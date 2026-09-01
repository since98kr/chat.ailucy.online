import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ChatDatabase } from './database.js';
import { adapterHealth } from './adapters/index.js';
import { storeArtifact } from './artifacts.js';
import { CollaborationService } from './collaboration.js';
import { registerCollaborationRoutes } from './collaboration-routes.js';
import { runCollaborativeReply } from './collaboration-runner.js';
import { classifyConversationIntent } from './conversation-intent.js';
import { conversationRuntimeIdentity } from './provider-session-identity.js';
import {
  reconcilePendingApproval,
  resolveBareApproval,
  resolveContinuation,
  sameConversationRuntimeIdentity,
  type ConversationOperatingContext,
} from '../shared/conversation-operating-context.js';
import {
  createOpenClawApprovalBackendFromEnv,
  type ConversationApprovalBackend,
} from './openclaw-approval.js';
import { FederationService } from './federation.js';
import { registerFederationRoutes } from './federation-routes.js';
import { runFederatedWorkflow } from './federated-runner.js';
import type {
  ConversationDetail,
  ConversationParticipantRecord,
  FederationSnapshotRecord,
  StreamEvent,
  TeamActivityRecord,
} from '../shared/contracts.js';

const conversationStatusSchema = z.enum(['active', 'archived', 'trashed']);
const systemIdSchema = z.enum(['letta', 'hermes']);

const createConversationSchema = z.object({
  systemId: systemIdSchema,
  agentId: z.string().min(1).max(120),
  title: z.string().trim().min(1).max(160).optional(),
  federated: z.boolean().default(false),
});

const updateConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    pinned: z.boolean().optional(),
    status: conversationStatusSchema.optional(),
    draft: z.string().max(100_000).optional(),
    lastReadMessageId: z.string().uuid().nullable().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, 'At least one field is required');

const branchConversationSchema = z.object({
  fromMessageId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(160).optional(),
});

const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(200_000),
  clientMessageId: z.string().uuid().optional(),
  parentMessageId: z.string().uuid().nullable().optional(),
  artifactIds: z.array(z.string().uuid()).max(20).default([]),
  targetAgentIds: z.array(z.string().min(1).max(120)).max(20).default([]),
  workflowMode: z.enum(['chat', 'federated']).default('chat'),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

function eventLine(event: StreamEvent) {
  return `${JSON.stringify(event)}\n`;
}

function directRequestFingerprint(input: z.infer<typeof sendMessageSchema>) {
  return createHash('sha256').update(JSON.stringify({
    content: input.content,
    parentMessageId: input.parentMessageId ?? null,
    artifactIds: [...input.artifactIds].sort(),
    targetAgentIds: [...input.targetAgentIds].sort(),
    workflowMode: input.workflowMode,
  })).digest('hex');
}

