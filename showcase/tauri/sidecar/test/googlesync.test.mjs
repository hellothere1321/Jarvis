import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const scratch = await mkdtemp(path.join(os.tmpdir(), 'roamies-google-'));
process.env.ROAMIES_DATA_DIR = scratch;
const planner = await import('../planner.mjs');
const { createGoogleSync } = await import('../googlesync.mjs');
const { DIR } = await import('../store.mjs');

const baseTime = Date.parse('2026-05-05T15:00:00Z');
const iso = (offset) => new Date(baseTime + offset).toISOString();
const time = (day) => new Date(2026, 4, day).getTime();
let now = baseTime + 1000;
const secret = () => randomBytes(24).toString('hex');
const refresh = secret(), firstAccess = secret(), access = secret(), clientSecret = secret(), code = secret();
const tokenValues = [refresh, firstAccess, access, code];
const calls = [], cursorCalls = [], writes = [];
let authCalls = 0, refreshCalls = 0, revoked = false, challenge, redirect;
let calendarMode = 'initial', fail = false, stall;
const task = (id, title, updated = iso(0), other = {}) => ({ id, title, updated, status: 'needsAction', ...other });
const defaultTasks = new Map([
  ['p1', task('p1', 'Phone task', iso(0), { due: '2026-05-06T00:00:00.000Z' })],
  ['p2', task('p2', 'Remove locally')],
]);
const workTasks = new Map([['p1', task('p1', 'Other list task')]]);
const start = { date: '2026-05-06' }, end = { date: '2026-05-07' };
const event = (id, title, updated = iso(0), other = {}) => ({ id, summary: title, start, end, updated, ...other });
const series = event('series', 'Daily event', iso(0), { recurrence: ['RRULE:FREQ=DAILY;COUNT=5', 'EXDATE;VALUE=DATE:20260508'] });
const cancelled = { id: 'series_1', recurringEventId: series.id, status: 'cancelled', originalStartTime: { date: '2026-05-07' } };
const gone = event('gone', 'Removed in full resync');
const newEvents = new Map();
const returned = (item, body = {}) => ({ ...item, ...body, updated: new Date(now).toISOString() });
let handlerError;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;
  const reply = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  };
  try {
    const method = req.method;
    calls.push([method, route]);
    let text = '';
    for await (const chunk of req) text += chunk;
    if (route === '/token') {
      const form = new URLSearchParams(text);
      assert.ok(form.get('client_secret') === clientSecret);
      if (form.get('grant_type') === 'authorization_code') {
        authCalls++;
        assert.ok(form.get('code') === code);
        assert.equal(form.get('redirect_uri'), redirect);
        const computed = createHash('sha256').update(form.get('code_verifier')).digest('base64url');
        assert.ok(computed === challenge);
        return reply({ refresh_token: refresh, access_token: firstAccess, expires_in: 3600 });
      }
      refreshCalls++;
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.ok(form.get('refresh_token') === refresh);
      return reply({ access_token: access, expires_in: 3600 });
    }
    if (route === '/revoke') {
      revoked = new URLSearchParams(text).get('token') === refresh;
      return reply({});
    }
    if (route === '/profile') {
      assert.ok(req.headers.authorization === `Bearer ${firstAccess}`);
      return reply({ sub: 'fake-account', email: 'sync@example.test' });
    }
    if (req.headers.authorization === `Bearer ${firstAccess}`) return reply({ error: firstAccess }, 401);
    assert.ok(req.headers.authorization === `Bearer ${access}`);
    if (fail) return reply({ error: 'error containing ' + refresh }, 503);
    if (route === '/lists' && stall) {
      await stall;
      stall = null;
    }
    const page = url.searchParams.get('pageToken');
    if (route === '/lists') {
      return reply(page ? { items: [{ id: 'work', title: 'Work' }] }
        : { items: [{ id: 'default', title: 'Default' }], nextPageToken: 'lists-2' });
    }
    if (route === '/lists/@default') return reply({ id: 'default' });
    const tasks = /^\/tasks\/(default|work)\/tasks(?:\/([^/]+))?$/.exec(route);
    if (tasks) {
      const [, list, id] = tasks;
      const data = list === 'default' ? defaultTasks : workTasks;
      if (method === 'GET') {
        assert.equal(url.searchParams.get('showHidden'), 'true');
        assert.equal(url.searchParams.get('showDeleted'), 'true');
        const items = [...data.values()];
        return reply(page ? { items: items.slice(1) } : { items: items.slice(0, 1), nextPageToken: 'tasks-2' });
      }
      const body = text ? JSON.parse(text) : null;
      writes.push({ method, route, body });
      if (method === 'DELETE') { data.delete(id); return reply({}); }
      const saved = returned(data.get(id) ?? { id: 'created-task' }, body);
      data.set(saved.id, saved);
      return reply(saved);
    }
    if (route === '/events' && method === 'GET') {
      const cursor = url.searchParams.get('syncToken');
      cursorCalls.push([cursor, page]);
      assert.equal(url.searchParams.get('singleEvents'), 'false');
      assert.equal(url.searchParams.get('showDeleted'), 'true');
      if (calendarMode === 'initial') {
        return reply(page ? { items: [cancelled, gone], nextSyncToken: 'cursor-1' }
          : { items: [series], nextPageToken: 'events-2' });
      }
      if (calendarMode === 'incremental') {
        return reply({ items: [{ ...cancelled, status: 'confirmed', start: cancelled.originalStartTime }], nextSyncToken: 'cursor-2' });
      }
      if (calendarMode === 'resync' && cursor) return reply({ error: 'expired cursor' }, 410);
      if (calendarMode === 'resync') return reply({ items: [series, cancelled, ...newEvents.values()], nextSyncToken: 'cursor-3' });
      return reply({ items: [], nextSyncToken: 'cursor-4' });
    }
    if (route.startsWith('/events') && method !== 'GET') {
      const id = route.split('/')[2];
      const body = text ? JSON.parse(text) : null;
      writes.push({ method, route, body });
      if (method === 'DELETE') { newEvents.delete(id); return reply({}); }
      const saved = returned(newEvents.get(id) ?? { id: body.id }, body);
      newEvents.set(saved.id, saved);
      return reply(saved);
    }
    reply({}, 404);
  } catch (error) {
    handlerError = error;
    reply({}, 500);
  }
});

