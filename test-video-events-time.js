// Smallest check that fails if the Worker-seconds -> app-milliseconds normalization
// in GET /api/leads/:id/videos/:vid/events breaks. The Worker's created_at is Unix
// seconds; the app (and fmtPacific in public/app.js) expects milliseconds everywhere.
const assert = require('assert');

// Same mapping used in server.js right after `const data = await wRes.json();`
function normalize(data) {
  if (Array.isArray(data.events)) data.events = data.events.map(e => ({ ...e, created_at: e.created_at * 1000 }));
  return data;
}

const secondsNow = Math.floor(Date.now() / 1000); // e.g. 1757894400 on 2026-09-15
const input = { events: [{ event: 'open', created_at: secondsNow }] };
const out = normalize(input);

assert.strictEqual(out.events[0].created_at, secondsNow * 1000, 'created_at must be converted to milliseconds');
assert.ok(new Date(out.events[0].created_at).getFullYear() >= 2026, 'converted timestamp must land in the present, not 1970');
assert.strictEqual(normalize({ events: [] }).events.length, 0, 'empty events array must stay empty');
assert.deepStrictEqual(normalize({}), {}, 'missing events key must be left alone');

console.log('test-video-events-time: ok');
