import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  ConversationParticipantRecord,
  ConversationRecord,
  MessageRecord,
} from '../../shared/contracts.js';
import { HttpAgentAdapter } from './http.js';

const timestamp = '2026-07-19T00:00:00.000Z';
const conversation: ConversationRecord = {
  id: 'conversation-tool',
  systemId: 'hermes',
  agentId: '[Hermes] Lucy',
  title: 'Tool test',
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
  id: 'message-tool',
  conversationId: conversation.id,
  role: 'user',
  authorId: 'tei',
  content: '다운로드 가능한 보고서를 만들어줘.',
  state: 'complete',
  parentMessageId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const participants: ConversationParticipantRecord[] = [];
let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
  server = null;
});

describe('HttpAgentAdapter artifact tool', () => {
  it('advertises return_artifact and converts streamed tool arguments into an artifact item', async () => {
    let requestBody: Record<string, unknown> = {};
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"return_artifact","arguments":"{\\"filename\\":\\"report.txt\\","}}]}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"mime_type\\":\\"text/plain\\","}}]}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"content_text\\":\\"TOOL_FILE_OK\\"}"}}]}}]}\n\n');
        response.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const adapter = new HttpAgentAdapter('hermes', {
      baseUrl: `http://127.0.0.1:${address.port}`,
      chatPath: '/v1/chat/completions',
      healthPath: '/health',
      timeoutMs: 2_000,
      protocol: 'openai',
      modelMap: { '[Hermes] Lucy': 'tool-model' },
      artifactToolEnabled: true,
    });

    const items = [];
    for await (const item of adapter.streamReply({
      conversation,
      userMessage,
      history: [userMessage],
      targetAgentId: '[Hermes] Lucy',
      routingMode: 'direct',
      participants,
    })) items.push(item);

    expect(requestBody.tool_choice).toBe('auto');
    const tools = requestBody.tools as Array<{ function: { name: string } }>;
    expect(tools[0].function.name).toBe('return_artifact');
    expect(items).toEqual([{
      type: 'artifact',
      artifact: {
        filename: 'report.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from('TOOL_FILE_OK', 'utf8').toString('base64'),
      },
    }]);
  });
});
