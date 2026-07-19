const INLINE_IMAGE_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function isInlineImageMime(mimeType: string) {
  return INLINE_IMAGE_TYPES.has(mimeType.trim().toLowerCase());
}
