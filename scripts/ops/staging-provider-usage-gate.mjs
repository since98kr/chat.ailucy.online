import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function readProviderUsageGate(path = 'ops/staging-provider-usage-block.json') {
  if (!existsSync(path)) {
    return { blocked: false, classification: null, reason: null, issue: null };
  }
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value.blocked !== 'boolean') {
    throw new Error('provider usage gate requires boolean blocked');
  }
  if (!value.blocked) {
    return { blocked: false, classification: null, reason: null, issue: null };
  }
  if (value.classification !== 'AUTH/USAGE') {
    throw new Error('blocked provider usage gate classification must be AUTH/USAGE');
  }
  const reason = String(value.reason ?? '').trim().replace(/\s+/g, ' ');
  if (!reason || reason.length > 180) {
    throw new Error('blocked provider usage gate requires a bounded reason');
  }
  const issue = Number(value.issue);
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new Error('blocked provider usage gate requires a positive issue number');
  }
  return { blocked: true, classification: 'AUTH/USAGE', reason, issue };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(readProviderUsageGate(process.argv[2])) + '\n');
}
