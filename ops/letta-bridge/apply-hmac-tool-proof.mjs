#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const write = process.argv.includes('--write');
const target = resolve('ops/letta-bridge/letta-cli-bridge.mjs');

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Ambiguous ${label}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceRange(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Missing ${label}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

const probeBlock = `export function createToolProbe(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('A session tool-proof secret is required');
  }
  const challenge = randomUUID().replaceAll('-', '');
  const expected = createHmac('sha256', secret).update(challenge).digest('hex');
  const command = 'node -e \'const c=require("node:crypto");process.stdout.write(c.createHmac("sha256",process.env.'
    + TOOL_PROBE_SECRET_ENV + ').update("' + challenge + '").digest("hex"))\'';
  return {
    secret,
    challenge,
    expected,
    command,
    observed: false,
    runningEmitted: false,
    completedEmitted: false,
  };
}

export function observeToolProbe(probe, value) {
  if (!probe || typeof value !== 'string') return false;
  const match = /CHAT_V2_TOOL_PROBE_RESULT=([a-f0-9]{64})\\b/i.exec(value);
  if (!match) return false;
  const supplied = Buffer.from(match[1].toLowerCase(), 'utf8');
  const expected = Buffer.from(probe.expected, 'utf8');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  probe.observed = true;
  return true;
}

export function cleanupToolProbe(probe) {
  if (!probe) return;
  probe.secret = '';
  probe.challenge = '';
  probe.expected = '';
  probe.command = '';
}

export function redactToolProbeText(value, probe) {
  if (typeof value !== 'string' || !probe) return value;
  return value.split(probe.command).join('[tool-probe-command-redacted]')
    .split(probe.secret).join('[tool-probe-secret-redacted]')
    .split(probe.challenge).join('[tool-probe-challenge-redacted]')
    .split(probe.expected).join('[verified-tool-hmac-redacted]');
}

function toolProbeInstructions(probe) {
  const payload = JSON.stringify({
    command: probe.command,
    description: 'Compute the required verification digest',
    result_prefix: TOOL_PROBE_RESULT_PREFIX,
  });
  return [
    '<CHAT_V2_LOCAL_TOOL_PROBE>',
    'This is an automated proof of real local CLI tool execution.',
    'The expected result depends on a secret available only in the CLI process environment and cannot be inferred from this prompt.',
    'Invoke the advertised Bash tool exactly once. Use the command and description from the JSON payload without changing, simulating, or explaining the command.',
    'After Bash succeeds, copy its stdout exactly after the result_prefix in your final one-sentence answer and also state the exact runtime model identifier.',
    'A claim without the exact Bash stdout fails verification. Do not reveal the command, environment variable name, challenge, secret, or raw digest except in the required prefixed result.',
    'CHAT_V2_PROBE_JSON=' + payload,
    '</CHAT_V2_LOCAL_TOOL_PROBE>',
  ].join('\\n');
}

`;

const input = await readFile(target, 'utf8');
let source = input;
source = replaceOnce(source,
  "import { randomUUID, timingSafeEqual } from 'node:crypto';",
  "import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';",
  'crypto import');
source = replaceOnce(source,
  "const TOOL_PROBE_STATUS = 'loopback_callback_probe';\nconst TOOL_PROBE_MAX_BODY_BYTES = 128;\nconst LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);",
  "const TOOL_PROBE_STATUS = 'hmac_challenge_probe';\nconst TOOL_PROBE_SECRET_ENV = 'CHAT_V2_TOOL_PROBE_SECRET';\nconst TOOL_PROBE_RESULT_PREFIX = 'CHAT_V2_TOOL_PROBE_RESULT=';",
  'HMAC probe constants');
source = replaceRange(source,
  'export async function createToolProbe() {',
  'function capsuleBlock(capsules) {',
  probeBlock,
  'loopback probe implementation');
source = replaceOnce(source,
  '    this.toolNames = new Map();\n',
  "    this.toolNames = new Map();\n    this.toolProbeSecret = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');\n",
  'session proof secret');
source = replaceOnce(source,
  '      env: process.env,\n',
  '      env: { ...process.env, [TOOL_PROBE_SECRET_ENV]: this.toolProbeSecret },\n',
  'CLI proof environment');
source = replaceOnce(source,
`      if (pending.probe) {
        if (!observeToolProbe(pending.probe)) {
          this.completePending(new Error('Lucy CLI runtime did not complete the verified loopback tool probe'));
          return;
        }
        if (!pending.probe.runningEmitted) {
          pending.probe.runningEmitted = true;
          pending.onItem({ status: 'tool.running:' + TOOL_PROBE_STATUS });
        }
        if (!pending.probe.completedEmitted) {
          pending.probe.completedEmitted = true;
          pending.onItem({ status: 'tool.completed:' + TOOL_PROBE_STATUS });
        }
      }
      const rawFinalText = typeof wire.result === 'string' ? wire.result : pending.accumulated;`,
`      const rawFinalText = typeof wire.result === 'string' ? wire.result : pending.accumulated;
      if (pending.probe) {
        if (!observeToolProbe(pending.probe, rawFinalText)) {
          this.completePending(new Error('Lucy CLI runtime did not complete the verified HMAC tool probe'));
          return;
        }
        if (!pending.probe.runningEmitted) {
          pending.probe.runningEmitted = true;
          pending.onItem({ status: 'tool.running:' + TOOL_PROBE_STATUS });
        }
        if (!pending.probe.completedEmitted) {
          pending.probe.completedEmitted = true;
          pending.onItem({ status: 'tool.completed:' + TOOL_PROBE_STATUS });
        }
      }`,
  'verified HMAC result handling');
source = replaceOnce(source,
  '    const probe = toolProbeRequested(current) ? await createToolProbe() : null;',
  '    const probe = toolProbeRequested(current) ? createToolProbe(this.toolProbeSecret) : null;',
  'HMAC probe creation');
source = replaceRange(source,
  '      if (probe) {\n        probe.onObserved = () => {',
  '      signal?.addEventListener',
  '',
  'obsolete callback observation');

if (source === input) throw new Error('No HMAC bridge changes produced');
if (write) await writeFile(target, source);
else console.log('HMAC local-tool proof bridge patch validated.');
