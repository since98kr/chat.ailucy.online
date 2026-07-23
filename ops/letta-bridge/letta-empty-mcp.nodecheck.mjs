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
    slash_commands: ['/skills'],
    permission_mode: 'acceptEdits',
    memfs_enabled: true,
    ...overrides,
  };
}

test('explicit empty MCP metadata is a valid advertised runtime state', () => {
  const capabilities = extractRuntimeCapabilities(runtimeInit({ mcp_servers: [] }));
  assert.equal(capabilities.mcpAdvertised, true);
  assert.deepEqual(capabilities.mcpServers, []);
  assert.doesNotThrow(() => validateRuntimeCapabilities(capabilities, baseConfig));
});

test('missing MCP metadata still fails closed', () => {
  const capabilities = extractRuntimeCapabilities(runtimeInit());
  assert.equal(capabilities.mcpAdvertised, false);
  assert.throws(
    () => validateRuntimeCapabilities(capabilities, baseConfig),
    /did not advertise MCP capability metadata/,
  );
});

test('named required MCP servers remain strict', () => {
  const capabilities = extractRuntimeCapabilities(runtimeInit({ mcp_servers: [] }));
  assert.throws(
    () => validateRuntimeCapabilities(capabilities, {
      ...baseConfig,
      requiredMcpServers: ['github'],
    }),
    /missing required MCP server: github/,
  );
});
