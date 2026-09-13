import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StreamEvent } from '../shared/contracts.js';

process.env.NODE_ENV = 'test';

let server: Server | null = null;
let directory: string | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  }
  server = null;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
  delete process.env.LETTA_BASE_URL;
  delete process.env.LETTA_CHAT_PATH;
  delete process.env.LETTA_HEALTH_PATH;
  delete process.env.LETTA_PROTOCOL;
  delete process.env.LETTA_AGENT_ID;
  vi.resetModules();
});

describe('collaboration completion guard ordering', () => {
  it('does not let an older receipt clear a blocker created after its first yielded event', async () => {
    let backendRequests = 0;
    server = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
        return;
      }
      backendRequests += 1;
      request.resume();
      request.on('end', () => {
        if (backendRequests === 1) {
          response.writeHead(500, { 'Content-Type': 'application/json' });
          response.end('{"error":"newer request failed"}');
          return;
        }
        const sessionId = String(request.headers['x-lucy-execution-session-id'] ?? '');
        const operationId = String(request.headers['x-lucy-execution-operation-id'] ?? '');
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({
          type: 'execution-evidence',
          evidence: {
            kind: 'result-receipt',
            sessionId,
            operationId,
            receiptId: 'older-run-result',
          },
        })}\n\n`);
        response.write('data: {"delta":"older run finished"}\n\n');
        response.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    process.env.LETTA_BASE_URL = baseUrl;
    process.env.LETTA_CHAT_PATH = '/chat';
    process.env.LETTA_HEALTH_PATH = '/health';
    process.env.LETTA_PROTOCOL = 'native';
    process.env.LETTA_AGENT_ID = '[OpenClaw] Lucy';

    directory = mkdtempSync(join(tmpdir(), 'chat-v2-completion-guard-'));
    vi.resetModules();
    const [{ ChatDatabase }, { CollaborationService }, { runCollaborativeReply }] = await Promise.all([
      import('./database.js'),
      import('./collaboration.js'),
      import('./collaboration-runner.js'),
    ]);
    const database = new ChatDatabase(join(directory, 'chat.sqlite'));
    const collaboration = new CollaborationService(database);
    const conversation = database.createConversation('letta', '[OpenClaw] Lucy', 'Completion guard race');
    const userA = database.addMessage({
      conversationId: conversation.id,
      role: 'user',
      authorId: 'tei',
      content: 'REQUEST_A_OLDER',
    });

    const runA = runCollaborativeReply({
      database,
      collaboration,
      conversation,
      userMessage: userA,
      attachedArtifacts: [],
      sendInput: { content: userA.content, artifactIds: [], targetAgentIds: [] },
      signal: new AbortController().signal,
    });

    const firstA = await runA.next();
    expect(firstA.done).toBe(false);
    expect(firstA.value?.type).toBe('message.accepted');
    expect(database.getConversationOperatingContext(conversation.id)?.activeTask?.taskId).toBe(userA.id);

    const userB = database.addMessage({
      conversationId: conversation.id,
      role: 'user',
      authorId: 'tei',
      content: 'REQUEST_B_NEWER_FAILS',
    });
    const eventsB: StreamEvent[] = [];
    for await (const event of runCollaborativeReply({
      database,
      collaboration,
      conversation: database.getConversation(conversation.id)!,
      userMessage: userB,
      attachedArtifacts: [],
      sendInput: { content: userB.content, artifactIds: [], targetAgentIds: [] },
      signal: new AbortController().signal,
    })) eventsB.push(event);
    expect(eventsB.some((event) => event.type === 'run.failed')).toBe(true);

    const afterB = database.getConversationOperatingContext(conversation.id)!;
    expect(afterB.activeTask?.taskId).toBe(userB.id);
    expect(afterB.blocker).not.toBeNull();

    const remainingA: StreamEvent[] = [];
    for await (const event of runA) remainingA.push(event);
    expect(remainingA.some((event) => event.type === 'run.completed')).toBe(true);
    expect(backendRequests).toBe(2);

    const finalContext = database.getConversationOperatingContext(conversation.id)!;
    expect(finalContext.activeTask).toEqual(afterB.activeTask);
    expect(finalContext.blocker).toEqual(afterB.blocker);
    expect(finalContext.nextAction).toEqual(afterB.nextAction);
    expect(finalContext.statusTruth).toEqual(afterB.statusTruth);
    database.close();
  });
});
