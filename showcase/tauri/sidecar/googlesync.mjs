// The user's Google Tasks lists and primary calendar, using their desktop OAuth client.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseIcs } from './ics.mjs';
import * as planner from './planner.mjs';
import { parseRule } from './recur.mjs';
import { SAFE, checkUrl } from './safety.mjs';
import { readJson, writeJson } from './store.mjs';
import { parseWhen } from './when.mjs';

const urls = {
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  profile: 'https://openidconnect.googleapis.com/v1/userinfo',
  lists: 'https://tasks.googleapis.com/tasks/v1/users/@me/lists',
  tasks: 'https://tasks.googleapis.com/tasks/v1/lists',
  events: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
};
const scope = 'openid email https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/calendar.events';
const secretName = 'google-token';
const missingClient = 'Choose a Google Desktop app OAuth client JSON file.';
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const hash = (text) => createHash('sha256').update(text);
const eventId = (item) => hash(item.id).digest('hex');
const part = encodeURIComponent;
const feed = (item) => item.source?.startsWith('feed:');
const timestamp = (date) => Number.isFinite(Date.parse(date)) ? Date.parse(date) : null;
const localDate = (date) => /^\d{4}-\d\d-\d\d$/.test(date ?? '') ? parseWhen(date)?.start ?? null : null;
const dateOnly = (time) => {
  const d = new Date(time);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n, i) => String(n).padStart(i === 0 ? 4 : 2, '0')).join('-');
};
const eventTime = (value) => value?.date ? localDate(value.date) : timestamp(value?.dateTime);
const taskKey = (listId, id) => JSON.stringify([listId, id]);
const uniqueDates = (dates) => [...new Set(dates)].sort((a, b) => a - b);
const parseRecurrence = (lines) => parseIcs(['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\n')).events[0];
const missing = (error) => [404, 410].includes(error.status);
const goneEvent = (event) => event.status === 'cancelled'
  || event.eventType === 'workingLocation'
  || event.attendees?.some((a) => a.self && a.responseStatus === 'declined');

class GoogleError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Keep Google response bodies and low-level errors out of status messages and logs.
async function request(url, options = {}) {
  try {
    return await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(25_000) });
  } catch {
    throw new GoogleError('Could not reach Google. Check your connection.');
  }
}
const json = async (response) => {
  try { return await response.json(); } catch { throw new GoogleError('Google returned an unreadable reply.'); }
};
const form = (url, body) => request(url, { method: 'POST', body: new URLSearchParams(body) });

function parseClient(text) {
  if (typeof text !== 'string' || text.length > 32_768) return null;
  try {
    const { installed } = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (typeof installed?.client_id === 'string' && installed.client_id.trim()
      && typeof installed.client_secret === 'string' && installed.client_secret.trim()) return installed;
  } catch {}
  return null;
}

