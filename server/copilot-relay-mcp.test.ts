import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatDatabase } from './database.js';
import { registerCopilotRelayMcp } from './copilot-relay-mcp.js';

const HOST = 'relay.test';
const KEY = 'test-copilot-relay-key';
const KEY_HASH = createHash('sha256').update(KEY).digest('hex');
const NOW = Date.parse('2026-08-15T08:45:00.000Z');
const cleanup: string[] = [];

function request(taskId = 'copilot-mcp-test-001', overrides: Record<string, unknown> = {}) {
  return {
    bridgeVersion: 'aicos.copilot-bridge/v1',
    taskId,
    objective: 'Perform one bounded corporate advisory check.',
    github: null,
    scope: {
      allowed: ['read sanitized corporate metadata'],
      forbidden: ['secret access', 'live action'],
    },
    expectedOutput: ['sanitized advisory verdict'],
    approvals: {
      merge: 'denied',
      productionDeploy: 'denied',
      secretChange: 'denied',
      destructiveDb: 'denied',
      liveAction: 'denied',
    },
    sourceAgent: 'openclaw',
    targetAgent: 'copilot',
    expiresAt: '2026-08-15T09:45:00.000Z',
    issueProseExecutable: false,
    ...overrides,
  };
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-relay-mcp-'));
  cleanup.push(dir);
  const db = new ChatDatabase(join(dir, 'relay.sqlite'));
  const app = Fastify();
  registerCopilotRelayMcp(app, db, {
    relayHost: HOST,
    mcpApiKeySha256: KEY_HASH,
    oidcVerifier: async (token) => token === 'oidc-ok',
    now: () => NOW,
  });
  await app.ready();
  return { app, db };
}

function mcpHeaders(key = KEY) {
  return {
    host: HOST,
    'x-aicos-relay-key': key,
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  };
}

function oidcHeaders(token = 'oidc-ok') {
  return { host: HOST, authorization: `Bearer ${token}` };
}

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe('Corporate Copilot relay MCP', () => {
  it('requires the dedicated host and MCP API key', async () => {
    const { app, db } = await fixture();
    expect((await app.inject({ method: 'POST', url: '/mcp/copilot-relay', headers: { host: 'other.test' }, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/mcp/copilot-relay', headers: mcpHeaders('wrong'), payload: {} })).statusCode).toBe(401);
    await app.close();
    db.close();
  });

  it('implements stateless Streamable HTTP lifecycle and tool discovery', async () => {
    const { app, db } = await fixture();
    const initialize = await app.inject({
      method: 'POST', url: '/mcp/copilot-relay', headers: mcpHeaders(),
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    });
    expect(initialize.statusCode).toBe(200);
    expect(initialize.json().result.protocolVersion).toBe('2025-06-18');
    expect(initialize.json().result.capabilities.tools).toEqual({ listChanged: false });

    const initialized = await app.inject({
      method: 'POST', url: '/mcp/copilot-relay', headers: mcpHeaders(),
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(initialized.statusCode).toBe(202);

    const list = await app.inject({
      method: 'POST', url: '/mcp/copilot-relay', headers: mcpHeaders(),
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'pull_external_task', 'claim_external_task', 'submit_external_result',
    ]);

    const get = await app.inject({ method: 'GET', url: '/mcp/copilot-relay', headers: { ...mcpHeaders(), accept: 'text/event-stream' } });
    expect(get.statusCode).toBe(405);
    await app.close();
    db.close();
  });

  it('rejects forged GitHub broker access and high-risk approved work', async () => {
    const { app, db } = await fixture();
    const forged = await app.inject({ method: 'POST', url: '/relay/copilot/inbox', headers: oidcHeaders('bad'), payload: { issueNumber: 10, bridgeRequest: request() } });
    expect(forged.statusCode).toBe(403);

    const risky = await app.inject({
      method: 'POST', url: '/relay/copilot/inbox', headers: oidcHeaders(),
      payload: { issueNumber: 10, bridgeRequest: request('copilot-risk-test-001', { approvals: { merge: 'approved', productionDeploy: 'denied', secretChange: 'denied', destructiveDb: 'denied', liveAction: 'denied' } }) },
    });
    expect(risky.statusCode).toBe(409);
    expect(risky.json().error).toBe('COPILOT_ADVISORY_CANNOT_EXERCISE_APPROVAL');
    await app.close();
    db.close();
  });

  it('moves one task from GitHub inbox through Copilot claim/result into durable outbox', async () => {
    const { app, db } = await fixture();
    const bridgeRequest = request();
    const pushed = await app.inject({
      method: 'POST', url: '/relay/copilot/inbox', headers: oidcHeaders(),
      payload: { issueNumber: 42, bridgeRequest },
    });
    expect(pushed.statusCode).toBe(201);

    const pulled = await app.inject({
      method: 'POST', url: '/mcp/copilot-relay', headers: mcpHeaders(),
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pull_external_task', arguments: {} } },
    });
    expect(pulled.statusCode).toBe(200);
    expect(pulled.json().result.structuredContent.task.issueNumber).toBe(42);
    expect(pulled.json().result.structuredContent.task.bridgeRequest.taskId).toBe(bridgeRequest.taskId);

    const claimed = await app.inject({
      method: 'POST', url: '/mcp/copilot-relay', headers: mcpHeaders(),
      payload: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'claim_external_task', arguments: { taskId: bridgeRequest.taskId } } },
    });
    expect(claimed.json().result.isError).toBe(false);

    const result = await app.inject({
      method: 'POST', url: '/mcp/copilot-relay', headers: mcpHeaders(),
      payload: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'submit_external_result', arguments: {
        bridgeVersion: 'aicos.copilot-bridge/v1', taskId: bridgeRequest.taskId, status: 'PASS',
        summary: 'Sanitized corporate advisory completed.', evidence: ['copilot:studio:test-pass'],
      } } },
    });
    expect(result.json().result.isError).toBe(false);

    const outbox = await app.inject({ method: 'GET', url: '/relay/copilot/outbox', headers: oidcHeaders() });
    expect(outbox.statusCode).toBe(200);
    const events = outbox.json().events;
    expect(events.map((event: { eventType: string }) => event.eventType)).toEqual(['claimed', 'result']);
    expect(events[1].payload.status).toBe('PASS');

    const ack = await app.inject({
      method: 'POST', url: '/relay/copilot/outbox/ack', headers: oidcHeaders(),
      payload: { eventIds: events.map((event: { eventId: string }) => event.eventId) },
    });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().acknowledged).toBe(2);
    const empty = await app.inject({ method: 'GET', url: '/relay/copilot/outbox', headers: oidcHeaders() });
    expect(empty.json().events).toEqual([]);
    await app.close();
    db.close();
  });

  it('expires queued work before Copilot can pull it', async () => {
    const { app, db } = await fixture();
    const expired = request('copilot-expired-test-001', { expiresAt: '2026-08-15T08:44:59.000Z' });
    const pushed = await app.inject({
      method: 'POST', url: '/relay/copilot/inbox', headers: oidcHeaders(),
      payload: { issueNumber: 77, bridgeRequest: expired },
    });
    expect(pushed.statusCode).toBe(409);
    expect(pushed.json().error).toBe('WORK_ORDER_EXPIRED');
    await app.close();
    db.close();
  });
});
