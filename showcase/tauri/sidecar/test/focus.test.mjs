// Focus mode: what counts as a distraction, when a nudge comes, and what gets logged when a block ends. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-focus-test-'));
process.env.HOME = TMP; process.env.USERPROFILE = TMP; process.env.ROAMIES_DATA_DIR = TMP;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
import { DEFAULT_DISTRACTIONS, check, distraction, endBlock, focusedMinutes, parseDistractions, startBlock, NUDGE_GAP_MS } from '../focus.mjs';

const L = DEFAULT_DISTRACTIONS;
assert.equal(distraction({ app: 'Google Chrome', title: 'Lo-fi beats - YouTube', url: 'https://www.youtube.com/watch?v=1' }, L), 'youtube.com');
assert.equal(distraction({ app: 'Safari', title: 'Watch', url: 'https://m.youtube.com/' }, L), 'youtube.com', 'subdomain');
assert.equal(distraction({ app: 'Firefox', title: 'Lo-fi beats – YouTube — Mozilla Firefox' }, L), 'YouTube', 'by title when no address');
assert.equal(distraction({ app: 'Arc', title: 'r/gaming', url: 'https://old.reddit.com/r/gaming' }, L), 'reddit.com');
assert.equal(distraction({ app: 'Steam', title: 'Steam' }, L), 'Steam');
assert.equal(distraction({ app: 'steamwebhelper', title: 'Library' }, L), 'Steam', 'app name contains it');
assert.equal(distraction({ app: 'Minecraft Launcher', title: 'Minecraft' }, L), 'Minecraft');
assert.equal(distraction({ app: 'Code', title: 'focus.mjs — Roamies' }, L), null, 'work is fine');
assert.equal(distraction({ app: 'Chrome', title: 'youtube-dl docs', url: 'https://github.com/ytdl-org/youtube-dl' }, L), null, 'an address, not the word');
assert.equal(distraction({ app: 'Chrome', title: 'Docs', url: 'https://notyoutube.com/' }, L), null, 'not a lookalike domain');
assert.equal(distraction({ app: 'Chrome', title: 'Reading about Steampunk', url: 'https://en.wikipedia.org/wiki/Steampunk' }, L), null, 'whole words in titles');
assert.equal(distraction({ app: 'Roamies', title: 'YouTube' }, L), null, 'never Roamies itself');
assert.equal(distraction(null, L), null);
assert.equal(distraction({ app: 'Discord', title: 'General' }, L), 'Discord', 'Discord the app');
assert.equal(distraction({ app: 'discord-helper', title: 'Voice' }, L), 'Discord', 'app name contains it');
assert.equal(distraction({ app: 'Chrome', title: 'Chat', url: 'https://discord.com/app' }, L), 'discord.com', 'Discord the site');
assert.equal(distraction({ app: 'Chrome', title: 'Chat', url: 'https://discord.com.evil.test/' }, L), null, 'not a lookalike domain');

assert.deepEqual(parseDistractions('https://www.chess.com/play, Steam;  news.ycombinator.com/item?id=1\nsteam, x'),
  ['chess.com', 'Steam', 'news.ycombinator.com'], 'cleaned, deduplicated, too-short dropped');
assert.deepEqual(parseDistractions(''), []);
assert.equal(distraction({ app: 'Chrome', title: 'Play', url: 'https://www.chess.com/play' }, parseDistractions('chess.com')), 'chess.com');

const t0 = 1_000_000;
const b = startBlock(45, ' the slides ', t0);
assert.equal(b.minutes, 45); assert.equal(b.task, 'the slides'); assert.equal(b.until, t0 + 45 * 60_000);
assert.equal(startBlock(1).minutes, 5, 'at least 5 minutes');
assert.equal(startBlock(999).minutes, 240, 'at most 4 hours');
assert.equal(startBlock('x').minutes, 25, 'unreadable: 25');

