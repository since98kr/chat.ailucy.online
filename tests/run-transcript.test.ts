import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../shared/contracts';
import {
  emptyTranscriptState,
  reduceTranscript,
  selectTranscripts,
  transcriptAnchorId,
} from '../src/run-transcript';

/**
 * The reducer only reads a handful of fields from each record, so the helpers
 * below build the minimum shape and cast once at the boundary.
 */
function event(value: unknown): StreamEvent {
  return value as StreamEvent;
}

function delta(runId: string, messageId: string, text: string): StreamEvent {
  return event({ type: 'content.delta', runId, messageId, delta: text });
}

function step(runId: string, id: string, status: string, position = 0) {
  return {
    id,
    runId,
    agentId: 'agent-a',
    systemId: 'hermes',
    position,
    parallelGroup: null,
    dependsOnStepIds: [],
    status,
    attempt: 1,
    outputMessageId: null,
    error: null,
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const NOW = '2026-01-01T00:00:10.000Z';

describe('reduceTranscript', () => {
  it('merges repeated content deltas into a single entry and accumulates counters', () => {
    let state = reduceTranscript(emptyTranscriptState, delta('run-1', 'msg-1', 'abc'), NOW);
    state = reduceTranscript(state, delta('run-1', 'msg-1', 'de'), NOW);

    const run = state.runs['run-1'];
    expect(state.order).toEqual(['run-1']);
    expect(run.entries).toHaveLength(1);
    expect(run.entries[0].kind).toBe('content.delta');
    expect(run.entries[0].tone).toBe('running');
    expect(run.deltaCount).toBe(2);
    expect(run.deltaChars).toBe(5);
    expect(run.messageId).toBe('msg-1');
  });

  it('settles the delta entry and anchors the run on completion', () => {
    let state = reduceTranscript(emptyTranscriptState, delta('run-1', 'msg-1', 'abc'), NOW);
    state = reduceTranscript(
      state,
      event({ type: 'run.completed', runId: 'run-1', message: { id: 'msg-1' } }),
      NOW,
    );

    const run = state.runs['run-1'];
    expect(run.status).toBe('completed');
    expect(run.messageId).toBe('msg-1');
    expect(transcriptAnchorId(run)).toBe('msg-1');
    expect(run.entries.find((entry) => entry.kind === 'content.delta')?.tone).toBe('success');
    expect(run.entries.at(-1)?.kind).toBe('run.completed');
    expect(selectTranscripts(state, 'msg-1')).toHaveLength(1);
    expect(selectTranscripts(state, 'msg-2')).toHaveLength(0);
  });

  it('seeds every step row when a workflow run record arrives', () => {
    const state = reduceTranscript(
      emptyTranscriptState,
      event({
        type: 'workflow.run',
        run: {
          id: 'run-2',
          conversationId: 'conv-1',
          sourceMessageId: 'msg-user',
          idempotencyKey: null,
          status: 'running',
          coordinatorAgentId: null,
          requestedAgentIds: ['agent-a', 'agent-b'],
          error: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:01.000Z',
          completedAt: null,
          steps: [step('run-2', 'step-1', 'completed', 0), step('run-2', 'step-2', 'running', 1)],
        },
      }),
      NOW,
    );

    const run = state.runs['run-2'];
    expect(run.sourceMessageId).toBe('msg-user');
    expect(run.status).toBe('running');
    expect(run.entries).toHaveLength(3);
    expect(run.entries.filter((entry) => entry.kind === 'workflow.step')).toHaveLength(2);
    expect(transcriptAnchorId(run)).toBe('msg-user');
    expect(selectTranscripts(state, 'msg-user')).toHaveLength(1);
  });

  it('updates an existing step in place instead of appending a duplicate', () => {
    let state = reduceTranscript(
      emptyTranscriptState,
      event({ type: 'workflow.step', step: step('run-3', 'step-1', 'running') }),
      NOW,
    );
    const firstAt = state.runs['run-3'].entries[0].at;

    state = reduceTranscript(
      state,
      event({ type: 'workflow.step', step: step('run-3', 'step-1', 'completed') }),
      NOW,
    );

    const run = state.runs['run-3'];
    expect(run.entries).toHaveLength(1);
    expect(run.entries[0].tone).toBe('success');
    expect(run.entries[0].at).toBe(firstAt);
  });

  it('returns the same state reference for events it does not track', () => {
    const state = reduceTranscript(emptyTranscriptState, delta('run-4', 'msg-4', 'a'), NOW);

    const ignoredType = reduceTranscript(
      state,
      event({ type: 'participants.updated', participants: [] }),
      NOW,
    );
    const ignoredWorkflowEvent = reduceTranscript(
      state,
      event({
        type: 'workflow.event',
        event: {
          id: 'evt-1',
          runId: 'run-4',
          sequence: 1,
          type: 'step.delta',
          payload: {},
          createdAt: NOW,
        },
      }),
      NOW,
    );
    const repeatedStep = reduceTranscript(
      reduceTranscript(state, event({ type: 'workflow.step', step: step('run-4', 's', 'running') }), NOW),
      event({ type: 'workflow.step', step: step('run-4', 's', 'running') }),
      NOW,
    );

    expect(ignoredType).toBe(state);
    expect(ignoredWorkflowEvent).toBe(state);
    expect(repeatedStep.runs['run-4'].entries).toHaveLength(2);
  });

  it('keeps a failed run visible with its error detail', () => {
    let state = reduceTranscript(emptyTranscriptState, delta('run-5', 'msg-5', 'x'), NOW);
    state = reduceTranscript(
      state,
      event({ type: 'run.failed', runId: 'run-5', error: 'gateway timeout' }),
      NOW,
    );

    const run = state.runs['run-5'];
    expect(run.status).toBe('failed');
    expect(run.entries.at(-1)?.tone).toBe('error');
    expect(run.entries.at(-1)?.detail).toBe('gateway timeout');
  });
});
