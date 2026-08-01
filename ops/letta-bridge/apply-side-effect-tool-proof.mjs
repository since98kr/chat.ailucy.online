#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = resolve('ops/letta-bridge/letta-cli-bridge.mjs');
const write = process.argv.includes('--write');
let source = await readFile(target, 'utf8');

function replaceOnce(before, after, label) {
  if (source.includes(after)) return;
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one source match, found ${count}`);
  source = source.replace(before, after);
}

replaceOnce(
  `import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';`,
  `import { randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';`,
  'node imports',
);

replaceOnce(
  `const DEFAULT_PERMISSION_MODE = 'unrestricted';`,
  `const DEFAULT_PERMISSION_MODE = 'unrestricted';
const TOOL_PROBE_MARKER = '<CHAT_V2_VERIFY_LOCAL_TOOL>';
const TOOL_PROBE_ROOT = join(tmpdir(), 'chat-v2-letta-tool-probes');
const TOOL_PROBE_STATUS = 'filesystem_probe';`,
  'tool probe constants',
);

replaceOnce(
  `function latestUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && messageText(messages[index])) return messages[index];
  }
  return null;
}
`,
  `function latestUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && messageText(messages[index])) return messages[index];
  }
  return null;
}

function toolProbeRequested(message) {
  return messageText(message).includes(TOOL_PROBE_MARKER);
}

export function createToolProbe() {
  mkdirSync(TOOL_PROBE_ROOT, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const token = randomUUID().replaceAll('-', '');
  const path = join(TOOL_PROBE_ROOT, id + '.txt');
  rmSync(path, { force: true });
  return { path, token, observed: false, runningEmitted: false, completedEmitted: false };
}

export function observeToolProbe(probe) {
  if (!probe?.path || !probe?.token) return false;
  try {
    const stat = lstatSync(probe.path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > 128) return false;
    const content = readFileSync(probe.path, 'utf8');
    if (content.trim() !== probe.token) return false;
    probe.observed = true;
    return true;
  } catch {
    return false;
  }
}

export function cleanupToolProbe(probe) {
  if (!probe?.path) return;
  try {
    rmSync(probe.path, { force: true });
  } catch {
    // Best-effort cleanup is repeated when the session closes.
  }
}

export function redactToolProbeText(value, probe) {
  if (typeof value !== 'string' || !probe) return value;
  return value.split(probe.path).join('[tool-probe-path-redacted]')
    .split(probe.token).join('[tool-probe-token-redacted]');
}

function toolProbeInstructions(probe) {
  const payload = JSON.stringify({ path: probe.path, token: probe.token });
  return [
    '<CHAT_V2_LOCAL_TOOL_PROBE>',
    'This is an automated proof of real local CLI tool execution.',
    'Use an advertised local tool such as Write or Bash to create a regular UTF-8 file at the exact path in the JSON payload.',
    'The file must contain exactly the token and no other text. Then use an advertised local read tool to read it back before answering.',
    'Do not mention or reproduce the path or token in your answer. Do not claim completion unless both operations succeeded.',
    'CHAT_V2_PROBE_JSON=' + payload,
    '</CHAT_V2_LOCAL_TOOL_PROBE>',
  ].join('\\n');
}
`,
  'tool probe helpers',
);

replaceOnce(
  `    const delta = extractAssistantDelta(wire);
    if (delta) {
      pending.accumulated += delta;
      pending.onItem({ delta });
    }`,
  `    const delta = extractAssistantDelta(wire);
    if (delta) {
      pending.accumulated += delta;
      if (!pending.probe) pending.onItem({ delta });
    }`,
  'probe output buffering',
);

replaceOnce(
  `      const finalText = typeof wire.result === 'string' ? wire.result : pending.accumulated;
      if (!pending.accumulated && finalText) pending.onItem({ delta: finalText });
      if (pending.messageId && finalText) {
        this.cache.set(pending.messageId, finalText);
        while (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value);
      }
      this.turns += 1;
      this.completePending(null, { finalText, wire });`,
  `      if (pending.probe) {
        if (!observeToolProbe(pending.probe)) {
          this.completePending(new Error('Lucy CLI runtime did not complete the verified local tool probe'));
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
      const rawFinalText = typeof wire.result === 'string' ? wire.result : pending.accumulated;
      const finalText = pending.probe ? redactToolProbeText(rawFinalText, pending.probe) : rawFinalText;
      if (pending.probe && finalText) pending.onItem({ delta: finalText });
      else if (!pending.accumulated && finalText) pending.onItem({ delta: finalText });
      if (pending.messageId && finalText) {
        this.cache.set(pending.messageId, finalText);
        while (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value);
      }
      this.turns += 1;
      this.completePending(null, { finalText, wire });`,
  'verified probe completion',
);

replaceOnce(
  `    clearTimeout(pending.timeout);
    pending.signal?.removeEventListener('abort', pending.abortHandler);
    this.lastActivity = Date.now();`,
  `    clearTimeout(pending.timeout);
    if (pending.probeInterval) clearInterval(pending.probeInterval);
    cleanupToolProbe(pending.probe);
    pending.signal?.removeEventListener('abort', pending.abortHandler);
    this.lastActivity = Date.now();`,
  'probe cleanup',
);

replaceOnce(
  `    const prompt = buildTurnPrompt(payload, this.turns === 0, this.capabilities);
    return new Promise((resolve, reject) => {`,
  `    const probe = toolProbeRequested(current) ? createToolProbe() : null;
    const prompt = [
      buildTurnPrompt(payload, this.turns === 0, this.capabilities),
      probe ? toolProbeInstructions(probe) : '',
    ].filter(Boolean).join('\\n\\n');
    return new Promise((resolve, reject) => {`,
  'probe prompt injection',
);

replaceOnce(
  `      this.pending = {
        resolve, reject, onItem, accumulated: '', messageId, timeout, signal, abortHandler, lastStatus: '',
      };
      signal?.addEventListener('abort', abortHandler, { once: true });`,
  `      const pending = {
        resolve, reject, onItem, accumulated: '', messageId, timeout, signal, abortHandler, lastStatus: '',
        probe, probeInterval: null,
      };
      this.pending = pending;
      if (probe) {
        const observe = () => {
          if (this.pending !== pending || !observeToolProbe(probe) || probe.runningEmitted) return;
          probe.runningEmitted = true;
          pending.onItem({ status: 'tool.running:' + TOOL_PROBE_STATUS });
        };
        pending.probeInterval = setInterval(observe, 100);
        pending.probeInterval.unref?.();
        observe();
      }
      signal?.addEventListener('abort', abortHandler, { once: true });`,
  'probe observer',
);

for (const required of [
  'CHAT_V2_PROBE_JSON=',
  'tool.running:',
  'tool.completed:',
  'observeToolProbe(pending.probe)',
  'redactToolProbeText(rawFinalText, pending.probe)',
]) {
  if (!source.includes(required)) throw new Error(`missing transformed contract: ${required}`);
}

if (write) {
  await writeFile(target, source);
  console.log('Applied bridge-observed local-tool proof.');
} else {
  console.log('Bridge-observed local-tool proof validates.');
}
