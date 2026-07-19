import { useState } from 'react';
import { Bot, Check, Copy, Download, FileText, GitBranch, Image, LoaderCircle, RefreshCw } from 'lucide-react';
import type { ArtifactDeliveryRecord, ArtifactRecord, ConversationDetail, MessageRecord, SystemId } from '../shared/contracts';
import { isInlineImageMime } from '../shared/artifact-mime';
import { artifactContentUrl, artifactDownloadUrl } from './api';
import { renderMessageContent } from './message-content';

const sourceBadgeStyle = {
  display: 'inline-block',
  flex: '0 0 auto',
  width: 'auto',
  height: 'auto',
  visibility: 'visible',
  opacity: 1,
  whiteSpace: 'nowrap',
} as const;

const deliveryListStyle = {
  marginTop: 10,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
} as const;

const deliveryBadgeStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 25,
  padding: '4px 8px',
  border: '1px solid rgba(148, 163, 184, .22)',
  borderRadius: 999,
  background: 'rgba(148, 163, 184, .07)',
  color: '#9aa7ba',
  fontSize: 9,
  lineHeight: 1.35,
} as const;

export default function MessageStream({
  conversation,
  selectedSystem,
  loading,
  runStatus,
  artifactDeliveries,
  streamEndRef,
  onCreate,
  onBranch,
  onRetry,
  retryEnabled,
  retryingMessageId,
}: {
  conversation: ConversationDetail | null;
  selectedSystem: SystemId;
  loading: boolean;
  runStatus: string | null;
  artifactDeliveries: ArtifactDeliveryRecord[];
  streamEndRef: React.RefObject<HTMLDivElement | null>;
  onCreate: () => void;
  onBranch: (messageId: string) => void;
  onRetry: (messageId: string, mode: 'retry' | 'regenerate') => void;
  retryEnabled: boolean;
  retryingMessageId: string | null;
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
        {conversation?.messages.map((message, messageIndex, messages) => {
          const siblingAttempts = !message.parentMessageId || message.role !== 'assistant'
            ? []
            : messages.slice(0, messageIndex).filter((candidate) =>
                candidate.role === 'assistant'
                && candidate.parentMessageId === message.parentMessageId
                && candidate.authorId === message.authorId,
              );
          const artifacts = conversation.artifacts.filter((artifact) => artifact.messageId === message.id);
          const deliveryResponses = message.role === 'user' && artifacts.length > 0
            ? messages.filter((candidate) => candidate.role === 'assistant' && candidate.parentMessageId === message.id)
            : [];
          const liveDeliveries = message.role === 'user'
            ? artifactDeliveries.filter((delivery) => delivery.messageId === message.id)
            : [];
          return (
            <MessageItem
              key={message.id}
              message={message}
              system={message.authorId === '[Letta] Lucy' ? 'letta' : selectedSystem}
              artifacts={artifacts}
              liveDeliveries={liveDeliveries}
              deliveryResponses={deliveryResponses}
              attemptNumber={siblingAttempts.length}
              onBranch={() => onBranch(message.id)}
              onRetry={(mode) => onRetry(message.id, mode)}
              retryEnabled={retryEnabled}
              retrying={retryingMessageId === message.id}
            />
          );
        })}
        {runStatus && <div className="run-status"><LoaderCircle size={15} className="spin" /> {runStatus}</div>}
        <div ref={streamEndRef} />
      </div>
    </div>
  );
}

