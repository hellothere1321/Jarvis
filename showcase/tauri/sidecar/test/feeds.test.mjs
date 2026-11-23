// Calendar feeds: the link rules, the fetch limits and how an .ics lands in the planner. No real network: fetch and
// DNS are fakes, and the data folder is a fresh temp dir.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-feeds-'));
process.env.ROAMIES_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const { createFeeds, download, normalizeUrl, entriesFrom } = await import('../feeds.mjs');
const planner = await import('../planner.mjs');

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const now = at(2027, 3, 10, 12);
const reply = (body, init = {}) => new Response(body, init);
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

// The factory used by the app must use the pinned transport even without injected fetch.
const originalRequest = https.request;
const originalFetch = globalThis.fetch;
let defaultRequests = 0;
try {
  globalThis.fetch = async () => { throw new Error('Unpinned transport'); };
  https.request = (url, options, callback) => {
    defaultRequests++;
    assert.equal(options.agent, false);
    options.lookup(url.hostname, { all: true }, (error, addresses) => {
      assert.ifError(error);
      assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
    });
    const req = new EventEmitter();
    req.end = () => callback(Object.assign(
      Readable.from([Buffer.from('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')]),
      { statusCode: 200, statusMessage: 'OK', headers: {} },
    ));
    return req;
  };
  const defaults = createFeeds({ lookup: publicDns });
  const feed = await defaults.add({ name: 'Pinned transport', url: 'https://example.test/pinned.ics' });
  assert.equal((await defaults.refresh([feed.id]))[0].ok, true);
  assert.equal(defaultRequests, 1);
  await defaults.remove(feed.id);
} finally {
  https.request = originalRequest;
  globalThis.fetch = originalFetch;
}

// ---------- the link ----------
assert.equal(normalizeUrl('http://example.com/a.ics'), 'http://example.com/a.ics');
assert.equal(normalizeUrl(' https://example.com/a.ics?token=x '), 'https://example.com/a.ics?token=x');
assert.equal(normalizeUrl('webcal://example.com/a.ics'), 'https://example.com/a.ics');
assert.equal(normalizeUrl('WEBCAL://example.com/a.ics'), 'https://example.com/a.ics');
for (const bad of ['', 'file:///C:/Users/me/a.ics', 'ftp://example.com/a.ics', 'javascript:alert(1)', 'example.com/a.ics',
  'http://127.0.0.1/a.ics', 'http://192.168.1.5/a.ics', 'http://10.0.0.2:8080/a.ics', 'http://169.254.169.254/latest', 'http://localhost/a.ics',
  'http://[::1]/a.ics', 'https://user:pass@example.com/a.ics']) assert.throws(() => normalizeUrl(bad), Error, bad);

// ---------- the fetch ----------
const feed = { fetchImpl: async () => reply('BEGIN:VCALENDAR\r\nEND:VCALENDAR'), lookup: publicDns };
assert.match(await download('https://example.com/a.ics', feed), /VCALENDAR/);

// a public name that points at a private address
let fetched = 0;
await assert.rejects(download('https://sneaky.example.com/a.ics', { fetchImpl: async () => { fetched++; return reply('x'); }, lookup: async () => [{ address: '10.1.2.3', family: 4 }] }), /own computer or network/);
assert.equal(fetched, 0, 'nothing is requested from a private address');
await assert.rejects(download('https://sneaky.example.com/a.ics', { fetchImpl: async () => reply('x'), lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '::ffff:127.0.0.1', family: 6 }] }), /own computer or network/);

// a redirect to a private address, by IP and by a name that resolves to one
const redirect = (to, status = 302) => reply(null, { status, headers: { location: to } });
await assert.rejects(download('https://example.com/a.ics', { lookup: publicDns, fetchImpl: async (u) => (u.startsWith('https://example.com') ? redirect('http://192.168.0.1/a.ics') : reply('x')) }), /own computer or network/);
await assert.rejects(download('https://example.com/a.ics', { lookup: async (h) => [{ address: h === 'inside.example.com' ? '127.0.0.1' : '93.184.216.34' }], fetchImpl: async (u) => (u.startsWith('https://example.com') ? redirect('https://inside.example.com/a.ics') : reply('x')) }), /own computer or network/);
await assert.rejects(download('https://example.com/a.ics', { lookup: publicDns, fetchImpl: async () => redirect('file:///etc/passwd') }), /http and https/);