async function authorize(client, endpoint, openUrl, timeout) {
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  let redirect, finish, timer, used = false;
  const callback = new Promise((resolve) => { finish = resolve; });
  const server = createServer((req, res) => {
    const url = URL.canParse(req.url, redirect) ? new URL(req.url, redirect) : null;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (req.method !== 'GET' || url?.origin !== new URL(redirect).origin || req.headers.host !== url.host || url.pathname !== '/'
      || used || url.searchParams.get('state') !== state) {
      res.writeHead(400).end('This Google sign-in request is invalid.');
      return;
    }
    used = true;
    const code = url.searchParams.get('error') ? null : url.searchParams.get('code');
    res.end(code ? 'Return to the app to finish connecting. You can close this tab.' : 'Google sign-in was cancelled. You can close this tab.');
    finish({ code });
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    redirect = `http://127.0.0.1:${server.address().port}/`;
    const url = new URL(endpoint);
    url.search = new URLSearchParams({
      client_id: client.client_id, redirect_uri: redirect, response_type: 'code',
      scope, access_type: 'offline', prompt: 'consent', state,
      code_challenge_method: 'S256', code_challenge: hash(verifier).digest('base64url'),
    });
    timer = setTimeout(() => finish({}), timeout);
    await openUrl(url.href);
    const { code } = await callback;
    if (!code) throw new GoogleError(used ? 'Google sign-in was cancelled.' : 'Google sign-in timed out. Try connecting again.');
    return { code, redirect_uri: redirect, code_verifier: verifier, grant_type: 'authorization_code' };
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

function taskBody(item) {
  return {
    title: item.title, notes: item.notes, status: item.done ? 'completed' : 'needsAction',
    due: item.start == null ? null : `${dateOnly(item.start)}T00:00:00.000Z`,
    ...(item.done ? {} : { completed: null }),
  };
}

function eventBody(item, patch) {
  const date = (time) => item.allDay
    ? { date: dateOnly(time), ...(patch ? { dateTime: null, timeZone: null } : {}) }
    : { dateTime: new Date(time).toISOString(), timeZone: item.gZone || timeZone, ...(patch ? { date: null } : {}) };
  const body = {
    summary: item.title, description: item.notes, start: date(item.start), end: date(item.end),
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: Math.min(item.alert, 40320) }] },
    extendedProperties: { private: { vlCat: item.cat, vlPrio: String(item.priority) } },
  };
  if (item.repeat) {
    const explicit = new Set(item.gRecurrence ? parseRecurrence(item.gRecurrence).exdates.map(Number) : []);
    const exdates = item.skip.filter((start) => explicit.has(start) || !item.gExceptions?.some(([, value]) => value === start));
    body.recurrence = [`RRULE:${item.repeat}`, ...exdates.map((start) => item.allDay
      ? `EXDATE;VALUE=DATE:${dateOnly(start).replaceAll('-', '')}`
      : `EXDATE:${new Date(start).toISOString().replace(/[-:]|\.\d+/g, '')}`)];
  } else if (patch) body.recurrence = !item.gRepeat && item.gRecurrence?.length ? item.gRecurrence : [];
  if (item.repeat && item.repeat === item.gRepeat && item.gRecurrence) {
    // Preserve recurrence properties outside the planner's editable subset.
    body.recurrence = [...item.gRecurrence.filter((line) => !/^EXDATE[;:]/i.test(line)), ...body.recurrence.slice(1)];
  }
  return body;
}

function incomingEvent(event) {
  const start = eventTime(event.start), end = eventTime(event.end);
  if (start == null || end == null || end <= start) return null;
  const allDay = !!event.start.date;
  const lines = Array.isArray(event.recurrence) ? event.recurrence.filter((line) => typeof line === 'string' && !/[\r\n]/.test(line)) : [];
  const series = parseRecurrence(lines);
  const repeat = parseRule(series.rrule) ? series.rrule : null;
  const props = event.extendedProperties?.private;
  const priority = Number(props?.vlPrio);
  const alert = event.reminders?.overrides?.find((r) => r.method === 'popup')?.minutes;
  return {
    start, end, allDay, alert: Number.isSafeInteger(alert) && alert >= 0 ? alert : 10,
    title: event.summary || '(no title)', notes: event.description || '',
    repeat, skip: uniqueDates(series.exdates.map(Number)),
    gZone: event.start.timeZone ?? null, gRecurrence: lines, gRepeat: repeat,
    gEtag: event.etag ?? null,
    ...(typeof props?.vlCat === 'string' ? { cat: props.vlCat } : {}),
    ...(Number.isInteger(priority) && priority >= 0 && priority <= 3 ? { priority } : {}),
  };
}

function merge(items, add, item, values, updated, removed, now) {
  // For pending edits, the newer timestamp wins. Local wins ties. An undated remote deletion wins.
  if (item?.dirty && (item.updated ?? 0) >= (updated ?? (removed ? Infinity : 0))) return;
  // A pull can briefly lag behind a successful push.
  if (updated != null && item?.updated > updated) return;
  if (removed) {
    if (item) items.splice(items.indexOf(item), 1);
    return;
  }
  if (!values) return;
  const resetAlert = item && (item.start !== values.start || item.repeat !== values.repeat || item.alert !== values.alert);
  const next = { ...values, dirty: false, deleted: false, updated: updated ?? item?.updated ?? now };
  if (resetAlert && values.kind === 'event') Object.assign(next, { fired: false, firedFor: null });
  if (item) Object.assign(item, next);
  else item = add(next);
  return item;
}

