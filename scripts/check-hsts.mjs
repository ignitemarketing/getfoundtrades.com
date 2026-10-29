// Fails unless public/_headers sends HSTS (max-age >= 1 year, includeSubDomains) on every path.
// Workers static assets copy public/_headers to dist/_headers, so this is what production serves.
import { readFileSync } from 'node:fs';

const MIN_MAX_AGE = 31536000;
const file = new URL('../public/_headers', import.meta.url);
let path = null;
const hsts = [];
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim() || line.trim().startsWith('#')) continue;
  if (!/^\s/.test(line)) { path = line.trim(); continue; }
  const [name, ...rest] = line.trim().split(':');
  if (path === '/*' && name.toLowerCase() === 'strict-transport-security') hsts.push(rest.join(':').trim());
}

const problems = [];
if (hsts.length !== 1) problems.push(`expected exactly one Strict-Transport-Security header under "/*", found ${hsts.length}`);
for (const value of hsts) {
  const maxAge = Number(/max-age=(\d+)/i.exec(value)?.[1] ?? NaN);
  if (!(maxAge >= MIN_MAX_AGE)) problems.push(`max-age must be >= ${MIN_MAX_AGE}: "${value}"`);
  if (!/(^|;)\s*includeSubDomains\s*(;|$)/i.test(value)) problems.push(`missing includeSubDomains: "${value}"`);
}

if (problems.length) {
  console.error('HSTS check failed (public/_headers):\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`HSTS check passed: ${hsts[0]}`);
