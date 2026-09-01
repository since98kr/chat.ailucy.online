from __future__ import annotations

import json
from pathlib import Path

# 1) Durable provider usage gate + active block marker.
Path('ops').mkdir(exist_ok=True)
Path('ops/staging-provider-usage-block.json').write_text(json.dumps({
    'blocked': True,
    'classification': 'AUTH/USAGE',
    'reason': 'OpenAI OAuth usage exhausted; model-dependent staging QA is intentionally deferred.',
    'issue': 199,
    'setAt': '2026-09-01T14:18:00Z',
}, indent=2) + '\n')

Path('scripts/ops/staging-provider-usage-gate.mjs').write_text(r'''import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function readProviderUsageGate(path = 'ops/staging-provider-usage-block.json') {
  if (!existsSync(path)) return { blocked: false, classification: null, reason: null, issue: null };
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value.blocked !== 'boolean') throw new Error('provider usage gate requires boolean blocked');
  if (!value.blocked) return { blocked: false, classification: null, reason: null, issue: null };
  if (value.classification !== 'AUTH/USAGE') throw new Error('blocked provider usage gate classification must be AUTH/USAGE');
  const reason = String(value.reason ?? '').trim().replace(/\s+/g, ' ');
  if (!reason || reason.length > 180) throw new Error('blocked provider usage gate requires a bounded reason');
  const issue = Number(value.issue);
  if (!Number.isInteger(issue) || issue <= 0) throw new Error('blocked provider usage gate requires a positive issue number');
  return { blocked: true, classification: 'AUTH/USAGE', reason, issue };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(readProviderUsageGate(process.argv[2])) + '\n');
}
''')

Path('scripts/ops/staging-provider-usage-gate.nodecheck.mjs').write_text(r'''import assert from 'node:assert/strict';
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
''')

# 2) Make the gate part of the existing QA-gate test contract.
pkg_path = Path('package.json')
pkg = json.loads(pkg_path.read_text())
old_qa = pkg['scripts']['test:qa-gates']
nodecheck = 'node scripts/ops/staging-provider-usage-gate.nodecheck.mjs'
if nodecheck not in old_qa:
    pkg['scripts']['test:qa-gates'] = f'{old_qa} && {nodecheck}'
pkg_path.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + '\n')

# 3) Patch staging workflow. The default (marker absent) remains unchanged.
wf_path = Path('.github/workflows/deploy-staging.yml')
s = wf_path.read_text()

insert_anchor = '      - name: Mark staging verification pending\n'
if s.count(insert_anchor) != 1:
    raise SystemExit('mark status anchor mismatch')
gate_step = '''      - name: Check provider usage gate
        id: provider_gate
        shell: bash
        run: |
          set -euo pipefail
          gate="$(node scripts/ops/staging-provider-usage-gate.mjs)"
          blocked="$(node -e "const j=JSON.parse(process.argv[1]);process.stdout.write(String(j.blocked))" "${gate}")"
          classification="$(node -e "const j=JSON.parse(process.argv[1]);process.stdout.write(j.classification || '')" "${gate}")"
          reason="$(node -e "const j=JSON.parse(process.argv[1]);process.stdout.write(j.reason || '')" "${gate}")"
          issue="$(node -e "const j=JSON.parse(process.argv[1]);process.stdout.write(String(j.issue || ''))" "${gate}")"
          echo "blocked=${blocked}" >> "$GITHUB_OUTPUT"
          echo "classification=${classification}" >> "$GITHUB_OUTPUT"
          echo "reason=${reason}" >> "$GITHUB_OUTPUT"
          echo "issue=${issue}" >> "$GITHUB_OUTPUT"
          if [[ "${blocked}" == 'true' ]]; then
            echo "Provider-backed staging QA is externally blocked: ${classification} · ${reason} (issue #${issue})."
          else
            echo 'Provider-backed staging QA is enabled.'
          fi

'''
s = s.replace(insert_anchor, gate_step + insert_anchor, 1)

mark_start = s.index('      - name: Mark staging verification pending\n')
mark_end = s.index('      - name: Require private OpenClaw staging ingress\n', mark_start)
old_mark = s[mark_start:mark_end]
new_mark = '''      - name: Mark staging verification pending
        uses: actions/github-script@v7
        env:
          DEPLOY_SHA: ${{ steps.source.outputs.sha }}
          PROVIDER_BLOCKED: ${{ steps.provider_gate.outputs.blocked }}
          PROVIDER_BLOCK_REASON: ${{ steps.provider_gate.outputs.reason }}
        with:
          script: |
            const blocked = process.env.PROVIDER_BLOCKED === 'true';
            await github.rest.repos.createCommitStatus({
              owner: context.repo.owner,
              repo: context.repo.repo,
              sha: process.env.DEPLOY_SHA,
              state: blocked ? 'error' : 'pending',
              context: 'chat-v2/staging',
              description: blocked
                ? 'AUTH/USAGE BLOCKED: provider model QA deferred'
                : 'OpenClaw-backed staging deploy and QA are running',
              target_url: blocked
                ? `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/issues/199`
                : `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
            });

'''
s = s[:mark_start] + new_mark + s[mark_end:]