function markdownExport(
  conversation: ConversationDetail,
  participants: ConversationParticipantRecord[],
  activities: TeamActivityRecord[],
  federation: FederationSnapshotRecord,
) {
  const lines = [
    `# ${conversation.title}`,
    '',
    `- System: ${conversation.systemId}`,
    `- Primary agent: ${conversation.agentId}`,
    `- Mode: ${federation.config?.mode ?? 'single'}`,
    `- Created: ${conversation.createdAt}`,
    `- Updated: ${conversation.updatedAt}`,
  ];
  if (conversation.branchedFromConversationId) {
    lines.push(`- Branched from: ${conversation.branchedFromConversationId}`);
  }
  if (federation.config?.mode === 'federated') {
    lines.push(`- Coordinator: ${federation.config.coordinatorAgentId}`);
    lines.push(`- Memory policy: ${federation.config.memoryPolicy}`);
    lines.push(`- Allowed systems: ${federation.config.allowedSystemIds.join(', ')}`);
  }
  if (participants.length) {
    lines.push('', '## Participants', '');
    for (const participant of participants) {
      lines.push(`- ${participant.agent.displayName} — ${participant.role} / ${participant.state} / ${participant.agent.role}`);
    }
  }
  if (federation.capsules.length) {
    lines.push('', '## Memory Capsules', '');
    for (const capsule of federation.capsules) {
      lines.push(`### ${capsule.title}`, '');
      lines.push(`- ${capsule.sourceSystemId} → ${capsule.targetSystemId}`);
      lines.push(`- Status: ${capsule.status}`);
      lines.push(`- Approved: ${capsule.approvedAt ?? 'not approved'}`, '');
      lines.push(capsule.content, '');
    }
  }
  lines.push('', '---', '');
  for (const message of conversation.messages) {
    const author = message.role === 'user' ? 'Tei' : message.authorId;
    lines.push(`## ${author}`, '', message.content || '_empty_', '');
    const artifacts = conversation.artifacts.filter((artifact) => artifact.messageId === message.id);
    if (artifacts.length) {
      lines.push('Attachments:', ...artifacts.map((artifact) => `- ${artifact.filename} (${artifact.mimeType})`), '');
    }
  }
  const unattached = conversation.artifacts.filter((artifact) => !artifact.messageId);
  if (unattached.length) {
    lines.push('## Unattached files', '', ...unattached.map((artifact) => `- ${artifact.filename} (${artifact.mimeType})`), '');
  }
  if (activities.length) {
    lines.push('## Team activity', '');
    for (const activity of [...activities].reverse()) {
      lines.push(`- ${activity.createdAt} · ${activity.agent.displayName} · ${activity.type} · ${activity.summary}`);
    }
    lines.push('');
  }
  if (federation.runs.length) {
    lines.push('## Workflow runs', '');
    for (const run of federation.runs) {
      lines.push(`### ${run.id}`, '');
      lines.push(`- Status: ${run.status}`);
      lines.push(`- Idempotency key: ${run.idempotencyKey}`);
      lines.push(`- Coordinator: ${run.coordinatorAgentId}`);
      lines.push(`- Requested agents: ${run.requestedAgentIds.join(', ')}`);
      lines.push(`- Error: ${run.error ?? 'none'}`, '');
      for (const step of run.steps) {
        lines.push(`  - ${step.agentId} · ${step.systemId} · group ${step.parallelGroup} · ${step.status} · attempt ${step.attempt}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

type BuildAppOptions = {
  databasePath?: string;
  artifactRoot?: string;
  approvalBackend?: ConversationApprovalBackend | null;
};

async function synchronizePendingApproval(
  database: ChatDatabase,
  backend: ConversationApprovalBackend,
  context: ConversationOperatingContext,
) {
  const candidates = await backend.listPending(context);
  const state: { resolution?: ReturnType<typeof reconcilePendingApproval> } = {};
  const synchronized = database.updateConversationOperatingContext(context.conversationId, (latest) => {
    if (!sameConversationRuntimeIdentity(latest, context)) {
      throw new Error('Conversation runtime identity changed during approval synchronization');
    }
    const resolution = reconcilePendingApproval(latest, candidates);
    state.resolution = resolution;
    return {
      ...latest,
      pendingApproval: resolution.ok ? resolution.value : null,
    };
  });
  const resolution = state.resolution;
  if (!synchronized || !resolution) {
    throw new Error('Conversation disappeared during approval synchronization');
  }
  return { context: synchronized, resolution };
}

type ApprovalActionResult =
  | { ok: true; approvalId: string; operatingContext: ConversationOperatingContext }
  | {
      ok: false;
      statusCode: 404 | 409 | 503;
      error: string;
      reason?: string;
      message: string;
    };

async function resolveConversationApproval(
  database: ChatDatabase,
  backend: ConversationApprovalBackend | null,
  conversationId: string,
): Promise<ApprovalActionResult> {
  const conversation = database.getConversation(conversationId);
  if (!conversation) {
    return {
      ok: false,
      statusCode: 404,
      error: 'CONVERSATION_NOT_FOUND',
      message: 'Conversation을 찾을 수 없습니다.',
    };
  }
  if (!backend || conversation.systemId !== 'letta') {
    return {
      ok: false,
      statusCode: 409,
      error: 'APPROVAL_BACKEND_UNAVAILABLE',
      message: '현재 Conversation의 실행 백엔드는 승인 재검증을 지원하지 않습니다.',
    };
  }

  const current = database.getConversationOperatingContext(conversationId)!;
  let synchronized: Awaited<ReturnType<typeof synchronizePendingApproval>>;
  try {
    synchronized = await synchronizePendingApproval(database, backend, current);
  } catch {
    return {
      ok: false,
      statusCode: 503,
      error: 'APPROVAL_BACKEND_UNAVAILABLE',
      message: '실행 백엔드의 현재 승인 상태를 검증할 수 없습니다.',
    };
  }

  if (!synchronized.resolution.ok) {
    return {
      ok: false,
      statusCode: 409,
      error: 'APPROVAL_BINDING_FAILED',
      reason: synchronized.resolution.reason,
      message: synchronized.resolution.reason === 'AMBIGUOUS_PENDING_APPROVAL'
        ? '현재 대화에 승인 대기가 둘 이상이라 자동으로 선택할 수 없습니다.'
        : '현재 대화에 검증된 승인 대기가 없습니다.',
    };
  }

  const identity = conversationRuntimeIdentity(conversation);
  const binding = resolveBareApproval(synchronized.context, identity);
  if (!binding.ok) {
    return {
      ok: false,
      statusCode: 409,
      error: 'APPROVAL_BINDING_FAILED',
      reason: binding.reason,
      message: '현재 대화의 승인 바인딩을 검증할 수 없습니다.',
    };
  }

  try {
    await backend.resolvePending(synchronized.context, binding.value.approvalId);
  } catch {
    return {
      ok: false,
      statusCode: 409,
      error: 'APPROVAL_REVERIFY_FAILED',
      message: '승인 대상이 더 이상 현재 대화의 대기 상태가 아니어서 실행하지 않았습니다.',
    };
  }

  const pendingApproval = synchronized.context.pendingApproval;
  const operatingContext = database.saveConversationOperatingContext(conversationId, {
    ...synchronized.context,
    pendingApproval: pendingApproval ? { ...pendingApproval, state: 'approved' } : null,
  })!;
  return { ok: true, approvalId: binding.value.approvalId, operatingContext };
}

export function buildApp(options?: BuildAppOptions) {
  if (options?.artifactRoot) process.env.CHAT_ARTIFACT_ROOT = options.artifactRoot;
  const db = new ChatDatabase(options?.databasePath);
  const collaboration = new CollaborationService(db);
  const federation = new FederationService(db);
  const approvalBackend = options?.approvalBackend === undefined
    ? createOpenClawApprovalBackendFromEnv()
    : options.approvalBackend;
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  if (approvalBackend?.start) {
    void approvalBackend.start().catch((error) => {
      app.log.warn({ err: error }, 'OpenClaw approval surface is not ready yet');
    });
  }

  app.register(cors, {
    origin: process.env.CHAT_ALLOWED_ORIGIN?.split(',').map((value) => value.trim()) ?? true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.register(multipart, {
    limits: {
      files: 1,
      fileSize: Number(process.env.CHAT_MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024),
    },
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', details: error.flatten() });
    }
    app.log.error(error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown internal error';
    return reply.status(500).send({
      error: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production' ? 'Internal server error' : errorMessage,
    });
  });

  app.addHook('onClose', async () => {
    await approvalBackend?.close?.();
    db.close();
  });

  app.get('/api/health', async () => ({
    ok: true,
    service: 'chat-ailucy-v2',
    adapters: await adapterHealth(),
    agents: {
      letta: collaboration.listAgents('letta').filter((agent) => agent.enabled).length,
      hermes: collaboration.listAgents('hermes').filter((agent) => agent.enabled).length,
    },
    workflow: {
      federatedConversations: db.db.prepare(`SELECT COUNT(*) AS count FROM conversation_federation WHERE mode = 'federated'`).get(),
      resumableRuns: db.db.prepare(`SELECT COUNT(*) AS count FROM workflow_runs WHERE status IN ('paused', 'failed')`).get(),
    },
    timestamp: new Date().toISOString(),
  }));

  app.get('/api/adapters/probe', async () => ({ adapters: await adapterHealth() }));
  registerCollaborationRoutes(app, db, collaboration);
  registerFederationRoutes(app, db, collaboration, federation);

  app.get('/api/conversations', async (request) => {
    const query = z.object({
      systemId: systemIdSchema.optional(),
      status: conversationStatusSchema.default('active'),
    }).parse(request.query);
    return { conversations: db.listConversations(query.systemId, query.status) };
  });

  app.get('/api/search', async (request) => {
    const query = z.object({
      q: z.string().trim().min(1).max(500),
      systemId: systemIdSchema.optional(),
      status: conversationStatusSchema.default('active'),
      limit: z.coerce.number().int().min(1).max(100).default(40),
    }).parse(request.query);
    return {
      results: db.searchConversations(query.q, {
        systemId: query.systemId,
        status: query.status,
        limit: query.limit,
      }),
    };
  });

  app.get('/api/conversations/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const conversation = db.getConversation(id);
    if (!conversation) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    return { conversation };
  });

  app.post('/api/conversations', async (request, reply) => {
    const input = createConversationSchema.parse(request.body);
    const agent = collaboration.getAgent(input.agentId);
    if (!agent || agent.systemId !== input.systemId || !agent.enabled || !agent.directChatEnabled) {
      return reply.status(409).send({ error: 'AGENT_UNAVAILABLE' });
    }
    if (input.federated && (input.systemId !== 'hermes' || input.agentId !== '[Hermes] Lucy')) {
      return reply.status(409).send({ error: 'FEDERATED_CONVERSATION_REQUIRES_HERMES_LUCY' });
    }
    const conversation = db.createConversation(input.systemId, input.agentId, input.title);
    collaboration.initializeConversation(conversation.id, input.systemId, input.agentId);
    if (input.federated) federation.enableConversation(conversation.id, input.agentId);
    return reply.status(201).send({
      conversation: db.getConversation(conversation.id),
      federation: federation.snapshot(conversation.id),
    });
  });

  app.get('/api/conversations/:id/operating-context', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    let operatingContext = db.getConversationOperatingContext(id);
    if (!operatingContext) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    if (approvalBackend && operatingContext.backendSystem === 'letta') {
      try {
        operatingContext = (await synchronizePendingApproval(db, approvalBackend, operatingContext)).context;
      } catch {
        // Status reads keep the last verified local snapshot when the backend
        // cannot be reached. Approval execution itself always fails closed.
      }
    }
    return { operatingContext };
  });

  app.post('/api/conversations/:id/approval', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const result = await resolveConversationApproval(db, approvalBackend, id);
    if (!result.ok) {
      return reply.status(result.statusCode).send({
        error: result.error,
        ...(result.reason ? { reason: result.reason } : {}),
        message: result.message,
      });
    }
    return { approvalId: result.approvalId, operatingContext: result.operatingContext };
  });

  app.post('/api/conversations/:id/branch', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = branchConversationSchema.parse(request.body ?? {});
    const conversation = db.branchConversation(id, input);
    if (!conversation) return reply.status(404).send({ error: 'CONVERSATION_OR_MESSAGE_NOT_FOUND' });
    collaboration.cloneParticipants(id, conversation.id);
    federation.cloneConversation(id, conversation.id);
    return reply.status(201).send({ conversation: db.getConversation(conversation.id) });
  });

  app.get('/api/conversations/:id/export/markdown', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const conversation = db.getConversation(id);
    if (!conversation) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`${conversation.title}.md`)}`,
    );
    return reply.send(markdownExport(
      conversation,
      collaboration.listParticipants(id),
      collaboration.listActivities(id, 500),
      federation.snapshot(id),
    ));
  });

  app.patch('/api/conversations/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = updateConversationSchema.parse(request.body);
    const conversation = db.updateConversation(id, input);
    if (!conversation) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    return { conversation };
  });

  app.delete('/api/conversations/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const conversation = db.getConversation(id);
    if (!conversation) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    if (conversation.status !== 'trashed') {
      return reply.status(409).send({ error: 'CONVERSATION_MUST_BE_TRASHED_FIRST' });
    }
    db.deleteConversation(id);
    return reply.status(204).send();
  });

  app.post('/api/conversations/:id/messages/stream', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = sendMessageSchema.parse(request.body);
    const found = db.getConversation(id);
    if (!found) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    const conversation = found;
    const operatingIntent = classifyConversationIntent(input.content);
    const operatingContext = db.getConversationOperatingContext(id)!;
    const currentIdentity = conversationRuntimeIdentity(conversation);
    if (conversation.systemId === 'letta' && approvalBackend?.start) {
      try {
        await approvalBackend.start();
      } catch {
        // Ordinary chat remains available. A protected action still fails closed
        // at OpenClaw when no approval delivery surface can be established.
      }
    }
    if (operatingIntent === 'continuation') {
      const binding = resolveContinuation(operatingContext, currentIdentity);
      if (!binding.ok) {
        return reply.status(409).send({
          error: 'CONTINUATION_BINDING_FAILED',
          reason: binding.reason,
          message: '현재 대화에 검증된 계속하기 대상이 없습니다.',
        });
      }
    }
    if (operatingIntent === 'approval') {
      if (!approvalBackend && !operatingContext.pendingApproval) {
        return reply.status(409).send({
          error: 'APPROVAL_BINDING_FAILED',
          reason: 'NO_PENDING_APPROVAL',
          message: '현재 대화에 검증된 승인 대기가 없습니다.',
        });
      }
      const result = await resolveConversationApproval(db, approvalBackend, id);
      if (!result.ok) {
        return reply.status(result.statusCode).send({
          error: result.error,
          ...(result.reason ? { reason: result.reason } : {}),
          message: result.message,
        });
      }
      return reply
        .header('Content-Type', 'application/x-ndjson; charset=utf-8')
        .header('Cache-Control', 'no-cache, no-transform')
        .header('X-Accel-Buffering', 'no')
        .send(eventLine({ type: 'approval.resolved', approvalId: result.approvalId }));
    }
    const config = federation.getConfig(id);
    const federated = config?.mode === 'federated' || input.workflowMode === 'federated';
    if (federated && config?.mode !== 'federated') {
      return reply.status(409).send({ error: 'FEDERATION_NOT_ENABLED' });
    }

    const idempotencyKey = input.idempotencyKey
      ?? (input.clientMessageId ? `direct:${input.clientMessageId}` : randomUUID());
    const existingRun = federated ? federation.findRunByIdempotency(id, idempotencyKey) : null;
    let directRequest = federated ? null : db.getDirectMessageRequest(id, idempotencyKey);
    const fingerprint = federated ? null : directRequestFingerprint(input);

    if (directRequest) {
      if (directRequest.request_fingerprint !== fingerprint) {
        return reply.status(409).send({
          error: 'DIRECT_MESSAGE_IDEMPOTENCY_CONFLICT',
          message: '같은 작업 식별자가 다른 요청 내용에 재사용되었습니다.',
        });
      }
      const sourceMessage = db.getMessage(directRequest.source_message_id);
      if (!sourceMessage) {
        return reply.status(409).send({
          error: 'DIRECT_MESSAGE_IDEMPOTENCY_BROKEN',
          message: '기존 작업의 원본 메시지를 검증할 수 없습니다.',
        });
      }
      if (directRequest.state !== 'completed') {
        return reply.status(409).send({
          error: 'DIRECT_MESSAGE_REPLAY_UNSAFE',
          state: directRequest.state,
          message: directRequest.state === 'started'
            ? '동일 작업의 이전 실행 상태를 확정할 수 없어 중복 실행을 차단했습니다.'
            : '동일 작업의 이전 실행이 실패했습니다. 새 요청 또는 검증된 계속하기로 복구하세요.',
        });
      }
      return reply
        .header('Content-Type', 'application/x-ndjson; charset=utf-8')
        .header('Cache-Control', 'no-cache, no-transform')
        .header('X-Accel-Buffering', 'no')
        .header('X-Chat-Idempotency', 'replayed')
        .send(eventLine({ type: 'message.accepted', message: sourceMessage }));
    }

    const existingMessage = existingRun ? db.getMessage(existingRun.sourceMessageId) : null;
    let userMessage = existingMessage;
    if (!userMessage && !federated) {
      const created = db.createDirectMessageRequest({
        conversationId: id,
        idempotencyKey,
        requestFingerprint: fingerprint!,
        clientMessageId: input.clientMessageId,
        content: input.content,
        parentMessageId: input.parentMessageId,
      });
      directRequest = created.request;
      if (!created.created || !created.message) {
        return reply.status(409).send({
          error: 'DIRECT_MESSAGE_REPLAY_RACE',
          message: '동일 작업이 동시에 제출되어 후속 중복 실행을 차단했습니다.',
        });
      }
      userMessage = created.message;
    }
    userMessage ??= db.addMessage({
      id: input.clientMessageId,
      conversationId: id,
      role: 'user',
      authorId: 'tei',
      content: input.content,
      parentMessageId: input.parentMessageId,
    });
    const resolvedUserMessage = userMessage;

    const attachedArtifacts = existingRun
      ? conversation.artifacts.filter((artifact) => artifact.messageId === resolvedUserMessage.id)
      : db.attachArtifacts(id, input.artifactIds, resolvedUserMessage.id);
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());

    async function* generate() {
      let directFailed = false;
      try {
        const generator = federated
          ? runFederatedWorkflow({
              database: db,
              collaboration,
              federation,
              conversation,
              userMessage: resolvedUserMessage,
              attachedArtifacts,
              idempotencyKey,
              requestedAgentIds: input.targetAgentIds,
              signal: controller.signal,
              existingRun,
            })
          : runCollaborativeReply({
              database: db,
              collaboration,
              conversation,
              userMessage: resolvedUserMessage,
              attachedArtifacts,
              sendInput: input,
              signal: controller.signal,
              idempotencyKey,
              operatingIntent,
            });
        for await (const event of generator) {
          if (event.type === 'run.failed') directFailed = true;
          yield eventLine(event);
        }
        if (!federated) {
          db.setDirectMessageRequestState(
            id,
            idempotencyKey,
            directFailed || controller.signal.aborted ? 'failed' : 'completed',
          );
        }
      } catch (error) {
        if (!federated) db.setDirectMessageRequestState(id, idempotencyKey, 'failed');
        throw error;
      }
    }

    reply
      .header('Content-Type', 'application/x-ndjson; charset=utf-8')
      .header('Cache-Control', 'no-cache, no-transform')
      .header('X-Accel-Buffering', 'no')
      .header('X-Chat-Idempotency', federated && existingRun ? 'replayed' : 'new');
    return reply.send(Readable.from(generate()));
  });

  app.post('/api/conversations/:id/artifacts', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    if (!db.getConversation(id)) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    const file = await request.file();
    if (!file) return reply.status(400).send({ error: 'FILE_REQUIRED' });
    const stored = await storeArtifact(id, file);
    const artifact = db.addArtifact({ conversationId: id, messageId: null, ...stored });
    return reply.status(201).send({ artifact });
  });

  app.get('/api/artifacts/:id/content', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const artifact = db.getArtifact(id);
    if (!artifact) return reply.status(404).send({ error: 'ARTIFACT_NOT_FOUND' });
    reply.header('Content-Type', artifact.mimeType);
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`);
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(createReadStream(artifact.storagePath));
  });

  app.get('/api/artifacts/:id/download', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const artifact = db.getArtifact(id);
    if (!artifact) return reply.status(404).send({ error: 'ARTIFACT_NOT_FOUND' });
    reply.header('Content-Type', artifact.mimeType);
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`);
    return reply.send(createReadStream(artifact.storagePath));
  });

  return app;
}
