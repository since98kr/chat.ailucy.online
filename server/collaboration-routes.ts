import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { StreamEvent, SystemId } from '../shared/contracts.js';
import type { CollaborationService } from './collaboration.js';
import { runCollaborativeReply } from './collaboration-runner.js';
import type { ChatDatabase } from './database.js';

const systemIdSchema = z.enum(['letta', 'hermes']);
const participantStateSchema = z.enum(['active', 'idle', 'working', 'reviewing', 'blocked', 'offline']);
const retryModeSchema = z.enum(['retry', 'regenerate']);
const eventLine = (event: StreamEvent) => `${JSON.stringify(event)}\n`;
const timestamp = () => new Date().toISOString();

type MessageRetryRow = {
  idempotency_key: string;
  conversation_id: string;
  original_message_id: string;
  source_message_id: string;
  output_message_id: string | null;
  agent_id: string;
  mode: 'retry' | 'regenerate';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  error: string | null;
  created_at: string;
  updated_at: string;
};

export function registerCollaborationRoutes(
  app: FastifyInstance,
  database: ChatDatabase,
  collaboration: CollaborationService,
) {
  database.db.exec(`
    CREATE TABLE IF NOT EXISTS message_retry_attempts (
      idempotency_key TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      original_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      output_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      mode TEXT NOT NULL CHECK (mode IN ('retry', 'regenerate')),
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_message_retry_conversation
      ON message_retry_attempts(conversation_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_message_retry_original
      ON message_retry_attempts(original_message_id, created_at DESC);
  `);

  app.get('/api/agents', async (request) => {
    const query = z.object({ systemId: systemIdSchema.optional() }).parse(request.query);
    return { agents: collaboration.listAgents(query.systemId as SystemId | undefined) };
  });

  app.get('/api/conversations/:id/participants', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    if (!database.getConversation(id)) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    return { participants: collaboration.listParticipants(id) };
  });

  app.put('/api/conversations/:id/participants', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = z.object({
      agentIds: z.array(z.string().min(1).max(120)).max(20),
      leadAgentId: z.string().min(1).max(120).optional(),
    }).parse(request.body);
    const conversation = database.getConversation(id);
    if (!conversation) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    try {
      return { participants: collaboration.updateParticipants(conversation, input) };
    } catch (error) {
      return reply.status(409).send({
        error: 'PARTICIPANT_UPDATE_REJECTED',
        message: error instanceof Error ? error.message : 'Participant update rejected',
      });
    }
  });

  app.patch('/api/conversations/:id/participants/:agentId', async (request, reply) => {
    const { id, agentId } = z.object({ id: z.string().min(1), agentId: z.string().min(1) }).parse(request.params);
    const input = z.object({ state: participantStateSchema }).parse(request.body);
    if (!database.getConversation(id)) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    const participant = collaboration.setParticipantState(id, agentId, input.state);
    if (!participant) return reply.status(404).send({ error: 'PARTICIPANT_NOT_FOUND' });
    return { participant };
  });

  app.get('/api/conversations/:id/team-activity', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    if (!database.getConversation(id)) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    return { activities: collaboration.listActivities(id, query.limit) };
  });

  app.post('/api/conversations/:id/routing/preview', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = z.object({
      content: z.string().max(200_000).default(''),
      targetAgentIds: z.array(z.string().min(1).max(120)).max(20).default([]),
    }).parse(request.body ?? {});
    const conversation = database.getConversation(id);
    if (!conversation) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    return { routing: collaboration.resolveRouting(conversation, input.content, input.targetAgentIds) };
  });

  app.post('/api/messages/:messageId/retry/stream', async (request, reply) => {
    const { messageId } = z.object({ messageId: z.string().uuid() }).parse(request.params);
    const input = z.object({
      mode: retryModeSchema.default('retry'),
      idempotencyKey: z.string().trim().min(8).max(200),
    }).parse(request.body ?? {});
    const original = database.getMessage(messageId);
    if (!original) return reply.status(404).send({ error: 'MESSAGE_NOT_FOUND' });
    if (original.role !== 'assistant') {
      return reply.status(409).send({ error: 'ONLY_ASSISTANT_RESPONSES_CAN_BE_RETRIED' });
    }
    if (input.mode === 'retry' && !['failed', 'cancelled'].includes(original.state)) {
      return reply.status(409).send({ error: 'RETRY_REQUIRES_FAILED_OR_CANCELLED_RESPONSE' });
    }
    if (!original.parentMessageId) {
      return reply.status(409).send({ error: 'RESPONSE_SOURCE_MESSAGE_MISSING' });
    }
    const sourceMessage = database.getMessage(original.parentMessageId);
    if (!sourceMessage || sourceMessage.role !== 'user' || sourceMessage.conversationId !== original.conversationId) {
      return reply.status(409).send({ error: 'RESPONSE_SOURCE_MESSAGE_MISSING' });
    }
    const conversation = database.getConversation(original.conversationId);
    if (!conversation) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    if (conversation.status !== 'active') {
      return reply.status(409).send({ error: 'CONVERSATION_NOT_ACTIVE' });
    }
    const federation = database.db.prepare(
      `SELECT mode FROM conversation_federation WHERE conversation_id = ?`,
    ).get(conversation.id) as { mode?: string } | undefined;
    if (federation?.mode === 'federated') {
      return reply.status(409).send({ error: 'FEDERATED_RESPONSE_RETRY_USES_WORKFLOW_RESUME' });
    }
    const agent = collaboration.getAgent(original.authorId);
    if (!agent || !agent.enabled || !agent.directChatEnabled || agent.systemId !== conversation.systemId) {
      return reply.status(409).send({ error: 'RESPONSE_AGENT_UNAVAILABLE' });
    }

    const retryOriginal = original;
    const retrySource = sourceMessage;
    const retryConversation = conversation;

    const existing = database.db.prepare(
      `SELECT * FROM message_retry_attempts WHERE idempotency_key = ?`,
    ).get(input.idempotencyKey) as MessageRetryRow | undefined;
    if (existing) {
      if (existing.original_message_id !== retryOriginal.id || existing.mode !== input.mode) {
        return reply.status(409).send({ error: 'RETRY_IDEMPOTENCY_KEY_CONFLICT' });
      }
      if (existing.status === 'running') {
        return reply.status(409).send({ error: 'RETRY_ALREADY_RUNNING' });
      }
      if (existing.status === 'completed' && existing.output_message_id) {
        const output = database.getMessage(existing.output_message_id);
        if (!output) return reply.status(409).send({ error: 'RETRY_OUTPUT_MISSING' });
        const replayOutput = output;
        const runId = `retry-replay:${input.idempotencyKey}`;
        async function* replay() {
          yield eventLine({ type: 'message.created', message: replayOutput });
          yield eventLine({
            type: 'run.completed',
            runId,
            message: replayOutput,
            agentId: replayOutput.authorId,
          });
        }
        reply
          .header('Content-Type', 'application/x-ndjson; charset=utf-8')
          .header('Cache-Control', 'no-cache, no-transform')
          .header('X-Accel-Buffering', 'no');
        return reply.send(Readable.from(replay()));
      }
      return reply.status(409).send({ error: 'RETRY_KEY_ALREADY_TERMINAL', status: existing.status });
    }

    const createdAt = timestamp();
    database.db.prepare(`
      INSERT INTO message_retry_attempts (
        idempotency_key, conversation_id, original_message_id, source_message_id,
        output_message_id, agent_id, mode, status, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'running', NULL, ?, ?)
    `).run(
      input.idempotencyKey,
      retryConversation.id,
      retryOriginal.id,
      retrySource.id,
      retryOriginal.authorId,
      input.mode,
      createdAt,
      createdAt,
    );

    const attachedArtifacts = retryConversation.artifacts.filter((artifact) => artifact.messageId === retrySource.id);
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());

    async function* generate() {
      let terminal = false;
      try {
        for await (const event of runCollaborativeReply({
          database,
          collaboration,
          conversation: retryConversation,
          userMessage: retrySource,
          attachedArtifacts,
          sendInput: { content: retrySource.content, targetAgentIds: [retryOriginal.authorId] },
          signal: controller.signal,
          forcedAgentId: retryOriginal.authorId,
          suppressUserAccepted: true,
          historyEndsAtSourceMessage: true,
          regeneratedFromMessageId: retryOriginal.id,
          retryMode: input.mode,
        })) {
          if (event.type === 'message.created') {
            database.db.prepare(`
              UPDATE message_retry_attempts SET output_message_id = ?, updated_at = ?
              WHERE idempotency_key = ?
            `).run(event.message.id, timestamp(), input.idempotencyKey);
          }
          if (event.type === 'run.completed') {
            terminal = true;
            database.db.prepare(`
              UPDATE message_retry_attempts
              SET status = 'completed', output_message_id = ?, error = NULL, updated_at = ?
              WHERE idempotency_key = ?
            `).run(event.message.id, timestamp(), input.idempotencyKey);
          } else if (event.type === 'run.failed') {
            terminal = true;
            database.db.prepare(`
              UPDATE message_retry_attempts SET status = 'failed', error = ?, updated_at = ?
              WHERE idempotency_key = ?
            `).run(event.error, timestamp(), input.idempotencyKey);
          }
          yield eventLine(event);
        }
      } finally {
        if (!terminal) {
          database.db.prepare(`
            UPDATE message_retry_attempts SET status = 'cancelled', error = ?, updated_at = ?
            WHERE idempotency_key = ? AND status = 'running'
          `).run('Retry stream closed before completion', timestamp(), input.idempotencyKey);
        }
      }
    }

    reply
      .header('Content-Type', 'application/x-ndjson; charset=utf-8')
      .header('Cache-Control', 'no-cache, no-transform')
      .header('X-Accel-Buffering', 'no');
    return reply.send(Readable.from(generate()));
  });
}
