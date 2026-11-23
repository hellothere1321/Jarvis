// Suggestions stay separate from the planner until the user chooses to accept them.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DIR, readJson, writeJson } from './store.mjs';
import * as planner from './planner.mjs';

const file = path.join(DIR, 'inbox.json');
const key = (title, start) => `${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(the|a|an|to)\s+/, '')}|${start == null ? '' : new Date(start).toDateString()}`;
export function list() { return readJson(file, { backup: true }) ?? []; }
let pending = Promise.resolve();
function change(fn) {
  const next = pending.then(async () => {
    const items = list();
    const result = await fn(items);
    await writeJson(file, items, { backup: true });
    if (JSON.stringify(list()) !== JSON.stringify(items)) throw new Error('Could not save the inbox.');
    return result;
  });
  pending = next.catch(() => {});
  return next;
}
export function capture(title) {
  title = String(title ?? '').trim();
  if (!title) throw new Error('An inbox item needs a title.');
  return change((items) => {
    const k = key(title, null);
    if (items.some((item) => key(item.title, item.start) === k) || planner.list().some((item) => !item.done && key(item.title, item.start) === k)) return null;
    const item = { id: randomUUID(), title, start: null };
    items.push(item);
    return item;
  });
}
export function dismiss(id) {
  return change((items) => { const i = items.findIndex((item) => item.id === id); if (i < 0) return false; items.splice(i, 1); return true; });
}
export function triage(id, { kind, start, end } = {}) {
  if (!['task', 'event'].includes(kind) || typeof start !== 'number' || !Number.isFinite(start)) throw new Error('Choose a task or event and a valid date.');
  return change(async (items) => {
    const i = items.findIndex((item) => item.id === id);
    if (i < 0) return null;
    const item = await planner.add({ title: items[i].title, kind, start, ...(end == null ? {} : { end }) });
    items.splice(i, 1);
    return item;
  });
}