const logs = [];
const originals = [console.log, console.error, console.warn];
[console.log, console.error, console.warn] = originals.map(() => (...args) => logs.push(args.map(String).join(' ')));
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = `http://127.0.0.1:${server.address().port}`;
  const endpoints = Object.fromEntries(['authorization', 'token', 'revoke', 'profile', 'lists', 'tasks', 'events']
    .map((key) => [key, root + '/' + key]));
  const credentials = new Map();
  const secrets = {
    async get(k) { return credentials.get(k); },
    async set(k, value) { credentials.set(k, value); },
    async delete(k) { credentials.delete(k); },
  };
  const sync = createGoogleSync({ dataDir: DIR, endpoints, secrets, clock: () => now, openUrl: async (url) => {
    const params = new URL(url).searchParams;
    redirect = params.get('redirect_uri');
    challenge = params.get('code_challenge');
    assert.equal(new URL(redirect).hostname, '127.0.0.1');
    assert.equal(params.get('code_challenge_method'), 'S256');
    assert.equal(params.get('access_type'), 'offline');
    assert.equal((await fetch(redirect + '?state=wrong&code=wrong')).status, 400);
    const callback = await fetch(redirect + '?' + new URLSearchParams({ state: params.get('state'), code }));
    assert.equal(callback.status, 200);
    assert.doesNotMatch(await callback.text(), new RegExp(code));
  } });
  const checkSync = async () => {
    const ok = await sync.sync();
    if (handlerError) throw handlerError;
    assert.equal(ok, true, sync.state().lastError);
  };
  const find = (gId, gList) => planner.syncItems().find((item) => item.gId === gId && (!gList || item.gList === gList));

  await sync.init();
  assert.equal(sync.state().hasClient, false);
  assert.equal(await sync.connect(), false);
  assert.match(sync.state().lastError, /Desktop app/);
  assert.equal(await sync.importClient(JSON.stringify({ installed: { client_id: 'fake-client', client_secret: clientSecret, token_uri: 'https://example.test' } })), true);
  assert.equal(await sync.connect(), true, sync.state().lastError);
  assert.equal(authCalls, 1);
  assert.equal(sync.state().email, 'sync@example.test');
  assert.ok(JSON.parse(credentials.get('google-token')).refresh === refresh);

  const local = await planner.add({ title: 'Upload task', cat: 'Work', start: time(6), est: 13, source: 'local-tag' }, now);
  const foreign = await planner.add({ kind: 'event', title: 'Feed only', start: time(6), source: 'feed:test' }, now);
  const localEvent = await planner.add({ kind: 'event', title: 'Upload event', start: time(6), allDay: true, repeat: 'daily', skip: [time(8)] }, now);
  await checkSync();
  assert.equal(refreshCalls, 1, 'a 401 refreshes the access token and retries');
  assert.deepEqual(calls.filter(([method, route]) => method === 'GET' && route === '/lists').length, 3);
  assert.deepEqual(cursorCalls, [[null, null], [null, 'events-2']]);
  assert.equal(find('p1', 'default').start, time(6));
  assert.equal(find('p1', 'work').cat, 'Work');
  assert.deepEqual(find(series.id).skip, [time(7), time(8)]);
  assert.equal(find(series.id).repeat, 'FREQ=DAILY;COUNT=5');
  assert.equal(find(cancelled.id), undefined);
  assert.equal(planner.get(foreign.id).gId, null);
  assert.equal(planner.get(local.id).dirty, false);
  assert.equal(planner.get(localEvent.id).dirty, false);
  const firstWrites = writes.splice(0);
  assert.deepEqual(firstWrites.map(({ method, route }) => [method, route]), [['POST', '/tasks/work/tasks'], ['POST', '/events']]);
  assert.equal(firstWrites[0].body.due, '2026-05-06T00:00:00.000Z');
  assert.deepEqual(firstWrites[1].body.recurrence, ['RRULE:FREQ=DAILY', 'EXDATE;VALUE=DATE:20260508']);
  assert.doesNotMatch(JSON.stringify(firstWrites), /est|source|spent|blockFor|Feed only/);

  calendarMode = 'incremental';
  now += 10_000;
  const phone = find('p1', 'default');
  const keep = { est: 20, spent: 3, source: 'local', uid: 'local-uid', link: 'https://example.test', blockFor: 'another-task' };
  await planner.edit(phone.id, keep);
  await planner.update(phone.id, { title: 'Older local edit' }, now - 200);
  defaultTasks.set('p1', task('p1', 'Newer phone edit', new Date(now - 100).toISOString()));
  await planner.update(local.id, { title: 'Newer local edit' }, now);
  workTasks.set('created-task', task('created-task', 'Older phone edit', new Date(now - 100).toISOString()));
  await planner.update(localEvent.id, { title: 'Edited local event' }, now);
  await planner.remove(find('p2').id, now);
  await checkSync();
  assert.deepEqual(cursorCalls.at(-1), ['cursor-1', null]);
  assert.deepEqual(find(series.id).skip, [time(8)]);
  assert.equal(planner.get(phone.id).title, 'Newer phone edit');
  for (const [key, value] of Object.entries(keep)) assert.equal(planner.get(phone.id)[key], value);
  assert.equal(planner.get(local.id).title, 'Newer local edit');
  assert.equal(planner.get(local.id).dirty, false);
  assert.equal(find('p2'), undefined);
  assert.deepEqual(writes.splice(0).map(({ method, route }) => [method, route]).sort(), [
    ['DELETE', '/tasks/default/tasks/p2'], ['PATCH', `/events/${planner.get(localEvent.id).gId}`], ['PATCH', '/tasks/work/tasks/created-task'],
  ]);

  calendarMode = 'resync';
  now += 1000;
  await planner.remove(localEvent.id, now);
  await checkSync();
  assert.deepEqual(cursorCalls.slice(-2), [['cursor-2', null], [null, null]]);
  assert.equal(find(gone.id), undefined);
  assert.deepEqual(find(series.id).skip, [time(7), time(8)]);
  assert.equal(planner.syncItems().some(({ id }) => id === localEvent.id), false);
  assert.equal(writes.at(-1).method, 'DELETE');

  fail = true;
  assert.equal(await sync.sync(), false);
  assert.match(sync.state().lastError, /HTTP 503/);
  assert.ok(!sync.state().lastError.includes(refresh));
  assert.equal(sync.state().retryAt, now + 5000);
  assert.equal(sync.state().lastSync, now);
  const before = calls.length;
  assert.equal(await sync.sync(), false);
  assert.equal(calls.length, before);
  now += 5000;
  assert.equal(await sync.sync(), false);
  assert.equal(sync.state().retryAt, now + 10_000);
  fail = false;
  now += 10_000;
  calendarMode = 'steady';
  let release;
  stall = new Promise((resolve) => { release = resolve; });
  const active = checkSync();
  assert.equal(sync.state().busy, 'sync');
  assert.equal(await sync.sync(), false, 'only one sync can run');
  release();
  await active;
  assert.equal(sync.state().retryAt, 0);
  assert.equal(sync.state().lastError, null);

  const reopened = createGoogleSync({ dataDir: DIR, endpoints, secrets, clock: () => now });
  assert.equal(await reopened.init(), true);
  assert.equal(reopened.state().connected, true);
  assert.equal(await reopened.sync(), true);
  assert.equal(refreshCalls, 2);
  assert.equal(await reopened.disconnect(), true, reopened.state().lastError);
  assert.ok(revoked);
  assert.equal(credentials.size, 0);
  assert.equal(reopened.state().connected, false);
  const files = (await readdir(DIR, { withFileTypes: true })).filter((file) => file.isFile());
  const saved = (await Promise.all(files.map(({ name }) => readFile(path.join(DIR, name), 'utf8')))).join('\n');
  for (const token of tokenValues) {
    assert.ok(!saved.includes(token), 'tokens stay out of the data files');
    assert.ok(!logs.join('\n').includes(token), 'tokens stay out of logs');
    assert.ok(!JSON.stringify(sync.state()).includes(token), 'tokens stay out of panel state');
  }
  assert.deepEqual(logs, []);
} finally {
  [console.log, console.error, console.warn] = originals;
  server.close();
  server.closeAllConnections();
  await rm(scratch, { recursive: true, force: true });
}
console.log('Google sync: OAuth, refresh, paging, cursors, conflicts, recurrence, push, backoff, and lock passed');
