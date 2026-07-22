import { useEffect, useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import type { AgentRecord } from '../shared/contracts';
import AppSidebar from './AppSidebar';
import ChatHeader from './ChatHeader';
import ConversationComposer from './ConversationComposer';
import FederationPanel from './FederationPanel';
import MessageStream from './MessageStream';
import { retryAssistantResponse } from './retry-api';
import TeamPanel from './TeamPanel';
import { useChat } from './useChat';
import { useCollaboration } from './useCollaboration';
import { useFederation } from './useFederation';

function App() {
  const chat = useChat();
  const collaboration = useCollaboration(
    chat.selectedSystem,
    chat.activeConversation?.id ?? null,
    chat.activeConversation?.agentId ?? chat.activeAgent,
  );
  const federation = useFederation(chat.activeConversation?.id ?? null);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [teamPanelOpen, setTeamPanelOpen] = useState(false);
  const [federationPanelOpen, setFederationPanelOpen] = useState(false);
  const [federatedTargets, setFederatedTargets] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [retryingMessageId, setRetryingMessageId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamEndRef = useRef<HTMLDivElement>(null);
  const retryAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    chat.searchConversations(search);
  }, [chat.searchConversations, search]);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ block: 'end' });
  }, [chat.activeConversation?.messages, chat.runStatus, retryingMessageId]);

  useEffect(() => {
    setFederatedTargets([]);
    retryAbortRef.current?.abort();
    retryAbortRef.current = null;
    setRetryingMessageId(null);
    setRetryError(null);
  }, [chat.activeConversation?.id]);

  useEffect(() => () => retryAbortRef.current?.abort(), []);

  const handleFiles = async (files: File[]) => {
    if (!files.length || chat.selectedStatus !== 'active' || retryingMessageId) return;
    try {
      await chat.uploadFiles(files);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const openAgent = async (agent: AgentRecord) => {
    setSearch('');
    setMobileDrawerOpen(false);
    setTeamPanelOpen(false);
    setFederationPanelOpen(false);
    await chat.openAgentConversation(agent.systemId, agent.id);
  };

  const createFederated = async () => {
    await chat.createFederatedConversation();
    setMobileDrawerOpen(false);
    setFederationPanelOpen(true);
  };

  const retryResponse = async (messageId: string, mode: 'retry' | 'regenerate') => {
    const conversationId = chat.activeConversation?.id;
    if (!conversationId || retryingMessageId || chat.isStreaming || federation.active) return;
    const controller = new AbortController();
    retryAbortRef.current = controller;
    setRetryingMessageId(messageId);
    setRetryError(null);
    try {
      await retryAssistantResponse(
        messageId,
        mode,
        `retry:${messageId}:${crypto.randomUUID()}`,
        chat.ingestStreamEvent,
        controller.signal,
      );
    } catch (reason) {
      if (!controller.signal.aborted) {
        setRetryError(reason instanceof Error ? reason.message : '응답을 다시 실행하지 못했습니다.');
      }
    } finally {
      retryAbortRef.current = null;
      setRetryingMessageId(null);
      try {
        await chat.selectConversation(conversationId);
      } catch {
        // Keep streamed messages visible when the refresh fails.
      }
    }
  };

  const error = retryError ?? chat.error ?? collaboration.error ?? federation.error;
  const retryBusy = Boolean(retryingMessageId);

  return (
    <div className="page-shell">
      <main className={`app-frame ${dragActive ? 'is-dragging' : ''}`}>
        <AppSidebar
          chat={chat}
          agents={collaboration.agents}
          search={search}
          setSearch={setSearch}
          mobileOpen={mobileDrawerOpen}
          setMobileOpen={setMobileDrawerOpen}
          onOpenAgent={(agent) => void openAgent(agent)}
          onCreateFederated={() => void createFederated()}
        />

        <section
          className="chat-column"
          onDragEnter={(event) => { event.preventDefault(); if (chat.selectedStatus === 'active' && !retryBusy) setDragActive(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { if (event.currentTarget === event.target) setDragActive(false); }}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            void handleFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <ChatHeader
            chat={chat}
            collaboration={collaboration}
            federation={federation}
            onMobileMenu={() => setMobileDrawerOpen(true)}
            onOpenTeam={() => setTeamPanelOpen(true)}
            onOpenFederation={() => setFederationPanelOpen(true)}
          />

          {error && (
            <div className="error-banner">
              <span>{error}</span>
              <button onClick={() => { setRetryError(null); chat.clearError(); collaboration.clearError(); federation.clearError(); }}><X size={15} /></button>
            </div>
          )}

          <MessageStream
            conversation={chat.activeConversation}
            selectedSystem={chat.selectedSystem}
            loading={chat.loading}
            runStatus={retryBusy ? '기존 응답을 보존하고 새 응답을 생성하는 중' : chat.runStatus}
            artifactDeliveries={chat.artifactDeliveries}
            streamEndRef={streamEndRef}
            onCreate={() => void chat.createConversation()}
            onBranch={(messageId) => void chat.branchConversation(messageId)}
            onRetry={(messageId, mode) => void retryResponse(messageId, mode)}
            retryEnabled={!federation.active && !chat.isStreaming && chat.selectedStatus === 'active'}
            retryingMessageId={retryingMessageId}
          />

          <ConversationComposer
            chat={chat}
            collaboration={collaboration}
            federation={federation}
            targets={federatedTargets}
            setTargets={setFederatedTargets}
            fileInputRef={fileInputRef}
            onFiles={(files) => void handleFiles(files)}
            externalBusy={retryBusy}
          />

          {dragActive && <div className="drop-overlay"><Upload size={28} /><strong>파일을 여기에 놓으세요</strong></div>}
        </section>

        {teamPanelOpen && chat.selectedSystem === 'hermes' && (
          <TeamPanel
            agents={collaboration.systemAgents}
            participants={collaboration.participants}
            activities={collaboration.activities}
            routing={collaboration.routing}
            saving={collaboration.saving}
            onToggleParticipant={(agentId, enabled) => void collaboration.setParticipantEnabled(agentId, enabled)}
            onOpenDirect={(agent) => void openAgent(agent)}
            onClose={() => setTeamPanelOpen(false)}
          />
        )}

        {federationPanelOpen && chat.activeConversation && (
          <FederationPanel
            agents={collaboration.agents}
            config={federation.config}
            capsules={federation.capsules}
            runs={federation.runs}
            selectedRun={federation.selectedRun}
            events={federation.events}
            saving={federation.saving}
            resuming={federation.resuming}
            onEnable={() => void federation.enable()}
            onDisable={() => void federation.disable()}
            onCreateCapsule={(input) => void federation.createCapsule(input)}
            onSetCapsuleStatus={(capsuleId, status) => void federation.setCapsuleStatus(capsuleId, status)}
            onSelectRun={federation.selectRun}
            onResume={(runId) => void federation.resume(runId, chat.ingestStreamEvent)}
            onRefresh={() => void federation.refresh()}
            onClose={() => setFederationPanelOpen(false)}
          />
        )}
      </main>
    </div>
  );
}

export default App;
