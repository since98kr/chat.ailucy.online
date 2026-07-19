import { Archive, Bot, FileDown, FileJson, GitBranch, Menu, MoreHorizontal, Network, Pin, RotateCcw, Sparkles, Trash2, Users } from 'lucide-react';
import type { ConversationStatus } from '../shared/contracts';
import { conversationExportUrl } from './api';
import type { useChat } from './useChat';
import type { useCollaboration } from './useCollaboration';
import type { useFederation } from './useFederation';

type ChatController = ReturnType<typeof useChat>;
type CollaborationController = ReturnType<typeof useCollaboration>;
type FederationController = ReturnType<typeof useFederation>;

function conversationJsonExportUrl(id: string) {
  return conversationExportUrl(id).replace(/\/markdown$/, '/json');
}

export default function ChatHeader({
  chat,
  collaboration,
  federation,
  onMobileMenu,
  onOpenTeam,
  onOpenFederation,
}: {
  chat: ChatController;
  collaboration: CollaborationController;
  federation: FederationController;
  onMobileMenu: () => void;
  onOpenTeam: () => void;
  onOpenFederation: () => void;
}) {
  const rename = async () => {
    if (!chat.activeConversation) return;
    const title = window.prompt('대화 이름을 입력하세요.', chat.activeConversation.title)?.trim();
    if (title) await chat.patchConversation({ title });
  };

  const move = async (status: ConversationStatus) => {
    await chat.patchConversation({ status });
  };

  return (
    <header className="chat-header">
      <div className="chat-header__identity">
        <button className="icon-button mobile-menu" aria-label="메뉴 열기" onClick={onMobileMenu}><Menu size={20} /></button>
        <div className={`agent-avatar agent-avatar--${chat.selectedSystem}`}>
          {chat.selectedSystem === 'letta' ? <Sparkles size={18} /> : <Bot size={19} />}
        </div>
        <div className="chat-header__text">
          <strong>{chat.activeConversation?.title ?? '새 Conversation'}</strong>
          <span>
            {chat.activeAgent} · {federation.active ? 'Federated' : chat.selectedSystem === 'letta' ? 'Personal' : chat.activeAgent === '[Hermes] Lucy' ? 'Hermes Lead' : 'Direct Agent'}
            {chat.activeConversation?.branchedFromConversationId ? ' · Branched' : ''}
          </span>
        </div>
      </div>

      <div className="chat-header__actions">
        {chat.selectedStatus === 'active' && chat.activeConversation && (
          <button className={`icon-button ${chat.activeConversation.pinned ? 'is-active' : ''}`} title="고정" onClick={() => chat.patchConversation({ pinned: !chat.activeConversation?.pinned })}><Pin size={17} /></button>
        )}
        <details className="conversation-menu">
          <summary className="icon-button" aria-label="대화 메뉴"><MoreHorizontal size={18} /></summary>
          <div className="conversation-menu__popup">
            {chat.selectedStatus === 'active' && <>
              <button onClick={rename}>이름 변경</button>
              <button onClick={() => chat.branchConversation(chat.activeConversation?.messages.at(-1)?.id)}><GitBranch size={14} /> 현재 지점에서 분기</button>
              {chat.activeConversation && <a href={conversationExportUrl(chat.activeConversation.id)}><FileDown size={14} /> Markdown 내보내기</a>}
              {chat.activeConversation && <a href={conversationJsonExportUrl(chat.activeConversation.id)}><FileJson size={14} /> JSON 증거 내보내기</a>}
              <button onClick={() => move('archived')}><Archive size={14} /> 보관</button>
              <button className="danger" onClick={() => move('trashed')}><Trash2 size={14} /> 휴지통으로 이동</button>
            </>}
            {chat.selectedStatus !== 'active' && <button onClick={() => move('active')}><RotateCcw size={14} /> 활성 대화로 복원</button>}
            {chat.selectedStatus === 'trashed' && <button className="danger" onClick={() => { if (window.confirm('이 대화 기록을 영구 삭제하시겠습니까?')) void chat.deletePermanently(); }}><Trash2 size={14} /> 영구 삭제</button>}
          </div>
        </details>
        {chat.selectedSystem === 'hermes' && <button className="team-button" onClick={onOpenTeam}><Users size={16} /> 팀 {collaboration.participants.length}</button>}
        {chat.activeConversation && <button className={`federation-button ${federation.active ? 'is-active' : ''}`} onClick={onOpenFederation}><Network size={16} /> {federation.active ? '교차' : '연합'}</button>}
      </div>
    </header>
  );
}
