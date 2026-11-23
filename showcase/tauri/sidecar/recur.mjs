// The planner's RRULE subset. Occurrences keep the start's local wall time.
import { DAY_NAMES, DAY_WORD, NUMBER_WORD, addDays, amount, dayNumber, localDate, midnight, parseWhen, weekday } from './when.mjs';

const CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const FREQ = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' };
const mondayIndex = (day) => (day + 6) % 7;
const ordered = (days) => [...new Set(days)].sort((a, b) => mondayIndex(a) - mondayIndex(b));
const makeRule = (freq, fields) => ({ freq, interval: 1, days: [], monthDay: 0, count: 0, until: null, ...fields });
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const lastDate = 8.64e15;

export function parseRule(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const fields = Object.create(null);
  for (const part of text.trim().toUpperCase().replace(/^RRULE:/, '').split(';')) {
    const [key, value, extra] = part.trim().split('=');
    if (!['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL', 'WKST'].includes(key) || !value || extra != null || key in fields) return null;
    fields[key] = value.trim();
  }
  const freq = fields.FREQ, interval = Number(fields.INTERVAL ?? 1), count = Number(fields.COUNT ?? 0);
  const days = fields.BYDAY?.split(',').map((code) => CODES.indexOf(code.trim())) ?? [];
  const monthDay = Number(fields.BYMONTHDAY ?? 0);
  if (!Object.values(FREQ).includes(freq) || !positive(interval) || (fields.COUNT && !positive(count))) return null;
  if (fields.WKST && fields.WKST !== 'MO') return null;
  if (fields.BYDAY && (freq !== 'WEEKLY' || days.includes(-1))) return null;
  if (fields.BYMONTHDAY && (freq !== 'MONTHLY' || !positive(monthDay) || monthDay > 31)) return null;
  if (fields.COUNT && fields.UNTIL) return null;

  let until = null;
  if (fields.UNTIL) {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(fields.UNTIL);
    if (!match) return null;
    const [, y, m, d, h, min, sec] = match;
    until = parseWhen(`${y}-${m}-${d}`)?.start;
    if (until == null || (h && (+h > 23 || +min > 59 || +sec > 59))) return null;
    if (h && fields.UNTIL.endsWith('Z')) until = midnight(Date.parse(`${y}-${m}-${d}T${h}:${min}:${sec}Z`));
  }
  return makeRule(freq, { interval, days: ordered(days), monthDay, count, until });
}

const pad = (n) => String(n).padStart(2, '0');
export function formatRule(rule, allDay = true) {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.days.length) parts.push(`BYDAY=${ordered(rule.days).map((day) => CODES[day]).join(',')}`);
  if (rule.monthDay) parts.push(`BYMONTHDAY=${rule.monthDay}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  else if (rule.until != null) {
    const date = new Date(rule.until);
    const until = allDay
      ? `${String(date.getFullYear()).padStart(4, '0')}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
      : new Date(addDays(midnight(rule.until), 1) - 1000).toISOString().replace(/[-:]|\.\d+/g, '');
    parts.push(`UNTIL=${until}`);
  }
  return parts.join(';');
}

export function* expand(rule, start, from, to) {
  if (!rule || !Number.isFinite(start) || !(from < to) || start >= to) return;
  const anchor = new Date(start), lower = new Date(Math.max(start, from));
  const { freq, interval, count, until } = rule;
  const timed = (day) => new Date(day).setHours(anchor.getHours(), anchor.getMinutes(), anchor.getSeconds(), anchor.getMilliseconds());
  const origin = midnight(start), step = (freq === 'WEEKLY' ? 7 : 1) * interval;
  const offsets = freq === 'WEEKLY' ? ordered(rule.days.length ? rule.days : [anchor.getDay()]).map(mondayIndex) : [0];
  const base = freq === 'WEEKLY' ? addDays(origin, -mondayIndex(anchor.getDay())) : origin;
  const year = anchor.getFullYear(), month = anchor.getMonth();
  const yearDiff = lower.getFullYear() - year;
  const dateOffset = dayNumber(lower) - dayNumber(base);
  const monthDiff = yearDiff * 12 + lower.getMonth() - month;
  const distance = freq === 'YEARLY' ? yearDiff : freq === 'MONTHLY' ? monthDiff : dateOffset;
  const index = count ? 0 : Math.max(0, Math.floor(distance / step));
  const cutoff = until == null ? to : Math.min(to, addDays(until, 1));
  let seen = 0, empty = 0;
  for (let i = index; ; i++) {
    const shift = i * step;
    const calendar = freq === 'MONTHLY' || freq === 'YEARLY';
    const period = calendar
      ? localDate(year + (freq === 'YEARLY' ? shift : 0), month + (freq === 'MONTHLY' ? shift : 0), 1)
      : addDays(base, shift);
    if (!Number.isFinite(period) || period >= cutoff) return;
    const date = rule.monthDay || anchor.getDate();
    for (const offset of offsets) {
      const day = addDays(period, calendar ? date - 1 : offset);
      if (calendar && new Date(day).getDate() !== date) {
        // Month and leap-year patterns repeat within 400 years.
        if (++empty >= 4800) return;
        continue;
      }
      empty = 0;
      const time = timed(day);
      if (!Number.isFinite(time) || time >= cutoff) return;
      if (time < start) continue;
      if (count && ++seen > count) return;
      if (time >= from) yield time;
    }
  }
}

