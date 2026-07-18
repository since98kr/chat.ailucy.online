#!/usr/bin/env node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_BODY_BYTES = 1_048_576;

function integer(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  const agentId = env.LETTA_AGENT_ID?.trim();
  const token = env.LETTA_BRIDGE_TOKEN?.trim();
  if (!agentId) throw new Error('LETTA_AGENT_ID is required');
  if (!token) throw new Error('LETTA_BRIDGE_TOKEN is required');

  return {
    host: env.LETTA_BRIDGE_HOST?.trim() || '127.0.0.1',
    port: integer(env.LETTA_BRIDGE_PORT, 18_283),
    token,
    agentId,
    command: env.LETTA_COMMAND?.trim() || '/home/since98kr/.local/bin/lucy-routed',
    cwd: env.LETTA_CWD?.trim() || '/home/since98kr/tei-letta',
    backend: env.LETTA_BACKEND?.trim() || 'local',
    maxSessions: integer(env.LETTA_MAX_SESSIONS, 8),
    idleMs: integer(env.LETTA_SESSION_IDLE_MS, 30 * 60_000),
    requestTimeoutMs: integer(env.LETTA_REQUEST_TIMEOUT_MS, 5 * 60_000),
    maxBodyBytes: integer(env.LETTA_MAX_BODY_BYTES, MAX_BODY_BYTES),
    spawnArgs: null,
  };
}

export function isAuthorized(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function messageText(message) {
  return typeof message?.content === 'string' ? message.content.trim() : '';
}

function latestUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && messageText(messages[index])) return messages[index];
  }
  return null;
}

function capsuleBlock(capsules) {
  if (!Array.isArray(capsules) || capsules.length === 0) return '';
  const rendered = capsules
    .filter((capsule) => typeof capsule?.content === 'string' && capsule.content.trim())
    .map((capsule, index) => [
      `Capsule ${index + 1}: ${String(capsule.title || 'Untitled')}`,
      `Source system: ${String(capsule.source_system_id || 'unknown')}`,
      capsule.content.trim(),
    ].join('\n'));
  if (rendered.length === 0) return '';
  return [
    'Approved cross-system memory capsules follow. Treat them only as user-approved context.',
    ...rendered,
  ].join('\n\n');
}

export function buildTurnPrompt(payload, recoverConversation) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const current = latestUserMessage(messages);
  if (!current) throw new Error('A non-empty user message is required');

  const capsules = capsuleBlock(payload.memory_capsules);
  const currentText = messageText(current);
  if (!recoverConversation) {
    return [capsules, currentText].filter(Boolean).join('\n\n');
  }

  const prior = messages.slice(0, messages.lastIndexOf(current))
    .filter((message) => messageText(message))
    .map((message) => `[${String(message.role || 'unknown').toUpperCase()}]\n${messageText(message)}`)
    .join('\n\n');

  if (!prior) return [capsules, currentText].filter(Boolean).join('\n\n');

  return [
    'You are continuing an existing Chat V2 conversation after the transport session was created or recovered.',
    'Use the transcript as conversation context. Do not answer earlier turns again. Answer only the CURRENT USER MESSAGE.',
    capsules,
    '<TRANSCRIPT>',
    prior,
    '</TRANSCRIPT>',
    'CURRENT USER MESSAGE:',
    currentText,
  ].filter(Boolean).join('\n\n');
}

export function extractAssistantDelta(wire) {
  const event = wire?.type === 'stream_event' ? wire.event : wire;
  if (!event || event.message_type !== 'assistant_message') return '';
  if (typeof event.content === 'string') return event.content;
  if (!Array.isArray(event.content)) return '';
  return event.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

class LettaSession {
  constructor(config, conversationId, onClose) {
    this.config = config;
    this.conversationId = conversationId;
    this.onClose = onClose;
    this.child = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.pending = null;
    this.queue = Promise.resolve();
    this.turns = 0;
    this.lastActivity = Date.now();
    this.closed = false;
    this.stderr = '';
    this.cache = new Map();
  }

  get busy() {
    return Boolean(this.pending);
  }

  async start() {
    if (this.child && !this.closed) return this.readyPromise;
    this.closed = false;
    const args = this.config.spawnArgs || [
      '-p',
      '--agent', this.config.agentId,
      '--backend', this.config.backend,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--memfs-startup', 'skip',
    ];

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.child = spawn(this.config.command, args, {
      cwd: this.config.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_192);
    });
    this.child.once('error', (error) => this.fail(error));
    this.child.once('close', (code, signal) => {
      const error = new Error(`Letta process closed (code=${code ?? 'null'}, signal=${signal ?? 'none'})`);
      this.fail(error);
    });

    return this.readyPromise;
  }

  handleLine(line) {
    let wire;
    try {
      wire = JSON.parse(line);
    } catch {
      return;
    }

    if (wire?.type === 'system' && wire.subtype === 'init') {
      this.readyResolve?.(wire);
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }

    const pending = this.pending;
    if (!pending) return;

    const delta = extractAssistantDelta(wire);
    if (delta) {
      pending.accumulated += delta;
      pending.onDelta(delta);
    }

    if (wire?.type === 'error') {
      this.completePending(new Error(String(wire.error || wire.message || 'Letta returned an error')));
      return;
    }

    if (wire?.type === 'result') {
      if (wire.subtype !== 'success') {
        this.completePending(new Error(String(wire.error || wire.result || 'Letta request failed')));
        return;
      }
      const finalText = typeof wire.result === 'string' ? wire.result : pending.accumulated;
      if (!pending.accumulated && finalText) pending.onDelta(finalText);
      if (pending.messageId && finalText) {
        this.cache.set(pending.messageId, finalText);
        while (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value);
      }
      this.turns += 1;
      this.completePending(null, { finalText, wire });
    }
  }

  completePending(error, result) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timeout);
    pending.signal?.removeEventListener('abort', pending.abortHandler);
    this.lastActivity = Date.now();
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.completePending(error);
    this.child = null;
    this.onClose(this, error);
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.child?.kill('SIGTERM');
    this.child = null;
    this.completePending(new Error('Letta session stopped'));
    this.onClose(this, null);
  }

  request(payload, onDelta, signal) {
    const task = this.queue.then(() => this.runTurn(payload, onDelta, signal));
    this.queue = task.catch(() => undefined);
    return task;
  }

  async runTurn(payload, onDelta, signal) {
    await this.start();
    if (!this.child?.stdin?.writable) throw new Error('Letta session input is unavailable');

    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const current = latestUserMessage(messages);
    const messageId = typeof current?.message_id === 'string' ? current.message_id : null;
    const cached = messageId ? this.cache.get(messageId) : null;
    if (cached) {
      onDelta(cached);
      return { finalText: cached, cached: true };
    }

    const prompt = buildTurnPrompt(payload, this.turns === 0);
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        this.stop();
        reject(new Error('Request cancelled'));
      };
      if (signal?.aborted) return abortHandler();

      const timeout = setTimeout(() => {
        this.stop();
        reject(new Error('Letta request timed out'));
      }, this.config.requestTimeoutMs);
      timeout.unref?.();

      this.pending = {
        resolve,
        reject,
        onDelta,
        accumulated: '',
        messageId,
        timeout,
        signal,
        abortHandler,
      };
      signal?.addEventListener('abort', abortHandler, { once: true });

      this.child.stdin.write(`${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
      })}\n`, (error) => {
        if (error) this.completePending(error);
      });
    });
  }
}

