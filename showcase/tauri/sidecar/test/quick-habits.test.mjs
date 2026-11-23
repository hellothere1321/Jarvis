// Quick command entry points for habits: match + run, against a scratch store. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-quick-habits-test-'));
process.env.ROAMIES_DATA_DIR = TMP; process.env.HOME = TMP; process.env.USERPROFILE = TMP;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const { match, run } = await import('../quick.mjs');
const NOW = new Date(2026, 10, 22, 15, 42, 0);
const HOME = path.join(TMP, 'home');

// match entry points
const add = match('add habit drink water', { now: NOW, home: HOME, platform: 'win32' });
assert.equal(add.kind, 'habit-add');
assert.equal(add.args.title, 'drink water');

const list = match('list habits', { now: NOW, home: HOME, platform: 'win32' });
assert.equal(list.kind, 'habit-list');

const check = match('check habit drink water', { now: NOW, home: HOME, platform: 'win32' });
assert.equal(check.kind, 'habit-check');
assert.equal(check.args.name, 'drink water');

// run entry points hit the store and deps.
let shown = 0;
let habits = [];
const deps = {
  now: NOW, home: HOME,
  say: (l) => { lines.push(l); return true; },
  showHabits: () => { shown++; },
  onHabit: (h) => { habits.push(h); },
};
const lines = [];
assert.equal(await run(add, deps), true);
assert.equal((await import('../habits.mjs')).list().length, 1);
assert.equal(habits.length, 1);

const lst = match('show habits', { now: NOW, home: HOME, platform: 'win32' });
assert.equal(await run(lst, deps), true);
assert.equal(shown, 1);

const chk = match('tick habit drink water', { now: NOW, home: HOME, platform: 'win32' });
assert.equal(await run(chk, deps), true);
assert.equal((await import('../habits.mjs')).list()[0].checks.length, 1);

console.log('quick habit entry points: passed');