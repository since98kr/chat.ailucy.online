import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RetryMessageInput, RetryMode } from '../shared/contracts.js';
import type { CollaborationService } from './collaboration.js';
import type { ChatDatabase } from './database.js';
import { runCollaborativeReply } from './collaboration-runner.js';
import { parseBody, retryMessageSchema } from './security.js';
import { streamNdjson } from './web.js';

const timestamp = () => new Date().toISOString();

function requestFingerprint(conversationId: string, sourceMessageId: string, mode: RetryMode) {
  return createHash('sha256')
    .update(JSON.stringify({ conversationId, sourceMessageId, mode }))
    .digest('hex');
}

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
      agent_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('retry', 'regenerate')),
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  app.get('/api/conversations/:id/participants', async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = database.getConversation(id);
    if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });
    return { participants: collaboration.ensureLeadParticipant(conversation) };
  });

  app.post('/api/conversations/:id/participants', async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = database.getConversation(id);
    if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });
    const body = request.body as { agentId?: string };
    if (!body.agentId?.trim()) return reply.status(400).send({ error: 'agentId is required' });
    try {
      const participant = collaboration.addParticipant(conversation, body.agentId.trim());
      return reply.status(201).send({ participant });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Unable to add participant' });
    }
  });

  app.delete('/api/conversations/:id/participants/:agentId', async (request, reply) => {
    const { id, agentId } = request.params as { id: string; agentId: string };
    const conversation = database.getConversation(id);
    if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });
    try {
      collaboration.removeParticipant(conversation, decodeURIComponent(agentId));
      return reply.status(204).send();
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Unable to remove participant' });
    }
  });

  app.get('/api/conversations/:id/activities', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!database.getConversation(id)) return reply.status(404).send({ error: 'Conversation not found' });
    return { activities: collaboration.listActivities(id, 100) };
  });

  app.post('/api/conversations/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!database.getConversation(id)) return reply.status(404).send({ error: 'Conversation not found' });
    const cancelled = collaboration.cancelRun(id);
    if (!cancelled) return reply.status(409).send({ error: 'No active run' });
    return reply.status(202).send({ cancelled: true });
  });

  app.post('/api/messages/:messageId/retry/stream', async (request, reply) => {
    const { messageId } = request.params as { messageId: string };
    let input: RetryMessageInput;
    try {
      input = parseBody(retryMessageSchema, request.body) as RetryMessageInput;
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Invalid retry request' });
    }

    const retryOriginal = database.getMessage(messageId);
    if (!retryOriginal || retryOriginal.role !== 'assistant') {
      return reply.status(404).send({ error: 'Assistant message not found' });
    }
    if (input.mode === 'retry' && !['failed', 'cancelled'].includes(retryOriginal.state)) {
      return reply.status(409).send({ error: 'RETRY_REQUIRES_FAILED_OR_CANCELLED_RESPONSE' });
    }

    const retryConversation = database.getConversation(retryOriginal.conversationId);
    if (!retryConversation) return reply.status(404).send({ error: 'Conversation not found' });
    const retrySource = retryOriginal.parentMessageId
      ? database.getMessage(retryOriginal.parentMessageId)
      : null;
    if (!retrySource || retrySource.role !== 'user') {
      return reply.status(409).send({ error: 'Retry source message is unavailable' });
    }

    const fingerprint = requestFingerprint(retryConversation.id, retrySource.id, input.mode);
    const existing = database.db.prepare(`
      SELECT idempotency_key, conversation_id, original_message_id, source_message_id,
             output_message_id, agent_id, mode, status, error, created_at, updated_at
      FROM message_retry_attempts WHERE idempotency_key = ?
    `).get(input.idempotencyKey) as {
      idempotency_key: string;
      conversation_id: string;
      original_message_id: string;
      source_message_id: string;
      output_message_id: string | null;
      agent_id: string;
      mode: RetryMode;
      status: 'running' | 'completed' | 'failed';
      error: string | null;
      created_at: string;
      updated_at: string;
    } | undefined;

    if (existing) {
      const existingFingerprint = requestFingerprint(existing.conversation_id, existing.source_message_id, existing.mode);
      if (existingFingerprint !== fingerprint || existing.original_message_id !== retryOriginal.id) {
        return reply.status(409).send({ error: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_RETRY' });
      }
      if (existing.status === 'completed' && existing.output_message_id) {
        const output = database.getMessage(existing.output_message_id);
        if (!output) return reply.status(409).send({ error: 'RETRY_OUTPUT_MISSING' });
        return streamNdjson(reply, (async function* replay() {
          yield { type: 'message.created', message: output };
          yield {
            type: 'run.completed',
            runId: `retry-replay:${input.idempotencyKey}`,
            message: output,
            agentId: existing.agent_id,
          };
        })());
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
          // Retry/regeneration continues the already-bound task. It must not
          // clear a persisted blocker before correlated execution evidence is
          // observed, and every retry attempt must keep its caller-owned
          // idempotency identity all the way to the provider receipt boundary.
          operatingIntent: 'continuation',
          idempotencyKey: input.idempotencyKey,
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
          yield event;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Retry stream failed';
        database.db.prepare(`
          UPDATE message_retry_attempts SET status = 'failed', error = ?, updated_at = ?
          WHERE idempotency_key = ?
        `).run(message, timestamp(), input.idempotencyKey);
        throw error;
      } finally {
        if (!terminal) {
          database.db.prepare(`
            UPDATE message_retry_attempts SET status = 'failed', error = ?, updated_at = ?
            WHERE idempotency_key = ? AND status = 'running'
          `).run('Retry stream ended before a terminal event', timestamp(), input.idempotencyKey);
        }
      }
    }

    return streamNdjson(reply, generate());
  });
}