// the checked answer is pinned to the socket: rebinding between the check and the connect can't swap the address
let resolutions = 0, pinnedLookup;
await download('https://pinned.example.com/a.ics', {
  lookup: async () => { resolutions++; return [{ address: '93.184.216.34', family: 4 }]; },
  fetchImpl: async (_u, o) => { pinnedLookup = o.lookup; return reply('BEGIN:VCALENDAR'); },
});
assert.equal(resolutions, 1, 'the name is resolved once, for the check');
const all = await new Promise((resolve, reject) => pinnedLookup('pinned.example.com', { all: true }, (e, a) => e ? reject(e) : resolve(a)));
assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }]);
const first = await new Promise((resolve, reject) => pinnedLookup('pinned.example.com', {}, (e, a, f) => e ? reject(e) : resolve([a, f])));
assert.deepEqual(first, ['93.184.216.34', 4]);
await assert.rejects(new Promise((_, reject) => pinnedLookup('elsewhere.example.com', {}, (e) => reject(e))), /ENOTFOUND/, 'a pin cannot be reused for another host');

// every redirect is checked and pinned again before its own socket is opened
const resolved = [], hopsSeen = [];
await download('https://first.example.com/a.ics', {
  lookup: async (h) => { resolved.push(h); return [{ address: h === 'first.example.com' ? '93.184.216.34' : '93.184.216.35', family: 4 }]; },
  fetchImpl: async (u, o) => { hopsSeen.push([u, o.lookup]); return u.includes('first.example.com') ? redirect('https://second.example.com/x.ics') : reply('BEGIN:VCALENDAR'); },
});
assert.deepEqual(resolved, ['first.example.com', 'second.example.com']);
assert.equal(hopsSeen.length, 2);
const second = await new Promise((resolve, reject) => hopsSeen[1][1]('second.example.com', {}, (e, a, f) => e ? reject(e) : resolve([a, f])));
assert.deepEqual(second, ['93.184.216.35', 4], 'the redirect uses its own checked address');

// at most five redirects are followed (relative ones too)
let hops = 0;
const chain = async (u) => (hops++ < 5 ? redirect(`/step${hops}`, 301) : reply('BEGIN:VCALENDAR'));
assert.equal(await download('https://example.com/a.ics', { fetchImpl: chain, lookup: publicDns }), 'BEGIN:VCALENDAR');
assert.equal(hops, 6);
await assert.rejects(download('https://example.com/a.ics', { fetchImpl: async () => redirect('/again'), lookup: publicDns }), /too many times/);

// size: refused by its declared length and when it grows past the cap without one
await assert.rejects(download('https://example.com/a.ics', { lookup: publicDns, maxBytes: 100, fetchImpl: async () => reply('x'.repeat(50), { headers: { 'content-length': '5000' } }) }), /over/);
const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(40)); } });
await assert.rejects(download('https://example.com/a.ics', { lookup: publicDns, maxBytes: 100, fetchImpl: async () => reply(stream) }), /over/);
assert.equal((await download('https://example.com/a.ics', { lookup: publicDns, maxBytes: 100, fetchImpl: async () => reply('y'.repeat(100)) })).length, 100);

// errors and the deadline
await assert.rejects(download('https://example.com/a.ics', { lookup: publicDns, fetchImpl: async () => reply('no', { status: 404 }) }), /404/);
await assert.rejects(download('https://example.com/a.ics', { lookup: publicDns, timeoutMs: 30, fetchImpl: () => new Promise(() => {}) }), /too long/);
await assert.rejects(download('https://example.com/a.ics', { lookup: publicDns, timeoutMs: 30, fetchImpl: async () => reply(new ReadableStream({ pull: () => new Promise(() => {}) })) }), /too long/);

