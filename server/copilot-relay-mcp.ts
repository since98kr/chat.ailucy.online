import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ChatDatabase } from './database.js';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_PATH = '/mcp/copilot-relay';
const BROKER_INBOX_PATH = '/relay/copilot/inbox';
const BROKER_OUTBOX_PATH = '/relay/copilot/outbox';
const BROKER_ACK_PATH = '/relay/copilot/outbox/ack';
const DEFAULT_RELAY_HOST = 'relay.ailucy.online';
const DEFAULT_MCP_KEY_SHA256 = '70bcc5c898c78f0a1e14222ae6f1097d8c28b2a9221b278e4da4ef0ee3e1bddf';
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_JWKS = 'https://token.actions.githubusercontent.com/.well-known/jwks';
const GITHUB_OIDC_AUDIENCE = 'aicos-copilot-relay-v1';
const AICOS_REPOSITORY = 'since98kr/ai-collaboration-os';
const AICOS_REPOSITORY_ID = '1303635534';
const AICOS_WORKFLOW_REF = `${AICOS_REPOSITORY}/.github/workflows/copilot-relay-broker-sync.yml@refs/heads/main`;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const TERMINAL_STATUSES = ['PASS', 'PASS_WITH_NOTE', 'PARTIAL_PASS', 'FAIL', 'BLOCKED', 'UNKNOWN'] as const;
const GATE_STATES = ['approved', 'denied', 'not_requested'] as const;

const approvalSchema = z.object({
  merge: z.enum(GATE_STATES),
  productionDeploy: z.enum(GATE_STATES),
  secretChange: z.enum(GATE_STATES),
  destructiveDb: z.enum(GATE_STATES),
  liveAction: z.enum(GATE_STATES),
}).strict();

const githubSubjectSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  branch: z.string().min(1).optional(),
  issue: z.number().int().positive().optional(),
  pullRequest: z.number().int().positive().optional(),
  headSha: z.string().regex(SHA_RE),
}).strict();

export const copilotBridgeRequestSchema = z.object({
  bridgeVersion: z.literal('aicos.copilot-bridge/v1'),
  taskId: z.string().regex(TASK_ID_RE),
  objective: z.string().trim().min(1).max(4000),
  github: githubSubjectSchema.nullable(),
  scope: z.object({
    allowed: z.array(z.string().trim().min(1)).min(1).max(50),
    forbidden: z.array(z.string().trim().min(1)).min(1).max(50),
  }).strict(),
  expectedOutput: z.array(z.string().trim().min(1)).min(1).max(50),
  approvals: approvalSchema,
  sourceAgent: z.enum(['openclaw', 'hermes', 'chatgpt']),
  targetAgent: z.literal('copilot'),
  expiresAt: z.string().datetime().nullable(),
  issueProseExecutable: z.literal(false),
}).strict();

export const copilotBridgeResponseSchema = z.object({
  bridgeVersion: z.literal('aicos.copilot-bridge/v1'),
  taskId: z.string().regex(TASK_ID_RE),
  status: z.enum(TERMINAL_STATUSES),
  summary: z.string().trim().min(1).max(8000),
  evidence: z.array(z.string().trim().min(1)).max(100),
  subjectSha: z.string().regex(SHA_RE).optional(),
  blockedReason: z.string().trim().min(1).max(4000).optional(),
  nextAction: z.string().max(4000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'BLOCKED' && !value.blockedReason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['blockedReason'], message: 'required for BLOCKED' });
  }
  if (['PASS', 'PASS_WITH_NOTE', 'PARTIAL_PASS', 'FAIL'].includes(value.status) && value.evidence.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'terminal execution result requires evidence' });
  }
});

const inboxSchema = z.object({
  issueNumber: z.number().int().positive(),
  bridgeRequest: copilotBridgeRequestSchema,
}).strict();

const ackSchema = z.object({ eventIds: z.array(z.string().uuid()).min(1).max(100) }).strict();

const jsonRpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
}).strict();

type CopilotBridgeRequest = z.infer<typeof copilotBridgeRequestSchema>;
type CopilotBridgeResponse = z.infer<typeof copilotBridgeResponseSchema>;

type TaskRow = {
  task_id: string;
  issue_number: number;
  bridge_request_json: string;
  state: 'pending' | 'claimed' | 'terminal';
  created_at: string;
  updated_at: string;
};

