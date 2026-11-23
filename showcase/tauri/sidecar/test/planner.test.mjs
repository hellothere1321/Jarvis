import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-planner-test-'));
process.env.ROAMIES_DATA_DIR = scratch;
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
const P = await import('../planner.mjs');
const S = await import('../store.mjs');
const at = (day, hour = 0, minute = 0) => +new Date(2026, 10, day, hour, minute);
const now = at(4, 10);
const file = path.join(scratch, 'Roamies', 'Data', 'planner.json');
const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
assert.deepEqual(P.list(), []);

const task = await P.add({ title: 'File receipts', cat: 'Home', start: at(3, 16), priority: 1, notes: 'Include the invoice' }, now);
const fields = 'id kind title notes start end allDay done alert fired firedFor repeat skip cat priority lastDone deleted dirty gId gList updated est spent source uid link blockFor';
assert.deepEqual(Object.keys(task).sort(), fields.split(' ').sort());
assert.equal(task.start, at(3));
assert.equal(task.dirty, true);
assert.equal(task.updated, now);
assert.deepEqual(P.get(task.id), task);
assert.deepEqual(P.list({ cat: 'home', overdue: true, now }).map(({ id }) => id), [task.id]);
assert.deepEqual(P.list({ cat: 'missing' }), []);

// Start from a clean synced item to distinguish a local edit from an update.
await S.writeJson(file, [{ ...task, dirty: false, gId: 'remote-id', gList: 'remote-list' }]);
const local = await P.edit(task.id, { est: 25, spent: 5, source: 'screen', link: 'https://example.org', title: 'Ignored' });
assert.equal(local.dirty, false);
assert.equal(local.updated, now);
assert.equal(local.title, task.title);
assert.equal(local.est, 25);
assert.equal(local.spent, 5);
assert.equal(local.source, 'screen');
assert.equal(local.link, 'https://example.org');
const updated = await P.update(task.id, { priority: 3, title: 'File invoices' }, now + 1);
assert.equal(updated.dirty, true);
assert.equal(updated.updated, now + 1);
assert.equal(updated.gId, 'remote-id');
assert.equal(updated.gList, 'remote-list');
assert.equal(updated.est, 25);
assert.equal(updated.priority, 3);
assert.equal(JSON.parse(fs.readFileSync(file + '.bak', 'utf8'))[0].dirty, false);

const [todayTask, undated, futureTask] = await Promise.all([
  P.add({ title: 'Return package', start: now, priority: 2 }, now),
  P.add({ title: 'Buy groceries' }, now),
  P.add({ title: 'Renew membership', start: at(8) }, now),
]);
assert.ok([todayTask, undated, futureTask].every((item) => P.get(item.id)));
assert.deepEqual(P.list({ kind: 'task', from: at(4), to: at(5), now }).map(({ id }) => id), [todayTask.id]);
assert.equal((await P.complete(undated.id, now)).done, true);
assert.equal((await P.complete(undated.id, now + 1)).lastDone, now);
assert.equal((await P.complete(undated.id, now, { done: false })).lastDone, null);
const removed = await P.remove(undated.id, now + 10);
assert.equal(removed.deleted, true);
assert.equal(P.get(undated.id), null);
assert.equal(await P.update(undated.id, { title: 'Still deleted' }), null);
assert.equal(onDisk().find(({ id }) => id === undated.id).dirty, true);

const repeating = await P.add({ title: 'Water plants', repeat: 'every sunday' }, now);
assert.equal(repeating.start, at(8));
assert.equal(repeating.repeat, 'FREQ=WEEKLY;BYDAY=SU');
const next = await P.complete(repeating.id, at(9, 9));
assert.equal(next.start, at(15));
assert.equal(next.lastDone, at(9, 9));
assert.equal(next.done, false);
const counted = await P.add({ title: 'Change filter', start: at(1), repeat: 'daily for 5 times' }, now);
const finalRepeat = await P.complete(counted.id, at(4, 16));
assert.equal(finalRepeat.start, at(5));
assert.equal(finalRepeat.repeat, 'FREQ=DAILY;COUNT=1');
assert.equal((await P.complete(counted.id, at(5, 12))).done, true);

const series = await P.add({ kind: 'event', title: 'Practice', start: at(4, 16), end: at(4, 17), repeat: 'daily for 4 times', skip: [at(6)] }, now);
assert.deepEqual(P.occurrences(at(4, 16, 30), at(8)).map(({ start }) => start), [at(4, 16), at(5, 16), at(7, 16)]);
assert.equal((await P.skipOccurrence(series.id, at(5), true, now)).start, at(5, 16));
assert.equal(await P.skipOccurrence(series.id, at(5), true, now), null);
assert.deepEqual(P.occurrences(at(4, 17), at(8)).map(({ start }) => start), [at(7, 16)]);
assert.equal((await P.update(series.id, { start: at(5, 17) }, now)).end, at(5, 18));

