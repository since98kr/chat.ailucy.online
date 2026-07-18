import { useCallback, useEffect, useRef, useState } from 'react';
import type {
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
  branchConversation as branchConversationApi,
  createConversation as createConversationApi,
  getConversation,
  listConversations,
  permanentlyDeleteConversation,
  searchConversations as searchConversationsApi,
  streamMessage,
  updateConversation as updateConversationApi,
  uploadArtifact,
} from './api';

const defaultAgent: Record<SystemId, string> = {
  letta: '[Letta] Lucy',
  hermes: '[Hermes] Lucy',
};

function upsertMessage(messages: MessageRecord[], next: MessageRecord) {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index < 0) return [...messages, next];
  const copy = [...messages];
  copy[index] = next;
  return copy;
}

export function useChat() {
  const [selectedSystem, setSelectedSystem] = useState<SystemId>('hermes');
  const [selectedStatus, setSelectedStatus] = useState<ConversationStatus>('active');
  const [activeAgent, setActiveAgent] = useState(defaultAgent.hermes);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [activeConversation, setActiveConversation] = useState<ConversationDetail | null>(null);
  const [searchResults, setSearchResults] = useState<ConversationSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [uploads, setUploads] = useState<UploadProgressRecord[]>([]);
  const [pendingArtifactIds, setPendingArtifactIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const draftTimerRef = useRef<number | null>(null);
  const searchTimerRef = useRef<number | null>(null);
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeIdRef.current = activeConversation?.id ?? null;
  }, [activeConversation?.id]);

  const applyDetail = useCallback((detail: ConversationDetail) => {
    setActiveConversation(detail);
    setActiveAgent(detail.agentId);
    setPendingArtifactIds(detail.artifacts.filter((artifact) => !artifact.messageId).map((artifact) => artifact.id));
    setUploads([]);
    return detail;
  }, []);

  const loadConversation = useCallback(async (id: string) => applyDetail(await getConversation(id)), [applyDetail]);

  const refreshList = useCallback(
    async (systemId: SystemId, status: ConversationStatus, preferredId?: string | null) => {
      const list = await listConversations(systemId, status);
      setConversations(list);
      const selectedId =
        (preferredId && list.some((conversation) => conversation.id === preferredId) && preferredId) ||
        list[0]?.id;
      if (!selectedId) {
        setActiveConversation(null);
        setPendingArtifactIds([]);
        return;
      }
      await loadConversation(selectedId);
    },
    [loadConversation],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSearchResults([]);
    abortRef.current?.abort();
    listConversations(selectedSystem, selectedStatus)
      .then(async (list) => {
        if (cancelled) return;
        setConversations(list);
        const preferred = activeIdRef.current;
        const selected = list.find((conversation) => conversation.id === preferred) ?? list[0];
        if (selected) {
          const detail = await getConversation(selected.id);
          if (!cancelled) applyDetail(detail);
        } else if (!cancelled) {
          setActiveConversation(null);
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
  }, [applyDetail, selectedStatus, selectedSystem]);

  const switchSystem = useCallback((systemId: SystemId, agentId = defaultAgent[systemId]) => {
    abortRef.current?.abort();
    setSelectedStatus('active');
    setSelectedSystem(systemId);
    setActiveAgent(agentId);
  }, []);

  const switchStatus = useCallback((status: ConversationStatus) => {
    abortRef.current?.abort();
    setSelectedStatus(status);
  }, []);

  const selectConversation = useCallback(async (id: string) => {
    abortRef.current?.abort();
    setLoading(true);
    setError(null);
    try {
      await loadConversation(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '대화를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [loadConversation]);

  const createConversation = useCallback(async () => {
    setError(null);
    setSelectedStatus('active');
    const detail = await createConversationApi({
      systemId: selectedSystem,
      agentId: activeAgent || defaultAgent[selectedSystem],
    });
    setConversations((current) => [detail, ...current]);
    applyDetail(detail);
    return detail;
  }, [activeAgent, applyDetail, selectedSystem]);

  const branchConversation = useCallback(async (fromMessageId?: string | null) => {
    if (!activeIdRef.current) return null;
    const detail = await branchConversationApi(activeIdRef.current, { fromMessageId });
    setSelectedSystem(detail.systemId);
    setSelectedStatus('active');
    setConversations((current) => [detail, ...current.filter((item) => item.id !== detail.id)]);
    applyDetail(detail);
    return detail;
  }, [applyDetail]);

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

  const handleStreamEvent = useCallback((event: StreamEvent) => {
    if (event.type === 'message.accepted') {
      setActiveConversation((current) =>
        current ? { ...current, messages: upsertMessage(current.messages, event.message) } : current,
      );
      return;
    }
    if (event.type === 'artifacts.attached') {
      const attached = new Map(event.artifacts.map((artifact) => [artifact.id, artifact]));
      setPendingArtifactIds((current) => current.filter((id) => !attached.has(id)));
      setActiveConversation((current) => current ? {
        ...current,
        artifacts: current.artifacts.map((artifact) => attached.get(artifact.id) ?? artifact),
      } : current);
      return;
    }
    if (event.type === 'run.started') {
      setRunStatus('응답을 준비하는 중');
      return;
    }
    if (event.type === 'run.status') {
      setRunStatus(event.status);
      return;
    }
    if (event.type === 'content.delta') {
      setRunStatus('응답 작성 중');
      setActiveConversation((current) => {
        if (!current) return current;
        const existing = current.messages.find((message) => message.id === event.messageId);
        const timestamp = new Date().toISOString();
        const next: MessageRecord = existing
          ? { ...existing, content: existing.content + event.delta, state: 'streaming', updatedAt: timestamp }
          : {
              id: event.messageId,
              conversationId: current.id,
              role: 'assistant',
              authorId: current.agentId,
              content: event.delta,
              state: 'streaming',
              parentMessageId: current.messages.at(-1)?.id ?? null,
              createdAt: timestamp,
              updatedAt: timestamp,
            };
        return { ...current, messages: upsertMessage(current.messages, next) };
      });
      return;
    }
    if (event.type === 'run.completed') {
      setActiveConversation((current) =>
        current ? { ...current, messages: upsertMessage(current.messages, event.message) } : current,
      );
      setRunStatus(null);
      return;
    }
    if (event.type === 'artifact.created') {
      setActiveConversation((current) =>
        current ? { ...current, artifacts: [...current.artifacts, event.artifact] } : current,
      );
      return;
    }
    if (event.type === 'run.failed') {
      setError(event.error);
      setRunStatus(null);
    }
  }, []);

  const sendMessage = useCallback(async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || isStreaming || selectedStatus !== 'active') return;
    let conversation = activeConversation;
    if (!conversation) conversation = await createConversation();
    const clientMessageId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const optimistic: MessageRecord = {
      id: clientMessageId,
      conversationId: conversation.id,
      role: 'user',
      authorId: 'tei',
      content: trimmed,
      state: 'complete',
      parentMessageId: conversation.messages.at(-1)?.id ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    setActiveConversation((current) =>
      current ? { ...current, draft: '', messages: upsertMessage(current.messages, optimistic) } : current,
    );
    setIsStreaming(true);
    setRunStatus('메시지 전송 중');
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamMessage(
        conversation.id,
        {
          content: trimmed,
          clientMessageId,
          parentMessageId: optimistic.parentMessageId,
          artifactIds: pendingArtifactIds,
        },
        handleStreamEvent,
        controller.signal,
      );
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : '응답 스트림이 중단됐습니다.');
      }
    } finally {
      setIsStreaming(false);
      setRunStatus(null);
      abortRef.current = null;
      try {
        await refreshList(selectedSystem, 'active', conversation.id);
      } catch {
        // Keep the optimistic transcript visible when a refresh fails.
      }
    }
  }, [activeConversation, createConversation, handleStreamEvent, isStreaming, pendingArtifactIds, refreshList, selectedStatus, selectedSystem]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
    setRunStatus(null);
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
          current ? { ...current, artifacts: [...current.artifacts, artifact] } : current,
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
    searchResults,
    searching,
    uploads,
    pendingArtifactIds,
    loading,
    error,
    runStatus,
    isStreaming,
    switchSystem,
    switchStatus,
    selectConversation,
    createConversation,
    branchConversation,
    patchConversation,
    deletePermanently,
    saveDraft,
    searchConversations,
    sendMessage,
    stopStreaming,
    uploadFiles,
    clearSearch: () => setSearchResults([]),
    clearError: () => setError(null),
  };
}
