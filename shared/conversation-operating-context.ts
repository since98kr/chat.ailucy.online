import type { SystemId } from './contracts.js';

export const CONVERSATION_OPERATING_CONTEXT_SCHEMA = 'lucy.chat.conversation-operating-context.v1' as const;

export type TruthClass = 'FACT' | 'INFERENCE' | 'UNKNOWN';
export type PendingApprovalState = 'pending' | 'approved' | 'expired' | 'cancelled';

export interface ConversationRuntimeIdentity {
  conversationId: string;
  backendSystem: SystemId;
  agentId: string;
  /** Opaque, non-secret identity supplied by the real backend/session owner. */
  sessionIdentity: string;
}

export interface ActiveTaskBinding {
  taskId: string;
  label: string;
}

export interface ContinuationTargetBinding extends ConversationRuntimeIdentity {
  taskId: string;
  label: string;
  /** Opaque backend-owned reference. Chat must not execute this as prose. */
  targetRef: string;
}

export interface StatusTruthRecord {
  classification: TruthClass;
  summary: string;
  evidenceRef: string | null;
  verifiedAt: string | null;
}

export interface BlockerRecord {
  blockerId: string;
  summary: string;
  nextAction: string;
  evidenceRef: string | null;
}

export interface PendingApprovalBinding extends ConversationRuntimeIdentity {
  approvalId: string;
  kind: string;
  summary: string;
  state: PendingApprovalState;
  createdAt: string;
  expiresAt: string | null;
}

export interface ConversationOperatingContext extends ConversationRuntimeIdentity {
  schemaVersion: typeof CONVERSATION_OPERATING_CONTEXT_SCHEMA;
  activeTask: ActiveTaskBinding | null;
  continuationTarget: ContinuationTargetBinding | null;
  statusTruth: StatusTruthRecord[];
  blocker: BlockerRecord | null;
  nextAction: string | null;
  pendingApproval: PendingApprovalBinding | null;
}

export type BindingFailureReason =
  | 'NO_CONTINUATION_TARGET'
  | 'NO_PENDING_APPROVAL'
  | 'AMBIGUOUS_PENDING_APPROVAL'
  | 'APPROVAL_NOT_PENDING'
  | 'APPROVAL_EXPIRED'
  | 'IDENTITY_MISMATCH';

export type BindingResolution<T> =
  | { ok: true; value: T }
  | { ok: false; reason: BindingFailureReason };

export function createConversationOperatingContext(identity: ConversationRuntimeIdentity): ConversationOperatingContext {
  assertIdentity(identity);
  return {
    schemaVersion: CONVERSATION_OPERATING_CONTEXT_SCHEMA,
    ...identity,
    activeTask: null,
    continuationTarget: null,
    statusTruth: [],
    blocker: null,
    nextAction: null,
    pendingApproval: null,
  };
}

export function sameConversationRuntimeIdentity(
  left: ConversationRuntimeIdentity,
  right: ConversationRuntimeIdentity,
): boolean {
  return left.conversationId === right.conversationId
    && left.backendSystem === right.backendSystem
    && left.agentId === right.agentId
    && left.sessionIdentity === right.sessionIdentity;
}

export function resolveContinuation(
  context: ConversationOperatingContext,
  currentIdentity: ConversationRuntimeIdentity,
): BindingResolution<ContinuationTargetBinding> {
  if (!sameConversationRuntimeIdentity(context, currentIdentity)) {
    return { ok: false, reason: 'IDENTITY_MISMATCH' };
  }
  const target = context.continuationTarget;
  if (!target) return { ok: false, reason: 'NO_CONTINUATION_TARGET' };
  if (!sameConversationRuntimeIdentity(target, currentIdentity)) {
    return { ok: false, reason: 'IDENTITY_MISMATCH' };
  }
  return { ok: true, value: target };
}

/**
 * Reconciles backend-owned approval candidates into the one approval Chat may
 * display/bind. Zero or multiple valid candidates fail closed.
 */
export function reconcilePendingApproval(
  context: ConversationOperatingContext,
  candidates: readonly PendingApprovalBinding[],
  now = new Date(),
): BindingResolution<PendingApprovalBinding> {
  const matching = candidates.filter((candidate) => {
    if (!sameConversationRuntimeIdentity(candidate, context)) return false;
    if (candidate.state !== 'pending') return false;
    return !isExpired(candidate, now);
  });

  if (matching.length === 0) return { ok: false, reason: 'NO_PENDING_APPROVAL' };
  if (matching.length > 1) return { ok: false, reason: 'AMBIGUOUS_PENDING_APPROVAL' };
  return { ok: true, value: matching[0] };
}

/**
 * Resolves a bare approval turn to an opaque approval id only. This function
 * never marks an approval approved and never executes the protected action;
 * the authoritative backend must perform both after re-verification.
 */
