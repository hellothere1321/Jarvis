// Habits in Data/habits.json: things to do every day or on chosen weekdays, ticked off once a day, with streaks and an
// optional reminder time. Days turn over at 4 am (brief.mjs), so ticking one off after midnight still counts for the
// evening before. Writes go through store.mjs (temp file, fsync, rename).
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DIR, writeJson } from './store.mjs';
import { briefDay } from './brief.mjs';
import { timeMinutes } from './quiet.mjs';
import { weekday } from './when.mjs';

const file = path.join(DIR, 'habits.json');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const KEEP_CHECKS = 800;   // check-ins kept per habit
const MAX_WALK = 1830;     // days a streak count looks back
export const MAX_TITLE = 80;

// ---------- days ----------
const dayDate = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
const validDay = (key) => typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key) && briefDay(dayDate(key).getTime() + 12 * 36e5) === key;
/** The day (YYYY-MM-DD) `ms` belongs to, turning over at 4 am. */
export const dayOf = (ms = Date.now()) => briefDay(ms);
/** 0 (Sunday) to 6 for a day key. */
export const weekdayOf = (key) => dayDate(key).getDay();
/** The day key `n` days after `key`. */
export function shiftDay(key, n) {
  const d = dayDate(key);
  d.setDate(d.getDate() + n);
  return briefDay(d.getTime() + 12 * 36e5);
}

/**
 * A schedule from what a person or the agent says: "daily", "weekdays", "weekends", "mon,wed,fri", a list of
 * weekday numbers (0 = Sunday) or names. → null (every day) or a sorted list of weekday numbers; undefined if unreadable.
 */
export function parseDays(value) {
  if (value == null) return null;
  const parts = Array.isArray(value) ? value : String(value).toLowerCase().split(/[\s,/&+]+|\band\b/).filter(Boolean);
  if (!parts.length) return null;
  const days = new Set();
  for (const part of parts) {
    if (typeof part === 'number') {
      if (!Number.isInteger(part) || part < 0 || part > 6) return undefined;
      days.add(part);
      continue;
    }
    const p = String(part).toLowerCase().trim();
    if (/^(?:daily|every ?day|everyday|all)$/.test(p)) return null;
    if (/^weekdays?$/.test(p)) { [1, 2, 3, 4, 5].forEach((d) => days.add(d)); continue; }
    if (/^weekends?$/.test(p)) { days.add(0); days.add(6); continue; }
    if (/^\d$/.test(p) && +p <= 6) { days.add(+p); continue; }
    const i = /^(?:sun|mon|tue|wed|thu|fri|sat)/.test(p) ? weekday(p) : -1;
    if (i < 0) return undefined;
    days.add(i);
  }
  return days.size === 7 ? null : [...days].sort((a, b) => a - b);
}

/** "every day", "weekdays", "Mon, Wed, Fri". */
export function describeDays(days) {
  if (!days || days.length === 7) return 'every day';
  const s = days.join('');
  if (s === '12345') return 'weekdays';
  if (s === '06') return 'weekends';
  return days.map((d) => DAYS[d]).join(', ');
}

/** Whether the habit is due on that day: its schedule includes the weekday and it already existed. */
export const scheduledOn = (habit, key) => key >= habit.since && (!habit.days || habit.days.includes(weekdayOf(key)));

/**
 * Where the habit stands on `key`: ticked today?, due today?, the streak (consecutive due days ticked, ending today if
 * ticked, else yesterday's due day: a day still to do doesn't break it), the best streak, and the last seven days.
 */
export function stats(habit, now = Date.now()) {
  const today = dayOf(now), done = new Set(habit.checks);
  let run = 0, best = 0;
  let key = habit.since;
  const first = shiftDay(today, -MAX_WALK);
  if (key < first) key = first;
  for (; key <= today; key = shiftDay(key, 1)) {
    if (!scheduledOn(habit, key)) continue;
    if (done.has(key)) { run++; best = Math.max(best, run); } else if (key !== today) run = 0;
  }
  const week = Array.from({ length: 7 }, (_, i) => {
    const day = shiftDay(today, i - 6);
    return { day, weekday: weekdayOf(day), scheduled: scheduledOn(habit, day), done: done.has(day) };
  });
  return { today, doneToday: done.has(today), dueToday: scheduledOn(habit, today), streak: run, best, week };
}

