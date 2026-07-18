import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreflight } from './preflight.js';

const originalEnv = { ...process.env };
const directories: string[] = [];

function prepareEnvironment() {
  const directory = mkdtempSync(join(tmpdir(), 'chat-v2-preflight-'));
  directories.push(directory);
  process.env.CHAT_DB_PATH = join(directory, 'chat.sqlite');
  process.env.CHAT_ARTIFACT_ROOT = join(directory, 'artifacts');
  process.env.CHAT_BACKUP_ROOT = join(directory, 'backups');
  process.env.CHAT_PREFLIGHT_MIN_FREE_BYTES = '1';
  delete process.env.LETTA_BASE_URL;
  delete process.env.HERMES_BASE_URL;
  delete process.env.CHAT_PUBLIC_ORIGIN;
  delete process.env.CHAT_ACCESS_TOKEN;
  delete process.env.CHAT_ALLOWED_EMAILS;
  process.env.CHAT_AUTH_MODE = 'disabled';
  return directory;
}

afterEach(() => {
  process.env = { ...originalEnv };
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('deployment preflight', () => {
  it('passes a non-strict first-start environment while reporting mock adapters', async () => {
    prepareEnvironment();
    const report = await runPreflight({ strict: false });

    expect(report.ok).toBe(true);
    expect(report.adapters.letta.mode).toBe('mock');
    expect(report.adapters.hermes.mode).toBe('mock');
    expect(report.checks.find((check) => check.name === 'database-integrity')?.level).toBe('warning');
  });

  it('fails strict mode when authentication and real adapters are not configured', async () => {
    prepareEnvironment();
    const report = await runPreflight({ strict: true });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'authentication')?.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'adapter-letta')?.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'adapter-hermes')?.ok).toBe(false);
  });

  it('accepts explicit staging security while allowing mock adapters only when requested', async () => {
    prepareEnvironment();
    process.env.CHAT_AUTH_MODE = 'token';
    process.env.CHAT_ACCESS_TOKEN = 'test-secret';
    process.env.CHAT_PUBLIC_ORIGIN = 'https://chat-staging.ailucy.online';
    process.env.CHAT_PREFLIGHT_REQUIRE_REAL_ADAPTERS = 'false';

    const report = await runPreflight({ strict: true });

    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.name === 'authentication')?.ok).toBe(true);
    expect(report.checks.find((check) => check.name === 'public-origin')?.ok).toBe(true);
  });
});
