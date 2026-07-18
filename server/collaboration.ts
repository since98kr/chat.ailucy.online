import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  AgentRecord,
  ConversationParticipantRecord,
  ConversationRecord,
  ParticipantRole,
  ParticipantState,
  RoutingPlanRecord,
  SystemId,
  TeamActivityRecord,
  TeamActivityType,
  UpdateParticipantsInput,
} from '../shared/contracts.js';
import type { ChatDatabase } from './database.js';

type AgentRow = {
  id: string;
  system_id: SystemId;
  display_name: string;
  short_name: string;
  role: string;
  description: string;
  capabilities_json: string;
  enabled: number;
  direct_chat_enabled: number;
  is_lead: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type ParticipantRow = {
  conversation_id: string;
  agent_id: string;
  participant_role: ParticipantRole;
  participant_state: ParticipantState;
  added_at: string;
  updated_at: string;
} & AgentRow;

type ActivityRow = {
  activity_id: string;
  conversation_id: string;
  agent_id: string;
  activity_type: TeamActivityType;
  activity_status: ParticipantState;
  summary: string;
  source_message_id: string | null;
  output_message_id: string | null;
  activity_created_at: string;
} & AgentRow;

const timestamp = () => new Date().toISOString();

const seedAgents: Array<Omit<AgentRecord, 'createdAt' | 'updatedAt'>> = [
  {
    id: '[Letta] Lucy',
    systemId: 'letta',
    displayName: '[Letta] Lucy',
    shortName: 'Lucy',
    role: 'Personal AI',
    description: 'Persistent personal Lucy with approved long-term memory.',
    capabilities: ['personal-memory', 'planning', 'writing', 'conversation'],
    enabled: true,
    directChatEnabled: true,
    isLead: true,
    sortOrder: 10,
  },
  {
    id: '[Hermes] Lucy',
    systemId: 'hermes',
    displayName: '[Hermes] Lucy',
    shortName: 'Lucy',
    role: 'Lead Orchestrator',
    description: 'Conversation owner responsible for synthesis, routing, and final response.',
    capabilities: ['orchestration', 'planning', 'synthesis', 'decision-support'],
    enabled: true,
    directChatEnabled: true,
    isLead: true,
    sortOrder: 10,
  },
  {
    id: 'Xixi',
    systemId: 'hermes',
    displayName: 'Xixi',
    shortName: 'Xixi',
    role: 'Implementation',
    description: 'Implementation specialist for code, integration, and technical delivery.',
    capabilities: ['implementation', 'coding', 'integration', 'debugging'],
    enabled: true,
    directChatEnabled: true,
    isLead: false,
    sortOrder: 20,
  },
  {
    id: 'Lynn',
    systemId: 'hermes',
    displayName: 'Lynn',
    shortName: 'Lynn',
    role: 'Independent Review',
    description: 'Clean-room reviewer for critique, risk discovery, and independent verification.',
    capabilities: ['review', 'risk-analysis', 'verification', 'critique'],
    enabled: true,
    directChatEnabled: true,
    isLead: false,
    sortOrder: 30,
  },
  {
    id: 'Gemma',
    systemId: 'hermes',
    displayName: 'Gemma',
    shortName: 'Gemma',
    role: 'Multimodal Analysis',
    description: 'Multimodal specialist for images, video, documents, and visual evidence.',
    capabilities: ['multimodal', 'image-analysis', 'video-analysis', 'document-analysis'],
    enabled: true,
    directChatEnabled: true,
    isLead: false,
    sortOrder: 40,
  },
];

function mapAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    systemId: row.system_id,
    displayName: row.display_name,
    shortName: row.short_name,
    role: row.role,
    description: row.description,
    capabilities: JSON.parse(row.capabilities_json) as string[],
    enabled: row.enabled === 1,
    directChatEnabled: row.direct_chat_enabled === 1,
    isLead: row.is_lead === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapParticipant(row: ParticipantRow): ConversationParticipantRecord {
  return {
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    role: row.participant_role,
    state: row.participant_state,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
    agent: mapAgent(row),
  };
}

function mapActivity(row: ActivityRow): TeamActivityRecord {
  return {
    id: row.activity_id,
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    type: row.activity_type,
    status: row.activity_status,
    summary: row.summary,
    sourceMessageId: row.source_message_id,
    outputMessageId: row.output_message_id,
    createdAt: row.activity_created_at,
    agent: mapAgent(row),
  };
}

export class CollaborationService {
  readonly database: ChatDatabase;
  readonly db: Database.Database;

  constructor(database: ChatDatabase) {
    this.database = database;
    this.db = database.db;
    this.migrate();
    this.seedAgents();
    this.backfillConversations();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        system_id TEXT NOT NULL CHECK (system_id IN ('letta', 'hermes')),
        display_name TEXT NOT NULL,
        short_name TEXT NOT NULL,
        role TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        direct_chat_enabled INTEGER NOT NULL DEFAULT 0 CHECK (direct_chat_enabled IN (0, 1)),
        is_lead INTEGER NOT NULL DEFAULT 0 CHECK (is_lead IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 100,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_participants (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        role TEXT NOT NULL CHECK (role IN ('lead', 'participant', 'observer')),
        state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('active', 'idle', 'working', 'reviewing', 'blocked', 'offline')),
        added_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS team_activities (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        type TEXT NOT NULL CHECK (type IN ('joined', 'left', 'assigned', 'status', 'output', 'completed', 'failed')),
        status TEXT NOT NULL CHECK (status IN ('active', 'idle', 'working', 'reviewing', 'blocked', 'offline')),
        summary TEXT NOT NULL DEFAULT '',
        source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        output_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agents_system_order ON agents(system_id, sort_order, display_name);
      CREATE INDEX IF NOT EXISTS idx_participants_conversation ON conversation_participants(conversation_id, role, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_team_activities_conversation ON team_activities(conversation_id, created_at DESC);
    `);
  }

  private seedAgents() {
    const statement = this.db.prepare(`
      INSERT INTO agents (
        id, system_id, display_name, short_name, role, description,
        capabilities_json, enabled, direct_chat_enabled, is_lead,
        sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        system_id = excluded.system_id,
        display_name = excluded.display_name,
        short_name = excluded.short_name,
        role = excluded.role,
        description = excluded.description,
        capabilities_json = excluded.capabilities_json,
        direct_chat_enabled = excluded.direct_chat_enabled,
        is_lead = excluded.is_lead,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `);
    const transaction = this.db.transaction(() => {
      for (const agent of seedAgents) {
        const createdAt = timestamp();
        statement.run(
          agent.id,
          agent.systemId,
          agent.displayName,
          agent.shortName,
          agent.role,
          agent.description,
          JSON.stringify(agent.capabilities),
          agent.enabled ? 1 : 0,
          agent.directChatEnabled ? 1 : 0,
          agent.isLead ? 1 : 0,
          agent.sortOrder,
          createdAt,
          createdAt,
        );
      }
    });
    transaction();
  }

  private backfillConversations() {
    const rows = this.db.prepare('SELECT id, system_id, agent_id FROM conversations').all() as Array<{
      id: string;
      system_id: SystemId;
      agent_id: string;
    }>;
    const transaction = this.db.transaction(() => {
      for (const row of rows) this.initializeConversation(row.id, row.system_id, row.agent_id, false);
    });
    transaction();
  }

  listAgents(systemId?: SystemId) {
    const rows = systemId
      ? this.db.prepare('SELECT * FROM agents WHERE system_id = ? ORDER BY sort_order, display_name').all(systemId)
      : this.db.prepare('SELECT * FROM agents ORDER BY system_id, sort_order, display_name').all();
    return (rows as AgentRow[]).map(mapAgent);
  }

  getAgent(agentId: string) {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as AgentRow | undefined;
    return row ? mapAgent(row) : null;
  }

  getLeadAgent(systemId: SystemId) {
    const row = this.db.prepare(`
      SELECT * FROM agents WHERE system_id = ? AND enabled = 1 AND is_lead = 1
      ORDER BY sort_order LIMIT 1
    `).get(systemId) as AgentRow | undefined;
    return row ? mapAgent(row) : null;
  }

  initializeConversation(conversationId: string, systemId: SystemId, primaryAgentId: string, recordActivity = true) {
    const primary = this.getAgent(primaryAgentId) ?? this.getLeadAgent(systemId);
    if (!primary || primary.systemId !== systemId || !primary.enabled) {
      throw new Error(`Agent ${primaryAgentId} is not available for ${systemId}`);
    }
    const lead = this.getLeadAgent(systemId);
    const ids = new Set([primary.id]);
    if (lead && systemId === 'hermes' && primary.id !== lead.id) ids.add(lead.id);
    const createdAt = timestamp();
    const statement = this.db.prepare(`
      INSERT INTO conversation_participants (conversation_id, agent_id, role, state, added_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
      ON CONFLICT(conversation_id, agent_id) DO NOTHING
    `);
    for (const agentId of ids) {
      const role: ParticipantRole = agentId === primary.id ? 'lead' : 'observer';
      const result = statement.run(conversationId, agentId, role, createdAt, createdAt);
      if (recordActivity && result.changes) {
        this.addActivity({
          conversationId,
          agentId,
          type: 'joined',
          status: 'active',
          summary: `${agentId} joined this Conversation.`,
        });
      }
    }
    return this.listParticipants(conversationId);
  }

  cloneParticipants(sourceConversationId: string, targetConversationId: string) {
    const participants = this.listParticipants(sourceConversationId);
    const createdAt = timestamp();
    const statement = this.db.prepare(`
      INSERT INTO conversation_participants (conversation_id, agent_id, role, state, added_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, agent_id) DO UPDATE SET role = excluded.role, state = excluded.state, updated_at = excluded.updated_at
    `);
    const transaction = this.db.transaction(() => {
      for (const participant of participants) {
        statement.run(targetConversationId, participant.agentId, participant.role, 'idle', createdAt, createdAt);
      }
    });
    transaction();
    return this.listParticipants(targetConversationId);
  }

  listParticipants(conversationId: string) {
    const rows = this.db.prepare(`
      SELECT
        cp.conversation_id,
        cp.agent_id,
        cp.role AS participant_role,
        cp.state AS participant_state,
        cp.added_at,
        cp.updated_at,
        a.*
      FROM conversation_participants cp
      JOIN agents a ON a.id = cp.agent_id
      WHERE cp.conversation_id = ?
      ORDER BY CASE cp.role WHEN 'lead' THEN 0 WHEN 'participant' THEN 1 ELSE 2 END, a.sort_order
    `).all(conversationId) as ParticipantRow[];
    return rows.map(mapParticipant);
  }

  updateParticipants(conversation: ConversationRecord, input: UpdateParticipantsInput) {
    const available = new Map(this.listAgents(conversation.systemId).filter((agent) => agent.enabled).map((agent) => [agent.id, agent]));
    const primary = available.get(input.leadAgentId ?? conversation.agentId);
    if (!primary || !primary.directChatEnabled) throw new Error('Selected lead agent is unavailable');
    const requested = [...new Set([primary.id, ...input.agentIds])];
    for (const agentId of requested) {
      if (!available.has(agentId)) throw new Error(`Agent ${agentId} is unavailable for this Conversation`);
    }
    const current = new Map(this.listParticipants(conversation.id).map((item) => [item.agentId, item]));
    const updatedAt = timestamp();
    const transaction = this.db.transaction(() => {
      for (const [agentId] of current) {
        if (!requested.includes(agentId)) {
          this.db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ? AND agent_id = ?')
            .run(conversation.id, agentId);
          this.addActivity({
            conversationId: conversation.id,
            agentId,
            type: 'left',
            status: 'offline',
            summary: `${agentId} was removed from this Conversation.`,
          });
        }
      }
      for (const agentId of requested) {
        const role: ParticipantRole = agentId === primary.id ? 'lead' : 'participant';
        const result = this.db.prepare(`
          INSERT INTO conversation_participants (conversation_id, agent_id, role, state, added_at, updated_at)
          VALUES (?, ?, ?, 'idle', ?, ?)
          ON CONFLICT(conversation_id, agent_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
        `).run(conversation.id, agentId, role, updatedAt, updatedAt);
        if (!current.has(agentId) && result.changes) {
          this.addActivity({
            conversationId: conversation.id,
            agentId,
            type: 'joined',
            status: 'idle',
            summary: `${agentId} was added to this Conversation.`,
          });
        }
      }
    });
    transaction();
    return this.listParticipants(conversation.id);
  }

  setParticipantState(conversationId: string, agentId: string, state: ParticipantState, summary?: string) {
    const result = this.db.prepare(`
      UPDATE conversation_participants SET state = ?, updated_at = ?
      WHERE conversation_id = ? AND agent_id = ?
    `).run(state, timestamp(), conversationId, agentId);
    if (!result.changes) return null;
    if (summary) {
      this.addActivity({ conversationId, agentId, type: 'status', status: state, summary });
    }
    return this.listParticipants(conversationId).find((participant) => participant.agentId === agentId) ?? null;
  }

  addActivity(input: {
    conversationId: string;
    agentId: string;
    type: TeamActivityType;
    status: ParticipantState;
    summary: string;
    sourceMessageId?: string | null;
    outputMessageId?: string | null;
  }) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO team_activities (
        id, conversation_id, agent_id, type, status, summary,
        source_message_id, output_message_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.conversationId,
      input.agentId,
      input.type,
      input.status,
      input.summary,
      input.sourceMessageId ?? null,
      input.outputMessageId ?? null,
      timestamp(),
    );
    return this.getActivity(id)!;
  }

  getActivity(id: string) {
    const row = this.db.prepare(`
      SELECT
        ta.id AS activity_id,
        ta.conversation_id,
        ta.agent_id,
        ta.type AS activity_type,
        ta.status AS activity_status,
        ta.summary,
        ta.source_message_id,
        ta.output_message_id,
        ta.created_at AS activity_created_at,
        a.*
      FROM team_activities ta JOIN agents a ON a.id = ta.agent_id
      WHERE ta.id = ?
    `).get(id) as ActivityRow | undefined;
    return row ? mapActivity(row) : null;
  }

  listActivities(conversationId: string, limit = 100) {
    const rows = this.db.prepare(`
      SELECT
        ta.id AS activity_id,
        ta.conversation_id,
        ta.agent_id,
        ta.type AS activity_type,
        ta.status AS activity_status,
        ta.summary,
        ta.source_message_id,
        ta.output_message_id,
        ta.created_at AS activity_created_at,
        a.*
      FROM team_activities ta JOIN agents a ON a.id = ta.agent_id
      WHERE ta.conversation_id = ?
      ORDER BY ta.created_at DESC, ta.rowid DESC
      LIMIT ?
    `).all(conversationId, Math.min(Math.max(limit, 1), 500)) as ActivityRow[];
    return rows.map(mapActivity);
  }

  private mentionTokens(content: string) {
    return [...content.matchAll(/@([A-Za-z0-9가-힣_-]+)/gu)].map((match) => match[1].toLowerCase());
  }

  resolveRouting(conversation: ConversationRecord, content: string, explicitTargetAgentIds: string[] = []): RoutingPlanRecord {
    const agents = this.listAgents(conversation.systemId).filter((agent) => agent.enabled);
    const byId = new Map(agents.map((agent) => [agent.id.toLowerCase(), agent]));
    const byShortName = new Map(agents.map((agent) => [agent.shortName.toLowerCase(), agent]));
    const lead = agents.find((agent) => agent.isLead) ?? agents[0];
    if (!lead) throw new Error(`No enabled agent is registered for ${conversation.systemId}`);
    const primary = agents.find((agent) => agent.id === conversation.agentId) ?? lead;

    if (conversation.systemId === 'letta' || primary.id !== lead.id) {
      return {
        mode: 'direct',
        leadAgentId: primary.id,
        mentionedAgentIds: [],
        targetAgentIds: [primary.id],
        rejectedMentions: [],
      };
    }

    const rejectedMentions: string[] = [];
    const mentioned = new Set<string>();
    for (const token of this.mentionTokens(content)) {
      const agent = byShortName.get(token) ?? byId.get(token);
      if (!agent || agent.systemId !== conversation.systemId || !agent.directChatEnabled) rejectedMentions.push(token);
      else mentioned.add(agent.id);
    }
    for (const agentId of explicitTargetAgentIds) {
      const agent = agents.find((candidate) => candidate.id === agentId);
      if (!agent || !agent.directChatEnabled) rejectedMentions.push(agentId);
      else mentioned.add(agent.id);
    }
    mentioned.delete(lead.id);

    if (mentioned.size === 0) {
      return {
        mode: 'lead',
        leadAgentId: lead.id,
        mentionedAgentIds: [],
        targetAgentIds: [lead.id],
        rejectedMentions,
      };
    }

    const targetAgentIds = [...mentioned, lead.id];
    return {
      mode: 'team',
      leadAgentId: lead.id,
      mentionedAgentIds: [...mentioned],
      targetAgentIds,
      rejectedMentions,
    };
  }

  ensureRoutingParticipants(conversation: ConversationRecord, routing: RoutingPlanRecord) {
    const existing = new Set(this.listParticipants(conversation.id).map((participant) => participant.agentId));
    const addedAt = timestamp();
    for (const agentId of routing.targetAgentIds) {
      if (existing.has(agentId)) continue;
      this.db.prepare(`
        INSERT INTO conversation_participants (conversation_id, agent_id, role, state, added_at, updated_at)
        VALUES (?, ?, ?, 'idle', ?, ?)
      `).run(
        conversation.id,
        agentId,
        agentId === routing.leadAgentId ? 'lead' : 'participant',
        addedAt,
        addedAt,
      );
      this.addActivity({
        conversationId: conversation.id,
        agentId,
        type: 'joined',
        status: 'idle',
        summary: `${agentId} joined after an explicit mention or routing selection.`,
      });
    }
    return this.listParticipants(conversation.id);
  }
}
