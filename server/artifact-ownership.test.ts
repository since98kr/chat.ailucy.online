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
});
