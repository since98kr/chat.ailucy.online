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

export function renderMessageContent(content: string): ReactNode {
  return segmentMessageContent(content).map((segment, index) =>
    segment.type === 'link' ? (
      <a
        key={`${segment.value}-${index}`}
        href={segment.value}
        target="_blank"
        rel="noopener noreferrer"
        className="message-link"
      >
        {segment.value}
      </a>
    ) : (
      <span key={`text-${index}`}>{segment.value}</span>
    ),
  );
}
