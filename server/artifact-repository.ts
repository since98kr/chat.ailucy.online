import type { ArtifactRecord } from '../shared/contracts.js';
import type { ChatDatabase } from './database.js';

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

export function getArtifact(db: ChatDatabase, id: string): ArtifactRecord | null {
  const row = db.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
  if (!row) return null;
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
