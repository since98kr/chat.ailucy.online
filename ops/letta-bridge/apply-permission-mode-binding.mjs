#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = resolve('ops/letta-bridge/letta-cli-bridge.mjs');
const write = process.argv.includes('--write');
let source = await readFile(target, 'utf8');

function replaceOnce(before, after, label) {
  if (source.includes(after)) return;
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one source match, found ${count}`);
  source = source.replace(before, after);
}

replaceOnce(
  "import { timingSafeEqual } from 'node:crypto';\nimport { pathToFileURL } from 'node:url';",
  "import { timingSafeEqual } from 'node:crypto';\nimport { readFileSync } from 'node:fs';\nimport { join, resolve as resolvePath } from 'node:path';\nimport { pathToFileURL } from 'node:url';",
  'node imports',
);

replaceOnce(
  "const SKILL_SOURCES = new Set(['bundled', 'global', 'agent', 'project']);",
  "const SKILL_SOURCES = new Set(['bundled', 'global', 'agent', 'project']);\nconst VALID_PERMISSION_MODES = new Set(['unrestricted', 'standard', 'acceptEdits', 'strict']);\nconst DEFAULT_PERMISSION_MODE = 'unrestricted';",
  'permission constants',
);

replaceOnce(
  `function uniqueLabels(values) {
  return [...new Set(values.map(safeLabel).filter(Boolean))].slice(0, MAX_CAPABILITY_ITEMS);
}
`,
  `function uniqueLabels(values) {
  return [...new Set(values.map(safeLabel).filter(Boolean))].slice(0, MAX_CAPABILITY_ITEMS);
}

function migratePermissionMode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (VALID_PERMISSION_MODES.has(normalized)) return normalized;
  if (normalized === 'default') return 'standard';
  if (normalized === 'bypassPermissions' || normalized === 'fullAccess') return 'unrestricted';
  return null;
}

function permissionModeFromArgs(extraArgs) {
  if (extraArgs.includes('--yolo')) return 'unrestricted';
  for (let index = 0; index < extraArgs.length; index += 1) {
    const item = extraArgs[index];
    if (item === '--permission-mode') return migratePermissionMode(extraArgs[index + 1]);
    if (item.startsWith('--permission-mode=')) return migratePermissionMode(item.slice('--permission-mode='.length));
  }
  return null;
}

function permissionModeFromSettings(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return migratePermissionMode(parsed?.permissions?.mode);
  } catch {
    return null;
  }
}

export function resolveRuntimePermissionMode(options = {}) {
  const cwd = resolvePath(options.cwd || process.cwd());
  const homeDir = options.homeDir ?? process.env.HOME ?? '';
  const xdgConfigHome = options.xdgConfigHome
    ?? process.env.XDG_CONFIG_HOME
    ?? (homeDir ? join(homeDir, '.config') : '');
  const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
  const cliMode = permissionModeFromArgs(extraArgs);
  if (cliMode) return cliMode;

  const sources = [];
  if (xdgConfigHome) sources.push(join(xdgConfigHome, 'letta', 'settings.json'));
  if (homeDir) sources.push(join(homeDir, '.letta', 'settings.json'));
  sources.push(join(cwd, '.letta', 'settings.json'));
  sources.push(join(cwd, '.letta', 'settings.local.json'));

  let configuredMode = null;
  for (const sourcePath of sources) {
    const mode = permissionModeFromSettings(sourcePath);
    if (mode) configuredMode = mode;
  }
  return configuredMode || DEFAULT_PERMISSION_MODE;
}
`,
  'permission resolver',
);

replaceOnce(
  "export function extractRuntimeCapabilities(wire, fallbackModel = '') {",
  "export function extractRuntimeCapabilities(wire, fallbackModel = '', fallbackPermissionMode = '') {",
  'capability signature',
);

replaceOnce(
  "    permissionMode: safeLabel(wire?.permission_mode) || null,",
  "    permissionMode: safeLabel(wire?.permission_mode) || safeLabel(fallbackPermissionMode) || null,",
  'capability permission fallback',
);

replaceOnce(
  `    this.toolNames = new Map();
    this.capabilities = {
      model: safeLabel(config.runtimeModelId),
      tools: [], skillSources: [], slashCommands: [], mcpServers: [],
      mcpAdvertised: false,
      slashCommandsAdvertised: false,
      permissionMode: null, memfsEnabled: null, sessionId: null,
    };`,
  `    this.toolNames = new Map();
    const startupPermissionMode = resolveRuntimePermissionMode({
      cwd: config.cwd,
      extraArgs: config.extraArgs,
    });
    this.capabilities = {
      model: safeLabel(config.runtimeModelId),
      tools: [], skillSources: [], slashCommands: [], mcpServers: [],
      mcpAdvertised: false,
      slashCommandsAdvertised: false,
      permissionMode: startupPermissionMode, memfsEnabled: null, sessionId: null,
    };`,
  'session startup permission',
);

replaceOnce(
  "      this.capabilities = mergeCapabilities(this.capabilities, extractRuntimeCapabilities(wire, this.config.runtimeModelId));",
  `      this.capabilities = mergeCapabilities(this.capabilities, extractRuntimeCapabilities(
        wire,
        this.config.runtimeModelId,
        this.capabilities.permissionMode,
      ));`,
  'headless permission fallback',
);

replaceOnce(
  `      model: safeLabel(this.config.runtimeModelId),
      tools: [], skillSources: [], slashCommands: [], mcpServers: [],
      mcpAdvertised: false,
      slashCommandsAdvertised: false,
      permissionMode: null, memfsEnabled: null, sessionId: null,
    });`,
  `      model: safeLabel(this.config.runtimeModelId),
      tools: [], skillSources: [], slashCommands: [], mcpServers: [],
      mcpAdvertised: false,
      slashCommandsAdvertised: false,
      permissionMode: resolveRuntimePermissionMode({
        cwd: this.config.cwd,
        extraArgs: this.config.extraArgs,
      }),
      memfsEnabled: null, sessionId: null,
    });`,
  'health permission fallback',
);

if (!source.includes('export function resolveRuntimePermissionMode')) {
  throw new Error('permission resolver was not installed');
}
if (!source.includes('this.capabilities.permissionMode')) {
  throw new Error('headless permission fallback was not installed');
}

if (write) {
  await writeFile(target, source);
  console.log('Applied Letta permission-mode binding.');
} else {
  console.log('Letta permission-mode binding validates.');
}
