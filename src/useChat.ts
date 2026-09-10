import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationOperatingContext } from '../shared/conversation-operating-context';
import type {
  ArtifactDeliveryRecord,
  ArtifactRecord,
  ConversationDetail,
  ConversationRecord,
  ConversationSearchResult,
  ConversationStatus,
  MessageRecord,
  StreamEvent,
  SystemId,
  UpdateConversationInput,
  UploadProgressRecord,
} from '../shared/contracts';
import {
  approveConversation as approveConversationApi,
  branchConversation as branchConversationApi,
  createConversation as createConversationApi,
  getConversation,
  getConversationOperatingContext,
  listConversations,
  permanentlyDeleteConversation,
  searchConversations as searchConversationsApi,
  streamMessage,
  updateConversation as updateConversationApi,
  uploadArtifact,
} from './api';
import { emitCollaborationEvent } from './collaboration-events';
import type { TranscriptState } from './run-transcript';
import { emptyTranscriptState, reduceTranscript } from './run-transcript';

const defaultAgent: Record<SystemId, string> = {
  letta: '[Letta] Lucy',
  hermes: '[Hermes] Lucy',
  claude: '[Claude] 테이아',
};

function upsertMessage(messages: MessageRecord[], next: MessageRecord) {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index < 0) return [...messages, next];
  const copy = [...messages];
  copy[index] = next;
  return copy;
}

function upsertArtifactDelivery(current: ArtifactDeliveryRecord[], next: ArtifactDeliveryRecord) {
  const index = current.findIndex((item) => item.runId === next.runId && item.agentId === next.agentId);
  if (index < 0) return [...current, next];
  const copy = [...current];
  copy[index] = next;
  return copy;
}

