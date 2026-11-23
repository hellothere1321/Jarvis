// Tasks and calendar events in Data/planner.json. Dates are epoch milliseconds.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DIR, readJson, writeJson } from './store.mjs';
import { describeRule, expand, formatRule, nextOccurrence, parseRule, ruleFromWords } from './recur.mjs';
import { addDays, dayNumber, midnight, parseWhen } from './when.mjs';

const file = path.join(DIR, 'planner.json');
const minute = 60_000;
const eventDefault = 60 * minute;
const defaults = {
  kind: 'task', title: '', notes: '', start: null, end: null, allDay: false, done: false,
  alert: 10, fired: false, firedFor: null, repeat: null, skip: [], cat: '', priority: 0,
  lastDone: null, deleted: false, dirty: true, gId: null, gList: null, updated: null,
  est: 0, spent: 0, source: '', uid: null, link: '', blockFor: null,
};
const localFields = ['est', 'spent', 'source', 'uid', 'link', 'blockFor'];
const editable = ['title', 'notes', 'start', 'end', 'allDay', 'alert', 'repeat', 'skip', 'cat', 'priority'];
const picked = (fields, values) => Object.fromEntries(fields.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
const live = (item) => !item.deleted && (item.kind === 'task' || item.kind === 'event');
const validDate = (date) => typeof date === 'number' && Number.isFinite(+new Date(date));
const order = (a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || b.priority - a.priority || a.title.localeCompare(b.title);

function load() {
  const items = readJson(file, { backup: true }) ?? [];
  if (!Array.isArray(items)) throw new Error('The planner file does not contain an item list.');
  return items.map((item) => ({ ...defaults, skip: [], ...item }));
}

// Queue the whole read/modify/write so overlapping tools and alert ticks see each other's changes.
let pending = Promise.resolve();
const localListeners = new Set();
export function onLocalChange(listener) {
  localListeners.add(listener);
  return () => localListeners.delete(listener);
}

export const syncItems = load;
export function applySync(merge) {
  return change((items) => {
    const before = JSON.stringify(items);
    merge(items, (values) => {
      const item = { ...defaults, skip: [], ...values, id: randomUUID() };
      items.push(item);
      return item;
    });
    return JSON.stringify(items) === before ? null : true;
  });
}

function change(fn, local = false) {
  const next = pending.then(async () => {
    const items = load();
    const result = fn(items);
    if (result == null) return null;
    await writeJson(file, items, { backup: true });
    if (JSON.stringify(readJson(file)) !== JSON.stringify(items)) throw new Error('Could not save the planner.');
    if (local) for (const listener of localListeners) listener();
    return result;
  });
  pending = next.catch(() => {});
  return next;
}

function touched(item, now) {
  item.dirty = true;
  item.updated = now;
  return item;
}

function duration(item) {
  if (item.allDay) return item.end > item.start ? dayNumber(item.end) - dayNumber(item.start) : 1;
  return item.end > item.start ? item.end - item.start : eventDefault;
}

const endAt = (item, start, length) => item.allDay ? addDays(start, length) : start + length;

function normalize(item, now, repeatStartChanged) {
  item.title = item.title.trim();
  item.cat = item.cat.trim();
  if (!item.title) throw new Error('A planner item needs a title.');
  if (!['task', 'event'].includes(item.kind)) throw new Error('Planner items are tasks or events.');
  if (!Number.isInteger(item.priority) || item.priority < 0 || item.priority > 3) throw new Error('Priority must be 0 through 3.');
  if (item.start != null && !validDate(item.start)) throw new Error('Invalid planner start date.');
  if (item.end != null && !validDate(item.end)) throw new Error('Invalid planner end date.');
  if (!Array.isArray(item.skip) || item.skip.some((date) => !validDate(date))) throw new Error('Invalid skip dates.');
  const spoken = item.repeat && ruleFromWords(item.repeat, now, item.start ?? now);
  const rule = parseRule(item.repeat) ?? (spoken?.rest === '' ? spoken.rule : null);
  if (item.repeat != null && !rule) throw new Error('Invalid repeat rule.');

  if (item.kind === 'task') {
    item.start = item.start == null && !rule ? null : midnight(item.start ?? now);
    item.end = null;
    item.allDay = false;
  } else {
    if (item.start == null) throw new Error('An event needs a start date.');
    if (!Number.isSafeInteger(item.alert) || item.alert < 0) throw new Error('An alert needs a nonnegative number of minutes.');
    if (item.allDay) {
      item.start = midnight(item.start);
      if (item.end != null) item.end = midnight(item.end);
    }
    if (item.end == null) item.end = endAt(item, item.start, item.allDay ? 1 : eventDefault);
    if (item.end <= item.start) throw new Error('An event must end after it starts.');
  }
  if (rule && repeatStartChanged) {
    const first = nextOccurrence(rule, item.start, item.start - 1);
    if (first == null) throw new Error('The repeat rule has no dates on or after the start.');
    if (item.kind === 'event') item.end = endAt(item, first, duration(item));
    item.start = first;
  }
  item.repeat = rule ? formatRule(rule, item.kind === 'task' || item.allDay) : null;
  return item;
}

export function add(values, now = Date.now()) {
  return change((items) => {
    const item = normalize({ ...defaults, skip: [], ...picked([...editable, ...localFields, 'kind'], values), id: randomUUID() }, now, true);
    items.push(touched(item, now));
    return item;
  }, true);
}

export function update(id, values, now = Date.now()) {
  return change((items) => {
    const item = items.find((candidate) => candidate.id === id && live(candidate));
    if (!item) return null;
    const patch = picked(editable, values), next = { ...item, ...patch };
    if (item.kind === 'task' && patch.start === null && next.repeat) throw new Error('Clear the repeat before clearing a repeating task’s due date.');
    if (item.kind === 'event' && !Object.hasOwn(patch, 'end')) {
      if (next.allDay !== item.allDay) next.end = null;
      else if (next.start !== item.start) next.end = endAt(item, next.start, duration(item));
    }
    normalize(next, now, next.start !== item.start || next.repeat !== item.repeat);
    if (next.start !== item.start || next.repeat !== item.repeat || next.allDay !== item.allDay) {
      next.fired = false;
      next.firedFor = null;
    }
    return Object.assign(item, touched(next, now));
  }, true);
}

export function edit(id, values) {
  return change((items) => {
    const item = items.find((candidate) => candidate.id === id && live(candidate));
    return item ? Object.assign(item, picked(localFields, values)) : null;
  });
}

/** Adds minutes a focus block spent on a task to its local `spent` field, queued with the other writes. */
export function addSpent(id, minutes, now = Date.now()) {
  const n = Math.max(0, Math.round(Number(minutes) || 0));
  if (!n) return get(id);
  return change((items) => {
    const item = items.find((candidate) => candidate.id === id && live(candidate) && candidate.kind === 'task');
    if (!item) return null;
    item.spent = (Number(item.spent) || 0) + n;
    return touched(item, now);
  });
}

export function advanceCompletedTask(item, now) {
  const rule = parseRule(item.repeat);
  if (!rule || item.start == null) return false;
  // A late completion skips dates that have already passed, including their share of COUNT.
  const next = nextOccurrence(rule, item.start, Math.max(item.start, midnight(now)));
  if (next == null) return false;
  if (rule.count) {
    const elapsed = [...expand(rule, item.start, item.start, next)].length;
    item.repeat = formatRule({ ...rule, count: rule.count - elapsed });
  }
  item.start = next;
  item.done = false;
  item.lastDone = now;
  touched(item, now);
  return true;
}

export function complete(id, now = Date.now(), { done = true } = {}) {
  return change((items) => {
    const item = items.find((candidate) => candidate.id === id && live(candidate) && candidate.kind === 'task');
    if (!item || item.done === done) return item ?? null;
    if (done && advanceCompletedTask(item, now)) return item;
    item.done = done;
    item.lastDone = done ? now : null;
    return touched(item, now);
  }, true);
}

export function remove(id, now = Date.now()) {
  return change((items) => {
    const item = items.find((candidate) => candidate.id === id && live(candidate));
    if (!item) return null;
    item.deleted = true;
    return touched(item, now);
  }, true);
}

export const get = (id) => load().find((item) => item.id === id && live(item)) ?? null;

function eventOccurrences(item, from, to) {
  if (!validDate(item.start) || !(from < to)) return [];
  const length = duration(item), rule = parseRule(item.repeat);
  // Include occurrences that start before the window and are still in progress.
  const lower = item.allDay ? addDays(midnight(from), -length) : from - length;
  const starts = rule ? expand(rule, item.start, lower, to) : [item.start];
  const exactSkips = new Set(item.skip);
  const daySkips = new Set(item.skip.filter((date) => date === midnight(date)));
  const events = [];
  for (const start of starts) {
    const end = endAt(item, start, length);
    if (start >= to || end <= from || (rule && (exactSkips.has(start) || daySkips.has(midnight(start))))) continue;
    events.push({ ...item, start, end, series: !!rule, seriesStart: item.start });
  }
  return events;
}

export function occurrences(from, to) {
  return load().filter((item) => live(item) && item.kind === 'event').flatMap((item) => eventOccurrences(item, from, to)).sort(order);
}

export function skipOccurrence(id, start, allDay = false, now = Date.now()) {
  return change((items) => {
    const item = items.find((candidate) => candidate.id === id && live(candidate) && candidate.kind === 'event' && candidate.repeat);
    if (!item) return null;
    const from = allDay ? midnight(start) : start;
    const to = allDay ? addDays(from, 1) : start + 1;
    const event = eventOccurrences(item, from, to).find((entry) => entry.start >= from);
    if (!event) return null;
    item.skip = [...item.skip, event.start];
    touched(item, now);
    return event;
  }, true);
}

// A bounded query expands events. An unbounded query returns the stored event series.
export function list({ from = null, to = null, cat, kind, overdue = false, includeOverdue = false, includeDone = false, now = Date.now() } = {}) {
  const today = midnight(now);
  const items = load().filter((item) => live(item) && (kind == null || item.kind === kind) && (cat == null || item.cat.toLowerCase() === cat.trim().toLowerCase()));
  const result = [];
  for (const item of items) {
    if (item.kind === 'event') {
      if (!overdue) result.push(...(from != null && to != null ? eventOccurrences(item, from, to) : [item]));
    } else if (includeDone || !item.done) {
      const late = item.start != null && item.start < today && !item.done;
      const inRange = (from == null && to == null) || (item.start != null && (from == null || item.start >= from) && (to == null || item.start < to));
      if (overdue ? late : (includeOverdue && late) || inRange) result.push(item);
    }
  }
  return result.sort(order);
}

export function todayRows(now = Date.now()) {
  const today = midnight(now), tomorrow = addDays(today, 1);
  return list({ from: today, to: tomorrow, includeOverdue: true, includeDone: true, now })
    .filter((item) => !item.done || item.lastDone >= today)
    .map((item) => ({
      id: item.kind === 'event' && item.series ? `${item.id}-${item.start}` : item.id,
      kind: item.kind, text: item.title, due: item.start, done: item.done,
      overdue: item.kind === 'task' && !item.done && item.start < today,
      repeat: item.repeat, allDay: item.allDay, end: item.end,
    }));
}

const dateLabel = (time) => new Date(time).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
export const timeLabel = (time) => new Date(time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
export function describeItem(item, now = Date.now()) {
  const day = item.start == null ? '' : dateLabel(item.start);
  let when = day;
  if (item.kind === 'task' && day) when = `${item.start < midnight(now) && !item.done ? 'overdue' : 'due'} ${day}`;
  if (item.kind === 'event') {
    const endDay = dayNumber(item.end) === dayNumber(item.start) ? '' : `${dateLabel(item.end)} `;
    when = item.allDay ? `${day} all day` : `${day} ${timeLabel(item.start)}–${endDay}${timeLabel(item.end)}`;
  }
  const rule = parseRule(item.repeat);
  const parts = [
    `${item.id} ${item.kind}: ${item.title.replace(/\s+/g, ' ')}`, when, item.cat && `list ${item.cat.replace(/\s+/g, ' ')}`,
    item.priority && `${['', 'low', 'medium', 'high'][item.priority]} priority`, rule && describeRule(rule, item.seriesStart ?? item.start),
  ];
  return parts.filter(Boolean).join(' · ');
}

export function summary(now = Date.now()) {
  const today = midnight(now);
  const items = list({ from: today, to: addDays(today, 4), includeOverdue: true, now });
  const groups = [
    ['Overdue', items.filter((item) => item.kind === 'task' && item.start < today)],
    ['Today', items.filter((item) => item.start < addDays(today, 1) && (item.kind === 'event' || item.start >= today))],
    ['Next three days', items.filter((item) => item.start >= addDays(today, 1))],
  ];
  return groups.filter(([, entries]) => entries.length).map(([label, entries]) =>
    `${label}:\n${entries.slice(0, 4).map((item) => `- ${describeItem(item, now)}`).join('\n')}${entries.length > 4 ? `\n- ${entries.length - 4} more` : ''}`).join('\n');
}

function alertCandidates(items, now, until) {
  const earliest = now - 30 * minute;
  return items.filter((item) => live(item) && item.kind === 'event' && !item.allDay && !item.done && !item.fired)
    .flatMap((item) => eventOccurrences(item, earliest, until + item.alert * minute + 1)
      .filter((event) => event.start > earliest && (item.firedFor == null || event.start > item.firedFor))
      .map((event) => ({ item, event, at: event.start - item.alert * minute })))
    .sort((a, b) => a.at - b.at);
}

// The scheduler already rechecks at least once a minute.
export const nextAlert = (now = Date.now()) => alertCandidates(load(), now, now + minute)[0]?.at ?? null;

export async function takeDueAlerts(now = Date.now()) {
  return await change((items) => {
    const due = alertCandidates(items, now, now);
    if (!due.length) return null;
    for (const { item, event } of due) {
      item.fired = !event.series;
      item.firedFor = event.start;
    }
    return due.map(({ event }) => event);
  }) ?? [];
}
