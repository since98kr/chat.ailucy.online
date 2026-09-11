import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatDatabase } from './database.js';
import { CollaborationService } from './collaboration.js';

const cleanup: string[] = [];

function createDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'chat-openclaw-identity-'));
  cleanup.push(directory);
  return new ChatDatabase(join(directory, 'chat.sqlite'));
}

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe('OpenClaw Lucy canonical identity migration', () => {
  it('converts the fresh personal seed from legacy Letta identity before it is exposed', () => {
    const database = createDatabase();
    const collaboration = new CollaborationService(database);

    const weekly = database.getConversation('weekly');
    expect(weekly).toMatchObject({ systemId: 'letta', agentId: '[OpenClaw] Lucy' });
    expect(weekly?.messages.every((message) => message.authorId !== '[Letta] Lucy')).toBe(true);
    expect(weekly?.messages.at(0)?.authorId).toBe('[OpenClaw] Lucy');

    const agents = collaboration.listAgents('letta');
    expect(agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: '[OpenClaw] Lucy',
        displayName: '[OpenClaw] Lucy',
        enabled: true,
        directChatEnabled: true,
        isLead: true,
      }),
    ]));
    expect(collaboration.listParticipants('weekly').map((participant) => participant.agentId)).toEqual([
      '[OpenClaw] Lucy',
    ]);

    database.close();
  });

  it('migrates persisted legacy conversations and participants while retaining only a disabled FK compatibility row', () => {
    const database = createDatabase();
    new CollaborationService(database);
    const stamp = new Date().toISOString();

    database.db.prepare(`
      INSERT INTO agents (
        id, system_id, display_name, short_name, role, description,
        capabilities_json, enabled, direct_chat_enabled, is_lead,
        sort_order, created_at, updated_at
      ) VALUES (?, 'letta', ?, 'Lucy', 'Personal AI', 'legacy', '[]', 1, 1, 1, 5, ?, ?)
    `).run('[Letta] Lucy', '[Letta] Lucy', stamp, stamp);
    database.db.prepare(`UPDATE conversations SET agent_id = '[Letta] Lucy' WHERE id = 'weekly'`).run();
    database.db.prepare(`UPDATE messages SET author_id = '[Letta] Lucy' WHERE conversation_id = 'weekly'`).run();
    database.db.prepare(`DELETE FROM conversation_participants WHERE conversation_id = 'weekly'`).run();
    database.db.prepare(`
      INSERT INTO conversation_participants (conversation_id, agent_id, role, state, added_at, updated_at)
      VALUES ('weekly', '[Letta] Lucy', 'lead', 'active', ?, ?)
    `).run(stamp, stamp);
    database.db.prepare(`
      INSERT INTO team_activities (id, conversation_id, agent_id, type, status, summary, created_at)
      VALUES ('legacy-activity', 'weekly', '[Letta] Lucy', 'joined', 'active', '[Letta] Lucy joined this Conversation.', ?)
    `).run(stamp);

    const migrated = new CollaborationService(database);
    const weekly = database.getConversation('weekly');
    expect(weekly?.agentId).toBe('[OpenClaw] Lucy');
    expect(weekly?.messages.every((message) => message.authorId === '[OpenClaw] Lucy')).toBe(true);
    expect(migrated.listParticipants('weekly').map((participant) => participant.agentId)).toEqual([
      '[OpenClaw] Lucy',
    ]);

    const legacy = migrated.getAgent('[Letta] Lucy');
    expect(legacy).toMatchObject({
      displayName: '[OpenClaw] Lucy',
      enabled: false,
      directChatEnabled: false,
      isLead: false,
    });
    expect(migrated.listActivities('weekly')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'legacy-activity',
        agentId: '[Letta] Lucy',
        summary: '[OpenClaw] Lucy joined this Conversation.',
        agent: expect.objectContaining({ displayName: '[OpenClaw] Lucy', enabled: false }),
      }),
    ]));

    database.close();
  });
});
