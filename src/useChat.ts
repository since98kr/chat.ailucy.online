import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ArtifactRecord,
  ConversationDetail,
  ConversationRecord,
  MessageRecord,
  StreamEvent,
  SystemId,
  UpdateConversationInput,
} from '../shared/contracts';
import {
  createConversation as createConversationApi,
  getConversation,
  listConversations,
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
  const [activeAgent, setActiveAgent] = useState(defaultAgent.hermes);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [activeConversation, setActiveConversation] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const draftTimerRef = useRef<number | null>(null);
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeIdRef.current = activeConversation?.id ?? null;
  }, [activeConversation?.id]);

  const loadConversation = useCallback(async (id: string) => {
    const detail = await getConversation(id);
    setActiveConversation(detail);
    setActiveAgent(detail.agentId);
    return detail;
  }, []);

  const refreshList = useCallback(async (systemId: SystemId, preferredId?: string | null) => {
    const list = await listConversations(systemId);
    setConversations(list);

    const selectedId =
      (preferredId && list.some((conversation) => conversation.id === preferredId) && preferredId) ||
      list[0]?.id;

    if (!selectedId) {
      setActiveConversation(null);
      return;
    }

    await loadConversation(selectedId);
  }, [loadConversation]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    abortRef.current?.abort();

    listConversations(selectedSystem)
      .then(async (list) => {
        if (cancelled) return;
        setConversations(list);
        const preferred = activeIdRef.current;
        const selected = list.find((conversation) => conversation.id === preferred) ?? list[0];
        if (selected) {
          const detail = await getConversation(selected.id);
          if (!cancelled) {
            setActiveConversation(detail);
            setActiveAgent(detail.agentId);
          }
        } else if (!cancelled) {
          setActiveConversation(null);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '대화를 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSystem]);

  const switchSystem = useCallback((systemId: SystemId, agentId = defaultAgent[systemId]) => {
    abortRef.current?.abort();
    setSelectedSystem(systemId);
    setActiveAgent(agentId);
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
    const detail = await createConversationApi({
      systemId: selectedSystem,
      agentId: activeAgent || defaultAgent[selectedSystem],
    });
    setConversations((current) => [detail, ...current]);
    setActiveConversation(detail);
    return detail;
  }, [activeAgent, selectedSystem]);

  const patchConversation = useCallback(async (input: UpdateConversationInput) => {
    if (!activeIdRef.current) return null;
    const detail = await updateConversationApi(activeIdRef.current, input);
    setActiveConversation(detail);
    setConversations((current) =>
      current
        .map((conversation) => (conversation.id === detail.id ? detail : conversation))
        .filter((conversation) => conversation.status === 'active')
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)),
    );
    return detail;
  }, []);

  const saveDraft = useCallback((draft: string) => {
    setActiveConversation((current) => (current ? { ...current, draft } : current));
    if (draftTimerRef.current) window.clearTimeout(draftTimerRef.current);
    const conversationId = activeIdRef.current;
    if (!conversationId) return;
    draftTimerRef.current = window.setTimeout(() => {
      updateConversationApi(conversationId, { draft }).catch(() => undefined);
    }, 500);
  }, []);

  const handleStreamEvent = useCallback((event: StreamEvent) => {
    if (event.type === 'message.accepted') {
      setActiveConversation((current) =>
        current ? { ...current, messages: upsertMessage(current.messages, event.message) } : current,
      );
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
    if (!trimmed || isStreaming) return;

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
        await refreshList(selectedSystem, conversation.id);
      } catch {
        // The optimistic transcript remains available even when refresh fails.
      }
    }
  }, [activeConversation, createConversation, handleStreamEvent, isStreaming, refreshList, selectedSystem]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
    setRunStatus(null);
  }, []);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!activeIdRef.current || files.length === 0) return [];
    const uploaded: ArtifactRecord[] = [];
    for (const file of files) {
      const artifact = await uploadArtifact(activeIdRef.current, file);
      uploaded.push(artifact);
      setActiveConversation((current) =>
        current ? { ...current, artifacts: [...current.artifacts, artifact] } : current,
      );
    }
    return uploaded;
  }, []);

  return {
    selectedSystem,
    activeAgent,
    conversations,
    activeConversation,
    loading,
    error,
    runStatus,
    isStreaming,
    switchSystem,
    selectConversation,
    createConversation,
    patchConversation,
    saveDraft,
    sendMessage,
    stopStreaming,
    uploadFiles,
    clearError: () => setError(null),
  };
}
