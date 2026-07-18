import { useEffect, useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import type { AgentRecord } from '../shared/contracts';
import AppSidebar from './AppSidebar';
import ChatHeader from './ChatHeader';
import ConversationComposer from './ConversationComposer';
import FederationPanel from './FederationPanel';
import MessageStream from './MessageStream';
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chat.searchConversations(search);
  }, [chat.searchConversations, search]);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ block: 'end' });
  }, [chat.activeConversation?.messages, chat.runStatus]);

  useEffect(() => {
    setFederatedTargets([]);
  }, [chat.activeConversation?.id]);

  const handleFiles = async (files: File[]) => {
    if (!files.length || chat.selectedStatus !== 'active') return;
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

  const error = chat.error ?? collaboration.error ?? federation.error;

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
          onDragEnter={(event) => { event.preventDefault(); if (chat.selectedStatus === 'active') setDragActive(true); }}
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
              <button onClick={() => { chat.clearError(); collaboration.clearError(); federation.clearError(); }}><X size={15} /></button>
            </div>
          )}

          <MessageStream
            conversation={chat.activeConversation}
            selectedSystem={chat.selectedSystem}
            loading={chat.loading}
            runStatus={chat.runStatus}
            streamEndRef={streamEndRef}
            onCreate={() => void chat.createConversation()}
            onBranch={(messageId) => void chat.branchConversation(messageId)}
          />

          <ConversationComposer
            chat={chat}
            collaboration={collaboration}
            federation={federation}
            targets={federatedTargets}
            setTargets={setFederatedTargets}
            fileInputRef={fileInputRef}
            onFiles={(files) => void handleFiles(files)}
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
