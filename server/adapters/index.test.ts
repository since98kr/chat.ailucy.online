import { describe, expect, it } from 'vitest';
import { resolveNativeExecution, resolveNativeTargetAgentId } from './index.js';

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

describe('resolveNativeExecution', () => {
  it('authorizes only the adapter-owned direct Letta runtime mapping', () => {
    expect(resolveNativeExecution(
      '[Letta] Lucy',
      '[Letta] Lucy',
      '[Letta] Lucy',
      'agent-local-0dc7f93b-7b2e-41f3-8193-a9520950557c',
    )).toEqual({
      targetAgentId: 'agent-local-0dc7f93b-7b2e-41f3-8193-a9520950557c',
      authorizationModelMap: {
        '[Letta] Lucy': 'agent-local-0dc7f93b-7b2e-41f3-8193-a9520950557c',
      },
    });
  });

  it('does not authorize an arbitrary requested runtime target', () => {
    expect(resolveNativeExecution(
      'agent-local-attacker-controlled',
      '[Letta] Lucy',
      '[Letta] Lucy',
      'agent-local-approved',
    )).toEqual({
      targetAgentId: 'agent-local-attacker-controlled',
      authorizationModelMap: undefined,
    });
  });

  it('preserves an explicit Hermes subagent model mapping without widening discovery', () => {
    const modelMap = { Xixi: 'xixi-runtime-model' };
    expect(resolveNativeExecution(
      'Xixi',
      'Xixi',
      '[Hermes] Lucy',
      'hermes-lead-runtime',
      modelMap,
    )).toEqual({
      targetAgentId: 'xixi-runtime-model',
      authorizationModelMap: modelMap,
    });
  });
});
