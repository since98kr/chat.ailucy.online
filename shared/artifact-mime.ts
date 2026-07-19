const INLINE_IMAGE_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const ACTIVE_DOCUMENT_TYPES = new Set([
  'application/xhtml+xml',
  'image/svg+xml',
  'text/html',
]);

export function normalizeArtifactMime(mimeType: string | undefined) {
  const normalized = mimeType?.trim().toLowerCase() || 'application/octet-stream';
  return ACTIVE_DOCUMENT_TYPES.has(normalized) ? 'application/octet-stream' : normalized;
}

export function isInlineImageMime(mimeType: string) {
  return INLINE_IMAGE_TYPES.has(mimeType.trim().toLowerCase());
}
