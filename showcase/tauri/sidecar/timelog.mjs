// Time spent in focus blocks, in Data/timelog.json. Writes go through store.mjs (temp file, fsync, rename).
import { existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DIR, writeJson } from './store.mjs';

const file = path.join(DIR, 'timelog.json');
const number = (value) => (value == null ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
const bound = (value, fallback) => (value == null ? fallback : number(value) ?? fallback);

// An unreadable log is kept as timelog.json.bad rather than overwritten: the time is still there to recover.
function setAside(reason) {
  const bad = `${file}.bad`;
  try {
    if (existsSync(bad)) renameSync(bad, `${bad}.${Date.now()}`);
    renameSync(file, bad);
  } catch (e) {
    console.error(`[timelog] couldn't set the unreadable log aside: ${e.message}`);
  }
  console.error(`[timelog] timelog.json was unreadable (${reason}); kept it as ${path.basename(bad)}`);
}

function load() {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    setAside(e.message);
    return [];
  }
  if (!Array.isArray(data)) { setAside('not a list'); return []; }
  const good = (e) => e && typeof e === 'object' && number(e.start) != null && number(e.end) != null && number(e.minutes) != null && number(e.minutes) >= 0;
  if (!data.every(good)) { setAside('invalid entry'); return []; }
  return data.map((e) => ({ ...e, start: number(e.start), end: number(e.end), minutes: number(e.minutes) }));
}

// Serialised so overlapping block endings can't overwrite each other's entries.
let pending = Promise.resolve();
function change(fn) {
  const next = pending.then(async () => {
    const rows = fn(load());
    await writeJson(file, rows);
    return rows;
  });
  pending = next.catch(() => {});
  return next;
}

/** One ended focus block. itemId is present only when it was tied to a planner task. */
export function append(entry) {
  const start = number(entry?.start), end = number(entry?.end), minutes = number(entry?.minutes);
  if (start == null || end == null || minutes == null || minutes < 0) throw new Error('A time log entry needs a start, end and non-negative minutes.');
  const row = {
    itemId: typeof entry.itemId === 'string' && entry.itemId ? entry.itemId : null,
    title: String(entry.title ?? '').trim().slice(0, 120),
    start, end, minutes: Math.round(minutes),
  };
  return change((rows) => [...rows, row]);
}

/** Entries whose blocks overlap [from, to), oldest first. */
export function list({ from = 0, to = Infinity } = {}) {
  const first = bound(from, 0), last = bound(to, Infinity);
  return load().filter((e) => e.end > first && e.start < last).sort((a, b) => a.start - b.start).map((e) => ({ ...e }));
}

function group(rows, keyOf) {
  const groups = new Map();
  for (const e of rows) {
    const key = keyOf(e);
    const at = groups.get(key) ?? { itemId: e.itemId ?? null, title: e.title || 'Focus', minutes: 0 };
    at.minutes += e.minutes;
    groups.set(key, at);
  }
  return [...groups.values()].sort((a, b) => b.minutes - a.minutes || a.title.localeCompare(b.title));
}

/** Minutes per planner item and per title, with the overall total. */
export function totals({ from = 0, to = Infinity } = {}) {
  const rows = list({ from, to });
  return {
    total: rows.reduce((n, e) => n + e.minutes, 0),
    byItem: group(rows, (e) => (e.itemId ? `id:${e.itemId}` : `title:${e.title || 'Focus'}`)),
    byTitle: group(rows, (e) => e.title || 'Focus'),
  };
}
