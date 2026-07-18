import { useState } from 'react';
import { Ban, Brain, Check, GitMerge, LoaderCircle, Network, Play, RefreshCw, X } from 'lucide-react';
import type {
  AgentRecord,
  CreateMemoryCapsuleInput,
  FederationConfigRecord,
  MemoryCapsuleRecord,
  MemoryCapsuleStatus,
  SystemId,
  WorkflowEventRecord,
  WorkflowRunRecord,
} from '../shared/contracts';

type Props = {
  agents: AgentRecord[];
  config: FederationConfigRecord | null;
  capsules: MemoryCapsuleRecord[];
  runs: WorkflowRunRecord[];
  selectedRun: WorkflowRunRecord | null;
  events: WorkflowEventRecord[];
  saving: boolean;
  resuming: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onCreateCapsule: (input: CreateMemoryCapsuleInput) => void;
  onSetCapsuleStatus: (capsuleId: string, status: MemoryCapsuleStatus) => void;
  onSelectRun: (runId: string) => void;
  onResume: (runId: string) => void;
  onRefresh: () => void;
  onClose: () => void;
};

export default function FederationPanel(props: Props) {
  const [source, setSource] = useState<SystemId>('hermes');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const active = props.config?.mode === 'federated';
  const target: SystemId = source === 'hermes' ? 'letta' : 'hermes';

  const createCapsule = () => {
    if (!title.trim() || !content.trim()) return;
    props.onCreateCapsule({
      sourceSystemId: source,
      targetSystemId: target,
      title: title.trim(),
      content: content.trim(),
      sourceMessageIds: [],
    });
    setTitle('');
    setContent('');
  };

  return (
    <aside className="federation-panel" aria-label="교차 시스템 워크플로">
      <header className="federation-panel__header">
        <div><strong>Federated Workflow</strong><span>Letta ↔ Hermes · explicit capsules</span></div>
        <button className="icon-button" onClick={props.onClose} aria-label="교차 시스템 패널 닫기"><X size={18} /></button>
      </header>

      <section>
        <div className="federation-section-title"><Network size={14} /> 실행 경계</div>
        <div className="federation-mode-row">
          <GitMerge size={20} />
          <div>
            <strong>{active ? '교차 시스템 활성' : '단일 시스템 Conversation'}</strong>
            <small>{active ? `${props.config?.coordinatorAgentId} 조정 · ${props.config?.memoryPolicy}` : '시스템 간 문맥은 공유되지 않습니다.'}</small>
          </div>
        </div>
        <div className="federation-actions">
          {!active ? <button onClick={props.onEnable} disabled={props.saving}><Network size={14} /> 활성화</button>
            : <button onClick={props.onDisable} disabled={props.saving || props.runs.some((run) => run.status === 'running' || run.status === 'paused')}><Ban size={14} /> 해제</button>}
          <button onClick={props.onRefresh}><RefreshCw size={14} /> 새로고침</button>
        </div>
        {active && <div className="federation-lanes">{props.agents.filter((agent) => agent.enabled).map((agent) => <span key={agent.id} className={`lane-chip lane-chip--${agent.systemId}`}>{agent.displayName}<small>{agent.systemId}</small></span>)}</div>}
      </section>

      <section>
        <div className="federation-section-title"><Brain size={14} /> Memory Capsules</div>
        {active && <div className="capsule-composer">
          <div><button className={source === 'hermes' ? 'is-active' : ''} onClick={() => setSource('hermes')}>Hermes → Letta</button><button className={source === 'letta' ? 'is-active' : ''} onClick={() => setSource('letta')}>Letta → Hermes</button></div>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Capsule 제목" />
          <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="상대 시스템에 전달할 승인 가능한 문맥" rows={3} />
          <button onClick={createCapsule} disabled={props.saving || !title.trim() || !content.trim()}>{props.saving ? <LoaderCircle size={14} className="spin" /> : <Brain size={14} />} Draft 생성</button>
        </div>}
        <div className="capsule-list">{props.capsules.length === 0 ? <p className="federation-empty">Capsule이 없습니다.</p> : props.capsules.map((capsule) => <article className={`capsule-card capsule-card--${capsule.status}`} key={capsule.id}>
          <header><div><strong>{capsule.title}</strong><span>{capsule.sourceSystemId} → {capsule.targetSystemId}</span></div><em>{capsule.status}</em></header>
          <p>{capsule.content}</p>
          <footer>{capsule.status === 'draft' && <button onClick={() => props.onSetCapsuleStatus(capsule.id, 'approved')}><Check size={13} /> 승인</button>}{capsule.status !== 'revoked' && <button onClick={() => props.onSetCapsuleStatus(capsule.id, 'revoked')}><Ban size={13} /> 철회</button>}</footer>
        </article>)}</div>
      </section>

      <section>
        <div className="federation-section-title"><GitMerge size={14} /> Workflow runs</div>
        <div className="workflow-run-list">{props.runs.map((run) => <button key={run.id} className={props.selectedRun?.id === run.id ? 'is-active' : ''} onClick={() => props.onSelectRun(run.id)}><span className={`run-dot run-dot--${run.status}`} /><span><strong>{run.status}</strong><small>{run.requestedAgentIds.join(' · ')}</small></span></button>)}</div>
        {props.selectedRun && <div className="workflow-detail">
          <header><strong>{props.selectedRun.id.slice(0, 12)}</strong>{(props.selectedRun.status === 'paused' || props.selectedRun.status === 'failed') && <button onClick={() => props.onResume(props.selectedRun!.id)} disabled={props.resuming}>{props.resuming ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />} 재개</button>}</header>
          {props.selectedRun.error && <p className="workflow-error">{props.selectedRun.error}</p>}
          {props.selectedRun.steps.map((step) => <div className={`workflow-step workflow-step--${step.status}`} key={step.id}><span className={`run-dot run-dot--${step.status}`} /><div><strong>{step.agentId}</strong><small>{step.systemId} · group {step.parallelGroup} · attempt {step.attempt}</small></div></div>)}
          <div className="workflow-events"><strong>Event ledger</strong>{props.events.slice(-30).map((event) => <div key={event.id}><span>{event.sequence}</span><em>{event.type}</em></div>)}</div>
        </div>}
      </section>
    </aside>
  );
}
