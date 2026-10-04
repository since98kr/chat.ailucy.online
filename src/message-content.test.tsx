import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderMessageContent } from './message-content';

function render(content: string) {
  return renderToStaticMarkup(<>{renderMessageContent(content)}</>);
}

describe('message content rendering', () => {
  it('preserves URL autolinking inside bold markdown', () => {
    const html = render('**see https://example.com**');
    expect(html).toContain('<strong>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('class="message-link"');
    expect(html).toContain('>https://example.com</a>');
  });

  it('keeps inline code opaque instead of autolinking its contents', () => {
    const html = render('`https://example.com`');
    expect(html).toContain('class="message-inline-code"');
    expect(html).not.toContain('href=');
  });

  it('renders fenced code without injecting raw HTML', () => {
    const html = render('\\`\\`\\`html\\n<script>alert(1)</script>\\`\\`\\`');
    expect(html).toContain('class="message-code-block"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
});
