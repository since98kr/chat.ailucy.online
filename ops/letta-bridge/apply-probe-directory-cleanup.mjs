#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = resolve('ops/letta-bridge/letta-cli-bridge.mjs');
const write = process.argv.includes('--write');
let source = await readFile(target, 'utf8');
const before = 'rmSync(probe.path, { force: true });';
const after = 'rmSync(probe.path, { recursive: true, force: true });';

if (!source.includes(after)) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`expected one cleanup target, found ${count}`);
  source = source.replace(before, after);
}
if (!source.includes(after)) throw new Error('recursive malformed-probe cleanup was not installed');

if (write) {
  await writeFile(target, source);
  console.log('Applied malformed probe directory cleanup.');
} else {
  console.log('Malformed probe directory cleanup validates.');
}
