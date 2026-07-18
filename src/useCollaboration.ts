import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentRecord,
  ConversationParticipantRecord,
  RoutingPlanRecord,
  StreamEvent,
  SystemId,
  TeamActivityRecord,
} from '../shared/contracts';
import {
  listAgents,
  listParticipants,
  listTeamActivity,
  previewRouting,
  updateParticipants,
} from './api';
import { subscribeCollaborationEvents } from './collaboration-events';

export function useCollaboration(
  systemId: SystemId,
  conversationId: string | null,
  primaryAgentId: string | null,
) {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [participants, setParticipants] = useState<ConversationParticipantRecord[]>([]);
  const [activities, setActivities] = useState<TeamActivityRecord[]>([]);
  const [routing, setRouting] = useState<RoutingPlanRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextAgents = await listAgents(systemId);
      setAgents(nextAgents);
      if (!conversationId) {
        setParticipants([]);
        setActivities([]);
        return;
      }
      const [nextParticipants, nextActivities] = await Promise.all([
        listParticipants(conversationId),
        listTeamActivity(conversationId),
      ]);
      setParticipants(nextParticipants);
      setActivities(nextActivities);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '협업 상태를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [conversationId, systemId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => subscribeCollaborationEvents((event: StreamEvent) => {
    if (event.type === 'routing.resolved') {
      setRouting(event.routing);
      return;
    }
    if (event.type === 'participants.updated') {
      setParticipants(event.participants);
      return;
    }
    if (event.type === 'team.activity') {
      setActivities((current) => [event.activity, ...current.filter((item) => item.id !== event.activity.id)]);
    }
  }), []);

  const lead = useMemo(
    () => participants.find((participant) => participant.role === 'lead')?.agent
      ?? agents.find((agent) => agent.id === primaryAgentId)
      ?? agents.find((agent) => agent.isLead)
      ?? null,
    [agents, participants, primaryAgentId],
  );

  const participantIds = useMemo(() => new Set(participants.map((participant) => participant.agentId)), [participants]);

  const setParticipantEnabled = useCallback(async (agentId: string, enabled: boolean) => {
    if (!conversationId || !lead) return;
    setSaving(true);
    setError(null);
    try {
      const ids = new Set(participants.map((participant) => participant.agentId));
      if (enabled) ids.add(agentId);
      else if (agentId !== lead.id) ids.delete(agentId);
      const next = await updateParticipants(conversationId, {
        agentIds: [...ids].filter((id) => id !== lead.id),
        leadAgentId: lead.id,
      });
      setParticipants(next);
      setActivities(await listTeamActivity(conversationId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '참여자를 변경하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  }, [conversationId, lead, participants]);

  const preview = useCallback(async (content: string, targetAgentIds: string[] = []) => {
    if (!conversationId) return null;
    try {
      const next = await previewRouting(conversationId, content, targetAgentIds);
      setRouting(next);
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '라우팅을 확인하지 못했습니다.');
      return null;
    }
  }, [conversationId]);

  return {
    agents,
    participants,
    participantIds,
    activities,
    routing,
    lead,
    loading,
    saving,
    error,
    refresh,
    setParticipantEnabled,
    preview,
    clearError: () => setError(null),
  };
}
