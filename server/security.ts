import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type ChatAuthMode = 'disabled' | 'token' | 'cloudflare';

type SecurityConfig = {
  authMode: ChatAuthMode;
  accessToken?: string;
  allowedEmails: Set<string>;
  allowedOrigins: Set<string>;
  rateWindowMs: number;
  generalRateLimit: number;
  chatRateLimit: number;
  uploadRateLimit: number;
};

type RateRecord = { count: number; resetAt: number };

const rateRecords = new Map<string, RateRecord>();
const mutationMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function csv(value: string | undefined) {
  return new Set(
    (value ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function securityConfigFromEnv(): SecurityConfig {
  const requestedMode = (process.env.CHAT_AUTH_MODE ?? 'disabled').trim().toLowerCase();
  const authMode: ChatAuthMode =
    requestedMode === 'token' || requestedMode === 'cloudflare' ? requestedMode : 'disabled';
  return {
    authMode,
    accessToken: process.env.CHAT_ACCESS_TOKEN?.trim(),
    allowedEmails: csv(process.env.CHAT_ALLOWED_EMAILS),
    allowedOrigins: csv(process.env.CHAT_ALLOWED_ORIGIN || process.env.CHAT_PUBLIC_ORIGIN),
    rateWindowMs: Number(process.env.CHAT_RATE_WINDOW_MS ?? 60_000),
    generalRateLimit: Number(process.env.CHAT_RATE_LIMIT_GENERAL ?? 300),
    chatRateLimit: Number(process.env.CHAT_RATE_LIMIT_CHAT ?? 30),
    uploadRateLimit: Number(process.env.CHAT_RATE_LIMIT_UPLOAD ?? 60),
  };
}

function secureEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return '';
  return authorization.slice('Bearer '.length).trim();
}

function requestEmail(request: FastifyRequest) {
  const value = request.headers['cf-access-authenticated-user-email'];
  return (Array.isArray(value) ? value[0] : value ?? '').trim().toLowerCase();
}

function rateLimitFor(request: FastifyRequest, config: SecurityConfig) {
  if (request.url.includes('/messages/stream')) return config.chatRateLimit;
  if (request.url.includes('/artifacts') && request.method === 'POST') return config.uploadRateLimit;
  return config.generalRateLimit;
}

function rateKey(request: FastifyRequest) {
  const category = request.url.includes('/messages/stream')
    ? 'chat'
    : request.url.includes('/artifacts') && request.method === 'POST'
      ? 'upload'
      : 'general';
  return `${request.ip}:${category}`;
}

function applyRateLimit(request: FastifyRequest, reply: FastifyReply, config: SecurityConfig) {
  const now = Date.now();
  const key = rateKey(request);
  const limit = rateLimitFor(request, config);
  const existing = rateRecords.get(key);
  const record = !existing || existing.resetAt <= now
    ? { count: 0, resetAt: now + config.rateWindowMs }
    : existing;
  record.count += 1;
  rateRecords.set(key, record);

  reply.header('X-RateLimit-Limit', String(limit));
  reply.header('X-RateLimit-Remaining', String(Math.max(0, limit - record.count)));
  reply.header('X-RateLimit-Reset', String(Math.ceil(record.resetAt / 1000)));
  if (record.count > limit) {
    reply.header('Retry-After', String(Math.max(1, Math.ceil((record.resetAt - now) / 1000))));
    return reply.status(429).send({ error: 'RATE_LIMITED' });
  }
}

function authenticate(request: FastifyRequest, reply: FastifyReply, config: SecurityConfig) {
  if (config.authMode === 'disabled') return;
  if (config.authMode === 'token') {
    const provided = bearerToken(request);
    if (!config.accessToken || !provided || !secureEqual(provided, config.accessToken)) {
      return reply.status(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    }
    return;
  }

  const email = requestEmail(request);
  if (!email || config.allowedEmails.size === 0 || !config.allowedEmails.has(email)) {
    return reply.status(403).send({ error: 'ACCESS_DENIED' });
  }
}

function validateOrigin(request: FastifyRequest, reply: FastifyReply, config: SecurityConfig) {
  if (!mutationMethods.has(request.method) || config.allowedOrigins.size === 0) return;
  const origin = request.headers.origin?.trim().toLowerCase();
  if (origin && !config.allowedOrigins.has(origin)) {
    return reply.status(403).send({ error: 'ORIGIN_NOT_ALLOWED' });
  }
}

export function registerRuntimeSecurity(app: FastifyInstance, config = securityConfigFromEnv()) {
  if (config.authMode === 'token' && !config.accessToken) {
    throw new Error('CHAT_ACCESS_TOKEN is required when CHAT_AUTH_MODE=token');
  }
  if (config.authMode === 'cloudflare' && config.allowedEmails.size === 0) {
    throw new Error('CHAT_ALLOWED_EMAILS is required when CHAT_AUTH_MODE=cloudflare');
  }

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/api/health' || request.url.startsWith('/api/health?')) return;
    const originResult = validateOrigin(request, reply, config);
    if (originResult) return originResult;
    if (request.url.startsWith('/api/')) {
      const authResult = authenticate(request, reply, config);
      if (authResult) return authResult;
      return applyRateLimit(request, reply, config);
    }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    return payload;
  });

  return config;
}

export function clearSecurityRateState() {
  rateRecords.clear();
}
