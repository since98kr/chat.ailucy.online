import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ArtifactRecord,
  BranchConversationInput,
  ConversationDetail,
  ConversationRecord,
  ConversationSearchResult,
  ConversationStatus,
  MessageRecord,
  MessageRole,
  MessageState,
  SystemId,
  UpdateConversationInput,
} from '../shared/contracts.js';

type ConversationRow = {
  id: string;
  system_id: SystemId;
  agent_id: string;
  title: string;
  preview: string;
  status: ConversationStatus;
  pinned: number;
  created_at: string;
  updated_at: string;
  last_read_message_id: string | null;
  draft: string;
  branched_from_conversation_id: string | null;
  branched_from_message_id: string | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: MessageRole;
  author_id: string;
  content: string;
  state: MessageState;
  parent_message_id: string | null;
  created_at: string;
  updated_at: string;
};

type ArtifactRow = {
  id: string;
  conversation_id: string;
  message_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  created_at: string;
};

const now = () => new Date().toISOString();

function mapConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    systemId: row.system_id,
    agentId: row.agent_id,
    title: row.title,
    preview: row.preview,
    status: row.status,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastReadMessageId: row.last_read_message_id,
    draft: row.draft,
    branchedFromConversationId: row.branched_from_conversation_id,
    branchedFromMessageId: row.branched_from_message_id,
  };
}

function mapMessage(row: MessageRow): MessageRecord {
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

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    storagePath: row.storage_path,
    createdAt: row.created_at,
  };
}

export class ChatDatabase {
  readonly db: Database.Database;

