// Date phrases use the computer's local calendar. Results use epoch milliseconds.
export const DAY_NAMES = 'Sunday Monday Tuesday Wednesday Thursday Friday Saturday'.split(' ');
export const DAY_WORD = 'sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:rs?(?:day)?)?|fri(?:day)?|sat(?:urday)?';
export const weekday = (word) => DAY_NAMES.findIndex((day) => day.slice(0, 3).toLowerCase() === word.slice(0, 3).toLowerCase());
const MONTH_WORD = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const months = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
const numbers = 'one two three four five six seven eight nine ten eleven twelve'.split(' ');
export const NUMBER_WORD = String.raw`\d+(?:\.\d+)?|half an?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty five`;
export function amount(word) {
  const value = word.toLowerCase();
  if (value.startsWith('half')) return 0.5;
  if (value === 'a' || value === 'an') return 1;
  return ({ fifteen: 15, twenty: 20, thirty: 30, 'forty five': 45 })[value] ?? (numbers.includes(value) ? numbers.indexOf(value) + 1 : Number(value));
}

export function localDate(year, month, day) {
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(0, 0, 0, 0);
  return +date;
}

export function midnight(time) {
  const date = new Date(time);
  return date.setHours(0, 0, 0, 0);
}

export function addDays(time, days) {
  const date = new Date(time);
  return date.setDate(date.getDate() + days);
}

// A calendar day index, independent of the length of a local day.
export function dayNumber(time) {
  const local = new Date(time), utc = new Date(0);
  return utc.setUTCFullYear(local.getFullYear(), local.getMonth(), local.getDate()) / 86_400_000;
}

const datePrefix = String.raw`(?:\b(?:on|by|due|until|before|for)\s+)?`;
const datePatterns = [
  String.raw`(?<year>\d{4})-(?<month>\d{1,2})-(?<day>\d{1,2})\b`,
  String.raw`(?<month>${MONTH_WORD})\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(?<year>\d{4}))?`,
  String.raw`(?<day>\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(?<month>${MONTH_WORD})\b(?:,?\s+(?<year>\d{4}))?`,
  String.raw`(?<month>\d{1,2})/(?<day>\d{1,2})(?:/(?<year>\d{2,4}))?\b`,
  String.raw`(?:the\s+)?(?<day>\d{1,2})(?:st|nd|rd|th)\b`,
].map((pattern) => new RegExp(datePrefix + '\\b' + pattern, 'i'));

function calendarDate({ year, month, day }, today) {
  const current = new Date(today);
  const d = Number(day);
  const m = month == null ? current.getMonth() : Number.isNaN(Number(month)) ? months.indexOf(month.toLowerCase().slice(0, 3)) : Number(month) - 1;
  const y = year == null ? current.getFullYear() : Number(year) + (year.length === 2 ? 2000 : 0);
  if (d < 1 || d > 31 || m < 0 || m > 11 || y < 1 || (month != null && d > new Date(localDate(2000, m + 1, 0)).getDate())) return NaN;
  // A missing month or year can roll forward to the next date that exists.
  const attempts = year != null ? 1 : month == null ? 12 : 8;
  for (let i = 0; i < attempts; i++) {
    const candidate = localDate(y + (month == null ? 0 : i), m + (month == null ? i : 0), d);
    if (new Date(candidate).getDate() === d && (year != null || candidate >= today)) return candidate;
  }
  return NaN;
}

