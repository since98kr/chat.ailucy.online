import { describe, expect, it } from 'vitest';
import {
  resolveNativeExecution,
  resolveNativeTargetAgentId,
  resolvePersonalLucyProviderTarget,
} from './index.js';

describe('mockAdaptersAllowed', () => {
  it('fails closed outside test mode unless the mock flag is explicit', async () => {
    const { mockAdaptersAllowed } = await import('./index.js');
    expect(mockAdaptersAllowed({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false);
    expect(mockAdaptersAllowed({ NODE_ENV: 'production', CHAT_ALLOW_MOCK_ADAPTERS: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(mockAdaptersAllowed({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('resolvePersonalLucyProviderTarget', () => {
  it('maps canonical OpenClaw Lucy to the configured legacy provider target', () => {
    expect(resolvePersonalLucyProviderTarget(
      '[OpenClaw] Lucy',
      '[Letta] Lucy',
    )).toBe('[Letta] Lucy');
  });

  it('honors an explicit canonical or legacy model mapping before the configured agent', () => {
    expect(resolvePersonalLucyProviderTarget(
      '[OpenClaw] Lucy',
      'configured-agent',
      { '[Letta] Lucy': 'legacy-mapped-runtime' },
    )).toBe('legacy-mapped-runtime');
    expect(resolvePersonalLucyProviderTarget(
      '[OpenClaw] Lucy',
      'configured-agent',
      { '[OpenClaw] Lucy': 'canonical-mapped-runtime', '[Letta] Lucy': 'legacy-mapped-runtime' },
    )).toBe('canonical-mapped-runtime');
  });

  it('does not alias unrelated agents', () => {
    expect(resolvePersonalLucyProviderTarget('Xixi', '[Letta] Lucy')).toBeUndefined();
  });
});

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

  it('maps canonical OpenClaw Lucy even when it is a federated target rather than the conversation lead', () => {
    expect(resolveNativeTargetAgentId(
      '[OpenClaw] Lucy',
      '[Hermes] Lucy',
      '[Letta] Lucy',
    )).toBe('[Letta] Lucy');
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

  it('authorizes the canonical OpenClaw Lucy compatibility target for federated native execution', () => {
    expect(resolveNativeExecution(
      '[OpenClaw] Lucy',
      '[OpenClaw] Lucy',
      '[Hermes] Lucy',
      '[Letta] Lucy',
    )).toEqual({
      targetAgentId: '[Letta] Lucy',
      authorizationModelMap: { '[OpenClaw] Lucy': '[Letta] Lucy' },
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