  constructor(databasePath = process.env.CHAT_DB_PATH ?? './data/chat-v2.sqlite') {
    const absolutePath = resolve(databasePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.db = new Database(absolutePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.seed();
  }

  close() {
    this.db.close();
  }

  private hasColumn(table: string, column: string) {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        system_id TEXT NOT NULL CHECK (system_id IN ('letta', 'hermes')),
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL,
        preview TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'trashed')),
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_read_message_id TEXT,
        draft TEXT NOT NULL DEFAULT '',
        branched_from_conversation_id TEXT,
        branched_from_message_id TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'complete' CHECK (state IN ('complete', 'streaming', 'failed', 'cancelled')),
        parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_system_status_updated
        ON conversations(system_id, status, pinned DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
        ON messages(conversation_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_messages_content
        ON messages(conversation_id, content);
      CREATE INDEX IF NOT EXISTS idx_artifacts_conversation_created
        ON artifacts(conversation_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_artifacts_message
        ON artifacts(message_id);
    `);

    if (!this.hasColumn('conversations', 'branched_from_conversation_id')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN branched_from_conversation_id TEXT');
    }
    if (!this.hasColumn('conversations', 'branched_from_message_id')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN branched_from_message_id TEXT');
    }
  }

  private seed() {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM conversations').get() as { count: number };
    if (count.count > 0) return;

    const seeded = [
      {
        id: 'chat-v2',
        systemId: 'hermes' as const,
        agentId: '[Hermes] Lucy',
        title: 'Chat V2 개발',
        preview: 'Conversation 중심 UI와 Chat Core 구현',
        pinned: true,
      },
      {
        id: 'hermes-v2',
        systemId: 'hermes' as const,
        agentId: '[Hermes] Lucy',
        title: 'Hermes V2 구축',
        preview: 'Lucy와 subagent 협업 구조',
        pinned: true,
      },
      {
        id: 'weekly',
        systemId: 'letta' as const,
        agentId: '[Letta] Lucy',
        title: '이번 주 업무 정리',
        preview: '중요 의사결정과 다음 일정',
        pinned: true,
      },
    ];

    const transaction = this.db.transaction(() => {
      for (const item of seeded) {
        const timestamp = now();
        this.db.prepare(`
          INSERT INTO conversations (
            id, system_id, agent_id, title, preview, status, pinned,
            created_at, updated_at, last_read_message_id, draft,
            branched_from_conversation_id, branched_from_message_id
          ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, '', NULL, NULL)
        `).run(
          item.id,
          item.systemId,
          item.agentId,
          item.title,
          item.preview,
          item.pinned ? 1 : 0,
          timestamp,
          timestamp,
        );
        this.addMessage({
          conversationId: item.id,
          role: 'assistant',
          authorId: item.agentId,
          content:
            item.systemId === 'letta'
              ? '이 Conversation은 다른 아젠다와 분리되어 있지만, 저는 승인된 개인 기억을 이어갑니다.'
              : '이 Conversation은 Hermes 작업 공간입니다. 필요할 때 subagent와 협업하되 최종 응답은 Lucy가 책임집니다.',
        });
      }
    });
    transaction();
  }

  listConversations(systemId?: SystemId, status: ConversationStatus = 'active') {
    const rows = systemId
      ? (this.db.prepare(`
          SELECT * FROM conversations
          WHERE system_id = ? AND status = ?
          ORDER BY pinned DESC, updated_at DESC
        `).all(systemId, status) as ConversationRow[])
      : (this.db.prepare(`
          SELECT * FROM conversations
          WHERE status = ?
          ORDER BY pinned DESC, updated_at DESC
        `).all(status) as ConversationRow[]);
    return rows.map(mapConversation);
  }

  getConversation(id: string): ConversationDetail | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    if (!row) return null;
    const messages = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(id) as MessageRow[];
    const artifacts = this.db
      .prepare('SELECT * FROM artifacts WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(id) as ArtifactRow[];
    return {
      ...mapConversation(row),
      messages: messages.map(mapMessage),
      artifacts: artifacts.map(mapArtifact),
    };
  }

  createConversation(
    systemId: SystemId,
    agentId: string,
    title = '새 대화',
    branch?: { conversationId: string; messageId: string | null },
  ) {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO conversations (
        id, system_id, agent_id, title, preview, status, pinned,
        created_at, updated_at, last_read_message_id, draft,
        branched_from_conversation_id, branched_from_message_id
      ) VALUES (?, ?, ?, ?, '', 'active', 0, ?, ?, NULL, '', ?, ?)
    `).run(
      id,
      systemId,
      agentId,
      title,
      timestamp,
      timestamp,
      branch?.conversationId ?? null,
      branch?.messageId ?? null,
    );
    return this.getConversation(id)!;
  }

  updateConversation(id: string, input: UpdateConversationInput) {
    const current = this.getConversation(id);
    if (!current) return null;
    const timestamp = now();
    this.db.prepare(`
      UPDATE conversations
      SET title = ?, pinned = ?, status = ?, draft = ?,
          last_read_message_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.title ?? current.title,
      (input.pinned ?? current.pinned) ? 1 : 0,
      input.status ?? current.status,
      input.draft ?? current.draft,
      input.lastReadMessageId === undefined ? current.lastReadMessageId : input.lastReadMessageId,
      timestamp,
      id,
    );
    return this.getConversation(id);
  }

  deleteConversation(id: string) {
    return this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0;
  }

  addMessage(input: {
    conversationId: string;
    role: MessageRole;
    authorId: string;
    content: string;
    state?: MessageState;
    parentMessageId?: string | null;
    id?: string;
  }) {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, author_id, content, state,
        parent_message_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.conversationId,
      input.role,
      input.authorId,
      input.content,
      input.state ?? 'complete',
      input.parentMessageId ?? null,
      timestamp,
      timestamp,
    );

    this.db.prepare(`
      UPDATE conversations SET preview = ?, updated_at = ?, draft = '' WHERE id = ?
    `).run(input.content.slice(0, 120), timestamp, input.conversationId);

    if (input.role === 'user') {
      const conversation = this.getConversation(input.conversationId);
      if (conversation?.title === '새 대화') {
        this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?')
          .run(input.content.replace(/\s+/g, ' ').slice(0, 28), input.conversationId);
      }
    }
    return this.getMessage(id)!;
  }

  getMessage(id: string) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
    return row ? mapMessage(row) : null;
  }

  updateMessage(id: string, input: { content?: string; state?: MessageState }) {
    const current = this.getMessage(id);
    if (!current) return null;
    const timestamp = now();
    this.db.prepare('UPDATE messages SET content = ?, state = ?, updated_at = ? WHERE id = ?')
      .run(input.content ?? current.content, input.state ?? current.state, timestamp, id);
    return this.getMessage(id);
  }

  addArtifact(input: Omit<ArtifactRecord, 'id' | 'createdAt'>) {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO artifacts (
        id, conversation_id, message_id, filename, mime_type,
        size_bytes, storage_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.conversationId,
      input.messageId,
      input.filename,
      input.mimeType,
      input.sizeBytes,
      input.storagePath,
      timestamp,
    );
    return this.getArtifact(id)!;
  }

  getArtifact(id: string) {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
    return row ? mapArtifact(row) : null;
  }

  attachArtifacts(conversationId: string, artifactIds: string[], messageId: string) {
    if (artifactIds.length === 0) return [];
    const uniqueIds = [...new Set(artifactIds)];
    const placeholders = uniqueIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT * FROM artifacts
      WHERE id IN (${placeholders}) AND conversation_id = ? AND message_id IS NULL
    `).all(...uniqueIds, conversationId) as ArtifactRow[];
    if (rows.length !== uniqueIds.length) {
      throw new Error('One or more artifacts are unavailable for this Conversation');
    }
    const transaction = this.db.transaction(() => {
      for (const id of uniqueIds) {
        this.db.prepare('UPDATE artifacts SET message_id = ? WHERE id = ?').run(messageId, id);
      }
    });
    transaction();
    return uniqueIds.map((id) => this.getArtifact(id)!);
  }

  searchConversations(
    query: string,
    options?: { systemId?: SystemId; status?: ConversationStatus; limit?: number },
  ): ConversationSearchResult[] {
    const normalized = query.trim();
    if (!normalized) return [];
    const like = `%${normalized.replace(/[\\%_]/g, '\\$&')}%`;
    const systemClause = options?.systemId ? 'AND c.system_id = @systemId' : '';
    const rows = this.db.prepare(`
      SELECT
        c.*,
        CASE
          WHEN c.title LIKE @like ESCAPE '\\' OR c.preview LIKE @like ESCAPE '\\' THEN 'title'
          WHEN EXISTS (
            SELECT 1 FROM artifacts a
            WHERE a.conversation_id = c.id AND a.filename LIKE @like ESCAPE '\\'
          ) THEN 'artifact'
          ELSE 'message'
        END AS matched_in,
        COALESCE(
          (SELECT substr(m.content, 1, 240) FROM messages m
           WHERE m.conversation_id = c.id AND m.content LIKE @like ESCAPE '\\'
           ORDER BY m.created_at DESC LIMIT 1),
          (SELECT a.filename FROM artifacts a
           WHERE a.conversation_id = c.id AND a.filename LIKE @like ESCAPE '\\'
           ORDER BY a.created_at DESC LIMIT 1),
          c.preview,
          c.title
        ) AS snippet,
        (SELECT m.id FROM messages m
         WHERE m.conversation_id = c.id AND m.content LIKE @like ESCAPE '\\'
         ORDER BY m.created_at DESC LIMIT 1) AS matched_message_id
      FROM conversations c
      WHERE c.status = @status
        ${systemClause}
        AND (
          c.title LIKE @like ESCAPE '\\'
          OR c.preview LIKE @like ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE @like ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM artifacts a WHERE a.conversation_id = c.id AND a.filename LIKE @like ESCAPE '\\')
        )
      ORDER BY c.pinned DESC, c.updated_at DESC
      LIMIT @limit
    `).all({
      like,
      status: options?.status ?? 'active',
      systemId: options?.systemId,
      limit: Math.min(Math.max(options?.limit ?? 40, 1), 100),
    }) as Array<ConversationRow & {
      matched_in: ConversationSearchResult['matchedIn'];
      snippet: string;
      matched_message_id: string | null;
    }>;

    return rows.map((row) => ({
      conversation: mapConversation(row),
      snippet: row.snippet,
      matchedIn: row.matched_in,
      messageId: row.matched_message_id,
    }));
  }

  branchConversation(sourceId: string, input: BranchConversationInput) {
    const source = this.getConversation(sourceId);
    if (!source) return null;
    let messages = source.messages;
    if (input.fromMessageId) {
      const index = messages.findIndex((message) => message.id === input.fromMessageId);
      if (index < 0) return null;
      messages = messages.slice(0, index + 1);
    }

    const result = this.db.transaction(() => {
      const target = this.createConversation(
        source.systemId,
        source.agentId,
        input.title?.trim() || `${source.title} · 분기`,
        { conversationId: source.id, messageId: input.fromMessageId ?? messages.at(-1)?.id ?? null },
      );
      const messageMap = new Map<string, string>();
      for (const message of messages) {
        const copied = this.addMessage({
          conversationId: target.id,
          role: message.role,
          authorId: message.authorId,
          content: message.content,
          state: message.state === 'streaming' ? 'cancelled' : message.state,
          parentMessageId: message.parentMessageId ? messageMap.get(message.parentMessageId) ?? null : null,
        });
        messageMap.set(message.id, copied.id);
      }
      for (const artifact of source.artifacts) {
        if (!artifact.messageId || !messageMap.has(artifact.messageId)) continue;
        this.addArtifact({
          conversationId: target.id,
          messageId: messageMap.get(artifact.messageId)!,
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          storagePath: artifact.storagePath,
        });
      }
      return this.getConversation(target.id)!;
    })();
    return result;
  }
}
