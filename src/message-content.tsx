import type { ReactNode } from 'react';

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION = /[),.!?;:\]}]$/;

export type MessageContentSegment =
  | { type: 'text'; value: string }
  | { type: 'link'; value: string };

export function segmentMessageContent(content: string): MessageContentSegment[] {
  const segments: MessageContentSegment[] = [];
  let cursor = 0;

  for (const match of content.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ type: 'text', value: content.slice(cursor, index) });

    const raw = match[0];
    let link = raw;
    while (link && TRAILING_PUNCTUATION.test(link)) link = link.slice(0, -1);

    if (link) segments.push({ type: 'link', value: link });
    if (link.length < raw.length) segments.push({ type: 'text', value: raw.slice(link.length) });
    cursor = index + raw.length;
  }

  if (cursor < content.length) segments.push({ type: 'text', value: content.slice(cursor) });
  return segments.length ? segments : [{ type: 'text', value: content }];
}

// --- Lightweight markdown blocks (no external dependency) ---
// Only fenced code blocks are treated as block-level. Everything else keeps the
// prior inline behavior. React escapes all text nodes, so this stays XSS-safe:
// we never use dangerouslySetInnerHTML.

type MarkdownBlock =
  | { type: 'code'; lang: string | null; value: string }
  | { type: 'text'; value: string };

const FENCE_PATTERN = /```([^\n`]*)\n([\s\S]*?)```/g;

function splitMarkdownBlocks(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let cursor = 0;
  for (const match of content.matchAll(FENCE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) blocks.push({ type: 'text', value: content.slice(cursor, index) });
    const lang = (match[1] ?? '').trim() || null;
    blocks.push({ type: 'code', lang, value: match[2] ?? '' });
    cursor = index + match[0].length;
  }
  if (cursor < content.length) blocks.push({ type: 'text', value: content.slice(cursor) });
  return blocks.length ? blocks : [{ type: 'text', value: content }];
}

// Inline tokens applied within text blocks: `code`, **bold**, and URL autolinks.
// Order matters: inline code is extracted first so its contents are not further
// parsed as bold/links.
type InlineToken =
  | { type: 'code'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'link'; value: string }
  | { type: 'text'; value: string };

const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const BOLD_PATTERN = /\*\*([^*\n]+)\*\*/g;

function tokenizeBoldAndLinks(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(BOLD_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      for (const seg of segmentMessageContent(text.slice(cursor, index))) {
        tokens.push(seg.type === 'link' ? { type: 'link', value: seg.value } : { type: 'text', value: seg.value });
      }
    }
    tokens.push({ type: 'bold', value: match[1] ?? '' });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    for (const seg of segmentMessageContent(text.slice(cursor))) {
      tokens.push(seg.type === 'link' ? { type: 'link', value: seg.value } : { type: 'text', value: seg.value });
    }
  }
  return tokens;
}

function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_CODE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) tokens.push(...tokenizeBoldAndLinks(text.slice(cursor, index)));
    tokens.push({ type: 'code', value: match[1] ?? '' });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) tokens.push(...tokenizeBoldAndLinks(text.slice(cursor)));
  return tokens;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return tokenizeInline(text).map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    if (token.type === 'link') {
      return (
        <a
          key={key}
          href={token.value}
          target="_blank"
          rel="noopener noreferrer"
          className="message-link"
        >
          {token.value}
        </a>
      );
    }
    if (token.type === 'code') {
      return (
        <code key={key} className="message-inline-code">
          {token.value}
        </code>
      );
    }
    if (token.type === 'bold') {
      return (
        <strong key={key}>
          {segmentMessageContent(token.value).map((segment, segmentIndex) => (
            segment.type === 'link'
              ? (
                <a
                  key={`${key}-bold-link-${segmentIndex}`}
                  href={segment.value}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="message-link"
                >
                  {segment.value}
                </a>
              )
              : <span key={`${key}-bold-text-${segmentIndex}`}>{segment.value}</span>
          ))}
        </strong>
      );
    }
    return <span key={key}>{token.value}</span>;
  });
}

export function renderMessageContent(content: string): ReactNode {
  return splitMarkdownBlocks(content).map((block, index) => {
    if (block.type === 'code') {
      return (
        <pre key={`code-${index}`} className="message-code-block" data-lang={block.lang ?? undefined}>
          <code>{block.value}</code>
        </pre>
      );
    }
    return <span key={`text-${index}`}>{renderInline(block.value, `inline-${index}`)}</span>;
  });
}