function findDate(text, today) {
  const named = new RegExp(datePrefix + String.raw`\b(?<day>day after tomorrow|tomorrow|today|tonight|this weekend|next week)\b`, 'i').exec(text);
  const dow = new Date(today).getDay();
  if (named) {
    const word = named.groups.day.toLowerCase();
    const days = { today: 0, tonight: 0, tomorrow: 1, 'day after tomorrow': 2, 'this weekend': (6 - dow + 7) % 7, 'next week': (8 - dow) % 7 || 7 };
    return { match: named, day: addDays(today, days[word]), tonight: word === 'tonight' };
  }
  const namedDay = new RegExp(datePrefix + String.raw`\b(?:(next|this|coming)\s+)?(${DAY_WORD})(?![\w/-])`, 'i').exec(text);
  if (namedDay) {
    const day = weekday(namedDay[2]), modifier = namedDay[1]?.toLowerCase();
    const ahead = (day - dow + 7) % 7;
    const days = modifier === 'next' ? ((8 - dow) % 7 || 7) + (day + 6) % 7 : ahead || (modifier === 'this' ? 0 : 7);
    return { match: namedDay, day: addDays(today, days) };
  }
  for (const pattern of datePatterns) {
    const match = pattern.exec(text);
    if (match) return { match, day: calendarDate(match.groups, today) };
  }
  return {};
}

const clock = String.raw`(\d{1,2}|${numbers.join('|')})(?::(\d{2}))?\s*(am|pm)?`;
const rangeClock = String.raw`(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?`;
const rangePattern = new RegExp(String.raw`(?<![\w:/.])(?:(?:from|at)\s+)?${rangeClock}\s*(-|–|—|to|until|till)\s*${rangeClock}\b(?![:/]|\.\d)`, 'gi');
const singleClock = new RegExp(String.raw`(?<![\w:])(?:(?:at|around|by)\s+|@\s*)?${clock}\b(?![:/]|\.\d)`, 'gi');
const timeAt = (day, minutes) => new Date(day).setMinutes(minutes);

function readClock(hourText, minuteText, meridiem) {
  const hour = amount(hourText), minute = Number(minuteText ?? 0);
  if (minute > 59 || hour > 23 || (meridiem && (hour < 1 || hour > 12))) return null;
  if (meridiem) return { minutes: (hour % 12 + (meridiem.toLowerCase() === 'pm' ? 12 : 0)) * 60 + minute, ambiguous: false };
  return { minutes: hour * 60 + minute, ambiguous: hour >= 1 && hour <= 12 && !hourText.startsWith('0') };
}

function resolveClock(time, day, now, part) {
  if (!time.ambiguous) return time.minutes;
  const morning = time.minutes % 720;
  if (part) return morning + (part === 'morning' ? 0 : 720);
  if (day === midnight(now)) return timeAt(day, morning) > now ? morning : morning + 720;
  return morning >= 420 ? morning : morning + 720;
}

function findTime(text, day, now, part, afterDate) {
  for (const match of text.matchAll(rangePattern)) {
    const [, h1, m1, a1, separator, h2, m2, a2] = match;
    if (!a1 && !a2 && !m1 && !m2 && day == null && separator === '-') continue;
    const first = readClock(h1, m1, a1 ?? a2), second = readClock(h2, m2, a2 ?? a1);
    if (!first || !second) continue;
    if (!a1 && !a2 && (!first.ambiguous || !second.ambiguous)) first.ambiguous = false;
    let start = resolveClock(first, day ?? midnight(now), now, part);
    if (!a1 && a2 && start >= second.minutes && start >= 720) start -= 720;
    if (a1 && !a2 && second.minutes <= start && second.minutes < 720) second.minutes += 720;
    const cycle = first.ambiguous && second.ambiguous ? 720 : 1440;
    const length = ((second.minutes - start) % cycle + cycle) % cycle || cycle;
    return { match, minutes: start, length };
  }
  const named = /\b(?:at\s+)?(noon|midnight)\b/i.exec(text);
  if (named) return { match: named, minutes: named[1].toLowerCase() === 'noon' ? 720 : 0 };
  for (const match of text.matchAll(singleClock)) {
    const [, hour, minute, meridiem] = match;
    if (!minute && !meridiem) {
      const tail = text.slice(match.index + match[0].length);
      const bareAfterDate = afterDate != null && match.index >= afterDate && !text.slice(afterDate, match.index).trim() && /^\d/.test(hour);
      if (!bareAfterDate && !/^(?:at\b|around\b|@)/i.test(match[0])) continue;
      if (/^\s*(?:%|\/|minutes?\b|mins?\b|hours?\b|hrs?\b|days?\b|people\b|items?\b)/i.test(tail)) continue;
    }
    const time = readClock(hour, minute, meridiem);
    if (time) return { match, minutes: resolveClock(time, day ?? midnight(now), now, part) };
  }
  if (part) return { minutes: { morning: 540, afternoon: 900, evening: 1140 }[part] };
  return {};
}

