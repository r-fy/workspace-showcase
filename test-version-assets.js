'use strict';
// Self-check for scripts/version-assets.js — run: node test-version-assets.js (exits 1 on failure).
// Works on a throwaway copy of the repo layout, never the real public/ or src/.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ver-'));
fs.mkdirSync(path.join(tmp, 'scripts'));
fs.mkdirSync(path.join(tmp, 'public'));
fs.mkdirSync(path.join(tmp, 'src'));
fs.copyFileSync(path.join(__dirname, 'scripts/version-assets.js'), path.join(tmp, 'scripts/version-assets.js'));
fs.writeFileSync(path.join(tmp, 'public/app.css'), 'body{color:red}');
fs.writeFileSync(path.join(tmp, 'public/app.js'), 'console.log(1)');
fs.writeFileSync(path.join(tmp, 'src/editor.js'), 'export const e = 1');
fs.writeFileSync(path.join(tmp, 'src/dialer.js'), 'export const d = 1');
fs.writeFileSync(path.join(tmp, 'public/index.html'),
  '<link rel="stylesheet" href="/app.css?v=1">\n<script src="/editor.bundle.js?v=1"></script>\n' +
  '<script src="/dialer.bundle.js?v=1"></script>\n<script src="/app.js?v=1"></script>\n');
fs.writeFileSync(path.join(tmp, 'public/sw.js'),
  "const CACHE = 'workspace-v1';\nconst SHELL = ['/', '/index.html', '/manifest.json', " +
  "'/app.css?v=1', '/app.js?v=1', '/editor.bundle.js?v=1', '/dialer.bundle.js?v=1'];\n");

const run = () => execFileSync(process.execPath, [path.join(tmp, 'scripts/version-assets.js')], { encoding: 'utf8' });
const html = () => fs.readFileSync(path.join(tmp, 'public/index.html'), 'utf8');
const sw = () => fs.readFileSync(path.join(tmp, 'public/sw.js'), 'utf8');
const vOf = (text, asset) => (text.match(new RegExp('/' + asset.replace(/\./g, '\\.') + '\\?v=([^"\'\\s]*)')) || [])[1];
const cacheOf = () => (sw().match(/const CACHE = '([^']*)'/) || [])[1];
const ASSETS = ['app.css', 'app.js', 'editor.bundle.js', 'dialer.bundle.js'];

// First run stamps everything
run();
const v1 = Object.fromEntries(ASSETS.map(a => [a, vOf(html(), a)]));
const cache1 = cacheOf();
for (const a of ASSETS) {
  assert.ok(/^[0-9a-f]{8}$/.test(v1[a]), `${a} should get a content hash, got ${v1[a]}`);
  assert.strictEqual(vOf(sw(), a), v1[a], `${a}: index.html and sw.js must agree`);
}
assert.ok(/^workspace-[0-9a-f]{8}$/.test(cache1), 'cache name should be content-derived, got ' + cache1);

// Re-running with no source change is a no-op
const htmlBefore = html(), swBefore = sw();
const out = run();
assert.strictEqual(html(), htmlBefore, 'no source change must not rewrite index.html');
assert.strictEqual(sw(), swBefore, 'no source change must not rewrite sw.js');
assert.ok(/no change/.test(out), 'a no-op run should say so:\n' + out);

// One byte of app.css moves exactly that version, plus the cache name
fs.writeFileSync(path.join(tmp, 'public/app.css'), 'body{color:blue}');
run();
const v2 = Object.fromEntries(ASSETS.map(a => [a, vOf(html(), a)]));
assert.notStrictEqual(v2['app.css'], v1['app.css'], 'app.css version must change');
for (const a of ASSETS.filter(a => a !== 'app.css')) {
  assert.strictEqual(v2[a], v1[a], `${a} version must NOT change when only app.css changed`);
}
assert.notStrictEqual(cacheOf(), cache1, 'cache name must change when any asset changes');
for (const a of ASSETS) assert.strictEqual(vOf(sw(), a), v2[a], `${a}: index.html and sw.js must still agree`);

// A missing source file refuses to write a version rather than guessing
fs.unlinkSync(path.join(tmp, 'src/dialer.js'));
let failed = false;
try { run(); } catch (e) { failed = true; assert.ok(/missing/.test(String(e.stderr)), 'should say what is missing'); }
assert.ok(failed, 'a missing source file must exit non-zero');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('version-assets: all checks passed');
