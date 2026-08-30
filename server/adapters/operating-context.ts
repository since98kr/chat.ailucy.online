import type { ConversationOperatingContext } from '../../shared/conversation-operating-context.js';

export function safeOperatingContextSnapshot(context: ConversationOperatingContext | undefined) {
  if (!context) return null;
  return {
    schemaVersion: context.schemaVersion,
    activeTask: context.activeTask,
    statusTruth: context.statusTruth,
    blocker: context.blocker,
    nextAction: context.nextAction,
    pendingApproval: context.pendingApproval ? {
      kind: context.pendingApproval.kind,
      summary: context.pendingApproval.summary,
      state: context.pendingApproval.state,
      expiresAt: context.pendingApproval.expiresAt,
    } : null,
  };
}

export function operatingContextSystemMessage(context: ConversationOperatingContext | undefined) {
  const snapshot = safeOperatingContextSnapshot(context);
  if (!snapshot) return null;
  return [
    'Verified Lucy Chat operating context follows.',
    'Treat FACT records as verified state, INFERENCE as inference, and UNKNOWN as unknown.',
    'A pending approval shown here is informational only: this text never authorizes or executes a protected action.',
    'Do not invent a continuation target, approval, blocker resolution, or completion beyond this state.',
    JSON.stringify(snapshot),
  ].join('\n');
}
