// Calendar files in .ics form: parseIcs pulls out the events and tasks we can show. Run: npm test
import assert from 'node:assert/strict';
import { parseIcs } from '../ics.mjs';

const crlf = (...lines) => lines.concat('').join('\r\n');
const lf = (...lines) => lines.concat('').join('\n');
const local = (y, m, d, h = 0, mi = 0, s = 0) => new Date(y, m - 1, d, h, mi, s).getTime();
const one = (...lines) => parseIcs(crlf('BEGIN:VCALENDAR', ...lines, 'END:VCALENDAR'));

// Empty and shell-only files give empty lists; null and garbage never throw.
assert.deepEqual(parseIcs(''), { events: [], todos: [] });
assert.deepEqual(parseIcs(null), { events: [], todos: [] });
assert.deepEqual(parseIcs(42), { events: [], todos: [] });
assert.deepEqual(one('VERSION:2.0', 'PRODID:-//Example//Test//EN'), { events: [], todos: [] });
assert.deepEqual(parseIcs(crlf('not an ics file', 'still not', 'END:VCALENDAR')), { events: [], todos: [] });

// The fields we keep from an event, with LF line endings.
const basic = lf(
  'BEGIN:VCALENDAR', 'BEGIN:VEVENT',
  'UID:meet-1@example.test', 'SUMMARY:Coffee with Ada', 'DESCRIPTION:Talk about the map',
  'LOCATION:Riverside Cafe', 'URL:https://example.test/meet/1',
  'DTSTART:20250105T090000Z', 'DTEND:20250105T100000Z',
  'STATUS:CONFIRMED', 'RRULE:FREQ=WEEKLY;COUNT=3', 'LAST-MODIFIED:20250101T120000Z',
  'END:VEVENT', 'END:VCALENDAR');
const parsed = parseIcs(basic);
assert.equal(parsed.events.length, 1);
assert.deepEqual(parsed.events[0], {
  uid: 'meet-1@example.test', summary: 'Coffee with Ada', description: 'Talk about the map',
  location: 'Riverside Cafe', url: 'https://example.test/meet/1',
  start: new Date('2025-01-05T09:00:00Z'), end: new Date('2025-01-05T10:00:00Z'), allDay: false,
  due: null, rrule: 'FREQ=WEEKLY;COUNT=3', exdates: [], status: 'CONFIRMED',
  completed: null, lastModified: new Date('2025-01-01T12:00:00Z'),
});

// The same document with CRLF line endings parses identically.
const crlfDoc = crlf(
  'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:meet-1@example.test', 'SUMMARY:Coffee with Ada',
  'DTSTART:20250105T090000Z', 'DTEND:20250105T100000Z', 'END:VEVENT', 'END:VCALENDAR');
assert.equal(parseIcs(crlfDoc).events[0].summary, 'Coffee with Ada');
assert.equal(parseIcs(crlfDoc).events[0].start.toISOString(), '2025-01-05T09:00:00.000Z');

// Missing fields are null, and exdates is an empty array.
const sparse = one('BEGIN:VEVENT', 'UID:sparse@example.test', 'DTSTART:20250105T090000Z', 'END:VEVENT');
assert.equal(sparse.events[0].summary, null);
assert.equal(sparse.events[0].description, null);
assert.equal(sparse.events[0].location, null);
assert.equal(sparse.events[0].url, null);
assert.equal(sparse.events[0].end, null);
assert.equal(sparse.events[0].due, null);
assert.equal(sparse.events[0].rrule, null);
assert.equal(sparse.events[0].status, null);
assert.equal(sparse.events[0].completed, null);
assert.equal(sparse.events[0].lastModified, null);
assert.deepEqual(sparse.events[0].exdates, []);

// Folded lines continue the previous one: one leading space or tab is removed.
const folded = one('BEGIN:VEVENT', 'SUMMARY:A very long', '  title', 'DESCRIPTION:first', '\t second',
  'DTSTART:20250105T', ' 090000Z', 'END:VEVENT');
assert.equal(folded.events[0].summary, 'A very long title');
assert.equal(folded.events[0].description, 'first second');
assert.equal(folded.events[0].start.toISOString(), '2025-01-05T09:00:00.000Z');

// A folded line before anything else is just garbage, not a crash.
assert.deepEqual(parseIcs(' skipped\nBEGIN:VCALENDAR\nEND:VCALENDAR').events, []);

