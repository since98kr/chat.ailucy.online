import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  FederationConfigRecord,
  FederationSnapshotRecord,
  MemoryCapsuleRecord,
  MemoryCapsuleStatus,
  SystemId,
  WorkflowEventRecord,
  WorkflowEventType,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStepRecord,
  WorkflowStepStatus,
} from '../shared/contracts.js';
import type { ChatDatabase } from './database.js';

const now = () => new Date().toISOString();
const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

type FederationRow = {
  conversation_id: string;
  mode: 'single' | 'federated';
  coordinator_agent_id: string;
  allowed_system_ids_json: string;
  memory_policy: 'explicit-capsules-only';
  created_at: string;
  updated_at: string;
};

type CapsuleRow = {
  id: string;
  conversation_id: string;
  source_system_id: SystemId;
  target_system_id: SystemId;
  title: string;
  content: string;
  status: MemoryCapsuleStatus;
  source_message_ids_json: string;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

type RunRow = {
  id: string;
  conversation_id: string;
  source_message_id: string;
  idempotency_key: string;
  status: WorkflowRunStatus;
  coordinator_agent_id: string;
  requested_agent_ids_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type StepRow = {
  id: string;
  run_id: string;
  agent_id: string;
  system_id: SystemId;
  position: number;
  parallel_group: number;
  depends_on_step_ids_json: string;
  status: WorkflowStepStatus;
  attempt: number;
  output_message_id: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

type EventRow = {
  id: string;
  run_id: string;
  sequence: number;
  type: WorkflowEventType;
  payload_json: string;
  created_at: string;
};

function mapConfig(row: FederationRow): FederationConfigRecord {
  return {
    conversationId: row.conversation_id,
    mode: row.mode,
    coordinatorAgentId: row.coordinator_agent_id,
    allowedSystemIds: parseJson<SystemId[]>(row.allowed_system_ids_json, ['hermes']),
    memoryPolicy: row.memory_policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCapsule(row: CapsuleRow): MemoryCapsuleRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sourceSystemId: row.source_system_id,
    targetSystemId: row.target_system_id,
    title: row.title,
    content: row.content,
    status: row.status,
    sourceMessageIds: parseJson<string[]>(row.source_message_ids_json, []),
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStep(row: StepRow): WorkflowStepRecord {
  return {
    id: row.id,
    runId: row.run_id,
    agentId: row.agent_id,
    systemId: row.system_id,
    position: row.position,
    parallelGroup: row.parallel_group,
    dependsOnStepIds: parseJson<string[]>(row.depends_on_step_ids_json, []),
    status: row.status,
    attempt: row.attempt,
    outputMessageId: row.output_message_id,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: EventRow): WorkflowEventRecord {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

export class FederationService {
  readonly database: ChatDatabase;
  readonly db: Database.Database;

  constructor(database: ChatDatabase) {
    this.database = database;
    this.db = database.db;
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_federation (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'federated' CHECK (mode IN ('single', 'federated')),
        coordinator_agent_id TEXT NOT NULL,
        allowed_system_ids_json TEXT NOT NULL DEFAULT '["letta","hermes"]',
        memory_policy TEXT NOT NULL DEFAULT 'explicit-capsules-only' CHECK (memory_policy = 'explicit-capsules-only'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_capsules (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        source_system_id TEXT NOT NULL CHECK (source_system_id IN ('letta', 'hermes')),
        target_system_id TEXT NOT NULL CHECK (target_system_id IN ('letta', 'hermes')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'revoked')),
        source_message_ids_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        approved_by TEXT,
        approved_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
        coordinator_agent_id TEXT NOT NULL,
        requested_agent_ids_json TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (conversation_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS workflow_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        system_id TEXT NOT NULL CHECK (system_id IN ('letta', 'hermes')),
        position INTEGER NOT NULL,
        parallel_group INTEGER NOT NULL DEFAULT 0,
        depends_on_step_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'cancelled')),
        attempt INTEGER NOT NULL DEFAULT 0,
        output_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        error TEXT,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (run_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS workflow_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (run_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_capsules_conversation_status ON memory_capsules(conversation_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_capsules_target_status ON memory_capsules(target_system_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation ON workflow_runs(conversation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_group ON workflow_steps(run_id, parallel_group, position);
      CREATE INDEX IF NOT EXISTS idx_workflow_events_run_sequence ON workflow_events(run_id, sequence);
    `);
  }

  enableConversation(conversationId: string, coordinatorAgentId = '[Hermes] Lucy') {
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO conversation_federation (
        conversation_id, mode, coordinator_agent_id, allowed_system_ids_json,
        memory_policy, created_at, updated_at
      ) VALUES (?, 'federated', ?, ?, 'explicit-capsules-only', ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        mode = 'federated',
        coordinator_agent_id = excluded.coordinator_agent_id,
        allowed_system_ids_json = excluded.allowed_system_ids_json,
        updated_at = excluded.updated_at
    `).run(conversationId, coordinatorAgentId, JSON.stringify(['letta', 'hermes']), createdAt, createdAt);
    return this.getConfig(conversationId)!;
  }

  disableConversation(conversationId: string) {
    this.db.prepare(`UPDATE conversation_federation SET mode = 'single', updated_at = ? WHERE conversation_id = ?`)
      .run(now(), conversationId);
    return this.getConfig(conversationId);
  }

  cloneConversation(sourceConversationId: string, targetConversationId: string) {
    const config = this.getConfig(sourceConversationId);
    if (!config || config.mode !== 'federated') return null;
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO conversation_federation (
        conversation_id, mode, coordinator_agent_id, allowed_system_ids_json,
        memory_policy, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      targetConversationId,
      config.mode,
      config.coordinatorAgentId,
      JSON.stringify(config.allowedSystemIds),
      config.memoryPolicy,
      createdAt,
      createdAt,
    );
    return this.getConfig(targetConversationId);
  }

  getConfig(conversationId: string) {
    const row = this.db.prepare('SELECT * FROM conversation_federation WHERE conversation_id = ?')
      .get(conversationId) as FederationRow | undefined;
    return row ? mapConfig(row) : null;
  }

  listCapsules(conversationId: string, status?: MemoryCapsuleStatus) {
    const rows = status
      ? this.db.prepare(`SELECT * FROM memory_capsules WHERE conversation_id = ? AND status = ? ORDER BY updated_at DESC, rowid DESC`)
          .all(conversationId, status)
      : this.db.prepare(`SELECT * FROM memory_capsules WHERE conversation_id = ? ORDER BY updated_at DESC, rowid DESC`)
          .all(conversationId);
    return (rows as CapsuleRow[]).map(mapCapsule);
  }

  getCapsule(id: string) {
    const row = this.db.prepare('SELECT * FROM memory_capsules WHERE id = ?').get(id) as CapsuleRow | undefined;
    return row ? mapCapsule(row) : null;
  }

  createCapsule(input: {
    conversationId: string;
    sourceSystemId: SystemId;
    targetSystemId: SystemId;
    title: string;
    content: string;
    sourceMessageIds?: string[];
    createdBy?: string;
  }) {
    if (input.sourceSystemId === input.targetSystemId) throw new Error('Memory Capsule requires different source and target systems');
    const id = randomUUID();
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO memory_capsules (
        id, conversation_id, source_system_id, target_system_id, title, content,
        status, source_message_ids_json, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(
      id,
      input.conversationId,
      input.sourceSystemId,
      input.targetSystemId,
      input.title,
      input.content,
      JSON.stringify([...new Set(input.sourceMessageIds ?? [])]),
      input.createdBy ?? 'tei',
      createdAt,
      createdAt,
    );
    return this.getCapsule(id)!;
  }

  updateCapsule(id: string, input: {
    title?: string;
    content?: string;
    status?: MemoryCapsuleStatus;
    actor?: string;
  }) {
    const current = this.getCapsule(id);
    if (!current) return null;
    const updatedAt = now();
    const status = input.status ?? current.status;
    const approving = status === 'approved' && current.status !== 'approved';
    const revoking = status === 'revoked' && current.status !== 'revoked';
    this.db.prepare(`
      UPDATE memory_capsules
      SET title = ?, content = ?, status = ?, approved_by = ?, approved_at = ?, revoked_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.title ?? current.title,
      input.content ?? current.content,
      status,
      approving ? (input.actor ?? 'tei') : current.approvedBy,
      approving ? updatedAt : current.approvedAt,
      revoking ? updatedAt : status === 'approved' ? null : current.revokedAt,
      updatedAt,
      id,
    );
    return this.getCapsule(id);
  }

  approvedCapsules(conversationId: string, targetSystemId: SystemId) {
    const rows = this.db.prepare(`
      SELECT * FROM memory_capsules
      WHERE conversation_id = ? AND target_system_id = ? AND status = 'approved'
      ORDER BY approved_at ASC, rowid ASC
    `).all(conversationId, targetSystemId) as CapsuleRow[];
    return rows.map(mapCapsule);
  }

  createOrGetRun(input: {
    conversationId: string;
    sourceMessageId: string;
    idempotencyKey: string;
    coordinatorAgentId: string;
    requestedAgentIds: string[];
  }) {
    const existing = this.findRunByIdempotency(input.conversationId, input.idempotencyKey);
    if (existing) return { run: existing, created: false };
    const id = randomUUID();
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO workflow_runs (
        id, conversation_id, source_message_id, idempotency_key, status,
        coordinator_agent_id, requested_agent_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)
    `).run(
      id,
      input.conversationId,
      input.sourceMessageId,
      input.idempotencyKey,
      input.coordinatorAgentId,
      JSON.stringify([...new Set(input.requestedAgentIds)]),
      createdAt,
      createdAt,
    );
    return { run: this.getRun(id)!, created: true };
  }

  findRunByIdempotency(conversationId: string, idempotencyKey: string) {
    const row = this.db.prepare(`SELECT * FROM workflow_runs WHERE conversation_id = ? AND idempotency_key = ?`)
      .get(conversationId, idempotencyKey) as RunRow | undefined;
    return row ? this.mapRun(row) : null;
  }

  createSteps(runId: string, steps: Array<{
    agentId: string;
    systemId: SystemId;
    position: number;
    parallelGroup: number;
    dependsOnStepIds?: string[];
  }>) {
    const insertedAt = now();
    const statement = this.db.prepare(`
      INSERT INTO workflow_steps (
        id, run_id, agent_id, system_id, position, parallel_group,
        depends_on_step_ids_json, status, attempt, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    `);
    const transaction = this.db.transaction(() => {
      const ids = new Map<string, string>();
      for (const step of steps) ids.set(step.agentId, randomUUID());
      for (const step of steps) {
        const dependencies = (step.dependsOnStepIds ?? []).map((value) => ids.get(value) ?? value);
        statement.run(
          ids.get(step.agentId),
          runId,
          step.agentId,
          step.systemId,
          step.position,
          step.parallelGroup,
          JSON.stringify(dependencies),
          insertedAt,
        );
      }
    });
    transaction();
    return this.listSteps(runId);
  }

  listSteps(runId: string) {
    const rows = this.db.prepare(`
      SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY parallel_group, position, rowid
    `).all(runId) as StepRow[];
    return rows.map(mapStep);
  }

  getStep(id: string) {
    const row = this.db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(id) as StepRow | undefined;
    return row ? mapStep(row) : null;
  }

  updateStep(id: string, input: {
    status?: WorkflowStepStatus;
    outputMessageId?: string | null;
    error?: string | null;
    incrementAttempt?: boolean;
  }) {
    const current = this.getStep(id);
    if (!current) return null;
    const updatedAt = now();
    const status = input.status ?? current.status;
    const starting = status === 'running' && current.status !== 'running';
    const terminal = ['completed', 'failed', 'skipped', 'cancelled'].includes(status);
    this.db.prepare(`
      UPDATE workflow_steps
      SET status = ?, attempt = ?, output_message_id = ?, error = ?,
          started_at = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      current.attempt + (input.incrementAttempt ? 1 : 0),
      input.outputMessageId === undefined ? current.outputMessageId : input.outputMessageId,
      input.error === undefined ? current.error : input.error,
      starting ? updatedAt : current.startedAt,
      terminal ? updatedAt : current.completedAt,
      updatedAt,
      id,
    );
    return this.getStep(id);
  }

  updateRun(id: string, input: { status?: WorkflowRunStatus; error?: string | null }) {
    const run = this.getRun(id);
    if (!run) return null;
    const status = input.status ?? run.status;
    const updatedAt = now();
    const terminal = ['completed', 'failed', 'cancelled'].includes(status);
    this.db.prepare(`
      UPDATE workflow_runs SET status = ?, error = ?, updated_at = ?, completed_at = ? WHERE id = ?
    `).run(
      status,
      input.error === undefined ? run.error : input.error,
      updatedAt,
      terminal ? updatedAt : run.completedAt,
      id,
    );
    return this.getRun(id);
  }

  addEvent(runId: string, type: WorkflowEventType, payload: Record<string, unknown>) {
    const sequenceRow = this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM workflow_events WHERE run_id = ?`)
      .get(runId) as { sequence: number };
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO workflow_events (id, run_id, sequence, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, runId, sequenceRow.sequence, type, JSON.stringify(payload), now());
    return this.getEvent(id)!;
  }

  getEvent(id: string) {
    const row = this.db.prepare('SELECT * FROM workflow_events WHERE id = ?').get(id) as EventRow | undefined;
    return row ? mapEvent(row) : null;
  }

  listEvents(runId: string, afterSequence = 0) {
    const rows = this.db.prepare(`
      SELECT * FROM workflow_events WHERE run_id = ? AND sequence > ? ORDER BY sequence
    `).all(runId, afterSequence) as EventRow[];
    return rows.map(mapEvent);
  }

  getRun(id: string) {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? this.mapRun(row) : null;
  }

  listRuns(conversationId: string, limit = 30) {
    const rows = this.db.prepare(`
      SELECT * FROM workflow_runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(conversationId, Math.min(Math.max(limit, 1), 100)) as RunRow[];
    return rows.map((row) => this.mapRun(row));
  }

  snapshot(conversationId: string): FederationSnapshotRecord {
    return {
      config: this.getConfig(conversationId),
      capsules: this.listCapsules(conversationId),
      runs: this.listRuns(conversationId),
    };
  }

  private mapRun(row: RunRow): WorkflowRunRecord {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      sourceMessageId: row.source_message_id,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      coordinatorAgentId: row.coordinator_agent_id,
      requestedAgentIds: parseJson<string[]>(row.requested_agent_ids_json, []),
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      steps: this.listSteps(row.id),
    };
  }
}
