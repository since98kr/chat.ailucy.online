import { Bot, Check, Circle, LoaderCircle, Route, UserPlus, Users, X } from 'lucide-react';
import type {
  AgentRecord,
  ConversationParticipantRecord,
  RoutingPlanRecord,
  TeamActivityRecord,
} from '../shared/contracts';

export default function TeamPanel({
  agents,
  participants,
  activities,
  routing,
  saving,
  onToggleParticipant,
  onOpenDirect,
  onClose,
}: {
  agents: AgentRecord[];
  participants: ConversationParticipantRecord[];
  activities: TeamActivityRecord[];
  routing: RoutingPlanRecord | null;
  saving: boolean;
  onToggleParticipant: (agentId: string, enabled: boolean) => void;
  onOpenDirect: (agent: AgentRecord) => void;
  onClose: () => void;
}) {
  const participantIds = new Set(participants.map((participant) => participant.agentId));
  return (
    <aside className="team-panel team-panel--collaboration" aria-label="Hermes 팀 활동">
      <div className="team-panel__header">
        <div><strong>Hermes Team</strong><span>Conversation별 참여자와 원문 활동</span></div>
        <button className="icon-button" onClick={onClose} aria-label="팀 패널 닫기"><X size={18} /></button>
      </div>

      {routing && (
        <section className="team-routing">
          <div className="team-section-title"><Route size={14} /> 최근 라우팅</div>
          <strong>{routing.mode === 'team' ? 'Team collaboration' : routing.mode === 'direct' ? 'Direct agent' : 'Lucy lead'}</strong>
          <span>{routing.targetAgentIds.join(' → ')}</span>
          {routing.rejectedMentions.length > 0 && <small>인식하지 못한 멘션: {routing.rejectedMentions.join(', ')}</small>}
        </section>
      )}

      <section className="team-participants">
        <div className="team-section-title"><Users size={14} /> 현재 참여자</div>
        {participants.map((participant) => (
          <div className="team-member team-member--active" key={participant.agentId}>
            <div className="team-member__avatar"><Bot size={16} /></div>
            <div>
              <strong>{participant.agent.displayName}</strong>
              <span>{participant.agent.role} · {participant.role}</span>
            </div>
            <span className={`presence presence--${participant.state}`} title={participant.state} />
            <small>{participant.state}</small>
          </div>
        ))}
      </section>

      <section className="team-roster">
        <div className="team-section-title"><UserPlus size={14} /> 에이전트 등록부</div>
        {agents.map((agent) => {
          const included = participantIds.has(agent.id);
          const fixed = participants.some((participant) => participant.agentId === agent.id && participant.role === 'lead');
          return (
            <div className="roster-row" key={agent.id}>
              <button className="roster-identity" onClick={() => onOpenDirect(agent)} title={`${agent.displayName}와 직접 대화`}>
                <span className="mini-avatar"><Bot size={13} /></span>
                <span><strong>{agent.displayName}</strong><small>{agent.capabilities.slice(0, 2).join(' · ')}</small></span>
              </button>
              <button
                className={`participant-toggle ${included ? 'is-included' : ''}`}
                onClick={() => onToggleParticipant(agent.id, !included)}
                disabled={saving || fixed || !agent.enabled}
                aria-label={`${agent.displayName} ${included ? '참여 해제' : '참여 추가'}`}
              >
                {saving ? <LoaderCircle size={13} className="spin" /> : included ? <Check size={13} /> : <Circle size={13} />}
              </button>
            </div>
          );
        })}
      </section>

      <section className="team-activity-list">
        <div className="team-section-title"><Bot size={14} /> 활동 이력</div>
        {activities.length === 0 ? (
          <p className="team-empty">아직 팀 활동이 없습니다.</p>
        ) : activities.slice(0, 40).map((activity) => (
          <article className={`activity-row activity-row--${activity.type}`} key={activity.id}>
            <span className={`presence presence--${activity.status}`} />
            <div>
              <strong>{activity.agent.displayName}</strong>
              <p>{activity.summary}</p>
              <small>{formatActivityTime(activity.createdAt)} · {activity.type}</small>
            </div>
          </article>
        ))}
      </section>
    </aside>
  );
}

function formatActivityTime(value: string) {
  return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
