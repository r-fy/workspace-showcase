#!/usr/bin/env node
'use strict';
// Computes the cache-busting ?v= values and the service-worker cache name from
// file content, so nobody types a version number by hand. Run before every
// deploy (see CLAUDE.md's Deploy section):
//
//   node scripts/version-assets.js
//
// Rewrites public/index.html and public/sw.js in place. Running it twice with
// no source change does nothing. Exits 1 if a source file is missing.
//
// Why the bundles hash their SOURCE, not the built file: editor.bundle.js and
// dialer.bundle.js are gitignored and rebuilt inside the Docker build from
// src/*.js, so the local copy is often stale. Hashing the source is the honest
// input — change src/editor.js and the version moves, which is the whole point.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ASSETS = [
  { asset: 'app.css',            source: 'public/app.css' },
  { asset: 'app.js',             source: 'public/app.js' },
  { asset: 'editor.bundle.js',   source: 'src/editor.js' },
  { asset: 'dialer.bundle.js',   source: 'src/dialer.js' },
];

function hashFile(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    console.error(`FATAL: ${rel} is missing — refusing to write a version for an asset that isn't there.`);
    process.exit(1);
  }
  return crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 8);
}

const versions = {};
for (const a of ASSETS) versions[a.asset] = hashFile(a.source);
// One cache name covering the whole shell: any asset moving invalidates it.
const cacheName = 'workspace-' + crypto.createHash('sha256')
  .update(ASSETS.map(a => a.asset + ':' + versions[a.asset]).join('|'))
  .digest('hex').slice(0, 8);

function rewrite(rel, fn) {
  const full = path.join(ROOT, rel);
  const before = fs.readFileSync(full, 'utf8');
  const after = fn(before);
  if (after === before) return false;
  fs.writeFileSync(full, after);
  return true;
}

// Any /asset?v=... in index.html or sw.js, whatever the current value.
function stampVersions(text) {
  let out = text;
  for (const { asset } of ASSETS) {
    const re = new RegExp('(/' + asset.replace(/\./g, '\\.') + '\\?v=)[^"\'\\s]*', 'g');
    out = out.replace(re, '$1' + versions[asset]);
  }
  return out;
}

const changed = [];
if (rewrite('public/index.html', stampVersions)) changed.push('public/index.html');
if (rewrite('public/sw.js', text =>
  stampVersions(text).replace(/^const CACHE = '[^']*';/m, `const CACHE = '${cacheName}';`)
)) changed.push('public/sw.js');

for (const { asset } of ASSETS) console.log(`  ${asset.padEnd(18)} v=${versions[asset]}`);
console.log(`  cache              ${cacheName}`);
console.log(changed.length ? `updated: ${changed.join(', ')}` : 'no change — versions already match file contents');
