// Habits: parsing schedules, ticking off, streaks, storage recovery, and deduplication of check-ins. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-habits-test-'));
process.env.ROAMIES_DATA_DIR = TMP; process.env.HOME = TMP; process.env.USERPROFILE = TMP;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const H = await import('../habits.mjs');

assert.deepEqual(H.parseDays('daily'), null);
assert.deepEqual(H.parseDays('weekdays'), [1, 2, 3, 4, 5]);
assert.deepEqual(H.parseDays('Mon, Wed, Fri'), [1, 3, 5]);
assert.equal(H.parseDays('nonsense'), undefined);
assert.equal(H.describeDays([1, 3, 5]), 'Mon, Wed, Fri');
assert.equal(H.describeDays(null), 'every day');

const h = await H.add({ title: 'Drink water', days: 'daily' }, Date.UTC(2026, 10, 20));
assert.ok(h.id);
assert.equal(h.title, 'Drink water');
assert.equal(H.list().length, 1);

// check-in deduplicates: ticking twice on the same day keeps one entry.
const day = H.dayOf(Date.UTC(2026, 10, 20, 12));
await H.checkIn(h.id, { done: true, now: Date.UTC(2026, 10, 20, 12) });
await H.checkIn(h.id, { done: true, now: Date.UTC(2026, 10, 20, 13) });
assert.equal(H.get(h.id).checks.filter((d) => d === day).length, 1, 'no duplicate check-in');
const s = H.stats(H.get(h.id), Date.UTC(2026, 10, 20, 12));
assert.equal(s.doneToday, true);
assert.equal(s.dueToday, true);
assert.ok(s.streak >= 1);

// uncheck removes the tick.
await H.checkIn(h.id, { done: false, now: Date.UTC(2026, 10, 20, 14) });
assert.equal(H.stats(H.get(h.id), Date.UTC(2026, 10, 20, 14)).doneToday, false);

// unknown id returns null.
assert.equal(await H.checkIn('nope'), null);
assert.equal(await H.update('nope', { title: 'x' }), null);
assert.equal(await H.remove('nope'), null);

// title validation.
try { await H.add({ title: '' }); assert.fail('empty title should throw'); } catch (e) { assert.match(String(e.message), /title/i); }
try { await H.add({ title: 'x'.repeat(81) }); assert.fail('long title should throw'); } catch (e) { assert.match(String(e.message), /80/); }

console.log('habits tests: passed');