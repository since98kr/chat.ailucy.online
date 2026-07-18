import type {
  AgentRecord,
  ArtifactRecord,
  ConversationRecord,
  MessageRecord,
  StreamEvent,
  SystemId,
  WorkflowEventType,
  WorkflowRunRecord,
  WorkflowStepRecord,
} from '../shared/contracts.js';
import { getAdapter } from './adapters/index.js';
import type { CollaborationService } from './collaboration.js';
import type { ChatDatabase } from './database.js';
import type { FederationService } from './federation.js';

class AsyncEventQueue<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as T, done: true });
  }

  async *iterate() {
    while (true) {
      if (this.values.length) {
        yield this.values.shift()!;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}

export type FederatedRunInput = {
  database: ChatDatabase;
  collaboration: CollaborationService;
  federation: FederationService;
  conversation: ConversationRecord;
  userMessage: MessageRecord;
  attachedArtifacts: ArtifactRecord[];
  idempotencyKey: string;
  requestedAgentIds: string[];
  signal: AbortSignal;
  existingRun?: WorkflowRunRecord | null;
  resumed?: boolean;
};

function mentionTokens(content: string) {
  return [...content.matchAll(/@([A-Za-z0-9가-힣_-]+)/gu)].map((match) => match[1].toLowerCase());
}

export function resolveFederatedAgents(
  collaboration: CollaborationService,
  conversation: ConversationRecord,
  content: string,
  explicitAgentIds: string[],
) {
  const agents = collaboration.listAgents().filter((agent) => agent.enabled && agent.directChatEnabled);
  const byId = new Map(agents.map((agent) => [agent.id.toLowerCase(), agent]));
  const byShort = new Map(agents.map((agent) => [agent.shortName.toLowerCase(), agent]));
  const aliases = new Map<string, AgentRecord>([
    ['letta', agents.find((agent) => agent.id === '[Letta] Lucy')!],
    ['lettalucy', agents.find((agent) => agent.id === '[Letta] Lucy')!],
    ['hermes', agents.find((agent) => agent.id === '[Hermes] Lucy')!],
    ['hermeslucy', agents.find((agent) => agent.id === '[Hermes] Lucy')!],
  ].filter((entry): entry is [string, AgentRecord] => Boolean(entry[1])));
  const coordinator = agents.find((agent) => agent.id === '[Hermes] Lucy')
    ?? agents.find((agent) => agent.systemId === conversation.systemId && agent.isLead)
    ?? agents[0];
  if (!coordinator) throw new Error('No coordinator agent is available');

  const requested = new Set<string>();
  const rejected: string[] = [];
  for (const token of mentionTokens(content)) {
    const agent = aliases.get(token) ?? byId.get(token) ?? byShort.get(token);
    if (agent) requested.add(agent.id);
    else rejected.push(token);
  }
  for (const agentId of explicitAgentIds) {
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (agent) requested.add(agent.id);
    else rejected.push(agentId);
  }
  if (requested.size === 0) requested.add(coordinator.id);
  requested.delete(coordinator.id);
  return {
    coordinator,
    requestedAgents: [...requested]
      .map((id) => agents.find((agent) => agent.id === id)!)
      .filter(Boolean)
      .sort((a, b) => a.sortOrder - b.sortOrder),
    rejected,
    allAgents: agents,
  };
}

function eventTypeFor(streamEvent: StreamEvent): WorkflowEventType {
  if (streamEvent.type === 'run.status') return 'step.status';
  if (streamEvent.type === 'content.delta') return 'step.delta';
  if (streamEvent.type === 'run.failed') return 'step.failed';
  if (streamEvent.type === 'run.completed') return 'step.completed';
  if (streamEvent.type === 'workflow.step') {
    if (streamEvent.step.status === 'running') return 'step.started';
    if (streamEvent.step.status === 'failed') return 'step.failed';
    return 'step.completed';
  }
  if (streamEvent.type === 'workflow.replayed') return 'replay.started';
  return 'step.status';
}

function recordEvent(
  federation: FederationService,
  runId: string,
  streamEvent: StreamEvent,
  overrideType?: WorkflowEventType,
) {
  return federation.addEvent(runId, overrideType ?? eventTypeFor(streamEvent), {
    streamEvent: streamEvent as unknown as Record<string, unknown>,
  });
}

async function executeStep(input: {
  database: ChatDatabase;
  collaboration: CollaborationService;
  federation: FederationService;
  conversation: ConversationRecord;
  userMessage: MessageRecord;
  step: WorkflowStepRecord;
  run: WorkflowRunRecord;
  allAgents: AgentRecord[];
  queue: AsyncEventQueue<StreamEvent>;
  signal: AbortSignal;
}) {
  const { database, collaboration, federation, conversation, userMessage, run, allAgents, queue, signal } = input;
  let step = federation.updateStep(input.step.id, {
    status: 'running',
    error: null,
    incrementAttempt: true,
  })!;
  const stepEvent: StreamEvent = { type: 'workflow.step', step };
  recordEvent(federation, run.id, stepEvent, 'step.started');
  queue.push(stepEvent);
  queue.push({ type: 'run.started', runId: run.id, agentId: step.agentId });

  const assistantMessage = database.addMessage({
    conversationId: conversation.id,
    role: 'assistant',
    authorId: step.agentId,
    content: '',
    state: 'streaming',
    parentMessageId: userMessage.id,
  });
  queue.push({ type: 'message.created', message: assistantMessage });
  const adapter = getAdapter(step.systemId);
  let content = '';

  try {
    const latest = database.getConversation(conversation.id)!;
    const history = latest.messages.filter((message) => message.id !== assistantMessage.id);
    const capsules = federation.approvedCapsules(conversation.id, step.systemId);
    for (const capsule of capsules) {
      const capsuleEvent = federation.addEvent(run.id, 'capsule.used', {
        capsuleId: capsule.id,
        targetSystemId: step.systemId,
        stepId: step.id,
      });
      queue.push({ type: 'workflow.event', event: capsuleEvent });
    }
    for await (const item of adapter.streamReply({
      conversation,
      userMessage,
      history,
      targetAgentId: step.agentId,
      routingMode: 'team',
      participants: collaboration.listParticipants(conversation.id),
      federatedAgents: allAgents,
      memoryCapsules: capsules,
      workflowRunId: run.id,
      signal,
    })) {
      if (signal.aborted) break;
      if (item.type === 'status') {
        const event: StreamEvent = { type: 'run.status', runId: run.id, status: item.status, agentId: step.agentId };
        recordEvent(federation, run.id, event, 'step.status');
        queue.push(event);
      } else {
        content += item.delta;
        database.updateMessage(assistantMessage.id, { content, state: 'streaming' });
        const event: StreamEvent = {
          type: 'content.delta',
          runId: run.id,
          messageId: assistantMessage.id,
          delta: item.delta,
          authorId: step.agentId,
        };
        recordEvent(federation, run.id, event, 'step.delta');
        queue.push(event);
      }
    }

    if (signal.aborted) {
      database.updateMessage(assistantMessage.id, { content, state: 'cancelled' });
      step = federation.updateStep(step.id, {
        status: 'cancelled',
        outputMessageId: assistantMessage.id,
        error: 'Connection closed before completion',
      })!;
      const cancelledEvent: StreamEvent = { type: 'workflow.step', step };
      recordEvent(federation, run.id, cancelledEvent, 'step.failed');
      queue.push(cancelledEvent);
      return { ok: false, aborted: true, step };
    }

    const finalMessage = database.updateMessage(assistantMessage.id, { content, state: 'complete' })!;
    step = federation.updateStep(step.id, {
      status: 'completed',
      outputMessageId: finalMessage.id,
      error: null,
    })!;
    const completed: StreamEvent = { type: 'run.completed', runId: run.id, message: finalMessage, agentId: step.agentId };
    recordEvent(federation, run.id, completed, 'step.completed');
    queue.push(completed);
    queue.push({ type: 'workflow.step', step });
    return { ok: true, aborted: false, step };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown federated adapter error';
    database.updateMessage(assistantMessage.id, { content, state: 'failed' });
    step = federation.updateStep(step.id, {
      status: 'failed',
      outputMessageId: assistantMessage.id,
      error: message,
    })!;
    const failed: StreamEvent = { type: 'run.failed', runId: run.id, error: message, agentId: step.agentId };
    recordEvent(federation, run.id, failed, 'step.failed');
    queue.push(failed);
    queue.push({ type: 'workflow.step', step });
    return { ok: false, aborted: false, step };
  }
}

export async function* runFederatedWorkflow(input: FederatedRunInput): AsyncGenerator<StreamEvent> {
  const { database, collaboration, federation, conversation, userMessage, attachedArtifacts, signal } = input;
  const resolved = resolveFederatedAgents(collaboration, conversation, userMessage.content, input.requestedAgentIds);
  const coordinator = resolved.coordinator;
  const requestedIds = [...resolved.requestedAgents.map((agent) => agent.id), coordinator.id];
  const runResult = input.existingRun
    ? { run: input.existingRun, created: false }
    : federation.createOrGetRun({
        conversationId: conversation.id,
        sourceMessageId: userMessage.id,
        idempotencyKey: input.idempotencyKey,
        coordinatorAgentId: coordinator.id,
        requestedAgentIds: requestedIds,
      });
  let run = runResult.run;

  if (!runResult.created && run.status === 'completed' && !input.resumed) {
    yield { type: 'workflow.replayed', runId: run.id, eventCount: federation.listEvents(run.id).length };
    yield { type: 'workflow.run', run, replayed: true };
    return;
  }

  if (run.steps.length === 0) {
    const independent = resolved.requestedAgents;
    const definitions = independent.map((agent, index) => ({
      agentId: agent.id,
      systemId: agent.systemId,
      position: index,
      parallelGroup: 0,
    }));
    definitions.push({
      agentId: coordinator.id,
      systemId: coordinator.systemId,
      position: definitions.length,
      parallelGroup: independent.length ? 1 : 0,
      dependsOnStepIds: independent.map((agent) => agent.id),
    });
    federation.createSteps(run.id, definitions);
    run = federation.getRun(run.id)!;
    const createdEvent = federation.addEvent(run.id, 'run.created', { runId: run.id, requestedAgentIds: requestedIds });
    yield { type: 'workflow.event', event: createdEvent };
  }

  if (!input.resumed) {
    yield { type: 'message.accepted', message: userMessage };
    if (attachedArtifacts.length) {
      yield { type: 'artifacts.attached', messageId: userMessage.id, artifacts: attachedArtifacts };
    }
  }

  run = federation.updateRun(run.id, { status: 'running', error: null })!;
  const lifecycleType: WorkflowEventType = input.resumed ? 'run.resumed' : 'run.started';
  const lifecycleEvent = federation.addEvent(run.id, lifecycleType, { runId: run.id });
  yield { type: 'workflow.event', event: lifecycleEvent };
  yield { type: 'workflow.run', run };

  const queue = new AsyncEventQueue<StreamEvent>();
  const orchestrate = async () => {
    const currentRun = federation.getRun(run.id)!;
    const runnable = currentRun.steps.filter((step) => step.status !== 'completed');
    const independent = runnable.filter((step) => step.agentId !== coordinator.id);
    const coordinatorStep = runnable.find((step) => step.agentId === coordinator.id);
    const results = await Promise.all(independent.map((step) => executeStep({
      database,
      collaboration,
      federation,
      conversation,
      userMessage,
      step,
      run: currentRun,
      allAgents: resolved.allAgents,
      queue,
      signal,
    })));

    if (signal.aborted) {
      run = federation.updateRun(run.id, { status: 'paused', error: 'Client connection closed; resume is available' })!;
      const pausedEvent = federation.addEvent(run.id, 'run.paused', { runId: run.id });
      queue.push({ type: 'workflow.event', event: pausedEvent });
      queue.push({ type: 'workflow.run', run });
      queue.close();
      return;
    }

    let coordinatorResult: Awaited<ReturnType<typeof executeStep>> | null = null;
    if (coordinatorStep) {
      coordinatorResult = await executeStep({
        database,
        collaboration,
        federation,
        conversation,
        userMessage,
        step: coordinatorStep,
        run: federation.getRun(run.id)!,
        allAgents: resolved.allAgents,
        queue,
        signal,
      });
    }

    const failures = [...results, ...(coordinatorResult ? [coordinatorResult] : [])].filter((result) => !result.ok);
    if (signal.aborted) {
      run = federation.updateRun(run.id, { status: 'paused', error: 'Client connection closed; resume is available' })!;
      const pausedEvent = federation.addEvent(run.id, 'run.paused', { runId: run.id });
      queue.push({ type: 'workflow.event', event: pausedEvent });
    } else if (coordinatorResult && !coordinatorResult.ok) {
      run = federation.updateRun(run.id, { status: 'failed', error: coordinatorResult.step.error })!;
      const failedEvent = federation.addEvent(run.id, 'run.failed', { runId: run.id, error: run.error });
      queue.push({ type: 'workflow.event', event: failedEvent });
    } else {
      run = federation.updateRun(run.id, {
        status: 'completed',
        error: failures.length ? `${failures.length} non-coordinator step(s) failed; completed outputs were preserved` : null,
      })!;
      const completedEvent = federation.addEvent(run.id, 'run.completed', { runId: run.id, partialFailures: failures.length });
      queue.push({ type: 'workflow.event', event: completedEvent });
    }
    queue.push({ type: 'workflow.run', run });
    queue.close();
  };

  void orchestrate().catch((error) => {
    const message = error instanceof Error ? error.message : 'Federated workflow controller failed';
    run = federation.updateRun(run.id, { status: 'failed', error: message })!;
    const failedEvent = federation.addEvent(run.id, 'run.failed', { runId: run.id, error: message });
    queue.push({ type: 'workflow.event', event: failedEvent });
    queue.push({ type: 'workflow.run', run });
    queue.close();
  });

  for await (const event of queue.iterate()) yield event;
}

export function replayWorkflowEvents(federation: FederationService, runId: string, afterSequence = 0) {
  return federation.listEvents(runId, afterSequence);
}
