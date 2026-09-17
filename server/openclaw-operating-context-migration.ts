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

type WorkflowRunIdentityRow = {
  id: string;
  requested_agent_ids_json: string;
};

type LegacyRuntimeIdentity = Omit<ConversationRuntimeIdentity, 'backendSystem'> & {
  backendSystem: 'letta';
};

function legacyBackendSystem(value: ConversationRuntimeIdentity) {
  return (value as ConversationRuntimeIdentity & { backendSystem: string }).backendSystem === 'letta';
}

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

function tableExists(db: Database.Database, table: string) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `).get(table));
}

function migrateAgentIdsJson(value: string, legacyAgentId: string, canonicalAgentId: string) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) return null;
    const migrated = [...new Set(parsed.map((item) => item === legacyAgentId ? canonicalAgentId : item))];
    return JSON.stringify(migrated);
  } catch {
    return null;
  }
}

/**
 * Rebind only identity-bearing fields of a valid legacy personal Lucy context.
 * User/task/status text is deliberately never string-replaced.
 *
 * ChatDatabase has already migrated the owning conversation row from the
 * retired `letta` system id to canonical `openclaw` before this function runs.
 * The stored JSON may still contain the legacy backend id; that value is read
 * only inside this migration boundary and is never written back as live truth.
 */
export function migrateLegacyPersonalLucyOperatingContexts(
  database: ChatDatabase,
  db: Database.Database,
  legacyAgentId: string,
  canonicalAgentId: string,
) {
  if (tableExists(db, 'agents')) {
    db.prepare(`
      UPDATE agents
      SET short_name = 'OpenClaw', updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), canonicalAgentId);
  }

  const rows = db.prepare(`
    SELECT coc.conversation_id, coc.context_json
    FROM conversation_operating_context coc
    JOIN conversations c ON c.id = coc.conversation_id
    WHERE c.system_id = 'openclaw' AND c.agent_id = ?
  `).all(canonicalAgentId) as StoredContextRow[];

  let migrated = 0;
  for (const row of rows) {
    try {
      // `validateConversationOperatingContext` intentionally validates shape and
      // bindings, while the old backend id is recognized only by this bounded
      // migration. Cast documents that this is persisted legacy input, not a
      // current SystemId accepted by product/API contracts.
      const previous = validateConversationOperatingContext(JSON.parse(row.context_json));
      const legacyIdentity = previous as ConversationOperatingContext & LegacyRuntimeIdentity;
      if (
        previous.conversationId !== row.conversation_id
        || !legacyBackendSystem(legacyIdentity)
        || previous.agentId !== legacyAgentId
      ) continue;
      if (
        (previous.continuationTarget && !sameConversationRuntimeIdentity(previous.continuationTarget, previous))
        || (previous.pendingApproval && !sameConversationRuntimeIdentity(previous.pendingApproval, previous))
      ) continue;

      const conversation = database.getConversation(row.conversation_id);
      if (!conversation || conversation.systemId !== 'openclaw' || conversation.agentId !== canonicalAgentId) continue;
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
      // replaces it instead of migration fabricating continuity.
    }
  }

  migrated += migrateLegacyPersonalLucyWorkflowIdentity(db, legacyAgentId, canonicalAgentId);
  return migrated;
}

/**
 * Upgrade persisted workflow execution identity without rewriting historical
 * prose or event-ledger payloads. `depends_on_step_ids_json` contains step UUIDs
 * after createSteps(), so it must remain byte-for-byte untouched.
 *
 * FederationService owns the system-id table migration. If its tables already
 * exist when CollaborationService starts, this function may see legacy raw
 * `workflow_steps.system_id='letta'` and only updates the associated agent id.
 */
export function migrateLegacyPersonalLucyWorkflowIdentity(
  db: Database.Database,
  legacyAgentId: string,
  canonicalAgentId: string,
) {
  if (!tableExists(db, 'workflow_runs') || !tableExists(db, 'workflow_steps')) return 0;

  let migrated = 0;
  const runs = db.prepare(`
    SELECT id, requested_agent_ids_json
    FROM workflow_runs
    WHERE requested_agent_ids_json LIKE ? OR coordinator_agent_id = ?
  `).all(`%${legacyAgentId}%`, legacyAgentId) as WorkflowRunIdentityRow[];
  const updateRequested = db.prepare(`
    UPDATE workflow_runs SET requested_agent_ids_json = ? WHERE id = ?
  `);
  for (const run of runs) {
    const requested = migrateAgentIdsJson(run.requested_agent_ids_json, legacyAgentId, canonicalAgentId);
    if (requested && requested !== run.requested_agent_ids_json) {
      updateRequested.run(requested, run.id);
      migrated += 1;
    }
  }

  const runCoordinator = db.prepare(`
    UPDATE workflow_runs SET coordinator_agent_id = ? WHERE coordinator_agent_id = ?
  `).run(canonicalAgentId, legacyAgentId);
  migrated += runCoordinator.changes;

  const steps = db.prepare(`
    UPDATE workflow_steps AS legacy
    SET agent_id = ?
    WHERE legacy.system_id = 'letta'
      AND legacy.agent_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM workflow_steps AS canonical
        WHERE canonical.run_id = legacy.run_id
          AND canonical.agent_id = ?
      )
  `).run(canonicalAgentId, legacyAgentId, canonicalAgentId);
  migrated += steps.changes;

  if (tableExists(db, 'conversation_federation')) {
    const federationCoordinator = db.prepare(`
      UPDATE conversation_federation SET coordinator_agent_id = ? WHERE coordinator_agent_id = ?
    `).run(canonicalAgentId, legacyAgentId);
    migrated += federationCoordinator.changes;
  }

  return migrated;
}
