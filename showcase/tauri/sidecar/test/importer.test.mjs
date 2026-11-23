// Importing VowenLite data: scan counts, an import into the real modules, a second run that adds nothing, a source that
// stays byte-identical, a damaged file that is reported (not thrown), and the DPAPI vault path (Windows only, with a
// made-up password and an in-memory key, so nothing reaches the real credential store). Run: npm test
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-import-home-'));
const src = fs.mkdtempSync(path.join(os.tmpdir(), 'vowen-src-'));
const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'vowen-bad-'));
process.env.ROAMIES_DATA_DIR = home; process.env.HOME = home; process.env.USERPROFILE = home;
process.on('exit', () => { for (const d of [home, src, bad]) fs.rmSync(d, { recursive: true, force: true }); });

const { findVowenLite, scan, run, parseTranscript, settingsPatch } = await import('../importer.mjs');
const planner = await import('../planner.mjs');
const timelog = await import('../timelog.mjs');
const inbox = await import('../inbox.mjs');
const { createFeeds } = await import('../feeds.mjs');
const { createVault } = await import('../vault.mjs');
const { createMeetings } = await import('../meetings.mjs');
const { runInput } = await import('../secrets.mjs');
const { DIR, readJson } = await import('../store.mjs');

const WIN = process.platform === 'win32';
const PASSWORD = 'made-up-password-for-the-test';
const SECRET_URL = 'https://example.test/cal/private-token-123.ics';
const day = (d) => new Date(2026, 10, d).toISOString().slice(0, 10);

// ---------- a made-up VowenLite data folder ----------
const write = (dir, name, data) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data)); };
const item = (o) => ({ Id: 'x', Kind: 'task', Title: 't', Notes: '', Start: null, End: null, AllDay: false, Done: false, Alert: 10, Fired: false, FiredFor: null, Repeat: null, Skip: [], Cat: '', Priority: 0, LastDone: null, Deleted: false, Dirty: false, GId: null, GList: null, Updated: '2026-11-01T00:00:00Z', Est: 0, Spent: 0, Source: '', Uid: null, Link: '', BlockFor: null, ...o });
write(src, 'planner.json', [
  item({ Id: 'p1', Title: 'Essay draft', Start: '2026-11-25T00:00:00', Priority: 2, Est: 60, Spent: 20, Cat: 'School', GId: 'g1', Link: 'https://example.test/essay' }),
  item({ Id: 'p2', Kind: 'event', Title: 'Lab session', Start: '2026-11-23T14:00:00', End: '2026-11-23T15:30:00', Alert: 15, Repeat: 'FREQ=WEEKLY;BYDAY=MO' }),
  item({ Id: 'p3', Title: 'Read chapter one', Start: '2026-11-20T00:00:00', Done: true }),
  item({ Id: 'p4', Title: 'Deleted one', Deleted: true }),
  item({ Id: 'p5', Title: 'From a feed', Source: 'feed:abc', Uid: 'u1' }),
  item({ Id: 'p6', Kind: 'event', Title: 'Event with no date' }),
]);
write(src, 'timelog.json', {
  [day(20)]: { Tasks: { p1: 1800, gone: 600, tiny: 20 }, Apps: { code: 900 }, Hours: new Array(24).fill(0) },
  [day(21)]: { Tasks: { p3: 900 }, Apps: {}, Hours: new Array(24).fill(0) },
});
write(src, 'inbox.json', [{ Id: 'i1', Title: 'Email the registrar', Kind: 'task' }, { Id: 'i2', Title: 'Book a dentist visit', Kind: 'task' }]);
write(src, 'settings.json', { QuietHours: '01:00-07:30', Distractions: ['discord', 'steam'], Names: 'Priya, Mr Okafor', Dictation: false, Feeds: [SECRET_URL, 'C:\\school\\cal.ics'], FeedList: 'School' });
write(src, 'google-client.json', { installed: { client_id: 'id.apps.example.test', client_secret: 'not-a-real-secret', redirect_uris: ['http://localhost'] } });
write(src, 'google-token.json', { refresh_token: 'never-copied' });
write(src, 'threads.json', [
  { Id: 't1', Updated: '2026-11-18T10:00:00', Turns: [{ Q: 'What is a tuple?', A: 'An ordered, immutable list.', At: '2026-11-18T10:00:00' }], Pending: null },
  { Id: 't2', Updated: '2026-11-18T11:00:00', Turns: [], Pending: null },
]);

