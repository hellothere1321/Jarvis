import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-plannerview-test-'));
process.env.ROAMIES_DATA_DIR = scratch;
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
const P = await import('../planner.mjs');
const S = await import('../store.mjs');
const V = await import('../plannerview.mjs');
const file = path.join(scratch, 'Roamies', 'Data', 'planner.json');
const reset = () => S.writeJson(file, []);
const at = (month, day, hour = 0, minute = 0) => +new Date(2026, month - 1, day, hour, minute);
const ids = (rows) => rows.map((r) => r.title);
const now = at(11, 4, 10); // a Wednesday

// An empty planner is an empty page.
await reset();
let view = V.plannerView(now);
assert.equal(view.error, null);
assert.deepEqual([view.today.overdue, view.today.tasks, view.today.events, view.today.timers, view.today.reminders, view.upcoming, view.lists], [[], [], [], [], [], [], []]);
assert.equal(view.week.days.length, 7);
assert.equal(view.overdue, 0);

// Today: overdue apart from today's tasks, events in time order (all-day first), done-today kept, reminders read-only.
await P.add({ title: 'Late essay', start: at(11, 2), priority: 1 }, now);
await P.add({ title: 'Low task', start: at(11, 4), priority: 1 }, now);
await P.add({ title: 'High task', start: at(11, 4), priority: 3 }, now);
await P.add({ title: 'No date', cat: 'Home' }, now);
await P.add({ title: 'Tomorrow task', start: at(11, 5) }, now);
const finished = await P.add({ title: 'Finished', start: at(11, 4) }, now);
await P.complete(finished.id, now);
const old = await P.add({ title: 'Finished last week', start: at(10, 28) }, now);
await P.complete(old.id, at(10, 29));
await P.add({ kind: 'event', title: 'Afternoon', start: at(11, 4, 14), end: at(11, 4, 15) }, now);
await P.add({ kind: 'event', title: 'Morning', start: at(11, 4, 9), end: at(11, 4, 10) }, now);
await P.add({ kind: 'event', title: 'Holiday', start: at(11, 4), allDay: true }, now);
await P.add({ kind: 'event', title: 'Tomorrow event', start: at(11, 5, 9), end: at(11, 5, 10) }, now);
const reminders = [
  { id: 'r1', text: 'Call back', due: at(11, 4, 16) }, { id: 'r2', text: 'Missed one', due: at(11, 3, 9) },
  { id: 'r3', text: 'Next week', due: at(11, 11, 9) }, { id: 'r4', text: 'Whenever', due: null },
];
view = V.plannerView(now, { reminders });
assert.deepEqual(ids(view.today.overdue), ['Late essay']);
assert.equal(view.today.overdue[0].overdue, true);
assert.equal(view.overdue, 1);
assert.deepEqual(ids(view.today.tasks), ['High task', 'Low task', 'Finished']);
assert.equal(view.today.tasks.find((r) => r.title === 'Finished').done, true);
assert.deepEqual(ids(view.today.events), ['Holiday', 'Morning', 'Afternoon']);
assert.deepEqual(view.today.reminders.map((r) => [r.id, r.overdue]), [['r2', true], ['r1', false]]);
assert.deepEqual(Object.keys(view.today.reminders[0]).sort(), ['due', 'id', 'overdue', 'text']);

// Only active timers show in the timers section, including countdowns that end tomorrow.
const timerView = V.plannerView(now, { reminders: [
  { id: 't1', kind: 'timer', text: '10 minute timer', due: at(11, 4, 12, 58) },
  { id: 't2', kind: 'timer', text: 'Fired timer', due: at(11, 4, 13, 30), status: 'done' },
  { id: 't3', kind: 'timer', text: 'Done timer', due: at(11, 4, 13, 45), done: true },
  { id: 't4', kind: 'timer', text: 'Old timer', due: at(11, 3, 9) },
  { id: 't5', kind: 'timer', text: 'Tomorrow timer', due: at(11, 5, 1) },
  { id: 'r5', text: 'Call back', due: at(11, 4, 14) },
] });
assert.deepEqual(timerView.today.reminders.map((r) => r.id), ['r5']);
assert.deepEqual(timerView.today.timers, [
  { id: 't1', text: '10 minute timer', due: at(11, 4, 12, 58) },
  { id: 't5', text: 'Tomorrow timer', due: at(11, 5, 1) },
]);

