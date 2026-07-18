import { FileText, Image, LoaderCircle, Mic, Paperclip, Plus, Send, Square, Upload } from 'lucide-react';
import type { AgentRecord, ArtifactRecord } from '../shared/contracts';
import type { useChat } from './useChat';
import type { useCollaboration } from './useCollaboration';
import type { useFederation } from './useFederation';

type ChatController = ReturnType<typeof useChat>;
type CollaborationController = ReturnType<typeof useCollaboration>;
type FederationController = ReturnType<typeof useFederation>;

export default function ConversationComposer({
  chat,
  collaboration,
  federation,
  targets,
  setTargets,
  fileInputRef,
  onFiles,
}: {
  chat: ChatController;
  collaboration: CollaborationController;
  federation: FederationController;
  targets: string[];
  setTargets: (targets: string[]) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFiles: (files: File[]) => void;
}) {
  const hasUploading = chat.uploads.some((item) => item.state === 'uploading');
  const pendingArtifacts = chat.activeConversation?.artifacts.filter((artifact) => chat.pendingArtifactIds.includes(artifact.id)) ?? [];
  const hermesMentionAgents = collaboration.agents.filter((agent) => agent.systemId === 'hermes' && !agent.isLead && agent.enabled);
  const federatedChoices = collaboration.agents.filter((agent) => agent.enabled && agent.directChatEnabled && agent.id !== '[Hermes] Lucy');

  const toggleFederatedTarget = (agent: AgentRecord) => {
    setTargets(targets.includes(agent.id) ? targets.filter((id) => id !== agent.id) : [...targets, agent.id]);
  };

  const addMention = (agent: AgentRecord) => {
    const current = chat.activeConversation?.draft ?? '';
    const prefix = current && !current.endsWith(' ') ? ' ' : '';
    chat.saveDraft(`${current}${prefix}@${agent.shortName} `);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const content = chat.activeConversation?.draft ?? '';
    if (!content.trim() || hasUploading) return;
    if (!federation.active && chat.selectedSystem === 'hermes') await collaboration.preview(content);
    chat.saveDraft('');
    await chat.sendMessage(content, targets, federation.active ? 'federated' : 'chat');
    setTargets([]);
  };

  if (chat.selectedStatus !== 'active') {
    return (
      <div className="readonly-bar">
        <span>{chat.selectedStatus === 'archived' ? '보관된 Conversation입니다.' : '휴지통의 Conversation입니다.'}</span>
        <button onClick={() => chat.patchConversation({ status: 'active' })}>복원</button>
      </div>
    );
  }

  return (
    <div className="composer-zone">
      {federation.active && federatedChoices.length > 0 ? (
        <div className="mention-toolbar mention-toolbar--federated" aria-label="교차 시스템 대상 선택">
          <span>병렬 실행:</span>
          {federatedChoices.map((agent) => (
            <button type="button" key={agent.id} className={targets.includes(agent.id) ? 'is-participant' : ''} onClick={() => toggleFederatedTarget(agent)} title={`${agent.systemId} · ${agent.role}`}>
              {agent.id === '[Letta] Lucy' ? '@Letta' : `@${agent.shortName}`}
            </button>
          ))}
          <em>{targets.length ? `${targets.join(' + ')} → Hermes Lucy` : 'Hermes Lucy 단독'}</em>
        </div>
      ) : chat.selectedSystem === 'hermes' && chat.activeAgent === '[Hermes] Lucy' && hermesMentionAgents.length > 0 ? (
        <div className="mention-toolbar" aria-label="Hermes 에이전트 멘션">
          <span>호출:</span>
          {hermesMentionAgents.map((agent) => <button type="button" key={agent.id} className={collaboration.participantIds.has(agent.id) ? 'is-participant' : ''} onClick={() => addMention(agent)}>@{agent.shortName}</button>)}
          {collaboration.routing && <em>{collaboration.routing.mode} · {collaboration.routing.targetAgentIds.join(' → ')}</em>}
        </div>
      ) : null}

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
          {pendingArtifacts.filter((artifact) => !chat.uploads.some((item) => item.artifactId === artifact.id)).map((artifact: ArtifactRecord) => (
            <div className="upload-chip upload-chip--complete" key={artifact.id}><FileText size={14} /><span>{artifact.filename}</span><em>전송 대기</em></div>
          ))}
        </div>
      )}

      <div className="drop-hint">
        {hasUploading ? <><LoaderCircle size={15} className="spin" /> 파일을 업로드하고 있습니다.</>
          : pendingArtifacts.length ? <><Paperclip size={15} /> 첨부파일 {pendingArtifacts.length}개가 다음 메시지에 포함됩니다.</>
            : <><Upload size={15} /> 파일을 끌어놓거나 이미지를 붙여넣을 수 있습니다.</>}
      </div>

      <form className="composer" onSubmit={submit}>
        <div className="composer__tools">
          <button type="button" className="icon-button" onClick={() => fileInputRef.current?.click()}><Plus size={18} /></button>
          <button type="button" className="icon-button" onClick={() => fileInputRef.current?.click()}><Paperclip size={17} /></button>
          <button type="button" className="icon-button" onClick={() => fileInputRef.current?.click()}><Image size={17} /></button>
          <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => onFiles(Array.from(event.target.files ?? []))} />
        </div>
        <textarea
          value={chat.activeConversation?.draft ?? ''}
          onChange={(event) => chat.saveDraft(event.target.value)}
          onPaste={(event) => {
            const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
            if (images.length) { event.preventDefault(); onFiles(images); }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={federation.active ? '교차 시스템 요청… 실행 대상은 위에서 선택' : chat.selectedSystem === 'hermes' && chat.activeAgent === '[Hermes] Lucy' ? 'Lucy에게 메시지… 필요하면 @Xixi @Lynn @Gemma' : `Message ${chat.activeAgent}...`}
          rows={1}
          disabled={chat.isStreaming}
        />
        <div className="composer__send">
          {chat.isStreaming ? <button type="button" className="stop-button" onClick={chat.stopStreaming} aria-label="응답 중단"><Square size={15} /></button> : <><button type="button" className="icon-button"><Mic size={18} /></button><button type="submit" className="send-button" aria-label="전송" disabled={hasUploading}><Send size={18} /></button></>}
        </div>
      </form>
      <p className="composer-footnote">
        {federation.active ? '선택한 시스템·에이전트는 병렬 실행되고, 승인된 Memory Capsule만 경계를 통과하며 Hermes Lucy가 마지막에 종합합니다.'
          : chat.selectedSystem === 'letta' ? 'Letta의 Lucy는 Conversation을 넘어 승인된 개인 기억을 유지합니다.'
            : chat.activeAgent === '[Hermes] Lucy' ? '명시적으로 멘션한 subagent의 원문을 보존하고 Lucy가 마지막에 종합합니다.'
              : `${chat.activeAgent}와 직접 대화 중입니다. 이 Conversation의 문맥은 다른 에이전트와 자동 공유되지 않습니다.`}
      </p>
    </div>
  );
}
