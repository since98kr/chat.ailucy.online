import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { ChatDatabase } from './database.js';
import { adapterHealth } from './adapters/index.js';
import { storeArtifact } from './artifacts.js';
import { CollaborationService } from './collaboration.js';
import { registerCollaborationRoutes } from './collaboration-routes.js';
import { runCollaborativeReply } from './collaboration-runner.js';
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

export function buildApp(options?: { databasePath?: string; artifactRoot?: string }) {
  if (options?.artifactRoot) process.env.CHAT_ARTIFACT_ROOT = options.artifactRoot;
  const db = new ChatDatabase(options?.databasePath);
  const collaboration = new CollaborationService(db);
  const federation = new FederationService(db);
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

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

  app.addHook('onClose', async () => db.close());

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
    const config = federation.getConfig(id);
    const federated = config?.mode === 'federated' || input.workflowMode === 'federated';
    if (federated && config?.mode !== 'federated') {
      return reply.status(409).send({ error: 'FEDERATION_NOT_ENABLED' });
    }

    const idempotencyKey = input.idempotencyKey ?? input.clientMessageId ?? crypto.randomUUID();
    const existingRun = federated ? federation.findRunByIdempotency(id, idempotencyKey) : null;
    const existingMessage = existingRun ? db.getMessage(existingRun.sourceMessageId) : null;
    const userMessage = existingMessage ?? db.addMessage({
      id: input.clientMessageId,
      conversationId: id,
      role: 'user',
      authorId: 'tei',
      content: input.content,
      parentMessageId: input.parentMessageId,
    });
    const attachedArtifacts = existingRun
      ? conversation.artifacts.filter((artifact) => artifact.messageId === userMessage.id)
      : db.attachArtifacts(id, input.artifactIds, userMessage.id);
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());

    async function* generate() {
      const generator = federated
        ? runFederatedWorkflow({
            database: db,
            collaboration,
            federation,
            conversation,
            userMessage,
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
            userMessage,
            attachedArtifacts,
            sendInput: input,
            signal: controller.signal,
          });
      for await (const event of generator) yield eventLine(event);
    }

    reply
      .header('Content-Type', 'application/x-ndjson; charset=utf-8')
      .header('Cache-Control', 'no-cache, no-transform')
      .header('X-Accel-Buffering', 'no');
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
