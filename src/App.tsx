import { FormEvent, useMemo, useState } from 'react';
import {
  Archive,
  Bot,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Image,
  Menu,
  MessageSquarePlus,
  Mic,
  MoreHorizontal,
  Paperclip,
  Pin,
  Plus,
  Search,
  Send,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';

type SystemId = 'letta' | 'hermes';
type ConversationStatus = 'active' | 'archived' | 'trashed';

type Conversation = {
  id: string;
  system: SystemId;
  agent: string;
  title: string;
  preview: string;
  updatedAt: string;
  pinned: boolean;
  status: ConversationStatus;
};

const initialConversations: Conversation[] = [
  {
    id: 'chat-v2',
    system: 'hermes',
    agent: '[Hermes] Lucy',
    title: 'Chat V2 개발',
    preview: 'Conversation 중심 UI와 파일 UX 확정',
    updatedAt: '방금',
    pinned: true,
    status: 'active',
  },
  {
    id: 'hermes-v2',
    system: 'hermes',
    agent: '[Hermes] Lucy',
    title: 'Hermes V2 구축',
    preview: 'Lucy와 subagent 협업 구조',
    updatedAt: '10:18',
    pinned: true,
    status: 'active',
  },
  {
    id: 'trade',
    system: 'hermes',
    agent: '[Hermes] Lucy',
    title: 'Trade 운영 안정화',
    preview: 'Dispatcher 검증과 다음 작업',
    updatedAt: '어제',
    pinned: true,
    status: 'active',
  },
  {
    id: 'drone-report',
    system: 'hermes',
    agent: 'Gemma',
    title: '액화수소 드론 보고서',
    preview: '장기체공 활용 사례와 시장 기회',
    updatedAt: '금요일',
    pinned: false,
    status: 'active',
  },
  {
    id: 'weekly',
    system: 'letta',
    agent: '[Letta] Lucy',
    title: '이번 주 업무 정리',
    preview: '중요 의사결정과 다음 일정',
    updatedAt: '어제',
    pinned: true,
    status: 'active',
  },
  {
    id: 'study',
    system: 'letta',
    agent: '[Letta] Lucy',
    title: '미국 유학 준비',
    preview: '지원 일정과 영어 점수 계획',
    updatedAt: '7월 15일',
    pinned: false,
    status: 'active',
  },
];

const agents = {
  letta: [{ name: '[Letta] Lucy', role: 'Personal', active: true }],
  hermes: [
    { name: '[Hermes] Lucy', role: 'Lead', active: true },
    { name: 'Xixi', role: 'Implementation', active: true },
    { name: 'Lynn', role: 'Review', active: false },
    { name: 'Gemma', role: 'Multimodal', active: true },
  ],
} satisfies Record<SystemId, Array<{ name: string; role: string; active: boolean }>>;

function App() {
  const [selectedSystem, setSelectedSystem] = useState<SystemId>('hermes');
  const [activeAgent, setActiveAgent] = useState('[Hermes] Lucy');
  const [conversations, setConversations] = useState(initialConversations);
  const [activeConversationId, setActiveConversationId] = useState('chat-v2');
  const [composer, setComposer] = useState('');
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [teamPanelOpen, setTeamPanelOpen] = useState(false);

  const visibleConversations = useMemo(
    () =>
      conversations.filter(
        (conversation) =>
          conversation.system === selectedSystem && conversation.status === 'active',
      ),
    [conversations, selectedSystem],
  );

  const activeConversation =
    conversations.find((conversation) => conversation.id === activeConversationId) ??
    visibleConversations[0];

  const switchSystem = (system: SystemId, agentName: string) => {
    setSelectedSystem(system);
    setActiveAgent(agentName);
    const nextConversation = conversations.find(
      (conversation) => conversation.system === system && conversation.status === 'active',
    );
    if (nextConversation) setActiveConversationId(nextConversation.id);
  };

  const createConversation = () => {
    const id = `conversation-${Date.now()}`;
    const newConversation: Conversation = {
      id,
      system: selectedSystem,
      agent: activeAgent,
      title: '새 대화',
      preview: '첫 메시지를 입력해 제목을 생성하세요.',
      updatedAt: '방금',
      pinned: false,
      status: 'active',
    };
    setConversations((current) => [newConversation, ...current]);
    setActiveConversationId(id);
    setMobileDrawerOpen(false);
  };

  const updateConversation = (
    id: string,
    update: Partial<Pick<Conversation, 'title' | 'pinned' | 'status'>>,
  ) => {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === id ? { ...conversation, ...update } : conversation,
      ),
    );
  };

  const renameConversation = () => {
    if (!activeConversation) return;
    const nextTitle = window.prompt('대화 이름을 입력하세요.', activeConversation.title)?.trim();
    if (nextTitle) updateConversation(activeConversation.id, { title: nextTitle });
  };

  const archiveConversation = () => {
    if (!activeConversation) return;
    updateConversation(activeConversation.id, { status: 'archived' });
    const next = visibleConversations.find(
      (conversation) => conversation.id !== activeConversation.id,
    );
    if (next) setActiveConversationId(next.id);
  };

  const trashConversation = () => {
    if (!activeConversation) return;
    updateConversation(activeConversation.id, { status: 'trashed' });
    const next = visibleConversations.find(
      (conversation) => conversation.id !== activeConversation.id,
    );
    if (next) setActiveConversationId(next.id);
  };

  const submitMessage = (event: FormEvent) => {
    event.preventDefault();
    const message = composer.trim();
    if (!message || !activeConversation) return;

    setComposer('');
    updateConversation(activeConversation.id, {
      title: activeConversation.title === '새 대화' ? message.slice(0, 24) : activeConversation.title,
    });
  };

  return (
    <div className="page-shell">
      <main className="app-frame">
        <aside className={`sidebar ${mobileDrawerOpen ? 'sidebar--open' : ''}`}>
          <div className="sidebar__mobile-head">
            <strong>시스템과 대화</strong>
            <button className="icon-button" onClick={() => setMobileDrawerOpen(false)}>
              <X size={18} />
            </button>
          </div>

          <div className="brand-row">
            <div className="brand-mark"><Sparkles size={18} /></div>
            <div>
              <strong>ailucy.online</strong>
              <span>V2</span>
            </div>
          </div>

          <section className="sidebar-section systems-section">
            <div className="section-title-row">
              <span>SYSTEMS</span>
              <button className="icon-button" aria-label="시스템 설정"><Settings size={15} /></button>
            </div>

            <SystemCard
              id="letta"
              label="Letta"
              accent="blue"
              selectedSystem={selectedSystem}
              activeAgent={activeAgent}
              onSelect={switchSystem}
            />
            <SystemCard
              id="hermes"
              label="Hermes"
              accent="violet"
              selectedSystem={selectedSystem}
              activeAgent={activeAgent}
              onSelect={switchSystem}
            />
          </section>

          <section className="sidebar-section conversations-section">
            <div className="section-title-row conversations-title">
              <span>CONVERSATIONS</span>
              <div>
                <button className="icon-button" aria-label="대화 검색"><Search size={15} /></button>
                <button className="icon-button" onClick={createConversation} aria-label="새 대화">
                  <Plus size={16} />
                </button>
              </div>
            </div>

            <ConversationGroup
              title="고정됨"
              conversations={visibleConversations.filter((conversation) => conversation.pinned)}
              activeConversationId={activeConversationId}
              onSelect={(id) => {
                setActiveConversationId(id);
                setMobileDrawerOpen(false);
              }}
            />
            <ConversationGroup
              title="최근"
              conversations={visibleConversations.filter((conversation) => !conversation.pinned)}
              activeConversationId={activeConversationId}
              onSelect={(id) => {
                setActiveConversationId(id);
                setMobileDrawerOpen(false);
              }}
            />
          </section>

          <div className="sidebar-footer">
            <button><Archive size={15} /> 보관함 <span>{conversations.filter((item) => item.status === 'archived').length}</span></button>
            <button><Trash2 size={15} /> 휴지통 <span>{conversations.filter((item) => item.status === 'trashed').length}</span></button>
          </div>
        </aside>

        {mobileDrawerOpen && <button className="drawer-scrim" onClick={() => setMobileDrawerOpen(false)} />}

        <section className="chat-column">
          <header className="chat-header">
            <div className="chat-header__identity">
              <button className="icon-button mobile-menu" onClick={() => setMobileDrawerOpen(true)}>
                <Menu size={20} />
              </button>
              <div className={`agent-avatar agent-avatar--${selectedSystem}`}>
                {selectedSystem === 'letta' ? <Sparkles size={18} /> : <Bot size={19} />}
              </div>
              <div className="chat-header__text">
                <strong>{activeConversation?.title ?? '새 대화'}</strong>
                <span>{activeAgent} · {selectedSystem === 'letta' ? 'Personal' : 'Hermes System'}</span>
              </div>
            </div>

            <div className="chat-header__actions">
              <button
                className={`icon-button ${activeConversation?.pinned ? 'is-active' : ''}`}
                title="고정"
                onClick={() =>
                  activeConversation &&
                  updateConversation(activeConversation.id, { pinned: !activeConversation.pinned })
                }
              >
                <Pin size={17} />
              </button>
              <button className="icon-button" title="이름 변경" onClick={renameConversation}>
                <MoreHorizontal size={18} />
              </button>
              {selectedSystem === 'hermes' && (
                <button className="team-button" onClick={() => setTeamPanelOpen(true)}>
                  <Users size={16} /> 팀 활동
                </button>
              )}
            </div>
          </header>

          <div className="conversation-canvas">
            <div className="message-stream">
              <article className="message message--user">
                <div className="message__meta"><strong>Tei</strong><span>10:30</span></div>
                <p>승인된 디자인을 기준으로 Chat V2의 첫 화면을 구현해줘. Conversation 관리가 가장 중요해.</p>
              </article>

              <article className="message message--assistant">
                <div className="message__meta">
                  <div className={`agent-avatar agent-avatar--${selectedSystem}`}><Bot size={15} /></div>
                  <strong>{activeAgent}</strong><span>10:31</span>
                </div>
                <p>
                  시스템은 AI의 소속을 구분하고, Conversation은 Tei님의 아젠다를 구분하도록 설계하겠습니다.
                  현재 대화는 고정·이름 변경·보관·삭제가 가능하며, 모바일에서도 같은 구조를 유지합니다.
                </p>

                <div className="inline-image-card">
                  <img
                    src="https://images.unsplash.com/photo-1555066931-4365d14bab8c?auto=format&fit=crop&w=1200&q=80"
                    alt="개발 화면 예시"
                  />
                  <div className="image-toolbar">
                    <button><Download size={15} /> 다운로드</button>
                    <button><Image size={15} /> 전체 화면</button>
                  </div>
                </div>

                <div className="file-card">
                  <div className="file-icon"><FileText size={19} /></div>
                  <div><strong>chat-v2-ui-spec.md</strong><span>Markdown · 42 KB</span></div>
                  <button className="icon-button"><Download size={17} /></button>
                </div>

                {selectedSystem === 'hermes' && (
                  <button className="activity-summary" onClick={() => setTeamPanelOpen(true)}>
                    <Users size={15} /> 팀 작업 2건 <ChevronRight size={15} />
                  </button>
                )}
              </article>
            </div>
          </div>

          <div className="composer-zone">
            <div className="drop-hint"><Upload size={15} /> 파일을 끌어놓거나 이미지를 붙여넣을 수 있습니다.</div>
            <form className="composer" onSubmit={submitMessage}>
              <div className="composer__tools">
                <button type="button" className="icon-button"><Plus size={18} /></button>
                <button type="button" className="icon-button"><Paperclip size={17} /></button>
                <button type="button" className="icon-button"><Image size={17} /></button>
              </div>
              <textarea
                value={composer}
                onChange={(event) => setComposer(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={`Message ${activeAgent}...`}
                rows={1}
              />
              <div className="composer__send">
                <button type="button" className="icon-button"><Mic size={18} /></button>
                <button type="submit" className="send-button" aria-label="전송"><Send size={18} /></button>
              </div>
            </form>
            <p className="composer-footnote">
              {selectedSystem === 'letta'
                ? 'Letta의 Lucy는 Conversation을 넘어 개인 기억을 유지합니다.'
                : 'Hermes의 Lucy는 필요할 때 subagent와 협업합니다.'}
            </p>
          </div>
        </section>

        {teamPanelOpen && (
          <aside className="team-panel">
            <div className="team-panel__header">
              <div><strong>Hermes Team</strong><span>현재 Conversation 활동</span></div>
              <button className="icon-button" onClick={() => setTeamPanelOpen(false)}><X size={18} /></button>
            </div>
            {agents.hermes.map((agent, index) => (
              <div className="team-member" key={agent.name}>
                <div className="team-member__avatar"><Bot size={16} /></div>
                <div><strong>{agent.name}</strong><span>{agent.role}</span></div>
                <span className={`presence ${agent.active ? 'presence--active' : ''}`} />
                <small>{index === 0 ? '대화 중' : index === 1 ? '구현안 작성' : index === 2 ? '대기' : '시각자료 준비'}</small>
              </div>
            ))}
          </aside>
        )}
      </main>
    </div>
  );
}

function SystemCard({
  id,
  label,
  accent,
  selectedSystem,
  activeAgent,
  onSelect,
}: {
  id: SystemId;
  label: string;
  accent: 'blue' | 'violet';
  selectedSystem: SystemId;
  activeAgent: string;
  onSelect: (system: SystemId, agentName: string) => void;
}) {
  return (
    <div className={`system-card system-card--${accent} ${selectedSystem === id ? 'is-selected' : ''}`}>
      <button className="system-card__header" onClick={() => onSelect(id, agents[id][0].name)}>
        <span className="system-card__icon">{id === 'letta' ? <Sparkles size={16} /> : <Bot size={17} />}</span>
        <span><strong>{label}</strong><small>{id === 'letta' ? 'Memory-first system' : 'Collaborative system'}</small></span>
        <ChevronDown size={15} />
      </button>
      <div className="agent-list">
        {agents[id].map((agent) => (
          <button
            key={agent.name}
            className={`agent-row ${selectedSystem === id && activeAgent === agent.name ? 'is-active' : ''}`}
            onClick={() => onSelect(id, agent.name)}
          >
            <span className="mini-avatar">{agent.name === '[Letta] Lucy' ? <Sparkles size={13} /> : <Bot size={14} />}</span>
            <span className="agent-row__name">{agent.name}</span>
            {agent.role === 'Personal' ? <em>Personal</em> : <span className={`presence ${agent.active ? 'presence--active' : ''}`} />}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConversationGroup({
  title,
  conversations,
  activeConversationId,
  onSelect,
}: {
  title: string;
  conversations: Conversation[];
  activeConversationId: string;
  onSelect: (id: string) => void;
}) {
  if (conversations.length === 0) return null;
  return (
    <div className="conversation-group">
      <h3>{title}</h3>
      {conversations.map((conversation) => (
        <button
          key={conversation.id}
          className={`conversation-row ${activeConversationId === conversation.id ? 'is-active' : ''}`}
          onClick={() => onSelect(conversation.id)}
        >
          <span className="conversation-row__content">
            <strong>{conversation.title}</strong>
            <small>{conversation.preview}</small>
          </span>
          <time>{conversation.updatedAt}</time>
        </button>
      ))}
    </div>
  );
}

export default App;
