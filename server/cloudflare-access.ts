import { createRemoteJWKSet, jwtVerify } from 'jose';

export type CloudflareAccessIdentity =
  | { kind: 'email'; value: string }
  | { kind: 'service'; value: string };

export type CloudflareAccessVerifier = (assertion: string) => Promise<CloudflareAccessIdentity | null>;

function claimString(payload: Record<string, unknown>, name: string) {
  const value = payload[name];
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeAccessIssuer(value: string) {
  return value.trim().replace(/\/+$/, '');
}

export function createCloudflareAccessVerifier(
  issuerValue: string,
  audience: string,
): CloudflareAccessVerifier {
  const issuer = normalizeAccessIssuer(issuerValue);
  if (!issuer) throw new Error('Cloudflare Access issuer is required');
  if (!audience.trim()) throw new Error('Cloudflare Access audience is required');

  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  return async (assertion: string) => {
    const { payload } = await jwtVerify(assertion, jwks, {
      issuer,
      audience: audience.trim(),
    });
    const claims = payload as Record<string, unknown>;

    const email = claimString(claims, 'email').toLowerCase();
    if (email) return { kind: 'email', value: email };

    const serviceClientId = claimString(claims, 'common_name') || claimString(claims, 'service_token_id');
    if (serviceClientId) return { kind: 'service', value: serviceClientId.toLowerCase() };

    return null;
  };
}