export function nextOccurrence(rule, start, after) {
  return expand(rule, start, after + 1, lastDate).next().value ?? null;
}

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
export function describeRule(rule, start = Date.now()) {
  const { freq, interval, monthDay, count, until } = rule;
  const unit = Object.keys(FREQ).find((key) => FREQ[key] === freq);
  let text = interval === 1 ? `Every ${unit}` : interval === 2 ? `Every other ${unit}` : `Every ${interval} ${unit}s`;
  if (freq === 'WEEKLY') {
    const days = ordered(rule.days.length ? rule.days : [new Date(start).getDay()]);
    const group = days.join() === '1,2,3,4,5' ? 'weekday' : days.join() === '6,0' ? 'weekend' : null;
    const label = group ?? days.map((day) => days.length === 1 ? DAY_NAMES[day] : DAY_NAMES[day].slice(0, 3)).join(', ');
    text = interval === 1 && (group || days.length === 1) ? `Every ${label}` : `${text} on ${label}${group ? 's' : ''}`;
  }
  if (freq === 'MONTHLY') text += ` on the ${ordinal(monthDay || new Date(start).getDate())}`;
  if (count) return `${text}, ${count} ${count === 1 ? 'time' : 'times'}`;
  if (until != null) return `${text} until ${new Date(until).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  return text;
}

const daysList = String.raw`(?:${DAY_WORD})s?(?:\s*(?:,\s*(?:and\s+)?|and\s+|&\s*)(?:${DAY_WORD})s?)*`;
const patterns = [
  [String.raw`(?:every\s+)?(?:week\s?days?|work\s?days)\b`, () => makeRule('WEEKLY', { days: [1, 2, 3, 4, 5] })],
  [String.raw`(?:every\s+weekends?|weekends)\b`, () => makeRule('WEEKLY', { days: [6, 0] })],
  [String.raw`(bi-?weekly|fortnightly)\b`, () => makeRule('WEEKLY', { interval: 2 })],
  [String.raw`(?:monthly|(?:every|each)\s+month|once\s+a\s+month)\s+on\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b`, ([day]) => makeRule('MONTHLY', { monthDay: +day })],
  [String.raw`every\s+(\d{1,2})(?:st|nd|rd|th)\b`, ([day]) => makeRule('MONTHLY', { monthDay: +day })],
  [String.raw`(?:every|each)\s+(?:(other|${NUMBER_WORD})\s+)?(day|week|month|year)s?\b`, ([n, unit]) => makeRule(FREQ[unit], { interval: n === 'other' ? 2 : n == null ? 1 : amount(n) })],
  [String.raw`(?:every|each)\s+(?:(other)\s+)?(${daysList})\b`, ([other, days]) => makeRule('WEEKLY', { interval: other ? 2 : 1, days: readDays(days) })],
  [String.raw`((?:(?:${DAY_WORD})s)(?:\s*(?:,|and|&)\s*(?:${DAY_WORD})s)*)\b`, ([days]) => makeRule('WEEKLY', { days: readDays(days) })],
  [String.raw`(daily|weekly|monthly|yearly|annually|everyday|once\s+a\s+(?:day|week|month|year))\b`, ([word]) => makeRule(FREQ[word.split(' ').at(-1)] ?? ({ weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY', annually: 'YEARLY' })[word] ?? 'DAILY')],
].map(([pattern, build]) => [new RegExp(String.raw`\b(?:on\s+)?` + pattern, 'i'), build]);

function readDays(text) {
  return ordered([...text.matchAll(new RegExp(`(?:${DAY_WORD})`, 'gi'))].map(([word]) => weekday(word)));
}

export function ruleFromWords(text, now = Date.now(), start = now) {
  for (const [pattern, build] of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const rule = build(match.slice(1).map((arg) => arg?.toLowerCase()));
    if (!positive(rule.interval) || rule.monthDay > 31 || (rule.freq === 'MONTHLY' && /(?:\bon\s+|^every\s+)\D*0(?:st|nd|rd|th)?$/i.test(match[0]))) return null;
    let rest = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`.trim().replace(/\s+/g, ' ');
    const limit = new RegExp(String.raw`\b(?:for\s+(?:the\s+next\s+)?(${NUMBER_WORD})\s+(times|occurrences?|sessions?|days?|weeks?|months?|years?)|(\d+)\s+(times))\b`, 'i').exec(rest);
    const until = /\b(?:until|till|through|thru|ending(?:\s+on)?)\s+(.+)$/i.exec(rest);
    if (limit) {
      const count = amount(limit[1] ?? limit[3]), unit = (limit[2] ?? limit[4])[0].toLowerCase();
      if (!positive(count)) return null;
      if (['t', 'o', 's'].includes(unit)) rule.count = count;
      else {
        const first = nextOccurrence(rule, start, start - 1);
        if (first == null) return null;
        const day = midnight(first), date = new Date(day);
        if (unit === 'w' || unit === 'd') rule.until = addDays(day, count * (unit === 'w' ? 7 : 1) - 1);
        else {
          const month = date.getMonth() + count * (unit === 'y' ? 12 : 1);
          const max = new Date(localDate(date.getFullYear(), month + 1, 0)).getDate();
          rule.until = addDays(localDate(date.getFullYear(), month, Math.min(date.getDate(), max)), -1);
        }
        if (!Number.isFinite(rule.until)) return null;
      }
      rest = `${rest.slice(0, limit.index)} ${rest.slice(limit.index + limit[0].length)}`.trim().replace(/\s+/g, ' ');
    } else if (until) {
      const date = parseWhen(until[1], now);
      if (date?.allDay) {
        rule.until = date.start;
        rest = `${rest.slice(0, until.index)} ${date.rest}`.trim();
      }
    }
    return { rule, rest };
  }
  return null;
}
