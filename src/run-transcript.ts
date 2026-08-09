import type { StreamEvent, WorkflowRunStatus, WorkflowStepStatus } from '../shared/contracts';

export type TranscriptTone = 'pending' | 'running' | 'success' | 'error' | 'muted';
export type TranscriptRunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface TranscriptEntry {
  /** Stable identity so repeated events update in place instead of appending. */
  id: string;
  kind: string;
  label: string;
  detail: string | null;
  tone: TranscriptTone;
  at: string;
}

export interface RunTranscript {
  runId: string;
  /** Assistant message this run produced. Null until the first delta/completion arrives. */
  messageId: string | null;
  /** User message that triggered a federated workflow run. */
  sourceMessageId: string | null;
  status: TranscriptRunStatus;
  startedAt: string;
  updatedAt: string;
  entries: TranscriptEntry[];
  deltaCount: number;
  deltaChars: number;
  /** True when older entries were dropped because the cap was reached. */
  truncated: boolean;
}

export interface TranscriptState {
  /** Run ids in first-seen order. */
  order: string[];
  runs: Record<string, RunTranscript>;
}

export const MAX_TRANSCRIPT_ENTRIES = 200;
export const MAX_TRANSCRIPT_RUNS = 40;

export const emptyTranscriptState: TranscriptState = { order: [], runs: {} };

const stepStatusLabel: Record<WorkflowStepStatus, string> = {
  pending: '대기',
  running: '실행 중',
  completed: '완료',
  failed: '실패',
  skipped: '건너뜀',
  cancelled: '취소됨',
};

const stepStatusTone: Record<WorkflowStepStatus, TranscriptTone> = {
  pending: 'pending',
  running: 'running',
  completed: 'success',
  failed: 'error',
  skipped: 'muted',
  cancelled: 'muted',
};

const runStatusLabel: Record<WorkflowRunStatus, string> = {
  queued: '실행 계획 대기',
  running: '워크플로 실행 중',
  paused: '워크플로 일시중지',
  completed: '워크플로 완료',
  failed: '워크플로 실패',
  cancelled: '워크플로 취소됨',
};

const runStatusTone: Record<WorkflowRunStatus, TranscriptTone> = {
  queued: 'pending',
  running: 'running',
  paused: 'pending',
  completed: 'success',
  failed: 'error',
  cancelled: 'muted',
};

