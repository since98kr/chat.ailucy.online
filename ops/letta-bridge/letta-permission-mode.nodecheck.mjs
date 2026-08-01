import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractRuntimeCapabilities,
  resolveRuntimePermissionMode,
} from './letta-cli-bridge.mjs';

async function settings(path, mode) {
  await mkdir(join(path, '.letta'), { recursive: true });
  await writeFile(join(path, '.letta', 'settings.json'), JSON.stringify({ permissions: { mode } }));
}

test('permission mode follows CLI, hierarchical settings, migration, and default precedence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'letta-permission-mode-'));
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  const xdg = join(root, 'xdg');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(join(xdg, 'letta'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(resolveRuntimePermissionMode({ cwd, homeDir: home, xdgConfigHome: xdg }), 'unrestricted');

  await writeFile(join(xdg, 'letta', 'settings.json'), JSON.stringify({ permissions: { mode: 'default' } }));
  await settings(home, 'acceptEdits');
  await settings(cwd, 'strict');
  await writeFile(join(cwd, '.letta', 'settings.local.json'), JSON.stringify({ permissions: { mode: 'standard' } }));
  assert.equal(resolveRuntimePermissionMode({ cwd, homeDir: home, xdgConfigHome: xdg }), 'standard');

  assert.equal(resolveRuntimePermissionMode({
    cwd,
    homeDir: home,
    xdgConfigHome: xdg,
    extraArgs: ['--permission-mode', 'acceptEdits'],
  }), 'acceptEdits');
  assert.equal(resolveRuntimePermissionMode({
    cwd,
    homeDir: home,
    xdgConfigHome: xdg,
    extraArgs: ['--permission-mode=strict'],
  }), 'strict');
  assert.equal(resolveRuntimePermissionMode({
    cwd,
    homeDir: home,
    xdgConfigHome: xdg,
    extraArgs: ['--permission-mode', 'strict', '--yolo'],
  }), 'unrestricted');

  await writeFile(join(cwd, '.letta', 'settings.local.json'), '{invalid json');
  assert.equal(resolveRuntimePermissionMode({ cwd, homeDir: home, xdgConfigHome: xdg }), 'strict');
});

test('headless capability uses its advertised mode and otherwise preserves the resolved startup mode', () => {
  assert.equal(extractRuntimeCapabilities({ permission_mode: 'strict' }, '', 'unrestricted').permissionMode, 'strict');
  assert.equal(extractRuntimeCapabilities({}, '', 'acceptEdits').permissionMode, 'acceptEdits');
});