const event = await P.add({ kind: 'event', title: 'Appointment', start: at(4, 11) }, now);
assert.equal(event.end, at(4, 12));
const allDay = await P.add({ kind: 'event', title: 'Conference', start: at(4), end: at(6), allDay: true }, now);
const reminder = await S.addCommitment('Leave a note', at(4, 12), 'reminder');
const later = await S.addCommitment('Return a call', at(5, 12));
const card = S.listItems(now, P.todayRows(now));
assert.deepEqual(card.today.map(({ id, kind, overdue }) => [id, kind, overdue]), [
  [task.id, 'task', true], [todayTask.id, 'task', false], [allDay.id, 'event', false],
  [event.id, 'event', false], [reminder.id, 'reminder', false],
]);
assert.deepEqual(card.later.map(({ id, kind }) => [id, kind]), [[later.id, 'commitment']]);
assert.equal(S.getCommitment(reminder.id).status, 'open');
assert.match(P.summary(now), /Overdue:\n- .*File invoices/);
assert.match(P.summary(now), /Today:\n/);
assert.match(P.summary(now), /Next three days:\n/);
assert.doesNotMatch(P.summary(now), /Renew membership/);

assert.equal(P.nextAlert(at(4, 10, 49)), at(4, 10, 50));
assert.deepEqual(await P.takeDueAlerts(at(4, 10, 49)), []);
assert.deepEqual((await P.takeDueAlerts(at(4, 10, 50))).map(({ id }) => id), [event.id]);
assert.deepEqual(await P.takeDueAlerts(at(4, 10, 51)), []);
const fired = P.get(event.id);
assert.equal(fired.fired, true);
assert.equal(fired.firedFor, event.start);
assert.equal(fired.updated, now);
assert.equal(P.get(allDay.id).firedFor, null);
await P.update(event.id, { start: at(4, 12) }, now + 1);
assert.equal(P.get(event.id).firedFor, null);
assert.deepEqual((await P.takeDueAlerts(at(4, 11, 50))).map(({ id }) => id), [event.id]);
assert.equal((await S.takeDueReminders(at(4, 12))).find(({ id }) => id === reminder.id).kind, 'reminder');

const alertSeries = await P.add({ kind: 'event', title: 'Daily briefing', start: at(10, 9), repeat: 'daily', alert: 0, skip: [at(11, 9)] }, now);
assert.deepEqual(await P.takeDueAlerts(at(10, 8, 59)), []);
const ticks = await Promise.all([P.takeDueAlerts(at(10, 9)), P.takeDueAlerts(at(10, 9))]);
assert.deepEqual(ticks.flatMap((tick) => tick.map(({ id }) => id)), [alertSeries.id]);
assert.equal(P.get(alertSeries.id).fired, false);
assert.equal(P.get(alertSeries.id).firedFor, at(10, 9));
assert.deepEqual(await P.takeDueAlerts(at(11, 9)), []);
assert.deepEqual((await P.takeDueAlerts(at(12, 9, 5))).map(({ id }) => id), [alertSeries.id]);
assert.deepEqual(await P.takeDueAlerts(at(13, 9, 30)), []);
console.log('planner: storage, CRUD, repeats, combined list and event alerts passed');

const { createTools } = await import('../tools.mjs');
let changes = 0, shown = 0;
const { tools } = createTools({ onPlanner: () => changes++, showList: () => shown++ });
const run = (name, args) => {
  const tool = tools.find((candidate) => candidate.name === name);
  return tool.execute(tool.parameters.parse(args));
};
const taskText = await run('add_task', { title: 'Check inventory', due: 'tomorrow', list: 'Office', priority: 3 });
const toolTask = P.list({ cat: 'Office' })[0];
assert.match(taskText, /Check inventory.*high priority/);
const eventText = await run('add_event', { title: 'Planning session', when: 'tomorrow 3 to 4pm', alert: 15, list: 'Office' });
assert.match(eventText, /event: Planning session/);
const toolEvent = P.list({ cat: 'Office', kind: 'event' })[0];
assert.equal(toolEvent.end - toolEvent.start, 60 * 60_000);
assert.equal(toolEvent.alert, 15);
assert.match(await run('list_planner', { from: 'tomorrow', list: 'Office', kind: 'event' }), /Planning session/);
assert.match(await run('update_planner_item', { id: toolEvent.id, end: '5pm' }), /Updated/);
assert.equal(P.get(toolEvent.id).end - toolEvent.start, 2 * 60 * 60_000);
assert.match(await run('complete_task', { id: toolTask.id }), /Done/);
assert.match(await run('delete_planner_item', { id: toolEvent.id }), /Deleted/);
assert.equal(P.get(toolEvent.id), null);
assert.match(await run('show_list', {}), /on screen/);
assert.equal(shown, 1);
assert.equal(changes, 5);
await assert.rejects(run('add_event', { title: 'Invalid event', when: 'unknown' }), /Couldn't read/);
console.log('planner tools: add, update, list, complete, delete and show list passed');
