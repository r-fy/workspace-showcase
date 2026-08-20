'use strict';
// Self-check for replay-safe offline writes — run: node test-idempotency.js (exits 1 on failure).
// Boots the real server against a throwaway DB and replays writes the way the
// browser's outbox does after a dropped connection.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const PIN = '135792468';
const PORT = 45801;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-idem-'));
const DB = path.join(tmp, 'idem.db');
let token = null;

function req(method, p, body, key) {
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  return fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const notes = async () => (await (await req('GET', '/api/sync')).json()).notes;

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), AUTH_USERS: 'owner:' + PIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  await new Promise((resolve, reject) => {
    const t = setInterval(() => { if (/workspace listening on/.test(out)) { clearInterval(t); resolve(); } }, 50);
    setTimeout(() => { clearInterval(t); reject(new Error('server never came up:\n' + out)); }, 15000);
  });

  try {
    const li = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN }),
    });
    token = (await li.json()).token;

    // 1 — the same write sent twice creates one row and answers identically
    const key = 'op-aaaa-1111';
    const a = await req('POST', '/api/notes', { title: 'replayed', content: 'x' }, key);
    const bodyA = await a.text();
    const b = await req('POST', '/api/notes', { title: 'replayed', content: 'x' }, key);
    const bodyB = await b.text();
    assert.strictEqual(a.status, b.status, 'a replay should answer with the same status');
    assert.strictEqual(bodyA, bodyB, 'a replay should answer with the same body, byte for byte');
    assert.strictEqual((await notes()).filter(n => n.title === 'replayed').length, 1,
      'a replayed write must not create a second row');

    // 2 — a different id is a different write
    await req('POST', '/api/notes', { title: 'replayed', content: 'x' }, 'op-bbbb-2222');
    assert.strictEqual((await notes()).filter(n => n.title === 'replayed').length, 2,
      'a genuinely new write should still go through');

    // 3 — no id at all behaves exactly as before
    await req('POST', '/api/notes', { title: 'unkeyed', content: '' });
    await req('POST', '/api/notes', { title: 'unkeyed', content: '' });
    assert.strictEqual((await notes()).filter(n => n.title === 'unkeyed').length, 2,
      'writes with no idempotency id are untouched by this');

    // 4 — replaying a delete and then an edit, in that order, leaves it deleted
    const created = await (await req('POST', '/api/notes', { title: 'ordering', content: 'first' }, 'op-cccc-3333')).json();
    const delKey = 'op-dddd-4444', editKey = 'op-eeee-5555';
    await req('DELETE', '/api/notes/' + created.id, undefined, delKey);
    const editAfterDelete = await req('PUT', '/api/notes/' + created.id, { title: 'ordering', content: 'edited', tags: '' }, editKey);
    assert.strictEqual(editAfterDelete.status, 404,
      'an edit that arrives after the delete is refused — this is what stops deleted content coming back');
    // …and now the outbox replays both, in the order they were queued
    await req('DELETE', '/api/notes/' + created.id, undefined, delKey);
    await req('PUT', '/api/notes/' + created.id, { title: 'ordering', content: 'edited', tags: '' }, editKey);
    assert.ok(!(await notes()).some(n => n.id === created.id),
      'a replayed delete-then-edit pair must leave the note deleted, not resurrected');

    // 5 — the recorded replies are scoped per user and aged out
    {
      const db = new Database(DB, { readonly: true });
      const rows = db.prepare('SELECT * FROM processed_ops').all();
      db.close();
      // Four: the 404'd edit is deliberately NOT recorded — only successful
      // writes are worth replaying an answer for.
      assert.strictEqual(rows.length, 4, 'every successful keyed write should be recorded, got ' + rows.length);
      assert.ok(rows.every(r => r.status >= 200 && r.status < 300), 'only successful writes should be recorded');
      assert.ok(rows.every(r => r.user_id === 'owner'), 'records must be scoped to a user');
      assert.ok(rows.every(r => r.created_at > 0), 'records must be timestamped so they can age out');
    }

    // 6 — an id older than the keep-window is swept, so a stale replay runs fresh
    {
      const db = new Database(DB);
      db.prepare('UPDATE processed_ops SET created_at=? WHERE op_key=?').run(1, 'op-aaaa-1111');
      db.close();
    }
    child.kill('SIGKILL'); // the boot sweep is what clears them
    const child2 = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...process.env, DB_PATH: DB, PORT: String(PORT + 1), AUTH_USERS: 'owner:' + PIN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out2 = '';
    child2.stdout.on('data', d => { out2 += d; });
    child2.stderr.on('data', d => { out2 += d; });
    await new Promise((resolve, reject) => {
      const t = setInterval(() => { if (/workspace listening on/.test(out2)) { clearInterval(t); resolve(); } }, 50);
      setTimeout(() => { clearInterval(t); reject(new Error('server never came back up:\n' + out2)); }, 15000);
    });
    child2.kill('SIGKILL');
    const db = new Database(DB, { readonly: true });
    const stale = db.prepare('SELECT 1 FROM processed_ops WHERE op_key=?').get('op-aaaa-1111');
    db.close();
    assert.ok(!stale, 'an id older than the keep-window should be swept at boot');

    console.log('idempotency: all checks passed');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
