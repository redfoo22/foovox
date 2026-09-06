import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Mint a pairing code.
 *
 *   npm run pair -- --label "iphone" --ttl 30m
 *
 * The code is one-use and short-lived, so it can be texted. It is printed
 * once and never stored anywhere readable.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.FOOVOX_URL ?? 'http://127.0.0.1:3210';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const parseTtl = (s) => {
  if (!s) return null;
  const m = /^(\d+)\s*([smhd])?$/.exec(String(s).trim());
  if (!m) return null;
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2] ?? 'm'];
};

const token = readFileSync(path.join(ROOT, 'data', 'admin-token.txt'), 'utf8').trim();

const res = await fetch(`${BASE}/api/auth/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    label: arg('label', 'phone'),
    principalId: arg('principal', 'redfoo'),
    ttlMs: parseTtl(arg('ttl')),
  }),
});

const body = await res.json();
if (!res.ok) {
  console.error(`pairing failed (${res.status}): ${body.error ?? ''}`);
  process.exit(1);
}

const public_url = process.env.FOOVOX_PUBLIC_URL ?? BASE;
console.log(`\n  code    ${body.code}`);
console.log(`  link    ${public_url}/login?code=${encodeURIComponent(body.code)}`);
console.log(`  expires ${body.expiresAt}`);
console.log(`  for     ${body.principalId}\n`);
console.log('  One use. It stops working the moment it is claimed.\n');
