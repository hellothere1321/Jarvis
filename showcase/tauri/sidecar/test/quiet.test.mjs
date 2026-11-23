// Quiet hours: the daily window when alerts stay on screen but speech and focus nudges wait. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-quiet-test-'));
process.env.HOME = TMP; process.env.USERPROFILE = TMP; process.env.ROAMIES_DATA_DIR = TMP;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const { DEFAULT_QUIET, isQuiet, timeMinutes } = await import('../quiet.mjs');

assert.deepEqual(DEFAULT_QUIET, { on: true, start: '00:30', end: '08:00' }, 'the default is stored in config.quietHours');
const at = (hour, minute = 0) => new Date(2026, 0, 12, hour, minute, 0);
const night = { on: true, start: '22:00', end: '06:00' };

assert.equal(timeMinutes('22:00'), 1320);
assert.equal(timeMinutes('9:00'), null, 'HH:MM needs two digits');
assert.equal(timeMinutes('24:00'), null);
assert.equal(timeMinutes('12:60'), null);
assert.equal(timeMinutes(900), null);

assert.equal(isQuiet(at(21, 59), night), false);
assert.equal(isQuiet(at(22, 0), night), true, 'start inclusive');
assert.equal(isQuiet(at(1, 30), night), true, 'midnight wrap');
assert.equal(isQuiet(at(5, 59), night), true);
assert.equal(isQuiet(at(6, 0), night), false, 'end exclusive');
assert.equal(isQuiet(at(12, 0), night), false);
assert.equal(isQuiet(at(0, 30)), true, 'the default starts at 00:30');
assert.equal(isQuiet(at(8, 0)), false, 'the default ends at 08:00');

assert.equal(isQuiet(at(9, 0), { ...night, start: '09:00', end: '09:00' }), false, 'start == end is never quiet');
assert.equal(isQuiet(at(23, 0), { ...night, start: '09:00', end: '09:00' }), false);
assert.equal(isQuiet(at(23, 0), { ...night, on: false }), false, 'off');
for (const bad of ['9:00', '25:00', '12:60', '', null, undefined, 900]) {
  assert.equal(isQuiet(at(23, 0), { on: true, start: bad, end: '06:00' }), false, `bad start ${bad}`);
  assert.equal(isQuiet(at(23, 0), { on: true, start: '22:00', end: bad }), false, `bad end ${bad}`);
}
assert.equal(isQuiet(at(23, 0), null), false, 'bad config');
assert.equal(isQuiet(new Date('not a date'), night), false, 'bad date');
assert.equal(isQuiet(at(23, 0).getTime(), night), true, 'epoch milliseconds work');

// The gates in sidekick.mjs: no focus nudge and no voice during quiet hours.
const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
assert.match(side, /r\.nudge && !quietNow\(\)/, 'focus drift nudges skip quiet hours');
assert.match(side, /const silent = quietNow\(\);/, 'quiet gates the reminder turn');
assert.match(side, /listenAfter: due\.length > 0 && snoozeListenOn\(\) && !silent, silent/, 'reminders and alerts keep their text but lose their voice');
assert.match(side, /!silent && VOICE_ON\(\) \? speech\.start\(\)/, 'silent turns gate speech.start');
assert.match(side, /quietHours: \{ \.\.\.DEFAULT_QUIET \}/, 'config.quietHours defaults to the nightly window');

console.log('quiet tests: passed');
