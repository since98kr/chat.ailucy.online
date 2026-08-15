export const SCHEMA_VERSION = 'aicos.agent-relay/v1';
export const AGENTS = Object.freeze(['openclaw', 'hermes', 'copilot', 'chatgpt']);
export const GATE_KEYS = Object.freeze(['merge', 'productionDeploy', 'secretChange', 'destructiveDb', 'liveAction']);
export const GATE_STATES = new Set(['approved', 'denied', 'not_requested']);
export const RESULT_STATUSES = new Set(['CLAIMED', 'RUNNING', 'PASS', 'PASS_WITH_NOTE', 'PARTIAL_PASS', 'FAIL', 'BLOCKED', 'UNKNOWN']);
export const TERMINAL_STATUSES = new Set(['PASS', 'PASS_WITH_NOTE', 'PARTIAL_PASS', 'FAIL', 'BLOCKED', 'UNKNOWN']);
export const WORK_MARKER = '<!-- aicos-agent-relay:v1:work-order -->';
export const RESULT_MARKER = '<!-- aicos-agent-relay:v1:result -->';

const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const INTERNAL_ACTIONS = new Set(['COMPLETE', 'DISPATCH', 'BLOCKED']);

export class RelayError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'RelayError';
    this.code = code;
  }
}

function fail(code, message) { throw new RelayError(code, message); }
function assert(condition, code, message) { if (!condition) fail(code, message); }
function isObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function assertKeys(value, allowed, path) {
  for (const key of Object.keys(value)) assert(allowed.has(key), 'UNKNOWN_FIELD', `${path}.${key}`);
}
function assertIso(value, path) {
  assert(typeof value === 'string' && value.length > 0, 'INVALID_DATE', path);
  const date = new Date(value);
  assert(Number.isFinite(date.getTime()) && date.toISOString() === value, 'INVALID_DATE', `${path} must be canonical ISO`);
}
function assertStrings(value, path, {min = 0, max = 100} = {}) {
  assert(Array.isArray(value), 'INVALID_LIST', path);
  assert(value.length >= min && value.length <= max, 'INVALID_LIST', `${path} count`);
  for (const [index, item] of value.entries()) assert(typeof item === 'string' && item.trim().length > 0, 'INVALID_LIST', `${path}[${index}]`);
}

export function secretLikeString(value) {
  if (typeof value !== 'string') return false;
  return [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\bBearer\s+[A-Za-z0-9._~+\/=:-]{12,}/i,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/i,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/i,
    /\bsk-[A-Za-z0-9_-]{16,}/i,
    /\bAKIA[0-9A-Z]{16}\b/,
  ].some((pattern) => pattern.test(value));
}

