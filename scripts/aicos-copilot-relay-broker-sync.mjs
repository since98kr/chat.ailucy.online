#!/usr/bin/env node

import {
  RESULT_MARKER,
  TERMINAL_STATUSES,
  WORK_MARKER,
  parseResult,
  parseWorkOrder,
  renderEnvelope,
  validateResult,
  validateWorkOrder,
} from './aicos-relay-v1.mjs';

const TRUSTED_ACTORS = new Set(['since98kr', 'github-actions[bot]']);
const BROKER_BASE = (process.env.COPILOT_RELAY_BROKER_URL || 'https://relay.ailucy.online').replace(/\/$/, '');
const OIDC_AUDIENCE = 'aicos-copilot-relay-v1';
const MAX_PAGES = 20;
const MAX_SYNC = 50;
const TERMINAL_BRIDGE_STATUSES = new Set(['PASS', 'PASS_WITH_NOTE', 'PARTIAL_PASS', 'FAIL', 'BLOCKED', 'UNKNOWN']);

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}
function assert(condition, code, message) { if (!condition) fail(code, message); }
function trusted(login) { return typeof login === 'string' && TRUSTED_ACTORS.has(login); }
function sameEnvelope(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function nowIso() { return new Date().toISOString(); }

function config() {
  const repo = process.env.GITHUB_REPOSITORY || 'since98kr/chat.ailucy.online';
  const token = process.env.GITHUB_TOKEN || '';
  assert(repo === 'since98kr/chat.ailucy.online', 'INVALID_RELAY_REPO', repo);
  assert(token, 'MISSING_GITHUB_TOKEN', 'GITHUB_TOKEN required');
  const broker = new URL(BROKER_BASE);
  assert(broker.protocol === 'https:' && broker.hostname === 'relay.ailucy.online', 'INVALID_BROKER_URL', BROKER_BASE);
  return { repo, token, brokerBase: broker.origin };
}

async function githubRequest(cfg, path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${cfg.token}`,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) fail('GITHUB_API_FAILED', `${response.status} ${response.statusText}`);
  return response.status === 204 ? null : response.json();
}

async function listAll(cfg, path) {
  const all = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await githubRequest(cfg, `${path}${separator}per_page=100&page=${page}`);
    assert(Array.isArray(batch), 'INVALID_GITHUB_RESPONSE', path);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  fail('PAGINATION_LIMIT', path);
}

async function oidcToken() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL || '';
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || '';
  assert(requestUrl && requestToken, 'OIDC_UNAVAILABLE', 'GitHub Actions id-token:write is required');
  const separator = requestUrl.includes('?') ? '&' : '?';
  const response = await fetch(`${requestUrl}${separator}audience=${encodeURIComponent(OIDC_AUDIENCE)}`, {
    headers: { authorization: `Bearer ${requestToken}` },
  });
  assert(response.ok, 'OIDC_REQUEST_FAILED', String(response.status));
  const value = await response.json();
  assert(typeof value?.value === 'string' && value.value.length > 20, 'OIDC_RESPONSE_INVALID', 'missing token');
  return value.value;
}

async function brokerRequest(cfg, oidc, path, options = {}) {
  const response = await fetch(`${cfg.brokerBase}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${oidc}`,
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    fail('BROKER_REQUEST_FAILED', `${response.status} ${path} ${text.slice(0, 300)}`);
  }
  return response.status === 204 ? null : response.json();
}

export function toCopilotBridgeRequest(workOrder, { now = Date.now() } = {}) {
  const order = validateWorkOrder(workOrder);
  assert(order.targetAgent === 'copilot', 'WRONG_TARGET_AGENT', order.targetAgent);
  if (order.expiresAt) assert(Date.parse(order.expiresAt) > now, 'WORK_ORDER_EXPIRED', order.expiresAt);
  return {
    bridgeVersion: 'aicos.copilot-bridge/v1',
    taskId: order.taskId,
    objective: order.objective,
    github: order.github ? { ...order.github } : null,
    scope: { allowed: [...order.allowedScope], forbidden: [...order.forbiddenScope] },
    expectedOutput: [...order.expectedOutput],
    approvals: { ...order.approvals },
    sourceAgent: order.sourceAgent,
    targetAgent: 'copilot',
    expiresAt: order.expiresAt ?? null,
    issueProseExecutable: false,
  };
}

function validateBridgeResponse(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_BRIDGE_RESPONSE', 'object required');
  const allowed = new Set(['bridgeVersion','taskId','status','summary','evidence','subjectSha','blockedReason','nextAction']);
  for (const key of Object.keys(value)) assert(allowed.has(key), 'UNKNOWN_BRIDGE_FIELD', key);
  assert(value.bridgeVersion === 'aicos.copilot-bridge/v1', 'UNSUPPORTED_BRIDGE_VERSION', String(value.bridgeVersion));
  assert(typeof value.taskId === 'string' && value.taskId.length >= 3, 'INVALID_TASK_ID', String(value.taskId));
  assert(TERMINAL_BRIDGE_STATUSES.has(value.status), 'INVALID_STATUS', String(value.status));
  assert(typeof value.summary === 'string' && value.summary.trim().length > 0 && value.summary.length <= 8000, 'INVALID_SUMMARY', '1..8000 chars');
  assert(Array.isArray(value.evidence) && value.evidence.length <= 100 && value.evidence.every((item) => typeof item === 'string' && item.trim()), 'INVALID_EVIDENCE', 'string list required');
  if (value.status === 'BLOCKED') assert(typeof value.blockedReason === 'string' && value.blockedReason.trim(), 'MISSING_BLOCKED_REASON', 'required');
  if (['PASS','PASS_WITH_NOTE','PARTIAL_PASS','FAIL'].includes(value.status)) assert(value.evidence.length > 0, 'MISSING_EVIDENCE', 'required');
  if (value.subjectSha !== undefined) assert(/^[0-9a-f]{40}$/i.test(value.subjectSha), 'INVALID_SUBJECT_SHA', String(value.subjectSha));
  if (value.nextAction !== undefined) assert(typeof value.nextAction === 'string' && value.nextAction.length <= 4000, 'INVALID_NEXT_ACTION', 'max 4000');
  return value;
}

export function fromCopilotBridgeResponse(workOrder, bridgeResponse, observedAt) {
  const order = validateWorkOrder(workOrder);
  assert(order.targetAgent === 'copilot', 'WRONG_TARGET_AGENT', order.targetAgent);
  const response = validateBridgeResponse(bridgeResponse);
  assert(response.taskId === order.taskId, 'TASK_ID_MISMATCH', `${response.taskId} != ${order.taskId}`);
  if (order.github) {
    assert(typeof response.subjectSha === 'string', 'MISSING_SUBJECT_SHA', 'source-bound terminal response requires subjectSha');
    assert(response.subjectSha.toLowerCase() === order.github.headSha.toLowerCase(), 'SUBJECT_SHA_MISMATCH', response.subjectSha);
  }
  return validateResult({
    schemaVersion: 'aicos.agent-relay/v1',
    kind: 'result',
    taskId: order.taskId,
    agent: 'copilot',
    status: response.status,
    observedAt,
    summary: response.summary,
    evidence: [...response.evidence],
    ...(response.subjectSha ? { subjectSha: response.subjectSha } : {}),
    ...(response.blockedReason ? { blockedReason: response.blockedReason } : {}),
    ...(response.nextAction ? { nextAction: response.nextAction } : {}),
  });
}

async function snapshot(cfg, issue) {
  assert(!issue.pull_request, 'NOT_RELAY_ISSUE', String(issue.number));
  assert(trusted(issue.user?.login), 'UNTRUSTED_ISSUE_AUTHOR', issue.user?.login || '<missing>');
  const workOrder = parseWorkOrder(issue.body || '');
  assert(workOrder, 'MISSING_WORK_ORDER', String(issue.number));
  const comments = await listAll(cfg, `/repos/${cfg.repo}/issues/${issue.number}/comments`);
  const results = [];
  for (const comment of comments) {
    if (!trusted(comment.user?.login)) continue;
    let result;
    try { result = parseResult(comment.body || ''); } catch { continue; }
    if (!result || result.taskId !== workOrder.taskId || result.agent !== workOrder.targetAgent) continue;
    if (workOrder.github && TERMINAL_STATUSES.has(result.status)) {
      if (!result.subjectSha || result.subjectSha.toLowerCase() !== workOrder.github.headSha.toLowerCase()) continue;
    }
    results.push(result);
  }
  return { issue, workOrder, latest: results.at(-1) || null, results };
}

async function postCanonicalResult(cfg, issueNumber, result) {
  validateResult(result);
  const body = renderEnvelope(RESULT_MARKER, result);
  return githubRequest(cfg, `/repos/${cfg.repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

async function pushCopilotInbox(cfg, oidc) {
  const issues = await listAll(cfg, `/repos/${cfg.repo}/issues?state=open&sort=created&direction=asc`);
  let pushed = 0;
  for (const issue of issues) {
    if (pushed >= MAX_SYNC || issue.pull_request || !trusted(issue.user?.login) || typeof issue.body !== 'string' || !issue.body.includes(WORK_MARKER)) continue;
    let state;
    try { state = await snapshot(cfg, issue); } catch { continue; }
    const { workOrder, latest } = state;
    if (workOrder.targetAgent !== 'copilot') continue;
    if (latest && TERMINAL_STATUSES.has(latest.status)) continue;
    if (workOrder.expiresAt && Date.parse(workOrder.expiresAt) <= Date.now()) continue;
    const bridgeRequest = toCopilotBridgeRequest(workOrder);
    await brokerRequest(cfg, oidc, '/relay/copilot/inbox', {
      method: 'POST',
      body: JSON.stringify({ issueNumber: issue.number, bridgeRequest }),
    });
    pushed += 1;
  }
  return pushed;
}

async function processOutboxEvent(cfg, event) {
  assert(event && typeof event === 'object', 'INVALID_OUTBOX_EVENT', 'object required');
  assert(typeof event.eventId === 'string' && event.eventId, 'INVALID_OUTBOX_EVENT', 'eventId');
  assert(Number.isInteger(event.issueNumber) && event.issueNumber > 0, 'INVALID_OUTBOX_EVENT', 'issueNumber');
  const issue = await githubRequest(cfg, `/repos/${cfg.repo}/issues/${event.issueNumber}`);
  const state = await snapshot(cfg, issue);
  assert(state.workOrder.targetAgent === 'copilot', 'WRONG_TARGET_AGENT', state.workOrder.targetAgent);
  assert(state.workOrder.taskId === event.taskId, 'TASK_ID_MISMATCH', String(event.taskId));

  if (event.eventType === 'claimed') {
    if (state.latest && (state.latest.status === 'CLAIMED' || state.latest.status === 'RUNNING' || TERMINAL_STATUSES.has(state.latest.status))) return;
    const result = validateResult({
      schemaVersion: 'aicos.agent-relay/v1', kind: 'result', taskId: state.workOrder.taskId,
      agent: 'copilot', status: 'CLAIMED', observedAt: event.createdAt || nowIso(),
      summary: event.payload?.summary || 'Corporate Copilot claimed the Work Order through the MCP bridge.',
      evidence: Array.isArray(event.payload?.evidence) ? event.payload.evidence : ['copilot:mcp:claimed'],
    });
    await postCanonicalResult(cfg, event.issueNumber, result);
    return;
  }

  assert(event.eventType === 'result', 'INVALID_OUTBOX_EVENT', String(event.eventType));
  const result = fromCopilotBridgeResponse(state.workOrder, event.payload, event.createdAt || nowIso());
  if (state.latest && TERMINAL_STATUSES.has(state.latest.status)) {
    if (sameEnvelope(state.latest, result)) return;
    fail('TERMINAL_RESULT_CONFLICT', state.workOrder.taskId);
  }
  await postCanonicalResult(cfg, event.issueNumber, result);
}

async function drainOutbox(cfg, oidc) {
  const response = await brokerRequest(cfg, oidc, `/relay/copilot/outbox?limit=${MAX_SYNC}`);
  const events = Array.isArray(response?.events) ? response.events : [];
  const ack = [];
  for (const event of events) {
    await processOutboxEvent(cfg, event);
    ack.push(event.eventId);
  }
  if (ack.length) {
    await brokerRequest(cfg, oidc, '/relay/copilot/outbox/ack', {
      method: 'POST',
      body: JSON.stringify({ eventIds: ack }),
    });
  }
  return ack.length;
}

export async function syncOnce() {
  const cfg = config();
  const oidc = await oidcToken();
  const pushed = await pushCopilotInbox(cfg, oidc);
  const drained = await drainOutbox(cfg, oidc);
  return { pushed, drained };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncOnce().then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  }).catch((error) => {
    console.error(`aicos-copilot-relay-broker-sync: ${error.message}`);
    process.exitCode = 1;
  });
}
