import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  Archive,
  Bot,
  ChevronDown,
  Download,
  FileDown,
  FileText,
  GitBranch,
  Image,
  LoaderCircle,
  Menu,
  Mic,
  MoreHorizontal,
  Paperclip,
  Pin,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import type {
  ArtifactRecord,
  ConversationRecord,
  ConversationStatus,
  MessageRecord,
  SystemId,
} from '../shared/contracts';
import {
  artifactContentUrl,
  artifactDownloadUrl,
  conversationExportUrl,
} from './api';
import { useChat } from './useChat';

const agents = {
  letta: [{ name: '[Letta] Lucy', role: 'Personal', active: true, enabled: true }],
  hermes: [
    { name: '[Hermes] Lucy', role: 'Lead', active: true, enabled: true },
    { name: 'Xixi', role: 'Implementation', active: true, enabled: false },
    { name: 'Lynn', role: 'Review', active: false, enabled: false },
    { name: 'Gemma', role: 'Multimodal', active: true, enabled: false },
  ],
} satisfies Record<SystemId, Array<{ name: string; role: string; active: boolean; enabled: boolean }>>;

function App() {
  const chat = useChat();
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [teamPanelOpen, setTeamPanelOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamEndRef = useRef<HTMLDivElement>(null);

  const hasUploading = chat.uploads.some((item) => item.state === 'uploading');
  const searchedConversations = search.trim()
    ? chat.searchResults.map((result) => ({ ...result.conversation, preview: result.snippet }))
    : chat.conversations;
  const pendingArtifacts = chat.activeConversation?.artifacts.filter((artifact) =>
    chat.pendingArtifactIds.includes(artifact.id),
  ) ?? [];

  useEffect(() => {
    chat.searchConversations(search);
  }, [chat.searchConversations, search]);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ block: 'end' });
  }, [chat.activeConversation?.messages, chat.runStatus]);

  const handleFiles = async (files: File[]) => {
    if (!files.length || chat.selectedStatus !== 'active') return;
    try {
      await chat.uploadFiles(files);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const renameConversation = async () => {
    if (!chat.activeConversation) return;
    const title = window.prompt('대화 이름을 입력하세요.', chat.activeConversation.title)?.trim();
    if (title) await chat.patchConversation({ title });
  };

  const moveConversation = async (status: ConversationStatus) => {
    await chat.patchConversation({ status });
  };

  const submitMessage = async (event: FormEvent) => {
    event.preventDefault();
    const content = chat.activeConversation?.draft ?? '';
    if (!content.trim() || hasUploading) return;
    chat.saveDraft('');
    await chat.sendMessage(content);
  };

  return (
    <div className="page-shell">
      <main className={`app-frame ${dragActive ? 'is-dragging' : ''}`}>
        <aside className={`sidebar ${mobileDrawerOpen ? 'sidebar--open' : ''}`}>
          <div className="sidebar__mobile-head">
            <strong>시스템과 대화</strong>
            <button className="icon-button" onClick={() => setMobileDrawerOpen(false)} aria-label="메뉴 닫기">
              <X size={18} />
            </button>
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
            <SystemCard
              id="letta"
              label="Letta"
              accent="blue"
              selectedSystem={chat.selectedSystem}
              activeAgent={chat.activeAgent}
              onSelect={(system, agent) => {
                chat.switchSystem(system, agent);
                setSearch('');
                setMobileDrawerOpen(false);
              }}
            />
            <SystemCard
              id="hermes"
              label="Hermes"
              accent="violet"
              selectedSystem={chat.selectedSystem}
              activeAgent={chat.activeAgent}
              onSelect={(system, agent) => {
                chat.switchSystem(system, agent);
                setSearch('');
                setMobileDrawerOpen(false);
              }}
            />
          </section>

          <section className="sidebar-section conversations-section">
            <div className="section-title-row conversations-title">
              <span>{statusLabel(chat.selectedStatus)}</span>
              <button
                className="icon-button"
                onClick={() => chat.createConversation().then(() => setMobileDrawerOpen(false))}
                aria-label="새 대화"
                disabled={chat.selectedStatus !== 'active'}
              >
                <Plus size={16} />
              </button>
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
                <ConversationGroup
                  title={search ? '검색 결과 · 고정' : '고정됨'}
                  conversations={searchedConversations.filter((conversation) => conversation.pinned)}
                  activeConversationId={chat.activeConversation?.id ?? null}
                  onSelect={(id) => {
                    chat.selectConversation(id);
                    setMobileDrawerOpen(false);
                  }}
                />
                <ConversationGroup
                  title={search ? '검색 결과' : '최근'}
                  conversations={searchedConversations.filter((conversation) => !conversation.pinned)}
                  activeConversationId={chat.activeConversation?.id ?? null}
                  onSelect={(id) => {
                    chat.selectConversation(id);
                    setMobileDrawerOpen(false);
                  }}
                />
              </>
            ) : (
              <ConversationGroup
                title={chat.selectedStatus === 'archived' ? '보관된 대화' : '삭제 대기'}
                conversations={searchedConversations}
                activeConversationId={chat.activeConversation?.id ?? null}
                onSelect={(id) => {
                  chat.selectConversation(id);
                  setMobileDrawerOpen(false);
                }}
              />
            )}

            {!chat.loading && searchedConversations.length === 0 && (
              <div className="empty-sidebar">{search ? '검색 결과가 없습니다.' : '표시할 Conversation이 없습니다.'}</div>
            )}
          </section>

          <div className="sidebar-footer sidebar-footer--three">
            <button className={chat.selectedStatus === 'active' ? 'is-active' : ''} onClick={() => { chat.switchStatus('active'); setSearch(''); }}><Bot size={15} /> 활성</button>
            <button className={chat.selectedStatus === 'archived' ? 'is-active' : ''} onClick={() => { chat.switchStatus('archived'); setSearch(''); }}><Archive size={15} /> 보관함</button>
            <button className={chat.selectedStatus === 'trashed' ? 'is-active' : ''} onClick={() => { chat.switchStatus('trashed'); setSearch(''); }}><Trash2 size={15} /> 휴지통</button>
          </div>
        </aside>

        {mobileDrawerOpen && <button className="drawer-scrim" onClick={() => setMobileDrawerOpen(false)} />}

        <section
          className="chat-column"
          onDragEnter={(event) => {
            event.preventDefault();
            if (chat.selectedStatus === 'active') setDragActive(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setDragActive(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            void handleFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <header className="chat-header">
            <div className="chat-header__identity">
              <button className="icon-button mobile-menu" onClick={() => setMobileDrawerOpen(true)}><Menu size={20} /></button>
              <div className={`agent-avatar agent-avatar--${chat.selectedSystem}`}>
                {chat.selectedSystem === 'letta' ? <Sparkles size={18} /> : <Bot size={19} />}
              </div>
              <div className="chat-header__text">
                <strong>{chat.activeConversation?.title ?? '새 Conversation'}</strong>
                <span>
                  {chat.activeAgent} · {chat.selectedSystem === 'letta' ? 'Personal' : 'Hermes System'}
                  {chat.activeConversation?.branchedFromConversationId ? ' · Branched' : ''}
                </span>
              </div>
            </div>

            <div className="chat-header__actions">
              {chat.selectedStatus === 'active' && chat.activeConversation && (
                <button
                  className={`icon-button ${chat.activeConversation.pinned ? 'is-active' : ''}`}
                  title="고정"
                  onClick={() => chat.patchConversation({ pinned: !chat.activeConversation?.pinned })}
                ><Pin size={17} /></button>
              )}
              <details className="conversation-menu">
                <summary className="icon-button" aria-label="대화 메뉴"><MoreHorizontal size={18} /></summary>
                <div className="conversation-menu__popup">
                  {chat.selectedStatus === 'active' && (
                    <>
                      <button onClick={renameConversation}>이름 변경</button>
                      <button onClick={() => chat.branchConversation(chat.activeConversation?.messages.at(-1)?.id)}><GitBranch size={14} /> 현재 지점에서 분기</button>
                      {chat.activeConversation && (
                        <a href={conversationExportUrl(chat.activeConversation.id)}><FileDown size={14} /> Markdown 내보내기</a>
                      )}
                      <button onClick={() => moveConversation('archived')}><Archive size={14} /> 보관</button>
                      <button className="danger" onClick={() => moveConversation('trashed')}><Trash2 size={14} /> 휴지통으로 이동</button>
                    </>
                  )}
                  {chat.selectedStatus !== 'active' && (
                    <button onClick={() => moveConversation('active')}><RotateCcw size={14} /> 활성 대화로 복원</button>
                  )}
                  {chat.selectedStatus === 'trashed' && (
                    <button
                      className="danger"
                      onClick={() => {
                        if (window.confirm('이 대화 기록을 영구 삭제하시겠습니까?')) void chat.deletePermanently();
                      }}
                    ><Trash2 size={14} /> 영구 삭제</button>
                  )}
                </div>
              </details>
              {chat.selectedSystem === 'hermes' && (
                <button className="team-button" onClick={() => setTeamPanelOpen(true)}><Users size={16} /> 팀 활동</button>
              )}
            </div>
          </header>

          {chat.error && (
            <div className="error-banner"><span>{chat.error}</span><button onClick={chat.clearError}><X size={15} /></button></div>
          )}

          <div className="conversation-canvas">
            {!chat.activeConversation && !chat.loading ? (
              <div className="empty-conversation">
                <div className="empty-icon"><Bot size={26} /></div>
                <strong>새 아젠다를 시작하세요.</strong>
                <p>Conversation은 Tei님의 생각과 프로젝트 문맥을 분리해 보존합니다.</p>
                {chat.selectedStatus === 'active' && <button onClick={() => chat.createConversation()}>새 Conversation</button>}
              </div>
            ) : (
              <div className="message-stream">
                {chat.activeConversation?.messages.map((message) => (
                  <MessageItem
                    key={message.id}
                    message={message}
                    system={chat.selectedSystem}
                    artifacts={chat.activeConversation?.artifacts.filter((artifact) => artifact.messageId === message.id) ?? []}
                    onBranch={() => chat.branchConversation(message.id)}
                  />
                ))}
                {chat.runStatus && <div className="run-status"><LoaderCircle size={15} className="spin" /> {chat.runStatus}</div>}
                <div ref={streamEndRef} />
              </div>
            )}
          </div>

          {chat.selectedStatus === 'active' ? (
            <div className="composer-zone">
              {(chat.uploads.length > 0 || pendingArtifacts.length > 0) && (
                <div className="pending-attachments">
                  {chat.uploads.map((item) => (
                    <div className={`upload-chip upload-chip--${item.state}`} key={item.localId}>
                      {item.state === 'uploading' ? <LoaderCircle size={14} className="spin" /> : <FileText size={14} />}
                      <span>{item.filename}</span>
                      <em>{item.state === 'uploading' ? `${item.progress}%` : item.state === 'failed' ? '실패' : '준비됨'}</em>
                      {item.state === 'uploading' && <i style={{ width: `${item.progress}%` }} />}
                    </div>
                  ))}
                  {pendingArtifacts
                    .filter((artifact) => !chat.uploads.some((item) => item.artifactId === artifact.id))
                    .map((artifact) => (
                      <div className="upload-chip upload-chip--complete" key={artifact.id}>
                        <FileText size={14} /><span>{artifact.filename}</span><em>전송 대기</em>
                      </div>
                    ))}
                </div>
              )}
              <div className="drop-hint">
                {hasUploading
                  ? <><LoaderCircle size={15} className="spin" /> 파일을 업로드하고 있습니다.</>
                  : pendingArtifacts.length
                    ? <><Paperclip size={15} /> 첨부파일 {pendingArtifacts.length}개가 다음 메시지에 포함됩니다.</>
                    : <><Upload size={15} /> 파일을 끌어놓거나 이미지를 붙여넣을 수 있습니다.</>}
              </div>
              <form className="composer" onSubmit={submitMessage}>
                <div className="composer__tools">
                  <button type="button" className="icon-button" onClick={() => fileInputRef.current?.click()}><Plus size={18} /></button>
                  <button type="button" className="icon-button" onClick={() => fileInputRef.current?.click()}><Paperclip size={17} /></button>
                  <button type="button" className="icon-button" onClick={() => fileInputRef.current?.click()}><Image size={17} /></button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    hidden
                    onChange={(event) => void handleFiles(Array.from(event.target.files ?? []))}
                  />
                </div>
                <textarea
                  value={chat.activeConversation?.draft ?? ''}
                  onChange={(event) => chat.saveDraft(event.target.value)}
                  onPaste={(event) => {
                    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
                    if (images.length) {
                      event.preventDefault();
                      void handleFiles(images);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={`Message ${chat.activeAgent}...`}
                  rows={1}
                  disabled={chat.isStreaming}
                />
                <div className="composer__send">
                  {chat.isStreaming ? (
                    <button type="button" className="stop-button" onClick={chat.stopStreaming} aria-label="응답 중단"><Square size={15} /></button>
                  ) : (
                    <>
                      <button type="button" className="icon-button"><Mic size={18} /></button>
                      <button type="submit" className="send-button" aria-label="전송" disabled={hasUploading}><Send size={18} /></button>
                    </>
                  )}
                </div>
              </form>
              <p className="composer-footnote">
                {chat.selectedSystem === 'letta'
                  ? 'Letta의 Lucy는 Conversation을 넘어 승인된 개인 기억을 유지합니다.'
                  : 'Hermes의 Lucy는 필요할 때만 subagent와 협업합니다.'}
              </p>
            </div>
          ) : (
            <div className="readonly-bar">
              <span>{chat.selectedStatus === 'archived' ? '보관된 Conversation입니다.' : '휴지통의 Conversation입니다.'}</span>
              <button onClick={() => moveConversation('active')}><RotateCcw size={14} /> 복원</button>
            </div>
          )}

          {dragActive && <div className="drop-overlay"><Upload size={28} /><strong>파일을 여기에 놓으세요</strong></div>}
        </section>

        {teamPanelOpen && (
          <aside className="team-panel">
            <div className="team-panel__header">
              <div><strong>Hermes Team</strong><span>현재 Conversation에서 선택적으로 참여</span></div>
              <button className="icon-button" onClick={() => setTeamPanelOpen(false)}><X size={18} /></button>
            </div>
            {agents.hermes.map((agent, index) => (
              <div className="team-member" key={agent.name}>
                <div className="team-member__avatar"><Bot size={16} /></div>
                <div><strong>{agent.name}</strong><span>{agent.role}</span></div>
                <span className={`presence ${agent.active ? 'presence--active' : ''}`} />
                <small>{index === 0 ? '대화 책임자' : '2차에서 직접 참여 활성화'}</small>
              </div>
            ))}
          </aside>
        )}
      </main>
    </div>
  );
}

function MessageItem({
  message,
  system,
  artifacts,
  onBranch,
}: {
  message: MessageRecord;
  system: SystemId;
  artifacts: ArtifactRecord[];
  onBranch: () => void;
}) {
  const isUser = message.role === 'user';
  return (
    <article className={`message ${isUser ? 'message--user' : 'message--assistant'}`}>
      <div className="message__meta">
        {!isUser && <div className={`agent-avatar agent-avatar--${system}`}><Bot size={15} /></div>}
        <strong>{isUser ? 'Tei' : message.authorId}</strong>
        <span>{formatTime(message.createdAt)}</span>
        {message.state !== 'complete' && <em>{message.state}</em>}
        <button className="message-branch" onClick={onBranch} title="이 메시지까지 새 Conversation으로 분기"><GitBranch size={13} /></button>
      </div>
      <p>{message.content || ' '}{message.state === 'streaming' && <span className="stream-cursor" />}</p>
      {artifacts.map((artifact) => <ArtifactItem key={artifact.id} artifact={artifact} />)}
    </article>
  );
}

function ArtifactItem({ artifact }: { artifact: ArtifactRecord }) {
  const isImage = artifact.mimeType.startsWith('image/');
  if (isImage) {
    return (
      <div className="inline-image-card">
        <img src={artifactContentUrl(artifact.id)} alt={artifact.filename} />
        <div className="image-toolbar">
          <a href={artifactDownloadUrl(artifact.id)}><Download size={15} /> 다운로드</a>
          <a href={artifactContentUrl(artifact.id)} target="_blank" rel="noreferrer"><Image size={15} /> 전체 화면</a>
        </div>
      </div>
    );
  }
  return (
    <div className="file-card">
      <div className="file-icon"><FileText size={19} /></div>
      <div><strong>{artifact.filename}</strong><span>{artifact.mimeType} · {formatBytes(artifact.sizeBytes)}</span></div>
      <a className="icon-button" href={artifactDownloadUrl(artifact.id)} aria-label="파일 다운로드"><Download size={17} /></a>
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
            onClick={() => agent.enabled && onSelect(id, agent.name)}
            disabled={!agent.enabled}
            title={agent.enabled ? agent.role : `${agent.role} · 2차 활성화`}
          >
            <span className="mini-avatar">{agent.name === '[Letta] Lucy' ? <Sparkles size={13} /> : <Bot size={14} />}</span>
            <span className="agent-row__name">{agent.name}</span>
            {agent.role === 'Personal' ? <em>Personal</em> : agent.enabled ? <span className={`presence ${agent.active ? 'presence--active' : ''}`} /> : <small>2차</small>}
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
  conversations: ConversationRecord[];
  activeConversationId: string | null;
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
            <small>{conversation.preview || '아직 메시지가 없습니다.'}</small>
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

function formatTime(value: string) {
  return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatRelative(value: string) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return formatTime(value);
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric' }).format(date);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default App;