export function assertNoSecretMaterial(value, path = '$') {
  if (typeof value === 'string') {
    assert(!secretLikeString(value), 'SECRET_MATERIAL_REJECTED', path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const approvalGate = path === '$.approvals' && key === 'secretChange';
    if (!approvalGate) assert(!/(token|password|api[_-]?key|authorization|credential|private[_-]?key|secret)/i.test(key), 'SECRET_FIELD_REJECTED', `${path}.${key}`);
    assertNoSecretMaterial(item, `${path}.${key}`);
  }
}

export function validateWorkOrder(value) {
  assert(isObject(value), 'INVALID_WORK_ORDER', 'object required');
  const required = new Set(['schemaVersion','kind','taskId','createdAt','sourceAgent','targetAgent','objective','allowedScope','forbiddenScope','expectedOutput','approvals']);
  const allowed = new Set([...required, 'github', 'expiresAt', 'idempotencyKey']);
  assertKeys(value, allowed, '$');
  for (const key of required) assert(Object.hasOwn(value, key), 'MISSING_FIELD', key);
  assert(value.schemaVersion === SCHEMA_VERSION, 'UNSUPPORTED_SCHEMA', value.schemaVersion);
  assert(value.kind === 'work_order', 'INVALID_KIND', 'work_order required');
  assert(typeof value.taskId === 'string' && TASK_RE.test(value.taskId), 'INVALID_TASK_ID', value.taskId);
  assertIso(value.createdAt, '$.createdAt');
  assert(AGENTS.includes(value.sourceAgent), 'INVALID_SOURCE_AGENT', value.sourceAgent);
  assert(AGENTS.includes(value.targetAgent), 'INVALID_TARGET_AGENT', value.targetAgent);
  assert(typeof value.objective === 'string' && value.objective.trim().length > 0 && value.objective.length <= 4000, 'INVALID_OBJECTIVE', '1..4000 chars');
  assertStrings(value.allowedScope, '$.allowedScope', {min: 1, max: 50});
  assertStrings(value.forbiddenScope, '$.forbiddenScope', {min: 1, max: 50});
  assertStrings(value.expectedOutput, '$.expectedOutput', {min: 1, max: 50});
  assert(isObject(value.approvals), 'INVALID_APPROVALS', 'object required');
  assertKeys(value.approvals, new Set(GATE_KEYS), '$.approvals');
  for (const key of GATE_KEYS) assert(GATE_STATES.has(value.approvals[key]), 'INVALID_APPROVALS', key);
  if (value.github !== undefined) {
    assert(isObject(value.github), 'INVALID_GITHUB', 'object required');
    assertKeys(value.github, new Set(['repository','branch','issue','pullRequest','headSha']), '$.github');
    assert(typeof value.github.repository === 'string' && REPO_RE.test(value.github.repository), 'INVALID_REPOSITORY', 'owner/repo required');
    assert(typeof value.github.headSha === 'string' && SHA_RE.test(value.github.headSha), 'INVALID_HEAD_SHA', '40 hex required');
    if (value.github.branch !== undefined) assert(typeof value.github.branch === 'string' && value.github.branch.trim(), 'INVALID_BRANCH', 'non-empty required');
    for (const key of ['issue','pullRequest']) if (value.github[key] !== undefined) assert(Number.isInteger(value.github[key]) && value.github[key] > 0, 'INVALID_GITHUB', key);
  }
  if (value.expiresAt !== undefined) assertIso(value.expiresAt, '$.expiresAt');
  if (value.idempotencyKey !== undefined) assert(typeof value.idempotencyKey === 'string' && value.idempotencyKey.length >= 8 && value.idempotencyKey.length <= 200, 'INVALID_IDEMPOTENCY_KEY', '8..200 chars');
  assertNoSecretMaterial(value);
  return value;
}

export function validateResult(value) {
  assert(isObject(value), 'INVALID_RESULT', 'object required');
  const allowed = new Set(['schemaVersion','kind','taskId','agent','status','observedAt','summary','subjectSha','evidence','nextAction','blockedReason']);
  assertKeys(value, allowed, '$');
  for (const key of ['schemaVersion','kind','taskId','agent','status','observedAt','summary','evidence']) assert(Object.hasOwn(value, key), 'MISSING_FIELD', key);
  assert(value.schemaVersion === SCHEMA_VERSION, 'UNSUPPORTED_SCHEMA', value.schemaVersion);
  assert(value.kind === 'result', 'INVALID_KIND', 'result required');
  assert(typeof value.taskId === 'string' && TASK_RE.test(value.taskId), 'INVALID_TASK_ID', value.taskId);
  assert(AGENTS.includes(value.agent), 'INVALID_RESULT_AGENT', value.agent);
  assert(RESULT_STATUSES.has(value.status), 'INVALID_RESULT_STATUS', value.status);
  assertIso(value.observedAt, '$.observedAt');
  assert(typeof value.summary === 'string' && value.summary.trim().length > 0 && value.summary.length <= 8000, 'INVALID_SUMMARY', '1..8000 chars');
  assertStrings(value.evidence, '$.evidence', {min: 0, max: 100});
  if (value.subjectSha !== undefined) assert(typeof value.subjectSha === 'string' && SHA_RE.test(value.subjectSha), 'INVALID_SUBJECT_SHA', '40 hex required');
  if (value.nextAction !== undefined) assert(typeof value.nextAction === 'string' && value.nextAction.length <= 4000, 'INVALID_NEXT_ACTION', 'max 4000 chars');
  if (value.status === 'BLOCKED') assert(typeof value.blockedReason === 'string' && value.blockedReason.trim().length > 0, 'MISSING_BLOCKED_REASON', 'required');
  if (['PASS','PASS_WITH_NOTE','PARTIAL_PASS','FAIL'].includes(value.status)) assert(value.evidence.length > 0, 'MISSING_EVIDENCE', 'terminal execution result requires evidence');
  assertNoSecretMaterial(value);
  return value;
}

export function renderEnvelope(marker, value) {
  return `${marker}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export function parseEnvelope(text, marker, validator) {
  if (typeof text !== 'string' || !text.includes(marker)) return null;
  const tail = text.slice(text.indexOf(marker) + marker.length);
  const match = tail.match(/```json\s*([\s\S]*?)\s*```/i);
  assert(match, 'MISSING_JSON_BLOCK', marker);
  let value;
  try { value = JSON.parse(match[1]); } catch { fail('INVALID_JSON', marker); }
  return validator(value);
}
export const parseWorkOrder = (text) => parseEnvelope(text, WORK_MARKER, validateWorkOrder);
export const parseResult = (text) => parseEnvelope(text, RESULT_MARKER, validateResult);

export function validateOpenClawDecision(value, {allowDispatch = true} = {}) {
  assert(isObject(value), 'INVALID_DECISION', 'object required');
  const allowed = new Set(['action','summary','targetAgent','childObjective','expectedOutput','blockedReason']);
  assertKeys(value, allowed, '$decision');
  assert(INTERNAL_ACTIONS.has(value.action), 'INVALID_DECISION_ACTION', value.action);
  assert(typeof value.summary === 'string' && value.summary.trim().length > 0 && value.summary.length <= 2000, 'INVALID_DECISION_SUMMARY', '1..2000 chars');
  if (value.action === 'DISPATCH') {
    assert(allowDispatch, 'DISPATCH_NOT_ALLOWED', 'follow-up dispatch is not allowed at this stage');
    assert(['hermes','copilot','chatgpt'].includes(value.targetAgent), 'INVALID_DISPATCH_TARGET', value.targetAgent);
    assert(typeof value.childObjective === 'string' && value.childObjective.trim().length > 0 && value.childObjective.length <= 4000, 'INVALID_CHILD_OBJECTIVE', '1..4000 chars');
    assertStrings(value.expectedOutput, '$decision.expectedOutput', {min: 1, max: 20});
  }
  if (value.action === 'BLOCKED') assert(typeof value.blockedReason === 'string' && value.blockedReason.trim().length > 0 && value.blockedReason.length <= 1000, 'MISSING_BLOCKED_REASON', 'required');
  assertNoSecretMaterial(value, '$decision');
  return value;
}

export function makeChildWorkOrder(parent, {parentIssue, decision, sequence = 1, createdAt}) {
  validateWorkOrder(parent);
  validateOpenClawDecision(decision);
  assert(parent.targetAgent === 'openclaw', 'WRONG_PARENT_TARGET', parent.targetAgent);
  assert(decision.action === 'DISPATCH', 'INVALID_DECISION_ACTION', 'DISPATCH required');
  assert(Number.isInteger(parentIssue) && parentIssue > 0, 'INVALID_PARENT_ISSUE', String(parentIssue));
  assertIso(createdAt, '$createdAt');
  const childTaskId = `${parent.taskId}:dispatch:${decision.targetAgent}:${sequence}`;
  assert(TASK_RE.test(childTaskId), 'INVALID_TASK_ID', childTaskId);
  const parentToken = Buffer.from(parent.taskId, 'utf8').toString('base64url');
  const child = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'work_order',
    taskId: childTaskId,
    createdAt,
    sourceAgent: 'openclaw',
    targetAgent: decision.targetAgent,
    objective: decision.childObjective,
    allowedScope: [...parent.allowedScope],
    forbiddenScope: [...parent.forbiddenScope],
    expectedOutput: [...decision.expectedOutput],
    approvals: {...parent.approvals},
    idempotencyKey: `parentIssue:${parentIssue}:parentTask:${parentToken}:dispatch:${sequence}`,
  };
  if (parent.github) child.github = {...parent.github};
  return validateWorkOrder(child);
}

export function parseParentLink(workOrder) {
  validateWorkOrder(workOrder);
  if (workOrder.sourceAgent !== 'openclaw' || typeof workOrder.idempotencyKey !== 'string') return null;
  const match = workOrder.idempotencyKey.match(/^parentIssue:(\d+):parentTask:([A-Za-z0-9_-]+):dispatch:(\d+)$/);
  if (!match) return null;
  let parentTaskId;
  try { parentTaskId = Buffer.from(match[2], 'base64url').toString('utf8'); } catch { return null; }
  if (!TASK_RE.test(parentTaskId)) return null;
  return {parentIssue: Number(match[1]), parentTaskId, sequence: Number(match[3])};
}

export function resultFromDecision(workOrder, decision, {observedAt, evidence = []} = {}) {
  validateWorkOrder(workOrder);
  validateOpenClawDecision(decision, {allowDispatch: false});
  assertIso(observedAt, '$observedAt');
  const base = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'result',
    taskId: workOrder.taskId,
    agent: 'openclaw',
    observedAt,
    summary: decision.summary,
    evidence: [...evidence],
  };
  if (decision.action === 'BLOCKED') {
    return validateResult({...base, status: 'BLOCKED', blockedReason: decision.blockedReason});
  }
  assert(decision.action === 'COMPLETE', 'INVALID_DECISION_ACTION', 'COMPLETE or BLOCKED required');
  assert(!workOrder.github, 'SOURCE_COMPLETE_REQUIRES_EXECUTOR', 'source-bound work cannot be cognitively completed without executor evidence');
  return validateResult({...base, status: 'PASS', evidence: evidence.length ? [...evidence] : ['openclaw:cognitive-completion']});
}
