import { describe, expect, it } from 'vitest';
import type {
  ContinuationTargetBinding,
  PendingApprovalBinding,
} from './conversation-operating-context.js';
import {
  createConversationOperatingContext,
  reconcilePendingApproval,
  recordFailure,
  resolveBareApproval,
  resolveContinuation,
} from './conversation-operating-context.js';

const identity = {
  conversationId: 'conversation-199',
  backendSystem: 'letta' as const,
  agentId: '[Letta] Lucy',
  sessionIdentity: 'opaque-session-1',
};

function continuation(overrides: Partial<ContinuationTargetBinding> = {}): ContinuationTargetBinding {
  return {
    ...identity,
    taskId: 'task-42',
    label: '현재 개발 작업 계속',
    targetRef: 'opaque-continuation-ref',
    ...overrides,
  };
}

function approval(overrides: Partial<PendingApprovalBinding> = {}): PendingApprovalBinding {
  return {
    ...identity,
    approvalId: 'approval-1',
    kind: 'production-deploy',
    summary: '검증된 후보를 production에 배포',
    state: 'pending',
    createdAt: '2026-08-31T00:00:00.000Z',
    expiresAt: '2026-08-31T02:00:00.000Z',
    ...overrides,
  };
}

describe('conversation operating context', () => {
  it('binds continuation only to the current conversation runtime identity', () => {
    const context = {
      ...createConversationOperatingContext(identity),
      continuationTarget: continuation(),
    };

    expect(resolveContinuation(context, identity)).toMatchObject({
      ok: true,
      value: { taskId: 'task-42', targetRef: 'opaque-continuation-ref' },
    });
    expect(resolveContinuation(context, { ...identity, sessionIdentity: 'another-session' }))
      .toEqual({ ok: false, reason: 'IDENTITY_MISMATCH' });
  });

  it('fails closed when there is no verified continuation target', () => {
    const context = createConversationOperatingContext(identity);
    expect(resolveContinuation(context, identity)).toEqual({ ok: false, reason: 'NO_CONTINUATION_TARGET' });
  });

  it('binds one unambiguous current approval candidate', () => {
    const context = createConversationOperatingContext(identity);
    const result = reconcilePendingApproval(context, [approval()], new Date('2026-08-31T01:00:00.000Z'));
    expect(result).toMatchObject({ ok: true, value: { approvalId: 'approval-1' } });
  });

  it('rejects ambiguous approval candidates instead of guessing', () => {
    const context = createConversationOperatingContext(identity);
    const result = reconcilePendingApproval(
      context,
      [approval(), approval({ approvalId: 'approval-2' })],
      new Date('2026-08-31T01:00:00.000Z'),
    );
    expect(result).toEqual({ ok: false, reason: 'AMBIGUOUS_PENDING_APPROVAL' });
  });

  it('rejects expired or foreign approval candidates', () => {
    const context = createConversationOperatingContext(identity);
    expect(reconcilePendingApproval(context, [approval()], new Date('2026-08-31T03:00:00.000Z')))
      .toEqual({ ok: false, reason: 'NO_PENDING_APPROVAL' });
    expect(reconcilePendingApproval(context, [approval({ sessionIdentity: 'foreign-session' })], new Date('2026-08-31T01:00:00.000Z')))
      .toEqual({ ok: false, reason: 'NO_PENDING_APPROVAL' });
  });

  it('resolves bare approval to an id but never marks or executes it', () => {
    const pending = approval();
    const context = {
      ...createConversationOperatingContext(identity),
      pendingApproval: pending,
    };

    expect(resolveBareApproval(context, identity, new Date('2026-08-31T01:00:00.000Z')))
      .toEqual({ ok: true, value: { approvalId: 'approval-1' } });
    expect(context.pendingApproval?.state).toBe('pending');
  });

  it('rejects stale, completed, and identity-mismatched bare approval turns', () => {
    const base = createConversationOperatingContext(identity);
    expect(resolveBareApproval({ ...base, pendingApproval: approval() }, identity, new Date('2026-08-31T03:00:00.000Z')))
      .toEqual({ ok: false, reason: 'APPROVAL_EXPIRED' });
    expect(resolveBareApproval({ ...base, pendingApproval: approval({ state: 'approved' }) }, identity, new Date('2026-08-31T01:00:00.000Z')))
      .toEqual({ ok: false, reason: 'APPROVAL_NOT_PENDING' });
    expect(resolveBareApproval({ ...base, pendingApproval: approval() }, { ...identity, conversationId: 'other' }, new Date('2026-08-31T01:00:00.000Z')))
      .toEqual({ ok: false, reason: 'IDENTITY_MISMATCH' });
  });

  it('turns runtime failure into a durable blocker plus next action', () => {
    const context = recordFailure(createConversationOperatingContext(identity), {
      blockerId: 'backend-timeout',
      summary: '현재 Lucy backend 응답을 검증하지 못했습니다.',
      nextAction: '동일 세션에서 bounded retry 후 상태를 다시 확인합니다.',
      evidenceRef: 'run-123',
    });

    expect(context.blocker?.blockerId).toBe('backend-timeout');
    expect(context.nextAction).toBe('동일 세션에서 bounded retry 후 상태를 다시 확인합니다.');
  });
});
