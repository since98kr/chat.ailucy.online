import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { GitHubOidcVerifier } from './copilot-relay-mcp.js';

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS = 'https://token.actions.githubusercontent.com/.well-known/jwks';
const AUDIENCE = 'aicos-copilot-relay-v1';
const REPOSITORY = 'since98kr/chat.ailucy.online';
const REPOSITORY_ID = '1262051098';
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/aicos-copilot-relay-broker-sync.yml@refs/heads/main`;

export function createOperationalRelayOidcVerifier(): GitHubOidcVerifier {
  const jwks = createRemoteJWKSet(new URL(JWKS));
  return async (token: string) => {
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: AUDIENCE });
      return payload.repository === REPOSITORY
        && String(payload.repository_id ?? '') === REPOSITORY_ID
        && payload.ref === 'refs/heads/main'
        && payload.workflow_ref === WORKFLOW_REF;
    } catch {
      return false;
    }
  };
}
