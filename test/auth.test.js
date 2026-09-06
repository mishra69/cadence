import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueSession, verifySession } from '../worker/lib/auth.js';

const SECRET = 'test-secret-not-the-real-one';
const SUB = '1029384756';
const NOW = Date.UTC(2026, 5, 15, 12, 0);

test('a freshly issued token verifies to the same subject', async () => {
  const t = await issueSession(SUB, SECRET, NOW);
  assert.equal(await verifySession(t, SECRET, NOW), SUB);
});

test('every kind of bad token is rejected the same way — null', async () => {
  const good = await issueSession(SUB, SECRET, NOW);
  const [payload, sig] = good.split('.');

  for (const [what, token] of [
    ['absent', null],
    ['empty', ''],
    ['not two parts', payload],
    ['garbage', 'aaa.bbb'],
    ['tampered payload', `${btoa('{"sub":"evil","exp":9999999999}').replace(/=+$/, '')}.${sig}`],
    ['tampered signature', `${payload}.${sig.slice(0, -2)}xy`],
    ['unsigned', `${payload}.`],
  ]) {
    assert.equal(await verifySession(token, SECRET, NOW), null, what);
  }
});

test('a token signed with another secret does not verify', async () => {
  const t = await issueSession(SUB, 'some-other-secret', NOW);
  assert.equal(await verifySession(t, SECRET, NOW), null);
});

test('an expired token is rejected', async () => {
  const t = await issueSession(SUB, SECRET, NOW);
  const past = NOW + 89 * 86_400_000;
  const future = NOW + 91 * 86_400_000;
  assert.equal(await verifySession(t, SECRET, past), SUB);
  assert.equal(await verifySession(t, SECRET, future), null);
});