export function resolveBareApproval(
  context: ConversationOperatingContext,
  currentIdentity: ConversationRuntimeIdentity,
  now = new Date(),
): BindingResolution<{ approvalId: string }> {
  if (!sameConversationRuntimeIdentity(context, currentIdentity)) {
    return { ok: false, reason: 'IDENTITY_MISMATCH' };
  }

  const approval = context.pendingApproval;
  if (!approval) return { ok: false, reason: 'NO_PENDING_APPROVAL' };
  if (!sameConversationRuntimeIdentity(approval, currentIdentity)) {
    return { ok: false, reason: 'IDENTITY_MISMATCH' };
  }
  if (approval.state !== 'pending') return { ok: false, reason: 'APPROVAL_NOT_PENDING' };
  if (isExpired(approval, now)) return { ok: false, reason: 'APPROVAL_EXPIRED' };

  return { ok: true, value: { approvalId: approval.approvalId } };
}

export function bindActiveTask(
  context: ConversationOperatingContext,
  task: ActiveTaskBinding,
): ConversationOperatingContext {
  assertNonEmpty(task.taskId, 'taskId');
  assertNonEmpty(task.label, 'task label');
  return {
    ...context,
    activeTask: task,
    continuationTarget: {
      conversationId: context.conversationId,
      backendSystem: context.backendSystem,
      agentId: context.agentId,
      sessionIdentity: context.sessionIdentity,
      taskId: task.taskId,
      label: task.label,
      targetRef: context.sessionIdentity,
    },
    blocker: null,
    nextAction: null,
  };
}

export function recordVerifiedFact(
  context: ConversationOperatingContext,
  summary: string,
  evidenceRef: string,
  verifiedAt = new Date().toISOString(),
): ConversationOperatingContext {
  assertNonEmpty(summary, 'fact summary');
  assertNonEmpty(evidenceRef, 'fact evidenceRef');
  const statusTruth = [
    ...context.statusTruth,
    { classification: 'FACT' as const, summary, evidenceRef, verifiedAt },
  ].slice(-20);
  return { ...context, statusTruth };
}

export function validateConversationOperatingContext(value: unknown): ConversationOperatingContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Operating context must be an object');
  const context = value as ConversationOperatingContext;
  if (context.schemaVersion !== CONVERSATION_OPERATING_CONTEXT_SCHEMA) throw new Error('Operating context schema is invalid');
  assertIdentity(context);
  if (!Array.isArray(context.statusTruth)) throw new Error('Operating context statusTruth must be an array');
  if (context.statusTruth.length > 20) throw new Error('Operating context statusTruth exceeds its bound');
  for (const item of context.statusTruth) {
    if (!item || !['FACT', 'INFERENCE', 'UNKNOWN'].includes(item.classification)) throw new Error('Operating context truth class is invalid');
    assertNonEmpty(item.summary, 'truth summary');
  }
  if (context.activeTask) {
    assertNonEmpty(context.activeTask.taskId, 'taskId');
    assertNonEmpty(context.activeTask.label, 'task label');
  }
  if (context.continuationTarget) {
    assertIdentity(context.continuationTarget);
    assertNonEmpty(context.continuationTarget.taskId, 'continuation taskId');
    assertNonEmpty(context.continuationTarget.label, 'continuation label');
    assertNonEmpty(context.continuationTarget.targetRef, 'continuation targetRef');
  }
  if (context.blocker) {
    assertNonEmpty(context.blocker.blockerId, 'blockerId');
    assertNonEmpty(context.blocker.summary, 'blocker summary');
    assertNonEmpty(context.blocker.nextAction, 'blocker nextAction');
  }
  if (context.pendingApproval) {
    assertIdentity(context.pendingApproval);
    assertNonEmpty(context.pendingApproval.approvalId, 'approvalId');
    assertNonEmpty(context.pendingApproval.kind, 'approval kind');
    assertNonEmpty(context.pendingApproval.summary, 'approval summary');
    if (!['pending', 'approved', 'expired', 'cancelled'].includes(context.pendingApproval.state)) throw new Error('Approval state is invalid');
  }
  return context;
}

export function recordFailure(
  context: ConversationOperatingContext,
  blocker: BlockerRecord,
): ConversationOperatingContext {
  assertNonEmpty(blocker.blockerId, 'blockerId');
  assertNonEmpty(blocker.summary, 'blocker summary');
  assertNonEmpty(blocker.nextAction, 'blocker nextAction');
  return { ...context, blocker, nextAction: blocker.nextAction };
}

export function clearResolvedBlocker(context: ConversationOperatingContext): ConversationOperatingContext {
  return { ...context, blocker: null };
}

function isExpired(approval: PendingApprovalBinding, now: Date): boolean {
  if (!approval.expiresAt) return false;
  const expiresAt = Date.parse(approval.expiresAt);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt <= now.getTime();
}

function assertIdentity(identity: ConversationRuntimeIdentity) {
  assertNonEmpty(identity.conversationId, 'conversationId');
  assertNonEmpty(identity.agentId, 'agentId');
  assertNonEmpty(identity.sessionIdentity, 'sessionIdentity');
}

function assertNonEmpty(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label} must be non-empty`);
}
