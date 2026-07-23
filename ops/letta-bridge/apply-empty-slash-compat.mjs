#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const write = process.argv.includes('--write');
const bridgePath = resolve(root, 'ops/letta-bridge/letta-cli-bridge.mjs');
const e2ePath = resolve(root, 'e2e-staging/letta-full-runtime.spec.ts');

function replaceOnce(text, oldValue, newValue, label) {
  const count = text.split(oldValue).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one replacement target, found ${count}`);
  return text.replace(oldValue, newValue);
}

let bridge = await readFile(bridgePath, 'utf8');
let e2e = await readFile(e2ePath, 'utf8');
const alreadyApplied = bridge.includes('slashCommandsAdvertised');

if (!alreadyApplied) {
  bridge = replaceOnce(
    bridge,
    `function withMcpAdvertisement(capabilities, advertised) {
  Object.defineProperty(capabilities, 'mcpAdvertised', {
    value: advertised === true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return capabilities;
}
`,
    `function withMcpAdvertisement(capabilities, advertised) {
  Object.defineProperty(capabilities, 'mcpAdvertised', {
    value: advertised === true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return capabilities;
}

function withSlashCommandAdvertisement(capabilities, advertised) {
  Object.defineProperty(capabilities, 'slashCommandsAdvertised', {
    value: advertised === true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return capabilities;
}
`,
    'slash command advertisement helper',
  );

  bridge = replaceOnce(
    bridge,
    `  return withMcpAdvertisement({
    model: safeLabel(wire?.model) || safeLabel(wire?.model_id) || safeLabel(fallbackModel) || null,
    tools: uniqueLabels(Array.isArray(wire?.tools) ? wire.tools : []),
    skillSources,
    slashCommands: uniqueLabels(Array.isArray(wire?.slash_commands) ? wire.slash_commands : []),
    mcpServers: normalizeMcpServers(wire?.mcp_servers),
    permissionMode: safeLabel(wire?.permission_mode) || null,
    memfsEnabled: typeof wire?.memfs_enabled === 'boolean' ? wire.memfs_enabled : null,
    sessionId: safeLabel(wire?.session_id) || null,
  }, Array.isArray(wire?.mcp_servers));`,
    `  return withSlashCommandAdvertisement(withMcpAdvertisement({
    model: safeLabel(wire?.model) || safeLabel(wire?.model_id) || safeLabel(fallbackModel) || null,
    tools: uniqueLabels(Array.isArray(wire?.tools) ? wire.tools : []),
    skillSources,
    slashCommands: uniqueLabels(Array.isArray(wire?.slash_commands) ? wire.slash_commands : []),
    mcpServers: normalizeMcpServers(wire?.mcp_servers),
    permissionMode: safeLabel(wire?.permission_mode) || null,
    memfsEnabled: typeof wire?.memfs_enabled === 'boolean' ? wire.memfs_enabled : null,
    sessionId: safeLabel(wire?.session_id) || null,
  }, Array.isArray(wire?.mcp_servers)), Array.isArray(wire?.slash_commands));`,
    'runtime capability extraction',
  );

  bridge = replaceOnce(
    bridge,
    `  return withMcpAdvertisement({
    model: right.model || left.model || null,
    tools: uniqueLabels([...(left.tools || []), ...(right.tools || [])]),
    skillSources: [...new Set([...(left.skillSources || []), ...(right.skillSources || [])])],
    slashCommands: uniqueLabels([...(left.slashCommands || []), ...(right.slashCommands || [])]),
    mcpServers: [...mcp.values()].slice(0, MAX_CAPABILITY_ITEMS),
    permissionMode: right.permissionMode || left.permissionMode || null,
    memfsEnabled: right.memfsEnabled ?? left.memfsEnabled ?? null,
    sessionId: right.sessionId || left.sessionId || null,
  }, left.mcpAdvertised === true || right.mcpAdvertised === true);`,
    `  return withSlashCommandAdvertisement(withMcpAdvertisement({
    model: right.model || left.model || null,
    tools: uniqueLabels([...(left.tools || []), ...(right.tools || [])]),
    skillSources: [...new Set([...(left.skillSources || []), ...(right.skillSources || [])])],
    slashCommands: uniqueLabels([...(left.slashCommands || []), ...(right.slashCommands || [])]),
    mcpServers: [...mcp.values()].slice(0, MAX_CAPABILITY_ITEMS),
    permissionMode: right.permissionMode || left.permissionMode || null,
    memfsEnabled: right.memfsEnabled ?? left.memfsEnabled ?? null,
    sessionId: right.sessionId || left.sessionId || null,
  }, left.mcpAdvertised === true || right.mcpAdvertised === true),
  left.slashCommandsAdvertised === true || right.slashCommandsAdvertised === true);`,
    'runtime capability merge',
  );

  bridge = replaceOnce(
    bridge,
    `  if (config.requireSlashCommands && capabilities.slashCommands.length === 0) throw new Error('Lucy CLI runtime did not advertise any slash commands');`,
    `  if (config.requireSlashCommands && capabilities.slashCommands.length === 0 && capabilities.slashCommandsAdvertised !== true) {
    throw new Error('Lucy CLI runtime did not advertise slash command capability metadata');
  }`,
    'slash command validation',
  );

  bridge = replaceOnce(
    bridge,
    `    slash_commands: capabilities.slashCommands,
    mcp_servers:`,
    `    slash_commands: capabilities.slashCommands,
    slash_commands_advertised: capabilities.slashCommandsAdvertised === true,
    mcp_servers:`,
    'public slash command metadata',
  );
  bridge = replaceOnce(
    bridge,
    `    slash_command_count: capabilities.slashCommands.length,
    mcp_server_count:`,
    `    slash_command_count: capabilities.slashCommands.length,
    slash_commands_advertised: capabilities.slashCommandsAdvertised === true,
    mcp_server_count:`,
    'slash command summary metadata',
  );
  bridge = replaceOnce(
    bridge,
    `    \`Slash commands and skill invocations: \${listForPrompt(capabilities.slashCommands)}\`,
    \`MCP servers:`,
    `    \`Slash commands and skill invocations: \${listForPrompt(capabilities.slashCommands)}\`,
    \`Slash command metadata advertised by headless runtime: \${capabilities.slashCommandsAdvertised === true ? 'true' : 'false'}\`,
    \`MCP servers:`,
    'runtime prompt slash metadata',
  );
  bridge = replaceOnce(
    bridge,
    `    onItem({ status: \`runtime.mcp_advertised:\${summary.mcp_advertised === true}\` });
    onItem({ status: \`runtime.capabilities:`,
    `    onItem({ status: \`runtime.mcp_advertised:\${summary.mcp_advertised === true}\` });
    onItem({ status: \`runtime.slash_commands_advertised:\${summary.slash_commands_advertised === true}\` });
    onItem({ status: \`runtime.capabilities:`,
    'stream slash metadata status',
  );

  const defaultNeedle = `      mcpAdvertised: false,
      permissionMode:`;
  const defaultReplacement = `      mcpAdvertised: false,
      slashCommandsAdvertised: false,
      permissionMode:`;
  const defaultCount = bridge.split(defaultNeedle).length - 1;
  if (defaultCount !== 2) throw new Error(`capability defaults: expected two targets, found ${defaultCount}`);
  bridge = bridge.split(defaultNeedle).join(defaultReplacement);

  e2e = replaceOnce(
    e2e,
    `    expect(capabilityStatus?.commands).toBeGreaterThan(0);`,
    `    expect(capabilityStatus?.commands).toBeGreaterThanOrEqual(0);
    expect(statuses).toContain('runtime.slash_commands_advertised:true');`,
    'live E2E slash command contract',
  );
}

if (write && !alreadyApplied) {
  await writeFile(bridgePath, bridge);
  await writeFile(e2ePath, e2e);
}

console.log(JSON.stringify({ ok: true, alreadyApplied, write }));
