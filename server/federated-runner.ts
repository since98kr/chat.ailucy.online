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
import { artifactDeliveryEvent, classifyArtifactDeliveryFailure } from './artifact-delivery.js';
import { storeGeneratedArtifact } from './artifacts.js';
import type { CollaborationService } from './collaboration.js';
import type { ChatDatabase } from './database.js';
import type { FederationService } from './federation.js';
import { FEDERATED_CONVERSATION_IDENTITY_ERROR, isFederationConversationIdentity } from './federation-identity.js';

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

type StepDefinition = {
  agentId: string;
  systemId: SystemId;
  position: number;
  parallelGroup: number;
  dependsOnStepIds?: string[];
};

type StepResult = {
  ok: boolean;
  aborted: boolean;
  step: WorkflowStepRecord;
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
  const aliases = new Map<string, AgentRecord>();
  const personalLucy = agents.find((agent) => agent.id === '[OpenClaw] Lucy')
    ?? agents.find((agent) => agent.id === '[Letta] Lucy');
  const hermes = agents.find((agent) => agent.id === '[Hermes] Lucy');
  if (personalLucy) {
    aliases.set('openclaw', personalLucy);
    aliases.set('openclawlucy', personalLucy);
    // Keep historical typed mentions working while the internal system key is
    // retained for compatibility; both aliases route to the canonical agent.
    aliases.set('letta', personalLucy);
    aliases.set('lettalucy', personalLucy);
  }
  if (hermes) {
    aliases.set('hermes', hermes);
    aliases.set('hermeslucy', hermes);
  }

  const coordinator = hermes
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
  requested.delete(coordinator.id);

  return {
    coordinator,
    requestedAgents: [...requested]
      .map((id) => agents.find((agent) => agent.id === id))
      .filter((agent): agent is AgentRecord => Boolean(agent))
      .sort((a, b) => a.sortOrder - b.sortOrder),
    rejected,
    allAgents: agents,
  };
}

function persistStreamEvent(
  federation: FederationService,
  runId: string,
  type: WorkflowEventType,
  streamEvent: StreamEvent,
) {
  return federation.addEvent(runId, type, { streamEvent });
}

function replayableStreamEvent(event: ReturnType<FederationService['listEvents']>[number]) {
  const streamEvent = event.payload.streamEvent;
  if (!streamEvent || typeof streamEvent !== 'object' || Array.isArray(streamEvent)) return null;
  return streamEvent as StreamEvent;
}

export async function* replayWorkflowEvents(
  federation: FederationService,
  run: WorkflowRunRecord,
): AsyncGenerator<StreamEvent> {
  const replay = federation.listEvents(run.id).map(replayableStreamEvent).filter((event): event is StreamEvent => Boolean(event));
  yield { type: 'workflow.replayed', run, eventCount: replay.length };
  for (const event of replay) yield event;
  yield { type: 'workflow.run', run };
}

function sourceOutputs(database: ChatDatabase, steps: WorkflowStepRecord[]) {
  return steps
    .filter((step) => step.outputMessageId)
    .map((step) => database.getMessage(step.outputMessageId!))
    .filter((message): message is MessageRecord => Boolean(message))
    .map((message) => `### ${message.authorId} 원문 결과\n${message.content}`)
    .join('\n\n');
}

function dependencyOutputs(database: ChatDatabase, steps: WorkflowStepRecord[]) {
  return new Map(steps
    .filter((step) => step.outputMessageId)
    .map((step) => [step.id, database.getMessage(step.outputMessageId!)?.content ?? '']));
}

function approvedCapsulesForSystem(
  federation: FederationService,
  conversationId: string,
  targetSystemId: SystemId,
) {
  return federation.listCapsules(conversationId)
    .filter((capsule) => capsule.status === 'approved' && capsule.targetSystemId === targetSystemId);
}

function buildStepDefinitions(
  agents: AgentRecord[],
  coordinator: AgentRecord,
): StepDefinition[] {
  const parallel = agents
    .filter((agent) => agent.id !== coordinator.id)
    .map((agent, index) => ({
      agentId: agent.id,
      systemId: agent.systemId,
      position: index,
      parallelGroup: 0,
    }));
  return [
    ...parallel,
    {
      agentId: coordinator.id,
      systemId: coordinator.systemId,
      position: parallel.length,
      parallelGroup: parallel.length ? 1 : 0,
      dependsOnStepIds: parallel.map((step) => step.agentId),
    },
  ];
}

