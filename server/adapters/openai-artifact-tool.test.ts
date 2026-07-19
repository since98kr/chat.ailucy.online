import { describe, expect, it } from 'vitest';
import { OpenAiArtifactToolAccumulator, parseGeneratedArtifactArguments } from './openai-artifact-tool.js';

describe('OpenAiArtifactToolAccumulator', () => {
  it('parses a complete return_artifact tool call', () => {
    const accumulator = new OpenAiArtifactToolAccumulator();
    accumulator.ingest({
      choices: [{
        message: {
          tool_calls: [{
            index: 0,
            function: {
              name: 'return_artifact',
              arguments: JSON.stringify({
                filename: 'report.md',
                mime_type: 'text/markdown',
                content_text: '# Report',
              }),
            },
          }],
        },
      }],
    });

    expect(accumulator.finish()).toEqual([{
      filename: 'report.md',
      mimeType: 'text/markdown',
      contentBase64: Buffer.from('# Report', 'utf8').toString('base64'),
    }]);
  });

  it('joins streamed function argument fragments in call-index order', () => {
    const accumulator = new OpenAiArtifactToolAccumulator();
    accumulator.ingest({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'return_artifact', arguments: '{"filename":"image.png",' } }] } }],
    });
    accumulator.ingest({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"mime_type":"image/png",' } }] } }],
    });
    accumulator.ingest({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content_base64":"cG5n"}' } }] } }],
    });

    expect(accumulator.finish()).toEqual([{
      filename: 'image.png',
      mimeType: 'image/png',
      contentBase64: 'cG5n',
    }]);
  });

  it('rejects streamed tool arguments before they can grow beyond the transport limit', () => {
    const accumulator = new OpenAiArtifactToolAccumulator(64);
    expect(() => accumulator.ingest({
      choices: [{ delta: { tool_calls: [{ index: 0, function: {
        name: 'return_artifact',
        arguments: `{"filename":"x.txt","mime_type":"text/plain","content_text":"${'x'.repeat(80)}`,
      } }] } }],
    })).toThrow('exceed 64 bytes');
  });

  it('rejects an artifact call without inline content', () => {
    const accumulator = new OpenAiArtifactToolAccumulator();
    accumulator.ingest({
      choices: [{
        message: {
          tool_calls: [{
            function: {
              name: 'return_artifact',
              arguments: '{"filename":"unsafe.txt","mime_type":"text/plain"}',
            },
          }],
        },
      }],
    });
    expect(() => accumulator.finish()).toThrow('requires content_text or content_base64');
  });

  it('rejects backend paths and URLs even when inline content is also supplied', () => {
    expect(() => parseGeneratedArtifactArguments(JSON.stringify({
      filename: 'unsafe.txt',
      mime_type: 'text/plain',
      content_text: 'inline',
      path: '/home/backend/unsafe.txt',
    }))).toThrow('must not contain path');
    expect(() => parseGeneratedArtifactArguments(JSON.stringify({
      filename: 'unsafe.txt',
      mime_type: 'text/plain',
      content_text: 'inline',
      url: 'https://backend.invalid/unsafe.txt',
    }))).toThrow('must not contain url');
  });

  it('rejects ambiguous aliases and oversized metadata', () => {
    expect(() => parseGeneratedArtifactArguments(JSON.stringify({
      filename: 'ambiguous.txt',
      mime_type: 'text/plain',
      mimeType: 'application/octet-stream',
      content_text: 'x',
    }))).toThrow('must not supply both mime_type and mimeType');
    expect(() => parseGeneratedArtifactArguments(JSON.stringify({
      filename: `${'a'.repeat(161)}.txt`,
      mime_type: 'text/plain',
      content_text: 'x',
    }))).toThrow('filename exceeds 160 characters');
  });
});
