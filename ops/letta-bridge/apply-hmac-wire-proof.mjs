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

let source = await readFile(target, 'utf8');
const original = source;

source = replaceOnce(
  source,
  "  const command = 'node -e ' + JSON.stringify(script);",
  "  const command = JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(script);",
  'absolute Node command',
);

source = replaceOnce(
  source,
`    observed: false,
    runningEmitted: false,
    completedEmitted: false,`,
`    observed: false,
    runningEmitted: false,
    completedEmitted: false,
    toolSignalSeen: false,
    assistantTextSeen: false,
    prefixSeen: false,
    hexCandidateSeen: false,`,
  'probe diagnostics fields',
);

source = replaceOnce(
  source,
`export function observeToolProbe(probe, value) {
  if (!probe || typeof value !== 'string') return false;
  const match = /CHAT_V2_TOOL_PROBE_RESULT=([a-f0-9]{64})\\b/.exec(value);
  if (!match) return false;`,
`export function observeToolProbe(probe, value) {
  if (!probe || typeof value !== 'string') return false;
  if (value.includes(TOOL_PROBE_RESULT_PREFIX)) probe.prefixSeen = true;
  if (/CHAT_V2_TOOL_PROBE_RESULT=[a-fA-F0-9]{64}\\b/.test(value)) probe.hexCandidateSeen = true;
  const match = /CHAT_V2_TOOL_PROBE_RESULT=([a-f0-9]{64})\\b/.exec(value);
  if (!match) return false;`,
  'wire evidence observation',
);

source = replaceOnce(
  source,
`export function cleanupToolProbe(probe) {`,
`export function toolProbeDiagnostic(probe) {
  return [
    'tool_signal=' + (probe?.toolSignalSeen === true),
    'assistant_text=' + (probe?.assistantTextSeen === true),
    'prefix=' + (probe?.prefixSeen === true),
    'hex=' + (probe?.hexCandidateSeen === true),
  ].join(';');
}

export function cleanupToolProbe(probe) {`,
  'bounded probe diagnostics',
);

source = replaceOnce(
  source,
`    'After Bash succeeds, copy its stdout exactly after the result_prefix in your final one-sentence answer and also state the exact runtime model identifier.',
    'A claim without the exact Bash stdout fails verification. Do not reveal the command, environment variable name, challenge, secret, or raw digest except in the required prefixed result.',`,
`    'After Bash succeeds, answer in one sentence with the exact runtime model identifier and confirm that the verified local tool operation completed.',
    'The bridge verifies Bash output directly from the runtime wire. Do not reproduce the command, environment variable name, challenge, secret, or raw digest in the final answer.',`,
  'wire-verification prompt',
);

source = replaceOnce(
  source,
`    const pending = this.pending;
    if (!pending) return;
    const status = extractToolStatus(wire, this.toolNames);`,
`    const pending = this.pending;
    if (!pending) return;
    if (pending.probe && observeToolProbe(pending.probe, JSON.stringify(wire)) && !pending.probe.runningEmitted) {
      pending.probe.runningEmitted = true;
      pending.onItem({ status: 'tool.running:' + TOOL_PROBE_STATUS });
    }
    const status = extractToolStatus(wire, this.toolNames);
    if (status && pending.probe) pending.probe.toolSignalSeen = true;`,
  'raw wire proof observation',
);

source = replaceOnce(
  source,
`    if (delta) {
      pending.accumulated += delta;
      if (!pending.probe) pending.onItem({ delta });
    }`,
`    if (delta) {
      pending.accumulated += delta;
      if (pending.probe) pending.probe.assistantTextSeen = true;
      else pending.onItem({ delta });
    }`,
  'assistant text diagnostic',
);

source = replaceOnce(
  source,
`      if (pending.probe) {
        if (!observeToolProbe(pending.probe, rawFinalText)) {
          this.completePending(new Error('Lucy CLI runtime did not complete the verified HMAC tool probe'));
          return;
        }`,
`      if (pending.probe) {
        observeToolProbe(pending.probe, rawFinalText);
        if (!pending.probe.observed) {
          this.completePending(new Error(
            'Lucy CLI runtime did not complete the verified HMAC tool probe ('
              + toolProbeDiagnostic(pending.probe) + ')',
          ));
          return;
        }`,
  'fail-closed diagnostic',
);

if (source === original) throw new Error('No HMAC wire-proof changes produced');
if (write) await writeFile(target, source);
else console.log('HMAC wire-proof patch validated.');
