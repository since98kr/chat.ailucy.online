#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const write = process.argv.includes('--write');
const bridgePath = resolve('ops/letta-bridge/letta-cli-bridge.mjs');

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

const probeBlock = `export async function createToolProbe() {
  const id = randomUUID().replaceAll('-', '');
  const token = randomUUID().replaceAll('-', '');
  const probe = {
    id,
    token,
    url: '',
    command: '',
    observed: false,
    runningEmitted: false,
    completedEmitted: false,
    server: null,
    onObserved: null,
  };
  const server = createServer((request, response) => {
    const remoteAddress = String(request.socket.remoteAddress || '');
    if (!LOOPBACK_ADDRESSES.has(remoteAddress)) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/' + id) {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    let bytes = 0;
    let oversized = false;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > TOOL_PROBE_MAX_BODY_BYTES) oversized = true;
      else chunks.push(Buffer.from(chunk));
    });
    request.on('end', () => {
      if (oversized) {
        response.writeHead(413).end();
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      if (body !== token) {
        response.writeHead(403).end();
        return;
      }
      if (!probe.observed) {
        probe.observed = true;
        probe.onObserved?.();
      }
      response.writeHead(204).end();
    });
    request.on('error', () => {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
  });
  probe.server = server;
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  server.on('error', () => {});
  server.unref?.();
  const address = server.address();
  if (!address || typeof address === 'string') {
    cleanupToolProbe(probe);
    throw new Error('Could not allocate the local tool proof endpoint');
  }
  probe.url = 'http://127.0.0.1:' + address.port + '/' + id;
  probe.command = "/usr/bin/curl --fail --silent --show-error --max-time 10 --request POST --header 'Content-Type: text/plain' --data-binary '" + token + "' '" + probe.url + "'";
  return probe;
}

export function observeToolProbe(probe) {
  return probe?.observed === true;
}

export function cleanupToolProbe(probe) {
  if (!probe) return;
  probe.onObserved = null;
  try {
    probe.server?.closeAllConnections?.();
    probe.server?.close();
  } catch {
    // The listener is loopback-only and best-effort cleanup also runs on session shutdown.
  }
  probe.server = null;
}

export function redactToolProbeText(value, probe) {
  if (typeof value !== 'string' || !probe) return value;
  return value.split(probe.url).join('[tool-probe-url-redacted]')
    .split(probe.token).join('[tool-probe-token-redacted]')
    .split(probe.id).join('[tool-probe-id-redacted]');
}

function toolProbeInstructions(probe) {
  const payload = JSON.stringify({ url: probe.url, token: probe.token, command: probe.command });
  return [
    '<CHAT_V2_LOCAL_TOOL_PROBE>',
    'This is an automated proof of real local CLI tool execution.',
    'Before producing any assistant text, invoke the advertised Bash tool and run the exact command from the JSON payload without changing or simulating it.',
    'The command performs one harmless POST to a bridge-owned loopback endpoint. A textual claim is not accepted as proof.',
    'Do not mention or reproduce the URL, token, command, port, or callback identifier in your answer.',
    'CHAT_V2_PROBE_JSON=' + payload,
    '</CHAT_V2_LOCAL_TOOL_PROBE>',
  ].join('\\n');
}

`;

const input = await readFile(bridgePath, 'utf8');
let source = input;
source = replaceOnce(source,
  "import { lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';",
  "import { readFileSync } from 'node:fs';",
  'filesystem probe imports');
source = replaceOnce(source,
  "const TOOL_PROBE_STATUS = 'filesystem_probe';",
  "const TOOL_PROBE_STATUS = 'loopback_callback_probe';\nconst TOOL_PROBE_MAX_BODY_BYTES = 128;\nconst LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);",
  'probe constants');
source = replaceRange(source,
  'export function createToolProbe(root) {',
  'function capsuleBlock(capsules) {',
  probeBlock,
  'filesystem probe implementation');
source = replaceOnce(source,
  "this.completePending(new Error('Lucy CLI runtime did not complete the verified local tool probe'));",
  "this.completePending(new Error('Lucy CLI runtime did not complete the verified loopback tool probe'));",
  'probe failure message');
source = replaceOnce(source,
  '    if (pending.probeInterval) clearInterval(pending.probeInterval);\n',
  '',
  'probe polling cleanup');
source = replaceOnce(source,
  '    const probe = toolProbeRequested(current) ? createToolProbe(this.config.cwd) : null;',
  '    const probe = toolProbeRequested(current) ? await createToolProbe() : null;',
  'probe creation');
source = replaceOnce(source,
  '        probe, probeInterval: null,',
  '        probe,',
  'pending probe shape');
source = replaceRange(source,
  '      if (probe) {\n        const observe = () => {',
  '      signal?.addEventListener',
  `      if (probe) {
        probe.onObserved = () => {
          if (this.pending !== pending || probe.runningEmitted) return;
          probe.runningEmitted = true;
          pending.onItem({ status: 'tool.running:' + TOOL_PROBE_STATUS });
        };
      }
`,
  'probe observation wiring');

if (source === input) throw new Error('No bridge changes produced');
if (write) await writeFile(bridgePath, source);
else console.log('Loopback local-tool proof bridge patch validated.');
