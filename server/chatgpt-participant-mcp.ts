import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ChatDatabase } from './database.js';

const MCP_PATH = '/mcp/chatgpt-participant';
const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp/chatgpt-participant';
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const CHATGPT_LUCY_AUTHOR_ID = '[ChatGPT] Lucy';
const READ_SCOPE = 'chat:read';
const WRITE_SCOPE = 'chat:write';

type AuthFailure = 'missing' | 'invalid' | null;

const jsonRpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
}).strict();

const listRoomsSchema = z.object({
  status: z.enum(['active', 'archived', 'trashed']).default('active'),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();

const readRoomSchema = z.object({
  conversationId: z.string().min(1).max(200),
  afterMessageId: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(200).default(100),
}).strict();

const postMessageSchema = z.object({
  conversationId: z.string().min(1).max(200),
  content: z.string().trim().min(1).max(200_000),
  parentMessageId: z.string().min(1).max(200).nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export type ChatGptParticipantAuthConfig = {
  resourceUrl: string;
  issuer: string;
  audience: string;
  jwksUrl: string;
  authorizationServer: string;
};

export type ChatGptParticipantIdentity = {
  subject: string;
  scopes: Set<string>;
};

export type ChatGptParticipantTokenVerifier = (
  token: string,
) => Promise<ChatGptParticipantIdentity>;

export type ChatGptParticipantMcpOptions = {
  enabled?: boolean;
  auth?: ChatGptParticipantAuthConfig | null;
  verifyAccessToken?: ChatGptParticipantTokenVerifier;
};

function exactTrue(value: string | undefined) {
  return value?.trim().toLowerCase() === 'true';
}

function configuredAuthFromEnv(): ChatGptParticipantAuthConfig | null {
  const resourceUrl = process.env.CHATGPT_PARTICIPANT_RESOURCE_URL?.trim() ?? '';
  const issuer = process.env.CHATGPT_PARTICIPANT_AUTH_ISSUER?.trim() ?? '';
  const audience = process.env.CHATGPT_PARTICIPANT_AUTH_AUDIENCE?.trim() ?? '';
  const jwksUrl = process.env.CHATGPT_PARTICIPANT_AUTH_JWKS_URL?.trim() ?? '';
  const authorizationServer = process.env.CHATGPT_PARTICIPANT_AUTHORIZATION_SERVER?.trim() || issuer;
  if (!resourceUrl || !issuer || !audience || !jwksUrl || !authorizationServer) return null;
  return { resourceUrl, issuer, audience, jwksUrl, authorizationServer };
}

function requireHttpsUrl(value: string, name: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${name} must use https`);
  return parsed;
}

function validateAuthConfig(config: ChatGptParticipantAuthConfig) {
  requireHttpsUrl(config.resourceUrl, 'CHATGPT_PARTICIPANT_RESOURCE_URL');
  requireHttpsUrl(config.issuer, 'CHATGPT_PARTICIPANT_AUTH_ISSUER');
  requireHttpsUrl(config.jwksUrl, 'CHATGPT_PARTICIPANT_AUTH_JWKS_URL');
  requireHttpsUrl(config.authorizationServer, 'CHATGPT_PARTICIPANT_AUTHORIZATION_SERVER');
  return { ...config };
}

function scopeSet(payload: JWTPayload) {
  const result = new Set<string>();
  if (typeof payload.scope === 'string') {
    for (const value of payload.scope.split(/\s+/)) if (value) result.add(value);
  }
  if (typeof payload.scp === 'string') {
    for (const value of payload.scp.split(/\s+/)) if (value) result.add(value);
  } else if (Array.isArray(payload.scp)) {
    for (const value of payload.scp) if (typeof value === 'string' && value) result.add(value);
  }
  return result;
}

function createJwtVerifier(config: ChatGptParticipantAuthConfig): ChatGptParticipantTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl));
  return async (token: string) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audience,
    });
    if (!payload.sub || typeof payload.sub !== 'string') throw new Error('ACCESS_TOKEN_SUBJECT_REQUIRED');
    return { subject: payload.sub, scopes: scopeSet(payload) };
  };
}

function bearer(request: FastifyRequest) {
  const value = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() ?? '';
}

function requestProtocolVersion(request: FastifyRequest) {
  const value = request.headers['mcp-protocol-version'];
  if (Array.isArray(value)) return value[0]?.trim() ?? '';
  return typeof value === 'string' ? value.trim() : '';
}

function jsonRpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(value: unknown, text = 'OK') {
  return {
    content: [{ type: 'text', text }],
    structuredContent: value && typeof value === 'object' && !Array.isArray(value) ? value : { value },
    isError: false,
  };
}

function toolError(message: string, code = 'TOOL_FAILED', meta?: Record<string, unknown>) {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: code, message },
    isError: true,
    ...(meta ? { _meta: meta } : {}),
  };
}

function authChallenge(metadataUrl: string, options?: {
  scope?: string;
  error?: 'invalid_token' | 'insufficient_scope';
  description?: string;
}) {
  return [
    `Bearer resource_metadata="${metadataUrl}"`,
    options?.scope ? `scope="${options.scope}"` : null,
    options?.error ? `error="${options.error}"` : null,
    options?.description ? `error_description="${options.description}"` : null,
  ].filter(Boolean).join(', ');
}

function safeRoom(room: ReturnType<ChatDatabase['listConversations']>[number]) {
  return {
    id: room.id,
    title: room.title,
    systemId: room.systemId,
    agentId: room.agentId,
    preview: room.preview,
    status: room.status,
    pinned: room.pinned,
    updatedAt: room.updatedAt,
  };
}

function safeMessage(message: NonNullable<ReturnType<ChatDatabase['getMessage']>>) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    authorId: message.authorId,
    content: message.content,
    state: message.state,
    parentMessageId: message.parentMessageId,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

const roomOutputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    systemId: { type: 'string' },
    agentId: { type: 'string' },
    preview: { type: 'string' },
    status: { type: 'string', enum: ['active', 'archived', 'trashed'] },
    pinned: { type: 'boolean' },
    updatedAt: { type: 'string' },
  },
  required: ['id', 'title', 'systemId', 'agentId', 'preview', 'status', 'pinned', 'updatedAt'],
  additionalProperties: false,
};

const messageOutputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    conversationId: { type: 'string' },
    role: { type: 'string', enum: ['user', 'assistant', 'system'] },
    authorId: { type: 'string' },
    content: { type: 'string' },
    state: { type: 'string', enum: ['complete', 'streaming', 'failed', 'cancelled'] },
    parentMessageId: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
  required: [
    'id', 'conversationId', 'role', 'authorId', 'content', 'state',
    'parentMessageId', 'createdAt', 'updatedAt',
  ],
  additionalProperties: false,
};

const errorOutputSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['error', 'message'],
  additionalProperties: false,
};

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function postFingerprint(input: z.infer<typeof postMessageSchema>) {
  return sha256(JSON.stringify({
    conversationId: input.conversationId,
    content: input.content,
    parentMessageId: input.parentMessageId ?? null,
  }));
}

function ensurePostTable(db: ChatDatabase) {
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS chatgpt_participant_posts (
      idempotency_key TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      request_fingerprint TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chatgpt_participant_posts_conversation_idx
      ON chatgpt_participant_posts(conversation_id, created_at);
  `);
}

function mcpTools() {
  return [
    {
      name: 'list_chat_rooms',
      title: 'List Chat rooms',
      description: 'Use this when ChatGPT Lucy needs to find a chat.ailucy.online room before reading or posting.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'archived', 'trashed'], default: 'active' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
        additionalProperties: false,
      },
      outputSchema: {
        oneOf: [
          {
            type: 'object',
            properties: {
              participant: { type: 'string', const: CHATGPT_LUCY_AUTHOR_ID },
              rooms: { type: 'array', items: roomOutputSchema },
            },
            required: ['participant', 'rooms'],
            additionalProperties: false,
          },
          errorOutputSchema,
        ],
      },
      securitySchemes: [{ type: 'oauth2', scopes: [READ_SCOPE] }],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: 'read_chat_room',
      title: 'Read Chat room',
      description: 'Use this when ChatGPT Lucy needs the canonical room transcript, optionally only messages after a known message.',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', minLength: 1, maxLength: 200 },
          afterMessageId: { type: 'string', minLength: 1, maxLength: 200 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
        },
        required: ['conversationId'],
        additionalProperties: false,
      },
      outputSchema: {
        oneOf: [
          {
            type: 'object',
            properties: {
              participant: { type: 'string', const: CHATGPT_LUCY_AUTHOR_ID },
              room: roomOutputSchema,
              messages: { type: 'array', items: messageOutputSchema },
              hasMore: { type: 'boolean' },
              nextAfterMessageId: { type: ['string', 'null'] },
            },
            required: ['participant', 'room', 'messages', 'hasMore', 'nextAfterMessageId'],
            additionalProperties: false,
          },
          errorOutputSchema,
        ],
      },
      securitySchemes: [{ type: 'oauth2', scopes: [READ_SCOPE] }],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: 'post_chatgpt_lucy_message',
      title: 'Post as ChatGPT Lucy',
      description: 'Use this when the active ChatGPT Lucy should post one message into a chat.ailucy.online room as the fixed author [ChatGPT] Lucy.',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', minLength: 1, maxLength: 200 },
          content: { type: 'string', minLength: 1, maxLength: 200000 },
          parentMessageId: { type: ['string', 'null'] },
          idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
        },
        required: ['conversationId', 'content', 'idempotencyKey'],
        additionalProperties: false,
      },
      outputSchema: {
        oneOf: [
          {
            type: 'object',
            properties: {
              participant: { type: 'string', const: CHATGPT_LUCY_AUTHOR_ID },
              created: { type: 'boolean' },
              message: messageOutputSchema,
            },
            required: ['participant', 'created', 'message'],
            additionalProperties: false,
          },
          errorOutputSchema,
        ],
      },
      securitySchemes: [{ type: 'oauth2', scopes: [WRITE_SCOPE] }],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ];
}

