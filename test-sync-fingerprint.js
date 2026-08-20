'use strict';
// Self-check for /api/sync's payload fingerprint — run: node test-sync-fingerprint.js (exits 1 on failure).
// Boots the real server against a throwaway DB and drives the poll path over HTTP.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PIN = '9999';
const PORT = 45501;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-sync-'));

let token = null;
const authHeader = () => 'Bearer ' + token;

async function login() {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN }),
  });
  assert.ok(res.ok, 'login should succeed before the sync checks can run');
  token = (await res.json()).token;
}

async function getSync(etag) {
  const headers = { Authorization: authHeader() };
  if (etag) headers['If-None-Match'] = etag;
  const res = await fetch(BASE + '/api/sync', { headers });
  assert.strictEqual(res.status, 200, 'sync should answer 200');
  return { etag: res.headers.get('etag'), body: await res.json() };
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, DB_PATH: path.join(tmp, 'sync.db'), PORT: String(PORT), AUTH_USERS: 'owner:' + PIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  await new Promise((resolve, reject) => {
    const t = setInterval(() => { if (/workspace listening on/.test(out)) { clearInterval(t); resolve(); } }, 100);
    setTimeout(() => { clearInterval(t); reject(new Error('server never came up:\n' + out)); }, 15000);
  });

  try {
    await login();

    // 1 — a first poll returns the full payload plus a fingerprint
    const first = await getSync(null);
    assert.ok(first.etag, 'sync must return an ETag');
    const KEYS = ['notes','boards','columns','tasks','reminders','calls','sms','prospect_lists','prospects','prospect_stats_today'];
    for (const k of KEYS) assert.ok(k in first.body, `full payload should still carry ${k}`);
    assert.ok(!('unchanged' in first.body), 'a first poll is never "unchanged"');

    // 2 — polling again with that fingerprint, nothing written in between
    const second = await getSync(first.etag);
    assert.deepStrictEqual(second.body, { unchanged: true }, 'an unchanged poll must not resend the database');
    assert.strictEqual(second.etag, first.etag, 'the fingerprint should not drift on its own');

    // 3 — a write between polls brings the full payload back
    const created = await fetch(BASE + '/api/notes', {
      method: 'POST',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'fingerprint check', content: 'hello' }),
    });
    assert.ok(created.ok, 'creating a note should succeed: ' + created.status);
    const third = await getSync(first.etag);
    assert.ok(!third.body.unchanged, 'a poll after a write must return real data');
    assert.notStrictEqual(third.etag, first.etag, 'the fingerprint must move when data moves');
    assert.ok(third.body.notes.some(n => n.title === 'fingerprint check'), 'the new note should be in the payload');

    // 4 — and the new fingerprint then holds steady
    const fourth = await getSync(third.etag);
    assert.deepStrictEqual(fourth.body, { unchanged: true }, 'the new fingerprint should hold until the next write');

    // 5 — a weak ETag (what Cloudflare sends back when it compresses) still matches
    const weak = await getSync('W/' + third.etag);
    assert.deepStrictEqual(weak.body, { unchanged: true }, 'a W/-prefixed fingerprint must still count as unchanged');

    console.log('sync fingerprint: all checks passed');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