// ---------- the calendar text ----------
const ics = (...parts) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...parts.flat(), 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const vtodo = (...lines) => ['BEGIN:VTODO', ...lines, 'END:VTODO'];
const calendar = (title = 'Physics lecture') => ics(
  vevent('UID:lecture-1', `SUMMARY:${title}`, 'DTSTART:20270312T150000', 'DTEND:20270312T163000', 'LOCATION:Room 4', 'DESCRIPTION:Bring notes\\nhttps://school.example.com/physics.', 'URL:https://school.example.com/e/1'),
  vevent('UID:trip-2', 'SUMMARY:Field trip', 'DTSTART;VALUE=DATE:20270315', 'DTEND;VALUE=DATE:20270317'),
  vevent('UID:weekly-3', 'SUMMARY:Lab', 'DTSTART:20270315T090000', 'DTEND:20270315T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4', 'EXDATE:20270322T090000'),
  // "the last Friday of the month" is outside the planner's repeat rules: imported once, as its first date
  vevent('UID:odd-4', 'SUMMARY:Monthly review', 'DTSTART:20270326T140000', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR'),
  vevent('UID:gone-5', 'SUMMARY:Cancelled seminar', 'DTSTART:20270320T100000', 'STATUS:CANCELLED'),
  vevent('UID:old-6', 'SUMMARY:Long past', 'DTSTART:20200101T100000'),
  vtodo('UID:essay-7', 'SUMMARY:Essay draft', 'DUE;VALUE=DATE:20270319', 'URL:https://school.example.com/essay'),
  vtodo('UID:quiz-8', 'SUMMARY:Quiz 1', 'DUE:20270318T235900', 'STATUS:COMPLETED', 'COMPLETED:20270309T120000Z'),
  vtodo('UID:undated-9', 'SUMMARY:Read chapter 4'),
);
{
  const e = Object.fromEntries(entriesFrom(calendar(), now).map((x) => [x.uid, x]));
  assert.deepEqual(Object.keys(e).sort(), ['essay-7', 'lecture-1', 'odd-4', 'quiz-8', 'trip-2', 'undated-9', 'weekly-3']);
  assert.equal(e['lecture-1'].start, at(2027, 3, 12, 15));
  assert.equal(e['lecture-1'].end, at(2027, 3, 12, 16, 30));
  assert.equal(e['lecture-1'].link, 'https://school.example.com/e/1');
  assert.equal(e['lecture-1'].notes, 'Room 4\nBring notes\nhttps://school.example.com/physics.');
  assert.equal(e['trip-2'].allDay, true);
  assert.equal(e['trip-2'].end, at(2027, 3, 17));
  assert.equal(e['weekly-3'].repeat, 'FREQ=WEEKLY;BYDAY=MO;COUNT=4');
  assert.deepEqual(e['weekly-3'].skip, [at(2027, 3, 22, 9)]);
  assert.equal(e['odd-4'].repeat, null);
  assert.equal(e['essay-7'].kind, 'task');
  assert.equal(e['essay-7'].start, at(2027, 3, 19));
  assert.equal(e['quiz-8'].done, true);
  assert.equal(e['undated-9'].start, null);
  assert.equal(entriesFrom(ics(vevent('SUMMARY:No id', 'DTSTART:20270312T150000')), now)[0].uid.startsWith('nouid-'), true);
  // a series and an edit of one occurrence share a UID: the series wins either way round
  const edit = vevent('UID:s', 'SUMMARY:Moved', 'DTSTART:20270316T100000', 'RECURRENCE-ID:20270315T090000');
  const series = vevent('UID:s', 'SUMMARY:Series', 'DTSTART:20270315T090000', 'RRULE:FREQ=WEEKLY');
  for (const text of [ics(edit, series), ics(series, edit)]) assert.deepEqual(entriesFrom(text, now).map((x) => x.title), ['Series']);
  assert.throws(() => entriesFrom('<html>sign in</html>', now), /isn’t a calendar/);
  assert.deepEqual(entriesFrom(ics(), now), []);
}

// ---------- merging into the planner ----------
const served = new Map();
const requests = [];
const fetchImpl = async (url) => {
  requests.push(url);
  const r = served.get(url);
  if (r == null) return reply('not found', { status: 404 });
  return typeof r === 'function' ? r() : reply(r);
};
let changes = 0;
const feeds = createFeeds({ fetchImpl, lookup: publicDns, clock: () => now, changed: () => changes++ });
const ownItems = (id) => planner.syncItems().filter((i) => i.source === `feed:${id}`);
const byUid = (id, uid) => ownItems(id).find((i) => i.uid === uid);

const mine = await planner.add({ kind: 'task', title: 'Typed by hand', start: at(2027, 3, 11) }, now);
const a = await feeds.add({ name: 'School', url: 'webcal://school.example.com/cal.ics?token=SECRET' });
await assert.rejects(feeds.add({ name: 'Again', url: 'https://school.example.com/cal.ics?token=SECRET' }), /already added/);
await assert.rejects(feeds.add({ name: 'Bad', url: 'http://10.0.0.1/cal.ics' }), /own computer or network/);
assert.equal(feeds.list().length, 1);
assert.equal(JSON.stringify(feeds.list()).includes('SECRET'), false, 'the link is never shown');
assert.equal(feeds.list()[0].host, 'school.example.com');

served.set('https://school.example.com/cal.ics?token=SECRET', calendar());
let [r] = await feeds.refresh();
assert.deepEqual([r.ok, r.added, r.updated, r.removed], [true, 7, 0, 0]);
assert.ok(changes > 0);
const lecture = byUid(a.id, 'lecture-1');
assert.deepEqual([lecture.kind, lecture.title, lecture.start, lecture.source, lecture.uid, lecture.link, lecture.cat], ['event', 'Physics lecture', at(2027, 3, 12, 15), `feed:${a.id}`, 'lecture-1', 'https://school.example.com/e/1', 'School']);
assert.equal(lecture.dirty, false);
assert.equal(byUid(a.id, 'weekly-3').repeat, 'FREQ=WEEKLY;BYDAY=MO;COUNT=4');
assert.equal(byUid(a.id, 'odd-4').repeat, null);
assert.equal(byUid(a.id, 'quiz-8').done, true);
assert.equal(byUid(a.id, 'essay-7').link, 'https://school.example.com/essay');
assert.equal(feeds.list()[0].items, 7);
assert.equal(feeds.list()[0].lastFetch, now);
assert.equal(feeds.list()[0].lastError, null);
// the series expands in the planner with its skipped date left out
assert.deepEqual(planner.occurrences(at(2027, 3, 14), at(2027, 4, 30)).filter((x) => x.title === 'Lab').map((x) => x.start), [at(2027, 3, 15, 9), at(2027, 3, 29, 9), at(2027, 4, 5, 9)]);
assert.equal(planner.get(mine.id).title, 'Typed by hand');

// feed items are read-only in the planner
for (const run of [() => planner.update(lecture.id, { title: 'x' }), () => planner.remove(lecture.id), () => planner.complete(byUid(a.id, 'essay-7').id), () => planner.skipOccurrence(byUid(a.id, 'weekly-3').id, at(2027, 3, 29, 9))])
  await assert.rejects(Promise.resolve().then(run), /calendar feed/);
assert.equal(planner.get(lecture.id).title, 'Physics lecture');

// the same calendar again changes nothing, and local-only fields survive
await planner.edit(lecture.id, { est: 30, spent: 5 });
const before = fs.readFileSync(path.join(dir, 'Roamies', 'Data', 'planner.json'), 'utf8');
[r] = await feeds.refresh();
assert.deepEqual([r.added, r.updated, r.removed], [0, 0, 0]);
assert.equal(fs.readFileSync(path.join(dir, 'Roamies', 'Data', 'planner.json'), 'utf8'), before, 'an unchanged feed doesn’t rewrite the planner');

// a changed event is updated in place; one that vanished is removed outright
served.set('https://school.example.com/cal.ics?token=SECRET', calendar('Physics lecture (moved online)').replace(/\r\nBEGIN:VEVENT\r\nUID:trip-2[\s\S]*?END:VEVENT/, ''));
[r] = await feeds.refresh();
assert.deepEqual([r.added, r.updated, r.removed], [0, 1, 1]);
const moved = byUid(a.id, 'lecture-1');
assert.deepEqual([moved.id, moved.title, moved.est, moved.spent], [lecture.id, 'Physics lecture (moved online)', 30, 5]);
assert.equal(byUid(a.id, 'trip-2'), undefined);
assert.equal(planner.syncItems().some((i) => i.uid === 'trip-2'), false, 'a vanished item leaves no tombstone');
assert.equal(planner.get(mine.id).title, 'Typed by hand');

// a failing or bogus feed keeps what it had and says why
served.set('https://school.example.com/cal.ics?token=SECRET', () => reply('server broke', { status: 503 }));
[r] = await feeds.refresh();
assert.equal(r.ok, false);
assert.match(r.error, /503/);
assert.equal(feeds.list()[0].lastError, r.error);
assert.equal(ownItems(a.id).length, 6);
served.set('https://school.example.com/cal.ics?token=SECRET', '<html>Please sign in</html>');
[r] = await feeds.refresh();
assert.match(r.error, /isn’t a calendar/);
assert.equal(ownItems(a.id).length, 6, 'a login page doesn’t wipe the calendar');
served.set('https://school.example.com/cal.ics?token=SECRET', () => { throw new Error('connect ECONNREFUSED https://school.example.com/cal.ics?token=SECRET'); });
[r] = await feeds.refresh();
assert.equal(r.error.includes('SECRET'), false, 'errors never carry the link');
served.set('https://school.example.com/cal.ics?token=SECRET', calendar('Physics lecture'));
[r] = await feeds.refresh();
assert.equal(r.ok, true);
assert.equal(feeds.list()[0].lastError, null);

// a second feed with the same UIDs is a separate set of items
const b = await feeds.add({ name: 'Club', url: 'https://club.example.org/events.ics' });
served.set('https://club.example.org/events.ics', ics(vevent('UID:lecture-1', 'SUMMARY:Club night', 'DTSTART:20270313T190000')));
requests.length = 0;
const both = await feeds.refresh();
assert.equal(both.length, 2);
assert.equal(byUid(b.id, 'lecture-1').title, 'Club night');
assert.equal(byUid(a.id, 'lecture-1').title, 'Physics lecture');
await feeds.refresh([b.id]);
assert.deepEqual(requests.slice(-1), ['https://club.example.org/events.ics']);

// off takes its items away, on brings them back, and remove deletes the feed and its items for good
await feeds.setOn(a.id, false);
assert.equal(ownItems(a.id).length, 0);
assert.equal(feeds.list().find((f) => f.id === a.id).on, false);
requests.length = 0;
await feeds.refresh();
assert.equal(requests.includes('https://school.example.com/cal.ics?token=SECRET'), false, 'a feed that is off isn’t fetched');
await feeds.setOn(a.id, true);
assert.equal(ownItems(a.id).length, 7);
assert.equal(await feeds.remove(a.id).then((f) => f.id), a.id);
assert.equal(ownItems(a.id).length, 0);
assert.equal(feeds.list().length, 1);
assert.equal(ownItems(b.id).length, 1);
assert.equal(planner.get(mine.id).title, 'Typed by hand');
assert.equal(await feeds.remove('nope'), null);

// a feed that points somewhere private at fetch time is refused, and the error names only the host
const c = await feeds.add({ name: 'Rebinding', url: 'https://rebind.example.net/x.ics?token=SECRET' });
const rebinding = createFeeds({ fetchImpl, lookup: async () => [{ address: '192.168.1.20', family: 4 }], clock: () => now });
[r] = (await rebinding.refresh([c.id]));
assert.match(r.error, /rebind\.example\.net/);
assert.equal(r.error.includes('SECRET'), false);

// the hourly timer fetches at once and again every interval
let ticks = 0;
const counted = createFeeds({ fetchImpl: async () => { ticks++; return reply(ics()); }, lookup: publicDns, clock: () => now });
const stop = counted.start(40);
await new Promise((resolve) => setTimeout(resolve, 150));
await stop();
assert.ok(ticks >= 2, `fetched ${ticks} times`);

// ---------- the agent's tools ----------
const { createTools } = await import('../tools.mjs');
const inbox = await import('../inbox.mjs');
const asked = [];
let answer = 'Allow', toolChanges = 0;
const base = { ask: async (o) => { asked.push(o.placeholder); return answer; }, userName: 'Test', onPlanner: () => toolChanges++ };
const toolFeeds = createFeeds({ fetchImpl, lookup: publicDns, clock: () => now });
const { tools } = createTools({ ...base, feeds: toolFeeds });
assert.equal(createTools(base).tools.some((t) => ['add_feed', 'remove_feed'].includes(t.name)), false, 'no feed tools without feeds');
const run = (name, args) => { const tool = tools.find((t) => t.name === name); return tool.execute(tool.parameters.parse(args), {}); };

await assert.rejects(run('add_feed', { url: 'http://192.168.1.9/cal.ics' }), /own computer or network/);
await assert.rejects(run('add_feed', { url: 'file:///C:/cal.ics' }), /http and https/);
assert.equal(asked.length, 0, 'a link that is never allowed isn’t asked about');
const feedsBefore = toolFeeds.list().length;
answer = "Don't allow";
await assert.rejects(run('add_feed', { url: 'webcal://tools.example.com/cal.ics?token=SECRET', name: 'Tools' }), /said no/);
assert.equal(toolFeeds.list().length, feedsBefore);
assert.match(asked.at(-1), /tools\.example\.com/);
assert.equal(asked.at(-1).includes('SECRET'), false);
answer = 'Allow';
served.set('https://tools.example.com/cal.ics?token=SECRET', calendar());
const added = await run('add_feed', { url: 'webcal://tools.example.com/cal.ics?token=SECRET', name: 'Tools' });
assert.match(added, /"Tools" \(tools\.example\.com\): 7 items/);
assert.equal(added.includes('SECRET'), false);
assert.ok(toolChanges > 0);
const toolFeed = toolFeeds.list().find((f) => f.name === 'Tools');
assert.equal(ownItems(toolFeed.id).length, 7);

await assert.rejects(run('remove_feed', { feed: 'Nope' }), /No feed called "Nope".*Tools/);
answer = "Don't allow";
await assert.rejects(run('remove_feed', { feed: 'tools' }), /said no/);
assert.equal(ownItems(toolFeed.id).length, 7);
answer = 'Allow';
assert.match(await run('remove_feed', { feed: toolFeed.id }), /Removed the feed "Tools"/);
assert.equal(ownItems(toolFeed.id).length, 0);
assert.equal(toolFeeds.list().some((f) => f.id === toolFeed.id), false);

assert.equal(await run('list_inbox', {}), 'The inbox is empty.');
const pending = await inbox.capture('Renew passport');
const other = await inbox.capture('Call the dentist');
assert.match(await run('list_inbox', {}), new RegExp(`${pending.id} · Renew passport`));
await assert.rejects(run('accept_inbox_item', { id: 'nope', when: 'friday' }), /No inbox item/);
await assert.rejects(run('accept_inbox_item', { id: pending.id, when: 'whenever' }), /Couldn't read/);
assert.match(await run('accept_inbox_item', { id: pending.id, when: 'friday' }), /task: Renew passport/);
assert.match(await run('accept_inbox_item', { id: other.id, when: 'friday 3pm' }), /event: Call the dentist/);
assert.equal(inbox.list().length, 0);

// ---------- caps ----------
const limiter = createFeeds({ fetchImpl, lookup: publicDns, clock: () => now });
for (const f of limiter.list()) await limiter.remove(f.id);
for (let i = 0; i < 20; i++) await limiter.add({ name: `Feed ${i}`, url: `https://f${i}.example.com/a.ics` });
await assert.rejects(limiter.add({ name: 'One too many', url: 'https://extra.example.com/a.ics' }), /most feeds/, 'twenty feeds is the cap');
assert.equal(limiter.list().length, 20);
for (const f of limiter.list()) await limiter.remove(f.id);
const crowded = ics(...Array.from({ length: 2005 }, (_, i) => vevent(`UID:cap-${i}`, `SUMMARY:Item ${i}`, 'DTSTART:20270312T150000')));
assert.equal(entriesFrom(crowded, now).length, 2000, 'a feed contributes at most two thousand entries');
console.log('feeds: link rules, pinned fetch, fetch limits, caps, merge, update, vanish, remove, tools and timer passed');
