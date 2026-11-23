// Simple requests answered on this PC with no model call: what is matched, what falls through to the model, and
// what doing it touches (a scratch store, a stubbed opener). Nothing here opens an app or a site. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-quick-test-'));
process.env.ROAMIES_DATA_DIR = TMP; process.env.HOME = TMP; process.env.USERPROFILE = TMP;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const { match, run, quick, checkTarget } = await import('../quick.mjs');
const S = await import('../store.mjs');
assert.ok(S.DIR.startsWith(TMP), 'the store must live in the scratch folder: ' + S.DIR);

// Sunday 22 November 2026, 3:42 pm local.
const NOW = new Date(2026, 10, 22, 15, 42, 0);
const HOME = path.join(TMP, 'home');
const m = (text, over = {}) => match(text, { now: NOW, home: HOME, platform: 'win32', ...over });
const failures = [];
const expect = (text, kind, reply) => {
  const got = m(text);
  if (got?.kind !== kind) return failures.push(`${JSON.stringify(text)} → ${got ? got.kind : 'null'}, wanted ${kind}`);
  if (reply instanceof RegExp ? !reply.test(got.reply) : reply !== undefined && got.reply !== reply) failures.push(`${JSON.stringify(text)} → reply ${JSON.stringify(got.reply)}, wanted ${reply}`);
};

// ---------- time, date, day ----------
for (const t of ['what time is it', 'What time is it?', "what's the time", 'whats the time', 'can you please tell me the time', 'hey what time is it right now', 'what is the current time', 'the time please']) expect(t, 'time', "It's 3:42 PM.");
for (const t of ["what's the date", 'whats the date today', "what's today's date", 'what is the date', 'what date is it', 'tell me the date please']) expect(t, 'date', 'Today is Sunday, November 22, 2026.');
for (const t of ['what day is it', 'what day is it today', 'what day of the week is it', "what's the day", 'which day is it']) expect(t, 'day', "It's Sunday.");

// ---------- maths ----------
for (const [t, r] of [
  ["what's 15% of 80", '15% of 80 is 12.'], ['what is 15 percent of 80', '15% of 80 is 12.'], ['12 times 7', '12 times 7 is 84.'], ['what is 12 x 7', /is 84\.$/],
  ['square root of 144', 'Square root of 144 is 12.'], ["what's the square root of 81", /is 9\.$/], ['what is 2 plus 2', /is 4\.$/], ['100 divided by 8', /is 12\.5\.$/],
  ['15 minus 20', /is -5\.$/], ['2 to the power of 10', /is 1,024\.$/], ['9 squared', /is 81\.$/], ['(3 + 4) * 5', /is 35\.$/], ['calculate 10 / 4', /is 2\.5\.$/],
  ['twelve times seven', /is 84\.$/], ['what is 1,000 plus 250', /is 1,250\.$/], ['0.1 + 0.2', /is 0\.3\.$/], ['what is 2 + 3 * 4', /is 14\.$/], ['what is 2 ^ 3 ^ 2', /is 512\.$/],
]) expect(t, 'math', r);
// A sum that can't be worked out (or isn't one) is the model's.
for (const t of ['1 / 0', 'what is 5 plus', 'what is 3 over there', '2 ** 5000', 'process.exit(1)', 'what is (2 + 3', 'what is 5 times apples', '5', "what's 5"]) assert.equal(m(t), null, `not maths: ${t}`);