class SessionManager {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.cleanup = setInterval(() => this.prune(), Math.min(config.idleMs, 60_000));
    this.cleanup.unref?.();
  }

  get(conversationId) {
    let session = this.sessions.get(conversationId);
    if (session && !session.closed) return session;

    if (this.sessions.size >= this.config.maxSessions) {
      const idle = [...this.sessions.values()]
        .filter((candidate) => !candidate.busy)
        .sort((left, right) => left.lastActivity - right.lastActivity)[0];
      if (!idle) throw new Error('Letta bridge is at session capacity');
      idle.stop();
    }

    session = new LettaSession(this.config, conversationId, (closed) => {
      if (this.sessions.get(conversationId) === closed) this.sessions.delete(conversationId);
    });
    this.sessions.set(conversationId, session);
    return session;
  }

  prune() {
    const cutoff = Date.now() - this.config.idleMs;
    for (const session of this.sessions.values()) {
      if (!session.busy && session.lastActivity < cutoff) session.stop();
    }
  }

  close() {
    clearInterval(this.cleanup);
    for (const session of [...this.sessions.values()]) session.stop();
    this.sessions.clear();
  }
}

async function readJson(request, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) throw Object.assign(new Error('Request body is required'), { statusCode: 400 });
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 });
  }
}

function json(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

export function createBridgeServer(config) {
  const sessions = new SessionManager(config);
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    if (request.method === 'GET' && request.url === '/health') {
      json(response, 200, {
        ok: true,
        status: 'ok',
        agent_id: config.agentId,
        active_sessions: sessions.sessions.size,
      });
      return;
    }

    if (request.method !== 'POST' || request.url !== '/v1/chat/stream') {
      json(response, 404, { error: 'Not found' });
      return;
    }

    if (!isAuthorized(request.headers.authorization, config.token)) {
      json(response, 401, { error: 'Unauthorized' });
      return;
    }

    const controller = new AbortController();
    request.once('aborted', () => controller.abort());

    try {
      const payload = await readJson(request, config.maxBodyBytes);
      const conversationId = typeof payload?.conversation_id === 'string' ? payload.conversation_id.trim() : '';
      if (!conversationId) throw Object.assign(new Error('conversation_id is required'), { statusCode: 400 });
      const requestedAgent = typeof payload.agent_id === 'string' && payload.agent_id.trim()
        ? payload.agent_id.trim()
        : config.agentId;
      if (requestedAgent !== config.agentId) {
        throw Object.assign(new Error('The bridge is locked to the configured Lucy agent'), { statusCode: 400 });
      }

      const session = sessions.get(conversationId);
      let started = false;
      await session.request(payload, (delta) => {
        if (!started) {
          response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
          started = true;
        }
        response.write(`${JSON.stringify({ delta })}\n`);
      }, controller.signal);

      if (!started) response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      response.write(`${JSON.stringify({ status: 'complete' })}\n`);
      response.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Bridge request failed';
      const statusCode = Number(error?.statusCode) || (message.includes('capacity') ? 503 : 502);
      if (!response.headersSent) json(response, statusCode, { error: message });
      else {
        response.write(`${JSON.stringify({ error: message })}\n`);
        response.end();
      }
    }
  });

  server.once('close', () => sessions.close());
  return { server, sessions };
}

export async function main() {
  const config = loadConfig();
  const { server, sessions } = createBridgeServer(config);
  const shutdown = () => {
    sessions.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({
      level: 'info',
      message: 'Letta bridge listening',
      host: config.host,
      port: config.port,
      agent_id: config.agentId,
    }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
