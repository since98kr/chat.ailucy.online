import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONVERSATION_OPERATING_CONTEXT_SCHEMA,
  type ConversationOperatingContext,
} from '../shared/conversation-operating-context.js';
import { CollaborationService } from './collaboration.js';
import { ChatDatabase } from './database.js';
import { conversationRuntimeIdentity } from './provider-session-identity.js';

const cleanup: string[] = [];

function createDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'chat-openclaw-context-'));
  cleanup.push(directory);
  return new ChatDatabase(join(directory, 'chat.sqlite'));
}

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe('OpenClaw Lucy operating-context migration', () => {
  it('rebinds identity fields while preserving task, blocker, truth, and pending approval semantics', () => {
    const database = createDatabase();
    new CollaborationService(database);

    database.db.prepare(`
      UPDATE conversations SET agent_id = '[Letta] Lucy' WHERE id = 'weekly'
    `).run();
    const legacyConversation = database.getConversation('weekly');
    expect(legacyConversation).not.toBeNull();
    const legacyIdentity = conversationRuntimeIdentity(legacyConversation!);
    expect(legacyIdentity.agentId).toBe('[Letta] Lucy');

    const timestamp = '2026-09-11T00:00:00.000Z';
    const legacyContext: ConversationOperatingContext = {
      schemaVersion: CONVERSATION_OPERATING_CONTEXT_SCHEMA,
      ...legacyIdentity,
      activeTask: { taskId: 'task-keep', label: '사용자 작업 [Letta] Lucy 텍스트 유지' },
      continuationTarget: {
        ...legacyIdentity,
        taskId: 'task-keep',
        label: '사용자 작업 [Letta] Lucy 텍스트 유지',
        targetRef: 'opaque-target-ref',
      },
      statusTruth: [{
        classification: 'FACT',
        summary: '사용자 상태 텍스트의 [Letta] Lucy 문자열은 이름 마이그레이션 대상이 아니다.',
        evidenceRef: 'evidence:keep',
        verifiedAt: timestamp,
      }],
      blocker: {
        blockerId: 'blocker-keep',
        summary: '보존할 blocker [Letta] Lucy 텍스트',
        nextAction: '보존할 next action [Letta] Lucy 텍스트',
        evidenceRef: 'evidence:blocker',
      },
      nextAction: '보존할 next action [Letta] Lucy 텍스트',
      pendingApproval: {
        ...legacyIdentity,
        approvalId: 'approval-keep',
        kind: 'exec',
        summary: '보존할 approval [Letta] Lucy 텍스트',
        state: 'pending',
        createdAt: timestamp,
        expiresAt: null,
      },
    };
    database.db.prepare(`
      INSERT INTO conversation_operating_context (conversation_id, context_json, updated_at)
      VALUES ('weekly', ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET context_json = excluded.context_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(legacyContext), timestamp);

    new CollaborationService(database);

    const migratedConversation = database.getConversation('weekly');
    expect(migratedConversation).toMatchObject({ systemId: 'letta', agentId: '[OpenClaw] Lucy' });
    const expectedIdentity = conversationRuntimeIdentity(migratedConversation!);
    const migrated = database.getConversationOperatingContext('weekly');
    expect(migrated).not.toBeNull();
    expect(migrated).toMatchObject({
      ...expectedIdentity,
      activeTask: legacyContext.activeTask,
      statusTruth: legacyContext.statusTruth,
      blocker: legacyContext.blocker,
      nextAction: legacyContext.nextAction,
    });
    expect(migrated?.continuationTarget).toMatchObject({
      ...expectedIdentity,
      taskId: 'task-keep',
      label: '사용자 작업 [Letta] Lucy 텍스트 유지',
      targetRef: 'opaque-target-ref',
    });
    expect(migrated?.pendingApproval).toMatchObject({
      ...expectedIdentity,
      approvalId: 'approval-keep',
      summary: '보존할 approval [Letta] Lucy 텍스트',
      state: 'pending',
    });

    database.close();
  });
});
