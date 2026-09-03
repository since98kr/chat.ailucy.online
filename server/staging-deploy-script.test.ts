import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('staging deployment rollback contract', () => {
  it('binds CHAT_IMAGE before asking docker compose for rollback logs', () => {
    const source = readFileSync(new URL('../scripts/deploy/staging.sh', import.meta.url), 'utf8');
    const start = source.indexOf('rollback() {');
    const end = source.indexOf('\n}\n\ntrap rollback ERR', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const rollback = source.slice(start, end);
    const bind = rollback.indexOf('export CHAT_IMAGE="${PREVIOUS_IMAGE:-${IMAGE}}"');
    const logs = rollback.indexOf('docker compose -p chat-v2-staging');
    expect(bind).toBeGreaterThanOrEqual(0);
    expect(logs).toBeGreaterThan(bind);
  });
});
