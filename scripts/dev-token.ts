#!/usr/bin/env node
/**
 * Mint a session token for local development, so the app can be exercised
 * without a Google client ID.
 *
 * Reads TOKEN_SECRET from worker/.dev.vars — the same secret `wrangler dev`
 * loads, so the token the Worker issues and the one this prints are
 * interchangeable. There is deliberately no dev-bypass endpoint in the Worker:
 * an auth hole that only exists "in dev" is one deploy away from existing in
 * production.
 *
 *   node scripts/dev-token.ts                     # prints the token
 *   node scripts/dev-token.ts --paste             # prints the localStorage line
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { issueSession } from '../worker/lib/auth.js';

const devVars = fileURLToPath(new URL('../worker/.dev.vars', import.meta.url));

let secret: string | undefined;
try {
  secret = readFileSync(devVars, 'utf8')
    .split('\n')
    .find(l => l.startsWith('TOKEN_SECRET='))
    ?.slice('TOKEN_SECRET='.length)
    .trim();
} catch {
  console.error('No worker/.dev.vars. Create it with TOKEN_SECRET=<anything>.');
  process.exit(1);
}
if (!secret) {
  console.error('worker/.dev.vars has no TOKEN_SECRET line.');
  process.exit(1);
}

// A fake Google `sub`. Numeric, like a real one, and stable so local data
// survives across runs.
const SUB = '100000000000000000001';
const token = await issueSession(SUB, secret);

if (process.argv.includes('--paste')) {
  console.log(`localStorage.setItem('cadence.token', '${token}')`);
} else {
  console.log(token);
}