type EventRow = {
  event_id: string;
  task_id: string;
  issue_number: number;
  event_type: 'claimed' | 'result';
  payload_json: string;
  created_at: string;
  delivered_at: string | null;
};

export type GitHubOidcVerifier = (token: string) => Promise<boolean>;

export type CopilotRelayOptions = {
  relayHost?: string;
  mcpApiKeySha256?: string;
  oidcVerifier?: GitHubOidcVerifier;
  now?: () => number;
};

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function secureHexEqual(left: string, right: string) {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function headerValue(request: FastifyRequest, name: string) {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value ?? '').trim();
}

function bearer(request: FastifyRequest) {
  const value = request.headers.authorization ?? '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function hostname(request: FastifyRequest) {
  return (request.headers.host ?? '').split(':')[0].trim().toLowerCase();
}

function jsonRpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolText(value: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value && typeof value === 'object' && !Array.isArray(value) ? value : { value },
    isError: false,
  };
}

function toolError(message: string) {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function originAllowed(request: FastifyRequest, relayHost: string) {
  const raw = headerValue(request, 'origin');
  if (!raw) return true;
  try {
    const origin = new URL(raw);
    if (origin.protocol !== 'https:') return false;
    const host = origin.hostname.toLowerCase();
    return host === relayHost
      || host.endsWith('.microsoft.com')
      || host.endsWith('.powerplatform.com')
      || host.endsWith('.powerapps.com');
  } catch {
    return false;
  }
}

function validateProtocolHeader(request: FastifyRequest) {
  const version = headerValue(request, 'mcp-protocol-version');
  return !version || version === '2025-03-26' || version === MCP_PROTOCOL_VERSION;
}

function highRiskApprovalPresent(request: CopilotBridgeRequest) {
  return Object.values(request.approvals).some((value) => value === 'approved');
}

function validateResponseAgainstTask(task: CopilotBridgeRequest, response: CopilotBridgeResponse) {
  if (response.taskId !== task.taskId) throw new Error('TASK_ID_MISMATCH');
  if (task.github) {
    if (!response.subjectSha) throw new Error('MISSING_SUBJECT_SHA');
    if (response.subjectSha.toLowerCase() !== task.github.headSha.toLowerCase()) throw new Error('SUBJECT_SHA_MISMATCH');
  }
}

export function createGitHubOidcVerifier(): GitHubOidcVerifier {
  const jwks = createRemoteJWKSet(new URL(GITHUB_OIDC_JWKS));
  return async (token: string) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: GITHUB_OIDC_ISSUER,
        audience: GITHUB_OIDC_AUDIENCE,
      });
      return payload.repository === AICOS_REPOSITORY
        && String(payload.repository_id ?? '') === AICOS_REPOSITORY_ID
        && payload.ref === 'refs/heads/main'
        && payload.workflow_ref === AICOS_WORKFLOW_REF;
    } catch {
      return false;
    }
  };
}

function migrate(db: ChatDatabase) {
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS copilot_relay_tasks (
      task_id TEXT PRIMARY KEY,
      issue_number INTEGER NOT NULL,
      bridge_request_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'terminal')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS copilot_relay_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES copilot_relay_tasks(task_id) ON DELETE CASCADE,
      issue_number INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('claimed', 'result')),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS copilot_relay_events_delivery_idx
      ON copilot_relay_events(delivered_at, created_at);
  `);
}

function insertEvent(
  db: ChatDatabase,
  taskId: string,
  issueNumber: number,
  eventType: 'claimed' | 'result',
  payload: unknown,
  createdAt: string,
  stableId?: string,
) {
  const eventId = stableId ?? randomUUID();
  db.db.prepare(`
    INSERT OR IGNORE INTO copilot_relay_events
      (event_id, task_id, issue_number, event_type, payload_json, created_at, delivered_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(eventId, taskId, issueNumber, eventType, JSON.stringify(payload), createdAt);
  return eventId;
}

