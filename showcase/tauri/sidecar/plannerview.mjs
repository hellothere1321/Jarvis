// The Planner page's data and what its buttons do. The page (panel.js) only draws this: the planner file stays the
// one source of truth, so every action calls planner.mjs and the view is built again from it. Dates are epoch
// milliseconds on the computer's local calendar.
import fs from 'node:fs';
import path from 'node:path';
import { DIR } from './store.mjs';
import * as planner from './planner.mjs';
import { describeRule, formatRule, nextOccurrence, parseRule, ruleFromWords } from './recur.mjs';
import { addDays, dayNumber, localDate, midnight, parseWhen } from './when.mjs';

const file = path.join(DIR, 'planner.json');
const pad = (n) => String(n).padStart(2, '0');
export const dayString = (time) => { const d = new Date(time); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const timeString = (time) => { const d = new Date(time); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function parseDay(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const day = localDate(+m[1], +m[2] - 1, +m[3]);
  return dayString(day) === m.slice(1).join('-') ? day : null;
}
function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null;
}
const atTime = (day, minutes) => new Date(day).setHours(0, minutes, 0, 0);

// ---------- the view ----------
const UPCOMING_DAYS = 14;
const mondayIndex = (time) => (new Date(time).getDay() + 6) % 7;
export const clampWeek = (n) => (Number.isInteger(n) ? Math.max(-104, Math.min(104, n)) : 0);

// One item as the page draws it. A repeating event is one row per occurrence (its id carries the start); its form
// edits the whole series, so the form's date is the series' first one.
function row(item, now) {
  const today = midnight(now), rule = parseRule(item.repeat), event = item.kind === 'event';
  const anchor = item.seriesStart ?? item.start;
  const words = rule ? describeRule(rule, anchor) : '';
  let seriesEnd = null;
  if (event) seriesEnd = item.allDay ? addDays(anchor, dayNumber(item.end) - dayNumber(item.start)) : anchor + (item.end - item.start);
  const timed = event && !item.allDay;
  return {
    id: item.series ? `${item.id}@${item.start}` : item.id, itemId: item.id, kind: item.kind, title: item.title, notes: item.notes,
    start: item.start, end: event ? item.end : null, allDay: item.allDay, done: item.done,
    overdue: !event && !item.done && item.start != null && item.start < today,
    repeat: words, series: !!item.series, cat: item.cat, priority: item.priority, est: item.est, spent: item.spent, link: item.link,
    form: {
      title: item.title, notes: item.notes, kind: item.kind, allDay: item.allDay,
      date: anchor == null ? '' : dayString(anchor), time: timed ? timeString(anchor) : '',
      endDate: event ? dayString(item.allDay ? addDays(seriesEnd, -1) : seriesEnd) : '', endTime: timed ? timeString(seriesEnd) : '',
      cat: item.cat, priority: item.priority, repeat: words, est: item.est, link: item.link,
    },
  };
}

// Events before tasks; all-day events first, then by time; tasks by priority.
const dayOrder = (a, b) => (a.kind === b.kind ? 0 : a.kind === 'event' ? -1 : 1)
  || (a.kind === 'event' ? (b.allDay - a.allDay) || a.start - b.start : b.priority - a.priority) || a.title.localeCompare(b.title);
const inDay = (r, day) => (r.kind === 'event'
  ? r.start < addDays(day, 1) && r.end > day
  : r.start != null && r.start >= day && r.start < addDays(day, 1));

// `count` days from `first`, each with what falls on it (a multi-day event is on every day it covers).
function byDay(items, first, count, now) {
  const rows = items.map((item) => row(item, now)), today = midnight(now);
  return Array.from({ length: count }, (_, i) => {
    const day = addDays(first, i);
    return { day, today: day === today, items: rows.filter((r) => inDay(r, day)).sort(dayOrder) };
  });
}

export function weekStart(now, offset = 0) {
  return addDays(midnight(now), -mondayIndex(now) + 7 * clampWeek(offset));
}

// reminders: the open commitments from store.mjs, shown read-only.
export function plannerView(now = Date.now(), { week = 0, reminders = [] } = {}) {
  try {
    const today = midnight(now), tomorrow = addDays(today, 1);
    const todays = planner.list({ from: today, to: tomorrow, includeOverdue: true, includeDone: true, now })
      .filter((item) => !item.done || item.lastDone >= today).map((item) => row(item, now));
    const next = addDays(today, 1);
    const upcoming = byDay(planner.list({ from: next, to: addDays(next, UPCOMING_DAYS), now }), next, UPCOMING_DAYS, now).filter((d) => d.items.length);
    const all = planner.list({ includeDone: true, now });
    const groups = new Map();
    for (const item of all.filter((i) => i.kind === 'task')) {
      const key = item.cat.toLowerCase();
      if (!groups.has(key)) groups.set(key, { name: item.cat, open: 0, overdue: 0, done: 0, items: [] });
      const g = groups.get(key), r = row(item, now);
      if (item.done) { g.done++; continue; }
      g.open++; if (r.overdue) g.overdue++;
      g.items.push(r);
    }
    const lists = [...groups.values()].sort((a, b) => (a.name === '') - (b.name === '') || a.name.localeCompare(b.name));
    const weekFirst = weekStart(now, week);
    const overdue = todays.filter((r) => r.overdue);
    return {
      now, error: null,
      today: {
        overdue, tasks: todays.filter((r) => r.kind === 'task' && !r.overdue).sort(dayOrder),
        events: todays.filter((r) => r.kind === 'event').sort(dayOrder),
        reminders: reminders.filter((c) => c.due != null && c.due < tomorrow).sort((a, b) => a.due - b.due)
          .map((c) => ({ id: c.id, text: c.text, due: c.due, overdue: c.due < today })),
      },
      overdue: overdue.length,
      upcoming, lists,
      week: { start: weekFirst, offset: clampWeek(week), days: byDay(planner.list({ from: weekFirst, to: addDays(weekFirst, 7), includeDone: true, now }), weekFirst, 7, now) },
      names: lists.map((l) => l.name).filter(Boolean),
    };
  } catch (e) {
    return { now, error: String(e?.message ?? e).slice(0, 200) };
  }
}

// Changes when the planner file or the day does, so the page can follow changes made anywhere.
export function plannerStamp(now = Date.now()) {
  try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}:${dayNumber(now)}`; } catch { return `none:${dayNumber(now)}`; }
}

// ---------- quick add ----------
// "math homework thursday", "dentist tue 3-4pm every 2 weeks", "essay friday #school !!". A date alone makes a task,
// a time makes an event. #name picks the list, ! to !!! the priority, and "task:" or "event:" in front (or kind)
// forces which.
export function parseQuick(input, now = Date.now(), { kind: forced = null } = {}) {
  let text = String(input ?? '').replace(/\s+/g, ' ').trim();
  const lead = /^(task|event)\s*:\s*/i.exec(text);
  if (lead) { forced = lead[1].toLowerCase(); text = text.slice(lead[0].length); }
  if (!text) return { ok: false, empty: true, error: '' };
  let cat = '', priority = 0;
  text = text.replace(/(?:^|\s)#([\p{L}\p{N}_-]+)/u, (_, name) => { cat = name; return ' '; });
  text = text.replace(/(?:^|\s)(!{1,3})(?=\s|$)/, (_, bangs) => { priority = bangs.length; return ' '; });

  const spoken = ruleFromWords(text, now, now), rule = spoken?.rule ?? null;
  if (spoken) text = spoken.rest;
  const when = parseWhen(text, now);
  const title = (when ? when.rest : text).replace(/\s+/g, ' ').trim();
  if (!title) return { ok: false, error: 'Add a title.' };
  const kind = forced ?? (when && !when.allDay ? 'event' : 'task');
  if (kind === 'event' && !when && !rule) return { ok: false, error: 'An event needs a date or time.' };

  const allDay = kind === 'task' || !when || when.allDay;
  let start = when ? (allDay ? midnight(when.start) : when.start) : rule ? midnight(now) : null;
  let end = kind === 'event' && when?.end != null ? when.end : null;
  if (rule) {
    const first = nextOccurrence(rule, start, start - 1);
    if (first == null) return { ok: false, error: 'That repeat has no dates.' };
    if (end != null) end += first - start;
    start = first;
  }
  const repeat = rule ? formatRule(rule, allDay) : null;
  const values = { kind, title, notes: '', start, end, allDay, repeat, cat, priority };
  return { ok: true, kind, title, start, end, allDay: kind === 'event' && allDay, repeat: rule ? describeRule(rule, start) : '', cat, priority, values };
}

// What the page shows before saving: the same parse, without the values that get saved.
export function preview(text, now, options) {
  const { values, ...shown } = parseQuick(text, now, options);
  return shown;
}

// ---------- the edit form ----------
function readRepeat(words, now, start, allDay) {
  const raw = parseRule(words);
  if (raw) return formatRule(raw, allDay);
  const spoken = ruleFromWords(words, now, start);
  if (!spoken || spoken.rest.replace(/[\s,;.]/g, '')) throw new Error(`I couldn’t read “${words}” as a repeat. Try “every week” or “every other Tuesday”.`);
  return formatRule(spoken.rule, allDay);
}

// The form's fields as planner values. repeat is left out when its words are the ones the item already shows, so a
// rule the words can't say exactly (days of the week with an interval) is kept as it was.
function fromForm(form, existing, now) {
  const kind = form.kind === 'event' ? 'event' : 'task';
  const day = form.date ? parseDay(form.date) : null;
  if (form.date && day == null) throw new Error('That date isn’t valid.');
  let start = null, end = null, allDay = false;
  if (kind === 'event') {
    if (day == null) throw new Error('An event needs a date.');
    const lastDay = form.endDate ? parseDay(form.endDate) : day;
    if (lastDay == null) throw new Error('That end date isn’t valid.');
    allDay = !!form.allDay;
    if (allDay) {
      if (lastDay < day) throw new Error('The last day can’t be before the first.');
      start = day; end = addDays(lastDay, 1);
    } else {
      const from = parseClock(form.time), to = form.endTime ? parseClock(form.endTime) : null;
      if (from == null) throw new Error('Add a start time, or tick All day.');
      if (form.endTime && to == null) throw new Error('That end time isn’t valid.');
      if (to == null && lastDay !== day) throw new Error('Add an end time.');
      start = atTime(day, from); end = to == null ? null : atTime(lastDay, to);
    }
  } else start = day;

  const words = String(form.repeat ?? '').trim();
  const before = existing?.repeat ? describeRule(parseRule(existing.repeat), existing.start) : '';
  const repeat = !words ? null : words === before ? undefined : readRepeat(words, now, start ?? now, kind === 'task' || allDay);
  const est = Number(form.est || 0);
  if (!Number.isInteger(est) || est < 0 || est > 100_000) throw new Error('The estimate is a whole number of minutes.');
  const link = String(form.link ?? '').trim();
  if (link && !isWebLink(link)) throw new Error('A link has to start with http:// or https://.');
  return {
    kind, local: { est, link },
    values: { title: String(form.title ?? ''), notes: String(form.notes ?? ''), start, end, allDay, cat: String(form.cat ?? ''), priority: Number(form.priority ?? 0), ...(repeat !== undefined && { repeat }) },
  };
}

function isWebLink(text) {
  try { return ['http:', 'https:'].includes(new URL(text).protocol); } catch { return false; }
}

// ---------- actions ----------
const ok = (note, extra = {}) => ({ ok: true, note, ...extra });
const bad = (note) => ({ ok: false, note });
const dayLabel = (time) => new Date(time).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const missing = () => bad('That item is gone. It may have been changed somewhere else.');

const handlers = {
  async add({ text, kind }, now) {
    const parsed = parseQuick(text, now, { kind: kind === 'task' || kind === 'event' ? kind : null });
    if (!parsed.ok) return bad(parsed.error || 'Type what to add first.');
    const item = await planner.add(parsed.values, now);
    return ok(`Added “${item.title}”.`, { added: item.id });
  },
  async save({ id, form }, now) {
    const item = planner.get(id);
    if (!item) return missing();
    const { kind, values, local } = fromForm(form ?? {}, item, now);
    if (kind === item.kind) {
      const saved = await planner.update(id, values, now);
      if (!saved) return missing();
      await planner.edit(id, local);
      return ok(`Saved “${saved.title}”.`);
    }
    // The planner keeps an item's kind for life: a task made an event (or back) is a new item in its place.
    const made = await planner.add({ ...values, ...local, kind, repeat: values.repeat === undefined ? item.repeat : values.repeat }, now);
    await planner.remove(id, now);
    return ok(`Saved “${made.title}” as ${kind === 'event' ? 'an event' : 'a task'}.`);
  },
  async done({ id, done = true }, now) {
    const item = await planner.complete(id, now, { done: done !== false });
    if (!item) return missing();
    if (done === false) return ok(`Back on your list: “${item.title}”.`);
    return ok(item.done ? `Done: “${item.title}”.` : `Done. Next: ${dayLabel(item.start)}.`);
  },
  async remove({ id }, now) {
    const item = planner.get(id);
    if (!item || !(await planner.remove(id, now))) return missing();
    return ok(`Deleted “${item.title}”.`);
  },
  // One occurrence of a repeating event.
  async skip({ id, start, allDay }, now) {
    if (!Number.isFinite(start)) return bad('Which one?');
    const event = await planner.skipOccurrence(id, start, !!allDay, now);
    return event ? ok(`Skipped “${event.title}” on ${dayLabel(event.start)}.`) : missing();
  },
  async open({ id }, now, open) {
    const item = planner.get(id);
    if (!item?.link || !isWebLink(item.link)) return bad('That item has no link to open.');
    open(item.link);
    return ok('');
  },
};

// Runs one of the page's actions. Never throws: a refused change comes back as { ok: false, note }.
export async function act(op, data = {}, { now = Date.now(), open = () => {} } = {}) {
  if (!Object.hasOwn(handlers, op)) return bad('I don’t know that planner action.');
  try { return await handlers[op](data ?? {}, now, open); } catch (e) { return bad(String(e?.message ?? e)); }
}