// The same item as the page draws it, with the form's fields as the form shows them.
const afternoon = view.today.events.find((r) => r.title === 'Afternoon');
assert.equal(afternoon.form.date, '2026-11-04');
assert.equal(afternoon.form.time, '14:00');
assert.equal(afternoon.form.endTime, '15:00');
assert.equal(afternoon.form.kind, 'event');
assert.equal(view.today.events[0].form.allDay, true);
assert.equal(view.today.events[0].form.endDate, '2026-11-04');
assert.equal(view.today.tasks[0].form.time, '');

// Upcoming: the next 14 days from tomorrow, only days with something, in order.
assert.deepEqual(view.upcoming.map((d) => [d.day, ids(d.items)]), [[at(11, 5), ['Tomorrow event', 'Tomorrow task']]]);

// Lists: every list with its open tasks and counts (case-insensitive), the unnamed one last, done tasks only counted.
await P.add({ title: 'Read', cat: 'home', start: at(11, 1) }, now);
await P.add({ title: 'Quiz', cat: 'School', priority: 2 }, now);
view = V.plannerView(now);
assert.deepEqual(view.lists.map((l) => [l.name.toLowerCase(), l.open, l.overdue, l.done]), [['home', 2, 1, 0], ['school', 1, 0, 0], ['', 4, 1, 2]]);
assert.deepEqual(ids(view.lists[0].items), ['Read', 'No date']);
assert.deepEqual(view.names.map((n) => n.toLowerCase()), ['home', 'school']);

// Upcoming across midnight and month end: now is late on Nov 28, so days run from Nov 29 to Dec 12.
await reset();
const late = at(11, 28, 23, 30);
await P.add({ kind: 'event', title: 'Overnight', start: at(11, 30, 23), end: at(12, 1, 1) }, late);
await P.add({ kind: 'event', title: 'Until midnight', start: at(11, 29, 22), end: at(11, 30) }, late);
await P.add({ title: 'First of December', start: at(12, 1) }, late);
await P.add({ title: 'Last day shown', start: at(12, 12) }, late);
await P.add({ title: 'One day too far', start: at(12, 13) }, late);
await P.add({ title: 'Already late', start: at(11, 27) }, late);
await P.add({ title: 'Today only', start: at(11, 28) }, late);
await P.add({ kind: 'event', title: 'Conference', start: at(11, 28), end: at(12, 2), allDay: true }, late);
view = V.plannerView(late);
assert.deepEqual(view.upcoming.map((d) => [dayName(d.day), ids(d.items)]), [
  ['Nov 29', ['Conference', 'Until midnight']],
  ['Nov 30', ['Conference', 'Overnight']],
  ['Dec 1', ['Conference', 'Overnight', 'First of December']],
  ['Dec 12', ['Last day shown']],
]);
assert.deepEqual(ids(view.today.overdue), ['Already late']);
assert.deepEqual(ids(view.today.tasks), ['Today only']);
assert.deepEqual(ids(view.today.events), ['Conference']);
function dayName(time) { return new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }

