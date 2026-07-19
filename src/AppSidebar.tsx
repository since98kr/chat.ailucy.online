import { Archive, Bot, ChevronDown, GitMerge, LoaderCircle, Plus, Search, Settings, Sparkles, Trash2, X } from 'lucide-react';
import type { AgentRecord, ConversationRecord, ConversationStatus, SystemId } from '../shared/contracts';
import type { useChat } from './useChat';

type ChatController = ReturnType<typeof useChat>;

export default function AppSidebar({
  chat,
  agents,
  search,
  setSearch,
  mobileOpen,
  setMobileOpen,
  onOpenAgent,
  onCreateFederated,
}: {
  chat: ChatController;
  agents: AgentRecord[];
  search: string;
  setSearch: (value: string) => void;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
  onOpenAgent: (agent: AgentRecord) => void;
  onCreateFederated: () => void;
}) {
  const conversations = search.trim()
    ? chat.searchResults.map((result) => ({ ...result.conversation, preview: result.snippet }))
    : chat.conversations;
  const lettaAgents = agents.filter((agent) => agent.systemId === 'letta');
  const hermesAgents = agents.filter((agent) => agent.systemId === 'hermes');

  const select = (id: string) => {
    void chat.selectConversation(id);
    setMobileOpen(false);
  };

  const createConversation = () => {
    setMobileOpen(false);
    void chat.createConversation();
  };

  return (
    <>
      <aside className={`sidebar ${mobileOpen ? 'sidebar--open' : ''}`}>
        <div className="sidebar__mobile-head">
          <strong>시스템과 대화</strong>
          <button className="icon-button" onClick={() => setMobileOpen(false)} aria-label="메뉴 닫기"><X size={18} /></button>
        </div>

        <div className="brand-row">
          <div className="brand-mark"><Sparkles size={18} /></div>
          <div><strong>ailucy.online</strong><span>V2</span></div>
        </div>

        <section className="sidebar-section systems-section">
          <div className="section-title-row">
            <span>SYSTEMS</span>
            <button className="icon-button" aria-label="시스템 설정"><Settings size={15} /></button>
          </div>
          <SystemCard id="letta" label="Letta" accent="blue" agents={lettaAgents} selectedSystem={chat.selectedSystem} activeAgent={chat.activeAgent} onSelect={onOpenAgent} />
          <SystemCard id="hermes" label="Hermes" accent="violet" agents={hermesAgents} selectedSystem={chat.selectedSystem} activeAgent={chat.activeAgent} onSelect={onOpenAgent} />
        </section>

        <section className="sidebar-section conversations-section">
          <div className="section-title-row conversations-title">
            <span>{statusLabel(chat.selectedStatus)}</span>
            <span className="conversation-create-actions">
              <button className="icon-button" onClick={createConversation} aria-label="새 대화" disabled={chat.selectedStatus !== 'active'}><Plus size={16} /></button>
              <button className="icon-button" onClick={onCreateFederated} aria-label="새 교차 시스템 대화" disabled={chat.selectedStatus !== 'active'}><GitMerge size={15} /></button>
            </span>
          </div>
          <label className="conversation-search">
            {chat.searching ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="제목·본문·파일 검색" />
            {search && <button onClick={() => setSearch('')} aria-label="검색 초기화"><X size={13} /></button>}
          </label>

          {chat.loading ? (
            <div className="sidebar-loading"><LoaderCircle size={18} className="spin" /> 불러오는 중</div>
          ) : chat.selectedStatus === 'active' ? (
            <>
              <ConversationGroup title={search ? '검색 결과 · 고정' : '고정됨'} conversations={conversations.filter((item) => item.pinned)} activeId={chat.activeConversation?.id ?? null} onSelect={select} />
              <ConversationGroup title={search ? '검색 결과' : '최근'} conversations={conversations.filter((item) => !item.pinned)} activeId={chat.activeConversation?.id ?? null} onSelect={select} />
            </>
          ) : (
            <ConversationGroup title={chat.selectedStatus === 'archived' ? '보관된 대화' : '삭제 대기'} conversations={conversations} activeId={chat.activeConversation?.id ?? null} onSelect={select} />
          )}
          {!chat.loading && conversations.length === 0 && <div className="empty-sidebar">{search ? '검색 결과가 없습니다.' : '표시할 Conversation이 없습니다.'}</div>}
        </section>

        <div className="sidebar-footer sidebar-footer--three">
          <button className={chat.selectedStatus === 'active' ? 'is-active' : ''} onClick={() => { chat.switchStatus('active'); setSearch(''); }}><Bot size={15} /> 활성</button>
          <button className={chat.selectedStatus === 'archived' ? 'is-active' : ''} onClick={() => { chat.switchStatus('archived'); setSearch(''); }}><Archive size={15} /> 보관함</button>
          <button className={chat.selectedStatus === 'trashed' ? 'is-active' : ''} onClick={() => { chat.switchStatus('trashed'); setSearch(''); }}><Trash2 size={15} /> 휴지통</button>
        </div>
      </aside>
      {mobileOpen && <button className="drawer-scrim" onClick={() => setMobileOpen(false)} />}
    </>
  );
}

function SystemCard({ id, label, accent, agents, selectedSystem, activeAgent, onSelect }: {
  id: SystemId;
  label: string;
  accent: 'blue' | 'violet';
  agents: AgentRecord[];
  selectedSystem: SystemId;
  activeAgent: string;
  onSelect: (agent: AgentRecord) => void;
}) {
  const lead = agents.find((agent) => agent.isLead) ?? agents[0];
  return (
    <div className={`system-card system-card--${accent} ${selectedSystem === id ? 'is-selected' : ''}`}>
      <button className="system-card__header" onClick={() => lead && onSelect(lead)} disabled={!lead}>
        <span className="system-card__icon">{id === 'letta' ? <Sparkles size={16} /> : <Bot size={17} />}</span>
        <span><strong>{label}</strong><small>{id === 'letta' ? 'Memory-first system' : 'Collaborative system'}</small></span>
        <ChevronDown size={15} />
      </button>
      <div className="agent-list">
        {agents.map((agent) => (
          <button key={agent.id} className={`agent-row ${selectedSystem === id && activeAgent === agent.id ? 'is-active' : ''}`} onClick={() => agent.enabled && agent.directChatEnabled && onSelect(agent)} disabled={!agent.enabled || !agent.directChatEnabled} title={`${agent.role} · ${agent.capabilities.join(', ')}`}>
            <span className="mini-avatar">{agent.id === '[Letta] Lucy' ? <Sparkles size={13} /> : <Bot size={14} />}</span>
            <span className="agent-row__name">{agent.displayName}</span>
            {agent.systemId === 'letta' ? <em>Personal</em> : agent.isLead ? <em>Lead</em> : <span className="presence presence--active" />}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConversationGroup({ title, conversations, activeId, onSelect }: {
  title: string;
  conversations: ConversationRecord[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  if (!conversations.length) return null;
  return (
    <div className="conversation-group">
      <h3>{title}</h3>
      {conversations.map((conversation) => (
        <button key={conversation.id} className={`conversation-row ${activeId === conversation.id ? 'is-active' : ''}`} onClick={() => onSelect(conversation.id)}>
          <span className="conversation-row__content">
            <strong>{conversation.title}</strong>
            <small>{conversation.agentId !== '[Hermes] Lucy' && conversation.systemId === 'hermes' ? `${conversation.agentId} · ` : ''}{conversation.preview || '아직 메시지가 없습니다.'}</small>
          </span>
          <time>{formatRelative(conversation.updatedAt)}</time>
        </button>
      ))}
    </div>
  );
}

function statusLabel(status: ConversationStatus) {
  if (status === 'archived') return 'ARCHIVE';
  if (status === 'trashed') return 'TRASH';
  return 'CONVERSATIONS';
}

function formatRelative(value: string) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(date);
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric' }).format(date);
}