// ---------- unit conversions ----------
for (const [t, r] of [
  ['5 miles in km', '5 miles is 8.04672 kilometers.'], ['convert 5 miles to kilometers', /is 8\.04672 kilometers\./], ['70 f to c', /^70 degrees Fahrenheit is 21\.1111\d* degrees Celsius\.$/],
  ['what is 100 celsius in fahrenheit', '100 degrees Celsius is 212 degrees Fahrenheit.'], ['10 kg to lbs', /^10 kilograms is 22\.0462\d* pounds\.$/], ['how many km in a mile', '1 mile is 1.609344 kilometers.'],
  ['2 liters in cups', /^2 liters is 8\.4535\d* cups\.$/], ['how many feet are in 2 miles', '2 miles is 10,560 feet.'], ['-40 c to f', '-40 degrees Celsius is -40 degrees Fahrenheit.'],
  ["what's 6 feet in cm", /is 182\.88 centimeters\.$/], ['32 oz in grams', /is 907\.18/], ['1 gallon to liters', /is 3\.78541\d liters\.$/], ['300 k to c', /is 26\.85 degrees Celsius\.$/],
]) expect(t, 'convert', r);
for (const t of ['5 miles in pounds', '5 pounds to dollars', '5 apples in km', 'convert 5 miles', '5 km']) assert.equal(m(t), null, `not a conversion: ${t}`);

// ---------- timers ----------
for (const [t, secs] of [['set a timer for 10 minutes', 600], ['timer 90 seconds', 90], ['set a 5 minute timer', 300], ['please set a timer for ten minutes', 600], ['start a timer for 1 hour 30 minutes', 5400],
  ['timer for an hour', 3600], ['10 minute timer', 600], ['set a timer for half an hour', 1800], ['timer for 2 hours', 7200], ['set a timer for 45 seconds', 45]]) {
  const got = m(t);
  if (got?.kind !== 'timer' || got.args.secs !== secs) failures.push(`${t} → ${JSON.stringify(got)}, wanted a ${secs} s timer`);
}
assert.equal(m('set a timer for 10 minutes').reply, 'Timer set for 10 minutes.');
for (const t of ['set a timer', 'timer for 5', 'set a timer for 3 days', 'kitchen timer', 'set a timer for soon']) assert.equal(m(t), null, `not a timer: ${t}`);

// ---------- reminders ----------
const rem = (t) => m(t)?.kind === 'reminder' ? m(t) : null;
const at = (h, mi = 0, dayOffset = 0) => new Date(2026, 10, 22 + dayOffset, h, mi).getTime();
for (const [t, text, due, reply] of [
  ['remind me in 20 minutes to call mum', 'call mum', NOW.getTime() + 20 * 6e4, "Okay, I'll remind you to call mum in 20 minutes."],
  ['remind me to call mum in 20 minutes', 'call mum', NOW.getTime() + 20 * 6e4],
  ['Remind me in an hour to take the pasta off', 'take the pasta off', NOW.getTime() + 36e5],
  ['remind me in twenty minutes to stretch', 'stretch', NOW.getTime() + 20 * 6e4],
  ['remind me at 5pm to call Sam', 'call Sam', at(17), "Okay, I'll remind you to call Sam at 5:00 PM."],
  ['remind me at 5:30 pm to feed the cat', 'feed the cat', at(17, 30)],
  ['remind me to feed the cat at 17:30', 'feed the cat', at(17, 30)],
  ['remind me to email the team at 9am', 'email the team', at(9, 0, 1), "Okay, I'll remind you to email the team tomorrow at 9:00 AM."],
  ['remind me tomorrow at 9 to pay rent', 'pay rent', at(9, 0, 1), "Okay, I'll remind you to pay rent tomorrow at 9:00 AM."],
  ['remind me to pay rent tomorrow at 9', 'pay rent', at(9, 0, 1)],
  ['remind me tonight at 8 to take the bins out', 'take the bins out', at(20)],
  ['remind me at 6 to start dinner', 'start dinner', at(18)],
  ['remind me on friday at 3pm to send the invoice', 'send the invoice', at(15, 0, 5), "Okay, I'll remind you to send the invoice on Friday at 3:00 PM."],
  ['remind me at noon to eat lunch', 'eat lunch', at(12, 0, 1)],
  ['set a reminder to water the plants at 7pm', 'water the plants', at(19)],
  ['set a reminder for in 10 minutes to check the oven', 'check the oven', NOW.getTime() + 10 * 6e4],
  ['can you remind me to watch the 7pm movie at 6pm', 'watch the 7pm movie', at(18)],
]) {
  const got = rem(t);
  if (!got) { failures.push(`${t} → not a reminder`); continue; }
  if (got.args.text !== text || got.args.dueMs !== due || got.args.repeat !== null) failures.push(`${t} → ${JSON.stringify(got.args)}, wanted ${text} at ${new Date(due)}`);
  if (reply && got.reply !== reply) failures.push(`${t} → reply ${got.reply}`);
}
for (const [t, spec, due] of [['remind me every day at 9am to take my vitamins', 'daily', at(9, 0, 1)], ['remind me every weekday at 8 to stretch', 'weekdays', at(8, 0, 1)], ['remind me every monday at 9am to plan the week', 'mon', at(9, 0, 1)]]) {
  const got = rem(t);
  if (got?.args.repeat !== spec || got.args.dueMs !== due) failures.push(`${t} → ${JSON.stringify(got?.args)}, wanted repeat ${spec}`);
}
assert.equal(m('remind me every weekday at 8 to stretch').reply, "Okay, I'll remind you to stretch every weekday at 8:00 AM.");
for (const t of ['remind me about the thing', 'remind me to call mum', 'remind me later to call mum', 'remind me in 20 minutes', 'remind me in 20 minutes to', 'remind me in 20 minutes to it', 'remind me in a while to call mum',
  'remind me to buy milk 2', 'remind me at 25 to leave', 'remind me at 5pm about the meeting', 'remind me tomorrow to call mum', 'remind me today at 3pm to call mum']) assert.equal(m(t), null, `not a clear reminder: ${t}`);