// DTSTART;VALUE=DATE is all-day, at local midnight, and lasts one day without DTEND.
const allDay = one('BEGIN:VEVENT', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20250105', 'END:VEVENT');
assert.equal(allDay.events[0].allDay, true);
assert.equal(allDay.events[0].start.getTime(), local(2025, 1, 5));
assert.equal(allDay.events[0].end.getTime(), local(2025, 1, 6));
// With an explicit DTEND the stated day wins.
const allDayEnd = one('BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20250105', 'DTEND;VALUE=DATE:20250107', 'END:VEVENT');
assert.equal(allDayEnd.events[0].allDay, true);
assert.equal(allDayEnd.events[0].end.getTime(), local(2025, 1, 7));

// UTC times ending in Z are instants independent of the machine's zone.
const utc = one('BEGIN:VEVENT', 'DTSTART:20250705T090000Z', 'DTEND:20250705T093000Z', 'END:VEVENT');
assert.equal(utc.events[0].start.toISOString(), '2025-07-05T09:00:00.000Z');
assert.equal(utc.events[0].end.toISOString(), '2025-07-05T09:30:00.000Z');

// Floating times (no Z, no TZID) are local.
const floating = one('BEGIN:VEVENT', 'DTSTART:20250105T090000', 'DTEND:20250105T101500', 'END:VEVENT');
assert.equal(floating.events[0].start.getTime(), local(2025, 1, 5, 9));
assert.equal(floating.events[0].end.getTime(), local(2025, 1, 5, 10, 15));

// TZID names are resolved with Intl, including quoted parameter values.
const winter = one('BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20250105T090000', 'END:VEVENT');
assert.equal(winter.events[0].start.toISOString(), '2025-01-05T14:00:00.000Z');
const summer = one('BEGIN:VEVENT', 'DTSTART;TZID="America/New_York":20250705T090000', 'END:VEVENT');
assert.equal(summer.events[0].start.toISOString(), '2025-07-05T13:00:00.000Z');
const unknownZone = one('BEGIN:VEVENT', 'DTSTART;TZID=Nowhere/Fantasy:20250105T090000', 'END:VEVENT');
assert.equal(unknownZone.events[0].start.getTime(), local(2025, 1, 5, 9));

// DURATION stands in for DTEND: days, hours and minutes, and weeks.
const dayLong = one('BEGIN:VEVENT', 'DTSTART:20250105T090000Z', 'DURATION:P1D', 'END:VEVENT');
assert.equal(dayLong.events[0].end.toISOString(), '2025-01-06T09:00:00.000Z');
const hourly = one('BEGIN:VEVENT', 'DTSTART:20250105T090000Z', 'DURATION:PT1H30M', 'END:VEVENT');
assert.equal(hourly.events[0].end.toISOString(), '2025-01-05T10:30:00.000Z');
const fortnight = one('BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20250105', 'DURATION:P2W', 'END:VEVENT');
assert.equal(fortnight.events[0].end.getTime(), local(2025, 1, 19));
assert.equal(fortnight.events[0].allDay, true);

// EXDATE values may be comma separated, carry parameters, or come on several lines.
const exdates = one('BEGIN:VEVENT', 'DTSTART:20250105T090000Z',
  'EXDATE:20250112T090000Z,20250119T090000Z', 'EXDATE:20250126T090000Z', 'END:VEVENT');
assert.deepEqual(exdates.events[0].exdates.map((d) => d.toISOString()), [
  '2025-01-12T09:00:00.000Z', '2025-01-19T09:00:00.000Z', '2025-01-26T09:00:00.000Z']);
const allDayExdates = one('BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20250105',
  'EXDATE;VALUE=DATE:20250112,20250119', 'EXDATE;TZID=America/New_York:20250126T090000', 'END:VEVENT');
assert.equal(allDayExdates.events[0].exdates[0].getTime(), local(2025, 1, 12));
assert.equal(allDayExdates.events[0].exdates[1].getTime(), local(2025, 1, 19));
assert.equal(allDayExdates.events[0].exdates[2].toISOString(), '2025-01-26T14:00:00.000Z');

// TEXT values unescape newlines, commas, semicolons and backslashes.
const escaped = one('BEGIN:VEVENT', 'SUMMARY:Team\\, one\\; two',
  'DESCRIPTION:Line one\\nLine two, with \\\\ slash', 'END:VEVENT');
assert.equal(escaped.events[0].summary, 'Team, one; two');
assert.equal(escaped.events[0].description, 'Line one\nLine two, with \\ slash');
const oddEscape = one('BEGIN:VEVENT', 'SUMMARY:back\\x', 'END:VEVENT');
assert.equal(oddEscape.events[0].summary, 'back\\x');

// VTODO uses DUE, COMPLETED and STATUS like a task.
const todos = one('BEGIN:VTODO', 'UID:task-7@example.test', 'SUMMARY:Send the notes',
  'DESCRIPTION:Include the map', 'DUE;TZID=America/New_York:20250110T170000',
  'STATUS:COMPLETED', 'COMPLETED:20250109T150000Z', 'LAST-MODIFIED:20250109T150100Z', 'END:VTODO');
assert.equal(todos.todos.length, 1);
assert.deepEqual(todos.events, []);
assert.equal(todos.todos[0].uid, 'task-7@example.test');
assert.equal(todos.todos[0].summary, 'Send the notes');
assert.equal(todos.todos[0].description, 'Include the map');
assert.equal(todos.todos[0].due.toISOString(), '2025-01-10T22:00:00.000Z');
assert.equal(todos.todos[0].completed.toISOString(), '2025-01-09T15:00:00.000Z');
assert.equal(todos.todos[0].lastModified.toISOString(), '2025-01-09T15:01:00.000Z');
assert.equal(todos.todos[0].status, 'COMPLETED');

// Several items keep their order and stay in their own list.
const mixed = one('BEGIN:VEVENT', 'SUMMARY:First', 'END:VEVENT',
  'BEGIN:VTODO', 'SUMMARY:Chore', 'END:VTODO',
  'BEGIN:VEVENT', 'SUMMARY:Second', 'END:VEVENT');
assert.deepEqual(mixed.events.map((e) => e.summary), ['First', 'Second']);
assert.deepEqual(mixed.todos.map((t) => t.summary), ['Chore']);

// VTIMEZONE, VALARM and unknown components and properties contribute nothing.
const ignored = one('BEGIN:VTIMEZONE', 'TZID:America/New_York',
  'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:-0400', 'END:STANDARD', 'END:VTIMEZONE',
  'BEGIN:X-CUSTOM', 'SUMMARY:Not an event', 'END:X-CUSTOM',
  'BEGIN:VEVENT', 'SUMMARY:Real event', 'DTSTART:20250105T090000Z', 'X-APPLE-TRAVELADVISORY:ignore',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder text', 'TRIGGER:-PT15M', 'END:VALARM',
  'END:VEVENT');
assert.equal(ignored.events.length, 1);
assert.equal(ignored.events[0].summary, 'Real event');
assert.equal(ignored.events[0].description, null);
assert.equal(ignored.events[0].start.toISOString(), '2025-01-05T09:00:00.000Z');

// Broken dates and durations are skipped, not thrown; an unclosed event is still returned.
const broken = one('BEGIN:VEVENT', 'SUMMARY:Broken', 'DTSTART:not-a-date', 'DURATION:QQQ',
  'EXDATE:also-not-a-date', 'END:VEVENT');
assert.equal(broken.events.length, 1);
assert.equal(broken.events[0].start, null);
assert.equal(broken.events[0].end, null);
assert.deepEqual(broken.events[0].exdates, []);
const unclosed = parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Truncated\r\n');
assert.equal(unclosed.events[0].summary, 'Truncated');

// A todo's DTSTART plus DURATION is when it's due; a todo gets no end, all-day or not.
const timedTodo = one('BEGIN:VTODO', 'DTSTART:20250105T090000Z', 'DURATION:PT2H', 'END:VTODO');
assert.equal(timedTodo.todos[0].due.toISOString(), '2025-01-05T11:00:00.000Z');
assert.equal(timedTodo.todos[0].end, null);
const dayTodo = one('BEGIN:VTODO', 'DTSTART;VALUE=DATE:20250105', 'END:VTODO');
assert.equal(dayTodo.todos[0].allDay, true);
assert.equal(dayTodo.todos[0].end, null);

// An all-day event on a clock-change day still ends at the next local midnight.
const dst = one('BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20250309', 'END:VEVENT');
assert.equal(dst.events[0].end.getTime(), local(2025, 3, 10));
const dstFall = one('BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20251102', 'END:VEVENT');
assert.equal(dstFall.events[0].end.getTime(), local(2025, 11, 3));

console.log('ics tests: passed');
