import assert from 'node:assert/strict';
import test from 'node:test';
import { fromCopilotBridgeResponse, toCopilotBridgeRequest, validateBrokerBaseUrl } from '../scripts/aicos-copilot-relay-broker-sync.mjs';

const approvals = () => ({
  merge: 'denied', productionDeploy: 'denied', secretChange: 'denied', destructiveDb: 'denied', liveAction: 'denied',
});

function work(overrides = {}) {
  return {
    schemaVersion: 'aicos.agent-relay/v1', kind: 'work_order', taskId: 'copilot-sync-test-001',
    createdAt: '2026-08-15T08:00:00.000Z', sourceAgent: 'openclaw', targetAgent: 'copilot',
    objective: 'Perform bounded advisory work.', allowedScope: ['read sanitized metadata'],
    forbiddenScope: ['secret access'], expectedOutput: ['sanitized result'], approvals: approvals(),
    idempotencyKey: 'copilot-sync-test-001-v1', ...overrides,
  };
}

test('canonical broker URL is always accepted', () => {
  assert.equal(validateBrokerBaseUrl('https://relay.ailucy.online'), 'https://relay.ailucy.online');
});

test('Quick Tunnel broker URL requires an explicit temporary gate', () => {
  const quick = 'https://temporary-relay.trycloudflare.com';
  assert.throws(() => validateBrokerBaseUrl(quick), /INVALID_BROKER_URL/);
  assert.equal(validateBrokerBaseUrl(quick, { allowQuickTunnel: true }), quick);
});

test('temporary broker gate still rejects non-Cloudflare hosts and URL decorations', () => {
  for (const value of [
    'http://temporary-relay.trycloudflare.com',
    'https://example.com',
    'https://trycloudflare.com.evil.example',
    'https://temporary-relay.trycloudflare.com/path',
    'https://temporary-relay.trycloudflare.com/?token=x',
    'https://user:pass@temporary-relay.trycloudflare.com',
  ]) {
    assert.throws(() => validateBrokerBaseUrl(value, { allowQuickTunnel: true }), /INVALID_BROKER_URL/);
  }
});

test('bridge mapping preserves future expiry and never marks prose executable', () => {
  const order = work({ expiresAt: '2026-08-15T09:00:00.000Z' });
  const request = toCopilotBridgeRequest(order, { now: Date.parse('2026-08-15T08:30:00.000Z') });
  assert.equal(request.expiresAt, order.expiresAt);
  assert.equal(request.issueProseExecutable, false);
  assert.equal(request.targetAgent, 'copilot');
});

test('expired and non-Copilot Work Orders fail closed before broker emission', () => {
  assert.throws(() => toCopilotBridgeRequest(work({ expiresAt: '2026-08-15T08:29:59.000Z' }), { now: Date.parse('2026-08-15T08:30:00.000Z') }), /WORK_ORDER_EXPIRED/);
  assert.throws(() => toCopilotBridgeRequest(work({ targetAgent: 'hermes' })), /WRONG_TARGET_AGENT/);
});

test('bridge response becomes canonical Copilot Result', () => {
  const order = work();
  const result = fromCopilotBridgeResponse(order, {
    bridgeVersion: 'aicos.copilot-bridge/v1', taskId: order.taskId, status: 'PASS',
    summary: 'Sanitized advisory complete.', evidence: ['copilot:studio:pass'],
  }, '2026-08-15T08:40:00.000Z');
  assert.deepEqual(result, {
    schemaVersion: 'aicos.agent-relay/v1', kind: 'result', taskId: order.taskId, agent: 'copilot', status: 'PASS',
    observedAt: '2026-08-15T08:40:00.000Z', summary: 'Sanitized advisory complete.', evidence: ['copilot:studio:pass'],
  });
});

test('source-bound result requires exact pinned SHA', () => {
  const sha = 'a'.repeat(40);
  const order = work({ github: { repository: 'since98kr/example', branch: 'main', headSha: sha } });
  assert.throws(() => fromCopilotBridgeResponse(order, {
    bridgeVersion: 'aicos.copilot-bridge/v1', taskId: order.taskId, status: 'PASS',
    summary: 'done', evidence: ['copilot:studio:pass'], subjectSha: 'b'.repeat(40),
  }, '2026-08-15T08:40:00.000Z'), /SUBJECT_SHA_MISMATCH/);
});
