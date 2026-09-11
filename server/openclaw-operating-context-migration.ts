import type Database from 'better-sqlite3';
import {
  sameConversationRuntimeIdentity,
  validateConversationOperatingContext,
  type ConversationOperatingContext,
  type ConversationRuntimeIdentity,
} from '../shared/conversation-operating-context.js';
import type { ChatDatabase } from './database.js';
import { conversationRuntimeIdentity } from './provider-session-identity.js';

type StoredContextRow = {
  conversation_id: string;
  context_json: string;
};

function migrateBoundIdentity<T extends ConversationRuntimeIdentity>(
  value: T | null,
  previous: ConversationOperatingContext,
  nextIdentity: ReturnType<typeof conversationRuntimeIdentity>,
): T | null {
  if (!value) return null;
  if (!sameConversationRuntimeIdentity(value, previous)) return value;
  return {
    ...value,
    ...nextIdentity,
  } as T;
}

/**
 * Rebind only identity-bearing fields of a valid legacy personal Lucy context.
 * User/task/status text is deliberately never string-replaced.
 *
 * The conversation row must already point at the canonical OpenClaw Lucy agent
 * when this runs, so the authoritative post-migration session identity can be
 * recomputed from the same provider-session contract used by normal reads.
 */
export function migrateLegacyPersonalLucyOperatingContexts(
  database: ChatDatabase,
  db: Database.Database,
  legacyAgentId: string,
  canonicalAgentId: string,
) {
  const rows = db.prepare(`
    SELECT coc.conversation_id, coc.context_json
    FROM conversation_operating_context coc
    JOIN conversations c ON c.id = coc.conversation_id
    WHERE c.system_id = 'letta' AND c.agent_id = ?
  `).all(canonicalAgentId) as StoredContextRow[];

  let migrated = 0;
  for (const row of rows) {
    try {
      const previous = validateConversationOperatingContext(JSON.parse(row.context_json));
      if (
        previous.conversationId !== row.conversation_id
        || previous.backendSystem !== 'letta'
        || previous.agentId !== legacyAgentId
      ) continue;
      if (
        (previous.continuationTarget && !sameConversationRuntimeIdentity(previous.continuationTarget, previous))
        || (previous.pendingApproval && !sameConversationRuntimeIdentity(previous.pendingApproval, previous))
      ) continue;

      const conversation = database.getConversation(row.conversation_id);
      if (!conversation || conversation.systemId !== 'letta' || conversation.agentId !== canonicalAgentId) continue;
      const nextIdentity = conversationRuntimeIdentity(conversation);
      const next = validateConversationOperatingContext({
        ...previous,
        ...nextIdentity,
        continuationTarget: migrateBoundIdentity(previous.continuationTarget, previous, nextIdentity),
        pendingApproval: migrateBoundIdentity(previous.pendingApproval, previous, nextIdentity),
      });
      db.prepare(`
        UPDATE conversation_operating_context
        SET context_json = ?, updated_at = ?
        WHERE conversation_id = ?
      `).run(JSON.stringify(next), new Date().toISOString(), row.conversation_id);
      migrated += 1;
    } catch {
      // Invalid or stale context stays untouched. The normal fail-closed reader
      // will replace it rather than migration fabricating continuity.
    }
  }
  return migrated;
}