runtime_steps = [
    'Require private OpenClaw staging ingress',
    'Legacy Letta bridge rollout is not used in OpenClaw mode',
    'Enforce fail-closed staging QA gate configuration',
    'Load authoritative Cloudflare staging service identity',
    'Deploy with strict preflight, backup, health check, and rollback',
    'Verify real Hermes and Letta transport',
    'Verify OpenClaw-backed Letta session continuity',
    'Verify real browser links and configured artifacts',
    'Capture authenticated OpenClaw Lucy route evidence',
    'Verify public Cloudflare Access and artifact transport',
]
for name in runtime_steps:
    needle = f'      - name: {name}\n'
    if s.count(needle) != 1:
        raise SystemExit(f'runtime step anchor mismatch: {name}')
    s = s.replace(needle, needle + "        if: steps.provider_gate.outputs.blocked != 'true'\n", 1)

summary_anchor = '      - name: Publish deployment summary\n'
if s.count(summary_anchor) != 1:
    raise SystemExit('summary anchor mismatch')
blocked_summary = '''      - name: Publish provider usage blocker summary
        if: steps.provider_gate.outputs.blocked == 'true'
        shell: bash
        env:
          PROVIDER_CLASSIFICATION: ${{ steps.provider_gate.outputs.classification }}
          PROVIDER_BLOCK_REASON: ${{ steps.provider_gate.outputs.reason }}
          PROVIDER_BLOCK_ISSUE: ${{ steps.provider_gate.outputs.issue }}
        run: |
          {
            echo '## Chat V2 staging — externally blocked'
            echo
            echo "- Classification: \`${PROVIDER_CLASSIFICATION}\`"
            echo "- Reason: ${PROVIDER_BLOCK_REASON}"
            echo "- Canonical issue: #${PROVIDER_BLOCK_ISSUE}"
            echo '- No staging deployment, provider turn, session-continuity turn, browser model QA, or external QA was executed by this run.'
            echo '- This is not a PASS; remove the source-controlled provider-usage block only after usage is restored.'
          } >> "$GITHUB_STEP_SUMMARY"

'''
s = s.replace(summary_anchor, blocked_summary + summary_anchor, 1)
s = s.replace('      - name: Publish deployment summary\n        if: always()\n', "      - name: Publish deployment summary\n        if: ${{ always() && steps.provider_gate.outputs.blocked != 'true' }}\n", 1)
s = s.replace('      - name: Upload deployment and browser evidence\n        if: always()\n', "      - name: Upload deployment and browser evidence\n        if: ${{ always() && steps.provider_gate.outputs.blocked != 'true' }}\n", 1)

final_env = '''        env:
          DEPLOY_SHA: ${{ steps.source.outputs.sha }}
          DEPLOY_RESULT: ${{ job.status }}
'''
if s.count(final_env) != 1:
    raise SystemExit('final status env anchor mismatch')
s = s.replace(final_env, final_env + '''          PROVIDER_BLOCKED: ${{ steps.provider_gate.outputs.blocked }}
          PROVIDER_BLOCK_REASON: ${{ steps.provider_gate.outputs.reason }}
''', 1)
old_final = """            const success = process.env.DEPLOY_RESULT === 'success';
            await github.rest.repos.createCommitStatus({
              owner: context.repo.owner,
              repo: context.repo.repo,
              sha: process.env.DEPLOY_SHA,
              state: success ? 'success' : 'failure',
              context: 'chat-v2/staging',
              description: success
                ? 'OpenClaw-backed staging and configured QA gates passed'
                : 'OpenClaw staging deploy or QA failed',
              target_url: `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
            });
"""
new_final = """            const blocked = process.env.PROVIDER_BLOCKED === 'true';
            const success = process.env.DEPLOY_RESULT === 'success';
            await github.rest.repos.createCommitStatus({
              owner: context.repo.owner,
              repo: context.repo.repo,
              sha: process.env.DEPLOY_SHA,
              state: blocked ? 'error' : success ? 'success' : 'failure',
              context: 'chat-v2/staging',
              description: blocked
                ? 'AUTH/USAGE BLOCKED: provider model QA deferred'
                : success
                  ? 'OpenClaw-backed staging and configured QA gates passed'
                  : 'OpenClaw staging deploy or QA failed',
              target_url: blocked
                ? `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/issues/199`
                : `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
            });
"""
if s.count(old_final) != 1:
    raise SystemExit('final status script anchor mismatch')
s = s.replace(old_final, new_final, 1)
wf_path.write_text(s)

# 4) Document the fail-closed temporary gate next to the QA contract.
doc_path = Path('docs/E2E_STAGING_QA_GATES.md')
doc = doc_path.read_text()
section = '''\n## Provider usage / authentication external blocker\n\n`ops/staging-provider-usage-block.json` is an explicit, source-controlled emergency gate for a known provider authentication or usage exhaustion event. When the marker exists with `blocked: true`, `Deploy staging` publishes `chat-v2/staging = error` with `AUTH/USAGE BLOCKED` and skips all staging deployment and model-dependent QA calls. It never converts the gate to PASS.\n\nThe marker is intentionally non-secret and must contain `classification: AUTH/USAGE`, a bounded reason, and the canonical issue number. Once provider usage is restored, remove the marker (or set `blocked: false`) in a reviewed commit; that same main push re-enables normal fail-closed staging verification. Production workflows do not consume this marker.\n'''
if '## Provider usage / authentication external blocker' not in doc:
    doc_path.write_text(doc.rstrip() + '\n' + section)

print('provider usage gate patch applied')
