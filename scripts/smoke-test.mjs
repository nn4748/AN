// Exercises the API core with an in-memory store. Run: TEST_PASSCODE=xxxxxx npm test
import assert from 'node:assert/strict';
import { createApi, memoryStore } from '../lib/core.mjs';

let clock = Date.now();
const api = createApi({ store: memoryStore(), now: () => clock });
const call = (path, { method = 'GET', body, token, ip = '1.1.1.1' } = {}) =>
  api(new Request('https://x' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body && JSON.stringify(body),
  }), ip);

assert.equal((await call('/api/entries')).status, 401, 'entries need auth');
assert.equal((await call('/api/entries', { token: 'e30.forged' })).status, 401, 'forged token rejected');
assert.equal((await call('/api/unlock', { method: 'POST', body: { passcode: '000000' } })).status, 401);

const pin = process.env.TEST_PASSCODE;
if (pin) {
  const r = await call('/api/unlock', { method: 'POST', body: { passcode: pin }, ip: '2.2.2.2' });
  assert.equal(r.status, 200);
  let { token } = await r.json();
  let p = await call('/api/entries/2026-11-01', { method: 'PATCH', token, body: { sleep: 'aziz', kisses: 12 } });
  assert.equal(p.status, 200);
  token = p.headers.get('X-Session-Token');
  assert.ok(token, 'token renewed');
  assert.equal((await call('/api/entries/2026-11-01', { method: 'PATCH', token, body: { sleep: 'bob' } })).status, 400);
  const all = await (await call('/api/entries', { token })).json();
  assert.equal(all.entries['2026-11-01'].kisses, 12);

  clock += 31 * 60 * 1000;
  assert.equal((await call('/api/entries', { token })).status, 401, 'idle session expires');
  clock -= 31 * 60 * 1000;

  assert.equal((await call('/api/lock', { method: 'POST', token })).status, 200);
  assert.equal((await call('/api/entries', { token })).status, 401, 'revoked after lock');
}

for (let i = 0; i < 4; i++) await call('/api/unlock', { method: 'POST', body: { passcode: '111111' } });
assert.equal((await call('/api/unlock', { method: 'POST', body: { passcode: '111111' } })).status, 429, 'rate limited');
console.log('smoke test passed');