export function useChat() {
  const [selectedSystem, setSelectedSystem] = useState<SystemId>('letta');
  const [selectedStatus, setSelectedStatus] = useState<ConversationStatus>('active');
  const [activeAgent, setActiveAgent] = useState(defaultAgent.letta);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [activeConversation, setActiveConversation] = useState<ConversationDetail | null>(null);
  const [operatingContext, setOperatingContext] = useState<ConversationOperatingContext | null>(null);
  const [searchResults, setSearchResults] = useState<ConversationSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [uploads, setUploads] = useState<UploadProgressRecord[]>([]);
  const [pendingArtifactIds, setPendingArtifactIds] = useState<string[]>([]);
  const [artifactDeliveriesByConversation, setArtifactDeliveriesByConversation] = useState<Record<string, ArtifactDeliveryRecord[]>>({});
  const [transcriptsByConversation, setTranscriptsByConversation] = useState<Record<string, TranscriptState>>({});
  const [runStatusByConversation, setRunStatusByConversation] = useState<Record<string, string | null>>({});
  const [streamingConversationIds, setStreamingConversationIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approvingApproval, setApprovingApproval] = useState(false);
  const streamControllersRef = useRef<Map<string, AbortController>>(new Map());
  const draftTimerRef = useRef<number | null>(null);
  const searchTimerRef = useRef<number | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const suppressNextSelectionRefreshRef = useRef(false);

  const activeConversationId = activeConversation?.id ?? null;
  const artifactDeliveries = activeConversationId
    ? artifactDeliveriesByConversation[activeConversationId] ?? []
    : [];
  const transcripts = activeConversationId
    ? transcriptsByConversation[activeConversationId] ?? emptyTranscriptState
    : emptyTranscriptState;
  const runStatus = activeConversationId
    ? runStatusByConversation[activeConversationId] ?? null
    : null;
  const isStreaming = activeConversationId
    ? streamingConversationIds.has(activeConversationId)
    : false;

  const setConversationRunStatus = useCallback((conversationId: string, status: string | null) => {
    setRunStatusByConversation((current) => {
      if ((current[conversationId] ?? null) === status) return current;
      return { ...current, [conversationId]: status };
    });
  }, []);

  const detachVisibleConversation = useCallback((nextConversationId: string | null = null) => {
    // Navigation changes only which Conversation is visible. It must never
    // cancel an in-flight backend run owned by another Conversation.
    activeIdRef.current = nextConversationId;
  }, []);

  useEffect(() => () => {
    // Component teardown/page exit is not room navigation. Abort remaining
    // fetches to avoid leaking client work after the Chat UI itself is gone.
    for (const controller of streamControllersRef.current.values()) controller.abort();
    streamControllersRef.current.clear();
  }, []);

  useEffect(() => {
    const conversationId = activeConversation?.id;
    if (!isStreaming || approvingApproval || selectedSystem !== 'letta' || !conversationId) return;
    let cancelled = false;
    let refreshing = false;
    const refreshOperatingContext = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const context = await getConversationOperatingContext(conversationId);
        if (!cancelled && activeIdRef.current === conversationId) setOperatingContext(context);
      } catch {
        // The active response stream remains authoritative. Poll failures do not
        // fabricate an approval or interrupt safe model output.
      } finally {
        refreshing = false;
      }
    };
    void refreshOperatingContext();
    const timer = window.setInterval(() => void refreshOperatingContext(), 750);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeConversation?.id, approvingApproval, isStreaming, selectedSystem]);

  const applyDetail = useCallback((detail: ConversationDetail) => {
    // Imperative navigation publishes its identity synchronously so late
    // events from another Conversation cannot mutate this visible transcript.
    activeIdRef.current = detail.id;
    setActiveConversation(detail);
    setActiveAgent(detail.agentId);
    setPendingArtifactIds(detail.artifacts.filter((artifact) => !artifact.messageId).map((artifact) => artifact.id));
    setUploads([]);
    return detail;
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const [detail, context] = await Promise.all([getConversation(id), getConversationOperatingContext(id)]);
    if (activeIdRef.current !== id) return null;
    setOperatingContext(context);
    return applyDetail(detail);
  }, [applyDetail]);

  const refreshList = useCallback(
    async (systemId: SystemId, status: ConversationStatus, preferredId?: string | null) => {
      const list = await listConversations(systemId, status);
      setConversations(list);
      const selectedId =
        (preferredId && list.some((conversation) => conversation.id === preferredId) && preferredId) ||
        list[0]?.id;
      if (!selectedId) {
        detachVisibleConversation(null);
        setActiveConversation(null);
        setOperatingContext(null);
        setPendingArtifactIds([]);
        return;
      }
      detachVisibleConversation(selectedId);
      await loadConversation(selectedId);
    },
    [detachVisibleConversation, loadConversation],
  );

  useEffect(() => {
    if (suppressNextSelectionRefreshRef.current) {
      suppressNextSelectionRefreshRef.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSearchResults([]);
    // System/status navigation detaches the visible room only. Existing room
    // streams remain owned by streamControllersRef until completion or Stop.
    detachVisibleConversation(null);
    listConversations(selectedSystem, selectedStatus)
      .then(async (list) => {
        if (cancelled) return;
        setConversations(list);
        const selected = list[0];
        if (selected) {
          detachVisibleConversation(selected.id);
          const [detail, context] = await Promise.all([
            getConversation(selected.id),
            getConversationOperatingContext(selected.id),
          ]);
          if (!cancelled && activeIdRef.current === selected.id) {
            setOperatingContext(context);
            applyDetail(detail);
          }
        } else if (!cancelled) {
          detachVisibleConversation(null);
          setActiveConversation(null);
          setOperatingContext(null);
          setPendingArtifactIds([]);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '대화를 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [applyDetail, detachVisibleConversation, selectedStatus, selectedSystem]);

  const switchSystem = useCallback((systemId: SystemId, agentId = defaultAgent[systemId]) => {
    detachVisibleConversation(null);
    setSelectedStatus('active');
    setSelectedSystem(systemId);
    setActiveAgent(agentId);
  }, [detachVisibleConversation]);

  const switchStatus = useCallback((status: ConversationStatus) => {
    detachVisibleConversation(null);
    setSelectedStatus(status);
  }, [detachVisibleConversation]);

  const selectConversation = useCallback(async (id: string) => {
    // Publish the target before awaiting I/O. A late stream event from the room
    // we just left can no longer land in the newly selected room.
    detachVisibleConversation(id);
    setLoading(true);
    setError(null);
    try {
      await loadConversation(id);
    } catch (reason) {
      if (activeIdRef.current === id) {
        setError(reason instanceof Error ? reason.message : '대화를 불러오지 못했습니다.');
      }
    } finally {
      if (activeIdRef.current === id) setLoading(false);
    }
  }, [detachVisibleConversation, loadConversation]);

  const createConversation = useCallback(async (agentId = activeAgent || defaultAgent[selectedSystem], title?: string) => {
    detachVisibleConversation(null);
    setError(null);
    setSelectedStatus('active');
    const detail = await createConversationApi({ systemId: selectedSystem, agentId, title });
    setConversations((current) => [detail, ...current]);
    applyDetail(detail);
    return detail;
  }, [activeAgent, applyDetail, detachVisibleConversation, selectedSystem]);

  const createFederatedConversation = useCallback(async () => {
    detachVisibleConversation(null);
    setError(null);
    if (selectedSystem !== 'hermes' || selectedStatus !== 'active') {
      suppressNextSelectionRefreshRef.current = true;
    }
    setSelectedSystem('hermes');
    setSelectedStatus('active');
    setActiveAgent('[Hermes] Lucy');
    const detail = await createConversationApi({
      systemId: 'hermes',
      agentId: '[Hermes] Lucy',
      title: '새 교차 시스템 대화',
      federated: true,
    });
    setConversations((current) => [detail, ...current]);
    return applyDetail(detail);
  }, [applyDetail, detachVisibleConversation, selectedStatus, selectedSystem]);

  const openAgentConversation = useCallback(async (systemId: SystemId, agentId: string) => {
    detachVisibleConversation(null);
    setLoading(true);
    setError(null);
    if (selectedSystem !== systemId || selectedStatus !== 'active') {
      suppressNextSelectionRefreshRef.current = true;
    }
    setSelectedSystem(systemId);
    setSelectedStatus('active');
    setActiveAgent(agentId);
    try {
      const list = await listConversations(systemId, 'active');
      setConversations(list);
      const existing = list.find((conversation) => conversation.agentId === agentId);
      if (existing) {
        detachVisibleConversation(existing.id);
        return await loadConversation(existing.id);
      }
      const detail = await createConversationApi({
        systemId,
        agentId,
        title: agentId.includes('Lucy') ? '새 대화' : `${agentId}와 새 대화`,
      });
      setConversations((current) => [detail, ...current]);
      return applyDetail(detail);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '에이전트 대화를 열지 못했습니다.');
      return null;
    } finally {
      setLoading(false);
    }
  }, [applyDetail, detachVisibleConversation, loadConversation, selectedStatus, selectedSystem]);

  const branchConversation = useCallback(async (fromMessageId?: string | null) => {
    const sourceId = activeIdRef.current;
    if (!sourceId) return null;
    detachVisibleConversation(null);
    const detail = await branchConversationApi(sourceId, { fromMessageId });
    setSelectedSystem(detail.systemId);
    setSelectedStatus('active');
    setConversations((current) => [detail, ...current.filter((item) => item.id !== detail.id)]);
    applyDetail(detail);
    return detail;
  }, [applyDetail, detachVisibleConversation]);

  const patchConversation = useCallback(async (input: UpdateConversationInput) => {
    if (!activeIdRef.current) return null;
    const detail = await updateConversationApi(activeIdRef.current, input);
    if (detail.status !== selectedStatus) {
      await refreshList(selectedSystem, selectedStatus, null);
      return detail;
    }
    applyDetail(detail);
    setConversations((current) =>
      current
        .map((conversation) => (conversation.id === detail.id ? detail : conversation))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)),
    );
    return detail;
  }, [applyDetail, refreshList, selectedStatus, selectedSystem]);

  const deletePermanently = useCallback(async () => {
    if (!activeIdRef.current || selectedStatus !== 'trashed') return;
    await permanentlyDeleteConversation(activeIdRef.current);
    await refreshList(selectedSystem, selectedStatus, null);
  }, [refreshList, selectedStatus, selectedSystem]);

  const saveDraft = useCallback((draft: string) => {
    setActiveConversation((current) => (current ? { ...current, draft } : current));
    if (draftTimerRef.current) window.clearTimeout(draftTimerRef.current);
    const conversationId = activeIdRef.current;
    if (!conversationId) return;
    draftTimerRef.current = window.setTimeout(() => {
      updateConversationApi(conversationId, { draft }).catch(() => undefined);
    }, 500);
  }, []);

  const searchConversations = useCallback((value: string) => {
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    const query = value.trim();
    if (!query) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimerRef.current = window.setTimeout(() => {
      searchConversationsApi(query, { systemId: selectedSystem, status: selectedStatus })
        .then(setSearchResults)
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '검색하지 못했습니다.'))
        .finally(() => setSearching(false));
    }, 220);
  }, [selectedStatus, selectedSystem]);

  const handleStreamEvent = useCallback((conversationId: string, event: StreamEvent) => {
    setTranscriptsByConversation((current) => ({
      ...current,
      [conversationId]: reduceTranscript(current[conversationId] ?? emptyTranscriptState, event),
    }));

    if (
      event.type === 'routing.resolved' ||
      event.type === 'participants.updated' ||
      event.type === 'team.activity' ||
      event.type === 'workflow.run' ||
      event.type === 'workflow.step' ||
      event.type === 'workflow.event' ||
      event.type === 'memory.capsule' ||
      event.type === 'workflow.replayed'
    ) {
      // The collaboration event bus is scoped to the visible Conversation. An
      // inactive room continues server-side, then reloads its persisted state
      // when selected again instead of mutating another room's panels.
      if (activeIdRef.current === conversationId) emitCollaborationEvent(event);
      if (event.type === 'workflow.run') {
        const statusLabel = event.run.status === 'running' ? '교차 시스템 워크플로 실행 중'
          : event.run.status === 'paused' ? '워크플로가 중단되어 재개할 수 있습니다.'
            : event.run.status === 'completed' ? '교차 시스템 워크플로 완료' : null;
        setConversationRunStatus(conversationId, statusLabel);
      } else if (event.type === 'workflow.step' && event.step.status === 'running') {
        setConversationRunStatus(conversationId, `${event.step.agentId} · ${event.step.systemId} 실행 중`);
      } else if (event.type === 'workflow.replayed') {
        setConversationRunStatus(conversationId, `기존 워크플로 재사용 · 이벤트 ${event.eventCount}개`);
      }
      return;
    }
    if (event.type === 'message.accepted' || event.type === 'message.created') {
      setActiveConversation((current) =>
        current?.id === conversationId
          ? { ...current, messages: upsertMessage(current.messages, event.message) }
          : current,
      );
      return;
    }
    if (event.type === 'artifacts.attached') {
      const attached = new Map(event.artifacts.map((artifact) => [artifact.id, artifact]));
      if (activeIdRef.current === conversationId) {
        setPendingArtifactIds((current) => current.filter((id) => !attached.has(id)));
      }
      setActiveConversation((current) => current?.id === conversationId ? {
        ...current,
        artifacts: current.artifacts.map((artifact) => attached.get(artifact.id) ?? artifact),
      } : current);
      return;
    }
    if (event.type === 'artifacts.delivery') {
      setArtifactDeliveriesByConversation((current) => ({
        ...current,
        [conversationId]: upsertArtifactDelivery(current[conversationId] ?? [], event.delivery),
      }));
      return;
    }
    if (event.type === 'run.started') {
      setConversationRunStatus(conversationId, event.agentId ? `${event.agentId} 응답 준비 중` : '응답을 준비하는 중');
      return;
    }
    if (event.type === 'run.status') {
      setConversationRunStatus(conversationId, event.agentId ? `${event.agentId} · ${event.status}` : event.status);
      return;
    }
    if (event.type === 'content.delta') {
      setConversationRunStatus(conversationId, event.authorId ? `${event.authorId} 응답 작성 중` : '응답 작성 중');
      setActiveConversation((current) => {
        if (!current || current.id !== conversationId) return current;
        const existing = current.messages.find((message) => message.id === event.messageId);
        const updatedAt = new Date().toISOString();
        const next: MessageRecord = existing
          ? { ...existing, content: existing.content + event.delta, state: 'streaming', updatedAt }
          : {
              id: event.messageId,
              conversationId,
              role: 'assistant',
              authorId: event.authorId ?? current.agentId,
              content: event.delta,
              state: 'streaming',
              parentMessageId: current.messages.at(-1)?.id ?? null,
              createdAt: updatedAt,
              updatedAt,
            };
        return { ...current, messages: upsertMessage(current.messages, next) };
      });
      return;
    }
    if (event.type === 'run.completed') {
      setActiveConversation((current) =>
        current?.id === conversationId
          ? { ...current, messages: upsertMessage(current.messages, event.message) }
          : current,
      );
      return;
    }
    if (event.type === 'artifact.created') {
      setActiveConversation((current) =>
        current?.id === conversationId
          ? { ...current, artifacts: [...current.artifacts, event.artifact] }
          : current,
      );
      return;
    }
    if (event.type === 'run.failed') {
      if (activeIdRef.current === conversationId) {
        setError(`${event.agentId ? `${event.agentId}: ` : ''}${event.error}`);
      }
      setConversationRunStatus(conversationId, null);
    }
  }, [setConversationRunStatus]);

  const ingestActiveStreamEvent = useCallback((event: StreamEvent) => {
    const conversationId = activeIdRef.current;
    if (conversationId) handleStreamEvent(conversationId, event);
  }, [handleStreamEvent]);

  const approvePending = useCallback(async () => {
    const conversationId = activeIdRef.current;
    const approval = operatingContext?.pendingApproval;
    if (!conversationId || !approval || approval.state !== 'pending' || approvingApproval) return false;
    setApprovingApproval(true);
    setError(null);
    try {
      const result = await approveConversationApi(conversationId);
      if (activeIdRef.current === conversationId) setOperatingContext(result.operatingContext);
      setConversationRunStatus(conversationId, '승인이 확인되어 실행을 계속합니다.');
      return true;
    } catch (reason) {
      if (activeIdRef.current === conversationId) {
        setError(reason instanceof Error ? reason.message : '승인 상태를 재검증하지 못했습니다.');
      }
      return false;
    } finally {
      setApprovingApproval(false);
    }
  }, [approvingApproval, operatingContext, setConversationRunStatus]);

  const sendMessage = useCallback(async (
    content: string,
    targetAgentIds: string[] = [],
    workflowMode: 'chat' | 'federated' = 'chat',
  ) => {
    const trimmed = content.trim();
    if (!trimmed || selectedStatus !== 'active') return;
    if (isStreaming) {
      if (trimmed === '승인' && operatingContext?.pendingApproval?.state === 'pending') {
        await approvePending();
      }
      return;
    }
    let conversation = activeConversation;
    if (!conversation) conversation = workflowMode === 'federated'
      ? await createFederatedConversation()
      : await createConversation();
    if (streamControllersRef.current.has(conversation.id)) return;

    const clientMessageId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const optimistic: MessageRecord = {
      id: clientMessageId,
      conversationId: conversation.id,
      role: 'user',
      authorId: 'tei',
      content: trimmed,
      state: 'complete',
      parentMessageId: conversation.messages.at(-1)?.id ?? null,
      createdAt,
      updatedAt: createdAt,
    };
    setActiveConversation((current) =>
      current?.id === conversation.id
        ? { ...current, draft: '', messages: upsertMessage(current.messages, optimistic) }
        : current,
    );
    setStreamingConversationIds((current) => {
      const next = new Set(current);
      next.add(conversation.id);
      return next;
    });
    setConversationRunStatus(
      conversation.id,
      workflowMode === 'federated' ? '교차 시스템 실행 계획을 만드는 중' : '메시지 전송 중',
    );
    setError(null);
    const controller = new AbortController();
    streamControllersRef.current.set(conversation.id, controller);
    const ingestCurrentStreamEvent = (event: StreamEvent) => {
      if (streamControllersRef.current.get(conversation.id) !== controller) return;
      handleStreamEvent(conversation.id, event);
    };
    try {
      await streamMessage(
        conversation.id,
        {
          content: trimmed,
          clientMessageId,
          parentMessageId: optimistic.parentMessageId,
          artifactIds: pendingArtifactIds,
          targetAgentIds,
          workflowMode,
          idempotencyKey: workflowMode === 'federated'
            ? `federated:${clientMessageId}`
            : `direct:${clientMessageId}`,
        },
        ingestCurrentStreamEvent,
        controller.signal,
      );
    } catch (reason) {
      if (
        !controller.signal.aborted
        && streamControllersRef.current.get(conversation.id) === controller
        && activeIdRef.current === conversation.id
      ) {
        setError(reason instanceof Error ? reason.message : '응답 스트림이 중단됐습니다.');
      }
    } finally {
      try {
        const [detail, context] = await Promise.all([
          getConversation(conversation.id),
          getConversationOperatingContext(conversation.id),
        ]);
        setConversations((current) => current.map((item) => item.id === detail.id ? detail : item));
        if (
          streamControllersRef.current.get(conversation.id) === controller
          && activeIdRef.current === conversation.id
        ) {
          setOperatingContext(context);
          applyDetail(detail);
        }
      } catch {
        // Keep the optimistic transcript visible when the refresh fails.
      } finally {
        if (streamControllersRef.current.get(conversation.id) === controller) {
          streamControllersRef.current.delete(conversation.id);
          setStreamingConversationIds((current) => {
            const next = new Set(current);
            next.delete(conversation.id);
            return next;
          });
          setConversationRunStatus(conversation.id, null);
        }
      }
    }
  }, [activeConversation, applyDetail, approvePending, createConversation, createFederatedConversation, handleStreamEvent, isStreaming, operatingContext, pendingArtifactIds, selectedStatus, setConversationRunStatus]);

  const stopStreaming = useCallback(() => {
    const conversationId = activeIdRef.current;
    if (!conversationId) return;
    // Explicit Stop is the only in-app action that aborts a Conversation run.
    streamControllersRef.current.get(conversationId)?.abort();
  }, []);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return [];
    let conversation = activeConversation;
    if (!conversation) conversation = await createConversation();
    const uploaded: ArtifactRecord[] = [];
    for (const file of files) {
      const localId = crypto.randomUUID();
      setUploads((current) => [...current, { localId, filename: file.name, progress: 0, state: 'uploading' }]);
      try {
        const artifact = await uploadArtifact(conversation.id, file, (progress) => {
          setUploads((current) => current.map((item) => item.localId === localId ? { ...item, progress } : item));
        });
        uploaded.push(artifact);
        setPendingArtifactIds((current) => [...current, artifact.id]);
        setUploads((current) => current.map((item) =>
          item.localId === localId ? { ...item, progress: 100, state: 'complete', artifactId: artifact.id } : item,
        ));
        setActiveConversation((current) =>
          current?.id === conversation.id ? { ...current, artifacts: [...current.artifacts, artifact] } : current,
        );
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : '업로드 실패';
        setUploads((current) => current.map((item) =>
          item.localId === localId ? { ...item, state: 'failed', error: message } : item,
        ));
        setError(message);
      }
    }
    return uploaded;
  }, [activeConversation, createConversation]);

  return {
    selectedSystem,
    selectedStatus,
    activeAgent,
    conversations,
    activeConversation,
    operatingContext,
    searchResults,
    searching,
    uploads,
    pendingArtifactIds,
    artifactDeliveries,
    transcripts,
    loading,
    error,
    runStatus,
    isStreaming,
    approvingApproval,
    switchSystem,
    switchStatus,
    selectConversation,
    createConversation,
    createFederatedConversation,
    openAgentConversation,
    branchConversation,
    patchConversation,
    deletePermanently,
    saveDraft,
    searchConversations,
    sendMessage,
    approvePending,
    stopStreaming,
    uploadFiles,
    ingestStreamEvent: ingestActiveStreamEvent,
    clearSearch: () => setSearchResults([]),
    clearError: () => setError(null),
  };
}