// ---------- the list ----------
for (const t of ['show my list', "what's on my list", 'what is on my to-do list', 'show me my reminders', 'open my list', 'what are my reminders']) expect(t, 'list', "Here's your list.");

// ---------- opening things and searching ----------
const op = (t) => { const g = m(t); return g?.kind === 'open' ? g.args : null; };
for (const [t, type, target] of [
  ['open spotify', 'app', 'spotify'], ['Open Spotify please', 'app', 'Spotify'], ['can you open visual studio code', 'app', 'visual studio code'], ['launch discord', 'app', 'discord'], ['fire up steam', 'app', 'steam'],
  ['open the calculator', 'app', 'calculator'], ['open youtube.com', 'url', 'https://youtube.com'], ['open skool dot com', 'url', 'https://skool.com/'], ['go to you tube dot com slash shorts', 'url', 'https://youtube.com/shorts'], ['open w w w dot bbc dot co dot uk', 'url', 'https://www.bbc.co.uk/'], ['open youtube', 'url', 'https://www.youtube.com'], ['go to github.com', 'url', 'https://github.com'],
  ['open https://example.com/docs', 'url', 'https://example.com/docs'], ['open www.bbc.co.uk/news', 'url', 'https://www.bbc.co.uk/news'], ['open gmail', 'url', 'https://mail.google.com'],
  ['open my downloads folder', 'path', path.join(HOME, 'Downloads')], ['open the documents folder', 'path', path.join(HOME, 'Documents')], ['open downloads', 'path', path.join(HOME, 'Downloads')],
  ['open my desktop folder', 'path', path.join(HOME, 'Desktop')], ['open ~/Notes', 'path', '~/Notes'],
]) {
  const got = op(t);
  if (!got || got.type !== type || got.target !== target) failures.push(`${t} → ${JSON.stringify(got)}, wanted ${type} ${target}`);
}
assert.equal(match('open my videos folder', { now: NOW, home: HOME, platform: 'darwin' }).args.target, path.join(HOME, 'Movies'));
for (const [t, target, reply] of [
  ['search for cats', 'https://www.google.com/search?q=cats', 'Searching for cats.'], ['google best pizza in chicago', 'https://www.google.com/search?q=best%20pizza%20in%20chicago'],
  ['look up the weather in Paris', 'https://www.google.com/search?q=the%20weather%20in%20Paris'], ['look up funny cats on youtube', 'https://www.youtube.com/results?search_query=funny%20cats', 'Searching youtube for funny cats.'],
  ['search youtube for lo-fi beats', 'https://www.youtube.com/results?search_query=lo-fi%20beats'], ['can you search for node streams docs', 'https://www.google.com/search?q=node%20streams%20docs'],
  ['search for a desk lamp on amazon', 'https://www.amazon.com/s?k=a%20desk%20lamp'], ['search up how to tie a tie', 'https://www.google.com/search?q=how%20to%20tie%20a%20tie'],
  ['google "a&b" test', 'https://www.google.com/search?q=%22a%26b%22%20test'],
]) {
  const got = m(t);
  if (got?.kind !== 'search' || got.args.target !== target) failures.push(`${t} → ${JSON.stringify(got)}, wanted ${target}`);
  else if (reply && got.reply !== reply) failures.push(`${t} → reply ${got.reply}`);
}

