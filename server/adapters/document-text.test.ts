import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import type { ArtifactRecord } from '../../shared/contracts.js';
import { extractArtifactText } from './document-text.js';

const timestamp = '2026-07-19T00:00:00.000Z';
const directories: string[] = [];

async function artifact(filename: string, mimeType: string, bytes: Buffer): Promise<ArtifactRecord> {
  const directory = await mkdtemp(join(tmpdir(), 'chat-v2-document-text-'));
  directories.push(directory);
  const storagePath = join(directory, filename);
  await writeFile(storagePath, bytes);
  return {
    id: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    filename,
    mimeType,
    sizeBytes: bytes.length,
    storagePath,
    createdAt: timestamp,
  };
}

function simplePdf(marker: string) {
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${marker}) Tj\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'binary')} >>\nstream\n${stream}endstream`,
  ];
  let document = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document, 'binary'));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(document, 'binary');
  document += `xref\n0 ${objects.length + 1}\n`;
  document += '0000000000 65535 f \n';
  offsets.forEach((offset) => {
    document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  document += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, 'binary');
}

async function simpleDocx(marker: string) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder('_rels')?.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${marker}</w:t></w:r></w:p><w:sectPr/></w:body>
</w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

afterEach(async () => {
  delete process.env.CHAT_MAX_EXTRACTED_TEXT_CHARACTERS;
  delete process.env.CHAT_MAX_PDF_PAGES;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('extractArtifactText', () => {
  it('extracts a marker from a PDF without rendering or OCR', async () => {
    const input = await artifact('marker.pdf', 'application/pdf', simplePdf('PDF_ONLY_MARKER_91C7'));
    await expect(extractArtifactText(input)).resolves.toContain('PDF_ONLY_MARKER_91C7');
  });

  it('extracts raw text from a DOCX buffer', async () => {
    const bytes = await simpleDocx('DOCX_ONLY_MARKER_2A8F');
    const input = await artifact(
      'marker.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes,
    );
    await expect(extractArtifactText(input)).resolves.toContain('DOCX_ONLY_MARKER_2A8F');
  });

  it('rejects image-only or empty PDF text instead of pretending OCR succeeded', async () => {
    const input = await artifact('empty.pdf', 'application/pdf', simplePdf(''));
    await expect(extractArtifactText(input)).rejects.toThrow('OCR is not available');
  });
});
