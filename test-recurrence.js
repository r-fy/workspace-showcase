'use strict';
// Self-check for recurrence.js — run: node test-recurrence.js (exits 1 on failure).
const assert = require('assert');
const { laWall, laEpoch, advance, computeInitialNextFire } = require('./recurrence');

function la(y, m, d, hh, mm) { return laEpoch(y, m, d, hh, mm); }
function wallStr(t) { const w = laWall(t); return `${w.y}-${String(w.m).padStart(2,'0')}-${String(w.d).padStart(2,'0')} ${String(w.hh).padStart(2,'0')}:${String(w.mm).padStart(2,'0')}`; }

// ── laEpoch/laWall round-trip ──
assert.strictEqual(wallStr(la(2026, 7, 18, 9, 0)), '2026-07-18 09:00');
assert.strictEqual(wallStr(la(2026, 1, 15, 9, 0)), '2026-01-15 09:00'); // PST
assert.strictEqual(laWall(la(2026, 7, 18, 9, 0)).weekday, 6); // Saturday

// ── daily across spring-forward (US DST starts 2026-03-08) ──
{
  const r = { first_fire_at: la(2026, 3, 6, 9, 0), recur_type: 'daily', recur_interval: 1 };
  let t = r.first_fire_at;
  for (const expect of ['2026-03-07 09:00', '2026-03-08 09:00', '2026-03-09 09:00']) {
    t = advance(r, t);
    assert.strictEqual(wallStr(t), expect, 'daily spring-forward');
  }
}

// ── daily across fall-back (US DST ends 2026-11-01) ──
{
  const r = { first_fire_at: la(2026, 10, 30, 9, 0), recur_type: 'daily', recur_interval: 1 };
  let t = r.first_fire_at;
  for (const expect of ['2026-10-31 09:00', '2026-11-01 09:00', '2026-11-02 09:00']) {
    t = advance(r, t);
    assert.strictEqual(wallStr(t), expect, 'daily fall-back');
  }
}

// ── every 3 days stays on the anchored grid ──
{
  const r = { first_fire_at: la(2026, 7, 1, 8, 30), recur_type: 'daily', recur_interval: 3 };
  let t = advance(r, r.first_fire_at);
  assert.strictEqual(wallStr(t), '2026-07-04 08:30');
  t = advance(r, t);
  assert.strictEqual(wallStr(t), '2026-07-07 08:30');
  // advancing from an off-grid instant snaps to the grid, not +3 from the query time
  t = advance(r, la(2026, 7, 5, 12, 0));
  assert.strictEqual(wallStr(t), '2026-07-07 08:30');
}

// ── weekly every 2 weeks on Mon+Thu, crossing a month boundary ──
{
  // anchor week: week of Mon 2026-07-20 (weekdays 1 and 4)
  const r = { first_fire_at: la(2026, 7, 20, 10, 0), recur_type: 'weekly', recur_interval: 2, recur_weekdays: '1,4' };
  let t = r.first_fire_at;
  const seq = ['2026-07-23 10:00', '2026-08-03 10:00', '2026-08-06 10:00', '2026-08-17 10:00'];
  for (const expect of seq) {
    t = advance(r, t);
    assert.strictEqual(wallStr(t), expect, 'weekly every-2 Mon+Thu');
  }
}

// ── weekly with no weekdays falls back to first-fire's weekday ──
{
  const r = { first_fire_at: la(2026, 7, 22, 7, 0), recur_type: 'weekly', recur_interval: 1, recur_weekdays: null }; // a Wednesday
  const t = advance(r, r.first_fire_at);
  assert.strictEqual(wallStr(t), '2026-07-29 07:00');
  assert.strictEqual(laWall(t).weekday, 3);
}

// ── monthly on the 31st clamps to shorter months ──
{
  const r = { first_fire_at: la(2026, 1, 31, 12, 0), recur_type: 'monthly', recur_interval: 1 };
  let t = advance(r, r.first_fire_at);
  assert.strictEqual(wallStr(t), '2026-02-28 12:00'); // 2026 not a leap year
  t = advance(r, t);
  assert.strictEqual(wallStr(t), '2026-03-31 12:00'); // returns to the real day, not stuck at 28
  t = advance(r, t);
  assert.strictEqual(wallStr(t), '2026-04-30 12:00');
}