function blockExpiredTasks(db: ChatDatabase, nowMs: number) {
  const rows = db.db.prepare(`
    SELECT task_id, issue_number, bridge_request_json, state, created_at, updated_at
    FROM copilot_relay_tasks
    WHERE state IN ('pending', 'claimed')
    ORDER BY created_at ASC
  `).all() as TaskRow[];
  const nowIso = new Date(nowMs).toISOString();
  for (const row of rows) {
    const task = copilotBridgeRequestSchema.parse(JSON.parse(row.bridge_request_json));
    if (!task.expiresAt || Date.parse(task.expiresAt) > nowMs) continue;
    const response: CopilotBridgeResponse = {
      bridgeVersion: 'aicos.copilot-bridge/v1',
      taskId: task.taskId,
      status: 'BLOCKED',
      summary: 'Corporate Copilot relay task expired before execution.',
      evidence: ['copilot:relay-broker:expired'],
      ...(task.github ? { subjectSha: task.github.headSha } : {}),
      blockedReason: 'WORK_ORDER_EXPIRED',
    };
    db.db.prepare(`UPDATE copilot_relay_tasks SET state='terminal', updated_at=? WHERE task_id=?`).run(nowIso, task.taskId);
    insertEvent(db, task.taskId, row.issue_number, 'result', response, nowIso, `expired:${task.taskId}`);
  }
}

function nextPendingTask(db: ChatDatabase, nowMs: number) {
  blockExpiredTasks(db, nowMs);
  const row = db.db.prepare(`
    SELECT task_id, issue_number, bridge_request_json, state, created_at, updated_at
    FROM copilot_relay_tasks
    WHERE state='pending'
    ORDER BY created_at ASC
    LIMIT 1
  `).get() as TaskRow | undefined;
  if (!row) return null;
  return {
    issueNumber: row.issue_number,
    bridgeRequest: copilotBridgeRequestSchema.parse(JSON.parse(row.bridge_request_json)),
  };
}

function claimTask(db: ChatDatabase, taskId: string, nowMs: number) {
  blockExpiredTasks(db, nowMs);
  const row = db.db.prepare(`
    SELECT task_id, issue_number, bridge_request_json, state, created_at, updated_at
    FROM copilot_relay_tasks WHERE task_id=?
  `).get(taskId) as TaskRow | undefined;
  if (!row) throw new Error('TASK_NOT_FOUND');
  if (row.state === 'terminal') throw new Error('TASK_ALREADY_TERMINAL');
  const nowIso = new Date(nowMs).toISOString();
  if (row.state === 'pending') {
    db.db.prepare(`UPDATE copilot_relay_tasks SET state='claimed', updated_at=? WHERE task_id=?`).run(nowIso, taskId);
    insertEvent(db, taskId, row.issue_number, 'claimed', {
      taskId,
      status: 'CLAIMED',
      summary: 'Corporate Copilot claimed the validated relay Work Order through the MCP bridge.',
      evidence: ['copilot:mcp:claimed'],
    }, nowIso, `claimed:${taskId}`);
  }
  return { taskId, claimed: true };
}

function submitResult(db: ChatDatabase, value: unknown, nowMs: number) {
  blockExpiredTasks(db, nowMs);
  const response = copilotBridgeResponseSchema.parse(value);
  const row = db.db.prepare(`
    SELECT task_id, issue_number, bridge_request_json, state, created_at, updated_at
    FROM copilot_relay_tasks WHERE task_id=?
  `).get(response.taskId) as TaskRow | undefined;
  if (!row) throw new Error('TASK_NOT_FOUND');
  if (row.state === 'terminal') throw new Error('TASK_ALREADY_TERMINAL');
  const task = copilotBridgeRequestSchema.parse(JSON.parse(row.bridge_request_json));
  validateResponseAgainstTask(task, response);
  const nowIso = new Date(nowMs).toISOString();
  db.db.prepare(`UPDATE copilot_relay_tasks SET state='terminal', updated_at=? WHERE task_id=?`).run(nowIso, response.taskId);
  insertEvent(db, response.taskId, row.issue_number, 'result', response, nowIso, `result:${response.taskId}`);
  return { taskId: response.taskId, accepted: true, status: response.status };
}

