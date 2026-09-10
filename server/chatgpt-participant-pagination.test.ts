import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatDatabase } from './database.js';
import { registerChatGptParticipantMcp } from './chatgpt-participant-mcp.js';

const cleanup: string[] = [];

const auth = {
  resourceUrl: 'https://chat.example.test/mcp/chatgpt-participant',
  issuer: 'https://identity.example.test',
  audience: 'chat-ailucy-chatgpt-participant',
  jwksUrl: 'https://identity.example.test/.well-known/jwks.json',
  authorizationServer: 'https://identity.example.test',
};

async function callRead(
  app: ReturnType<typeof Fastify>,
  args: Record<string, unknown>,
  id: number,
) {
  return app.inject({
    method: 'POST',
    url: '/mcp/chatgpt-participant',
    headers: {
      authorization: 'Bearer read-token',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    payload: {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'read_chat_room', arguments: args },
    },
  });
}

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe('ChatGPT participant room pagination', () => {
  it('reads first/cursor pages with limit+1 SQLite paging and rejects a foreign cursor without loading the full Conversation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chatgpt-participant-pagination-'));
    cleanup.push(dir);
    const db = new ChatDatabase(join(dir, 'chat.sqlite'));
    const room = db.createConversation('hermes', '[Hermes] Lucy', 'Paged room');
    const otherRoom = db.createConversation('hermes', 'Xixi', 'Foreign room');

    const first = db.addMessage({
      conversationId: room.id,
      role: 'user',
      authorId: 'tei',
      content: 'one',
    });
    const second = db.addMessage({
      conversationId: room.id,
      role: 'assistant',
      authorId: '[Hermes] Lucy',
      content: 'two',
      parentMessageId: first.id,
    });
    const third = db.addMessage({
      conversationId: room.id,
      role: 'assistant',
      authorId: '[Hermes] Lucy',
      content: 'three',
      parentMessageId: second.id,
    });
    const foreign = db.addMessage({
      conversationId: otherRoom.id,
      role: 'assistant',
      authorId: 'Xixi',
      content: 'foreign',
    });

    // Prove the secondary rowid key is part of the cursor contract rather than
    // accidentally relying on timestamp uniqueness.
    const sharedTimestamp = '2026-09-11T00:00:00.000Z';
    db.db.prepare(`
      UPDATE messages SET created_at = ?
      WHERE id IN (?, ?, ?)
    `).run(sharedTimestamp, first.id, second.id, third.id);

    db.addArtifact({
      conversationId: room.id,
      messageId: second.id,
      filename: 'private.txt',
      mimeType: 'text/plain',
      sizeBytes: 6,
      storagePath: '/private/artifacts/should-never-be-read-or-returned.txt',
    });

    const app = Fastify();
    registerChatGptParticipantMcp(app, db, {
      enabled: true,
      auth,
      verifyAccessToken: async () => ({ subject: 'tei-chatgpt', scopes: new Set(['chat:read']) }),
    });
    await app.ready();

    db.getConversation = (() => {
      throw new Error('read_chat_room must not load the full Conversation');
    }) as typeof db.getConversation;

    const firstPage = await callRead(app, { conversationId: room.id, limit: 2 }, 1);
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json().result.structuredContent;
    expect(firstBody.messages.map((message: { id: string }) => message.id)).toEqual([first.id, second.id]);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextAfterMessageId).toBe(second.id);
    expect(JSON.stringify(firstBody)).not.toContain('storagePath');
    expect(JSON.stringify(firstBody)).not.toContain('/private/artifacts/');

    const cursorPage = await callRead(app, {
      conversationId: room.id,
      afterMessageId: second.id,
      limit: 2,
    }, 2);
    expect(cursorPage.statusCode).toBe(200);
    const cursorBody = cursorPage.json().result.structuredContent;
    expect(cursorBody.messages.map((message: { id: string }) => message.id)).toEqual([third.id]);
    expect(cursorBody.hasMore).toBe(false);
    expect(cursorBody.nextAfterMessageId).toBe(third.id);

    const emptyPage = await callRead(app, {
      conversationId: room.id,
      afterMessageId: third.id,
      limit: 2,
    }, 3);
    const emptyBody = emptyPage.json().result.structuredContent;
    expect(emptyBody.messages).toEqual([]);
    expect(emptyBody.hasMore).toBe(false);
    expect(emptyBody.nextAfterMessageId).toBe(third.id);

    db.db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('archived', room.id);
    const archivedPage = await callRead(app, { conversationId: room.id, limit: 1 }, 4);
    expect(archivedPage.statusCode).toBe(200);
    expect(archivedPage.json().result).toMatchObject({
      isError: false,
      structuredContent: {
        room: { id: room.id, status: 'archived' },
        messages: [{ id: first.id }],
        hasMore: true,
      },
    });

    db.db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('trashed', room.id);
    const trashedPage = await callRead(app, { conversationId: room.id, limit: 1 }, 5);
    expect(trashedPage.statusCode).toBe(200);
    expect(trashedPage.json().result).toMatchObject({
      isError: false,
      structuredContent: { room: { id: room.id, status: 'trashed' } },
    });

    const foreignCursor = await callRead(app, {
      conversationId: room.id,
      afterMessageId: foreign.id,
      limit: 2,
    }, 6);
    expect(foreignCursor.statusCode).toBe(200);
    expect(foreignCursor.json().result).toMatchObject({
      isError: true,
      structuredContent: { error: 'AFTER_MESSAGE_NOT_IN_CONVERSATION' },
    });

    await app.close();
    db.close();
  });
});
