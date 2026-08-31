import { GatewayClient } from '@openclaw/gateway-client';
import type {
  ConversationOperatingContext,
  PendingApprovalBinding,
} from '../shared/conversation-operating-context.js';

type OpenClawApprovalRequest = {
  command?: unknown;
  commandPreview?: unknown;
  sessionKey?: unknown;
  agentId?: unknown;
};

type OpenClawApprovalRecord = {
  approvalKind?: unknown;
  id?: unknown;
  request?: unknown;
  createdAtMs?: unknown;
  expiresAtMs?: unknown;
};

export interface ConversationApprovalBackend {
  start?(): Promise<void>;
  close?(): Promise<void>;
  listPending(context: ConversationOperatingContext): Promise<PendingApprovalBinding[]>;
  resolvePending(context: ConversationOperatingContext, approvalId: string): Promise<void>;
}

export type OpenClawApprovalBackendConfig = {
  gatewayUrl: string;
  token: string;
  timeoutMs: number;
  expectedAgentId?: string;
};

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedText(value: unknown, fallback: string, maxLength = 500) {
  const raw = typeof value === 'string' ? value : '';
  const normalized = raw.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  return (normalized || fallback).slice(0, maxLength);
}

function asTimestamp(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function gatewayWebSocketUrl(value: string) {
  const url = new URL(value);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('OpenClaw approval gateway URL must use http(s) or ws(s)');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function openClawRuntimeAgentId(target: string | undefined) {
  const value = target?.trim();
  if (!value || value === 'openclaw' || value === 'openclaw/default') return undefined;
  if (value.startsWith('openclaw/')) return value.slice('openclaw/'.length) || undefined;
  if (value.startsWith('openclaw:')) return value.slice('openclaw:'.length) || undefined;
  if (value.startsWith('agent:')) return value.slice('agent:'.length) || undefined;
  return undefined;
}

export function mapOpenClawPendingApprovals(
  context: ConversationOperatingContext,
  records: readonly unknown[],
  expectedAgentId?: string,
): PendingApprovalBinding[] {
  const mapped: PendingApprovalBinding[] = [];
  for (const raw of records) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as OpenClawApprovalRecord;
    const request = record.request;
    if (!request || typeof request !== 'object' || Array.isArray(request)) continue;
    const approvalRequest = request as OpenClawApprovalRequest;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const sessionKey = typeof approvalRequest.sessionKey === 'string'
      ? approvalRequest.sessionKey.trim()
      : '';
    const agentId = typeof approvalRequest.agentId === 'string'
      ? approvalRequest.agentId.trim()
      : '';
    const createdAtMs = asTimestamp(record.createdAtMs);
    if (!id || !sessionKey || sessionKey !== context.sessionIdentity || createdAtMs === null) continue;
    if (expectedAgentId && agentId !== expectedAgentId) continue;
    const expiresAtMs = asTimestamp(record.expiresAtMs);
    const kind = boundedText(record.approvalKind, 'exec', 80);
    const summary = boundedText(
      approvalRequest.commandPreview ?? approvalRequest.command,
      'OpenClaw protected action',
    );
    mapped.push({
      conversationId: context.conversationId,
      backendSystem: context.backendSystem,
      agentId: context.agentId,
      sessionIdentity: context.sessionIdentity,
      approvalId: id,
      kind,
      summary,
      state: 'pending',
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
    });
  }
  return mapped;
}

export class OpenClawApprovalBackend implements ConversationApprovalBackend {
  private readonly approvalSurface: GatewayClient;
  private readonly approvalSurfaceReady: Promise<void>;

  constructor(readonly config: OpenClawApprovalBackendConfig) {
    let resolveSurface!: () => void;
    let rejectSurface!: (error: Error) => void;
    this.approvalSurfaceReady = new Promise<void>((resolve, reject) => {
      resolveSurface = resolve;
      rejectSurface = reject;
    });
    this.approvalSurface = new GatewayClient({
      url: gatewayWebSocketUrl(this.config.gatewayUrl),
      token: this.config.token,
      role: 'operator',
      scopes: ['operator.admin'],
      // OpenClaw treats this capability as a real exec-approval delivery surface.
      // Keeping it connected prevents a protected agent action from being
      // discarded as `no-approval-route` before Lucy Chat can re-verify it.
      caps: ['exec-approvals'],
      clientName: 'gateway-client',
      clientDisplayName: 'Lucy Chat approval surface',
      clientVersion: '0.8.0',
      platform: process.platform,
      mode: 'backend',
      requestTimeoutMs: this.config.timeoutMs,
      onHelloOk: () => resolveSurface(),
      onReconnectPaused: (info) => rejectSurface(
        new Error(`OpenClaw approval surface reconnect paused (${info.code})`),
      ),
    });
    this.approvalSurface.start();
  }

  async start() {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.approvalSurfaceReady,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('OpenClaw approval surface connection timed out')),
            this.config.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async close() {
    await this.approvalSurface.stopAndWait({ timeoutMs: 1_000 }).catch(() => undefined);
  }

  private async withClient<T>(run: (client: GatewayClient) => Promise<T>): Promise<T> {
    let connectedResolve!: () => void;
    let connectedReject!: (error: Error) => void;
    const connected = new Promise<void>((resolve, reject) => {
      connectedResolve = resolve;
      connectedReject = reject;
    });
    const client = new GatewayClient({
      url: gatewayWebSocketUrl(this.config.gatewayUrl),
      token: this.config.token,
      role: 'operator',
      // The existing OpenClaw HTTP adapter already uses the shared owner token.
      // Admin visibility is needed only to re-verify the backend-owned approval
      // record instead of trusting an id supplied by the chat client.
      scopes: ['operator.admin'],
      requestTimeoutMs: this.config.timeoutMs,
      onHelloOk: () => connectedResolve(),
      onConnectError: (error) => connectedReject(error),
      onReconnectPaused: (info) => connectedReject(
        new Error(`OpenClaw approval gateway reconnect paused (${info.code})`),
      ),
    });
    const timer = setTimeout(
      () => connectedReject(new Error('OpenClaw approval gateway connection timed out')),
      this.config.timeoutMs,
    );
    client.start();
    try {
      await connected;
      return await run(client);
    } finally {
      clearTimeout(timer);
      await client.stopAndWait({ timeoutMs: 1_000 }).catch(() => undefined);
    }
  }

  private async listRaw() {
    return await this.withClient(async (client) => {
      const records = await client.request<unknown>('exec.approval.list', {});
      if (!Array.isArray(records)) {
        throw new Error('OpenClaw approval list returned an invalid payload');
      }
      return records;
    });
  }

  async listPending(context: ConversationOperatingContext) {
    return mapOpenClawPendingApprovals(
      context,
      await this.listRaw(),
      this.config.expectedAgentId,
    );
  }

  async resolvePending(context: ConversationOperatingContext, approvalId: string) {
    const current = await this.listPending(context);
    const matches = current.filter((candidate) => candidate.approvalId === approvalId);
    if (matches.length !== 1) {
      throw new Error('OpenClaw approval is no longer pending for this Conversation');
    }
    await this.withClient(async (client) => {
      await client.request('exec.approval.resolve', {
        id: approvalId,
        decision: 'allow-once',
      });
    });
  }
}

export function createOpenClawApprovalBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ConversationApprovalBackend | null {
  if ((env.LETTA_PROTOCOL ?? '').trim().toLowerCase() !== 'openclaw') return null;
  const gatewayUrl = env.LETTA_OPENCLAW_GATEWAY_WS_URL?.trim() || env.LETTA_BASE_URL?.trim();
  const token = env.LETTA_OPENCLAW_GATEWAY_TOKEN?.trim() || env.LETTA_API_KEY?.trim();
  if (!gatewayUrl || !token) return null;
  return new OpenClawApprovalBackend({
    gatewayUrl,
    token,
    timeoutMs: positiveInteger(env.LETTA_TIMEOUT_MS, 10_000),
    expectedAgentId: openClawRuntimeAgentId(env.LETTA_OPENCLAW_AGENT_TARGET),
  });
}
