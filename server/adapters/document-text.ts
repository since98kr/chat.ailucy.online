import { readFile } from 'node:fs/promises';
import * as mammoth from 'mammoth';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ArtifactRecord } from '../../shared/contracts.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';
const TEXT_ATTACHMENT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/javascript',
]);

export function artifactTextKind(artifact: ArtifactRecord) {
  const mimeType = artifact.mimeType.trim().toLowerCase();
  if (mimeType.startsWith('text/') || mimeType.endsWith('+json') || mimeType.endsWith('+xml') || TEXT_ATTACHMENT_TYPES.has(mimeType)) {
    return 'plain' as const;
  }
  if (mimeType === PDF_MIME) return 'pdf' as const;
  if (mimeType === DOCX_MIME) return 'docx' as const;
  return null;
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  const resolved = Number(value ?? fallback);
  if (!Number.isFinite(resolved) || resolved < 1) throw new Error(`${name} must be a positive number`);
  return Math.floor(resolved);
}

function normalizeExtractedText(value: string, filename: string) {
  const normalized = value
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!normalized) {
    throw new Error(`Attachment ${filename} contains no extractable text; OCR is not available for this document`);
  }
  const maxCharacters = positiveInteger(
    process.env.CHAT_MAX_EXTRACTED_TEXT_CHARACTERS,
    2_000_000,
    'CHAT_MAX_EXTRACTED_TEXT_CHARACTERS',
  );
  if (normalized.length > maxCharacters) {
    throw new Error(`Extracted text from ${filename} exceeds ${maxCharacters} characters`);
  }
  return normalized;
}

async function extractPdf(bytes: Buffer, filename: string) {
  const maxPages = positiveInteger(process.env.CHAT_MAX_PDF_PAGES, 200, 'CHAT_MAX_PDF_PAGES');
  const task = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  });
  const document = await task.promise;
  try {
    if (document.numPages > maxPages) {
      throw new Error(`Attachment ${filename} exceeds the ${maxPages}-page PDF extraction limit`);
    }
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item && typeof item.str === 'string' ? item.str : ''))
        .filter(Boolean)
        .join(' ')
        .trim();
      if (text) pages.push(`[Page ${pageNumber}]\n${text}`);
      page.cleanup();
    }
    return normalizeExtractedText(pages.join('\n\n'), filename);
  } finally {
    await document.destroy();
  }
}

async function extractDocx(bytes: Buffer, filename: string) {
  const result = await mammoth.extractRawText({ buffer: bytes });
  const errors = result.messages.filter((message) => message.type === 'error');
  if (errors.length) {
    throw new Error(`DOCX extraction failed for ${filename}: ${errors[0].message}`);
  }
  return normalizeExtractedText(result.value, filename);
}

export async function extractArtifactText(artifact: ArtifactRecord, validatedBytes?: Buffer) {
  const kind = artifactTextKind(artifact);
  if (!kind) return null;
  const bytes = validatedBytes ?? await readFile(artifact.storagePath);
  if (bytes.length !== artifact.sizeBytes) {
    throw new Error(`Attachment ${artifact.filename} changed after upload`);
  }
  if (kind === 'plain') return normalizeExtractedText(bytes.toString('utf8'), artifact.filename);
  if (kind === 'pdf') return extractPdf(bytes, artifact.filename);
  return extractDocx(bytes, artifact.filename);
}