function MessageItem({ message, system, artifacts, liveDeliveries, deliveryResponses, attemptNumber, onBranch, onRetry, retryEnabled, retrying }: {
  message: MessageRecord;
  system: SystemId;
  artifacts: ArtifactRecord[];
  liveDeliveries: ArtifactDeliveryRecord[];
  deliveryResponses: MessageRecord[];
  attemptNumber: number;
  onBranch: () => void;
  onRetry: (mode: 'retry' | 'regenerate') => void;
  retryEnabled: boolean;
  retrying: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';
  const canRetryState = ['complete', 'failed', 'cancelled'].includes(message.state);
  const retryMode = message.state === 'complete' ? 'regenerate' : 'retry';
  const retryLabel = retryMode === 'retry' ? '응답 다시 시도' : '응답 재생성';
  const agentClass = !isUser ? ` message--${message.authorId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';

  const copyMessage = async () => {
    if (!message.content) return;
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <article className={`message ${isUser ? 'message--user' : 'message--assistant'}${agentClass}`}>
      <div className="message__meta">
        {!isUser && <div className={`agent-avatar agent-avatar--${system}`}><Bot size={15} /></div>}
        <strong>{isUser ? 'Tei' : message.authorId}</strong>
        <span>{formatTime(message.createdAt)}</span>
        {message.state !== 'complete' && <em>{message.state}</em>}
        {!isUser && message.authorId !== '[Hermes] Lucy' && <small className="source-output" style={sourceBadgeStyle}>원문</small>}
        {!isUser && attemptNumber > 0 && <small className="source-output" style={sourceBadgeStyle}>재생성 {attemptNumber}</small>}
        {!isUser && artifacts.length > 0 && <small className="source-output" style={sourceBadgeStyle}>AI 생성 파일 {artifacts.length}</small>}
        {message.content && (
          <button
            className="message-branch"
            onClick={() => void copyMessage()}
            title={copied ? '복사됨' : '메시지 복사'}
            aria-label={copied ? '메시지 복사됨' : '메시지 복사'}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        )}
        {!isUser && canRetryState && (
          <button
            className="message-branch"
            onClick={() => onRetry(retryMode)}
            title={retryLabel}
            aria-label={retryLabel}
            disabled={!retryEnabled || retrying}
          >
            <RefreshCw size={13} className={retrying ? 'spin' : undefined} />
          </button>
        )}
        <button className="message-branch" onClick={onBranch} title="이 메시지까지 새 Conversation으로 분기" aria-label="이 메시지에서 분기"><GitBranch size={13} /></button>
      </div>
      <p>{renderMessageContent(message.content || ' ')}{message.state === 'streaming' && <span className="stream-cursor" />}</p>
      {artifacts.map((artifact) => <ArtifactItem key={artifact.id} artifact={artifact} />)}
      {isUser && artifacts.length > 0 && <DeliveryLifecycle deliveries={liveDeliveries} responses={deliveryResponses} />}
    </article>
  );
}

function DeliveryLifecycle({ deliveries, responses }: {
  deliveries: ArtifactDeliveryRecord[];
  responses: MessageRecord[];
}) {
  if (deliveries.length > 0) {
    return (
      <div aria-label="첨부 전달 상태" style={deliveryListStyle}>
        {deliveries.map((delivery, index) => {
          const label = delivery.state === 'delivering'
            ? '백엔드 전달 중'
            : delivery.state === 'delivered'
              ? '백엔드 전달 완료 · 이해 여부는 응답으로 확인'
              : delivery.state === 'unsupported'
                ? '선택한 백엔드에서 미지원'
                : '백엔드 전달 실패';
          return (
            <span
              key={`${delivery.runId}:${delivery.agentId}`}
              data-state={delivery.state}
              style={deliveryBadgeStyle}
              title={delivery.detail ?? undefined}
            >
              {delivery.agentId} · {label}{index > 0 ? ` · 시도 ${index + 1}` : ''}
            </span>
          );
        })}
      </div>
    );
  }

  if (responses.length === 0) {
    return (
      <div aria-label="첨부 전달 상태" style={deliveryListStyle}>
        <span data-state="attached" style={deliveryBadgeStyle}>메시지에 첨부됨 · 백엔드 전달 대기</span>
      </div>
    );
  }

  return (
    <div aria-label="첨부 전달 상태" style={deliveryListStyle}>
      {responses.map((response, index) => {
        const label = response.state === 'streaming'
          ? '백엔드 전달 중'
          : response.state === 'complete'
            ? '백엔드 전달 완료 · 이해 여부는 응답으로 확인'
            : response.state === 'cancelled'
              ? '전달 취소됨'
              : '미지원 또는 전달 실패';
        return (
          <span key={response.id} data-state={response.state} style={deliveryBadgeStyle}>
            {response.authorId} · {label}{index > 0 ? ` · 시도 ${index + 1}` : ''}
          </span>
        );
      })}
    </div>
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