// Blank extracted text to keep match offsets stable.
const cut = (text, match) => match ? text.slice(0, match.index) + ' '.repeat(match[0].length) + text.slice(match.index + match[0].length) : text;
const clean = (text) => text.trim().replace(/\s+/g, ' ')
  .replace(/^(?:(?:on|at|by|due|until|before|for|from)\s+)+/i, '')
  .replace(/(?:\s+(?:on|at|by|due|until|before|for|from|in|and))+$/i, '')
  .replace(/^[ ,;:.-]+|[ ,;:.-]+$/g, '');

export function parseWhen(input, now = Date.now(), { timeAfter = now } = {}) {
  now = +now;
  let text = String(input ?? '').replace(/\b([ap])\.m\.?/gi, '$1m').replace(/\bo'?clock\b/gi, ' ');
  const iso = /^\s*(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?\s*$/i.exec(text);
  if (iso) {
    const day = findDate(iso[1], midnight(now)).day;
    const [, , h, m, s = '0'] = iso;
    if (!Number.isFinite(day) || +h > 23 || +m > 59 || +s > 59) return null;
    return { start: new Date(day).setHours(+h, +m, +s, 0), allDay: false, rest: '' };
  }
  const duration = new RegExp(String.raw`\bfor\s+(${NUMBER_WORD})\s*(hours?|hrs?|minutes?|mins?)\b`, 'i').exec(text);
  const length = duration && amount(duration[1]) * (/^h/i.test(duration[2]) ? 60 : 1);
  text = cut(text, duration);
  const relative = new RegExp(String.raw`\b(?:due\s+)?in\s+(${NUMBER_WORD})\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\b`, 'i').exec(text);
  const today = midnight(now);
  let date;
  if (relative) {
    const unit = relative[2][0].toLowerCase(), n = amount(relative[1]);
    text = cut(text, relative);
    if (['s', 'm', 'h'].includes(unit)) {
      const start = now + n * { s: 1000, m: 60_000, h: 3600_000 }[unit];
      return Number.isFinite(+new Date(start)) ? { start, ...(length > 0 && { end: start + length * 60_000 }), allDay: false, rest: clean(text) } : null;
    }
    date = { day: addDays(today, n * (unit === 'w' ? 7 : 1)) };
  } else {
    date = findDate(text, today);
    text = cut(text, date.match);
  }
  if (Number.isNaN(date.day)) return null;

  const partMatch = /\b(?:(?:in the|this|at)\s+)?(morning|afternoon|evening|tonight)\b/i.exec(text);
  const partWord = partMatch?.[1].toLowerCase();
  const part = date.tonight || partWord === 'tonight' ? 'evening' : partWord;
  text = cut(text, partMatch);
  const clockNow = date.day == null ? timeAfter : now;
  const time = findTime(text, date.day, clockNow, part, date.match && date.match.index + date.match[0].length);
  if (time.minutes == null) return date.day == null ? null : { start: date.day, allDay: true, rest: clean(text) };
  const day = date.day ?? midnight(clockNow);
  let start = timeAt(day, time.minutes);
  if (date.day == null && start <= clockNow) start = timeAt(addDays(day, 1), time.minutes);
  const minutes = time.length ?? length;
  return { start, ...(minutes > 0 && { end: start + minutes * 60_000 }), allDay: false, rest: clean(cut(text, time.match)) };
}
