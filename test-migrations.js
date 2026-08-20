'use strict';
// Self-check for server.js's migration helpers — run: node test-migrations.js (exits 1 on failure).
// Boots the real server as a child process against throwaway DBs and asserts:
//   1. a fresh DB migrates and the server comes up
//   2. booting a SECOND time over the same DB still comes up (duplicate-column ALTERs stay ignored)
//   3. a migration that fails for any other reason refuses the boot and names the statement
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-mig-'));
let port = 45311;

// Resolves { code, out } once the server either prints its listening line or exits.
function boot(dbPath) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...process.env, DB_PATH: dbPath, PORT: String(port++), AUTH_USERS: 'owner:9999' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const done = code => resolve({ code, out });
    const onData = d => {
      out += d.toString();
      if (/workspace listening on/.test(out)) { child.kill('SIGKILL'); done(0); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => done(code === null ? 0 : code));
    setTimeout(() => { child.kill('SIGKILL'); done(0); }, 15000);
  });
}

(async () => {
  // 1 + 2 — fresh DB, then the same DB again
  const good = path.join(tmp, 'good.db');
  const first = await boot(good);
  assert.strictEqual(first.code, 0, 'fresh DB should boot:\n' + first.out);
  assert.ok(fs.existsSync(good), 'DB file should exist after boot');
  const second = await boot(good);
  assert.strictEqual(second.code, 0, 'second boot over the same DB should still work:\n' + second.out);
  assert.ok(!/Migration failed/.test(second.out), 'a re-run additive ALTER must stay silent');

  // 3 — a migration that fails for a reason other than "already applied"
  const bad = path.join(tmp, 'bad.db');
  {
    const db = new Database(bad);
    db.exec('CREATE TABLE seed(a)');
    db.exec('CREATE VIEW notes AS SELECT * FROM seed'); // ALTER TABLE notes now fails: can't add a column to a view
    db.close();
  }
  const broken = await boot(bad);
  assert.notStrictEqual(broken.code, 0, 'a failing migration must refuse the boot, not be swallowed');
  assert.ok(/Migration failed/.test(broken.out), 'the error must say a migration failed:\n' + broken.out);
  assert.ok(/ALTER TABLE notes ADD COLUMN tags/.test(broken.out), 'the error must name the failing statement:\n' + broken.out);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('migrations: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
