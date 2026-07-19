import Database from 'better-sqlite3';
import { accessSync, constants, existsSync, mkdirSync, statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { adapterHealth } from './adapters/index.js';
import { getBuildInfo } from './build-info.js';
import { securityConfigFromEnv } from './security.js';

type CheckLevel = 'info' | 'warning' | 'error';

type PreflightCheck = {
  name: string;
  ok: boolean;
  level: CheckLevel;
  detail: string;
};

type PreflightReport = {
  ok: boolean;
  strict: boolean;
  generatedAt: string;
  build: ReturnType<typeof getBuildInfo>;
  checks: PreflightCheck[];
  adapters: Awaited<ReturnType<typeof adapterHealth>>;
};

function boolEnv(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function addCheck(checks: PreflightCheck[], check: PreflightCheck) {
  checks.push(check);
}

function checkPositiveIntegerEnv(
  checks: PreflightCheck[],
  input: { name: string; checkName: string; fallback: number },
) {
  const raw = process.env[input.name]?.trim();
  const value = raw ? Number(raw) : input.fallback;
  const ok = Number.isFinite(value) && Number.isInteger(value) && value > 0;
  addCheck(checks, {
    name: input.checkName,
    ok,
    level: ok ? 'info' : 'error',
    detail: ok ? `${input.name}=${value}` : `${input.name} must be a positive integer`,
  });
}

function checkWritableDirectory(checks: PreflightCheck[], name: string, path: string) {
  const absolute = resolve(path);
  try {
    mkdirSync(absolute, { recursive: true });
    accessSync(absolute, constants.R_OK | constants.W_OK | constants.X_OK);
    addCheck(checks, { name, ok: true, level: 'info', detail: `${absolute} is writable` });
  } catch (error) {
    addCheck(checks, {
      name,
      ok: false,
      level: 'error',
      detail: error instanceof Error ? error.message : `${absolute} is not writable`,
    });
  }
}

function checkDisk(checks: PreflightCheck[], root: string) {
  const minimumBytes = numberEnv('CHAT_PREFLIGHT_MIN_FREE_BYTES', 2 * 1024 * 1024 * 1024);
  try {
    const stats = statfsSync(root);
    const freeBytes = stats.bavail * stats.bsize;
    addCheck(checks, {
      name: 'disk-free',
      ok: freeBytes >= minimumBytes,
      level: freeBytes >= minimumBytes ? 'info' : 'error',
      detail: `${Math.round(freeBytes / 1024 / 1024)} MiB free; minimum ${Math.round(minimumBytes / 1024 / 1024)} MiB`,
    });
  } catch (error) {
    addCheck(checks, {
      name: 'disk-free',
      ok: false,
      level: 'error',
      detail: error instanceof Error ? error.message : 'Unable to inspect disk space',
    });
  }
}

function checkDatabase(checks: PreflightCheck[], databasePath: string) {
  const absolute = resolve(databasePath);
  if (!existsSync(absolute)) {
    addCheck(checks, {
      name: 'database-integrity',
      ok: true,
      level: 'warning',
      detail: 'Database does not exist yet; it will be created on first start',
    });
    return;
  }
  try {
    const db = new Database(absolute, { readonly: true, fileMustExist: true });
    const integrity = db.pragma('quick_check', { simple: true });
    const conversationCount = (db.prepare('SELECT COUNT(*) AS count FROM conversations').get() as { count: number }).count;
    const messageCount = (db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count;
    db.close();
    addCheck(checks, {
      name: 'database-integrity',
      ok: integrity === 'ok',
      level: integrity === 'ok' ? 'info' : 'error',
      detail: `quick_check=${String(integrity)}; conversations=${conversationCount}; messages=${messageCount}`,
    });
  } catch (error) {
    addCheck(checks, {
      name: 'database-integrity',
      ok: false,
      level: 'error',
      detail: error instanceof Error ? error.message : 'Database integrity check failed',
    });
  }
}

function checkSecurity(checks: PreflightCheck[], strict: boolean) {
  const security = securityConfigFromEnv();
  const requireAuth = boolEnv('CHAT_PREFLIGHT_REQUIRE_AUTH', strict);
  const publicOrigin = process.env.CHAT_PUBLIC_ORIGIN?.trim();

  if (requireAuth && security.authMode === 'disabled') {
    addCheck(checks, {
      name: 'authentication',
      ok: false,
      level: 'error',
      detail: 'Authentication is disabled while strict preflight requires it',
    });
  } else {
    addCheck(checks, {
      name: 'authentication',
      ok: true,
      level: security.authMode === 'disabled' ? 'warning' : 'info',
      detail: `mode=${security.authMode}`,
    });
  }

  if (security.authMode === 'token' && !security.accessToken) {
    addCheck(checks, { name: 'token-config', ok: false, level: 'error', detail: 'CHAT_ACCESS_TOKEN is missing' });
  }
  if (security.authMode === 'cloudflare' && security.allowedEmails.size === 0) {
    addCheck(checks, { name: 'cloudflare-config', ok: false, level: 'error', detail: 'CHAT_ALLOWED_EMAILS is empty' });
  }
  if (strict && !publicOrigin) {
    addCheck(checks, { name: 'public-origin', ok: false, level: 'error', detail: 'CHAT_PUBLIC_ORIGIN is required in strict mode' });
  } else {
    addCheck(checks, {
      name: 'public-origin',
      ok: true,
      level: publicOrigin ? 'info' : 'warning',
      detail: publicOrigin || 'not configured',
    });
  }
}

export async function runPreflight(options?: { strict?: boolean }): Promise<PreflightReport> {
  const strict = options?.strict ?? false;
  const checks: PreflightCheck[] = [];
  const databasePath = process.env.CHAT_DB_PATH ?? './data/chat-v2.sqlite';
  const artifactRoot = process.env.CHAT_ARTIFACT_ROOT ?? './data/artifacts';
  const backupRoot = process.env.CHAT_BACKUP_ROOT ?? './data/backups';
  const dataRoot = dirname(resolve(databasePath));

  checkWritableDirectory(checks, 'database-directory', dataRoot);
  checkWritableDirectory(checks, 'artifact-directory', artifactRoot);
  checkWritableDirectory(checks, 'backup-directory', backupRoot);
  checkDisk(checks, dataRoot);
  checkDatabase(checks, databasePath);
  checkSecurity(checks, strict);
  checkPositiveIntegerEnv(checks, {
    name: 'CHAT_MAX_GENERATED_ARTIFACT_BYTES',
    checkName: 'generated-artifact-size-limit',
    fallback: 50 * 1024 * 1024,
  });
  checkPositiveIntegerEnv(checks, {
    name: 'CHAT_MAX_INLINE_GENERATED_ARTIFACT_PAYLOAD_BYTES',
    checkName: 'inline-generated-artifact-payload-limit',
    fallback: 10 * 1024 * 1024,
  });

  const adapters = await adapterHealth();
  const requireRealAdapters = boolEnv('CHAT_PREFLIGHT_REQUIRE_REAL_ADAPTERS', strict);
  for (const [system, health] of Object.entries(adapters)) {
    const realEnough = health.mode === 'http' && health.ok;
    const ok = health.ok && (!requireRealAdapters || realEnough);
    addCheck(checks, {
      name: `adapter-${system}`,
      ok,
      level: ok ? (health.mode === 'mock' ? 'warning' : 'info') : 'error',
      detail: `mode=${health.mode}; ${health.detail}; latency=${health.latencyMs ?? 0}ms`,
    });
  }

  return {
    ok: checks.every((check) => check.ok || check.level !== 'error'),
    strict,
    generatedAt: new Date().toISOString(),
    build: getBuildInfo(),
    checks,
    adapters,
  };
}

async function main() {
  const strict = process.argv.includes('--strict');
  const report = await runPreflight({ strict });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