// ── yearly Feb-29 clamps on non-leap years ──
{
  const r = { first_fire_at: la(2024, 2, 29, 9, 0), recur_type: 'yearly', recur_interval: 1 };
  let t = advance(r, la(2025, 1, 1, 0, 0));
  assert.strictEqual(wallStr(t), '2025-02-28 09:00');
  t = advance(r, la(2028, 1, 1, 0, 0));
  assert.strictEqual(wallStr(t), '2028-02-29 09:00'); // leap year gets the real date back
}

// ── yearly every-2 stays on the anchored grid (regression: review finding) ──
{
  const r = { first_fire_at: la(2024, 6, 15, 9, 0), recur_type: 'yearly', recur_interval: 2 };
  assert.strictEqual(wallStr(advance(r, la(2026, 1, 1, 0, 0))), '2026-06-15 09:00');
  assert.strictEqual(wallStr(advance(r, la(2027, 1, 1, 0, 0))), '2028-06-15 09:00');
  assert.strictEqual(wallStr(advance(r, la(2030, 7, 1, 0, 0))), '2032-06-15 09:00');
}

// ── spring-forward gap: 2:30 AM lands post-jump, not an hour early (regression) ──
{
  assert.strictEqual(wallStr(la(2026, 3, 8, 2, 30)), '2026-03-08 03:30'); // nonexistent 2:30 → 3:30 PDT
  const r = { first_fire_at: la(2026, 3, 6, 2, 30), recur_type: 'daily', recur_interval: 1 };
  let t = advance(r, r.first_fire_at);
  assert.strictEqual(wallStr(t), '2026-03-07 02:30');
  const prev = t;
  t = advance(r, t);
  assert.strictEqual(wallStr(t), '2026-03-08 03:30'); // jump day: fires at the post-jump instant
  assert.ok(t > prev, 'chain stays monotonic');
  t = advance(r, t);
  assert.strictEqual(wallStr(t), '2026-03-09 02:30'); // back to normal next day
}

// ── weekly created on an off-grid weekday snaps to the grid (regression) ──
{
  const nowMs = la(2026, 7, 18, 12, 0);
  // Wed 2026-07-22 17:00 first fire, but only Mon+Thu selected → Thu 07-23
  const r = { first_fire_at: la(2026, 7, 22, 17, 0), recur_type: 'weekly', recur_interval: 1, recur_weekdays: '1,4' };
  const t = computeInitialNextFire(r, nowMs);
  assert.strictEqual(wallStr(t), '2026-07-23 17:00');
  assert.strictEqual(laWall(t).weekday, 4);
  // on-grid future first fire is kept exactly
  const r2 = { first_fire_at: la(2026, 7, 23, 17, 0), recur_type: 'weekly', recur_interval: 1, recur_weekdays: '1,4' };
  assert.strictEqual(computeInitialNextFire(r2, nowMs), r2.first_fire_at);
}

// ── exhausted series: advance null when whole series past end ──
{
  const nowMs = la(2026, 7, 18, 12, 0);
  const r = { first_fire_at: la(2026, 6, 1, 9, 0), recur_type: 'daily', recur_interval: 1, recur_end_at: la(2026, 6, 10, 23, 59) };
  assert.strictEqual(computeInitialNextFire(r, nowMs), null);
}

// ── recur_end_at cuts the series ──
{
  const r = { first_fire_at: la(2026, 7, 1, 9, 0), recur_type: 'daily', recur_interval: 1, recur_end_at: la(2026, 7, 3, 23, 59) };
  let t = advance(r, r.first_fire_at);
  assert.strictEqual(wallStr(t), '2026-07-02 09:00');
  t = advance(r, t);
  assert.strictEqual(wallStr(t), '2026-07-03 09:00');
  assert.strictEqual(advance(r, t), null, 'series must end after recur_end_at');
}

// ── computeInitialNextFire ──
{
  const nowMs = la(2026, 7, 18, 12, 0);
  // future first fire: kept as-is
  const fut = { first_fire_at: la(2026, 7, 20, 9, 0), recur_type: 'daily', recur_interval: 1 };
  assert.strictEqual(computeInitialNextFire(fut, nowMs), fut.first_fire_at);
  // long-overdue daily catches up to the next future occurrence
  const old = { first_fire_at: la(2026, 6, 1, 9, 0), recur_type: 'daily', recur_interval: 1 };
  assert.strictEqual(wallStr(computeInitialNextFire(old, nowMs)), '2026-07-19 09:00');
  // past one-off keeps its past time (fires once immediately)
  const oneoff = { first_fire_at: la(2026, 7, 10, 9, 0), recur_type: 'none' };
  assert.strictEqual(computeInitialNextFire(oneoff, nowMs), oneoff.first_fire_at);
}

console.log('recurrence: all checks passed');
