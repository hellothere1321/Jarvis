// Calendar feeds: .ics links (a school's LMS, a team calendar, webcal://) fetched every hour and kept in the planner
// as read-only items. The feed list lives in Data/feeds.json; the items are planner.json's, marked source 'feed:<id>'
// with the ics UID as uid, so a refresh updates what changed and removes what vanished. Feed items are never sent to
// Google (googlesync.mjs skips every source starting with 'feed:') and nothing goes through the inbox: a feed is
// something the user chose to follow, so its items just appear.
//
// The link usually carries a private token, so only its host is ever shown, in the panel, in errors and in tool replies.
import { createHash, randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DIR, readJson, writeJson } from './store.mjs';
import { parseIcs } from './ics.mjs';
import * as planner from './planner.mjs';
import { formatRule, nextOccurrence, parseRule } from './recur.mjs';
import { BLOCK, checkFetch, checkUrl } from './safety.mjs';
import { midnight } from './when.mjs';

const file = path.join(DIR, 'feeds.json');
export const MAX_BYTES = 5 * 1024 * 1024, MAX_REDIRECTS = 5, TIMEOUT_MS = 20_000, REFRESH_MS = 3_600_000;
const MAX_FEEDS = 20, MAX_ITEMS = 2000, PAST_DAYS = 30, day = 86_400_000;

// ---------- the link ----------
/** The link as it will be fetched: http(s) only, webcal:// read as https://. Throws a sentence the user can read. */
export function normalizeUrl(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new Error('Paste the calendar link first.');
  text = text.replace(/^webcals?:\/\//i, 'https://');
  const verdict = checkUrl(text);
  if (verdict.level === BLOCK) throw new Error(verdict.reason);
  return new URL(text).href;
}
export const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

/** Resolve once, check the answer, then return a lookup that can only hand back that answer. Checking a name and
 *  connecting to it are two separate DNS reads: without this, a name can answer public to the check and private to
 *  the socket (rebinding). checkFetch holds every private/special-address rule, so feed it the answer already in hand. */
async function pin(url, lookup) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addrs = await lookup(host, { all: true });
  const verdict = await checkFetch(url, { lookup: async () => addrs });
  if (verdict.level === BLOCK) throw new Error(verdict.reason);
  const checked = (Array.isArray(addrs) ? addrs : []).filter((a) => a?.address).map((a) => ({ address: a.address, family: a.family ?? (a.address.includes(':') ? 6 : 4) }));
  if (!checked.length) throw new Error('The calendar link doesn’t lead anywhere.');
  return (name, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const list = String(name ?? '').replace(/^\[|\]$/g, '') === host ? checked : [];
    if (!list.length) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND' }));
    if (options?.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  };
}

/** fetch-shaped GET whose socket uses the pinned lookup. Node's fetch has no lookup hook; http(s).request does. */
async function request(url, { lookup, signal, headers } = {}) {
  const u = new URL(url), transport = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(u, { method: 'GET', headers, lookup, signal, agent: false }, (res) => {
      const empty = [204, 205, 304].includes(res.statusCode);
      const body = empty ? null : Readable.toWeb(res);
      if (empty) res.resume();
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage, headers: res.headers }));
    });
    req.once('error', reject);
    req.end();
  });
}

/** One GET with every address and redirect checked and pinned, a deadline and a size cap. fetchImpl and lookup are
 *  injectable; each redirect hop is resolved, checked and pinned again before a socket is opened for it. */
