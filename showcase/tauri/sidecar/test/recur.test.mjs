import assert from 'node:assert/strict';
import { describeRule, expand, formatRule, nextOccurrence, parseRule, ruleFromWords } from '../recur.mjs';

const at = (year, month, day, hour = 0) => +new Date(year, month - 1, day, hour);
const now = at(2026, 11, 4, 10);
const dates = (rule, start, from, to) => [...expand(parseRule(rule), start, from, to)];

const biweekly = parseRule('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,MO;COUNT=4');
const monday = at(2026, 11, 2, 9), wed = at(2026, 11, 4, 9), thirdMonday = at(2026, 11, 16, 9), thirdWed = at(2026, 11, 18, 9);
assert.equal(formatRule(biweekly), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4');
assert.equal(describeRule(biweekly, monday), 'Every other week on Mon, Wed, 4 times');
assert.deepEqual([...expand(biweekly, monday, monday, at(2027, 1, 1))], [monday, wed, thirdMonday, thirdWed]);
assert.deepEqual([...expand(biweekly, monday, at(2026, 11, 5), at(2027, 1, 1))], [thirdMonday, thirdWed]);
assert.equal(nextOccurrence(biweekly, monday, wed), thirdMonday);
assert.equal(nextOccurrence(biweekly, monday, thirdWed), null);
assert.deepEqual(dates('FREQ=DAILY;INTERVAL=2;UNTIL=20261108', now, now, at(2026, 12, 1)), [now, at(2026, 11, 6, 10), at(2026, 11, 8, 10)]);
assert.deepEqual(dates('FREQ=WEEKLY;INTERVAL=3', now, now + 1, at(2026, 12, 1)), [at(2026, 11, 25, 10)]);

const jan = at(2026, 1, 31, 10);
assert.deepEqual(dates('FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4', jan, at(2026, 2, 1), at(2026, 8, 1)),
  [at(2026, 3, 31, 10), at(2026, 5, 31, 10), at(2026, 7, 31, 10)]);
assert.deepEqual(dates('FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=15', jan, jan, at(2026, 7, 1)), [at(2026, 3, 15, 10), at(2026, 5, 15, 10)]);
assert.equal(nextOccurrence(parseRule('FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=31'), at(2026, 2, 1), now), null);
const leap = at(2028, 2, 29);
assert.deepEqual(dates('FREQ=YEARLY;INTERVAL=2;COUNT=3', leap, leap, at(2040, 1, 1)), [leap, at(2032, 2, 29), at(2036, 2, 29)]);
const timedUntil = parseRule('FREQ=DAILY;UNTIL=20261108');
assert.deepEqual(parseRule(formatRule(timedUntil, false)), timedUntil);
assert.deepEqual(dates('FREQ=DAILY', at(2026, 3, 7, 9), at(2026, 3, 7), at(2026, 3, 10)), [at(2026, 3, 7, 9), at(2026, 3, 8, 9), at(2026, 3, 9, 9)]);

for (const rule of ['FREQ=MONTHLY;BYDAY=2TU', 'INTERVAL=2', 'FREQ=WEEKLY;INTERVAL=0', 'FREQ=DAILY;COUNT=0', 'FREQ=DAILY;UNTIL=20260230', 'FREQ=MONTHLY;BYMONTHDAY=-1', 'FREQ=HOURLY']) {
  assert.equal(parseRule(rule), null, rule);
}
const spoken = [
  ['gym every monday and thursday at 6pm', 'FREQ=WEEKLY;BYDAY=MO,TH', 'gym at 6pm'],
  ['standup every weekday', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'standup'],
  ['every other Monday', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', ''],
  ['water plants biweekly', 'FREQ=WEEKLY;INTERVAL=2', 'water plants'],
  ['monthly on the 15th', 'FREQ=MONTHLY;BYMONTHDAY=15', ''],
  ['run every 3 days for 5 times', 'FREQ=DAILY;INTERVAL=3;COUNT=5', 'run'],
  ['class every tuesday until dec 15', 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215', 'class'],
  ['daily for the next six weeks', 'FREQ=DAILY;UNTIL=20261215', ''],
  ['once a year', 'FREQ=YEARLY', ''],
  ['weekends', 'FREQ=WEEKLY;BYDAY=SA,SU', ''],
];
for (const [text, rrule, rest] of spoken) {
  const result = ruleFromWords(text, now);
  assert.equal(formatRule(result.rule), rrule, text);
  assert.equal(result.rest, rest, text);
}
assert.equal(ruleFromWords('buy milk', now), null);
console.log('recur: daily, weekly, monthly and yearly rules, limits and spoken phrases passed');
