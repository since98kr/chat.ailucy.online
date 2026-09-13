import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatDatabase } from './database.js';

let directory: string | null = null;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

describe('durable generated-artifact ownership', () => {
  it('persists run/task ownership, keeps legacy ownership unknown, and fails closed on re-claim', () => {
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-artifact-owner-'));
    const databasePath = join(directory, 'chat.sqlite');
    let database = new ChatDatabase(databasePath);

    const conversationA = database.createConversation('hermes', '[Hermes] Lucy', 'Artifact owner A');
    const producingMessage = database.addMessage({
      conversationId: conversationA.id,
      role: 'assistant',
      authorId: '[Hermes] Lucy',
      content: 'generated output',
    });
    const generated = database.addArtifact({
      conversationId: conversationA.id,
      messageId: producingMessage.id,
      filename: 'generated.txt',
      mimeType: 'text/plain',
      sizeBytes: 9,
      storagePath: join(directory, 'generated.txt'),
      producerRunId: 'run-a',
      producerTaskId: 'task-a',
    });
    const legacyUpload = database.addArtifact({
      conversationId: conversationA.id,
      messageId: null,
      filename: 'legacy.txt',
      mimeType: 'text/plain',
      sizeBytes: 6,
      storagePath: join(directory, 'legacy.txt'),
    });
    database.close();

    database = new ChatDatabase(databasePath);
    expect(database.getArtifact(generated.id)).toMatchObject({
      conversationId: conversationA.id,
      messageId: producingMessage.id,
      producerRunId: 'run-a',
      producerTaskId: 'task-a',
    });
    expect(database.getConversation(conversationA.id)?.artifacts.find((artifact) => artifact.id === generated.id))
      .toMatchObject({ producerRunId: 'run-a', producerTaskId: 'task-a' });
    expect(database.getArtifact(legacyUpload.id)).toMatchObject({
      producerRunId: null,
      producerTaskId: null,
    });

    const laterMessageA = database.addMessage({
      conversationId: conversationA.id,
      role: 'user',
      authorId: 'tei',
      content: 'try to claim generated artifact again',
    });
    expect(() => database.attachArtifacts(conversationA.id, [generated.id], laterMessageA.id))
      .toThrow('One or more artifacts are unavailable for this Conversation');

    const conversationB = database.createConversation('hermes', '[Hermes] Lucy', 'Artifact owner B');
    const messageB = database.addMessage({
      conversationId: conversationB.id,
      role: 'user',
      authorId: 'tei',
      content: 'cross conversation claim',
    });
    expect(() => database.attachArtifacts(conversationB.id, [generated.id], messageB.id))
      .toThrow('One or more artifacts are unavailable for this Conversation');

    expect(database.getArtifact(generated.id)).toMatchObject({
      conversationId: conversationA.id,
      messageId: producingMessage.id,
      producerRunId: 'run-a',
      producerTaskId: 'task-a',
    });
    database.close();
  });

  it('migrates pre-ownership artifact rows without inventing producer provenance', () => {
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-artifact-owner-migration-'));
    const databasePath = join(directory, 'legacy.sqlite');
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO artifacts (
        id, conversation_id, message_id, filename, mime_type, size_bytes, storage_path, created_at
      ) VALUES (
        'legacy-artifact', 'legacy-conversation', NULL, 'legacy.txt', 'text/plain', 6, '/legacy/path', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const migrated = new ChatDatabase(databasePath);
    expect(migrated.getArtifact('legacy-artifact')).toMatchObject({
      id: 'legacy-artifact',
      conversationId: 'legacy-conversation',
      producerRunId: null,
      producerTaskId: null,
    });
    const columns = migrated.db.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'producer_run_id',
      'producer_task_id',
    ]));
    migrated.close();
  });
});
