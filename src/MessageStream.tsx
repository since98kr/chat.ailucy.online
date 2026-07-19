import { Bot, Download, FileText, GitBranch, Image, LoaderCircle } from 'lucide-react';
import type { ArtifactRecord, ConversationDetail, MessageRecord, SystemId } from '../shared/contracts';
import { isInlineImageMime } from '../shared/artifact-mime';
import { artifactContentUrl, artifactDownloadUrl } from './api';
import { renderMessageContent } from './message-content';

export default function MessageStream({
  conversation,
  selectedSystem,
  loading,
  runStatus,
  streamEndRef,
  onCreate,
  onBranch,
}: {
  conversation: ConversationDetail | null;
  selectedSystem: SystemId;
  loading: boolean;
  runStatus: string | null;
  streamEndRef: React.RefObject<HTMLDivElement | null>;
  onCreate: () => void;
  onBranch: (messageId: string) => void;
}) {
  if (!conversation && !loading) {
    return (
      <div className="conversation-canvas">
        <div className="empty-conversation">
          <div className="empty-icon"><Bot size={26} /></div>
          <strong>새 아젠다를 시작하세요.</strong>
          <p>Conversation은 Tei님의 생각과 프로젝트 문맥을 분리해 보존합니다.</p>
          <button onClick={onCreate}>새 Conversation</button>
        </div>
      </div>
    );
  }

  return (
    <div className="conversation-canvas">
      <div className="message-stream">
        {conversation?.messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            system={message.authorId === '[Letta] Lucy' ? 'letta' : selectedSystem}
            artifacts={conversation.artifacts.filter((artifact) => artifact.messageId === message.id)}
            onBranch={() => onBranch(message.id)}
          />
        ))}
        {runStatus && <div className="run-status"><LoaderCircle size={15} className="spin" /> {runStatus}</div>}
        <div ref={streamEndRef} />
      </div>
    </div>
  );
}

function MessageItem({ message, system, artifacts, onBranch }: {
  message: MessageRecord;
  system: SystemId;
  artifacts: ArtifactRecord[];
  onBranch: () => void;
}) {
  const isUser = message.role === 'user';
  const agentClass = !isUser ? ` message--${message.authorId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
  return (
    <article className={`message ${isUser ? 'message--user' : 'message--assistant'}${agentClass}`}>
      <div className="message__meta">
        {!isUser && <div className={`agent-avatar agent-avatar--${system}`}><Bot size={15} /></div>}
        <strong>{isUser ? 'Tei' : message.authorId}</strong>
        <span>{formatTime(message.createdAt)}</span>
        {message.state !== 'complete' && <em>{message.state}</em>}
        {!isUser && message.authorId !== '[Hermes] Lucy' && <small className="source-output">원문</small>}
        <button className="message-branch" onClick={onBranch} title="이 메시지까지 새 Conversation으로 분기"><GitBranch size={13} /></button>
      </div>
      <p>{renderMessageContent(message.content || ' ')}{message.state === 'streaming' && <span className="stream-cursor" />}</p>
      {artifacts.map((artifact) => <ArtifactItem key={artifact.id} artifact={artifact} />)}
    </article>
  );
}

function ArtifactItem({ artifact }: { artifact: ArtifactRecord }) {
  if (isInlineImageMime(artifact.mimeType)) {
    return (
      <div className="inline-image-card">
        <img src={artifactContentUrl(artifact.id)} alt={artifact.filename} />
        <div className="image-toolbar">
          <a href={artifactDownloadUrl(artifact.id)}><Download size={15} /> 다운로드</a>
          <a href={artifactContentUrl(artifact.id)} target="_blank" rel="noopener noreferrer"><Image size={15} /> 전체 화면</a>
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

function formatTime(value: string) {
  return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
