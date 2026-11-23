// Small iCalendar reader for the events and tasks we get from a calendar file or a CalDAV reply. It keeps just the
// fields we show; timezone names are resolved with Intl, so no date library is needed. Bad input yields what parsed.

// The first colon outside a quoted parameter value ends the property name and parameters.
function propertyColon(line) {
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quote = !quote;
    else if (line[i] === ':' && !quote) return i;
  }
  return -1;
}

function splitParams(head) {
  const parts = [];
  let start = 0, quote = false;
  for (let i = 0; i <= head.length; i++) {
    if (i < head.length && head[i] === '"') quote = !quote;
    if ((i === head.length || (head[i] === ';' && !quote))) {
      parts.push(head.slice(start, i));
      start = i + 1;
    }
  }
  return parts;
}

function readProperty(line) {
  const colon = propertyColon(line);
  if (colon < 0) return null;
  const pieces = splitParams(line.slice(0, colon));
  const name = pieces.shift().trim().toUpperCase();
  if (!name) return null;
  const params = {};
  for (const piece of pieces) {
    const eq = piece.indexOf('=');
    const key = (eq < 0 ? piece : piece.slice(0, eq)).trim().toUpperCase();
    if (!key) continue;
    let val = eq < 0 ? '' : piece.slice(eq + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { name, params, value: line.slice(colon + 1).trim() };
}

// RFC 5545 text: \n is a newline, \, \; and \\ stand for one literal character.
function unescape(value) {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\\' || i + 1 === value.length) { out += value[i]; continue; }
    const next = value[i + 1];
    if (next === 'n' || next === 'N') out += '\n';
    else if (next === ',' || next === ';' || next === '\\') out += next;
    else out += value[i] + next;
    i++;
  }
  return out;
}

function utcMs(year, month, day, hour, minute, second) {
  const d = new Date(0);
  d.setUTCFullYear(year, month, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

function localMs(year, month, day, hour, minute, second) {
  const d = new Date(0);
  d.setFullYear(year, month, day);
  d.setHours(hour, minute, second, 0);
  return d.getTime();
}

// Walk the guess until Intl reports the wall clock we asked for; two or three passes settle DST changes.
function zonedMs(year, month, day, hour, minute, second, zone) {
  const target = utcMs(year, month, day, hour, minute, second);
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch {
    return localMs(year, month, day, hour, minute, second);
  }
  const wall = (ms) => {
    const p = {};
    for (const part of fmt.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = part.value;
    let h = Number(p.hour);
    if (h === 24) h = 0; // some Intl builds say 24:00 for midnight
    return utcMs(Number(p.year), Number(p.month) - 1, Number(p.day), h, Number(p.minute), Number(p.second));
  };
  try {
    let guess = target;
    for (let i = 0; i < 3; i++) {
      const delta = target - wall(guess);
      if (!delta) break;
      guess += delta;
    }
    return guess;
  } catch {
    return localMs(year, month, day, hour, minute, second);
  }
}

function parseDate(value, params = {}) {
  const v = String(value ?? '').trim();
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (day) return new Date(localMs(+day[1], +day[2] - 1, +day[3], 0, 0, 0));
  const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(v);
  if (!time) return null;
  const [, y, mo, d, h, mi, s, z] = time;
  const year = +y, month = +mo - 1, date = +d, hour = +h, minute = +mi, second = +(s || 0);
  if (month < 0 || month > 11 || date < 1 || date > 31 || hour > 23 || minute > 59 || second > 59) return null;
  if (z) return new Date(utcMs(year, month, date, hour, minute, second));
  if (params.TZID) return new Date(zonedMs(year, month, date, hour, minute, second, params.TZID));
  return new Date(localMs(year, month, date, hour, minute, second));
}

function parseDuration(value) {
  const m = /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(value ?? '').trim());
  if (!m || (!m[2] && !m[3] && !m[4] && !m[5] && !m[6])) return null;
  const seconds = (+m[2] || 0) * 7 * 86400 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0);
  return (m[1] === '-' ? -1 : 1) * seconds * 1000;
}

function blankItem() {
  return {
    uid: null, summary: null, description: null, location: null, url: null,
    start: null, end: null, allDay: false, due: null, rrule: null, exdates: [],
    status: null, completed: null, lastModified: null,
  };
}

/** Parse an .ics document into { events, todos } with dates as JS Date instants. Missing fields are null. */
export function parseIcs(text) {
  const events = [], todos = [];
  if (typeof text !== 'string' || !text) return { events, todos };
  const lines = [];
  for (const line of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  const stack = [];
  let item = null, kind = null, duration = null;
  const finish = () => {
    if (!item) return;
    if (kind === 'VTODO') {
      // A todo's DURATION runs from DTSTART to when it's due; a todo has no end.
      if (duration !== null && item.start && !item.due) item.due = new Date(item.start.getTime() + duration);
    } else if (duration !== null && item.start && !item.end) item.end = new Date(item.start.getTime() + duration);
    // A date-only event with no DTEND occupies that one day: to the next local midnight, so a clock-change day
    // still ends at midnight.
    else if (item.allDay && item.start && !item.end) { const d = new Date(item.start); d.setDate(d.getDate() + 1); item.end = d; }
    if (kind === 'VEVENT') events.push(item);
    else if (kind === 'VTODO') todos.push(item);
    item = null; kind = null; duration = null;
  };
  try {
    for (const line of lines) {
      const begin = /^BEGIN:(.+)$/i.exec(line);
      if (begin) {
        const name = begin[1].trim().toUpperCase();
        stack.push(name);
        if (name === 'VEVENT' || name === 'VTODO') {
          finish();
          kind = name;
          item = blankItem();
        }
        continue;
      }
      const end = /^END:(.+)$/i.exec(line);
      if (end) {
        const name = end[1].trim().toUpperCase();
        const at = stack.lastIndexOf(name);
        if (at >= 0) stack.length = at;
        if (item && kind === name) finish();
        continue;
      }
      // Properties of a nested VALARM (or an unknown component) don't belong to the event or task.
      if (!item || stack[stack.length - 1] !== kind) continue;
      const prop = readProperty(line);
      if (!prop) continue;
      const value = prop.value;
      switch (prop.name) {
        case 'UID': item.uid = value || null; break;
        case 'SUMMARY': item.summary = value ? unescape(value) : null; break;
        case 'DESCRIPTION': item.description = value ? unescape(value) : null; break;
        case 'LOCATION': item.location = value ? unescape(value) : null; break;
        case 'URL': item.url = value || null; break;
        case 'STATUS': item.status = value || null; break;
        case 'RRULE': item.rrule = value || null; break;
        case 'DTSTART':
          item.start = parseDate(value, prop.params);
          if (prop.params.VALUE === 'DATE') item.allDay = true;
          break;
        case 'DTEND':
          item.end = parseDate(value, prop.params);
          if (prop.params.VALUE === 'DATE') item.allDay = true;
          break;
        case 'DUE':
          item.due = parseDate(value, prop.params);
          if (prop.params.VALUE === 'DATE') item.allDay = true;
          break;
        case 'DURATION': duration = parseDuration(value); break;
        case 'EXDATE':
          for (const part of value.split(',')) {
            const d = parseDate(part, prop.params);
            if (d) item.exdates.push(d);
          }
          break;
        case 'COMPLETED': item.completed = parseDate(value, prop.params); break;
        case 'LAST-MODIFIED': item.lastModified = parseDate(value, prop.params); break;
        default: break; // unknown properties are ignored
      }
    }
    finish();
  } catch {
    finish(); // a broken line can't lose the items already read
  }
  return { events, todos };
}

export default parseIcs;
