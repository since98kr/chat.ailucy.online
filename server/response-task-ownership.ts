import type { ChatDatabase } from './database.js';

type ResponseTaskOwnershipRow = {
  response_message_id: string;
  conversation_id: string;
  producer_task_id: string | null;
};

function ensureResponseTaskOwnershipSchema(database: ChatDatabase) {
  database.db.exec(`
    CREATE TABLE IF NOT EXISTS response_task_ownership (
      response_message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      producer_task_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_response_task_ownership_conversation
      ON response_task_ownership(conversation_id, response_message_id);
  `);
}

/**
 * Persist the canonical task binding that applied when an assistant response
 * began. `null` is meaningful: it records that the response was genuinely
 * unbound/unknown rather than permitting later transcript-order inference.
 */
export function recordResponseTaskOwnership(
  database: ChatDatabase,
  conversationId: string,
  responseMessageId: string,
  producerTaskId: string | null,
) {
  ensureResponseTaskOwnershipSchema(database);

  const response = database.getMessage(responseMessageId);
  if (!response || response.conversationId !== conversationId || response.role !== 'assistant') {
    throw new Error('Response task ownership requires an assistant response in the same Conversation');
  }
  if (producerTaskId) {
    const task = database.getMessage(producerTaskId);
    if (!task || task.conversationId !== conversationId || task.role !== 'user') {
      throw new Error('Response task ownership requires a user task in the same Conversation');
    }
  }

  const existing = database.db.prepare(`
    SELECT response_message_id, conversation_id, producer_task_id
    FROM response_task_ownership
    WHERE response_message_id = ?
  `).get(responseMessageId) as ResponseTaskOwnershipRow | undefined;
  if (existing) {
    if (existing.conversation_id !== conversationId || existing.producer_task_id !== producerTaskId) {
      throw new Error('Response task ownership is immutable once recorded');
    }
    return producerTaskId;
  }

  database.db.prepare(`
    INSERT INTO response_task_ownership (
      response_message_id, conversation_id, producer_task_id, created_at
    ) VALUES (?, ?, ?, ?)
  `).run(responseMessageId, conversationId, producerTaskId, new Date().toISOString());
  return producerTaskId;
}

/**
 * Read only durable response-level ownership. Missing legacy rows and stored
 * null ownership both remain UNKNOWN/null; neither may be inferred from current
 * active task, transcript order, or artifacts that did not exist on the source.
 */
export function taskOwnedByResponse(
  database: ChatDatabase,
  conversationId: string,
  responseMessageId: string,
) {
  ensureResponseTaskOwnershipSchema(database);
  const row = database.db.prepare(`
    SELECT response_message_id, conversation_id, producer_task_id
    FROM response_task_ownership
    WHERE response_message_id = ? AND conversation_id = ?
  `).get(responseMessageId, conversationId) as ResponseTaskOwnershipRow | undefined;
  return row?.producer_task_id ?? null;
}