// ---------- not sure: the model gets these ----------
const FALL = [
  'open the file I was working on', 'open it', 'open that', 'open a new tab', 'open my project folder', 'open the last email', 'open notepad.exe', 'open setup.exe', 'open the door and turn on the lights',
  'remind me about the thing', 'remind me to call mum', 'what is the capital of France', 'who won the world cup in 2018', 'how are you', 'tell me a joke', 'what time is it in Tokyo',
  'what is the date of the French revolution', 'what day was I born', 'search for the file I was working on', 'search my computer for taxes', 'look up at the sky', 'google is a big company',
  'search results look wrong', 'set an alarm for 7am', 'set a timer', 'convert this file to pdf', 'what is 5 in binary', 'what is photosynthesis', 'summarize my last email', 'play some jazz',
  'turn the volume up', 'mute', 'pause the music', 'next song', 'show me the list of files in downloads', 'what is on my screen', 'go to sleep', 'open and read it', 'search', 'timer',
  '', '   ', '(System, not the user: a reminder is due)', 'hello', 'yes', 'thanks',
];
for (const t of FALL) if (m(t) !== null) failures.push(`should go to the model: ${JSON.stringify(t)} → ${JSON.stringify(m(t))}`);
assert.ok(FALL.length >= 15);

assert.deepEqual(failures, [], `\n${failures.join('\n')}`);

