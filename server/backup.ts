import Database from 'better-sqlite3';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type BackupFile = {
  path: string;
  sizeBytes: number;
  sha256: string;
};

export type BackupManifest = {
  formatVersion: 1;
  createdAt: string;
  database: BackupFile;
  artifacts: BackupFile[];
  artifactCount: number;
  artifactBytes: number;
};

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function sha256(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walkFiles(root: string, relative = ''): BackupFile[] {
  const current = join(root, relative);
  if (!existsSync(current)) return [];
  const entries = readdirSync(current, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const nextRelative = join(relative, entry.name);
    if (entry.isDirectory()) return walkFiles(root, nextRelative);
    if (!entry.isFile()) return [];
    const absolute = join(root, nextRelative);
    return [{ path: nextRelative, sizeBytes: statSync(absolute).size, sha256: sha256(absolute) }];
  });
}

function pruneBackups(root: string, retention: number) {
  if (!existsSync(root)) return [];
  const directories = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.tmp-'))
    .map((entry) => ({ name: entry.name, path: join(root, entry.name), mtime: statSync(join(root, entry.name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
  const removed = directories.slice(Math.max(0, retention)).map((entry) => entry.name);
  for (const name of removed) rmSync(join(root, name), { recursive: true, force: true });
  return removed;
}

export async function createBackup(options?: {
  databasePath?: string;
  artifactRoot?: string;
  backupRoot?: string;
  retention?: number;
}) {
  const databasePath = resolve(options?.databasePath ?? process.env.CHAT_DB_PATH ?? './data/chat-v2.sqlite');
  const artifactRoot = resolve(options?.artifactRoot ?? process.env.CHAT_ARTIFACT_ROOT ?? './data/artifacts');
  const backupRoot = resolve(options?.backupRoot ?? process.env.CHAT_BACKUP_ROOT ?? './data/backups');
  const retention = Math.max(1, options?.retention ?? Number(process.env.CHAT_BACKUP_RETENTION ?? 10));
  if (!existsSync(databasePath)) throw new Error(`Database does not exist: ${databasePath}`);

  mkdirSync(backupRoot, { recursive: true });
  const id = safeTimestamp();
  const tempDirectory = join(backupRoot, `.tmp-${id}`);
  const finalDirectory = join(backupRoot, id);
  rmSync(tempDirectory, { recursive: true, force: true });
  mkdirSync(tempDirectory, { recursive: true });

  const backupDatabasePath = join(tempDirectory, 'chat-v2.sqlite');
  const source = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(backupDatabasePath);
  } finally {
    source.close();
  }

  const backupArtifactRoot = join(tempDirectory, 'artifacts');
  if (existsSync(artifactRoot)) cpSync(artifactRoot, backupArtifactRoot, { recursive: true, preserveTimestamps: true });
  else mkdirSync(backupArtifactRoot, { recursive: true });

  const artifacts = walkFiles(backupArtifactRoot);
  const manifest: BackupManifest = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    database: {
      path: basename(backupDatabasePath),
      sizeBytes: statSync(backupDatabasePath).size,
      sha256: sha256(backupDatabasePath),
    },
    artifacts,
    artifactCount: artifacts.length,
    artifactBytes: artifacts.reduce((total, file) => total + file.sizeBytes, 0),
  };
  writeFileSync(join(tempDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(tempDirectory, finalDirectory);
  const removed = pruneBackups(backupRoot, retention);
  return { id, directory: finalDirectory, manifest, removed };
}

export function verifyBackup(directory: string) {
  const resolved = resolve(directory);
  const manifestPath = join(resolved, 'manifest.json');
  if (!existsSync(manifestPath)) return { ok: false, errors: ['manifest.json is missing'] };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
  const errors: string[] = [];
  const databasePath = join(resolved, manifest.database.path);
  if (!existsSync(databasePath)) errors.push(`${manifest.database.path} is missing`);
  else {
    if (statSync(databasePath).size !== manifest.database.sizeBytes) errors.push('database size mismatch');
    if (sha256(databasePath) !== manifest.database.sha256) errors.push('database checksum mismatch');

    let verificationDirectory: string | null = null;
    try {
      verificationDirectory = mkdtempSync(join(tmpdir(), 'chat-v2-backup-verify-'));
      const verificationDatabasePath = join(verificationDirectory, 'chat-v2.sqlite');
      copyFileSync(databasePath, verificationDatabasePath);
      const database = new Database(verificationDatabasePath, { readonly: true, fileMustExist: true });
      try {
        const integrity = database.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') errors.push(`SQLite integrity check failed: ${String(integrity)}`);
      } finally {
        database.close();
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'SQLite validation failed');
    } finally {
      if (verificationDirectory) rmSync(verificationDirectory, { recursive: true, force: true });
    }
  }

  for (const file of manifest.artifacts) {
    const path = join(resolved, 'artifacts', file.path);
    if (!existsSync(path)) {
      errors.push(`artifact missing: ${file.path}`);
      continue;
    }
    if (statSync(path).size !== file.sizeBytes) errors.push(`artifact size mismatch: ${file.path}`);
    if (sha256(path) !== file.sha256) errors.push(`artifact checksum mismatch: ${file.path}`);
  }
  return { ok: errors.length === 0, errors, manifest };
}

async function main() {
  const command = process.argv[2] ?? 'create';
  if (command === 'create') {
    const result = await createBackup();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'verify') {
    const directory = process.argv[3];
    if (!directory) throw new Error('Usage: backup verify <backup-directory>');
    const result = verifyBackup(directory);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown backup command: ${command}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
