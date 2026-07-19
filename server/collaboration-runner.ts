import { randomUUID } from 'node:crypto';
import type {
  ArtifactRecord,
  ConversationRecord,
  MessageRecord,
  RoutingPlanRecord,
  SendMessageInput,
  StreamEvent,
} from '../shared/contracts.js';
import { getAdapter } from './adapters/index.js';
import { artifactDeliveryEvent, classifyArtifactDeliveryFailure } from './artifact-delivery.js';
import { storeGeneratedArtifact } from './artifacts.js';
import type { CollaborationService } from './collaboration.js';
import type { ChatDatabase } from './database.js';

export type CollaborationRunInput = {
  database: ChatDatabase;
  collaboration: CollaborationService;
  conversation: ConversationRecord;
  userMessage: MessageRecord;
  attachedArtifacts: ArtifactRecord[];
  sendInput: SendMessageInput;
  signal: AbortSignal;
  forcedAgentId?: string;
  suppressUserAccepted?: boolean;
  historyEndsAtSourceMessage?: boolean;
  regeneratedFromMessageId?: string;
  retryMode?: 'retry' | 'regenerate';
};

function participantWorkState(agentId: string) {
  if (agentId === 'Lynn') return 'reviewing' as const;
  return 'working' as const;
}

function forcedRouting(agentId: string): RoutingPlanRecord {
  return {
    mode: 'direct',
    leadAgentId: agentId,
    mentionedAgentIds: [],
    targetAgentIds: [agentId],
    rejectedMentions: [],
  };
}

function historyThroughSource(messages: MessageRecord[], sourceMessageId: string) {
  const index = messages.findIndex((message) => message.id === sourceMessageId);
  return index < 0 ? messages : messages.slice(0, index + 1);
}