// The week: Monday to Sunday, previous and next weeks, multi-day events in each column they cover, done tasks kept.
await reset();
await P.add({ kind: 'event', title: 'Trip', start: at(11, 5), end: at(11, 8), allDay: true }, now);
await P.add({ title: 'Monday task', start: at(11, 2) }, now);
await P.add({ title: 'Sunday task', start: at(11, 8) }, now);
await P.add({ title: 'Next week task', start: at(11, 9) }, now);
const tick = await P.add({ title: 'Ticked', start: at(11, 3) }, now);
await P.complete(tick.id, now);
view = V.plannerView(now);
assert.equal(view.week.start, at(11, 2));
assert.equal(view.week.offset, 0);
assert.deepEqual(view.week.days.map((d) => dayName(d.day)), ['Nov 2', 'Nov 3', 'Nov 4', 'Nov 5', 'Nov 6', 'Nov 7', 'Nov 8']);
assert.deepEqual(view.week.days.map((d) => d.today), [false, false, true, false, false, false, false]);
assert.deepEqual(view.week.days.map((d) => ids(d.items)), [['Monday task'], ['Ticked'], [], ['Trip'], ['Trip'], ['Trip'], ['Sunday task']]);
view = V.plannerView(now, { week: 1 });
assert.equal(view.week.start, at(11, 9));
assert.equal(view.week.offset, 1);
assert.deepEqual(view.week.days.map((d) => ids(d.items)), [['Next week task'], [], [], [], [], [], []]);
assert.equal(V.plannerView(now, { week: -1 }).week.start, at(10, 26));
assert.equal(V.plannerView(now, { week: 'x' }).week.offset, 0);
assert.equal(V.clampWeek(1e9), 104);
assert.equal(V.clampWeek(1.5), 0);
assert.equal(V.clampWeek(500), 104);
assert.equal(V.clampWeek(-3), -3);
// A week that starts in one month and ends in the next.
assert.deepEqual(V.plannerView(at(12, 1, 12)).week.days.map((d) => dayName(d.day)), ['Nov 30', 'Dec 1', 'Dec 2', 'Dec 3', 'Dec 4', 'Dec 5', 'Dec 6']);

// Repeating items expand per occurrence, skips drop one, and the row's form edits the whole series.
await reset();
const standup = await P.add({ kind: 'event', title: 'Standup', start: at(11, 3, 9), end: at(11, 3, 9, 30), repeat: 'FREQ=WEEKLY' }, now);
const chore = await P.add({ title: 'Water plants', start: at(11, 4), repeat: 'FREQ=DAILY' }, now);
assert.equal((await V.act('skip', { id: standup.id, start: at(11, 10, 9) }, { now })).ok, true);
const weekOf = (n) => V.plannerView(now, { week: n }).week.days.flatMap((d) => d.items.filter((r) => r.kind === 'event').map((r) => dayName(d.day)));
assert.deepEqual([weekOf(0), weekOf(1), weekOf(2)], [['Nov 3'], [], ['Nov 17']]);
view = V.plannerView(at(11, 17, 8));
const occurrence = view.today.events[0];
assert.equal(occurrence.id, `${standup.id}@${at(11, 17, 9)}`);
assert.equal(occurrence.itemId, standup.id);
assert.equal(occurrence.series, true);
assert.equal(occurrence.repeat, 'Every Tuesday');
assert.equal(occurrence.form.date, '2026-11-03');
assert.equal(occurrence.form.time, '09:00');
assert.equal(occurrence.form.endTime, '09:30');
assert.equal(occurrence.form.repeat, 'Every Tuesday');
assert.equal(V.plannerView(now).today.tasks[0].repeat, 'Every day');
assert.equal(V.plannerView(now).today.tasks[0].id, chore.id);

