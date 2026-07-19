import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatDatabase } from './database.js';
import { createBackup, verifyBackup } from './backup.js';

const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('backup engine', () => {
  it('creates an online SQLite and artifact backup and detects corruption', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat-v2-backup-'));
    directories.push(directory);
    const databasePath = join(directory, 'chat.sqlite');
    const artifactRoot = join(directory, 'artifacts');
    const backupRoot = join(directory, 'backups');

    const db = new ChatDatabase(databasePath);
    const conversation = db.createConversation('hermes', '[Hermes] Lucy', 'Backup verification');
    db.addMessage({
      conversationId: conversation.id,
      role: 'user',
      authorId: 'tei',
      content: '이 메시지는 백업되어야 합니다.',
    });
    db.close();

    writeFileSync(join(directory, 'artifact-source.txt'), 'backup artifact', 'utf8');
    const { mkdirSync, copyFileSync } = await import('node:fs');
    mkdirSync(artifactRoot, { recursive: true });
    copyFileSync(join(directory, 'artifact-source.txt'), join(artifactRoot, 'artifact.txt'));

    const created = await createBackup({ databasePath, artifactRoot, backupRoot, retention: 3 });
    expect(created.manifest.artifactCount).toBe(1);
    expect(created.manifest.database.sizeBytes).toBeGreaterThan(0);

    const backedUpDatabase = join(created.directory, 'chat-v2.sqlite');
    chmodSync(backedUpDatabase, 0o444);
    chmodSync(created.directory, 0o555);
    try {
      const readOnlyValid = verifyBackup(created.directory);
      expect(readOnlyValid.ok).toBe(true);
      expect(readOnlyValid.errors).toEqual([]);
    } finally {
      chmodSync(created.directory, 0o755);
      chmodSync(backedUpDatabase, 0o644);
    }

    const valid = verifyBackup(created.directory);
    expect(valid.ok).toBe(true);
    expect(valid.errors).toEqual([]);

    const backedUpArtifact = join(created.directory, 'artifacts', 'artifact.txt');
    writeFileSync(backedUpArtifact, `${readFileSync(backedUpArtifact, 'utf8')}-corrupt`, 'utf8');
    const corrupted = verifyBackup(created.directory);
    expect(corrupted.ok).toBe(false);
    expect(corrupted.errors.some((error) => error.includes('artifact'))).toBe(true);
  });
});
