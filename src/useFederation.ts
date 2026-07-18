import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CreateMemoryCapsuleInput,
  FederationSnapshotRecord,
  MemoryCapsuleStatus,
  StreamEvent,
  WorkflowEventRecord,
  WorkflowRunRecord,
} from '../shared/contracts';
import {
  createMemoryCapsule,
  disableFederation,
  enableFederation,
  getFederationSnapshot,
  listWorkflowEvents,
  resumeWorkflow,
  updateMemoryCapsule,
} from './api';
import { subscribeCollaborationEvents } from './collaboration-events';

const emptySnapshot: FederationSnapshotRecord = { config: null, capsules: [], runs: [] };

function upsertRun(runs: WorkflowRunRecord[], run: WorkflowRunRecord) {
  return [run, ...runs.filter((item) => item.id !== run.id)]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function useFederation(conversationId: string | null) {
  const [snapshot, setSnapshot] = useState<FederationSnapshotRecord>(emptySnapshot);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<WorkflowEventRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resumeAbortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setSnapshot(emptySnapshot);
      setEvents([]);
      setSelectedRunId(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await getFederationSnapshot(conversationId);
      setSnapshot(next);
      setSelectedRunId((current) => current && next.runs.some((run) => run.id === current)
        ? current
        : next.runs[0]?.id ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '교차 시스템 상태를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => subscribeCollaborationEvents((event: StreamEvent) => {
    if (event.type === 'workflow.run') {
      setSnapshot((current) => ({ ...current, runs: upsertRun(current.runs, event.run) }));
      setSelectedRunId(event.run.id);
      return;
    }
    if (event.type === 'workflow.step') {
      setSnapshot((current) => ({
        ...current,
        runs: current.runs.map((run) => run.id === event.step.runId ? {
          ...run,
          steps: run.steps.map((step) => step.id === event.step.id ? event.step : step),
          updatedAt: event.step.updatedAt,
        } : run),
      }));
      return;
    }
    if (event.type === 'workflow.event') {
      setEvents((current) => event.event.runId === selectedRunId
        ? [...current.filter((item) => item.id !== event.event.id), event.event].sort((a, b) => a.sequence - b.sequence)
        : current);
      return;
    }
    if (event.type === 'memory.capsule') {
      setSnapshot((current) => ({
        ...current,
        capsules: [event.capsule, ...current.capsules.filter((item) => item.id !== event.capsule.id)],
      }));
    }
  }), [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) {
      setEvents([]);
      return;
    }
    listWorkflowEvents(selectedRunId)
      .then(setEvents)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '실행 이력을 불러오지 못했습니다.'));
  }, [selectedRunId]);

  const enable = useCallback(async () => {
    if (!conversationId) return null;
    setSaving(true);
    setError(null);
    try {
      const next = await enableFederation(conversationId);
      setSnapshot(next);
      return next.config;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '교차 시스템 모드를 활성화하지 못했습니다.');
      return null;
    } finally {
      setSaving(false);
    }
  }, [conversationId]);

  const disable = useCallback(async () => {
    if (!conversationId) return null;
    setSaving(true);
    setError(null);
    try {
      const config = await disableFederation(conversationId);
      setSnapshot((current) => ({ ...current, config }));
      return config;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '교차 시스템 모드를 비활성화하지 못했습니다.');
      return null;
    } finally {
      setSaving(false);
    }
  }, [conversationId]);

  const createCapsule = useCallback(async (input: CreateMemoryCapsuleInput) => {
    if (!conversationId) return null;
    setSaving(true);
    setError(null);
    try {
      const capsule = await createMemoryCapsule(conversationId, input);
      setSnapshot((current) => ({ ...current, capsules: [capsule, ...current.capsules] }));
      return capsule;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Memory Capsule을 만들지 못했습니다.');
      return null;
    } finally {
      setSaving(false);
    }
  }, [conversationId]);

  const setCapsuleStatus = useCallback(async (capsuleId: string, status: MemoryCapsuleStatus) => {
    setSaving(true);
    setError(null);
    try {
      const capsule = await updateMemoryCapsule(capsuleId, { status });
      setSnapshot((current) => ({
        ...current,
        capsules: current.capsules.map((item) => item.id === capsule.id ? capsule : item),
      }));
      return capsule;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Memory Capsule 상태를 변경하지 못했습니다.');
      return null;
    } finally {
      setSaving(false);
    }
  }, []);

  const resume = useCallback(async (runId: string, onEvent: (event: StreamEvent) => void) => {
    if (resuming) return;
    setResuming(true);
    setError(null);
    const controller = new AbortController();
    resumeAbortRef.current = controller;
    try {
      await resumeWorkflow(runId, onEvent, controller.signal);
      await refresh();
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : '워크플로를 재개하지 못했습니다.');
      }
    } finally {
      setResuming(false);
      resumeAbortRef.current = null;
    }
  }, [refresh, resuming]);

  const selectedRun = useMemo(
    () => snapshot.runs.find((run) => run.id === selectedRunId) ?? null,
    [selectedRunId, snapshot.runs],
  );

  return {
    config: snapshot.config,
    active: snapshot.config?.mode === 'federated',
    capsules: snapshot.capsules,
    runs: snapshot.runs,
    selectedRun,
    selectedRunId,
    events,
    latestRun: snapshot.runs[0] ?? null,
    resumableRuns: snapshot.runs.filter((run) => run.status === 'paused' || run.status === 'failed'),
    loading,
    saving,
    resuming,
    error,
    enable,
    disable,
    createCapsule,
    setCapsuleStatus,
    resume,
    refresh,
    selectRun: setSelectedRunId,
    stopResume: () => resumeAbortRef.current?.abort(),
    clearError: () => setError(null),
  };
}
