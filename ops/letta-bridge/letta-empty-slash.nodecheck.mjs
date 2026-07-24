import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractRuntimeCapabilities,
  validateRuntimeCapabilities,
} from './letta-cli-bridge.mjs';

const baseConfig = {
  requireModel: true,
  requireTools: true,
  requireSkillSources: true,
  requireMcpServers: true,
  requireSlashCommands: true,
  requireMemfs: true,
  requiredTools: [],
  requiredSkillSources: [],
  requiredMcpServers: [],
  requiredSlashCommands: [],
};

function runtimeInit(overrides = {}) {
  return {
    type: 'system',
    subtype: 'init',
    model: 'openai/gpt-5.6',
    tools: ['Read'],
    skill_sources: ['project'],
    mcp_servers: [],
    permission_mode: 'acceptEdits',
    memfs_enabled: true,
    ...overrides,
  };
}

test('explicit empty slash command metadata is a valid advertised runtime state', () => {
  const capabilities = extractRuntimeCapabilities(runtimeInit({ slash_commands: [] }));
  assert.equal(capabilities.slashCommandsAdvertised, true);
  assert.deepEqual(capabilities.slashCommands, []);
  assert.doesNotThrow(() => validateRuntimeCapabilities(capabilities, baseConfig));
});

test('missing slash command metadata still fails closed', () => {
  const capabilities = extractRuntimeCapabilities(runtimeInit());
  assert.equal(capabilities.slashCommandsAdvertised, false);
  assert.throws(
    () => validateRuntimeCapabilities(capabilities, baseConfig),
    /did not advertise slash command capability metadata/,
  );
});

test('named required slash commands remain strict', () => {
  const capabilities = extractRuntimeCapabilities(runtimeInit({ slash_commands: [] }));
  assert.throws(
    () => validateRuntimeCapabilities(capabilities, {
      ...baseConfig,
      requiredSlashCommands: ['/skills'],
    }),
    /missing required slash command: \/skills/,
  );
});