const runStatusToTranscriptStatus: Record<WorkflowRunStatus, TranscriptRunStatus> = {
  queued: 'running',
  running: 'running',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** Workflow events that add information the step list does not already carry. */
const notableWorkflowEvents = new Set(['capsule.used', 'replay.started', 'run.paused', 'run.resumed']);

const workflowEventLabel: Record<string, string> = {
  'capsule.used': 'Memory Capsule 사용',
  'replay.started': '기존 실행 이력 재생',
  'run.paused': '실행 일시중지',
  'run.resumed': '실행 재개',
};

function createRun(runId: string, at: string): RunTranscript {
  return {
    runId,
    messageId: null,
    sourceMessageId: null,
    status: 'running',
    startedAt: at,
    updatedAt: at,
    entries: [],
    deltaCount: 0,
    deltaChars: 0,
    truncated: false,
  };
}

function putEntry(run: RunTranscript, entry: TranscriptEntry): RunTranscript {
  const index = run.entries.findIndex((item) => item.id === entry.id);
  let entries: TranscriptEntry[];
  if (index < 0) {
    entries = [...run.entries, entry];
  } else {
    const existing = run.entries[index];
    if (
      existing.label === entry.label
      && existing.detail === entry.detail
      && existing.tone === entry.tone
    ) {
      return run;
    }
    entries = [...run.entries];
    // Preserve the original timestamp so the list stays chronologically stable.
    entries[index] = { ...entry, at: existing.at };
  }
  let truncated = run.truncated;
  if (entries.length > MAX_TRANSCRIPT_ENTRIES) {
    entries = entries.slice(entries.length - MAX_TRANSCRIPT_ENTRIES);
    truncated = true;
  }
  return { ...run, entries, truncated, updatedAt: entry.at };
}

function commit(state: TranscriptState, runId: string, run: RunTranscript): TranscriptState {
  const known = state.runs[runId];
  if (known === run) return state;
  const order = known ? state.order : [...state.order, runId];
  const runs = { ...state.runs, [runId]: run };
  if (order.length <= MAX_TRANSCRIPT_RUNS) return { order, runs };
  const dropped = order.slice(0, order.length - MAX_TRANSCRIPT_RUNS);
  const trimmed = order.slice(order.length - MAX_TRANSCRIPT_RUNS);
  for (const id of dropped) delete runs[id];
  return { order: trimmed, runs };
}

/**
 * Folds a stream event into the run transcript state.
 *
 * The chat UI previously reduced every run event to a single transient
 * `runStatus` string that was cleared when the stream ended, so no execution
 * history survived. This reducer keeps that history per run instead.
 *
 * Returns the same state reference when the event carries nothing new.
 */
export function reduceTranscript(
  state: TranscriptState,
  event: StreamEvent,
  now: string = new Date().toISOString(),
): TranscriptState {
  switch (event.type) {
    case 'run.started': {
      const run = state.runs[event.runId] ?? createRun(event.runId, now);
      return commit(state, event.runId, putEntry(run, {
        id: `${event.runId}:run.started`,
        kind: 'run.started',
        label: event.agentId ? `${event.agentId} 응답 준비` : '응답 준비',
        detail: null,
        tone: 'running',
        at: now,
      }));
    }
    case 'run.status': {
      const run = state.runs[event.runId] ?? createRun(event.runId, now);
      return commit(state, event.runId, putEntry(run, {
        id: `${event.runId}:run.status:${event.status}`,
        kind: 'run.status',
        label: event.agentId ? `${event.agentId} · ${event.status}` : event.status,
        detail: null,
        tone: 'running',
        at: now,
      }));
    }
    case 'content.delta': {
      const base = state.runs[event.runId] ?? createRun(event.runId, now);
      const author = event.authorId ?? null;
      const deltaCount = base.deltaCount + 1;
      const deltaChars = base.deltaChars + event.delta.length;
      const run = putEntry(
        { ...base, messageId: base.messageId ?? event.messageId, deltaCount, deltaChars },
        {
          id: `${event.runId}:content.delta`,
          kind: 'content.delta',
          label: author ? `${author} 응답 작성 중` : '응답 작성 중',
          detail: `${deltaCount}개 조각 · ${deltaChars}자`,
          tone: 'running',
          at: now,
        },
      );
      return commit(state, event.runId, { ...run, updatedAt: now });
    }
    case 'artifact.created': {
      const run = state.runs[event.runId] ?? createRun(event.runId, now);
      return commit(state, event.runId, putEntry(run, {
        id: `${event.runId}:artifact:${event.artifact.id}`,
        kind: 'artifact.created',
        label: '파일 생성',
        detail: event.artifact.filename,
        tone: 'success',
        at: now,
      }));
    }
    case 'artifacts.delivery': {
      const { delivery } = event;
      const base = state.runs[delivery.runId] ?? createRun(delivery.runId, now);
      const label = delivery.state === 'delivering'
        ? `${delivery.agentId} 첨부 전달 중`
        : delivery.state === 'delivered'
          ? `${delivery.agentId} 첨부 전달 완료`
          : delivery.state === 'unsupported'
            ? `${delivery.agentId} 첨부 미지원`
            : `${delivery.agentId} 첨부 전달 실패`;
      const tone: TranscriptTone = delivery.state === 'delivered'
        ? 'success'
        : delivery.state === 'failed'
          ? 'error'
          : delivery.state === 'unsupported' ? 'muted' : 'running';
      return commit(state, delivery.runId, putEntry(base, {
        id: `${delivery.runId}:delivery:${delivery.agentId}`,
        kind: 'artifacts.delivery',
        label,
        detail: delivery.detail ?? `첨부 ${delivery.artifactIds.length}건`,
        tone,
        at: now,
      }));
    }
    case 'run.completed': {
      const base = state.runs[event.runId] ?? createRun(event.runId, now);
      const withMessage: RunTranscript = {
        ...base,
        messageId: base.messageId ?? event.message.id,
        status: 'completed',
      };
      const settled = base.deltaCount > 0
        ? putEntry(withMessage, {
          id: `${event.runId}:content.delta`,
          kind: 'content.delta',
          label: event.agentId ? `${event.agentId} 응답 작성 완료` : '응답 작성 완료',
          detail: `${base.deltaCount}개 조각 · ${base.deltaChars}자`,
          tone: 'success',
          at: now,
        })
        : withMessage;
      return commit(state, event.runId, putEntry(settled, {
        id: `${event.runId}:run.completed`,
        kind: 'run.completed',
        label: event.agentId ? `${event.agentId} 응답 완료` : '응답 완료',
        detail: null,
        tone: 'success',
        at: now,
      }));
    }
    case 'run.failed': {
      const base = state.runs[event.runId] ?? createRun(event.runId, now);
      return commit(state, event.runId, putEntry({ ...base, status: 'failed' }, {
        id: `${event.runId}:run.failed`,
        kind: 'run.failed',
        label: event.agentId ? `${event.agentId} 응답 실패` : '응답 실패',
        detail: event.error,
        tone: 'error',
        at: now,
      }));
    }
    case 'workflow.run': {
      const { run: record } = event;
      const base = state.runs[record.id] ?? createRun(record.id, record.createdAt);
      const next: RunTranscript = {
        ...base,
        sourceMessageId: record.sourceMessageId,
        status: runStatusToTranscriptStatus[record.status],
      };
      const withRun = putEntry(next, {
        id: `${record.id}:workflow.run:${record.status}`,
        kind: 'workflow.run',
        label: runStatusLabel[record.status],
        detail: record.error ?? (record.requestedAgentIds.length > 0
          ? `참여 ${record.requestedAgentIds.length}명`
          : null),
        tone: runStatusTone[record.status],
        at: record.updatedAt || now,
      });
      // Seed the step rows so a resumed/replayed run renders its full plan.
      return commit(state, record.id, record.steps.reduce((acc, step) => putEntry(acc, {
        id: `${record.id}:step:${step.id}`,
        kind: 'workflow.step',
        label: `${step.position + 1}. ${step.agentId} · ${stepStatusLabel[step.status]}`,
        detail: step.error ?? (step.attempt > 1 ? `시도 ${step.attempt}회` : null),
        tone: stepStatusTone[step.status],
        at: step.updatedAt || now,
      }), withRun));
    }
    case 'workflow.step': {
      const { step } = event;
      const base = state.runs[step.runId] ?? createRun(step.runId, step.updatedAt || now);
      return commit(state, step.runId, putEntry(base, {
        id: `${step.runId}:step:${step.id}`,
        kind: 'workflow.step',
        label: `${step.position + 1}. ${step.agentId} · ${stepStatusLabel[step.status]}`,
        detail: step.error ?? (step.attempt > 1 ? `시도 ${step.attempt}회` : null),
        tone: stepStatusTone[step.status],
        at: step.updatedAt || now,
      }));
    }
    case 'workflow.event': {
      const record = event.event;
      if (!notableWorkflowEvents.has(record.type)) return state;
      const base = state.runs[record.runId] ?? createRun(record.runId, record.createdAt);
      return commit(state, record.runId, putEntry(base, {
        id: `${record.runId}:event:${record.id}`,
        kind: 'workflow.event',
        label: workflowEventLabel[record.type] ?? record.type,
        detail: typeof record.payload.title === 'string' ? record.payload.title : null,
        tone: record.type === 'run.paused' ? 'pending' : 'muted',
        at: record.createdAt || now,
      }));
    }
    case 'workflow.replayed': {
      const base = state.runs[event.runId] ?? createRun(event.runId, now);
      return commit(state, event.runId, putEntry(base, {
        id: `${event.runId}:workflow.replayed`,
        kind: 'workflow.replayed',
        label: '기존 워크플로 재사용',
        detail: `이벤트 ${event.eventCount}개`,
        tone: 'muted',
        at: now,
      }));
    }
    default:
      return state;
  }
}

/** Anchor message for a run: the assistant reply when known, otherwise the request. */
export function transcriptAnchorId(run: RunTranscript): string | null {
  return run.messageId ?? run.sourceMessageId;
}

/** Runs whose anchor is the given message, in first-seen order. */
export function selectTranscripts(state: TranscriptState, messageId: string): RunTranscript[] {
  const selected: RunTranscript[] = [];
  for (const runId of state.order) {
    const run = state.runs[runId];
    if (run && transcriptAnchorId(run) === messageId) selected.push(run);
  }
  return selected;
}