function mcpTools() {
  return [
    {
      name: 'pull_external_task',
      title: 'Pull next external relay task',
      description: 'Fetch the next validated, non-expired aicos.copilot-bridge/v1 task addressed to Corporate Copilot. Returns null when no task is pending.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'claim_external_task',
      title: 'Claim external relay task',
      description: 'Claim one taskId before doing advisory work. Claiming records durable relay evidence for the external orchestrator.',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string', minLength: 3, maxLength: 160 } },
        required: ['taskId'],
        additionalProperties: false,
      },
    },
    {
      name: 'submit_external_result',
      title: 'Submit external relay result',
      description: 'Submit one terminal aicos.copilot-bridge/v1 Result for the claimed task. Do not include secrets or unsanitized corporate content.',
      inputSchema: {
        type: 'object',
        properties: {
          bridgeVersion: { type: 'string', const: 'aicos.copilot-bridge/v1' },
          taskId: { type: 'string', minLength: 3, maxLength: 160 },
          status: { type: 'string', enum: [...TERMINAL_STATUSES] },
          summary: { type: 'string', minLength: 1, maxLength: 8000 },
          evidence: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 100 },
          subjectSha: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
          blockedReason: { type: 'string', minLength: 1, maxLength: 4000 },
          nextAction: { type: 'string', maxLength: 4000 },
        },
        required: ['bridgeVersion', 'taskId', 'status', 'summary', 'evidence'],
        additionalProperties: false,
      },
    },
  ];
}

async function handleToolCall(db: ChatDatabase, name: string, args: unknown, nowMs: number) {
  try {
    if (name === 'pull_external_task') return toolText({ task: nextPendingTask(db, nowMs) });
    if (name === 'claim_external_task') {
      const input = z.object({ taskId: z.string().regex(TASK_ID_RE) }).strict().parse(args ?? {});
      return toolText(claimTask(db, input.taskId, nowMs));
    }
    if (name === 'submit_external_result') return toolText(submitResult(db, args, nowMs));
    throw new Error('UNKNOWN_TOOL');
  } catch (error) {
    return toolError(error instanceof Error ? error.message : 'TOOL_FAILED');
  }
}