// ---------- storage ----------
// An unreadable file is kept as habits.json.bad rather than overwritten: the habits are still there to recover.
function setAside(reason) {
  const bad = `${file}.bad`;
  try {
    if (existsSync(bad)) renameSync(bad, `${bad}.${Date.now()}`);
    renameSync(file, bad);
  } catch (e) {
    console.error(`[habits] couldn't set the unreadable file aside: ${e.message}`);
  }
  console.error(`[habits] habits.json was unreadable (${reason}); kept it as ${path.basename(bad)}`);
}

const good = (h) => h && typeof h === 'object' && typeof h.id === 'string' && h.id && typeof h.title === 'string' && h.title.trim()
  && validDay(h.since) && Array.isArray(h.checks) && h.checks.every(validDay)
  && (h.days == null || (Array.isArray(h.days) && h.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)))
  && (h.remind == null || timeMinutes(h.remind) != null);

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
  if (!data.every(good)) { setAside('invalid habit'); return []; }
  return data.map((h) => ({ ...h, days: h.days ?? null, remind: h.remind ?? null, checks: [...new Set(h.checks)].sort() }));
}

// Serialised so overlapping panel clicks and tool calls see each other's changes.
let pending = Promise.resolve();
function change(fn) {
  const next = pending.then(async () => {
    const habits = load();
    const result = fn(habits);
    if (result == null) return null;
    await writeJson(file, habits);
    if (JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))) !== JSON.stringify(habits)) throw new Error('Could not save the habits.');
    return result;
  });
  pending = next.catch(() => {});
  return next;
}

function clean(values, habit) {
  const title = String(values.title ?? habit.title).replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('A habit needs a title.');
  if (title.length > MAX_TITLE) throw new Error(`Keep the title to ${MAX_TITLE} characters.`);
  const days = Object.hasOwn(values, 'days') ? parseDays(values.days) : habit.days;
  if (days === undefined) throw new Error('Days are every day, weekdays, weekends, or names like Mon, Wed, Fri.');
  let remind = habit.remind;
  if (Object.hasOwn(values, 'remind')) {
    const text = values.remind == null ? '' : String(values.remind).trim();
    remind = text === '' || text === 'none' ? null : text.length === 4 && text[1] === ':' ? `0${text}` : text;
    if (remind != null && timeMinutes(remind) == null) throw new Error('A reminder time is 24-hour like 08:30.');
  }
  return { title, days, remind };
}

// ---------- reading ----------
export const list = () => load();
export const get = (id) => load().find((h) => h.id === id) ?? null;

/** Habits with their standing today, in the order they were added. */
export function view(now = Date.now()) {
  return load().map((h) => ({
    id: h.id, title: h.title, days: h.days, schedule: describeDays(h.days), remind: h.remind, since: h.since, ...stats(h, now),
    form: { title: h.title, days: h.days ?? [], remind: h.remind ?? '' },
  }));
}

export function describe(habit, now = Date.now()) {
  const s = stats(habit, now);
  const today = !s.dueToday ? 'not due today' : s.doneToday ? 'done today' : 'not done yet today';
  return `${habit.id} · ${habit.title} · ${describeDays(habit.days)}${habit.remind ? ` · reminds at ${habit.remind}` : ''} · ${today} · streak ${s.streak}${s.best > s.streak ? ` (best ${s.best})` : ''}`;
}

// ---------- changing ----------
export function add(values, now = Date.now()) {
  return change((habits) => {
    const { title, days, remind } = clean(values, { title: '', days: null, remind: null });
    const habit = { id: randomUUID().slice(0, 8), title, days, remind, since: dayOf(now), checks: [] };
    habits.push(habit);
    return habit;
  });
}

export function update(id, values, now = Date.now()) {
  return change((habits) => {
    const habit = habits.find((h) => h.id === id);
    if (!habit) return null;
    Object.assign(habit, clean(values, habit));
    return habit;
  });
}

/** Ticks the habit off for today (or takes the tick back with done: false). */
export function checkIn(id, { done = true, now = Date.now() } = {}) {
  return change((habits) => {
    const habit = habits.find((h) => h.id === id);
    if (!habit) return null;
    const day = dayOf(now), has = habit.checks.includes(day);
    if (done && !has) habit.checks = [...habit.checks, day].sort().slice(-KEEP_CHECKS);
    else if (!done && has) habit.checks = habit.checks.filter((d) => d !== day);
    return habit;
  });
}

export function remove(id) {
  return change((habits) => {
    const i = habits.findIndex((h) => h.id === id);
    if (i < 0) return null;
    return habits.splice(i, 1)[0];
  });
}
