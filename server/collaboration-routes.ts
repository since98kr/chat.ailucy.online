import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SystemId } from '../shared/contracts.js';
import type { CollaborationService } from './collaboration.js';
import type { ChatDatabase } from './database.js';

const systemIdSchema = z.enum(['letta', 'hermes']);
const participantStateSchema = z.enum(['active', 'idle', 'working', 'reviewing', 'blocked', 'offline']);

export function registerCollaborationRoutes(
  app: FastifyInstance,
  database: ChatDatabase,
  collaboration: CollaborationService,
) {
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
}
