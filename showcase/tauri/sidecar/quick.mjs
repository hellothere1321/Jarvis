// Simple requests answered on this PC, with no model call: the time, a sum, a unit, a timer, a reminder, opening
// something, a web search, the list. match() only reads the words and returns { kind, args, reply } (or null, and
// the model gets the turn as before); run() does the matching one's work. Whole-utterance matches only: anything
// that isn't clearly one of these goes to the model.
import { fileURLToPath } from 'node:url';
import { siteAddress } from './browser.mjs';
import os from 'node:os';
import path from 'node:path';
import { addCommitment, parseDue, parseRepeat, repeatLabel } from './store.mjs';
import { SAFE, checkLink, checkOpen } from './safety.mjs';
import * as habits from './habits.mjs';

// ---------- the words ----------
const clean = (text) => {
  let s = String(text ?? '').normalize('NFKC').replace(/[‘’`]/g, "'").replace(/\s+/g, ' ').trim();
  if (!s || s.length > 220) return '';
  const strip = (x) => x.replace(/^[\s,!?;:]+|[\s,.!?;:]+$/g, '');
  s = strip(s);
  // "Hey Jarvis, can you please …" and "… for me, thanks": filler at either end.
  const lead = /^(?:hey|hi|hello|ok|okay|yo|so|jarvis|please|can you|could you|would you|will you|can i get you to|i need you to|i want you to|i'd like you to|go ahead and|just|kindly)\b[\s,]*/i;
  for (let i = 0; i < 6 && lead.test(s); i++) s = s.replace(lead, '');
  s = strip(s).replace(/\bwhats\b/i, "what's");
  const tail = /[\s,]+(?:please|for me|thanks|thank you|now|right now|real quick|quickly)$/i;
  for (let i = 0; i < 4 && tail.test(s); i++) s = strip(s.replace(tail, ''));
  return s;
};

const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90 };
const NUMWORD = `(?:${Object.keys(ONES).join('|')}|hundred)`;
const NUMWORDS = `${NUMWORD}(?:[ -]${NUMWORD})*`;
/** "twenty five" → 25, "a"/"an" → 1; NaN if it isn't a number. */
const wordsToNum = (s) => {
  const w = s.toLowerCase().split(/[ -]+/).filter(Boolean);
  if (w.length === 1 && (w[0] === 'a' || w[0] === 'an')) return 1;
  let n = 0;
  for (const x of w) {
    if (x === 'hundred') n = (n || 1) * 100;
    else if (x in ONES) n += ONES[x];
    else return NaN;
  }
  return w.length ? n : NaN;
};
const toNum = (s) => (/^-?[\d,]*\.?\d+$/.test(s) ? Number(s.replace(/,/g, '')) : wordsToNum(s));

const fmtNum = (n) => Number(n.toPrecision(10)).toLocaleString('en-US', { maximumFractionDigits: 6 });
const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
const clock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

// ---------- time, date, day ----------
const TIME = /^(?:what(?:'s| is) (?:the )?(?:current )?time(?: is it)?|what time is it|tell me (?:the )?(?:current )?time|the (?:current )?time|do you (?:have|know) the time|what time do you have)$/i;
const DATE = /^(?:what(?:'s| is) (?:the |today's )?(?:current )?date(?: today)?|what date is it(?: today)?|what is the date today|tell me (?:the|today's) date|(?:the |today's )date|what(?:'s| is) today|what is today's date)$/i;
const DAY = /^(?:what day (?:of the week )?is it(?: today)?|what(?:'s| is) the day(?: today| of the week)?|which day is it|what day is today|what day of the week is it)$/i;

// ---------- maths ----------
// A small evaluator over numbers, + - * / ^, brackets, sqrt and cbrt: no eval, no Function.
function evaluate(src) {
  const t = src.match(/\d+(?:\.\d+)?|\.\d+|sqrt|cbrt|[()+\-*/^]/g);
  if (!t || t.length > 60 || t.join('') !== src.replace(/\s+/g, '')) return null;
  let i = 0, depth = 0;
  const fail = () => { throw new Error('bad'); };
  const atom = () => {
    const x = t[i++];
    if (x === undefined) fail();
    if (/^[\d.]/.test(x)) return Number(x);
    if (x === '(') { if (++depth > 8) fail(); const v = sum(); if (t[i++] !== ')') fail(); depth--; return v; }
    if (x === '-') return -power();
    if (x === 'sqrt' || x === 'cbrt') { const v = power(); if (x === 'sqrt' && v < 0) fail(); return x === 'sqrt' ? Math.sqrt(v) : Math.cbrt(v); }
    return fail();
  };
  const power = () => { const a = atom(); if (t[i] === '^') { i++; const b = power(); if (Math.abs(b) > 1000) fail(); return a ** b; } return a; };
  const product = () => { let v = power(); while (t[i] === '*' || t[i] === '/') { const op = t[i++], b = power(); v = op === '*' ? v * b : v / b; } return v; };
  const sum = () => { let v = product(); while (t[i] === '+' || t[i] === '-') { const op = t[i++], b = product(); v = op === '+' ? v + b : v - b; } return v; };
  try {
    const v = sum();
    return i === t.length && Number.isFinite(v) ? v : null;
  } catch { return null; }
}

function mathMatch(s) {
  let w = s.replace(/^(?:what(?:'s| is| are)|how much is|calculate|compute|work out|evaluate|solve|tell me)\s+(?:the )?/i, '').replace(/\s*(?:=|equals)$/i, '').trim();
  if (!w) return null;
  const pct = /^(-?[\d,]*\.?\d+)\s*(?:%|percent|per cent)\s+of\s+(-?[\d,]*\.?\d+)$/i.exec(w);
  if (pct) {
    const v = (toNum(pct[1]) * toNum(pct[2])) / 100;
    return Number.isFinite(v) ? { kind: 'math', args: { expr: w }, reply: `${fmtNum(toNum(pct[1]))}% of ${fmtNum(toNum(pct[2]))} is ${fmtNum(v)}.` } : null;
  }
  const hadWords = /[a-z]/i.test(w);
  let x = w.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');
  // Number words become digits ("twelve times seven"), then the operator words become symbols.
  x = x.replace(new RegExp(`\\b${NUMWORDS}\\b`, 'g'), (m) => { const n = wordsToNum(m); return Number.isNaN(n) ? m : String(n); });
  x = x.replace(/square root of|sqrt of|√/g, ' sqrt ').replace(/cube root of/g, ' cbrt ')
    .replace(/to the power of|\*\*/g, ' ^ ').replace(/(\S)\s+squared\b/g, '$1 ^ 2').replace(/(\S)\s+cubed\b/g, '$1 ^ 3')
    .replace(/\b(?:multiplied by|times)\b|×/g, ' * ').replace(/(\d)\s*x\s*(?=[\d(])/g, '$1 * ')
    .replace(/\b(?:divided by|over)\b|÷/g, ' / ').replace(/\bplus\b/g, ' + ').replace(/\bminus\b/g, ' - ');
  if (!/[+\-*/^]|sqrt|cbrt/.test(x) || !/\d/.test(x)) return null;
  if (!hadWords && !/^[\d(.-]/.test(x.trim())) return null;
  const v = evaluate(x.trim());
  if (v === null) return null;
  return { kind: 'math', args: { expr: w }, reply: `${w[0].toUpperCase()}${w.slice(1)} is ${fmtNum(v)}.` };
}

// ---------- units ----------
const UNITS = {};
const unit = (cat, to, one, many, ...aliases) => { for (const a of [one, many, ...aliases]) UNITS[a] = { cat, to, one, many }; };
unit('length', 0.001, 'millimeter', 'millimeters', 'mm', 'millimetre', 'millimetres');
unit('length', 0.01, 'centimeter', 'centimeters', 'cm', 'centimetre', 'centimetres');
unit('length', 1, 'meter', 'meters', 'm', 'metre', 'metres');
unit('length', 1000, 'kilometer', 'kilometers', 'km', 'kilometre', 'kilometres');
unit('length', 0.0254, 'inch', 'inches');
unit('length', 0.3048, 'foot', 'feet', 'ft');
unit('length', 0.9144, 'yard', 'yards', 'yd', 'yds');
unit('length', 1609.344, 'mile', 'miles', 'mi');
unit('mass', 0.001, 'gram', 'grams', 'g');
unit('mass', 1e-6, 'milligram', 'milligrams', 'mg');
unit('mass', 1, 'kilogram', 'kilograms', 'kg', 'kilo', 'kilos');
unit('mass', 0.028349523125, 'ounce', 'ounces', 'oz');
unit('mass', 0.45359237, 'pound', 'pounds', 'lb', 'lbs');
unit('mass', 6.35029318, 'stone', 'stone');
unit('volume', 0.001, 'milliliter', 'milliliters', 'ml', 'millilitre', 'millilitres');
unit('volume', 1, 'liter', 'liters', 'l', 'litre', 'litres');
unit('volume', 0.00492892159375, 'teaspoon', 'teaspoons', 'tsp');
unit('volume', 0.01478676478125, 'tablespoon', 'tablespoons', 'tbsp');
unit('volume', 0.0295735295625, 'fluid ounce', 'fluid ounces', 'fl oz', 'floz');
unit('volume', 0.2365882365, 'cup', 'cups');
unit('volume', 0.473176473, 'pint', 'pints');
unit('volume', 0.946352946, 'quart', 'quarts');
unit('volume', 3.785411784, 'gallon', 'gallons', 'gal');
for (const [one, many, ...a] of [['degree Celsius', 'degrees Celsius', 'celsius', 'c', '°c', 'degrees c', 'degree c', 'centigrade'],
  ['degree Fahrenheit', 'degrees Fahrenheit', 'fahrenheit', 'f', '°f', 'degrees f', 'degree f'], ['kelvin', 'kelvin', 'k']]) {
  for (const x of [one.toLowerCase(), many.toLowerCase(), ...a]) UNITS[x] = { cat: 'temp', one, many, id: one[0] === 'k' ? 'k' : one.includes('Cel') ? 'c' : 'f' };
}
const UNIT_RE = Object.keys(UNITS).sort((a, b) => b.length - a.length).map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const CNUM = '-?[\\d,]*\\.?\\d+|an?|one|half';
const toTemp = (v, id) => (id === 'c' ? v : id === 'f' ? ((v - 32) * 5) / 9 : v - 273.15);
const fromTemp = (c, id) => (id === 'c' ? c : id === 'f' ? (c * 9) / 5 + 32 : c + 273.15);

function convertMatch(s) {
  let m = new RegExp(`^(?:convert |what(?:'s| is) |how much is )?(${CNUM})\\s*(${UNIT_RE}) (?:to|in|into|as|equals?|is in) (${UNIT_RE})$`, 'i').exec(s);
  let n, a, b;
  if (m) [n, a, b] = [m[1], m[2], m[3]];
  else if ((m = new RegExp(`^how many (${UNIT_RE}) (?:are |is )?(?:there )?in (${CNUM}) ?(${UNIT_RE})$`, 'i').exec(s))) [n, a, b] = [m[2], m[3], m[1]];
  else return null;
  const from = UNITS[a.toLowerCase()], to = UNITS[b.toLowerCase()];
  const v = /^half$/i.test(n) ? 0.5 : toNum(n.toLowerCase());
  if (!from || !to || from.cat !== to.cat || !Number.isFinite(v)) return null;
  let out;
  if (from.cat === 'temp') out = fromTemp(toTemp(v, from.id), to.id);
  else out = (v * from.to) / to.to;
  if (!Number.isFinite(out)) return null;
  const r = Number(out.toPrecision(10));
  return { kind: 'convert', args: { value: v, from: from.one, to: to.one }, reply: `${fmtNum(v)} ${plural(v, from.one, from.many)} is ${fmtNum(r)} ${plural(r, to.one, to.many)}.` };
}

// ---------- durations, clock times ----------
const DUR_UNIT = '(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)';
const DUR_ONE = `(?:\\d+(?:\\.\\d+)?|${NUMWORDS}|an?)\\s*${DUR_UNIT}`;
const DUR_RE = new RegExp(`^(?:half an hour|${DUR_ONE}(?:(?:\\s*(?:,|and))?\\s*${DUR_ONE})*)$`, 'i');
const SECS = { s: 1, m: 60, h: 3600 };
/** "10 minutes", "an hour and a half"-free: "1 hour 30 minutes", "half an hour" → seconds, or null. */
function parseSpan(text) {
  const s = text.trim().toLowerCase();
  if (!DUR_RE.test(s)) return null;
  if (s === 'half an hour') return 1800;
  let total = 0;
  for (const [, n, u] of s.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?|${NUMWORDS}|an?)\\s*(${DUR_UNIT})`, 'g'))) {
    const v = toNum(n);
    if (!Number.isFinite(v)) return null;
    total += v * SECS[u[0]];
  }
  return total >= 1 && total <= 86400 ? Math.round(total) : null;
}
const spanLabel = (secs) => {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), r = secs % 60;
  return [h && `${h} ${plural(h, 'hour')}`, m && `${m} ${plural(m, 'minute')}`, r && `${r} ${plural(r, 'second')}`].filter(Boolean).join(' ');
};

const DAYNAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY = '(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?';
const dayIndex = (w) => DAYNAMES.findIndex((d) => d.startsWith(w.toLowerCase().slice(0, 3)));
const HOURWORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const CLOCK = `noon|midnight|(?:\\d{1,2}|${HOURWORD})(?::\\d{2})?(?:\\s*(?:a\\.?m\\.?|p\\.?m\\.?|o'?clock))?`;
const REPEAT = `every day|daily|every weekday|weekdays|every weekend|weekends|every week|weekly|every month|monthly|every ${WEEKDAY}s?`;
const WHEN = new RegExp(`^(?:(${REPEAT})\\s+)?(?:(today|tonight|tomorrow|(?:on |next )?${WEEKDAY})\\s+)?(at\\s+)?(${CLOCK})(?:\\s+(today|tonight|tomorrow|(?:on |next )?${WEEKDAY}))?$`, 'i');
const repeatWords = (spec) => ({ daily: 'every day', weekdays: 'every weekday', weekly: 'every week', monthly: 'every month', 'sat,sun': 'every weekend' }[spec]
  ?? (/^[a-z]{3}$/.test(spec) ? `every ${DAYNAMES[dayIndex(spec)][0].toUpperCase()}${DAYNAMES[dayIndex(spec)].slice(1)}` : repeatLabel(spec)));
const pad = (n) => String(n).padStart(2, '0');
const localIso = (d, h, m) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(h)}:${pad(m)}`;

/** "in 20 minutes", "at 5pm", "tomorrow at 9", "every weekday at 8:30" → { dueMs, repeat, when }, or null. */
function parseWhen(text, now) {
  const s = text.trim();
  const rel = /^in\s+(.+)$/i.exec(s);
  if (rel) {
    const secs = parseSpan(rel[1]);
    const due = secs && parseDue(`in ${secs}s`, now.getTime());
    return due ? { dueMs: due, repeat: null, when: `in ${spanLabel(secs)}` } : null;
  }
  const m = WHEN.exec(s);
  if (!m) return null;
  const [, rep, day1, at, clk, day2] = m;
  if (day1 && day2) return null;
  const day = (day1 || day2 || '').toLowerCase().replace(/^(on|next) /, ''), isNext = /next /i.test(day1 || day2 || '');
  let h, min = 0, mer = null;
  const cm = /^(noon|midnight)$/i.exec(clk);
  if (cm) { h = cm[1].toLowerCase() === 'noon' ? 12 : 0; mer = 'x'; } else {
    const p = /^(\d{1,2}|[a-z]+)(?::(\d{2}))?\s*(a|p|o)?/i.exec(clk.toLowerCase());
    h = /^\d/.test(p[1]) ? Number(p[1]) : ONES[p[1]];
    min = p[2] ? Number(p[2]) : 0;
    mer = p[3] ?? null;
    // A bare number needs "at" ("buy milk 2" isn't a time).
    if (!at && !mer && !p[2]) return null;
  }
  if (h === undefined || h > 23 || min > 59 || (mer === 'a' || mer === 'p') && (h < 1 || h > 12)) return null;
  const explicitDay = !!day || !!rep;
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const at24 = (hour) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, min);
  const when = (d) => d.getTime();
  let due;
  if (mer === 'x') due = at24(h);
  else if (mer === 'p') due = at24(h === 12 ? 12 : h + 12);
  else if (mer === 'a') due = at24(h === 12 ? 0 : h);
  else if (h > 12 || h === 0) due = at24(h);
  else if (day === 'tonight') due = at24(h === 12 ? 0 : h + 12);
  else if (explicitDay) due = at24(h <= 6 || h === 12 ? (h === 12 ? 12 : h + 12) : h);
  else {
    // "at 5" with no am or pm and no day: the next time the clock reads that.
    const c = [at24(h % 12), at24((h % 12) + 12)].filter((d) => when(d) > now.getTime());
    due = c.length ? c[0] : at24(h % 12);
    if (!c.length) due.setDate(due.getDate() + 1);
  }
  const addDays = (d, n) => { d.setDate(d.getDate() + n); return d; };
  let label = '';
  if (day === 'tomorrow') { addDays(due, 1); label = 'tomorrow'; }
  else if (day === 'today' || day === 'tonight') { if (when(due) <= now.getTime()) return null; label = ''; }
  else if (day) {
    const want = dayIndex(day);
    if (want < 0) return null;
    let ahead = (want - now.getDay() + 7) % 7;
    if (ahead === 0 && (isNext || when(due) <= now.getTime())) ahead = 7;
    addDays(due, ahead); label = `on ${DAYNAMES[want][0].toUpperCase()}${DAYNAMES[want].slice(1)}`;
  } else if (when(due) <= now.getTime()) { addDays(due, 1); label = 'tomorrow'; }
  const dueMs = parseDue(localIso(due, due.getHours(), due.getMinutes()), now.getTime());
  if (!dueMs || dueMs <= now.getTime() - 1000) return null;
  let repeat = null;
  if (rep) { const r = parseRepeat(rep.toLowerCase()); if (!r) return null; repeat = r.spec; }
  const phrase = repeat ? `${repeatWords(repeat)} at ${clock(due)}` : `${label ? `${label} ` : ''}at ${clock(due)}`;
  return { dueMs, repeat, when: phrase };
}

// ---------- timers and reminders ----------
function timerMatch(s) {
  const m = /^(?:(?:set|start|make|create)\s+)?(?:an? |the )?(?:timer|countdown)(?: for| of)?\s+(.+)$/i.exec(s)
    ?? /^(?:(?:set|start|make|create)\s+)?(?:an? )?(.+?)[ -](?:timer|countdown)$/i.exec(s);
  if (!m) return null;
  // "10 minute timer": the unit is singular there.
  const secs = parseSpan(m[1].replace(/^(\d+(?:\.\d+)?|\w+)[ -](second|minute|hour)$/i, '$1 $2'));
  if (!secs) return null;
  const label = spanLabel(secs);
  return { kind: 'timer', args: { secs, text: `Your timer for ${label} is up.` }, reply: `Timer set for ${label}.` };
}

const VAGUE = /^(?:it|that|this|something|stuff|things?|about\b.*|of\b.*|the (?:thing|stuff)\b.*|what i (?:said|told you)\b.*)$/i;
function reminderMatch(s, now) {
  let r = /^remind me (.+)$/i.exec(s)?.[1];
  if (!r) {
    const a = /^set (?:a )?reminder to (.+)$/i.exec(s), b = /^set (?:a )?reminder for ((?:in|at|tomorrow|tonight|today|on|every) .+)$/i.exec(s);
    r = a ? `to ${a[1]}` : b?.[1];
  }
  if (!r) return null;
  let task, when;
  if (/^to /i.test(r)) {
    // "to call mum at 5pm": the shortest task that leaves a time on the end.
    const words = r.slice(3).split(' ');
    for (let i = 1; i < words.length && !when; i++) {
      const w = parseWhen(words.slice(i).join(' '), now);
      if (w) { when = w; task = words.slice(0, i).join(' '); }
    }
  } else {
    // "in 20 minutes to call mum": the first " to " that follows a time.
    for (let from = 0, j; !when && (j = r.toLowerCase().indexOf(' to ', from)) >= 0; from = j + 1) {
      const w = parseWhen(r.slice(0, j), now);
      if (w) { when = w; task = r.slice(j + 4); }
    }
  }
  task = task?.trim().replace(/[.,!?\s]+$/, '');
  if (!when || !task || task.length < 2 || task.length > 120 || VAGUE.test(task)) return null;
  return { kind: 'reminder', args: { text: task, dueMs: when.dueMs, repeat: when.repeat }, reply: `Okay, I'll remind you to ${task} ${when.when}.` };
}

// ---------- the list ----------
const LIST = /^(?:(?:show|open|pull up|bring up|display|view|see|check)(?: me)? (?:my|the) (?:list|to-?do list|todo list|to-?dos|reminders)|what(?:'s| is| are) on my (?:list|to-?do list|todo list|reminders)|what are my (?:reminders|to-?dos)|show (?:the |my )?list)$/i;

// ---------- habits ----------
const HABIT_LIST = /^(?:(?:show|open|pull up|bring up|display|view|see|check)(?: me)? (?:my|the) habits|what(?:'s| is| are) on my habits|list habits|show habits|habits)$/i;
const HABIT_ADD = /^(?:(?:add|new|create|track|start)(?: a)? habit (?:to |for )?(.+)|habit add (.+))$/i;
const HABIT_CHECK = /^(?:(?:check|tick|done|complete)(?: off)? habit (.+)|habit (?:check|tick|done) (.+))$/i;
const HABIT_UNCHECK = /^(?:(?:uncheck|untick|undo) habit (.+)|habit (?:uncheck|untick|undo) (.+))$/i;

// ---------- opening things and searching ----------
const SITES = { youtube: 'https://www.youtube.com', gmail: 'https://mail.google.com', github: 'https://github.com', reddit: 'https://www.reddit.com',
  netflix: 'https://www.netflix.com', google: 'https://www.google.com', wikipedia: 'https://www.wikipedia.org', twitter: 'https://twitter.com',
  facebook: 'https://www.facebook.com', instagram: 'https://www.instagram.com', linkedin: 'https://www.linkedin.com', amazon: 'https://www.amazon.com',
  chatgpt: 'https://chatgpt.com' };
const FOLDERS = { downloads: 'Downloads', documents: 'Documents', desktop: 'Desktop', pictures: 'Pictures', music: 'Music', videos: 'Videos', movies: 'Movies', home: '' };
// A "web address" ending like a file ("setup.exe", "run.sh") is a file, not a site: left to the model.
const FILE_TLD = /^(?:exe|bat|cmd|ps1|sh|js|mjs|py|rb|pl|msi|dll|lnk|jar|scr|vbs|txt|pdf|docx?|xlsx?|pptx?|zip|png|jpe?g|gif|mp[34]|json|md|csv|log|dmg|pkg|iso|deb|rpm)$/i;
const NOT_APP = /\b(?:the|a|an|my|your|our|that|this|these|those|it|them|file|files|folder|document|documents|doc|docs|last|recent|latest|previous|one|thing|things|stuff|something|everything|again|there|here|all|same|other|another|tab|tabs|window|windows|page|link|new|up|down|and|or|to|for|with|in|on|at|of)\b/i;
const OPEN_V = '(?:open|launch|fire up|pull up|bring up)';
const SEARCH_ON = { youtube: 'https://www.youtube.com/results?search_query=', amazon: 'https://www.amazon.com/s?k=', wikipedia: 'https://en.wikipedia.org/w/index.php?search=',
  github: 'https://github.com/search?q=', reddit: 'https://www.reddit.com/search/?q=', maps: 'https://www.google.com/maps/search/', google: 'https://www.google.com/search?q=' };
const SEARCH_BAD = /\b(?:my|mine|i was|i had|i've|file|files|folder|document|documents|computer|pc|laptop|here|this|that|these|those|it|them|me)\b|^(?:is|was|are|were|has|have|had|does|do|did|can|will|would|should|could|maps|drive|docs|photos|chrome|calendar|translate|at|up|results?|history|engine|bar|box|index|query|page)\b/i;

function openMatch(s, { home, platform }) {
  const gt = /^(?:go to|take me to|navigate to|visit)\s+(.+)$/i.exec(s);
  const m = new RegExp(`^${OPEN_V}\\s+(.+)$`, 'i').exec(s);
  const rest = (m?.[1] ?? gt?.[1] ?? '').replace(/^["']|["']$/g, '').trim();
  if (!rest) return null;
  const site = (url, label) => ({ kind: 'open', args: { target: url, type: 'url', label }, reply: `Opening ${label}.` });
  // Said aloud: "skool dot com", "you tube dot com slash shorts".
  const spoken = /\bdot\b/i.test(rest) ? siteAddress(rest) : null;
  if (spoken && !FILE_TLD.test(new URL(spoken).hostname.split('.').pop())) return site(spoken, new URL(spoken).hostname.replace(/^www\./i, ''));
  const dom = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+([a-z]{2,24}))(?:[/?#]\S*)?$/i.exec(rest);
  if (dom && !FILE_TLD.test(dom[2])) return site(/^https?:/i.test(rest) ? rest : `https://${rest}`, dom[1].replace(/^www\./i, ''));
  const known = SITES[rest.toLowerCase().replace(/\.com$/, '').replace(/^the /, '')];
  if (known && !/[ ]/.test(rest)) return site(known, rest.toLowerCase().replace(/\.com$/, ''));
  if (gt) return null;
  const f = /^(?:the |my )?(downloads|documents|desktop|pictures|music|videos|movies|home)(?: folder| directory)?$/i.exec(rest);
  if (f && (/folder|directory/i.test(rest) || /^(?:the |my )?(?:downloads|documents)$/i.test(rest))) {
    const key = f[1].toLowerCase(), name = key === 'videos' && platform === 'darwin' ? 'Movies' : FOLDERS[key];
    return { kind: 'open', args: { target: name ? path.join(home, name) : home, type: 'path', label: `your ${key} folder` }, reply: `Opening your ${key} folder.` };
  }
  if (/^(?:~[\\/]|\/|[a-z]:[\\/])/i.test(rest)) return { kind: 'open', args: { target: rest, type: 'path', label: rest }, reply: `Opening ${rest}.` };
  const app = /^(?:the )?([a-z0-9][a-z0-9 +&'-]{0,30})$/i.exec(rest)?.[1]?.trim();
  if (!app || NOT_APP.test(app) || app.split(' ').length > 4 || /^(?:folder|file|document)/i.test(app)) return null;
  return { kind: 'open', args: { target: app, type: 'app', label: app }, reply: `Opening ${app}.` };
}

function searchMatch(s) {
  let on, q;
  let m = /^(?:search|look)(?: up| for)?\s+(?:on )?(youtube|amazon|wikipedia|github|reddit|maps|google)\s+for\s+(.+)$/i.exec(s);
  if (m) [on, q] = [m[1], m[2]];
  else if ((m = /^(?:(?:search|look)(?: up| for)?|google|lookup|search the web for|search online for|search google for)\s+(.+?)\s+(?:on|in|at)\s+(youtube|amazon|wikipedia|github|reddit|maps|google)$/i.exec(s))) [q, on] = [m[1], m[2]];
  else if ((m = /^(?:search the web for|search online for|search google for|search for|search up|search|google|look up|lookup)\s+(.+)$/i.exec(s))) [on, q] = ['google', m[1]];
  else return null;
  q = q.replace(/^(?:for|about) /i, '').trim();
  if (q.length < 2 || q.length > 100 || SEARCH_BAD.test(q)) return null;
  on = on.toLowerCase();
  const url = SEARCH_ON[on] + encodeURIComponent(q);
  return { kind: 'search', args: { target: url, type: 'url', label: `${q} on ${on}` }, reply: `Searching ${on === 'google' ? '' : `${on} `}for ${q}.` };
}

// ---------- matching ----------
/** text → { kind, args, reply } for a request clear enough to answer here, else null. No side effects. */
export function match(text, { now = new Date(), home = os.homedir(), platform = process.platform } = {}) {
  const s = clean(text);
  if (!s) return null;
  if (TIME.test(s)) return { kind: 'time', args: {}, reply: `It's ${clock(now)}.` };
  if (DAY.test(s)) return { kind: 'day', args: {}, reply: `It's ${DAYNAMES[now.getDay()][0].toUpperCase()}${DAYNAMES[now.getDay()].slice(1)}.` };
  if (DATE.test(s)) return { kind: 'date', args: {}, reply: `Today is ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.` };
  if (LIST.test(s)) return { kind: 'list', args: {}, reply: "Here's your list." };
  if (HABIT_LIST.test(s)) return { kind: 'habit-list', args: {}, reply: "Here are your habits." };
  let hm;
  if ((hm = HABIT_ADD.exec(s))) return { kind: 'habit-add', args: { title: (hm[1] ?? hm[2] ?? '').trim() }, reply: `Added the habit ${(hm[1] ?? hm[2] ?? '').trim()}.` };
  if ((hm = HABIT_CHECK.exec(s))) return { kind: 'habit-check', args: { name: (hm[1] ?? hm[2] ?? '').trim() }, reply: `Checked off ${(hm[1] ?? hm[2] ?? '').trim()}.` };
  if ((hm = HABIT_UNCHECK.exec(s))) return { kind: 'habit-uncheck', args: { name: (hm[1] ?? hm[2] ?? '').trim() }, reply: `Unchecked ${(hm[1] ?? hm[2] ?? '').trim()}.` };
  return timerMatch(s) ?? reminderMatch(s, now) ?? searchMatch(s) ?? openMatch(s, { home, platform }) ?? convertMatch(s) ?? mathMatch(s);
}

// ---------- safety for opening ----------
const BARE_ADDRESS = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;
const expandHome = (t, home) => (/^~(?=$|[\\/])/.test(t) ? path.join(home, t.slice(1)) : t);
/** The checks the `open` tool makes, in the same order: a bare address is a link, a file: link a path, then
 *  checkOpen (and checkLink for web links). → { level, reason, target }; only SAFE may be opened. */
export function checkTarget(target, home = os.homedir(), { executable = false } = {}) {
  let t = String(target ?? '').trim();
  if (BARE_ADDRESS.test(t) && !/\.app$/i.test(t)) t = `https://${t}`;
  if (/^file:\/\//i.test(t)) { try { t = fileURLToPath(t); } catch { /* not a local file link: checkOpen refuses it */ } }
  t = expandHome(t, home);
  const v = checkOpen(t, home, { executable });
  if (v.level === SAFE && /^https?:/i.test(t)) { const l = checkLink(t); if (l.level !== SAFE) return { ...l, target: t }; }
  return { ...v, target: t };
}

// ---------- doing it ----------
/**
 * Carries out a match. deps: say(line) shows and speaks a line; open(target, type) opens it and says whether it
 * worked; showList(); onReminder(c) after a reminder is saved; stat(path) for paths; home. Returns true when the
 * turn is answered, false when the model should have it after all (a path that isn't there, an app that won't open).
 */
export async function run(m, deps) {
  const say = (line) => { deps.say?.(line); return true; };
  switch (m.kind) {
    case 'time': case 'date': case 'day': case 'math': case 'convert': return say(m.reply);
    case 'list': deps.showList?.(); return say(m.reply);
    case 'habit-list': {
      deps.showHabits?.();
      const rows = habits.view(deps.now ?? Date.now());
      return say(rows.length ? rows.map((h) => `${h.title} (${h.doneToday ? 'done' : h.dueToday ? 'due' : 'not scheduled'})`).join(', ') : 'No habits yet.');
    }
    case 'habit-add': {
      const title = String(m.args.title ?? '').trim();
      if (!title) return false;
      try { const h = await habits.add({ title }, deps.now ?? new Date()); deps.onHabit?.(h); } catch (e) { return say(String(e?.message ?? e)); }
      return say(m.reply);
    }
    case 'habit-check': case 'habit-uncheck': {
      const name = String(m.args.name ?? '').trim();
      if (!name) return false;
      const all = habits.list();
      const found = all.find((h) => h.id === name || h.title.toLowerCase() === name.toLowerCase()) ||
        all.find((h) => h.title.toLowerCase().includes(name.toLowerCase()));
      if (!found) return say(`No habit matching ${name}.`);
      try { await habits.checkIn(found.id, { done: m.kind === 'habit-check', now: deps.now ?? new Date() }); deps.onHabit?.(found); } catch (e) { return say(String(e?.message ?? e)); }
      return say(m.reply);
    }
    case 'timer': case 'reminder': {
      const c = await addCommitment(m.args.text, m.kind === 'timer' ? Date.now() + m.args.secs * 1000 : m.args.dueMs, 'reminder', m.args.repeat);
      deps.onReminder?.(c);
      return say(m.reply);
    }
    case 'open': case 'search': {
      const home = deps.home ?? os.homedir();
      const isPath = m.args.type === 'path';
      const st = isPath ? await Promise.resolve(deps.stat?.(expandHome(m.args.target, home))).catch(() => null) : null;
      const v = checkTarget(m.args.target, home, { executable: !!(st?.isFile?.() && (st.mode & 0o111) !== 0) });
      // A refused target is said so here; a path that isn't there is the model's to explain.
      if (v.level !== SAFE) return say(v.reason);
      if (isPath && !st) return false;
      if (!(await deps.open?.(v.target, m.args.type))) return false;
      return say(m.reply);
    }
    default: return false;
  }
}

/** The whole thing for a turn: true when it was answered here, false when it goes to the model. */
export async function quick(text, deps = {}) {
  const m = match(text, { now: deps.now ?? new Date(), home: deps.home, platform: deps.platform });
  if (!m) return false;
  try { return await run(m, deps); } catch (e) { console.error('quick', e); return false; }
}
