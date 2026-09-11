import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Scenario = {
  id: string;
  name: string;
  initialState: string;
  userTurns: string[];
  expectedLucyBehavior: string[];
  forbiddenBehavior: string[];
  backendIdentity: string;
  observableEvidence: string[];
  sourceAuditVerdict: string;
  acceptanceVerdict: string;
  currentSourceEvidence: string[];
  primaryGap: string;
};

type ScenarioMatrix = {
  issue: number;
  evidenceRefreshIssue: number;
  sourceBaselineSha: string;
  acceptanceGate: {
    issue: number;
    classification: string;
    blocked: boolean;
    reason: string;
  };
  scenarios: Scenario[];
};

const matrix = JSON.parse(
  readFileSync(new URL('../docs/lucy-chat-scenarios.v1.json', import.meta.url), 'utf8'),
) as ScenarioMatrix;

describe('Lucy Chat scenario evidence matrix', () => {
  it('keeps one complete machine-readable contract for every S1-S12 scenario', () => {
    expect(matrix.issue).toBe(199);
    expect(matrix.evidenceRefreshIssue).toBe(232);
    expect(matrix.sourceBaselineSha).toMatch(/^[0-9a-f]{40}$/);
    expect(matrix.scenarios.map((scenario) => scenario.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `S${index + 1}`),
    );

    for (const scenario of matrix.scenarios) {
      expect(scenario.name).not.toBe('');
      expect(scenario.initialState).not.toBe('');
      expect(scenario.userTurns.length).toBeGreaterThan(0);
      expect(scenario.expectedLucyBehavior.length).toBeGreaterThan(0);
      expect(scenario.forbiddenBehavior.length).toBeGreaterThan(0);
      expect(scenario.backendIdentity).not.toBe('');
      expect(scenario.observableEvidence.length).toBeGreaterThan(0);
      expect(scenario.sourceAuditVerdict).not.toBe('');
      expect(scenario.acceptanceVerdict).not.toBe('');
      expect(scenario.currentSourceEvidence.length).toBeGreaterThan(0);
      expect(scenario.primaryGap).not.toBe('');
    }
  });

  it('cannot claim provider-backed acceptance while the canonical AUTH/USAGE gate is blocked', () => {
    expect(matrix.acceptanceGate).toMatchObject({
      issue: 210,
      classification: 'AUTH/USAGE',
      blocked: true,
    });
    expect(matrix.acceptanceGate.reason).toContain('429');
    expect(matrix.scenarios.every((scenario) => scenario.acceptanceVerdict === 'BLOCKED_REAL_PROVIDER')).toBe(true);
  });

  it('keeps source evidence and end-to-end acceptance as separate verdicts', () => {
    expect(matrix.scenarios.every((scenario) => !scenario.sourceAuditVerdict.includes('BLOCKED_REAL_PROVIDER'))).toBe(true);
    expect(matrix.scenarios.some((scenario) => scenario.sourceAuditVerdict === 'PASS')).toBe(true);
    expect(matrix.scenarios.some((scenario) => scenario.sourceAuditVerdict.includes('RUNTIME_PROOF_PENDING'))).toBe(true);
  });
});
