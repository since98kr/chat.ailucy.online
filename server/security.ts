import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createCloudflareAccessVerifier,
  type CloudflareAccessIdentity,
  type CloudflareAccessVerifier,
} from './cloudflare-access.js';

export type ChatAuthMode = 'disabled' | 'token' | 'cloudflare';

export type SecurityConfig = {
  authMode: ChatAuthMode;
  accessToken?: string;
  accessIssuer?: string;
  accessAudience?: string;
  allowedEmails: Set<string>;
  allowedServiceClientIds: Set<string>;
  allowedOrigins: Set<string>;
  cloudflareAccessVerifier?: CloudflareAccessVerifier;
  rateWindowMs: number;
  generalRateLimit: number;
  chatRateLimit: number;
  uploadRateLimit: number;
};

type RateRecord = { count: number; resetAt: number };

const rateRecords = new Map<string, RateRecord>();
const requestIdentities = new WeakMap<FastifyRequest, string>();
const mutationMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const publicApiPaths = new Set(['/api/health', '/api/auth/config', '/api/auth/login', '/api/auth/logout']);
const sessionCookieName = 'chat_v2_session';

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
  const accessIssuer = process.env.CHAT_CF_ACCESS_ISSUER?.trim();
  const accessAudience = process.env.CHAT_CF_ACCESS_AUD?.trim();

  return {
    authMode,
    accessToken: process.env.CHAT_ACCESS_TOKEN?.trim(),
    accessIssuer,
    accessAudience,
    allowedEmails: csv(process.env.CHAT_ALLOWED_EMAILS),
    allowedServiceClientIds: csv(process.env.CHAT_ALLOWED_SERVICE_CLIENT_IDS),
    allowedOrigins: csv(process.env.CHAT_ALLOWED_ORIGIN || process.env.CHAT_PUBLIC_ORIGIN),
    cloudflareAccessVerifier:
      accessIssuer && accessAudience
        ? createCloudflareAccessVerifier(accessIssuer, accessAudience)
        : undefined,
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

function requestHeader(request: FastifyRequest, name: string) {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value ?? '').trim();
}

function bearerToken(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return '';
  return authorization.slice('Bearer '.length).trim();
}

function cookies(request: FastifyRequest) {
  const header = request.headers.cookie ?? '';
  return new Map(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        const name = separator < 0 ? part : part.slice(0, separator);
        const value = separator < 0 ? '' : part.slice(separator + 1);
        return [name, decodeURIComponent(value)] as const;
      }),
  );
}

function cookieToken(request: FastifyRequest) {
  return cookies(request).get(sessionCookieName) ?? '';
}

function requestEmail(request: FastifyRequest) {
  return requestHeader(request, 'cf-access-authenticated-user-email').toLowerCase();
}

function requestAssertion(request: FastifyRequest) {
  return requestHeader(request, 'cf-access-jwt-assertion');
}

function cookieSecure(request: FastifyRequest) {
  if ((process.env.CHAT_COOKIE_SECURE ?? '').trim().toLowerCase() === 'true') return true;
  const forwarded = request.headers['x-forwarded-proto'];
  const protocol = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return protocol === 'https';
}

function sessionCookie(value: string, request: FastifyRequest, maxAgeSeconds?: number) {
  const attributes = [
    `${sessionCookieName}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(cookieSecure(request) ? ['Secure'] : []),
    ...(maxAgeSeconds === undefined ? [] : [`Max-Age=${maxAgeSeconds}`]),
  ];
  return attributes.join('; ');
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

function validToken(request: FastifyRequest, config: SecurityConfig) {
  const provided = bearerToken(request) || cookieToken(request);
  return Boolean(config.accessToken && provided && secureEqual(provided, config.accessToken));
}

function allowedCloudflareIdentity(identity: CloudflareAccessIdentity, config: SecurityConfig) {
  if (identity.kind === 'email') {
    return config.allowedEmails.has(identity.value.toLowerCase())
      ? identity.value.toLowerCase()
      : null;
  }
  const clientId = identity.value.toLowerCase();
  return config.allowedServiceClientIds.has(clientId) ? `service:${clientId}` : null;
}

async function resolveCloudflareIdentity(request: FastifyRequest, config: SecurityConfig) {
  const assertion = requestAssertion(request);
  if (assertion && config.cloudflareAccessVerifier) {
    try {
      const verified = await config.cloudflareAccessVerifier(assertion);
      return verified ? allowedCloudflareIdentity(verified, config) : null;
    } catch {
      return null;
    }
  }

  const email = requestEmail(request);
  return email && config.allowedEmails.has(email) ? email : null;
}

async function authenticate(request: FastifyRequest, reply: FastifyReply, config: SecurityConfig) {
  if (config.authMode === 'disabled') return;
  if (config.authMode === 'token') {
    if (!validToken(request, config)) {
      return reply.status(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    }
    requestIdentities.set(request, 'private-session');
    return;
  }

  const identity = await resolveCloudflareIdentity(request, config);
  if (!identity) return reply.status(403).send({ error: 'ACCESS_DENIED' });
  requestIdentities.set(request, identity);
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
  if (
    config.authMode === 'cloudflare'
    && config.allowedEmails.size === 0
    && config.allowedServiceClientIds.size === 0
  ) {
    throw new Error('Cloudflare mode requires an allowed email or service client ID');
  }
  if (config.allowedServiceClientIds.size > 0 && !config.cloudflareAccessVerifier) {
    throw new Error('Cloudflare service clients require CHAT_CF_ACCESS_ISSUER and CHAT_CF_ACCESS_AUD');
  }

  app.get('/api/auth/config', async () => ({ mode: config.authMode }));

  app.post('/api/auth/login', async (request, reply) => {
    if (config.authMode !== 'token') {
      return reply.status(400).send({ error: 'TOKEN_LOGIN_NOT_ENABLED' });
    }
    const body = request.body as { token?: unknown } | null;
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!config.accessToken || !token || !secureEqual(token, config.accessToken)) {
      return reply.status(401).send({ error: 'INVALID_ACCESS_TOKEN' });
    }
    reply.header('Set-Cookie', sessionCookie(token, request));
    return { authenticated: true, mode: config.authMode, identity: 'private-session' };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    reply.header('Set-Cookie', sessionCookie('', request, 0));
    return { authenticated: false };
  });

  app.get('/api/auth/session', async (request) => ({
    authenticated: true,
    mode: config.authMode,
    identity:
      requestIdentities.get(request)
      ?? (config.authMode === 'token' ? 'private-session' : config.authMode === 'disabled' ? 'local' : requestEmail(request)),
  }));

  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0];
    if (publicApiPaths.has(pathname)) return;
    const originResult = validateOrigin(request, reply, config);
    if (originResult) return originResult;
    if (request.url.startsWith('/api/')) {
      const authResult = await authenticate(request, reply, config);
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
