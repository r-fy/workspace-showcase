'use strict';
// Self-check for the call log's redraw guard — run: node test-calllog-guard.js (exits 1 on failure).
// This one reads the source rather than running the app: the logic lives in
// browser DOM code, and the failure it guards against is somebody restoring the
// old unconditional guard, which a source check catches perfectly well.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'public/app.js'), 'utf8');

// The hold-back applies ONLY to the automatic poll redraw.
const guard = src.match(/^\s*if \(opts && opts\.fromPoll && \(log\.querySelector\('audio'\).*$/m);
assert.ok(guard, 'the audio/notes hold-back must be gated on opts.fromPoll, or user clicks get swallowed again');

assert.ok(/function renderCallLog\(opts\)/.test(src), 'renderCallLog should take the opts argument');

// Both automatic redraws must ask for the hold-back; nothing else should.
const calls = src.match(/renderCallLog\([^)]*\)/g) || [];
const polled = calls.filter(c => c.includes('fromPoll'));
assert.strictEqual(polled.length, 2, `exactly the two sync redraws pass fromPoll, found ${polled.length}`);
assert.ok(calls.length > polled.length, 'user-initiated redraws should still call renderCallLog() plainly');

// The old workaround is gone: deleting a call no longer has to hand-clear the
// audio slot to get past the guard.
assert.ok(!/call-audio-' \+ sid\)\?\.replaceChildren\(\)/.test(src),
  'the delete-a-call workaround for the old guard should be removed');

console.log('call log guard: all checks passed');
