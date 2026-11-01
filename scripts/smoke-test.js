'use strict';
// Starts the server on a temp data dir and checks the auth + journal API.
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 3999;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'na-'));
const pin = process.env.TEST_PASSCODE;
const base = `http://127.0.0.1:${PORT}`;

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', DATA_DIR: dataDir },
    stdio: 'inherit',
  });
  await new Promise((r) => setTimeout(r, 500));
  const j = (p, o = {}) => fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) } });
  try {
    assert.equal((await j('/')).status, 200);
    assert.equal((await j('/api/entries')).status, 401, 'entries require auth');
    assert.equal((await j('/api/unlock', { method: 'POST', body: '{"passcode":"000000"}' })).status, 401);
    if (pin) {
      const r = await j('/api/unlock', { method: 'POST', body: JSON.stringify({ passcode: pin }) });
      assert.equal(r.status, 200);
      const { token } = await r.json();
      const auth = { Authorization: `Bearer ${token}` };
      let p = await j('/api/entries/2026-11-01', { method: 'PATCH', headers: auth, body: '{"sleep":"aziz","kisses":12}' });
      assert.equal(p.status, 200);
      p = await j('/api/entries/2026-11-01', { method: 'PATCH', headers: auth, body: '{"sleep":"bob"}' });
      assert.equal(p.status, 400, 'rejects invalid values');
      const all = await (await j('/api/entries', { headers: auth })).json();
      assert.equal(all.entries['2026-11-01'].kisses, 12);
      assert.equal((await j('/api/lock', { method: 'POST', headers: auth })).status, 200);
      assert.equal((await j('/api/entries', { headers: auth })).status, 401, 'token revoked after lock');
    }
    for (let i = 0; i < 5; i++) await j('/api/unlock', { method: 'POST', body: '{"passcode":"111111"}' });
    assert.equal((await j('/api/unlock', { method: 'POST', body: '{"passcode":"111111"}' })).status, 429, 'rate limited');
    console.log('smoke test passed');
  } finally {
    srv.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
