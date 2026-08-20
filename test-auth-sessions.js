'use strict';
// Self-check for the session-token auth — run: node test-auth-sessions.js (exits 1 on failure).
// Boots the real server against a throwaway DB and drives login/logout over HTTP.
// Takes ~10s: the progressive login delay is deliberately slow, and this measures it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const PIN = '246813579';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-auth-'));
const DB = path.join(tmp, 'auth.db');
let port = 45601;
let BASE = '';

function boot() {
  BASE = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(port++), AUTH_USERS: 'owner:' + PIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  return new Promise((resolve, reject) => {
    const t = setInterval(() => { if (/workspace listening on/.test(out)) { clearInterval(t); resolve(child); } }, 50);
    setTimeout(() => { clearInterval(t); child.kill('SIGKILL'); reject(new Error('server never came up:\n' + out)); }, 15000);
  });
}
const login = pin => fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
});

(async () => {
  let child = await boot();
  try {
    // 1 — the PIN buys a token
    const ok = await login(PIN);
    assert.strictEqual(ok.status, 200, 'the right PIN should log in');
    const { token } = await ok.json();
    assert.ok(token && token.length >= 32, 'login should return a real token, got ' + token);

    // 2 — the token authenticates a normal route
    const withToken = await fetch(BASE + '/api/sync', { headers: { Authorization: 'Bearer ' + token } });
    assert.strictEqual(withToken.status, 200, 'the token should work on a normal route');

    // 3 — the PIN itself does NOT authenticate a normal route any more
    const withPin = await fetch(BASE + '/api/sync', {
      headers: { Authorization: 'Basic ' + Buffer.from('owner:' + PIN).toString('base64') },
    });
    assert.strictEqual(withPin.status, 401, 'the PIN must only work at /api/auth/login');

    // 4 — the token in the /uploads cookie authenticates too (<img> can't send a header)
    fs.mkdirSync(path.join(tmp, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'uploads', 'probe.png'), 'not really a png');
    const noCookie = await fetch(BASE + '/uploads/probe.png');
    assert.strictEqual(noCookie.status, 401, 'uploads should be closed to strangers');
    const withCookie = await fetch(BASE + '/uploads/probe.png', {
      headers: { Cookie: 'ws_auth=' + encodeURIComponent('Bearer ' + token) },
    });
    assert.strictEqual(withCookie.status, 200, 'the cookie token should let the image through');
    assert.strictEqual(await withCookie.text(), 'not really a png', 'and serve the real file');

    // 5 — only the DB holds the token; the hash is stored, never the token itself
    {
      const db = new Database(DB, { readonly: true });
      const rows = db.prepare('SELECT token_hash FROM sessions').all();
      db.close();
      assert.strictEqual(rows.length, 1, 'exactly one session should exist');
      assert.ok(!rows.some(r => r.token_hash === token), 'the raw token must never be stored');
    }

    // 6 — logging out kills the token
    const out = await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
    assert.strictEqual(out.status, 200, 'logout should succeed');
    const after = await fetch(BASE + '/api/sync', { headers: { Authorization: 'Bearer ' + token } });
    assert.strictEqual(after.status, 401, 'a logged-out token must stop working');

    // 7 — each wrong guess answers slower than the last
    const t0 = Date.now(); await login('000000'); const first = Date.now() - t0;
    await login('000000');                                   // 2nd guess
    const t2 = Date.now(); await login('000000'); const third = Date.now() - t2;
    assert.ok(first >= 800, 'the first wrong guess should already stall ~1s, took ' + first + 'ms');
    assert.ok(third > first + 1500, `guess 3 (${third}ms) should be clearly slower than guess 1 (${first}ms)`);

    // 8 — that counter is in the database, so a restart does not wipe it
    const beforeRestart = (() => {
      const db = new Database(DB, { readonly: true });
      const r = db.prepare('SELECT fail_count FROM login_attempts').get();
      db.close(); return r;
    })();
    assert.ok(beforeRestart && beforeRestart.fail_count === 3, 'three failures should be recorded, got ' + JSON.stringify(beforeRestart));
    child.kill('SIGKILL'); child = await boot();
    await login('000000'); // 4th
    const afterRestart = (() => {
      const db = new Database(DB, { readonly: true });
      const r = db.prepare('SELECT fail_count FROM login_attempts').get();
      db.close(); return r;
    })();
    assert.strictEqual(afterRestart.fail_count, 4, 'the failure count must survive a restart, got ' + afterRestart.fail_count);

    // 9 — an active lockout blocks even the correct PIN, across a restart
    {
      const db = new Database(DB);
      db.prepare('UPDATE login_attempts SET locked_until=?').run(Date.now() + 60000);
      db.close();
    }
    child.kill('SIGKILL'); child = await boot();
    const locked = await login(PIN);
    assert.strictEqual(locked.status, 429, 'a lockout written before the restart must still apply');

    // 10 — clearing it lets the right PIN back in
    {
      const db = new Database(DB);
      db.prepare('DELETE FROM login_attempts').run();
      db.close();
    }
    const back = await login(PIN);
    assert.strictEqual(back.status, 200, 'the owner should get back in once the lockout expires');

    console.log('auth sessions: all checks passed');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
