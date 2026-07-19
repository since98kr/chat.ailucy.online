#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_API_ROOT = 'https://api.cloudflare.com/client/v4';
const APP_NAME = 'Chat V2 isolated staging';
const HUMAN_POLICY_NAME = 'Chat V2 staging human access';
const SERVICE_POLICY_NAME = 'Chat V2 staging automated E2E';
const SERVICE_TOKEN_NAME = 'chat-v2-staging-e2e';

function apiRoot() {
  return (process.env.CLOUDFLARE_API_ROOT?.trim() || DEFAULT_API_ROOT).replace(/\/$/, '');
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function allowedEmails() {
  const values = (process.env.CHAT_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!values.length) throw new Error('CHAT_ALLOWED_EMAILS must contain at least one human administrator before Access is enabled');
  return [...new Set(values)];
}

function secretFilePath() {
  return process.env.CHAT_CLOUDFLARE_ACCESS_STATE_FILE?.trim()
    || '/opt/chat-v2/staging/secrets/cloudflare-access-staging.json';
}

async function cloudflare(path, options = {}) {
  const response = await fetch(`${apiRoot()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    const detail = Array.isArray(payload?.errors)
      ? payload.errors.map((item) => item?.message || item?.code).filter(Boolean).join('; ')
      : `HTTP ${response.status}`;
    throw new Error(`Cloudflare API ${options.method || 'GET'} ${path} failed: ${detail || 'unknown error'}`);
  }
  return payload.result;
}

async function readState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function exactApplication(applications, hostname) {
  return applications.find((application) => {
    const domain = String(application?.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    return domain === hostname && application?.type === 'self_hosted';
  });
}

async function ensureApplication(accountId, hostname) {
  const query = new URLSearchParams({ domain: hostname, exact: 'true', per_page: '50' });
  const listed = await cloudflare(`/accounts/${accountId}/access/apps?${query}`);
  let application = exactApplication(Array.isArray(listed) ? listed : [], hostname);
  if (!application) {
    application = await cloudflare(`/accounts/${accountId}/access/apps`, {
      method: 'POST',
      body: JSON.stringify({
        name: APP_NAME,
        domain: hostname,
        type: 'self_hosted',
        session_duration: '24h',
        app_launcher_visible: false,
      }),
    });
    console.log(`[cloudflare-bootstrap] Created Access application for ${hostname}.`);
  } else {
    console.log(`[cloudflare-bootstrap] Reusing Access application for ${hostname}.`);
  }
  if (!application?.id || !application?.aud) {
    throw new Error('Cloudflare Access application is missing id or audience');
  }
  return application;
}

async function ensureHumanPolicy(accountId, application, emails) {
  const policies = await cloudflare(`/accounts/${accountId}/access/apps/${application.id}/policies?per_page=100`);
  const existingPolicies = Array.isArray(policies) ? policies : [];
  const existingHumanPolicy = existingPolicies.find((policy) => policy?.name === HUMAN_POLICY_NAME);
  const anyAllowPolicy = existingPolicies.some((policy) => policy?.decision === 'allow');
  const body = {
    name: HUMAN_POLICY_NAME,
    decision: 'allow',
    include: emails.map((email) => ({ email: { email } })),
  };

  if (existingHumanPolicy?.id) {
    await cloudflare(`/accounts/${accountId}/access/apps/${application.id}/policies/${existingHumanPolicy.id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    console.log('[cloudflare-bootstrap] Updated the managed human access policy.');
    return;
  }
  if (anyAllowPolicy) {
    console.log('[cloudflare-bootstrap] Preserving an existing human Allow policy.');
    return;
  }
  await cloudflare(`/accounts/${accountId}/access/apps/${application.id}/policies`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  console.log('[cloudflare-bootstrap] Created the human access policy before service authentication.');
}

async function ensureServiceToken(accountId, previousState) {
  const tokens = await cloudflare(`/accounts/${accountId}/access/service_tokens?per_page=100`);
  const existing = (Array.isArray(tokens) ? tokens : []).find((token) => token?.name === SERVICE_TOKEN_NAME);

  if (
    existing?.id
    && previousState?.serviceTokenId === existing.id
    && previousState?.clientId === existing.client_id
    && typeof previousState?.clientSecret === 'string'
    && previousState.clientSecret.length > 0
  ) {
    console.log('[cloudflare-bootstrap] Reusing the persisted staging service token.');
    return {
      id: existing.id,
      client_id: existing.client_id,
      client_secret: previousState.clientSecret,
    };
  }

  if (existing?.id) {
    const rotated = await cloudflare(`/accounts/${accountId}/access/service_tokens/${existing.id}/rotate`, {
      method: 'POST',
    });
    console.log('[cloudflare-bootstrap] Rotated the existing staging service token because its secret was unavailable.');
    return rotated;
  }

  const created = await cloudflare(`/accounts/${accountId}/access/service_tokens`, {
    method: 'POST',
    body: JSON.stringify({ name: SERVICE_TOKEN_NAME, duration: '8760h' }),
  });
  console.log('[cloudflare-bootstrap] Created a dedicated staging service token.');
  return created;
}

async function ensureServicePolicy(accountId, application, serviceTokenId) {
  const policies = await cloudflare(`/accounts/${accountId}/access/apps/${application.id}/policies?per_page=100`);
  const existing = (Array.isArray(policies) ? policies : []).find((policy) => policy?.name === SERVICE_POLICY_NAME);
  const body = {
    name: SERVICE_POLICY_NAME,
    decision: 'non_identity',
    include: [{ service_token: { token_id: serviceTokenId } }],
  };
  if (existing?.id) {
    await cloudflare(`/accounts/${accountId}/access/apps/${application.id}/policies/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    console.log('[cloudflare-bootstrap] Updated the managed Service Auth policy.');
    return;
  }
  await cloudflare(`/accounts/${accountId}/access/apps/${application.id}/policies`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  console.log('[cloudflare-bootstrap] Created the Service Auth policy.');
}

export async function main() {
  const accountId = required('CLOUDFLARE_ACCOUNT_ID');
  const origin = new URL(process.env.CHAT_PUBLIC_ORIGIN?.trim() || 'https://chat-staging.ailucy.online');
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('CHAT_PUBLIC_ORIGIN must be an HTTPS origin without a path, query, or fragment');
  }
  const emails = allowedEmails();
  const path = secretFilePath();
  const previousState = await readState(path);

  const organization = await cloudflare(`/accounts/${accountId}/access/organizations`);
  if (!organization?.auth_domain) throw new Error('Cloudflare Zero Trust organization has no auth_domain');
  const issuer = `https://${String(organization.auth_domain).replace(/^https?:\/\//, '').replace(/\/$/, '')}`;

  const application = await ensureApplication(accountId, origin.hostname);
  await ensureHumanPolicy(accountId, application, emails);
  const token = await ensureServiceToken(accountId, previousState);
  if (!token?.id || !token?.client_id || !token?.client_secret) {
    throw new Error('Cloudflare did not return a complete service token; the secret is only returned on create or rotate');
  }
  await ensureServicePolicy(accountId, application, token.id);

  const state = {
    version: 1,
    createdAt: new Date().toISOString(),
    publicOrigin: origin.origin,
    applicationId: application.id,
    audience: application.aud,
    issuer,
    serviceTokenId: token.id,
    clientId: token.client_id,
    clientSecret: token.client_secret,
  };
  await writeState(path, state);

  console.log('[cloudflare-bootstrap] Access application, human policy, service policy, and local credential state are ready.');
  console.log(`[cloudflare-bootstrap] State written with mode 0600 to ${path}.`);
  console.log(`[cloudflare-bootstrap] client-id=${state.clientId}`);
  console.log(`[cloudflare-bootstrap] issuer=${state.issuer}`);
  console.log(`[cloudflare-bootstrap] audience=${state.audience}`);
  return state;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[cloudflare-bootstrap] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