// ---------- the open path goes through the safety checks ----------
const folder = fs.mkdirSync(path.join(HOME, 'Downloads'), { recursive: true }) && path.join(HOME, 'Downloads');
const dir = { isFile: () => false, mode: 0o755 };
const file = (mode) => ({ isFile: () => true, mode });
const deps = (over = {}) => {
  const d = { said: [], opened: [], listed: 0, reminded: [] };
  return Object.assign(d, {
    home: HOME, say: (l) => d.said.push(l), open: async (t, type) => { d.opened.push([t, type]); return true; }, stat: async () => dir,
    showList: () => { d.listed++; }, onReminder: (c) => d.reminded.push(c),
  }, over);
};
{
  const d = deps();
  assert.equal(await quick('open my downloads folder', { ...d, now: NOW }), true);
  assert.deepEqual(d.opened, [[folder, 'path']]); assert.deepEqual(d.said, ['Opening your downloads folder.']);
}
{
  const d = deps();
  assert.equal(await quick('open youtube.com', { ...d, now: NOW }), true);
  assert.deepEqual(d.opened, [['https://youtube.com', 'url']]);
}
{
  const d = deps();
  assert.equal(await quick('look up cats on youtube', { ...d, now: NOW }), true);
  assert.deepEqual(d.opened, [['https://www.youtube.com/results?search_query=cats', 'url']]);
}
{
  // A refused target is refused: said, never opened, and not handed on to the model.
  for (const target of ['~/.ssh', '~/.ssh/id_rsa', path.join(HOME, '.aws', 'credentials'), 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com/x', 'ssh-keys/../x', 'C:\\Windows\\System32\\cmd.exe', '/etc/passwd']) {
    const d = deps();
    const type = /^[~/]|^[a-z]:\\/i.test(target) ? 'path' : /:/.test(target) ? 'url' : 'app';
    const ok = await run({ kind: 'open', args: { target, type, label: target }, reply: 'Opening.' }, d);
    assert.equal(d.opened.length, 0, `${target} must not be opened`);
    assert.equal(ok, true, `${target}: the refusal is the answer`);
    assert.ok(d.said.length === 1 && d.said[0] !== 'Opening.', `${target}: says why: ${d.said}`);
  }
  assert.equal(checkTarget('~/.ssh', HOME).level, 'block');
  assert.equal(checkTarget('https://user:pw@example.com/', HOME).level, 'block', 'a link with a password in it');
  assert.equal(checkTarget('example.com', HOME).target, 'https://example.com', 'a bare address is a link, as in the open tool');
  assert.equal(checkTarget('Notes', HOME).level, 'safe');
  // A program that would run is refused even from a folder-looking request.
  const d = deps({ stat: async () => file(0o755) });
  assert.equal(await run({ kind: 'open', args: { target: path.join(HOME, 'tool'), type: 'path', label: 'it' }, reply: 'Opening.' }, d), true);
  assert.equal(d.opened.length, 0);
  // Typed paths in the request itself get the same treatment.
  const e = deps();
  assert.equal(await quick('open ~/.ssh', { ...e, now: NOW }), true);
  assert.equal(e.opened.length, 0);
}
{
  // Not there, or the opener fails: no answer given here, so the model gets the turn.
  const none = deps({ stat: async () => null });
  assert.equal(await quick('open ~/Notes', { ...none, now: NOW }), false);
  assert.deepEqual([none.opened.length, none.said.length], [0, 0]);
  const fails = deps({ open: async () => false });
  assert.equal(await quick('open spotify', { ...fails, now: NOW }), false);
  assert.equal(fails.said.length, 0);
  assert.equal(await quick('open spotify', { now: NOW }), false, 'no opener, no answer');
}
{
  // Answered here: said once, nothing else touched.
  const d = deps();
  assert.equal(await quick('what time is it', { ...d, now: NOW }), true);
  assert.deepEqual(d.said, ["It's 3:42 PM."]); assert.equal(d.opened.length, 0);
  assert.equal(await quick('12 times 7', { ...d, now: NOW }), true); assert.equal(d.said.at(-1), '12 times 7 is 84.');
  assert.equal(await quick('show my list', { ...d, now: NOW }), true); assert.equal(d.listed, 1);
  const n = deps();
  assert.equal(await quick('what is the capital of France', { ...n, now: NOW }), false);
  assert.equal(n.said.length, 0);
}

// ---------- reminders and timers land in the store ----------
{
  const d = deps();
  assert.equal(S.openCommitments().length, 0);
  const t0 = Date.now();
  assert.equal(await quick('set a timer for 10 minutes', d), true);
  assert.equal(await quick('remind me in 20 minutes to call mum', d), true);
  assert.equal(await quick('remind me every weekday at 8 to stretch', d), true);
  const all = S.openCommitments();
  assert.equal(all.length, 3);
  const timer = all.find((c) => /timer/.test(c.text)), call = all.find((c) => c.text === 'call mum'), stretch = all.find((c) => c.text === 'stretch');
  assert.equal(timer.kind, 'reminder'); assert.ok(Math.abs(timer.due - (t0 + 600_000)) < 5000, 'timer due in 10 minutes');
  assert.equal(call.kind, 'reminder'); assert.ok(Math.abs(call.due - (t0 + 20 * 6e4)) < 5000, 'reminder due in 20 minutes');
  assert.equal(stretch.repeat, 'weekdays'); assert.ok(stretch.due > t0);
  assert.equal(d.reminded.length, 3, 'the app is told so it can schedule them');
  assert.deepEqual(d.said, ['Timer set for 10 minutes.', "Okay, I'll remind you to call mum in 20 minutes.", "Okay, I'll remind you to stretch every weekday at 8:00 AM."]);
  await S.flushWrites();
  assert.ok(fs.readFileSync(path.join(S.DIR, 'memory.json'), 'utf8').includes('call mum'), 'saved to the scratch folder');
}

console.log('quick commands tests: passed');