// A DPAPI blob made the way Vault.cs makes one: "v1|<utc ticks>|<password>", entropy salt + "vowenlite-vault:" + site.
const powershell = (script, input) => runInput('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], input, 60_000);
const PROTECT = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security
$o=[Console]::In.ReadToEnd() | ConvertFrom-Json; $salt=[Convert]::FromBase64String($o.salt)
$entropy=[byte[]]($salt + [Text.Encoding]::UTF8.GetBytes('vowenlite-vault:' + $o.site))
$plain=[Text.Encoding]::UTF8.GetBytes($o.plain)
[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)))`;
const salt = Buffer.from('0123456789abcdef').toString('base64');
let goodBlob = Buffer.from('not a real blob').toString('base64');
if (WIN) {
  const ticks = (BigInt(Date.now()) * 10000n + 621355968000000000n).toString();
  const r = await powershell(PROTECT, JSON.stringify({ salt, site: 'example.test', plain: `v1|${ticks}|${PASSWORD}` }));
  assert.equal(r.code, 0, 'the test blob could be sealed');
  goodBlob = r.stdout.trim();
}
const entry = (o) => ({ Site: 'example.test', Host: 'example.test', Subdomains: null, User: 'student', Blob: goodBlob, Salt: salt, SavedAt: '2026-11-22T00:00:00Z', ...o });
write(src, 'vault.json', [
  entry({}),
  entry({ Site: 'broken.test', Host: 'broken.test', Blob: Buffer.from('garbage').toString('base64') }),
  entry({ Site: 'old.test', Host: 'old.test', Blob: null, Salt: null }),
]);

const meetingsSrc = path.join(src, 'Meetings');
write(meetingsSrc, '2026-11-10_20-52/transcript.md', '# Meeting 2026-11-10 20:52\n\n[00:03] You: Hello everyone.\n\n[01:05] Others: Let us start with the budget.\n\n[1:02:10] You: Thanks, that is all.\n');
write(meetingsSrc, '2026-11-10_20-52/summary.md', '## Summary\nBudget talk.\n');
write(meetingsSrc, '2026-11-11_09-05/summary.md', '## Summary\nNotes only.\n');
write(meetingsSrc, '2026-11-12_10-00/mic.wav', 'RIFF');
write(meetingsSrc, 'scratch/summary.md', 'odd folder name');

const paths = findVowenLite({ platform: 'win32', env: { VOWENLITE_DATA: src, VOWENLITE_MEETINGS: meetingsSrc } });
assert.deepEqual(paths, { dataDir: src, meetingsDir: meetingsSrc });
assert.equal(findVowenLite({ platform: 'linux', env: { VOWENLITE_DATA: src } }), null, 'Windows only');
assert.equal(findVowenLite({ platform: 'win32', env: { VOWENLITE_DATA: path.join(src, 'nope') } }), null, 'no folder, no block');

const tree = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map((n) => {
  const p = path.join(dir, n);
  return fs.statSync(p).isFile() ? `${n}:${createHash('sha256').update(fs.readFileSync(p)).digest('hex')}` : n;
}).join('\n');
const before = tree(src);

// ---------- scan: counts, problems, no text, no writes ----------
const first = scan({ paths });
assert.deepEqual(first.kinds, {
  planner: { found: 3, new: 3 }, timelog: { found: 3, new: 3 }, inbox: { found: 2, new: 2 }, feeds: { found: 1, new: 1 },
  vault: { found: 2, new: 2 }, threads: { found: 1, new: 1 }, meetings: { found: 2, new: 2 }, settings: { found: 5, new: 5 },
});
const problemText = first.problems.join(' | ');
assert.match(problemText, /1 planner item had no title or date/);
assert.match(problemText, /1 calendar feed is a file on this PC/);
assert.match(problemText, /1 saved login has expired/);
assert.match(problemText, /1 meeting folder had an unfamiliar name/);
assert.match(first.notes.join(' '), /1 planner item is already in Google/);
const seen = JSON.stringify(first);
for (const text of ['Essay draft', 'Lab session', 'registrar', 'private-token', 'student', 'example.test', PASSWORD, 'Priya', 'Budget']) assert.ok(!seen.includes(text), `the scan never shows "${text}"`);
assert.equal(fs.existsSync(path.join(DIR, 'import-vowenlite.json')), false, 'a scan writes nothing');
assert.deepEqual(planner.syncItems(), []);
assert.equal(tree(src), before, 'a scan leaves the source alone');

// ---------- a damaged file is reported, not thrown ----------
write(bad, 'planner.json', '{ this is not json');
write(bad, 'threads.json', '{"not":"a list"}');
const broken = scan({ paths: { dataDir: bad, meetingsDir: null } });
assert.equal(broken.kinds.planner.found, 0);
assert.match(broken.problems.join(' | '), /planner\.json is damaged/);
assert.match(broken.problems.join(' | '), /threads\.json is not a list/);
const brokenRun = await run({ paths: { dataDir: bad, meetingsDir: null }, kinds: ['planner', 'threads'] });
assert.deepEqual(brokenRun.kinds.planner, { added: 0, already: 0, failed: 0 });
assert.equal(fs.readFileSync(path.join(bad, 'planner.json'), 'utf8'), '{ this is not json', 'the damaged source stays where it is');
assert.deepEqual(fs.readdirSync(bad).sort(), ['planner.json', 'threads.json']);
await assert.rejects(() => run({ paths: null, kinds: 'planner' }), /Choose what to import/);

// ---------- an import into the real modules ----------
let key;
const vault = createVault({ dataDir: DIR, secrets: { get: async () => key, set: async (_, v) => { key = v; } }, hands: '' });
let applied = null;
const result = await run({ paths, vault, applySettings: async (patch) => { applied = patch; } });
const added = Object.fromEntries(Object.entries(result.kinds).map(([k, v]) => [k, v.added]));
assert.deepEqual(added, { planner: 3, timelog: 3, inbox: 2, feeds: 1, vault: WIN ? 1 : 0, threads: 1, meetings: 2, settings: 5 });
assert.equal(result.kinds.planner.failed + result.kinds.timelog.failed + result.kinds.inbox.failed + result.kinds.feeds.failed, 0);

const items = planner.syncItems().filter((i) => i.source === 'vowenlite');
assert.deepEqual(items.map((i) => i.title).sort(), ['Essay draft', 'Lab session', 'Read chapter one']);
// A Google-linked item keeps its link and isn't pending a push, so connecting Google matches it instead of copying it.
{ const linked = items.find((i) => i.title === 'Essay draft'); assert.equal(linked.gId, 'g1'); assert.equal(linked.dirty, false);
  assert.equal(items.find((i) => i.title === 'Lab session').gId, null); }
const essay = items.find((i) => i.uid === 'p1'), lab = items.find((i) => i.uid === 'p2'), read = items.find((i) => i.uid === 'p3');
assert.equal(essay.kind, 'task'); assert.equal(essay.priority, 2); assert.equal(essay.est, 60); assert.equal(essay.spent, 20);
assert.equal(essay.cat, 'School'); assert.equal(essay.link, 'https://example.test/essay');
assert.equal(essay.start, new Date(2026, 10, 25).getTime());
assert.equal(lab.kind, 'event'); assert.equal(lab.alert, 15); assert.match(lab.repeat, /FREQ=WEEKLY/); assert.equal(lab.end - lab.start, 90 * 60_000);
assert.equal(read.done, true);

const rows = timelog.list();
assert.equal(rows.length, 3);
assert.equal(rows.reduce((n, r) => n + r.minutes, 0), 55);
const forEssay = rows.find((r) => r.minutes === 30);
assert.equal(forEssay.itemId, essay.id); assert.equal(forEssay.title, 'Essay draft');
assert.equal(rows.find((r) => r.minutes === 10).itemId, null, 'time on a task that is gone keeps no link');
assert.equal(forEssay.start, new Date(2026, 10, 20).getTime());

assert.deepEqual(inbox.list().map((i) => i.title).sort(), ['Book a dentist visit', 'Email the registrar']);

const feedRows = createFeeds().list();
assert.equal(feedRows.length, 1); assert.equal(feedRows[0].name, 'School'); assert.equal(feedRows[0].host, 'example.test');
assert.equal(JSON.parse(fs.readFileSync(path.join(DIR, 'feeds.json'), 'utf8'))[0].url, SECRET_URL);

assert.deepEqual(applied, { quietHours: { on: true, start: '01:00', end: '07:30' }, distractions: ['discord', 'steam'], names: ['Priya', 'Mr Okafor'], voice: false });
assert.equal(fs.readFileSync(path.join(DIR, 'google-client.json'), 'utf8'), fs.readFileSync(path.join(src, 'google-client.json'), 'utf8'));
assert.equal(fs.existsSync(path.join(DIR, 'google-token.json')), false, 'a Google sign-in is never copied');

const sessionFiles = fs.readdirSync(path.join(DIR, 'sessions')).filter((n) => n.endsWith('.json'));
assert.equal(sessionFiles.length, 1);
assert.match(sessionFiles[0], /^20261118-100000-[0-9a-f]{6}\.json$/);
const session = readJson(path.join(DIR, 'sessions', sessionFiles[0]));
assert.equal(session.version, 1);
assert.deepEqual(session.messages, [{ role: 'user', content: 'What is a tuple?' }, { role: 'assistant', content: [{ type: 'text', text: 'An ordered, immutable list.' }] }]);

const meetings = createMeetings({ call: async () => {}, base: home });
const listed = (await meetings.list()).map((m) => m.id).sort();
assert.deepEqual(listed, ['2026-11-10 2052', '2026-11-11 0905']);
const transcript = await meetings.read('2026-11-10 2052', { summary: true });
assert.deepEqual(transcript.segments.map((s) => [s.track, s.start, s.text]), [['mic', 3, 'Hello everyone.'], ['system', 65, 'Let us start with the budget.'], ['mic', 3730, 'Thanks, that is all.']]);
assert.equal(transcript.summary, '## Summary\nBudget talk.\n');
assert.equal(await meetings.summary('2026-11-11 0905'), '## Summary\nNotes only.\n');
assert.equal(fs.existsSync(path.join(home, 'Roamies', 'Meetings', '2026-11-11 0905', 'transcript.json')), false, 'notes only: no transcript');

if (WIN) {
  const [saved] = await vault.list();
  assert.equal(saved.site, 'example.test'); assert.equal(saved.username, 'student');
  assert.equal(await vault.reveal(saved.id), PASSWORD, 'the password was opened and sealed again');
  assert.equal(result.kinds.vault.failed, 1, 'the unreadable blob is counted');
  assert.match(result.problems.join(' | '), /1 saved login could not be read/);
}

// The record says what came across and when, and holds no text or secrets.
const record = fs.readFileSync(path.join(DIR, 'import-vowenlite.json'), 'utf8');
assert.ok(JSON.parse(record).lastRun > 0);
assert.equal(Object.keys(JSON.parse(record).planner).length, 3);
for (const text of [PASSWORD, 'Essay draft', 'registrar', 'private-token', 'Hello everyone', 'student', 'tuple']) assert.ok(!record.includes(text), `the record never holds "${text}"`);
const out = JSON.stringify(result);
for (const text of [PASSWORD, 'Essay draft', 'private-token', 'student']) assert.ok(!out.includes(text), `the result never shows "${text}"`);
assert.equal(tree(src), before, 'the source is byte-identical after the import');

// ---------- a second run adds nothing ----------
const again = scan({ paths });
for (const [kind, counts] of Object.entries(again.kinds)) assert.equal(counts.new, kind === 'vault' && WIN ? 1 : 0, `${kind}: nothing new`);
let appliedAgain = false;
const second = await run({ paths, vault, applySettings: async () => { appliedAgain = true; } });
for (const [kind, counts] of Object.entries(second.kinds)) assert.equal(counts.added, 0, `${kind}: nothing added the second time`);
assert.equal(appliedAgain, false, 'settings are applied once');
assert.equal(planner.syncItems().filter((i) => i.source === 'vowenlite').length, 3);
assert.equal(timelog.list().length, 3);
assert.equal(inbox.list().length, 2);
assert.equal(createFeeds().list().length, 1);
assert.equal((await vault.list()).length, WIN ? 1 : 0);
assert.equal(fs.readdirSync(path.join(DIR, 'sessions')).filter((n) => n.endsWith('.json')).length, 1);
assert.equal((await meetings.list()).length, 2);
assert.equal(tree(src), before, 'still byte-identical');

// Without the record, the planner and vault still see what is already there.
fs.rmSync(path.join(DIR, 'import-vowenlite.json'));
assert.equal(scan({ paths }).kinds.planner.new, 0);
assert.equal((await run({ paths, vault, kinds: ['planner', 'vault', 'meetings'] })).kinds.planner.added, 0);
assert.equal(planner.syncItems().filter((i) => i.source === 'vowenlite').length, 3);
assert.equal((await vault.list()).length, WIN ? 1 : 0, 'a login already saved is not saved twice');

// ---------- the pure parts ----------
assert.deepEqual(parseTranscript('[00:10] You: a\n\nnoise\n[00:12] Others: b\n[1:00:00] You: c'), [
  { start: 10, track: 'mic', text: 'a', end: 12 }, { start: 12, track: 'system', text: 'b', end: 3600 }, { start: 3600, track: 'mic', text: 'c', end: 3603 },
]);
assert.deepEqual(settingsPatch({ QuietHours: '', Dictation: true, Distractions: [], Names: ' ' }), { quietHours: { on: false }, voice: true });
assert.deepEqual(settingsPatch({ QuietHours: '25:00-07:00' }), {});
assert.deepEqual(settingsPatch(null), {});
console.log('importer ok');
