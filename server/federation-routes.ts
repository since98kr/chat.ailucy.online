import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { StreamEvent, SystemId } from '../shared/contracts.js';
import type { CollaborationService } from './collaboration.js';
import type { ChatDatabase } from './database.js';
import type { FederationService } from './federation.js';
import { replayWorkflowEvents, runFederatedWorkflow } from './federated-runner.js';

const systemIdSchema = z.enum(['letta', 'hermes']);
const capsuleStatusSchema = z.enum(['draft', 'approved', 'revoked']);

const createCapsuleSchema = z.object({
  sourceSystemId: systemIdSchema,
  targetSystemId: systemIdSchema,
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(100_000),
  sourceMessageIds: z.array(z.string().uuid()).max(100).default([]),
}).refine((value) => value.sourceSystemId !== value.targetSystemId, {
  message: 'Source and target systems must differ',
});

const updateCapsuleSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  content: z.string().trim().min(1).max(100_000).optional(),
  status: capsuleStatusSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');

const eventLine = (event: StreamEvent) => `${JSON.stringify(event)}\n`;

export function registerFederationRoutes(
  app: FastifyInstance,
  database: ChatDatabase,
  collaboration: CollaborationService,
  federation: FederationService,
) {
  app.get('/api/conversations/:id/export/json', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const conversation = database.getConversation(id);
    if (!conversation) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    const { artifacts, ...conversationWithoutArtifacts } = conversation;
    const publicArtifacts = artifacts.map(({ storagePath: _storagePath, ...artifact }) => artifact);
    const participants = collaboration.listParticipants(id);
    const activities = collaboration.listActivities(id, 500);
    const snapshot = federation.snapshot(id);
    const payload = {
      schema: 'chat.ailucy.online/conversation-export-v1',
      exportedAt: new Date().toISOString(),
      conversation: {
        ...conversationWithoutArtifacts,
        artifacts: publicArtifacts,
      },
      collaboration: {
        participants,
        activities,
        activityLimit: 500,
        activityLimitReached: activities.length === 500,
      },
      federation: {
        config: snapshot.config,
        capsules: snapshot.capsules,
        workflows: snapshot.runs.map((run) => ({
          run,
          events: federation.listEvents(run.id),
        })),
      },
    };
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`${conversation.title}.json`)}`,
    );
    return reply.send(`${JSON.stringify(payload, null, 2)}\n`);
  });

  app.get('/api/conversations/:id/federation', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    if (!database.getConversation(id)) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    return { federation: federation.snapshot(id) };
  });

  app.post('/api/conversations/:id/federation', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = z.object({ coordinatorAgentId: z.string().min(1).max(120).default('[Hermes] Lucy') })
      .parse(request.body ?? {});
    const conversation = database.getConversation(id);
    if (!conversation) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    const coordinator = collaboration.getAgent(input.coordinatorAgentId);
    if (!coordinator || !coordinator.enabled || coordinator.systemId !== 'hermes') {
      return reply.status(409).send({ error: 'FEDERATION_COORDINATOR_UNAVAILABLE' });
    }
    const config = federation.enableConversation(id, coordinator.id);
    return reply.status(201).send({ config, federation: federation.snapshot(id) });
  });

  app.delete('/api/conversations/:id/federation', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const config = federation.getConfig(id);
    if (!config) return reply.status(404).send({ error: 'FEDERATION_NOT_FOUND' });
    if (federation.listRuns(id).some((run) => run.status === 'running' || run.status === 'paused')) {
      return reply.status(409).send({ error: 'FEDERATION_HAS_ACTIVE_WORKFLOW' });
    }
    return { config: federation.disableConversation(id) };
  });

  app.post('/api/conversations/:id/memory-capsules', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = createCapsuleSchema.parse(request.body);
    const conversation = database.getConversation(id);
    if (!conversation) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    if (federation.getConfig(id)?.mode !== 'federated') {
      return reply.status(409).send({ error: 'FEDERATION_NOT_ENABLED' });
    }
    const messageIds = new Set(conversation.messages.map((message) => message.id));
    if (input.sourceMessageIds.some((messageId) => !messageIds.has(messageId))) {
      return reply.status(409).send({ error: 'CAPSULE_SOURCE_MESSAGE_OUTSIDE_CONVERSATION' });
    }
    const capsule = federation.createCapsule({ conversationId: id, ...input, createdBy: 'tei' });
    return reply.status(201).send({ capsule });
  });

  app.patch('/api/memory-capsules/:capsuleId', async (request, reply) => {
    const { capsuleId } = z.object({ capsuleId: z.string().uuid() }).parse(request.params);
    const input = updateCapsuleSchema.parse(request.body);
    const current = federation.getCapsule(capsuleId);
    if (!current) return reply.status(404).send({ error: 'MEMORY_CAPSULE_NOT_FOUND' });
    if (current.status === 'revoked' && input.status === 'approved') {
      return reply.status(409).send({ error: 'REVOKED_CAPSULE_CANNOT_BE_REAPPROVED' });
    }
    const capsule = federation.updateCapsule(capsuleId, { ...input, actor: 'tei' });
    return { capsule };
  });

  app.get('/api/conversations/:id/workflows', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    if (!database.getConversation(id)) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
    return { runs: federation.listRuns(id, query.limit) };
  });

  app.get('/api/workflows/:runId', async (request, reply) => {
    const { runId } = z.object({ runId: z.string().uuid() }).parse(request.params);
    const run = federation.getRun(runId);
    if (!run) return reply.status(404).send({ error: 'WORKFLOW_RUN_NOT_FOUND' });
    return { run };
  });

  app.get('/api/workflows/:runId/events', async (request, reply) => {
    const { runId } = z.object({ runId: z.string().uuid() }).parse(request.params);
    if (!federation.getRun(runId)) return reply.status(404).send({ error: 'WORKFLOW_RUN_NOT_FOUND' });
    const query = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    return { events: replayWorkflowEvents(federation, runId, query.after) };
  });

  app.post('/api/workflows/:runId/resume/stream', async (request, reply) => {
    const { runId } = z.object({ runId: z.string().uuid() }).parse(request.params);
    const foundRun = federation.getRun(runId);
    if (!foundRun) return reply.status(404).send({ error: 'WORKFLOW_RUN_NOT_FOUND' });
    if (!['paused', 'failed'].includes(foundRun.status)) {
      return reply.status(409).send({ error: 'WORKFLOW_RUN_NOT_RESUMABLE', status: foundRun.status });
    }
    const foundConversation = database.getConversation(foundRun.conversationId);
    const foundUserMessage = database.getMessage(foundRun.sourceMessageId);
    if (!foundConversation || !foundUserMessage) {
      return reply.status(409).send({ error: 'WORKFLOW_SOURCE_CONTEXT_MISSING' });
    }

    const run = foundRun;
    const conversation = foundConversation;
    const userMessage = foundUserMessage;
    const attachedArtifacts = conversation.artifacts.filter((artifact) => artifact.messageId === userMessage.id);
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());

    async function* generate() {
      for await (const event of runFederatedWorkflow({
        database,
        collaboration,
        federation,
        conversation,
        userMessage,
        attachedArtifacts,
        idempotencyKey: run.idempotencyKey,
        requestedAgentIds: run.requestedAgentIds,
        signal: controller.signal,
        existingRun: run,
        resumed: true,
      })) yield eventLine(event);
    }

    reply
      .header('Content-Type', 'application/x-ndjson; charset=utf-8')
      .header('Cache-Control', 'no-cache, no-transform')
      .header('X-Accel-Buffering', 'no');
    return reply.send(Readable.from(generate()));
  });
}

export type FederationRouteSystemId = SystemId;
