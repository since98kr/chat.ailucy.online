import type { AdapterGeneratedArtifact } from './types.js';

export const RETURN_ARTIFACT_TOOL_NAME = 'return_artifact';

export const RETURN_ARTIFACT_TOOL = {
  type: 'function',
  function: {
    name: RETURN_ARTIFACT_TOOL_NAME,
    description: 'Return a file to the Chat V2 user. Supply either UTF-8 content_text or canonical content_base64.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filename: { type: 'string', minLength: 1, maxLength: 160 },
        mime_type: { type: 'string', minLength: 1, maxLength: 200 },
        content_text: { type: 'string' },
        content_base64: { type: 'string' },
      },
      required: ['filename', 'mime_type'],
    },
  },
} as const;

type ToolState = {
  name: string;
  arguments: string;
};

function records(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
}

function toolCalls(payload: unknown) {
  if (!payload || typeof payload !== 'object') return [];
  const object = payload as Record<string, unknown>;
  const choices = records(object.choices);
  const calls: Array<{ index: number; name?: string; arguments?: string }> = [];

  for (const choice of choices) {
    const source = choice.delta && typeof choice.delta === 'object'
      ? choice.delta as Record<string, unknown>
      : choice.message && typeof choice.message === 'object'
        ? choice.message as Record<string, unknown>
        : null;
    if (!source) continue;
    records(source.tool_calls).forEach((call, fallbackIndex) => {
      const fn = call.function && typeof call.function === 'object'
        ? call.function as Record<string, unknown>
        : {};
      calls.push({
        index: typeof call.index === 'number' ? call.index : fallbackIndex,
        ...(typeof fn.name === 'string' ? { name: fn.name } : {}),
        ...(typeof fn.arguments === 'string' ? { arguments: fn.arguments } : {}),
      });
    });
  }
  return calls;
}

function parseArtifactArguments(value: string): AdapterGeneratedArtifact {
  let input: unknown;
  try {
    input = JSON.parse(value);
  } catch {
    throw new Error('return_artifact tool arguments must be valid JSON');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('return_artifact tool arguments must be an object');
  }
  const object = input as Record<string, unknown>;
  const filename = typeof object.filename === 'string' ? object.filename.trim() : '';
  const mimeType = typeof object.mime_type === 'string' ? object.mime_type.trim()
    : typeof object.mimeType === 'string' ? object.mimeType.trim() : '';
  const contentBase64 = typeof object.content_base64 === 'string' ? object.content_base64.trim()
    : typeof object.contentBase64 === 'string' ? object.contentBase64.trim() : '';
  const contentText = typeof object.content_text === 'string' ? object.content_text
    : typeof object.contentText === 'string' ? object.contentText : '';
  if (!filename || !mimeType) throw new Error('return_artifact requires filename and mime_type');
  if (!contentBase64 && !contentText) throw new Error('return_artifact requires content_text or content_base64');
  if (contentBase64 && contentText) throw new Error('return_artifact must not supply both text and base64 content');
  return {
    filename,
    mimeType,
    contentBase64: contentBase64 || Buffer.from(contentText, 'utf8').toString('base64'),
  };
}

export class OpenAiArtifactToolAccumulator {
  private readonly states = new Map<number, ToolState>();

  ingest(payload: unknown) {
    for (const call of toolCalls(payload)) {
      const state = this.states.get(call.index) ?? { name: '', arguments: '' };
      if (call.name) state.name = call.name;
      if (call.arguments) state.arguments += call.arguments;
      this.states.set(call.index, state);
    }
  }

  finish() {
    const artifacts: AdapterGeneratedArtifact[] = [];
    for (const [index, state] of [...this.states.entries()].sort(([left], [right]) => left - right)) {
      if (state.name !== RETURN_ARTIFACT_TOOL_NAME) continue;
      artifacts.push(parseArtifactArguments(state.arguments));
    }
    this.states.clear();
    return artifacts;
  }
}
