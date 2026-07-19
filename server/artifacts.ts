import { createWriteStream, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MultipartFile } from '@fastify/multipart';
import { normalizeArtifactMime } from '../shared/artifact-mime.js';

function rootPath() {
  return resolve(process.env.CHAT_ARTIFACT_ROOT ?? './data/artifacts');
}

function safeName(filename: string) {
  const base = basename(filename).replace(/[^\p{L}\p{N}._-]+/gu, '-');
  return base.slice(0, 160) || 'file';
}

export async function storeArtifact(conversationId: string, file: MultipartFile) {
  const directory = join(rootPath(), conversationId);
  mkdirSync(directory, { recursive: true });

  const filename = safeName(file.filename);
  const storedFilename = `${randomUUID()}-${filename}`;
  const storagePath = join(directory, storedFilename);
  let sizeBytes = 0;

  file.file.on('data', (chunk: Buffer) => {
    sizeBytes += chunk.length;
  });
  await pipeline(file.file, createWriteStream(storagePath, { flags: 'wx' }));

  return {
    filename,
    mimeType: normalizeArtifactMime(file.mimetype),
    sizeBytes,
    storagePath,
  };
}

export function artifactRoot() {
  return rootPath();
}