// Quick add understands what it is told.
const q = (text, options) => V.parseQuick(text, now, options);
let parsed = q('math homework thursday');
assert.equal(parsed.ok, true);
assert.deepEqual([parsed.kind, parsed.title, parsed.start, parsed.end, parsed.repeat, parsed.cat, parsed.priority], ['task', 'math homework', at(11, 5), null, '', '', 0]);
parsed = q('dentist tue 3-4pm every 2 weeks');
assert.deepEqual([parsed.kind, parsed.title, parsed.start, parsed.end, parsed.allDay, parsed.repeat], ['event', 'dentist', at(11, 10, 15), at(11, 10, 16), false, 'Every other week on Tuesday']);
assert.equal(parsed.values.repeat, 'FREQ=WEEKLY;INTERVAL=2');
parsed = q('essay friday #school !!');
assert.deepEqual([parsed.kind, parsed.title, parsed.start, parsed.cat, parsed.priority], ['task', 'essay', at(11, 6), 'school', 2]);
parsed = q('call mom at 5pm');
assert.deepEqual([parsed.kind, parsed.title, parsed.start], ['event', 'call mom', at(11, 4, 17)]);
parsed = q('buy milk');
assert.deepEqual([parsed.ok, parsed.kind, parsed.start, parsed.title], [true, 'task', null, 'buy milk']);
parsed = q('gym every weekday');
assert.deepEqual([parsed.kind, parsed.start, parsed.repeat, parsed.values.repeat], ['task', at(11, 4), 'Every weekday', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR']);
parsed = q('gym 6am every weekday');
assert.deepEqual([parsed.kind, parsed.start], ['event', at(11, 5, 6)]);
parsed = q('pay rent every month on the 1st');
assert.deepEqual([parsed.kind, parsed.start, parsed.repeat], ['task', at(12, 1), 'Every month on the 1st']);
// The first date of a repeat is the first one that fits, and its end moves with it.
parsed = q('class every tuesday 10-11am');
assert.deepEqual([parsed.start, parsed.end], [at(11, 10, 10), at(11, 10, 11)]);
// A date alone is an event only when asked to be; a time alone is a task only when asked to be.
parsed = q('standup friday', { kind: 'event' });
assert.deepEqual([parsed.kind, parsed.allDay, parsed.start], ['event', true, at(11, 6)]);
parsed = q('task: call mom at 5pm');
assert.deepEqual([parsed.kind, parsed.title, parsed.start], ['task', 'call mom', at(11, 4)]);
parsed = q('event: standup friday');
assert.deepEqual([parsed.kind, parsed.allDay], ['event', true]);
// What can't be saved says why, and what's empty says nothing.
assert.deepEqual(q('tomorrow'), { ok: false, error: 'Add a title.' });
assert.equal(q('meeting', { kind: 'event' }).error, 'An event needs a date or time.');
assert.deepEqual(q('   '), { ok: false, empty: true, error: '' });
assert.equal('values' in V.preview('math homework thursday', now), false);
assert.equal(V.preview('math homework thursday', now).title, 'math homework');

// Actions call the planner. Quick add saves exactly what the preview said.
await reset();
let result = await V.act('add', { text: 'dentist tue 3-4pm every 2 weeks' }, { now });
assert.deepEqual([result.ok, result.note], [true, 'Added “dentist”.']);
const dentist = P.list()[0];
assert.deepEqual([dentist.kind, dentist.start, dentist.end, dentist.repeat], ['event', at(11, 10, 15), at(11, 10, 16), 'FREQ=WEEKLY;INTERVAL=2']);
result = await V.act('add', { text: 'math homework thursday #school !', kind: 'task' }, { now });
const homework = P.get(result.added);
assert.deepEqual([homework.kind, homework.start, homework.cat, homework.priority], ['task', at(11, 5), 'school', 1]);
assert.equal((await V.act('add', { text: 'tomorrow' }, { now })).ok, false);
assert.equal((await V.act('add', { text: '' }, { now })).note, 'Type what to add first.');
assert.equal(P.list().length, 2);

// Saving the form: fields go to update and edit; unchanged repeat words keep the rule; bad input is refused.
const rowOf = (id) => [...V.plannerView(now).upcoming.flatMap((d) => d.items), ...V.plannerView(now).lists.flatMap((l) => l.items)].find((r) => r.itemId === id);
const hw = rowOf(homework.id).form;
assert.equal(hw.date, '2026-11-05');
result = await V.act('save', { id: homework.id, form: { ...hw, title: 'Math homework p. 4', notes: 'odd ones', priority: 3, cat: 'Maths', est: 45, link: 'https://example.org/p4', date: '2026-11-06' } }, { now });
assert.deepEqual([result.ok, result.note], [true, 'Saved “Math homework p. 4”.']);
let saved = P.get(homework.id);
assert.deepEqual([saved.title, saved.notes, saved.priority, saved.cat, saved.est, saved.link, saved.start], ['Math homework p. 4', 'odd ones', 3, 'Maths', 45, 'https://example.org/p4', at(11, 6)]);
assert.equal(saved.dirty, true);
const dentistForm = V.plannerView(now, { week: 1 }).week.days.flatMap((d) => d.items).find((r) => r.itemId === dentist.id).form;
assert.equal(dentistForm.repeat, 'Every other week on Tuesday');
result = await V.act('save', { id: dentist.id, form: { ...dentistForm, title: 'Dentist (new office)', endTime: '16:30' } }, { now });
assert.equal(result.ok, true);
saved = P.get(dentist.id);
assert.deepEqual([saved.title, saved.end, saved.repeat], ['Dentist (new office)', at(11, 10, 16, 30), 'FREQ=WEEKLY;INTERVAL=2']);
result = await V.act('save', { id: dentist.id, form: { ...dentistForm, repeat: 'every week' } }, { now });
assert.equal(P.get(dentist.id).repeat, 'FREQ=WEEKLY');
result = await V.act('save', { id: dentist.id, form: { ...dentistForm, repeat: '' } }, { now });
assert.equal(P.get(dentist.id).repeat, null);
for (const [patch, text] of [
  [{ repeat: 'whenever' }, /couldn’t read “whenever” as a repeat/], [{ title: '  ' }, /needs a title/], [{ date: '2026-02-30' }, /date isn’t valid/],
  [{ time: '' }, /start time/], [{ endTime: '09:00' }, /must end after/], [{ link: 'javascript:alert(1)' }, /http/], [{ est: 'x' }, /estimate/], [{ endDate: '2026-11-11' , endTime: ''}, /end time/],
]) {
  result = await V.act('save', { id: dentist.id, form: { ...dentistForm, repeat: '', ...patch } }, { now });
  assert.equal(result.ok, false, JSON.stringify(patch));
  assert.match(result.note, text);
}
assert.equal(P.get(dentist.id).title, 'dentist');
// An all-day event takes its last day inclusive.
result = await V.act('save', { id: dentist.id, form: { ...dentistForm, allDay: true, time: '', endTime: '', date: '2026-11-10', endDate: '2026-11-12', repeat: '' } }, { now });
saved = P.get(dentist.id);
assert.deepEqual([saved.allDay, saved.start, saved.end], [true, at(11, 10), at(11, 13)]);
assert.equal(V.plannerView(now).week.days.some((d) => d.items.some((r) => r.itemId === dentist.id)), false);
assert.deepEqual(V.plannerView(now, { week: 1 }).week.days.map((d) => d.items.some((r) => r.itemId === dentist.id)), [false, true, true, true, false, false, false]);
// A task made an event is a new item in its place.
const before = P.list({ includeDone: true }).length;
const hwForm = rowOf(homework.id).form;
result = await V.act('save', { id: homework.id, form: { ...hwForm, kind: 'event', time: '13:00', endTime: '14:00' } }, { now });
assert.deepEqual([result.ok, result.note], [true, 'Saved “Math homework p. 4” as an event.']);
assert.equal(P.get(homework.id), null);
assert.equal(P.list({ includeDone: true }).length, before);
const moved = P.list({ cat: 'Maths' })[0];
assert.deepEqual([moved.kind, moved.start, moved.end, moved.est, moved.link], ['event', at(11, 6, 13), at(11, 6, 14), 45, 'https://example.org/p4']);
assert.equal((await V.act('save', { id: 'nope', form: {} }, { now })).ok, false);

// Ticking off, a repeating task moving on, unticking, deleting, skipping and opening a link.
await reset();
const once = await P.add({ title: 'Once', start: at(11, 4) }, now);
const daily = await P.add({ title: 'Daily', start: at(11, 4), repeat: 'FREQ=DAILY' }, now);
result = await V.act('done', { id: once.id }, { now });
assert.deepEqual([result.ok, result.note, P.get(once.id).done], [true, 'Done: “Once”.', true]);
result = await V.act('done', { id: once.id, done: false }, { now });
assert.deepEqual([result.note, P.get(once.id).done], ['Back on your list: “Once”.', false]);
result = await V.act('done', { id: daily.id }, { now });
assert.match(result.note, /^Done\. Next: /);
assert.deepEqual([P.get(daily.id).start, P.get(daily.id).done], [at(11, 5), false]);
assert.equal((await V.act('done', { id: 'nope' }, { now })).ok, false);
result = await V.act('remove', { id: once.id }, { now });
assert.deepEqual([result.note, P.get(once.id)], ['Deleted “Once”.', null]);
assert.equal((await V.act('remove', { id: once.id }, { now })).ok, false);
const meet = await P.add({ kind: 'event', title: 'Meet', start: at(11, 9, 9), repeat: 'FREQ=DAILY' }, now);
assert.equal((await V.act('skip', { id: meet.id, start: 'x' }, { now })).ok, false);
assert.equal((await V.act('skip', { id: meet.id, start: at(11, 10, 9) }, { now })).ok, true);
assert.deepEqual(P.get(meet.id).skip, [at(11, 10, 9)]);
assert.equal((await V.act('skip', { id: meet.id, start: at(11, 3, 9) }, { now })).ok, false);
const linked = await P.add({ title: 'Linked', link: 'https://example.org/x' }, now);
const bare = await P.add({ title: 'No link' }, now);
const bad = await P.add({ title: 'Bad link', link: 'file:///etc/passwd' }, now);
const opened = [];
assert.equal((await V.act('open', { id: linked.id }, { now, open: (u) => opened.push(u) })).ok, true);
assert.equal((await V.act('open', { id: bare.id }, { now, open: (u) => opened.push(u) })).ok, false);
assert.equal((await V.act('open', { id: bad.id }, { now, open: (u) => opened.push(u) })).ok, false);
assert.deepEqual(opened, ['https://example.org/x']);
assert.equal((await V.act('explode', {}, { now })).ok, false);

// The stamp changes when the planner file does, and when the day does.
const stamp = V.plannerStamp(now);
await P.add({ title: 'Another' }, now);
assert.notEqual(V.plannerStamp(now), stamp);
assert.notEqual(V.plannerStamp(at(11, 5)), V.plannerStamp(now));

// The inbox: capture, accept (a day makes a task, a time an event) and dismiss.
await reset();
assert.equal((await V.act('capture', { text: '  ' }, { now })).ok, false);
assert.equal((await V.act('capture', { text: 'Call the bank' }, { now })).ok, true);
assert.equal((await V.act('capture', { text: 'Email Sam' }, { now })).ok, true);
view = V.plannerView(now);
assert.deepEqual(view.inbox.map((i) => i.title), ['Call the bank', 'Email Sam']);
const [bank, sam] = view.inbox;
assert.match((await V.act('accept', { id: bank.id, when: '' }, { now })).note, /Say when/);
assert.match((await V.act('accept', { id: bank.id, when: 'blorp' }, { now })).note, /couldn’t read/);
assert.equal((await V.act('accept', { id: bank.id, when: 'friday' }, { now })).ok, true);
assert.equal((await V.act('accept', { id: sam.id, when: 'friday 3pm' }, { now })).ok, true);
assert.equal(P.list({ kind: 'task', now }).filter((i) => i.title === 'Call the bank').length, 1);
assert.equal(P.list({ kind: 'event', from: at(11, 6), to: at(11, 7), now }).filter((i) => i.title === 'Email Sam').length, 1);
assert.equal(V.plannerView(now).inbox.length, 0);
const later = await V.act('capture', { text: 'Book flights' }, { now }).then(() => V.plannerView(now).inbox[0]);
assert.equal((await V.act('dismiss', { id: later.id }, { now })).ok, true);
assert.equal((await V.act('dismiss', { id: later.id }, { now })).ok, false);

// Feed items are read-only on the page: marked, and every change to one is refused (a kind change too, which would
// otherwise make a copy before the delete failed).
await reset();
const synced = await P.syncFeed('feed:t1', [{ uid: 'u1', kind: 'event', title: 'Lecture', start: at(11, 5, 9), end: at(11, 5, 10), allDay: false, repeat: null, skip: [], link: '', notes: '' }], now);
assert.equal(synced.added, 1);
view = V.plannerView(now, { week: 0 });
const locked = view.week.days.flatMap((d) => d.items).find((r) => r.title === 'Lecture');
assert.equal(locked.readOnly, true);
assert.equal((await V.act('save', { id: locked.itemId, form: { ...locked.form, kind: 'task', date: '2026-11-05' } }, { now })).ok, false);
assert.equal((await V.act('remove', { id: locked.itemId }, { now })).ok, false);
assert.equal(P.list({ now }).length, 1);
assert.equal(view.week.days.flatMap((d) => d.items).filter((r) => r.readOnly).length, 1);

// Feed buttons go to the feeds object, and say so when there isn't one.
const calls = [];
const fakeFeeds = {
  add: async (f) => { calls.push(['add', f]); return { id: 'f1', name: f.name }; },
  refresh: async (ids) => { calls.push(['refresh', ids]); return []; },
  setOn: async (id, on) => { calls.push(['on', id, on]); return id === 'f1' ? { id } : null; },
  remove: async (id) => { calls.push(['remove', id]); return id === 'f1' ? { id, name: 'School' } : null; },
};
assert.equal((await V.act('feedAdd', { name: 'School', url: 'https://x.test/a.ics' }, { now })).ok, false);
assert.equal((await V.act('feedAdd', { name: 'School', url: 'https://x.test/a.ics' }, { now, feeds: fakeFeeds })).ok, true);
assert.equal((await V.act('feedOn', { id: 'f1', on: false }, { now, feeds: fakeFeeds })).ok, true);
assert.equal((await V.act('feedOn', { id: 'zz', on: true }, { now, feeds: fakeFeeds })).ok, false);
assert.equal((await V.act('feedRefresh', {}, { now, feeds: fakeFeeds })).ok, true);
assert.equal((await V.act('feedRemove', { id: 'f1' }, { now, feeds: fakeFeeds })).ok, true);
assert.equal((await V.act('feedRemove', { id: 'zz' }, { now, feeds: fakeFeeds })).ok, false);
assert.deepEqual(calls.map((c) => c[0]), ['add', 'refresh', 'on', 'on', 'refresh', 'remove', 'remove']);
assert.deepEqual(V.plannerView(now, { feeds: [{ id: 'f1', name: 'School', host: 'x.test' }] }).feeds, [{ id: 'f1', name: 'School', host: 'x.test' }]);

// The stamp follows the inbox and feeds files too.
const stampBefore = V.plannerStamp(now);
await V.act('capture', { text: 'Stamp me' }, { now });
assert.notEqual(V.plannerStamp(now), stampBefore);

// A planner file that can't be read gives the page an error, not a crash.
fs.writeFileSync(file, '{"not":"a list"}');
fs.rmSync(file + '.bak', { force: true });
assert.match(V.plannerView(now).error, /./);
console.log('plannerview ok');
