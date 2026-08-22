// Smallest check that fails if the Connections logic breaks:
// threshold -> 'low', unset key -> 'unset', and a down network -> 'down'.
const assert = require('assert');
const { result, runChecks } = require('./connections');
const base = { id: 'x', name: 'X', group: 'balance', used_by: '', alert_at: 10 };
assert.strictEqual(result(base, { status: 'up', balance: 9.99 }).status, 'low');
assert.strictEqual(result(base, { status: 'up', balance: 10 }).status, 'up');
assert.strictEqual(result({ ...base, alert_at: null }, { status: 'up', balance: 0 }).status, 'up');
(async () => {
  const rows = await runChecks({ N8N_URL: 'http://127.0.0.1:9' });
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.strictEqual(by.dataforseo.status, 'unset');
  assert.strictEqual(by.n8n.status, 'down');
  assert.strictEqual(by.workspace.status, 'up');
  console.log('test-connections: ok');
})();