export async function download(url, { fetchImpl = request, lookup = dns.lookup, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  const control = new AbortController();
  const late = new Promise((_, reject) => control.signal.addEventListener('abort', () => reject(new Error('The calendar took too long to answer.'))));
  late.catch(() => {});
  const timer = setTimeout(() => control.abort(), timeoutMs);
  const within = (promise) => Promise.race([promise, late]);
  try {
    let current = url;
    for (let hops = 0; ; hops++) {
      const pinned = await within(pin(current, lookup));
      const res = await within(fetchImpl(current, { redirect: 'manual', signal: control.signal, lookup: pinned, headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1' } }));
      const where = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (where) {
        if (hops >= MAX_REDIRECTS) throw new Error('The link redirects too many times.');
        try { current = new URL(where, current).href; } catch { throw new Error('The link redirects somewhere that isn’t a link.'); }
        await res.body?.cancel().catch(() => {});
        continue;
      }
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      const tooBig = () => new Error(`The calendar is over ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      if (Number(res.headers.get('content-length')) > maxBytes) throw tooBig();
      const chunks = [];
      let total = 0;
      const reader = res.body?.getReader();
      while (reader) {
        const { done, value } = await within(reader.read());
        if (done) break;
        total += value.length;
        if (total > maxBytes) { reader.cancel().catch(() => {}); throw tooBig(); }
        chunks.push(value);
      }
      return new TextDecoder().decode(Buffer.concat(chunks));
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------- ics -> planner entries ----------
const clean = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const webLink = (item) => {
  const found = /^https?:\/\//i.test(item.url ?? '') ? item.url : /https?:\/\/[^\s<>"]+/i.exec(item.description ?? '')?.[0].replace(/[.,;)\]]+$/, '');
  return found && found.length <= 2000 ? found : '';
};
const ms = (date) => (date instanceof Date && Number.isFinite(+date) ? +date : null);
const fallbackUid = (item) => `nouid-${createHash('sha1').update(`${item.summary}|${ms(item.start ?? item.due)}`).digest('hex').slice(0, 12)}`;

// A repeat the planner understands (recur.mjs: daily to yearly, an interval, weekdays, a month day, COUNT, UNTIL) is
// kept. Anything else (BYSETPOS, "last Friday", BYMONTH, hourly...) can't be expanded faithfully, so that item is
// imported once, as its first occurrence only, rather than with wrong dates.
function repeatOf(item, start, allDay) {
  const rule = item.rrule ? parseRule(item.rrule) : null;
  if (!rule || start == null) return null;
  return nextOccurrence(rule, start, start - 1) == null ? null : formatRule(rule, allDay);
}

function entryOf(item, kind) {
  const notes = [item.location, item.description].filter(Boolean).map((t) => String(t).trim()).filter(Boolean).join('\n').slice(0, 2000);
  const base = { uid: item.uid || fallbackUid(item), kind, title: clean(item.summary, 300), notes, link: webLink(item), skip: [] };
  if (kind === 'event') {
    const allDay = !!item.allDay, start = ms(item.start);
    if (start == null) return null;
    const first = allDay ? midnight(start) : start, end = ms(item.end);
    const repeat = repeatOf(item, first, allDay);
    return { ...base, start: first, end: end != null && end > first ? (allDay ? midnight(end) : end) : null, allDay, repeat,
      skip: repeat ? item.exdates.map(ms).filter((d) => d != null).map((d) => (allDay ? midnight(d) : d)) : [] };
  }
  const due = ms(item.due) ?? ms(item.start);
  return { ...base, start: due == null ? null : midnight(due), end: null, allDay: false, repeat: repeatOf(item, due == null ? null : midnight(due), true),
    done: !!item.completed || /^COMPLETED$/i.test(item.status ?? '') };
}

/** The planner entries a feed's ics text makes. Cancelled items, items that ended long ago and anything past a cap are left out. */
export function entriesFrom(text, now = Date.now()) {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That link isn’t a calendar (.ics) file.');
  const { events, todos } = parseIcs(text), byUid = new Map(), horizon = now - PAST_DAYS * day;
  const consider = (item, kind) => {
    if (!item.summary?.trim() || /^CANCELLED$/i.test(item.status ?? '')) return;
    const entry = entryOf(item, kind);
    if (!entry) return;
    // Edits to one occurrence share the series' UID; the series itself is the one kept.
    const old = byUid.get(entry.uid);
    if (old && (old.repeat || !entry.repeat)) return;
    byUid.set(entry.uid, entry);
  };
  for (const item of events) consider(item, 'event');
  for (const item of todos) consider(item, 'task');
  return [...byUid.values()].filter((e) => {
    if (e.repeat) return true;
    if (e.kind === 'event') return (e.end ?? e.start) >= horizon;
    return !e.done || e.start == null || e.start >= horizon;
  }).slice(0, MAX_ITEMS);
}

// ---------- the feed list ----------
const shape = (f) => ({ id: f.id, name: f.name, url: f.url, on: f.on !== false, lastFetch: f.lastFetch ?? null, lastError: f.lastError ?? null });
const sourceOf = (id) => `feed:${id}`;

export function createFeeds({ fetchImpl, lookup = dns.lookup, clock = Date.now, timeoutMs = TIMEOUT_MS, changed = () => {} } = {}) {
  const list = () => (readJson(file, { backup: true }) ?? []).filter((f) => f?.id && f.url).map(shape);
  let pending = Promise.resolve();
  function change(fn) {
    const next = pending.then(async () => {
      const feeds = list(), result = fn(feeds);
      await writeJson(file, feeds, { backup: true });
      if (JSON.stringify(list()) !== JSON.stringify(feeds)) throw new Error('Could not save the feeds.');
      return result;
    });
    pending = next.catch(() => {});
    return next;
  }
  const count = (id) => planner.syncItems().filter((item) => item.source === sourceOf(id) && !item.deleted).length;
  /** What the panel and the agent see: never the link itself. */
  const view = () => list().map(({ url, ...f }) => ({ ...f, host: hostOf(url), items: count(f.id) }));

  async function add({ name, url }) {
    const href = normalizeUrl(url);
    return change((feeds) => {
      if (feeds.length >= MAX_FEEDS) throw new Error(`That’s the most feeds (${MAX_FEEDS}). Remove one first.`);
      if (feeds.some((f) => f.url === href)) throw new Error('That calendar is already added.');
      const feed = { id: randomBytes(4).toString('hex'), name: clean(name, 60) || hostOf(href), url: href, on: true, lastFetch: null, lastError: null };
      feeds.push(feed);
      return feed;
    }).then((feed) => { changed(); return feed; });
  }

  async function remove(id) {
    const gone = await change((feeds) => { const i = feeds.findIndex((f) => f.id === id); return i < 0 ? null : feeds.splice(i, 1)[0]; });
    if (gone) await planner.syncFeed(sourceOf(id), []);
    changed();
    return gone;
  }

  async function setOn(id, on) {
    const feed = await change((feeds) => { const f = feeds.find((x) => x.id === id); if (f) f.on = !!on; return f ?? null; });
    // Off means the calendar leaves the planner too (nothing is left stale); on fetches it again.
    if (feed && !on) await planner.syncFeed(sourceOf(id), []);
    if (feed && on) await refresh([id]);
    changed();
    return feed;
  }

  let running = Promise.resolve();
  async function refreshOne(feed) {
    const result = { id: feed.id, name: feed.name, ok: true, error: null, added: 0, updated: 0, removed: 0 };
    try {
      const text = await download(feed.url, { fetchImpl, lookup, timeoutMs });
      // Each feed's items sit in a list named after it, so the Lists view groups them.
      const entries = entriesFrom(text, clock()).map((entry) => ({ ...entry, cat: feed.name }));
      Object.assign(result, await planner.syncFeed(sourceOf(feed.id), entries, clock()));
    } catch (e) {
      result.ok = false;
      result.error = String(e?.message ?? e).replace(/https?:\/\/\S+/g, hostOf(feed.url) || 'the link').slice(0, 200);
    }
    await change((feeds) => { const f = feeds.find((x) => x.id === feed.id); if (f) Object.assign(f, { lastFetch: clock(), lastError: result.error }); }).catch(() => {});
    return result;
  }
  /** Fetches the enabled feeds (the named ones, or all), one after another, one refresh at a time. */
  function refresh(ids = null) {
    const run = running.then(async () => {
      const results = [];
      for (const feed of list().filter((f) => f.on && (ids == null || ids.includes(f.id)))) results.push(await refreshOne(feed));
      if (results.length) changed();
      return results;
    });
    running = run.catch(() => {});
    return run;
  }

  /** Once now and then every hour. The stop function clears the timer and waits for any refresh already running,
   *  so a late write can't land after the caller's next change to the feed list. */
  function start(every = REFRESH_MS) {
    const tick = () => refresh().catch((e) => console.error('feeds', e));
    tick();
    const timer = setInterval(tick, every);
    timer.unref?.();
    let stopped = false;
    return async () => { if (!stopped) { stopped = true; clearInterval(timer); await running; } };
  }

  return { list: view, add, remove, setOn, refresh, start };
}