export async function* runCollaborativeReply(input: CollaborationRunInput): AsyncGenerator<StreamEvent> {
  const {
    database,
    collaboration,
    conversation,
    userMessage,
    attachedArtifacts,
    sendInput,
    signal,
  } = input;
  const routing = input.forcedAgentId
    ? forcedRouting(input.forcedAgentId)
    : collaboration.resolveRouting(conversation, userMessage.content, sendInput.targetAgentIds ?? []);
  let participants = collaboration.ensureRoutingParticipants(conversation, routing);

  if (!input.suppressUserAccepted) yield { type: 'message.accepted', message: userMessage };
  if (attachedArtifacts.length && !input.suppressUserAccepted) {
    yield { type: 'artifacts.attached', messageId: userMessage.id, artifacts: attachedArtifacts };
  }
  yield { type: 'routing.resolved', routing };
  yield { type: 'participants.updated', participants };

  const adapter = getAdapter(conversation.systemId);
  for (const agentId of routing.targetAgentIds) {
    if (signal.aborted) return;
    const runId = randomUUID();
    const state = participantWorkState(agentId);
    const retryLabel = input.regeneratedFromMessageId
      ? `${input.retryMode === 'retry' ? 'Retry' : 'Regeneration'} requested from response ${input.regeneratedFromMessageId}.`
      : null;
    const assigned = collaboration.addActivity({
      conversationId: conversation.id,
      agentId,
      type: 'assigned',
      status: state,
      summary: retryLabel ?? (routing.mode === 'team'
        ? `${agentId} received an explicit team assignment.`
        : `${agentId} received the Conversation request.`),
      sourceMessageId: userMessage.id,
      outputMessageId: input.regeneratedFromMessageId ?? null,
    });
    collaboration.setParticipantState(conversation.id, agentId, state);
    participants = collaboration.listParticipants(conversation.id);
    yield { type: 'team.activity', activity: assigned };
    yield { type: 'participants.updated', participants };

    const assistantMessage = database.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      authorId: agentId,
      content: '',
      state: 'streaming',
      parentMessageId: userMessage.id,
    });
    yield { type: 'message.created', message: assistantMessage };
    yield { type: 'run.started', runId, agentId };

    let deliveryConfirmed = attachedArtifacts.length === 0;
    if (attachedArtifacts.length) {
      yield artifactDeliveryEvent({
        runId,
        messageId: userMessage.id,
        agentId,
        systemId: conversation.systemId,
        artifacts: attachedArtifacts,
        state: 'delivering',
        detail: input.regeneratedFromMessageId
          ? 'Preparing the original bounded attachment content for response regeneration.'
          : 'Preparing bounded attachment content for the selected backend.',
      });
    }

    let content = '';
    try {
      const latest = database.getConversation(conversation.id)!;
      const withoutCurrent = latest.messages.filter((message) => message.id !== assistantMessage.id);
      const history = input.historyEndsAtSourceMessage
        ? historyThroughSource(withoutCurrent, userMessage.id)
        : withoutCurrent;
      for await (const item of adapter.streamReply({
        conversation: latest,
        userMessage,
        history,
        artifacts: attachedArtifacts,
        targetAgentId: agentId,
        routingMode: routing.mode,
        participants,
        signal,
      })) {
        if (!deliveryConfirmed) {
          deliveryConfirmed = true;
          yield artifactDeliveryEvent({
            runId,
            messageId: userMessage.id,
            agentId,
            systemId: conversation.systemId,
            artifacts: attachedArtifacts,
            state: 'delivered',
            detail: 'Backend accepted the attachment request; model understanding is verified separately.',
          });
        }
        if (signal.aborted) break;
        if (item.type === 'status') {
          const statusActivity = collaboration.addActivity({
            conversationId: conversation.id,
            agentId,
            type: 'status',
            status: state,
            summary: item.status,
            sourceMessageId: userMessage.id,
            outputMessageId: assistantMessage.id,
          });
          yield { type: 'run.status', runId, status: item.status, agentId };
          yield { type: 'team.activity', activity: statusActivity };
          continue;
        }
        if (item.type === 'artifact') {
          const stored = await storeGeneratedArtifact(conversation.id, item.artifact);
          const artifact = database.addArtifact({
            conversationId: conversation.id,
            messageId: assistantMessage.id,
            ...stored,
          });
          yield { type: 'artifact.created', runId, artifact };
          continue;
        }

        content += item.delta;
        database.updateMessage(assistantMessage.id, { content, state: 'streaming' });
        yield {
          type: 'content.delta',
          runId,
          messageId: assistantMessage.id,
          delta: item.delta,
          authorId: agentId,
        };
      }

      if (attachedArtifacts.length && !deliveryConfirmed) {
        if (signal.aborted) {
          yield artifactDeliveryEvent({
            runId,
            messageId: userMessage.id,
            agentId,
            systemId: conversation.systemId,
            artifacts: attachedArtifacts,
            state: 'failed',
            detail: 'The request was cancelled before the backend confirmed attachment delivery.',
          });
        } else {
          deliveryConfirmed = true;
          yield artifactDeliveryEvent({
            runId,
            messageId: userMessage.id,
            agentId,
            systemId: conversation.systemId,
            artifacts: attachedArtifacts,
            state: 'delivered',
            detail: 'Backend completed an empty response after accepting the attachment request.',
          });
        }
      }

      const finalMessage = database.updateMessage(assistantMessage.id, {
        content,
        state: signal.aborted ? 'cancelled' : 'complete',
      })!;
      const outputActivity = collaboration.addActivity({
        conversationId: conversation.id,
        agentId,
        type: signal.aborted ? 'status' : 'output',
        status: signal.aborted ? 'blocked' : 'active',
        summary: signal.aborted
          ? `${agentId} output was cancelled by the user.`
          : input.regeneratedFromMessageId
            ? `${agentId} produced a new response from ${input.regeneratedFromMessageId}; the original response was preserved.`
            : `${agentId} original output was preserved in the transcript.`,
        sourceMessageId: userMessage.id,
        outputMessageId: finalMessage.id,
      });
      collaboration.setParticipantState(conversation.id, agentId, signal.aborted ? 'blocked' : 'idle');
      participants = collaboration.listParticipants(conversation.id);
      yield { type: 'team.activity', activity: outputActivity };
      yield { type: 'participants.updated', participants };
      yield { type: 'run.completed', runId, message: finalMessage, agentId };
      if (signal.aborted) return;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown adapter error';
      if (attachedArtifacts.length && !deliveryConfirmed) {
        const failure = classifyArtifactDeliveryFailure(error);
        yield artifactDeliveryEvent({
          runId,
          messageId: userMessage.id,
          agentId,
          systemId: conversation.systemId,
          artifacts: attachedArtifacts,
          state: failure.state,
          detail: failure.detail,
        });
      }
      database.updateMessage(assistantMessage.id, { content, state: 'failed' });
      const failed = collaboration.addActivity({
        conversationId: conversation.id,
        agentId,
        type: 'failed',
        status: 'blocked',
        summary: message,
        sourceMessageId: userMessage.id,
        outputMessageId: assistantMessage.id,
      });
      collaboration.setParticipantState(conversation.id, agentId, 'blocked');
      participants = collaboration.listParticipants(conversation.id);
      yield { type: 'team.activity', activity: failed };
      yield { type: 'participants.updated', participants };
      yield { type: 'run.failed', runId, error: message, agentId };
    }
  }
}