const yt = { app: 'Chrome', title: 'x - YouTube', url: 'https://youtube.com/' }, work = { app: 'Keynote', title: 'Slides' };
assert.deepEqual(check(b, yt, L, t0 + 1000), {}, 'a glance');
assert.deepEqual(check(b, work, L, t0 + 21000), {}, 'back to work');
assert.deepEqual(check(b, yt, L, t0 + 41000), {});
assert.deepEqual(check(b, yt, L, t0 + 61000), { nudge: 'youtube.com' }, 'stayed: nudge');
assert.deepEqual(check(b, yt, L, t0 + 81000), {}, 'not again right away');
assert.deepEqual(check(b, yt, L, t0 + 61000 + NUDGE_GAP_MS), { nudge: 'youtube.com' }, 'again after the gap');
assert.equal(b.drifts, 2, 'two separate drifts counted');
assert.deepEqual(check(b, work, L, t0 + 45 * 60_000), { end: true }, 'time up');

// Ending a block: the minutes actually focused are logged, and added to the planner task when there is one.
assert.equal(focusedMinutes({ startedAt: t0 }, t0), 0, 'no time passed');
assert.equal(focusedMinutes({ startedAt: t0 }, t0 + 20_000), 1, 'any time counts as a minute');
assert.equal(focusedMinutes({ startedAt: t0 }, t0 + 90_000), 2, 'rounded');
const tied = startBlock(25, ' the slides ', t0, 'task-1');
assert.equal(tied.itemId, 'task-1');
assert.deepEqual(endBlock(tied, t0 + 125_000), { itemId: 'task-1', title: 'the slides', start: t0, end: t0 + 125_000, minutes: 2 });
assert.deepEqual(endBlock(b, t0), { itemId: null, title: 'the slides', start: t0, end: t0, minutes: 0 }, 'no id: no task to credit');

const planner = await import('../planner.mjs');
const task = await planner.add({ kind: 'task', title: 'Slides', est: 30, spent: 1 });
await planner.addSpent(task.id, endBlock(tied, t0 + 125_000).minutes);
assert.equal(planner.get(task.id).spent, 3, 'spent minutes added on stop');
await planner.addSpent(task.id, 0);
assert.equal(planner.get(task.id).spent, 3, 'zero minutes leaves spent alone');
assert.equal(await planner.addSpent('no-such-id', 5), null, 'unknown task is left alone');

// The agent's start_focus tool passes the optional planner id through to the block.
const started = [];
const { createTools } = await import('../tools.mjs');
const { tools } = createTools({
  allowActions: false, ui: () => {}, ask: async () => false, openUrl: async () => {}, onCommitments: () => {},
  showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test',
  focus: { start: (...args) => { started.push(args); return 'ok'; }, stop: () => 'ok' },
  jobs: { changed: () => {}, run: async () => ({ id: 'a1' }) }, skills: { changed: () => {} },
});
const startTool = tools.find((t) => t.name === 'start_focus');
await startTool.execute({ minutes: 10, task: 'Slides', itemId: task.id });
assert.deepEqual(started.at(-1), [10, 'Slides', task.id], 'itemId reaches startFocus');
await startTool.execute({ minutes: 10, task: 'Slides', id: task.id });
assert.deepEqual(started.at(-1), [10, 'Slides', task.id], 'id alias works too');
await startTool.execute({ minutes: 10, task: 'Slides' });
assert.deepEqual(started.at(-1), [10, 'Slides', ''], 'no id keeps the old behaviour');

// time_log reads those totals back without writing anything.
const timelog = await import('../timelog.mjs');
const now = Date.now();
await timelog.append({ itemId: task.id, title: 'Slides', start: now - 60_000, end: now, minutes: 7 });
const logTool = tools.find((t) => t.name === 'time_log');
const logText = await logTool.execute({ from: 'today', to: 'tomorrow' });
assert.match(logText, /Focus time: 7 minutes total/);
assert.ok(logText.includes(task.id), 'the planner task is named in the totals');

const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
assert.match(side, /await planner\.addSpent\(entry\.itemId, entry\.minutes/, 'stopFocus credits the planner task');
assert.match(side, /await appendTimeLog\(entry\)/, 'every ended block is logged');

console.log('focus tests: passed');
