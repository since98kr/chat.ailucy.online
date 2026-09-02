from __future__ import annotations

import json
from pathlib import Path

# Source-controlled, non-secret external provider-usage blocker.
Path('ops').mkdir(exist_ok=True)
Path('ops/staging-provider-usage-block.json').write_text(json.dumps({
    'blocked': True,
    'classification': 'AUTH/USAGE',
    'reason': 'OpenAI OAuth usage exhausted; model-dependent staging QA is intentionally deferred.',
    'issue': 199,
    'setAt': '2026-09-02T13:14:00Z',
}, indent=2) + '\n')

Path('scripts/ops/staging-provider-usage-gate.mjs').write_text(r'''import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function readProviderUsageGate(path = 'ops/staging-provider-usage-block.json') {
  if (!existsSync(path)) {
    return { blocked: false, classification: null, reason: null, issue: null };
  }
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value.blocked !== 'boolean') {
    throw new Error('provider usage gate requires boolean blocked');
  }
  if (!value.blocked) {
    return { blocked: false, classification: null, reason: null, issue: null };
  }
  if (value.classification !== 'AUTH/USAGE') {
    throw new Error('blocked provider usage gate classification must be AUTH/USAGE');
  }
  const reason = String(value.reason ?? '').trim().replace(/\s+/g, ' ');
  if (!reason || reason.length > 180) {
    throw new Error('blocked provider usage gate requires a bounded reason');
  }
  const issue = Number(value.issue);
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new Error('blocked provider usage gate requires a positive issue number');
  }
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

pkg_path = Path('package.json')
pkg = json.loads(pkg_path.read_text())
nodecheck = 'node scripts/ops/staging-provider-usage-gate.nodecheck.mjs'
current = pkg['scripts']['test:qa-gates']
if nodecheck not in current:
    pkg['scripts']['test:qa-gates'] = f'{current} && {nodecheck}'
pkg_path.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + '\n')

wf_path = Path('.github/workflows/deploy-staging.yml')
s = wf_path.read_text()
anchor = 'jobs:\n  deploy:\n'
if s.count(anchor) != 1:
    raise SystemExit('deploy job anchor mismatch')
provider_job = r'''jobs:
  provider_gate:
    name: Classify provider usage gate
    runs-on: ubuntu-latest
    outputs:
      blocked: ${{ steps.gate.outputs.blocked }}
      classification: ${{ steps.gate.outputs.classification }}
      reason: ${{ steps.gate.outputs.reason }}
      issue: ${{ steps.gate.outputs.issue }}
      source_sha: ${{ steps.source.outputs.sha }}
    steps:
      - name: Checkout requested revision for gate classification
        uses: actions/checkout@v4
        with:
          ref: ${{ inputs.ref || github.sha }}
          clean: true

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Verify source revision
        id: source
        shell: bash
        run: |
          set -euo pipefail
          echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"

      - name: Read source-controlled provider usage gate
        id: gate
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
            echo "Provider-backed staging QA is externally blocked: ${classification} · issue #${issue}."
          else
            echo 'Provider-backed staging QA is enabled.'
          fi

  deploy:
'''
s = s.replace(anchor, provider_job, 1)

deploy_header = '''  deploy:\n    name: Deploy and verify isolated staging\n'''
if s.count(deploy_header) != 1:
    raise SystemExit('deploy header mismatch')
s = s.replace(
    deploy_header,
    deploy_header + "    needs: provider_gate\n    if: needs.provider_gate.outputs.blocked != 'true'\n",
    1,
)

provider_blocked_job = r'''

  provider_blocked:
    name: Record external provider usage blocker
    needs: provider_gate
    if: needs.provider_gate.outputs.blocked == 'true'
    runs-on: ubuntu-latest
    steps:
      - name: Publish AUTH/USAGE blocked commit status
        uses: actions/github-script@v7
        env:
          DEPLOY_SHA: ${{ needs.provider_gate.outputs.source_sha }}
          PROVIDER_CLASSIFICATION: ${{ needs.provider_gate.outputs.classification }}
          PROVIDER_BLOCK_REASON: ${{ needs.provider_gate.outputs.reason }}
          PROVIDER_BLOCK_ISSUE: ${{ needs.provider_gate.outputs.issue }}
        with:
          script: |
            await github.rest.repos.createCommitStatus({
              owner: context.repo.owner,
              repo: context.repo.repo,
              sha: process.env.DEPLOY_SHA,
              state: 'error',
              context: 'chat-v2/staging',
              description: 'AUTH/USAGE BLOCKED: provider model QA deferred',
              target_url: `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/issues/${process.env.PROVIDER_BLOCK_ISSUE}`,
            });

      - name: Publish external blocker summary
        shell: bash
        env:
          PROVIDER_CLASSIFICATION: ${{ needs.provider_gate.outputs.classification }}
          PROVIDER_BLOCK_REASON: ${{ needs.provider_gate.outputs.reason }}
          PROVIDER_BLOCK_ISSUE: ${{ needs.provider_gate.outputs.issue }}
        run: |
          {
            echo '## Chat V2 staging — externally blocked'
            echo
            echo "- Classification: \`${PROVIDER_CLASSIFICATION}\`"
            echo "- Reason: ${PROVIDER_BLOCK_REASON}"
            echo "- Canonical issue: #${PROVIDER_BLOCK_ISSUE}"
            echo '- Self-hosted staging, secrets, provider turns, browser model QA, and external QA were not started.'
            echo '- This is not a PASS. Remove or deactivate the source marker only after provider usage is restored.'
          } >> "$GITHUB_STEP_SUMMARY"

      - name: Fail closed without provider execution
        shell: bash
        run: |
          echo 'AUTH/USAGE BLOCKED: provider-backed staging QA was intentionally not executed.' >&2
          exit 1
'''
s = s.rstrip() + provider_blocked_job + '\n'
wf_path.write_text(s)

doc_path = Path('docs/E2E_STAGING_QA_GATES.md')
doc = doc_path.read_text()
section = '''\n## Provider usage / authentication external blocker\n\n`ops/staging-provider-usage-block.json` is an explicit, source-controlled emergency gate for a known provider authentication or usage exhaustion event. The GitHub-hosted `provider_gate` job evaluates it before the self-hosted staging job is scheduled. When `blocked: true`, staging/runtime secrets and provider calls are not started; the workflow records `chat-v2/staging = error` with `AUTH/USAGE BLOCKED` and fails closed. This is never acceptance evidence.\n\nThe marker is non-secret and requires `classification: AUTH/USAGE`, a bounded reason, and the canonical issue number. After usage is restored, remove the marker (or set `blocked: false`) in a reviewed commit; the next main push re-enables normal fail-closed staging verification. Production workflows do not consume this marker.\n'''
if '## Provider usage / authentication external blocker' not in doc:
    doc_path.write_text(doc.rstrip() + '\n' + section)

print('provider usage gate v2 patch applied')
