import { createWriteStream, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MultipartFile } from '@fastify/multipart';
import { normalizeArtifactMime } from '../shared/artifact-mime.js';
import type { AdapterGeneratedArtifact } from './adapters/types.js';

function rootPath() {
  return resolve(process.env.CHAT_ARTIFACT_ROOT ?? './data/artifacts');
}

function safeName(filename: string) {
  const base = basename(filename).replace(/[^\p{L}\p{N}._-]+/gu, '-');
  return base.slice(0, 160) || 'file';
}

function artifactPath(conversationId: string, filename: string) {
  const directory = join(rootPath(), conversationId);
  mkdirSync(directory, { recursive: true });
  const normalizedFilename = safeName(filename);
  return {
    filename: normalizedFilename,
    storagePath: join(directory, `${randomUUID()}-${normalizedFilename}`),
  };
}

export async function storeArtifact(conversationId: string, file: MultipartFile) {
  const { filename, storagePath } = artifactPath(conversationId, file.filename);
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

function decodeBase64(value: string) {
  const compact = value.replace(/\s+/g, '');
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error('Generated artifact content must be valid base64');
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length === 0 || bytes.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    throw new Error('Generated artifact content must be canonical base64');
  }
  return bytes;
}

export async function storeGeneratedArtifact(
  conversationId: string,
  generated: AdapterGeneratedArtifact,
) {
  const bytes = decodeBase64(generated.contentBase64);
  const maxBytes = Number(process.env.CHAT_MAX_GENERATED_ARTIFACT_BYTES ?? 50 * 1024 * 1024);
  if (!Number.isFinite(maxBytes) || maxBytes < 1) throw new Error('Generated artifact size limit is invalid');
  if (bytes.length > maxBytes) {
    throw new Error(`Generated artifact exceeds ${maxBytes} bytes`);
  }

  const { filename, storagePath } = artifactPath(conversationId, generated.filename);
  await writeFile(storagePath, bytes, { flag: 'wx' });
  return {
    filename,
    mimeType: normalizeArtifactMime(generated.mimeType),
    sizeBytes: bytes.length,
    storagePath,
  };
}

export function artifactRoot() {
  return rootPath();
}
