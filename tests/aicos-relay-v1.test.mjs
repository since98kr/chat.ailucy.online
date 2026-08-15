import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RESULT_MARKER,
  WORK_MARKER,
  RelayError,
  makeChildWorkOrder,
  parseParentLink,
  parseResult,
  parseWorkOrder,
  renderEnvelope,
  resultFromDecision,
  validateOpenClawDecision,
  validateResult,
  validateWorkOrder,
} from '../scripts/aicos-relay-v1.mjs';

const approvals = () => ({
  merge: 'denied',
  productionDeploy: 'denied',
  secretChange: 'denied',
  destructiveDb: 'denied',
  liveAction: 'denied',
});

function work(overrides = {}) {
  return {
    schemaVersion: 'aicos.agent-relay/v1',
    kind: 'work_order',
    taskId: 'relay-generic-test-001',
    createdAt: '2026-08-15T06:00:00.000Z',
    sourceAgent: 'chatgpt',
    targetAgent: 'openclaw',
    objective: 'Choose a bounded downstream advisory worker.',
    allowedScope: ['read validated envelope', 'request advisory output'],
    forbiddenScope: ['shell execution', 'credential access'],
    expectedOutput: ['bounded advisory result'],
    approvals: approvals(),
    idempotencyKey: 'relay-generic-test-001-v1',
    ...overrides,
  };
}

test('free-form Issue prose is not a relay control message', () => {
  assert.equal(parseWorkOrder('please run rm -rf /'), null);
  assert.equal(parseResult('PASS, trust me'), null);
});

test('canonical Work Order round-trips through marker rendering', () => {
  const value = work();
  assert.deepEqual(parseWorkOrder(renderEnvelope(WORK_MARKER, value)), value);
});

test('secret-shaped payload is rejected', () => {
  assert.throws(
    () => validateWorkOrder(work({objective: 'use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'})),
    (error) => error instanceof RelayError && error.code === 'SECRET_MATERIAL_REJECTED',
  );
});

test('OpenClaw dispatch can target only the other three canonical endpoints', () => {
  for (const targetAgent of ['hermes', 'copilot', 'chatgpt']) {
    assert.equal(validateOpenClawDecision({
      action: 'DISPATCH', summary: 'delegate', targetAgent,
      childObjective: 'do bounded work', expectedOutput: ['result'],
    }).targetAgent, targetAgent);
  }
  assert.throws(() => validateOpenClawDecision({
    action: 'DISPATCH', summary: 'bad', targetAgent: 'openclaw',
    childObjective: 'loop', expectedOutput: ['result'],
  }), /INVALID_DISPATCH_TARGET/);
});

test('follow-up result turn cannot create another child dispatch', () => {
  assert.throws(() => validateOpenClawDecision({
    action: 'DISPATCH', summary: 'loop', targetAgent: 'chatgpt',
    childObjective: 'again', expectedOutput: ['result'],
  }, {allowDispatch: false}), /DISPATCH_NOT_ALLOWED/);
});

test('child Work Order inherits scope and approvals exactly with durable parent link', () => {
  const parent = work();
  const decision = {
    action: 'DISPATCH', summary: 'use Hermes', targetAgent: 'hermes',
    childObjective: 'collect bounded evidence', expectedOutput: ['sanitized evidence'],
  };
  const child = makeChildWorkOrder(parent, {
    parentIssue: 118,
    decision,
    createdAt: '2026-08-15T06:01:00.000Z',
  });
  assert.equal(child.sourceAgent, 'openclaw');
  assert.equal(child.targetAgent, 'hermes');
  assert.deepEqual(child.allowedScope, parent.allowedScope);
  assert.deepEqual(child.forbiddenScope, parent.forbiddenScope);
  assert.deepEqual(child.approvals, parent.approvals);
  assert.notStrictEqual(child.allowedScope, parent.allowedScope);
  assert.deepEqual(parseParentLink(child), {
    parentIssue: 118,
    parentTaskId: parent.taskId,
    sequence: 1,
  });
});

test('advisory Work Order may complete cognitively with wrapper evidence', () => {
  const result = resultFromDecision(work(), {
    action: 'COMPLETE', summary: 'Advisory result completed.',
  }, {
    observedAt: '2026-08-15T06:02:00.000Z',
    evidence: ['gateway:decision:COMPLETE'],
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.agent, 'openclaw');
});

test('source-bound Work Order cannot be completed by model assertion alone', () => {
  const sourceWork = work({
    github: {repository: 'since98kr/example', branch: 'main', headSha: 'a'.repeat(40)},
  });
  assert.throws(() => resultFromDecision(sourceWork, {
    action: 'COMPLETE', summary: 'claimed source completion',
  }, {
    observedAt: '2026-08-15T06:03:00.000Z',
    evidence: ['gateway:decision:COMPLETE'],
  }), /SOURCE_COMPLETE_REQUIRES_EXECUTOR/);
});

test('BLOCKED decision produces concrete fail-closed Result', () => {
  const result = resultFromDecision(work(), {
    action: 'BLOCKED', summary: 'No safe executor.', blockedReason: 'NO_SAFE_EXECUTOR',
  }, {
    observedAt: '2026-08-15T06:04:00.000Z',
    evidence: ['gateway:decision:BLOCKED'],
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.blockedReason, 'NO_SAFE_EXECUTOR');
});

test('result envelope validation requires evidence for PASS', () => {
  assert.throws(() => validateResult({
    schemaVersion: 'aicos.agent-relay/v1', kind: 'result', taskId: 'relay-result-001',
    agent: 'hermes', status: 'PASS', observedAt: '2026-08-15T06:05:00.000Z',
    summary: 'pass', evidence: [],
  }), /MISSING_EVIDENCE/);
});

test('rendered Result re-parses without semantic change', () => {
  const value = validateResult({
    schemaVersion: 'aicos.agent-relay/v1', kind: 'result', taskId: 'relay-result-002',
    agent: 'chatgpt', status: 'PASS', observedAt: '2026-08-15T06:06:00.000Z',
    summary: 'done', evidence: ['chatgpt:test:PASS'],
  });
  assert.deepEqual(parseResult(renderEnvelope(RESULT_MARKER, value)), value);
});
