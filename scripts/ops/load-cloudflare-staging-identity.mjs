#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises';

function required(name, value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function envValue(name, value) {
  const normalized = required(name, value);
  if (/\r|\n/.test(normalized)) throw new Error(`${name} must not contain newlines`);
  return normalized;
}

export async function main() {
  const statePath = process.env.CHAT_CLOUDFLARE_ACCESS_STATE_FILE?.trim()
    || '/opt/chat-v2/staging/secrets/cloudflare-access-staging.json';
  const githubEnv = required('GITHUB_ENV', process.env.GITHUB_ENV);
  const publicOrigin = new URL(process.env.CHAT_PUBLIC_ORIGIN?.trim() || 'https://chat-staging.ailucy.online');

  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const clientId = envValue('clientId', state.clientId);
  const clientSecret = envValue('clientSecret', state.clientSecret);
  const issuer = envValue('issuer', state.issuer);
  const audience = envValue('audience', state.audience);

  if (state.publicOrigin && new URL(state.publicOrigin).origin !== publicOrigin.origin) {
    throw new Error(`Persisted Cloudflare identity belongs to ${new URL(state.publicOrigin).origin}, not ${publicOrigin.origin}`);
  }

  process.stdout.write(`::add-mask::${clientSecret}\n`);

  const healthUrl = new URL('/api/health', publicOrigin);
  const response = await fetch(healthUrl, {
    redirect: 'manual',
    headers: {
      'CF-Access-Client-Id': clientId,
      'CF-Access-Client-Secret': clientSecret,
    },
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  if (response.status !== 200) {
    throw new Error(`Persisted Cloudflare staging service identity failed edge preflight with HTTP ${response.status}`);
  }

  const lines = [
    `CF_ACCESS_CLIENT_ID=${clientId}`,
    `CF_ACCESS_CLIENT_SECRET=${clientSecret}`,
    `CHAT_ALLOWED_SERVICE_CLIENT_IDS=${clientId}`,
    `CHAT_CF_ACCESS_ISSUER=${issuer}`,
    `CHAT_CF_ACCESS_AUD=${audience}`,
  ];
  await appendFile(githubEnv, `${lines.join('\n')}\n`, { encoding: 'utf8' });

  console.log(`[cloudflare-staging-identity] PASS: protected staging identity ${clientId} received HTTP 200 and was loaded for subsequent steps.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[cloudflare-staging-identity] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