export function createGoogleSync({ dataDir, secrets, openUrl, endpoints = urls, clock = Date.now, changed = () => {}, signInTimeout = 180_000 }) {
  if (endpoints === urls && Object.values(urls).some((url) => checkUrl(url).level !== SAFE)) throw new Error('Invalid Google API endpoint.');
  const clientFile = path.join(dataDir, 'google-client.json');
  const stateFile = path.join(dataDir, 'google-sync.json');
  let client, grant, access, expires = 0, calendarCursor, running, busy = null;
  let lastSync = null, lastError = null, retryAt = 0, failures = 0;
  const state = () => ({ hasClient: !!client, connected: !!grant, email: grant?.email ?? null, busy, lastSync, lastError, retryAt });
  const readClient = async () => parseClient(await fs.readFile(clientFile, 'utf8').catch(() => ''));
  const reset = () => { access = null; expires = 0; calendarCursor = null; retryAt = 0; failures = 0; };
  const saveGrant = async (value) => {
    try { await secrets.set(secretName, JSON.stringify(value)); }
    catch { throw new GoogleError('Could not save Google sign-in to the system credential store.'); }
    grant = value;
  };
  const forgetGrant = async () => {
    try { await secrets.delete(secretName); }
    catch { throw new GoogleError('Could not remove Google sign-in from the system credential store.'); }
    grant = null;
    reset();
  };

  function exclusive(action, work) {
    if (running) return Promise.resolve(false);
    busy = action;
    running = Promise.resolve().then(work).then(() => {
      lastError = null;
      return true;
    }, (error) => {
      lastError = error instanceof GoogleError ? error.message : 'Could not update Google sync. Try again.';
      if (action === 'sync' && grant) retryAt = clock() + Math.min(300_000, 5_000 * 2 ** Math.min(failures++, 6));
      return false;
    }).finally(() => {
      running = null;
      busy = null;
      changed();
    });
    changed();
    return running;
  }

  async function exchange(params) {
    if (!client) throw new GoogleError('The Google OAuth client file is missing. Disconnect to choose it again.');
    const response = await form(endpoints.token, { client_id: client.client_id, client_secret: client.client_secret, ...params });
    const reply = await json(response);
    if (!response.ok || typeof reply.access_token !== 'string' || !reply.access_token) {
      if (reply.error === 'invalid_grant' && params.grant_type === 'refresh_token') {
        await forgetGrant();
        throw new GoogleError('Google sign-in expired. Connect again.');
      }
      throw new GoogleError('Google could not complete sign-in. Check your OAuth client and try again.');
    }
    return reply;
  }

  function useAccess(reply) {
    access = reply.access_token;
    expires = clock() + Math.max(0, (Number(reply.expires_in) - 30) * 1000 || 0);
  }

  async function api(url, method = 'GET', body, etag) {
    if (!grant) throw new GoogleError('Connect Google to sync your planner.');
    const refresh = async () => {
      const reply = await exchange({ grant_type: 'refresh_token', refresh_token: grant.refresh });
      if (typeof reply.refresh_token === 'string' && reply.refresh_token) await saveGrant({ ...grant, refresh: reply.refresh_token });
      useAccess(reply);
    };
    if (!access || expires <= clock()) await refresh();
    const send = () => request(url, {
      method, headers: {
        Authorization: `Bearer ${access}`, ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(etag ? { 'If-Match': etag } : {}),
      }, body: body ? JSON.stringify(body) : undefined,
    });
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel();
      await refresh();
      response = await send();
    }
    if (!response.ok || method === 'DELETE') await response.body?.cancel();
    if (method === 'DELETE' && (response.ok || missing(response))) return null;
    if (!response.ok) {
      const message = response.status === 403 ? 'Google denied access. Check that both APIs are enabled and allowed.'
        : response.status === 401 ? 'Google did not authorize the request. Connect again.'
          : response.status === 412 ? 'An item changed in Google during sync. Retrying shortly.'
            : `Google sync request failed (HTTP ${response.status}).`;
      throw new GoogleError(message, response.status);
    }
    return json(response);
  }

  async function pages(url, query) {
    const items = [];
    let pageToken, nextSyncToken;
    do {
      const params = new URLSearchParams(query);
      if (pageToken) params.set('pageToken', pageToken);
      const page = await api(`${url}?${params}`);
      items.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
      nextSyncToken = page.nextSyncToken;
    } while (pageToken);
    return { items, nextSyncToken };
  }

  async function pullTasks(lists, defaultId) {
    const remote = new Map();
    for (const list of lists) {
      const { items } = await pages(`${endpoints.tasks}/${part(list.id)}/tasks`, {
        maxResults: '100', showCompleted: 'true', showHidden: 'true', showDeleted: 'true',
      });
      for (const task of items) if (task.id) remote.set(taskKey(list.id, task.id), { task, list });
    }
    const now = clock();
    await planner.applySync((items, add) => {
      const linked = new Map(items.filter((item) => item.kind === 'task' && item.gId && !feed(item))
        .map((item) => [taskKey(item.gList ?? defaultId, item.gId), item]));
      for (const [key, { task, list }] of remote) {
        const current = linked.get(key);
        const updated = timestamp(task.updated), done = task.status === 'completed';
        const values = {
          kind: 'task', gId: task.id, gList: list.id, cat: list.id === defaultId ? '' : list.title ?? '',
          title: task.title || '(untitled)', notes: task.notes ?? '', start: localDate(task.due?.slice(0, 10)),
          done, lastDone: done ? timestamp(task.completed) ?? current?.lastDone ?? updated ?? now : null,
        };
        const wasDone = current?.done;
        const item = merge(items, add, current, values, updated, task.deleted, now);
        if (item && done && !wasDone) planner.advanceCompletedTask(item, now);
      }
      for (const [key, item] of linked) {
        if (!remote.has(key)) merge(items, add, item, null, null, true, now);
      }
    });
    return remote;
  }

  async function pullEvents() {
    const query = { singleEvents: 'false', showDeleted: 'true', maxResults: '250' };
    let full = !calendarCursor, result;
    try {
      result = await pages(endpoints.events, { ...query, ...(full ? {} : { syncToken: calendarCursor }) });
    } catch (error) {
      if (full || error.status !== 410) throw error;
      calendarCursor = null;
      full = true;
      result = await pages(endpoints.events, query);
    }
    const remote = new Map(), exceptions = new Map();
    for (const event of result.items) {
      if (!event.id) continue;
      if (event.recurringEventId) {
        const group = exceptions.get(event.recurringEventId) ?? [];
        group.push(event);
        exceptions.set(event.recurringEventId, group);
      } else remote.set(event.id, event);
    }
    const now = clock();
    await planner.applySync((items, add) => {
      const linked = new Map(items.filter((item) => item.kind === 'event' && item.gId && !feed(item)).map((item) => [item.gId, item]));
      const pending = new Map(items.filter((item) => item.kind === 'event' && item.dirty && !item.gId && !feed(item))
        .map((item) => [eventId(item), item]));
      for (const [id, event] of remote) {
        const values = incomingEvent(event);
        const current = linked.get(id) ?? pending.get(id);
        const removed = goneEvent(event);
        // A previous insert may have reached Google before its response was lost.
        if (current && !removed) {
          current.gId = id;
          current.gEtag = event.etag ?? null;
          linked.set(id, current);
        }
        const item = merge(items, add, current, values && { ...values, kind: 'event', gId: id }, timestamp(event.updated), removed, now);
        if (item) linked.set(id, item);
        else if (removed && current && !items.includes(current)) linked.delete(id);
      }
      for (const [id, item] of linked) {
        if (full && !remote.has(id)) {
          merge(items, add, item, null, null, true, now);
          continue;
        }
        if (!item.repeat || item.deleted) continue;
        const old = new Map(item.gExceptions);
        const next = full ? new Map() : new Map(old);
        for (const event of exceptions.get(id) ?? []) {
          const start = eventTime(event.originalStartTime);
          if (start != null && (goneEvent(event) || eventTime(event.start) !== start)) next.set(event.id, start);
          else next.delete(event.id);
        }
        if (!remote.has(id) && !exceptions.has(id) && !full) continue;
        const explicit = new Set(parseRecurrence(item.gRecurrence ?? []).exdates.map(Number));
        const oldStarts = new Set(old.values());
        item.skip = uniqueDates([
          ...item.skip.filter((start) => !oldStarts.has(start) || explicit.has(start)),
          ...next.values(),
        ]);
        item.gExceptions = [...next];
      }
    });
    // Commit the cursor after the pull is durable, even if a later push fails.
    calendarCursor = result.nextSyncToken;
    return remote;
  }

  async function updateLink(snapshot, link, updated, drop = false) {
    await planner.applySync((items) => {
      const current = items.find((item) => item.id === snapshot.id && item.gId === snapshot.gId && item.gList === snapshot.gList);
      if (!current) return;
      if (drop) {
        if (current.updated === snapshot.updated && current.deleted === snapshot.deleted) items.splice(items.indexOf(current), 1);
        return;
      }
      Object.assign(current, link);
      // The user may have edited this item while the Google request was in flight.
      if (link.gId && current.updated === snapshot.updated && current.deleted === snapshot.deleted) {
        current.dirty = false;
        current.updated = updated ?? clock();
      }
    });
  }

  async function pushTasks(lists, defaultId, remote) {
    for (const item of planner.syncItems().filter((entry) => entry.kind === 'task' && entry.dirty && !feed(entry))) {
      const currentList = item.gList ?? defaultId;
      const currentUrl = `${endpoints.tasks}/${part(currentList)}/tasks/${part(item.gId)}`;
      const etag = remote.get(taskKey(currentList, item.gId))?.task.etag;
      if (item.deleted) {
        if (item.gId) await api(currentUrl, 'DELETE', undefined, etag);
        await updateLink(item, null, null, true);
        continue;
      }
      let listId = defaultId;
      if (item.cat) {
        let list = lists.find((entry) => entry.id === item.gList && entry.id !== defaultId && entry.title?.toLowerCase() === item.cat.toLowerCase())
          ?? lists.find((entry) => entry.id !== defaultId && entry.title?.toLowerCase() === item.cat.toLowerCase());
        if (!list) {
          list = await api(endpoints.lists, 'POST', { title: item.cat });
          lists.push(list);
        }
        listId = list.id;
      }
      if (item.gId && currentList !== listId) {
        await api(currentUrl, 'DELETE', undefined, etag);
        await updateLink(item, { gId: null, gList: null }, null);
        const current = planner.syncItems().find((entry) => entry.id === item.id);
        if (!current || current.deleted || current.updated !== item.updated) continue;
        Object.assign(item, { gId: null, gList: null });
      }
      try {
        const saved = item.gId ? await api(currentUrl, 'PATCH', taskBody(item), etag)
          : await api(`${endpoints.tasks}/${part(listId)}/tasks`, 'POST', taskBody(item));
        if (!saved?.id) throw new GoogleError('Google did not confirm the task was saved.');
        await updateLink(item, { gId: saved.id, gList: listId }, timestamp(saved.updated));
      } catch (error) {
        if (!item.gId || !missing(error)) throw error;
        await updateLink(item, null, null, true);
      }
    }
  }

  async function pushEvents(remote) {
    for (const item of planner.syncItems().filter((entry) => entry.kind === 'event' && entry.dirty && !feed(entry))) {
      const id = item.gId ?? eventId(item);
      const url = `${endpoints.events}/${part(id)}`;
      const etag = remote.get(id)?.etag ?? item.gEtag;
      if (item.deleted) {
        if (item.gId) await api(url, 'DELETE', undefined, etag);
        await updateLink(item, null, null, true);
        continue;
      }
      let saved;
      try {
        saved = item.gId ? await api(url, 'PATCH', eventBody(item, true), etag)
          : await api(endpoints.events, 'POST', { ...eventBody(item, false), id });
      } catch (error) {
        if (!item.gId && error.status === 409) saved = await api(url, 'PATCH', eventBody(item, true), etag);
        else if (item.gId && missing(error)) {
          await updateLink(item, null, null, true);
          continue;
        } else throw error;
      }
      if (!saved?.id) throw new GoogleError('Google did not confirm the event was saved.');
      await updateLink(item, { gId: saved.id, gEtag: saved.etag ?? null }, timestamp(saved.updated));
    }
  }

  return {
    state,
    init: () => exclusive('load', async () => {
      client = await readClient();
      if (!client && !readJson(stateFile)?.account) return;
      try {
        const saved = await secrets.get(secretName);
        if (saved) {
          const value = JSON.parse(saved);
          if (typeof value?.refresh !== 'string' || !value.refresh) throw new Error();
          grant = value;
        }
      } catch { throw new GoogleError('Could not read Google sign-in from the system credential store.'); }
    }),
    importClient: (text) => exclusive('import', async () => {
      if (grant) throw new GoogleError('Disconnect Google before replacing its OAuth client.');
      const next = parseClient(text);
      if (!next) throw new GoogleError(missingClient);
      const { client_id, client_secret } = next;
      await writeJson(clientFile, { installed: { client_id, client_secret } });
      client = await readClient();
      if (client?.client_id !== client_id || client.client_secret !== client_secret) throw new GoogleError('Could not save the OAuth client file.');
    }),
    connect: () => exclusive('connect', async () => {
      if (grant) return;
      client = await readClient();
      if (!client) throw new GoogleError(missingClient);
      const reply = await exchange(await authorize(client, endpoints.authorization, openUrl, signInTimeout));
      if (typeof reply.refresh_token !== 'string' || !reply.refresh_token) throw new GoogleError('Google did not grant offline access. Try connecting again.');
      const profile = await request(endpoints.profile, { headers: { Authorization: `Bearer ${reply.access_token}` } });
      const user = profile.ok ? await json(profile) : null;
      if (typeof user?.sub !== 'string' || !user.sub) throw new GoogleError('Could not identify the signed-in Google account. Try connecting again.');
      const account = hash(user.sub).digest('hex');
      const prior = readJson(stateFile)?.account;
      if (prior && prior !== account) {
        // Keep linked items on this computer when switching to a different account.
        await planner.applySync((items) => {
          for (const item of items) if (item.gId) Object.assign(item, { gId: null, gList: null, dirty: false });
        });
      }
      await writeJson(stateFile, { account });
      if (readJson(stateFile)?.account !== account) throw new GoogleError('Could not save the Google account on this computer.');
      await saveGrant({ refresh: reply.refresh_token, email: typeof user.email === 'string' ? user.email : null });
      reset();
      useAccess(reply);
      lastSync = null;
    }),
    disconnect: () => exclusive('disconnect', async () => {
      if (!grant) return;
      const token = grant.refresh;
      await forgetGrant();
      lastSync = null;
      const revoked = await form(endpoints.revoke, { token }).catch(() => null);
      await revoked?.body?.cancel();
      if (!revoked?.ok) throw new GoogleError('Signed out here. Google could not revoke access. Check your Google Account permissions.');
    }),
    sync: () => grant && clock() >= retryAt ? exclusive('sync', async () => {
      const { items: lists } = await pages(endpoints.lists, { maxResults: '100' });
      const primary = await api(`${endpoints.lists}/@default`);
      if (!primary?.id) throw new GoogleError('Google did not return your default task list.');
      if (!lists.some((list) => list.id === primary.id)) lists.unshift(primary);
      const tasks = await pullTasks(lists, primary.id);
      const events = await pullEvents();
      await pushTasks(lists, primary.id, tasks);
      await pushEvents(events);
      lastSync = clock();
      failures = 0;
      retryAt = 0;
    }) : Promise.resolve(false),
  };
}