export function registerCopilotRelayMcp(
  app: FastifyInstance,
  db: ChatDatabase,
  options: CopilotRelayOptions = {},
) {
  migrate(db);
  const relayHost = (options.relayHost ?? process.env.COPILOT_RELAY_HOST ?? DEFAULT_RELAY_HOST).trim().toLowerCase();
  const mcpApiKeySha256 = (options.mcpApiKeySha256 ?? process.env.COPILOT_RELAY_KEY_SHA256 ?? DEFAULT_MCP_KEY_SHA256).trim().toLowerCase();
  const oidcVerifier = options.oidcVerifier ?? createGitHubOidcVerifier();
  const now = options.now ?? Date.now;

  app.addHook('onRequest', async (request, reply) => {
    if (hostname(request) !== relayHost) return;
    if (request.url === MCP_PATH || request.url.startsWith(`${MCP_PATH}?`)) return;
    if (request.url === BROKER_INBOX_PATH || request.url.startsWith(`${BROKER_OUTBOX_PATH}`)) return;
    return reply.status(404).send({ error: 'NOT_FOUND' });
  });

  async function requireMcpAuth(request: FastifyRequest, reply: FastifyReply) {
    if (hostname(request) !== relayHost) return reply.status(404).send({ error: 'NOT_FOUND' });
    if (!originAllowed(request, relayHost)) return reply.status(403).send({ error: 'ORIGIN_NOT_ALLOWED' });
    if (!validateProtocolHeader(request)) return reply.status(400).send({ error: 'UNSUPPORTED_MCP_PROTOCOL_VERSION' });
    const supplied = headerValue(request, 'x-aicos-relay-key');
    if (!supplied || !secureHexEqual(sha256(supplied), mcpApiKeySha256)) {
      return reply.status(401).send({ error: 'MCP_AUTHENTICATION_REQUIRED' });
    }
  }

  async function requireGitHubOidc(request: FastifyRequest, reply: FastifyReply) {
    if (hostname(request) !== relayHost) return reply.status(404).send({ error: 'NOT_FOUND' });
    const token = bearer(request);
    if (!token || !(await oidcVerifier(token))) return reply.status(403).send({ error: 'GITHUB_OIDC_DENIED' });
  }

  app.get(MCP_PATH, { preHandler: requireMcpAuth }, async (_request, reply) => {
    reply.header('Allow', 'POST');
    return reply.status(405).send({ error: 'SSE_NOT_SUPPORTED' });
  });

  app.post(MCP_PATH, { preHandler: requireMcpAuth }, async (request, reply) => {
    const parsed = jsonRpcSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.header('Content-Type', 'application/json');
      return reply.status(400).send(jsonRpcError(null, -32600, 'Invalid Request'));
    }
    const message = parsed.data;
    if (message.id === undefined) {
      if (message.method === 'notifications/initialized' || message.method.startsWith('notifications/')) {
        return reply.status(202).send();
      }
      return reply.status(202).send();
    }

    let result: unknown;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'aicos-corporate-copilot-relay', version: '1.0.0' },
        instructions: 'Pull a task, claim it, perform only the bounded advisory work, then submit a sanitized terminal result. Never include secrets or raw corporate content in relay results.',
      };
    } else if (message.method === 'ping') {
      result = {};
    } else if (message.method === 'tools/list') {
      result = { tools: mcpTools() };
    } else if (message.method === 'tools/call') {
      const params = z.object({
        name: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).optional(),
      }).strict().safeParse(message.params ?? {});
      if (!params.success) return reply.send(jsonRpcError(message.id, -32602, 'Invalid params'));
      result = await handleToolCall(db, params.data.name, params.data.arguments ?? {}, now());
    } else {
      return reply.send(jsonRpcError(message.id, -32601, 'Method not found'));
    }
    reply.header('Content-Type', 'application/json');
    return reply.send(jsonRpcResult(message.id, result));
  });

  app.post(BROKER_INBOX_PATH, { preHandler: requireGitHubOidc }, async (request, reply) => {
    const input = inboxSchema.parse(request.body);
    const bridgeRequest = input.bridgeRequest;
    const nowMs = now();
    if (bridgeRequest.expiresAt && Date.parse(bridgeRequest.expiresAt) <= nowMs) {
      return reply.status(409).send({ error: 'WORK_ORDER_EXPIRED' });
    }
    if (highRiskApprovalPresent(bridgeRequest)) {
      return reply.status(409).send({ error: 'COPILOT_ADVISORY_CANNOT_EXERCISE_APPROVAL' });
    }
    const existing = db.db.prepare(`SELECT issue_number, bridge_request_json FROM copilot_relay_tasks WHERE task_id=?`).get(bridgeRequest.taskId) as { issue_number: number; bridge_request_json: string } | undefined;
    if (existing) {
      if (existing.issue_number !== input.issueNumber || existing.bridge_request_json !== JSON.stringify(bridgeRequest)) {
        return reply.status(409).send({ error: 'TASK_ID_COLLISION' });
      }
      return { accepted: true, idempotent: true, taskId: bridgeRequest.taskId };
    }
    const nowIso = new Date(nowMs).toISOString();
    db.db.prepare(`
      INSERT INTO copilot_relay_tasks
        (task_id, issue_number, bridge_request_json, state, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(bridgeRequest.taskId, input.issueNumber, JSON.stringify(bridgeRequest), nowIso, nowIso);
    return reply.status(201).send({ accepted: true, idempotent: false, taskId: bridgeRequest.taskId });
  });

  app.get(BROKER_OUTBOX_PATH, { preHandler: requireGitHubOidc }, async (request) => {
    blockExpiredTasks(db, now());
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query ?? {});
    const rows = db.db.prepare(`
      SELECT event_id, task_id, issue_number, event_type, payload_json, created_at, delivered_at
      FROM copilot_relay_events
      WHERE delivered_at IS NULL
      ORDER BY created_at ASC
      LIMIT ?
    `).all(query.limit) as EventRow[];
    return {
      events: rows.map((row) => ({
        eventId: row.event_id,
        taskId: row.task_id,
        issueNumber: row.issue_number,
        eventType: row.event_type,
        payload: JSON.parse(row.payload_json),
        createdAt: row.created_at,
      })),
    };
  });

  app.post(BROKER_ACK_PATH, { preHandler: requireGitHubOidc }, async (request) => {
    const input = ackSchema.parse(request.body);
    const deliveredAt = new Date(now()).toISOString();
    const update = db.db.prepare(`UPDATE copilot_relay_events SET delivered_at=? WHERE event_id=? AND delivered_at IS NULL`);
    const transaction = db.db.transaction((ids: string[]) => ids.reduce((count, id) => count + update.run(deliveredAt, id).changes, 0));
    return { acknowledged: transaction(input.eventIds) };
  });
}
