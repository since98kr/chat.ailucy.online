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

function expectNonBlankString(value: unknown) {
  expect(typeof value).toBe('string');
  expect((value as string).trim().length).toBeGreaterThan(0);
}

function expectNonBlankStringArray(value: unknown) {
  expect(Array.isArray(value)).toBe(true);
  const items = value as unknown[];
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) expectNonBlankString(item);
}

describe('Lucy Chat scenario evidence matrix', () => {
  it('keeps one complete machine-readable contract for every S1-S12 scenario', () => {
    expect(matrix.issue).toBe(199);
    expect(matrix.evidenceRefreshIssue).toBe(232);
    expectNonBlankString(matrix.sourceBaselineSha);
    expect(matrix.sourceBaselineSha).toMatch(/^[0-9a-f]{40}$/);
    expect(Array.isArray(matrix.scenarios)).toBe(true);
    expect(matrix.scenarios.map((scenario) => scenario.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `S${index + 1}`),
    );

    for (const scenario of matrix.scenarios) {
      expectNonBlankString(scenario.id);
      expectNonBlankString(scenario.name);
      expectNonBlankString(scenario.initialState);
      expectNonBlankStringArray(scenario.userTurns);
      expectNonBlankStringArray(scenario.expectedLucyBehavior);
      expectNonBlankStringArray(scenario.forbiddenBehavior);
      expectNonBlankString(scenario.backendIdentity);
      expectNonBlankStringArray(scenario.observableEvidence);
      expectNonBlankString(scenario.sourceAuditVerdict);
      expectNonBlankString(scenario.acceptanceVerdict);
      expectNonBlankStringArray(scenario.currentSourceEvidence);
      expectNonBlankString(scenario.primaryGap);
    }
  });

  it('cannot claim provider-backed acceptance while the canonical AUTH/USAGE gate is blocked', () => {
    expect(matrix.acceptanceGate).toMatchObject({
      issue: 210,
      classification: 'AUTH/USAGE',
      blocked: true,
    });
    expectNonBlankString(matrix.acceptanceGate.reason);
    expect(matrix.acceptanceGate.reason).toContain('429');
    expect(matrix.scenarios.every((scenario) => scenario.acceptanceVerdict === 'BLOCKED_REAL_PROVIDER')).toBe(true);
  });

  it('keeps source evidence and end-to-end acceptance as separate verdicts', () => {
    expect(matrix.scenarios.every((scenario) => !scenario.sourceAuditVerdict.includes('BLOCKED_REAL_PROVIDER'))).toBe(true);
    expect(matrix.scenarios.some((scenario) => scenario.sourceAuditVerdict === 'PASS')).toBe(true);
    expect(matrix.scenarios.some((scenario) => scenario.sourceAuditVerdict.startsWith('PARTIAL_'))).toBe(true);
  });

  it('does not overclaim artifact run ownership or personal-memory ownership', () => {
    expect(matrix.scenarios.find((scenario) => scenario.id === 'S9')?.sourceAuditVerdict).toBe(
      'PARTIAL_RUN_OWNERSHIP_PENDING',
    );
    expect(matrix.scenarios.find((scenario) => scenario.id === 'S12')?.sourceAuditVerdict).toBe(
      'PARTIAL_MEMORY_OWNER_PENDING',
    );
  });
});
