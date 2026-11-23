// Coach: quiet hours gate the tick, rollover fires once per day, escalation deduplicates, and the briefs read real planner/timelog data. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-coach-test-'));
process.env.ROAMIES_DATA_DIR = TMP; process.env.HOME = TMP; process.env.USERPROFILE = TMP;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const C = await import('../coach.mjs');
const P = await import('../planner.mjs');
const T = await import('../timelog.mjs');
const N = await import('../nudge.mjs');

// quiet hours: inside window -> tick does nothing (no state file written).
const quietSettings = { quietHours: { on: true, start: '00:30', end: '08:00' }, rollover: '21:30', escalate: true };
const morning = new Date(2026, 10, 22, 3, 0, 0);
await C.tick(quietSettings, morning);
// no coach.json should be created because tick returned early.
const coachFile = path.join(TMP, 'Roamies', 'Data', 'coach.json');
assert.equal(fs.existsSync(coachFile), false, 'quiet tick writes nothing');

// rollover fires once per day even when tick is called repeatedly.
const settings = { quietHours: { on: false, start: '00:30', end: '08:00' }, rollover: '15:00', escalate: false };
const now = new Date(2026, 10, 22, 16, 0, 0);
await C.tick(settings, now);
assert.equal(fs.existsSync(coachFile), true);
const first = JSON.parse(fs.readFileSync(coachFile, 'utf8'));
assert.equal(first.roll, C.dayKey(now));
await C.tick(settings, new Date(2026, 10, 22, 17, 0, 0));
const second = JSON.parse(fs.readFileSync(coachFile, 'utf8'));
assert.equal(second.roll, first.roll, 'rollover does not repeat the same day');

// escalation deduplication: a due-tonight task escalates to the current step only once.
const task = await P.add({ title: 'Quiz 13.2 tonight', kind: 'task', start: new Date(2026, 10, 22, 23, 0).getTime() }, now.getTime());
const escSettings = { quietHours: { on: false, start: '00:30', end: '08:00' }, rollover: '00:00', escalate: true, speakReplies: 'off' };
const evening = new Date(2026, 10, 22, 18, 30, 0);
await C.tick(escSettings, evening);
const st1 = JSON.parse(fs.readFileSync(coachFile, 'utf8'));
const key = `${C.dayKey(evening)}|${task.id}`;
assert.ok(st1.esc && st1.esc[key] >= 1, 'escalation recorded');
const before = { ...st1.esc };
await C.tick(escSettings, new Date(2026, 10, 22, 19, 0, 0));
const st2 = JSON.parse(fs.readFileSync(coachFile, 'utf8'));
assert.equal(st2.esc[key], before[key], 'escalation step not re-run for same step');
await C.tick(escSettings, new Date(2026, 10, 22, 23, 30, 0));
assert.deepEqual(P.list({ kind: 'event' }), [], 'late reminders never create calendar events');

// real planner/timelog data flow into the week brief.
const t0 = Date.UTC(2026, 10, 16, 9, 0);
await T.append({ itemId: task.id, title: task.title, start: t0, end: t0 + 30 * 60_000, minutes: 30 });
const md = C.weekMarkdown(new Date(2026, 10, 22, 10, 0, 0));
assert.match(md, /Your week/);
assert.match(md, /Tasks/);

// morning brief reads planner occurrences.
const ev = await P.add({ title: 'Standup', kind: 'event', start: new Date(2026, 10, 22, 9, 0).getTime(), end: new Date(2026, 10, 22, 9, 30).getTime() }, now.getTime());
const brief = C.morningBrief(new Date(2026, 10, 22, 8, 0, 0));
assert.match(brief, /Standup/);

// deduplication: nudge.Show replaces same key.
N.Show('coach-roll', 'first', 'a');
N.Show('coach-roll', 'second', 'b');
const rows = N.Rows();
const matches = rows.filter((r) => r.primary === 'second');
assert.equal(matches.length, 1, 'same key replaced, not duplicated');

// dueTonight helper.
assert.equal(C.dueTonight(task, evening), true);

console.log('coach tests: passed');
