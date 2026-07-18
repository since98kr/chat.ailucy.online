import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ArtifactRecord,
  ConversationDetail,
  ConversationRecord,
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
        draft TEXT NOT NULL DEFAULT ''
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
      CREATE INDEX IF NOT EXISTS idx_artifacts_conversation_created
        ON artifacts(conversation_id, created_at ASC);
    `);
  }

  private seed() {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM conversations').get() as { count: number };
    if (count.count > 0) return;

    const insertConversation = this.db.prepare(`
      INSERT INTO conversations (
        id, system_id, agent_id, title, preview, status, pinned,
        created_at, updated_at, last_read_message_id, draft
      ) VALUES (
        @id, @system_id, @agent_id, @title, @preview, 'active', @pinned,
        @created_at, @updated_at, NULL, ''
      )
    `);

    const insertMessage = this.db.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, author_id, content, state,
        parent_message_id, created_at, updated_at
      ) VALUES (
        @id, @conversation_id, @role, @author_id, @content, 'complete',
        NULL, @created_at, @updated_at
      )
    `);

    const seeded = [
      {
        id: 'chat-v2',
        system_id: 'hermes',
        agent_id: '[Hermes] Lucy',
        title: 'Chat V2 개발',
        preview: 'Conversation 중심 UI와 Chat Core 구현',
        pinned: 1,
      },
      {
        id: 'hermes-v2',
        system_id: 'hermes',
        agent_id: '[Hermes] Lucy',
        title: 'Hermes V2 구축',
        preview: 'Lucy와 subagent 협업 구조',
        pinned: 1,
      },
      {
        id: 'weekly',
        system_id: 'letta',
        agent_id: '[Letta] Lucy',
        title: '이번 주 업무 정리',
        preview: '중요 의사결정과 다음 일정',
        pinned: 1,
      },
    ];

    const seedTransaction = this.db.transaction(() => {
      for (const item of seeded) {
        const timestamp = now();
        insertConversation.run({ ...item, created_at: timestamp, updated_at: timestamp });
        insertMessage.run({
          id: randomUUID(),
          conversation_id: item.id,
          role: 'assistant',
          author_id: item.agent_id,
          content:
            item.system_id === 'letta'
              ? '이 Conversation은 다른 아젠다와 분리되어 있지만, 저는 승인된 개인 기억을 이어갑니다.'
              : '이 Conversation은 Hermes 작업 공간입니다. 필요할 때 subagent와 협업하되 최종 응답은 Lucy가 책임집니다.',
          created_at: timestamp,
          updated_at: timestamp,
        });
      }
    });

    seedTransaction();
  }

  listConversations(systemId?: SystemId, status: ConversationStatus = 'active') {
    const rows = systemId
      ? (this.db
          .prepare(`
            SELECT * FROM conversations
            WHERE system_id = ? AND status = ?
            ORDER BY pinned DESC, updated_at DESC
          `)
          .all(systemId, status) as ConversationRow[])
      : (this.db
          .prepare(`
            SELECT * FROM conversations
            WHERE status = ?
            ORDER BY pinned DESC, updated_at DESC
          `)
          .all(status) as ConversationRow[]);

    return rows.map(mapConversation);
  }

  getConversation(id: string): ConversationDetail | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    if (!row) return null;

    const messages = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(id) as MessageRow[];
    const artifacts = this.db
      .prepare('SELECT * FROM artifacts WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(id) as ArtifactRow[];

    return {
      ...mapConversation(row),
      messages: messages.map(mapMessage),
      artifacts: artifacts.map(mapArtifact),
    };
  }

  createConversation(systemId: SystemId, agentId: string, title = '새 대화') {
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO conversations (
          id, system_id, agent_id, title, preview, status, pinned,
          created_at, updated_at, last_read_message_id, draft
        ) VALUES (?, ?, ?, ?, '', 'active', 0, ?, ?, NULL, '')
      `)
      .run(id, systemId, agentId, title, timestamp, timestamp);

    return this.getConversation(id)!;
  }

  updateConversation(id: string, input: UpdateConversationInput) {
    const current = this.getConversation(id);
    if (!current) return null;

    const next = {
      title: input.title ?? current.title,
      pinned: input.pinned ?? current.pinned,
      status: input.status ?? current.status,
      draft: input.draft ?? current.draft,
      lastReadMessageId:
        input.lastReadMessageId === undefined ? current.lastReadMessageId : input.lastReadMessageId,
      updatedAt: now(),
    };

    this.db
      .prepare(`
        UPDATE conversations
        SET title = ?, pinned = ?, status = ?, draft = ?,
            last_read_message_id = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.title,
        next.pinned ? 1 : 0,
        next.status,
        next.draft,
        next.lastReadMessageId,
        next.updatedAt,
        id,
      );

    return this.getConversation(id);
  }

  deleteConversation(id: string) {
    const result = this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return result.changes > 0;
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
    this.db
      .prepare(`
        INSERT INTO messages (
          id, conversation_id, role, author_id, content, state,
          parent_message_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
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

    this.db
      .prepare(`
        UPDATE conversations
        SET preview = ?, updated_at = ?, draft = ''
        WHERE id = ?
      `)
      .run(input.content.slice(0, 120), timestamp, input.conversationId);

    if (input.role === 'user') {
      const conversation = this.getConversation(input.conversationId);
      if (conversation?.title === '새 대화') {
        this.db
          .prepare('UPDATE conversations SET title = ? WHERE id = ?')
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
    this.db
      .prepare('UPDATE messages SET content = ?, state = ?, updated_at = ? WHERE id = ?')
      .run(input.content ?? current.content, input.state ?? current.state, timestamp, id);
    return this.getMessage(id);
  }

  addArtifact(input: Omit<ArtifactRecord, 'id' | 'createdAt'>) {
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO artifacts (
          id, conversation_id, message_id, filename, mime_type,
          size_bytes, storage_path, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.conversationId,
        input.messageId,
        input.filename,
        input.mimeType,
        input.sizeBytes,
        input.storagePath,
        timestamp,
      );

    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow;
    return mapArtifact(row);
  }
}
