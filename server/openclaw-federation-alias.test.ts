import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatDatabase } from './database.js';
import { CollaborationService } from './collaboration.js';
import { resolveFederatedAgents } from './federated-runner.js';

describe('OpenClaw federated mention alias', () => {
  let directory: string;
  let database: ChatDatabase;
  let collaboration: CollaborationService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'chat-openclaw-alias-'));
    database = new ChatDatabase(join(directory, 'chat.sqlite'));
    collaboration = new CollaborationService(database);
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('routes @OpenClaw to canonical OpenClaw Lucy without enabling legacy Letta', () => {
    const canonical = collaboration.getAgent('[OpenClaw] Lucy');
    const legacy = collaboration.getAgent('[Letta] Lucy');
    expect(canonical?.shortName).toBe('OpenClaw');
    expect(canonical?.enabled).toBe(true);
    expect(legacy?.enabled).toBe(false);

    const conversation = database.createConversation('hermes', '[Hermes] Lucy', 'Federated alias');
    collaboration.initializeConversation(conversation.id, 'hermes', '[Hermes] Lucy');
    const resolved = resolveFederatedAgents(collaboration, conversation, '@OpenClaw 검토해줘', []);

    expect(resolved.requestedAgents.map((agent) => agent.id)).toContain('[OpenClaw] Lucy');
    expect(resolved.rejected).toEqual([]);
  });
});