async function executeStep(
  input: FederatedRunInput,
  run: WorkflowRunRecord,
  step: WorkflowStepRecord,
  allAgents: AgentRecord[],
  dependencies: WorkflowStepRecord[],
  emit: (event: StreamEvent, workflowType?: WorkflowEventType) => void,
): Promise<StepResult> {
  const { database, collaboration, federation, conversation, userMessage, attachedArtifacts, signal } = input;
  if (signal.aborted) return { ok: false, aborted: true, step };

  const agent = collaboration.getAgent(step.agentId);
  if (!agent || !agent.enabled || !agent.directChatEnabled || agent.systemId !== step.systemId) {
    const failed = federation.updateStep(step.id, { status: 'failed', error: 'AGENT_UNAVAILABLE', incrementAttempt: true })!;
    emit({ type: 'workflow.step', step: failed }, 'step.failed');
    return { ok: false, aborted: false, step: failed };
  }
  const adapter = getAdapter(step.systemId);
  const participant = collaboration.listParticipants(conversation.id).find((item) => item.agentId === step.agentId);
  const memoryCapsules = approvedCapsulesForSystem(federation, conversation.id, step.systemId);
  const dependencyText = dependencies.length
    ? `\n\nApproved dependency outputs:\n${sourceOutputs(database, dependencies)}`
    : '';
  const operatingContext = step.systemId === 'letta'
    ? database.getConversationOperatingContext(conversation.id) ?? undefined
    : undefined;
  const history = database.getConversation(conversation.id)!.messages.filter((message) => message.id !== step.outputMessageId);
  const runtimeAgent = participant?.agent ?? agent;
  const assistantMessage = step.outputMessageId
    ? database.getMessage(step.outputMessageId)
    : database.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      authorId: step.agentId,
      content: '',
      state: 'streaming',
      parentMessageId: userMessage.id,
    });
  if (!assistantMessage) throw new Error('Federated workflow output message is missing');
  if (!step.outputMessageId) federation.updateStep(step.id, { outputMessageId: assistantMessage.id });
  const runnable = federation.updateStep(step.id, { status: 'running', error: null, incrementAttempt: true })!;
  emit({ type: 'workflow.step', step: runnable }, 'step.started');
  emit({ type: 'message.created', message: assistantMessage });
  yieldArtifactDelivery(emit, {
    runId: run.id,
    messageId: userMessage.id,
    agentId: step.agentId,
    systemId: step.systemId,
    artifacts: attachedArtifacts,
    state: 'delivering',
    detail: 'Preparing the approved attachment set for this federated step.',
  });

  let content = '';
  try {
    const selectedParticipants = participant ? [participant] : [];
    const providerRequest = {
      conversation,
      userMessage: {
        ...userMessage,
        content: `${userMessage.content}${dependencyText}`,
      },
      history,
      participants: selectedParticipants,
      selectedAgentId: step.agentId,
      targetAgentId: step.agentId,
      federatedAgents: allAgents,
      artifacts: attachedArtifacts,
      memoryCapsules,
      routingMode: 'federated' as const,
      signal,
      sessionId: `federation:${conversation.id}:${step.agentId}`,
      idempotencyKey: `${run.id}:${step.id}:${runnable.attempt}`,
      workflowRunId: run.id,
      operatingContext,
    };
    for await (const item of adapter.streamReply(providerRequest)) {
      if (signal.aborted) break;
      if (item.type === 'status') {
        emit({ type: 'run.status', runId: run.id, agentId: step.agentId, status: item.status });
      } else if (item.type === 'delta') {
        content += item.delta;
        database.updateMessage(assistantMessage.id, { content, state: 'streaming' });
        emit({ type: 'content.delta', runId: run.id, messageId: assistantMessage.id, authorId: step.agentId, delta: item.delta });
      } else if (item.type === 'artifact') {
        const artifact = storeGeneratedArtifact(database, conversation.id, assistantMessage.id, item.artifact);
        emit({ type: 'artifact.created', artifact });
      }
    }
    if (signal.aborted) {
      const cancelled = federation.updateStep(step.id, { status: 'cancelled', error: 'ABORTED' })!;
      database.updateMessage(assistantMessage.id, { state: 'cancelled' });
      emit({ type: 'workflow.step', step: cancelled }, 'step.cancelled');
      return { ok: false, aborted: true, step: cancelled };
    }
    const complete = database.updateMessage(assistantMessage.id, { content, state: 'complete' })!;
    const completed = federation.updateStep(step.id, { status: 'completed', error: null })!;
    emit({ type: 'run.completed', runId: run.id, agentId: step.agentId, message: complete });
    emit({ type: 'workflow.step', step: completed }, 'step.completed');
    yieldArtifactDelivery(emit, {
      runId: run.id,
      messageId: userMessage.id,
      agentId: step.agentId,
      systemId: step.systemId,
      artifacts: attachedArtifacts,
      state: 'delivered',
      detail: 'Attachment bytes delivered to the selected backend; model understanding is verified separately.',
    });
    return { ok: true, aborted: false, step: completed };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown federated execution error';
    const failed = federation.updateStep(step.id, { status: 'failed', error: detail })!;
    database.updateMessage(assistantMessage.id, { state: 'failed' });
    emit({ type: 'run.failed', runId: run.id, agentId: step.agentId, error: detail });
    emit({ type: 'workflow.step', step: failed }, 'step.failed');
    yieldArtifactDelivery(emit, {
      runId: run.id,
      messageId: userMessage.id,
      agentId: step.agentId,
      systemId: step.systemId,
      artifacts: attachedArtifacts,
      state: classifyArtifactDeliveryFailure(error),
      detail,
    });
    return { ok: false, aborted: false, step: failed };
  }
}

