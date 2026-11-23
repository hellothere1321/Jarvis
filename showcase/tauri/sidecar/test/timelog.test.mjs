// Time log: append, list, totals, atomic writes, and recovery from a damaged file. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-timelog-test-'));
process.env.HOME = TMP; process.env.USERPROFILE = TMP; process.env.ROAMIES_DATA_DIR = TMP;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const T = await import('../timelog.mjs');

const dir = path.join(TMP, 'Roamies', 'Data'), file = path.join(dir, 'timelog.json');
assert.ok(file.startsWith(TMP), 'the log lives under the throwaway data dir: ' + file);
assert.deepEqual(T.list(), [], 'a missing log reads as empty');
assert.deepEqual(T.totals(), { total: 0, byItem: [], byTitle: [] });

const t0 = Date.UTC(2026, 0, 12, 9, 0);
const realRename = fsp.rename;
const renames = [];
fsp.rename = async (from, to) => { renames.push([from, to]); return realRename(from, to); };
try {
  await T.append({ itemId: 'task-1', title: 'Slides', start: t0, end: t0 + 25 * 60_000, minutes: 25 });
} finally { fsp.rename = realRename; }
assert.equal(renames.length, 1, 'one atomic write');
assert.match(path.basename(renames[0][0]), /\.tmp$/, 'written to a temp file');
assert.equal(path.basename(renames[0][1]), 'timelog.json', 'then renamed into place');
assert.equal(fs.readdirSync(dir).some((n) => n.endsWith('.tmp')), false, 'no temp leftovers');
assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 1, 'valid JSON on disk');

await T.append({ itemId: 'task-2', title: 'Slides', start: t0 + 60 * 60_000, end: t0 + 70 * 60_000, minutes: 10 });
await T.append({ title: 'Inbox', start: t0 + 120 * 60_000, end: t0 + 134 * 60_000, minutes: 14 });
assert.equal(T.list().length, 3);
assert.deepEqual(T.list({ from: t0 + 60 * 60_000, to: t0 + 70 * 60_000 }).map((e) => e.title), ['Slides']);
assert.equal(T.list({ from: t0 + 60 * 60_000, to: t0 + 70 * 60_000 })[0].itemId, 'task-2');
assert.ok(T.list()[0].start <= T.list()[1].start, 'oldest first');

const totals = T.totals({ from: t0, to: t0 + 3 * 3600_000 });
assert.equal(totals.total, 49);
assert.deepEqual(totals.byTitle.map((x) => [x.title, x.minutes]), [['Slides', 35], ['Inbox', 14]]);
assert.deepEqual(totals.byItem.map((x) => [x.itemId, x.minutes]), [['task-1', 25], [null, 14], ['task-2', 10]], 'untitled blocks have no item id');
assert.equal(T.totals({ from: t0 - 1000, to: t0 }).total, 0, 'window filters totals too');
assert.equal(T.totals({ from: t0, to: t0 + 1000 }).total, 25, 'a block that overlaps the window counts');
assert.throws(() => T.append({ title: 'Bad', start: t0, end: t0, minutes: NaN }), /non-negative minutes/);
await T.append({ title: 'Zero', start: t0 + 240 * 60_000, end: t0 + 240 * 60_000, minutes: 0 });
assert.equal(T.list().length, 4, 'a block stopped immediately is still logged');
assert.equal(T.totals().total, 49, 'but adds no time');

// Damage: read as empty, keep the original as .bad, then carry on logging.
fs.writeFileSync(file, '{"entries": [broken');
assert.deepEqual(T.list(), [], 'corrupt log reads as empty');
assert.equal(fs.readFileSync(`${file}.bad`, 'utf8'), '{"entries": [broken', 'kept aside, not thrown away');
assert.equal(fs.existsSync(file), false);
await T.append({ title: 'Slides', start: t0 + 180 * 60_000, end: t0 + 190 * 60_000, minutes: 10 });
assert.deepEqual(T.list().map((e) => e.title), ['Slides'], 'new log starts clean');
assert.equal(T.totals().total, 10);

// A JSON array with a broken entry is corrupt too, not a log to silently filter down.
fs.writeFileSync(file, '[{"title":"oops"}]');
assert.deepEqual(T.list(), []);
assert.equal(fs.readFileSync(`${file}.bad`, 'utf8'), '[{"title":"oops"}]');
await T.append({ title: 'Again', start: t0 + 210 * 60_000, end: t0 + 213 * 60_000, minutes: 3 });
assert.equal(T.totals().total, 3);

console.log('timelog tests: passed');
