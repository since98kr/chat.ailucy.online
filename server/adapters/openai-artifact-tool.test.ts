import { describe, expect, it } from 'vitest';
import { OpenAiArtifactToolAccumulator } from './openai-artifact-tool.js';

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
});
