import { describe, expect, it } from 'vitest';
import { resolveNativeTargetAgentId } from './index.js';

describe('resolveNativeTargetAgentId', () => {
  it('uses an explicit model map when one is configured', () => {
    expect(resolveNativeTargetAgentId(
      '[Letta] Lucy',
      '[Letta] Lucy',
      'configured-agent',
      { '[Letta] Lucy': 'mapped-agent' },
    )).toBe('mapped-agent');
  });

  it('maps a direct Chat V2 conversation agent to the configured backend agent', () => {
    expect(resolveNativeTargetAgentId(
      '[Letta] Lucy',
      '[Letta] Lucy',
      'agent-local-0dc7f93b-7b2e-41f3-8193-a9520950557c',
    )).toBe('agent-local-0dc7f93b-7b2e-41f3-8193-a9520950557c');
  });

  it('preserves an explicitly delegated team target', () => {
    expect(resolveNativeTargetAgentId(
      'Xixi',
      '[Hermes] Lucy',
      'configured-lucy-agent',
    )).toBe('Xixi');
  });
});
