import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ArtifactRecord,
  ConversationParticipantRecord,
  ConversationRecord,
  MessageRecord,
} from '../../shared/contracts.js';
import type { AdapterRequest } from './types.js';
import { augmentNativeArtifactContext } from './native-artifacts.js';

const timestamp = '2026-07-19T00:00:00.000Z';
const conversation: ConversationRecord = {
  id: 'conversation-1',
  systemId: 'letta',
  agentId: '[Letta] Lucy',
  title: 'Native artifact test',
  preview: '',
  status: 'active',
  pinned: false,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastReadMessageId: null,
  draft: '',
  branchedFromConversationId: null,
  branchedFromMessageId: null,
};
const userMessage: MessageRecord = {
  id: 'message-1',
  conversationId: conversation.id,
  role: 'user',
  authorId: 'tei',
  content: '첨부 문서의 코드만 알려줘.',
  state: 'complete',
  parentMessageId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const participants: ConversationParticipantRecord[] = [];
const directories: string[] = [];

async function artifact(filename: string, mimeType: string, content: Buffer): Promise<ArtifactRecord> {
  const directory = await mkdtemp(join(tmpdir(), 'chat-v2-native-artifact-'));
  directories.push(directory);
  const storagePath = join(directory, filename);
  await writeFile(storagePath, content);
  return {
    id: crypto.randomUUID(),
    conversationId: conversation.id,
    messageId: userMessage.id,
    filename,
    mimeType,
    sizeBytes: content.length,
    storagePath,
    createdAt: timestamp,
  };
}

function request(artifacts: ArtifactRecord[]): AdapterRequest {
  return {
    conversation,
    userMessage,
    history: [userMessage],
    artifacts,
    targetAgentId: '[Letta] Lucy',
    routingMode: 'direct',
    participants,
  };
}

afterEach(async () => {
  delete process.env.LETTA_MAX_TEXT_ARTIFACT_BYTES;
  delete process.env.LETTA_NATIVE_BINARY_ARTIFACTS;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('augmentNativeArtifactContext', () => {
  it('injects a marker found only inside a text attachment', async () => {
    const input = await artifact('marker.md', 'text/markdown', Buffer.from('LEtta_DOC_ONLY_7F92', 'utf8'));
    const result = await augmentNativeArtifactContext('letta', request([input]));

    expect(result.userMessage.content).toContain('LEtta_DOC_ONLY_7F92');
    expect(result.userMessage.content).toContain('<ATTACHMENTS>');
    expect(result.history[0].content).toBe(result.userMessage.content);
    expect(userMessage.content).not.toContain('LEtta_DOC_ONLY_7F92');
  });

  it('rejects binary input when the native backend has no declared capability', async () => {
    const input = await artifact('photo.png', 'image/png', Buffer.from('png', 'utf8'));
    await expect(augmentNativeArtifactContext('letta', request([input])))
      .rejects.toThrow('letta native backend does not support attachment type: image/png');
  });

  it('enforces the native document extraction input limit', async () => {
    process.env.LETTA_MAX_TEXT_ARTIFACT_BYTES = '4';
    const input = await artifact('large.txt', 'text/plain', Buffer.from('12345', 'utf8'));
    await expect(augmentNativeArtifactContext('letta', request([input])))
      .rejects.toThrow('document attachments exceed the 4-byte extraction input limit');
  });
});
