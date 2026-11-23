import assert from 'node:assert/strict';
import { parseWhen } from '../when.mjs';

const at = (month, day, hour = 0, minute = 0) => +new Date(2026, month - 1, day, hour, minute);
const now = at(11, 4, 10);
const cases = [
  ['tomorrow at 5', at(11, 5, 17), undefined, false, ''],
  ['next tue 3pm', at(11, 10, 15), undefined, false, ''],
  ['the 14th', at(11, 14), undefined, true, ''],
  ['in 2 weeks', at(11, 18), undefined, true, ''],
  ['friday 3 to 4pm', at(11, 6, 15), at(11, 6, 16), false, ''],
  ['dentist Tuesday 3 to 4', at(11, 10, 15), at(11, 10, 16), false, 'dentist'],
  ['dentist tomorrow at 3pm for an hour', at(11, 5, 15), at(11, 5, 16), false, 'dentist'],
  ['calls 830-9pm Sunday biweekly', at(11, 8, 20, 30), at(11, 8, 21), false, 'calls biweekly'],
  ['class 11-1pm tomorrow', at(11, 5, 11), at(11, 5, 13), false, 'class'],
  ['gym 6 to 7:30pm', at(11, 4, 18), at(11, 4, 19, 30), false, 'gym'],
  ['study group 5:30-7:30 tomorrow', at(11, 5, 17, 30), at(11, 5, 19, 30), false, 'study group'],
  ['lab 17:00-19:30 friday', at(11, 6, 17), at(11, 6, 19, 30), false, 'lab'],
  ['late flight Friday 11pm-1am', at(11, 6, 23), at(11, 7, 1), false, 'late flight'],
  ['call 9-10:30am monday', at(11, 9, 9), at(11, 9, 10, 30), false, 'call'],
  ['send email by friday', at(11, 6), undefined, true, 'send email'],
  ['make a call on nov 12th at 5:30 p.m.', at(11, 12, 17, 30), undefined, false, 'make a call'],
  ['stretch in 20 minutes', at(11, 4, 10, 20), undefined, false, 'stretch'],
  ['pay rent in 3 days', at(11, 7), undefined, true, 'pay rent'],
  ['run tonight', at(11, 4, 19), undefined, false, 'run'],
  ['run tonight at seven', at(11, 4, 19), undefined, false, 'run'],
  ['standup next monday at 9am', at(11, 9, 9), undefined, false, 'standup'],
  ['dentist at 9 am', at(11, 5, 9), undefined, false, 'dentist'],
  ['exam on 2026-12-03 at 14:30', at(12, 3, 14, 30), undefined, false, 'exam'],
  ['2026-12-03T08:30', at(12, 3, 8, 30), undefined, false, ''],
  ['12/3/26 at noon', at(12, 3, 12), undefined, false, ''],
  ['3rd of december', at(12, 3), undefined, true, ''],
  ['the 1st', at(12, 1), undefined, true, ''],
  ['this weekend', at(11, 7), undefined, true, ''],
  ['today', at(11, 4), undefined, true, ''],
  ['day after tomorrow', at(11, 6), undefined, true, ''],
];
for (const [text, start, end, allDay, rest] of cases) {
  assert.deepEqual(parseWhen(text, now), { start, ...(end == null ? {} : { end }), allDay, rest }, text);
}
for (const text of ['', 'buy milk', 'buy 5 items', 'add 10-12 pages', 'for half an hour', '2026-02-30', '26:90', 'at 3 people']) {
  assert.equal(parseWhen(text, now), null, text);
}
assert.equal(parseWhen('4pm', now, { timeAfter: at(11, 6, 15) }).start, at(11, 6, 16));
assert.equal(parseWhen('tomorrow', now, { timeAfter: at(11, 6, 15) }).start, at(11, 5));
console.log('when: local dates, relative dates and times, ranges and text extraction checks passed');
