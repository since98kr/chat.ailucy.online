import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const workflowPath = join(root, '.github/workflows/apply-letta-empty-mcp-patch.yml');
const targets = [
  'ops/letta-bridge/letta-cli-bridge.mjs',
  'e2e-staging/letta-full-runtime.spec.ts',
  '.github/workflows/deploy-staging.yml',
];

test('MCP compatibility edits produce validated Git blob payloads', async (t) => {
  const workflow = await readFile(workflowPath, 'utf8');
  const match = workflow.match(/python3 - <<'PY'\n([\s\S]*?)\n {10}PY/);
  assert.ok(match, 'embedded compatibility edit script was not found');
  let python = match[1]
    .split('\n')
    .map((line) => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n');

  const ambiguous = `replace_once(bridge, "      tools: [], skillSources: [], slashCommands: [], mcpServers: [],\\n      permissionMode:", "      tools: [], skillSources: [], slashCommands: [], mcpServers: [],\\n      mcpAdvertised: false,\\n      permissionMode:")`;
  const redundant = `replace_once(bridge, "      tools: [], skillSources: [], slashCommands: [], mcpServers: [],\\n      permissionMode: null, memfsEnabled: null, sessionId: null,\\n    });", "      tools: [], skillSources: [], slashCommands: [], mcpServers: [],\\n      mcpAdvertised: false,\\n      permissionMode: null, memfsEnabled: null, sessionId: null,\\n    });")`;
  assert.equal(python.split(ambiguous).length - 1, 1);
  assert.equal(python.split(redundant).length - 1, 1);
  python = python.replace(ambiguous, `text = Path(bridge).read_text(encoding='utf-8')\nneedle = "      tools: [], skillSources: [], slashCommands: [], mcpServers: [],\\n      permissionMode:"\nreplacement = "      tools: [], skillSources: [], slashCommands: [], mcpServers: [],\\n      mcpAdvertised: false,\\n      permissionMode:"\nif text.count(needle) != 2:\n    raise SystemExit(f'{bridge}: expected two capability defaults, found {text.count(needle)}')\nPath(bridge).write_text(text.replace(needle, replacement), encoding='utf-8')`);
  python = python.replace(redundant, '');

  const sandbox = await mkdtemp(join(tmpdir(), 'chat-mcp-patch-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  for (const relative of targets) {
    const destination = join(sandbox, relative);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, relative), destination);
  }
  const script = join(sandbox, 'apply.py');
  await writeFile(script, `${python}\n`, 'utf8');
  const applied = spawnSync('python3', [script], { cwd: sandbox, encoding: 'utf8' });
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);

  const checked = spawnSync(process.execPath, ['--check', join(sandbox, targets[0])], { encoding: 'utf8' });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);

  const bridge = await import(`${pathToFileURL(join(sandbox, targets[0])).href}?test=${Date.now()}`);
  const advertisedEmpty = bridge.extractRuntimeCapabilities({
    type: 'system',
    subtype: 'init',
    model: 'openai/gpt-5.6',
    tools: ['Read'],
    skill_sources: ['project'],
    slash_commands: ['/skills'],
    mcp_servers: [],
    permission_mode: 'acceptEdits',
    memfs_enabled: true,
  });
  assert.equal(advertisedEmpty.mcpAdvertised, true);
  assert.deepEqual(advertisedEmpty.mcpServers, []);

  const config = {
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
  assert.doesNotThrow(() => bridge.validateRuntimeCapabilities(advertisedEmpty, config));

  const missingMetadata = bridge.extractRuntimeCapabilities({
    model: 'openai/gpt-5.6',
    tools: ['Read'],
    skill_sources: ['project'],
    slash_commands: ['/skills'],
    permission_mode: 'acceptEdits',
    memfs_enabled: true,
  });
  assert.equal(missingMetadata.mcpAdvertised, false);
  assert.throws(
    () => bridge.validateRuntimeCapabilities(missingMetadata, config),
    /did not advertise MCP capability metadata/,
  );
  assert.throws(
    () => bridge.validateRuntimeCapabilities(advertisedEmpty, { ...config, requiredMcpServers: ['github'] }),
    /missing required MCP server: github/,
  );

  for (const relative of targets) {
    const payload = await readFile(join(sandbox, relative));
    console.log(`CHAT_MCP_PATCH_BEGIN:${relative}`);
    console.log(payload.toString('base64'));
    console.log(`CHAT_MCP_PATCH_END:${relative}`);
  }
});