function yieldArtifactDelivery(
  emit: (event: StreamEvent, workflowType?: WorkflowEventType) => void,
  input: Parameters<typeof artifactDeliveryEvent>[0],
) {
  if (input.artifacts.length === 0) return;
  emit(artifactDeliveryEvent(input));
}

export async function* runFederatedWorkflow(input: FederatedRunInput): AsyncGenerator<StreamEvent> {
  const { database, collaboration, federation, conversation, userMessage, idempotencyKey, requestedAgentIds, signal } = input;
  if (!isFederationConversationIdentity(conversation)) {
    throw new Error(FEDERATED_CONVERSATION_IDENTITY_ERROR);
  }
  const config = federation.getConfig(conversation.id);
  if (!config || config.mode !== 'federated') throw new Error('FEDERATION_NOT_ENABLED');

  const coordinator = collaboration.getAgent(config.coordinatorAgentId);
  if (!coordinator || !coordinator.enabled || coordinator.systemId !== 'hermes') throw new Error('FEDERATION_COORDINATOR_UNAVAILABLE');
  const agents = collaboration.listAgents().filter((agent) => agent.enabled && agent.directChatEnabled);
  const requestedAgents = requestedAgentIds
    .map((agentId) => agents.find((agent) => agent.id === agentId))
    .filter((agent): agent is AgentRecord => Boolean(agent));
  const selected = [...requestedAgents, coordinator].filter((agent, index, list) => list.findIndex((candidate) => candidate.id === agent.id) === index);
  const runResult = input.existingRun
    ? { run: input.existingRun, created: false }
    : federation.createOrGetRun({
      conversationId: conversation.id,
      sourceMessageId: userMessage.id,
      idempotencyKey,
      coordinatorAgentId: coordinator.id,
      requestedAgentIds: selected.map((agent) => agent.id),
    });
  let run = runResult.run;
  const queue = new AsyncEventQueue<StreamEvent>();
  const emit = (event: StreamEvent, workflowType?: WorkflowEventType) => {
    queue.push(event);
    if (workflowType) persistStreamEvent(federation, run.id, workflowType, event);
  };

  if (!runResult.created && !input.resumed) {
    yield* replayWorkflowEvents(federation, run);
    return;
  }

  if (runResult.created) {
    run = federation.updateRun(run.id, { status: 'running', error: null })!;
    federation.createSteps(run.id, buildStepDefinitions(selected, coordinator));
    federation.addEvent(run.id, 'run.started', { sourceMessageId: userMessage.id, requestedAgentIds: selected.map((agent) => agent.id) });
  } else if (input.resumed) {
    run = federation.updateRun(run.id, { status: 'running', error: null })!;
    federation.addEvent(run.id, 'run.resumed', { requestedAgentIds });
  }
  queue.push({ type: 'workflow.run', run: federation.getRun(run.id)! });

  const worker = (async () => {
    try {
      const allSteps = federation.getRun(run.id)!.steps;
      const runnable = input.resumed
        ? allSteps.filter((step) => step.status !== 'completed')
        : allSteps;
      const grouped = [...new Set(runnable.map((step) => step.parallelGroup))].sort((a, b) => a - b);
      for (const group of grouped) {
        if (signal.aborted) break;
        const steps = runnable.filter((step) => step.parallelGroup === group);
        const allRunSteps = federation.getRun(run.id)!.steps;
        const dependencyMap = dependencyOutputs(database, allRunSteps);
        const executable = steps.filter((step) => step.dependsOnStepIds.every((id) => dependencyMap.has(id)));
        const blocked = steps.filter((step) => !executable.some((candidate) => candidate.id === step.id));
        for (const step of blocked) {
          const failed = federation.updateStep(step.id, { status: 'failed', error: 'DEPENDENCY_FAILED', incrementAttempt: true })!;
          emit({ type: 'workflow.step', step: failed }, 'step.failed');
        }
        await Promise.all(executable.map((step) => executeStep(input, run, step, agents, allRunSteps.filter((candidate) => step.dependsOnStepIds.includes(candidate.id)), emit)));
      }
      const finalSteps = federation.getRun(run.id)!.steps;
      const failed = finalSteps.filter((step) => step.status !== 'completed');
      run = federation.updateRun(run.id, {
        status: signal.aborted ? 'paused' : failed.length ? 'failed' : 'completed',
        error: signal.aborted ? 'ABORTED' : failed.length ? `${failed.length} step(s) failed` : null,
      })!;
      federation.addEvent(run.id, run.status === 'completed' ? 'run.completed' : run.status === 'paused' ? 'run.paused' : 'run.failed', {
        failedStepIds: failed.map((step) => step.id),
      });
      queue.push({ type: 'workflow.run', run });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown workflow error';
      run = federation.updateRun(run.id, { status: signal.aborted ? 'paused' : 'failed', error: detail })!;
      federation.addEvent(run.id, run.status === 'paused' ? 'run.paused' : 'run.failed', { error: detail });
      queue.push({ type: 'workflow.run', run });
    } finally {
      queue.close();
    }
  })();

  for await (const event of queue.iterate()) yield event;
  await worker;
}