function listRooms(db: ChatDatabase, args: unknown) {
  const input = listRoomsSchema.parse(args ?? {});
  return toolResult({
    participant: CHATGPT_LUCY_AUTHOR_ID,
    rooms: db.listConversations(undefined, input.status).slice(0, input.limit).map(safeRoom),
  }, 'Chat rooms listed.');
}

type PagedMessageRow = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  author_id: string;
  content: string;
  state: 'complete' | 'streaming' | 'failed' | 'cancelled';
  parent_message_id: string | null;
  created_at: string;
  updated_at: string;
};

function mapPagedMessage(row: PagedMessageRow): NonNullable<ReturnType<ChatDatabase['getMessage']>> {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    authorId: row.author_id,
    content: row.content,
    state: row.state,
    parentMessageId: row.parent_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readRoom(db: ChatDatabase, args: unknown) {
  const input = readRoomSchema.parse(args ?? {});
  const room = db.listConversations().find((candidate) => candidate.id === input.conversationId);
  if (!room) return toolError('Conversation not found.', 'CONVERSATION_NOT_FOUND');

  let cursor: { conversation_id: string; created_at: string; row_id: number } | undefined;
  if (input.afterMessageId) {
    cursor = db.db.prepare(`
      SELECT conversation_id, created_at, rowid AS row_id
      FROM messages
      WHERE id = ?
    `).get(input.afterMessageId) as typeof cursor;
    if (!cursor || cursor.conversation_id !== input.conversationId) {
      return toolError(
        'afterMessageId does not belong to this Conversation.',
        'AFTER_MESSAGE_NOT_IN_CONVERSATION',
      );
    }
  }

  const pageSize = input.limit + 1;
  const rows = cursor
    ? db.db.prepare(`
        SELECT id, conversation_id, role, author_id, content, state,
               parent_message_id, created_at, updated_at
        FROM messages
        WHERE conversation_id = ?
          AND (created_at > ? OR (created_at = ? AND rowid > ?))
        ORDER BY created_at ASC, rowid ASC
        LIMIT ?
      `).all(
        input.conversationId,
        cursor.created_at,
        cursor.created_at,
        cursor.row_id,
        pageSize,
      ) as PagedMessageRow[]
    : db.db.prepare(`
        SELECT id, conversation_id, role, author_id, content, state,
               parent_message_id, created_at, updated_at
        FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC, rowid ASC
        LIMIT ?
      `).all(input.conversationId, pageSize) as PagedMessageRow[];

  const hasMore = rows.length > input.limit;
  const messages = rows.slice(0, input.limit).map(mapPagedMessage).map(safeMessage);
  return toolResult({
    participant: CHATGPT_LUCY_AUTHOR_ID,
    room: safeRoom(room),
    messages,
    hasMore,
    nextAfterMessageId: messages.at(-1)?.id ?? input.afterMessageId ?? null,
  }, `Read ${messages.length} room message${messages.length === 1 ? '' : 's'}.`);
}

function postMessage(db: ChatDatabase, args: unknown) {
  const input = postMessageSchema.parse(args ?? {});
  const room = db.getConversation(input.conversationId);
  if (!room) return toolError('Conversation not found.', 'CONVERSATION_NOT_FOUND');
  if (input.parentMessageId) {
    const parent = db.getMessage(input.parentMessageId);
    if (!parent || parent.conversationId !== input.conversationId) {
      return toolError(
        'parentMessageId does not belong to this Conversation.',
        'PARENT_MESSAGE_NOT_IN_CONVERSATION',
      );
    }
  }

  ensurePostTable(db);
  const fingerprint = postFingerprint(input);
  const result = db.db.transaction(() => {
    const existing = db.db.prepare(`
      SELECT conversation_id, request_fingerprint, message_id
      FROM chatgpt_participant_posts
      WHERE idempotency_key = ?
    `).get(input.idempotencyKey) as {
      conversation_id: string;
      request_fingerprint: string;
      message_id: string;
    } | undefined;

    if (existing) {
      if (existing.conversation_id !== input.conversationId || existing.request_fingerprint !== fingerprint) {
        return { kind: 'conflict' as const };
      }
      const message = db.getMessage(existing.message_id);
      if (!message) return { kind: 'broken' as const };
      return { kind: 'existing' as const, message };
    }

    const message = db.addMessage({
      conversationId: input.conversationId,
      role: 'assistant',
      authorId: CHATGPT_LUCY_AUTHOR_ID,
      content: input.content,
      parentMessageId: input.parentMessageId ?? null,
    });
    // addMessage clears drafts for normal send flows. External participant posts must not
    // erase text the user is still composing, so restore the pre-post draft atomically.
    db.db.prepare('UPDATE conversations SET draft = ? WHERE id = ?')
      .run(room.draft, input.conversationId);
    db.db.prepare(`
      INSERT INTO chatgpt_participant_posts (
        idempotency_key, conversation_id, request_fingerprint, message_id, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      input.idempotencyKey,
      input.conversationId,
      fingerprint,
      message.id,
      new Date().toISOString(),
    );
    return { kind: 'created' as const, message };
  })();

  if (result.kind === 'conflict') {
    return toolError(
      'The idempotency key was already used for a different ChatGPT Lucy message.',
      'IDEMPOTENCY_CONFLICT',
    );
  }
  if (result.kind === 'broken') {
    return toolError('The recorded idempotent message is missing.', 'IDEMPOTENCY_STATE_BROKEN');
  }
  return toolResult({
    participant: CHATGPT_LUCY_AUTHOR_ID,
    created: result.kind === 'created',
    message: safeMessage(result.message),
  }, result.kind === 'created' ? 'ChatGPT Lucy message posted.' : 'Existing ChatGPT Lucy message returned.');
}

function toolAuthError(metadataUrl: string, scope: string, failure: AuthFailure) {
  const insufficientScope = failure === null;
  const error = insufficientScope ? 'insufficient_scope' : 'invalid_token';
  const description = insufficientScope
    ? `OAuth scope ${scope} is required for this tool.`
    : failure === 'missing'
      ? `OAuth access token with scope ${scope} is required.`
      : 'The OAuth access token is invalid or expired.';
  return toolError(
    description,
    insufficientScope ? 'INSUFFICIENT_SCOPE' : 'OAUTH_ACCESS_TOKEN_REQUIRED',
    {
      'mcp/www_authenticate': [authChallenge(metadataUrl, {
        scope,
        error,
        description,
      })],
    },
  );
}

function authorizeTool(
  identity: ChatGptParticipantIdentity | null,
  authFailure: AuthFailure,
  metadataUrl: string,
  scope: string,
) {
  if (!identity) return toolAuthError(metadataUrl, scope, authFailure ?? 'invalid');
  if (!identity.scopes.has(scope)) return toolAuthError(metadataUrl, scope, null);
  return null;
}

async function handleToolCall(
  db: ChatDatabase,
  identity: ChatGptParticipantIdentity | null,
  authFailure: AuthFailure,
  metadataUrl: string,
  name: string,
  args: unknown,
) {
  try {
    if (name === 'list_chat_rooms') {
      const denied = authorizeTool(identity, authFailure, metadataUrl, READ_SCOPE);
      return denied ?? listRooms(db, args);
    }
    if (name === 'read_chat_room') {
      const denied = authorizeTool(identity, authFailure, metadataUrl, READ_SCOPE);
      return denied ?? readRoom(db, args);
    }
    if (name === 'post_chatgpt_lucy_message') {
      const denied = authorizeTool(identity, authFailure, metadataUrl, WRITE_SCOPE);
      return denied ?? postMessage(db, args);
    }
    return toolError('Unknown tool.', 'UNKNOWN_TOOL');
  } catch (error) {
    if (error instanceof z.ZodError) return toolError('Tool arguments failed validation.', 'INVALID_ARGUMENTS');
    return toolError(error instanceof Error ? error.message : 'Tool failed.', 'TOOL_FAILED');
  }
}

export function registerChatGptParticipantMcp(
  app: FastifyInstance,
  db: ChatDatabase,
  options: ChatGptParticipantMcpOptions = {},
) {
  const enabled = options.enabled ?? exactTrue(process.env.CHATGPT_PARTICIPANT_MCP_ENABLED);
  if (!enabled) return;

  const rawAuth = options.auth === undefined ? configuredAuthFromEnv() : options.auth;
  let auth: ChatGptParticipantAuthConfig | null = null;
  let authConfigurationError: string | null = null;
  if (rawAuth) {
    try {
      auth = validateAuthConfig(rawAuth);
    } catch (error) {
      authConfigurationError = error instanceof Error ? error.message : 'Invalid OAuth configuration';
    }
  } else {
    authConfigurationError = 'ChatGPT participant OAuth resource-server configuration is incomplete';
  }
  const metadataUrl = auth
    ? new URL(RESOURCE_METADATA_PATH, auth.resourceUrl).toString()
    : RESOURCE_METADATA_PATH;
  const verifyAccessToken = auth
    ? (options.verifyAccessToken ?? createJwtVerifier(auth))
    : options.verifyAccessToken;

  app.get(RESOURCE_METADATA_PATH, async (_request, reply) => {
    if (!auth) return reply.status(503).send({ error: 'CHATGPT_PARTICIPANT_AUTH_NOT_CONFIGURED' });
    return {
      resource: auth.resourceUrl,
      authorization_servers: [auth.authorizationServer],
      scopes_supported: [READ_SCOPE, WRITE_SCOPE],
    };
  });

  app.get(MCP_PATH, async (_request, reply) => {
    reply.header('Allow', 'POST');
    return reply.status(405).send({ error: 'STREAMABLE_HTTP_POST_REQUIRED' });
  });

  app.post(MCP_PATH, async (request, reply) => {
    if (!auth || !verifyAccessToken) {
      return reply.status(503).send({
        error: 'CHATGPT_PARTICIPANT_AUTH_NOT_CONFIGURED',
        message: authConfigurationError ?? 'OAuth resource-server configuration is unavailable',
      });
    }

    const parsed = jsonRpcSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(jsonRpcError(null, -32600, 'Invalid Request'));
    const message = parsed.data;
    const requestedProtocolVersion = requestProtocolVersion(request);
    if (
      message.method !== 'initialize'
      && requestedProtocolVersion
      && requestedProtocolVersion !== DEFAULT_PROTOCOL_VERSION
    ) {
      return reply.status(400).send(jsonRpcError(
        message.id,
        -32600,
        `Unsupported MCP-Protocol-Version: ${requestedProtocolVersion}`,
      ));
    }
    if (message.id === undefined) return reply.status(202).send();

    if (message.method === 'initialize') {
      const protocolVersion = DEFAULT_PROTOCOL_VERSION;
      return reply.send(jsonRpcResult(message.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'chat-ailucy-chatgpt-participant', version: '0.1.0' },
        instructions: 'You are the active ChatGPT participant [ChatGPT] Lucy. Read the canonical room transcript before replying. Never impersonate Tei or another agent. Posting does not wake this ChatGPT conversation after the current turn ends.',
      }));
    }
    if (message.method === 'ping') return reply.send(jsonRpcResult(message.id, {}));
    if (message.method === 'tools/list') return reply.send(jsonRpcResult(message.id, { tools: mcpTools() }));
    if (message.method === 'tools/call') {
      const params = z.object({
        name: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).optional(),
      }).strict().safeParse(message.params ?? {});
      if (!params.success) return reply.send(jsonRpcError(message.id, -32602, 'Invalid params'));

      const token = bearer(request);
      let identity: ChatGptParticipantIdentity | null = null;
      let authFailure: AuthFailure = token ? 'invalid' : 'missing';
      if (token) {
        try {
          identity = await verifyAccessToken(token);
          if (!identity.subject) throw new Error('ACCESS_TOKEN_SUBJECT_REQUIRED');
          authFailure = null;
        } catch {
          identity = null;
          authFailure = 'invalid';
        }
      }

      const result = await handleToolCall(
        db,
        identity,
        authFailure,
        metadataUrl,
        params.data.name,
        params.data.arguments ?? {},
      );
      return reply.send(jsonRpcResult(message.id, result));
    }
    return reply.send(jsonRpcError(message.id, -32601, 'Method not found'));
  });
}
