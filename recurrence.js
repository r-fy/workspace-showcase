'use strict';
// Recurrence math for reminders. All schedule arithmetic happens in
// America/Los_Angeles wall-clock space so a 9:00 AM reminder stays 9:00 AM
// across DST — never add raw day-milliseconds to an epoch.
const TZ = 'America/Los_Angeles';

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false,
});
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Epoch ms -> LA wall-clock parts { y, m, d, hh, mm, weekday } (m 1-12, weekday 0=Sun)
function laWall(epochMs) {
  const parts = {};
  for (const p of partsFmt.formatToParts(new Date(epochMs))) parts[p.type] = p.value;
  return {
    y: parseInt(parts.year, 10), m: parseInt(parts.month, 10), d: parseInt(parts.day, 10),
    hh: parseInt(parts.hour, 10) % 24, mm: parseInt(parts.minute, 10),
    weekday: WEEKDAYS[parts.weekday],
  };
}

// LA wall-clock time -> epoch ms. Guess UTC, measure how far off the LA
// rendering of the guess is, correct, re-check once (handles DST edges; the
// nonexistent spring-forward hour lands on the post-jump interpretation).
function laEpoch(y, m, d, hh, mm) {
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const w = laWall(guess);
    const diff = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm) - Date.UTC(y, m - 1, d, hh, mm);
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

// Calendar-day arithmetic on (y, m, d) without timezones (pure proleptic Gregorian).
function addDays(y, m, d, n) {
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
function dayNumber(y, m, d) { return Math.floor(Date.UTC(y, m - 1, d) / 86400000); }

function parseWeekdays(csv) {
  if (!csv) return [];
  return String(csv).split(',').map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
}

// Next occurrence strictly after fromEpochMs, or null when the series is
// exhausted (past recur_end_at) or the type is 'none'/unknown.
function advance(reminder, fromEpochMs) {
  const type = reminder.recur_type;
  const interval = Math.max(1, parseInt(reminder.recur_interval, 10) || 1);
  const first = laWall(reminder.first_fire_at);
  const from = laWall(fromEpochMs);
  let next = null;

  if (type === 'daily') {
    // First candidate on/after "from" that lands on the every-N-days grid
    // anchored at first_fire_at, then bump past fromEpochMs.
    const gap = dayNumber(from.y, from.m, from.d) - dayNumber(first.y, first.m, first.d);
    let steps = Math.max(0, Math.ceil(gap / interval));
    for (let i = 0; i < 3; i++) {
      const c = addDays(first.y, first.m, first.d, steps * interval);
      const t = laEpoch(c.y, c.m, c.d, first.hh, first.mm);
      if (t > fromEpochMs) { next = t; break; }
      steps++;
    }
  } else if (type === 'weekly') {
    let days = parseWeekdays(reminder.recur_weekdays);
    if (!days.length) days = [first.weekday];
    const anchorWeekStart = dayNumber(first.y, first.m, first.d) - first.weekday; // Sunday of first's week
    let c = addDays(from.y, from.m, from.d, 0);
    const cap = 7 * interval * 4 + 14;
    for (let i = 0; i < cap; i++) {
      const dn = dayNumber(c.y, c.m, c.d);
      const weekday = ((dn % 7) + 7 + 4) % 7; // epoch day 0 = Thursday (4)
      const weekStart = dn - weekday;
      const weeksFromAnchor = Math.floor((weekStart - anchorWeekStart) / 7);
      if (weeksFromAnchor >= 0 && weeksFromAnchor % interval === 0 && days.includes(weekday)) {
        const t = laEpoch(c.y, c.m, c.d, first.hh, first.mm);
        if (t > fromEpochMs) { next = t; break; }
      }
      c = addDays(c.y, c.m, c.d, 1);
    }
  } else if (type === 'monthly') {
    // Grid of first's (year, month) + k*interval months, on first's day clamped
    // to the target month's length.
    const monthsGap = (from.y - first.y) * 12 + (from.m - first.m);
    let k = Math.max(0, Math.floor(monthsGap / interval));
    for (let i = 0; i < 4; i++) {
      const total = first.m - 1 + k * interval;
      const y = first.y + Math.floor(total / 12), m = (total % 12) + 1;
      const d = Math.min(first.d, daysInMonth(y, m));
      const t = laEpoch(y, m, d, first.hh, first.mm);
      if (t > fromEpochMs) { next = t; break; }
      k++;
    }
  } else if (type === 'yearly') {
    let k = Math.max(0, from.y - first.y);
    for (let i = 0; i < 3; i++) {
      const y = first.y + k * interval;
      const d = Math.min(first.d, daysInMonth(y, first.m));
      const t = laEpoch(y, first.m, d, first.hh, first.mm);
      if (t > fromEpochMs) { next = t; break; }
      k++;
    }
  } else {
    return null;
  }

  if (next === null) return null;
  if (reminder.recur_end_at != null && next > reminder.recur_end_at) return null;
  return next;
}

// next_fire_at for a freshly created/edited reminder: the first fire if still
// ahead; else the next future occurrence for recurring; a past one-off keeps
// its past time so it fires once immediately (creating it was the intent).
function computeInitialNextFire(reminder, nowMs) {
  if (reminder.first_fire_at > nowMs) return reminder.first_fire_at;
  if (reminder.recur_type === 'none' || !reminder.recur_type) return reminder.first_fire_at;
  return advance(reminder, nowMs);
}

module.exports = { laWall, laEpoch, advance, computeInitialNextFire, parseWeekdays };
