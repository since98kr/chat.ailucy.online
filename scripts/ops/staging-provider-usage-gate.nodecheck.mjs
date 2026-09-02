import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProviderUsageGate } from './staging-provider-usage-gate.mjs';

const root = mkdtempSync(join(tmpdir(), 'chat-provider-gate-'));
try {
  assert.deepEqual(readProviderUsageGate(join(root, 'missing.json')), {
    blocked: false, classification: null, reason: null, issue: null,
  });

  const active = join(root, 'active.json');
  writeFileSync(active, JSON.stringify({
    blocked: true,
    classification: 'AUTH/USAGE',
    reason: ' OAuth usage exhausted; model QA deferred. ',
    issue: 199,
  }));
  assert.deepEqual(readProviderUsageGate(active), {
    blocked: true,
    classification: 'AUTH/USAGE',
    reason: 'OAuth usage exhausted; model QA deferred.',
    issue: 199,
  });

  const inactive = join(root, 'inactive.json');
  writeFileSync(inactive, JSON.stringify({ blocked: false }));
  assert.equal(readProviderUsageGate(inactive).blocked, false);

  const invalid = join(root, 'invalid.json');
  writeFileSync(invalid, JSON.stringify({ blocked: true, classification: 'AUTH/USAGE', issue: 199 }));
  assert.throws(() => readProviderUsageGate(invalid), /bounded reason/);
  console.log('[staging-provider-usage-gate-nodecheck] PASS 4 checks');
} finally {
  rmSync(root, { recursive: true, force: true });
}
