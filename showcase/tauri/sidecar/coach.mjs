// Habits and coach: evening rollover, due-tonight escalation, morning brief, Sunday review, as Roamie nudges.
// Quiet hours are honored; each nudge fires once per day (state in Data/coach.json).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DIR, readJson, writeJson } from './store.mjs';
import { isQuiet, timeMinutes } from './quiet.mjs';
import * as planner from './planner.mjs';
import * as timelog from './timelog.mjs';
import * as nudgeMod from './nudge.mjs';

const file = path.join(DIR, 'coach.json');

let sayFn = (t) => {};
export function setSay(fn) { sayFn = typeof fn === 'function' ? fn : sayFn; }
export function getSay() { return sayFn; }

function loadState() {
  try {
    const data = readJson(file);
    if (data && typeof data === 'object') return { roll: '', week: '', esc: {}, ...data, esc: data.esc ?? {} };
  } catch {}
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') return { roll: '', week: '', esc: {}, ...parsed, esc: parsed.esc ?? {} };
    }
  } catch {}
  return { roll: '', week: '', esc: {} };
}
async function saveState(st) {
  try { await writeJson(file, st); } catch {}
}

function nowDate(now) {
  return now instanceof Date ? new Date(now.getTime()) : new Date(now);
}
export function dayKey(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function dateOnly(v) {
  const dt = v instanceof Date ? new Date(v.getTime()) : new Date(v);
  dt.setHours(0, 0, 0, 0);
  return dt;
}
function sameDay(a, b) { return dateOnly(a).getTime() === dateOnly(b).getTime(); }

export function timeReached(hhmm, now) {
  const t = timeMinutes(typeof hhmm === 'string' ? hhmm.trim() : hhmm);
  if (t == null) return false;
  const d = now instanceof Date ? now : new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= t;
}
export function escStep(now) {
  const d = now instanceof Date ? now : new Date(now);
  const h = d.getHours();
  return h >= 21 ? 3 : h >= 20 ? 2 : h >= 18 ? 1 : 0;
}
export function weekStart(d) {
  const dt = d instanceof Date ? new Date(d.getTime()) : new Date(d);
  dt.setHours(0, 0, 0, 0);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return d instanceof Date ? dt : dt.getTime();
}
export function left(min) {
  const m = Number(min) || 0;
  if (m >= 90) {
    const v = m / 60;
    return `${v.toFixed(1).replace(/\.0$/, '')} h left`;
  }
  return `${m} min left`;
}
export function dueWord(due, now) {
  const dueD = dateOnly(due), nowD = dateOnly(now);
  const diff = Math.round((dueD.getTime() - nowD.getTime()) / 86400000);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'due today';
  if (diff === 1) return 'due tomorrow';
  return 'due ' + dueD.toLocaleDateString('en-US', { weekday: 'long' });
}
export function titleTime(title) {
  const m = String(title ?? '').match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  const min = m[2] ? Number(m[2]) : 0;
  if (/pm/i.test(m[3])) h += 12;
  if (h >= 24 || min >= 60) return null;
  return h * 60 + min; // minutes since midnight
}
export function dueTonight(t, now) {
  if (!t || t.kind !== 'task' || t.done || t.deleted) return false;
  if (t.spent) return false;
  if (t.blockFor) return false;
  const nowD = dateOnly(now);
  if (t.start != null) return sameDay(t.start, nowD);
  return /\btonight\b/i.test(String(t.title ?? ''));
}
export function doneOn(t, day) {
  if (!t || t.kind !== 'task' || t.deleted) return false;
  const dayD = dateOnly(day);
  if (t.done && t.updated != null && sameDay(t.updated, dayD)) return true;
  if (t.lastDone != null && sameDay(t.lastDone, dayD)) return true;
  return false;
}
export function hours(sec) {
  const s = Number(sec) || 0;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  const v = s / 3600;
  return `${v.toFixed(1).replace(/\.0$/, '')} h`;
}

function quietConfig(s) { return nudgeMod.quietConfig(s); }
function isQuietNow(s, now) { return nudgeMod.Quiet(s, now instanceof Date ? now : new Date(now)); }

function liveItems() { return planner.list({ includeDone: true }); }
function openTasks() { return planner.list({ kind: 'task' }); }

function estimateFor(task) {
  if (!task) return 0;
  const est = task.est > 0 ? task.est : defaultMinutes(kindOf(task.title));
  return Math.max(0, est - (task.spent || 0));
}
function kindOf(title) {
  const t = String(title ?? '').toLowerCase();
  const has = (...w) => w.some((x) => new RegExp('\\b' + x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(t));
  if (has('quiz', 'quizzes')) return 'quiz';
  if (has('exam', 'midterm', 'final', 'test')) return 'exam';
  if (has('essay', 'paper', 'report', 'write-up', 'thesis', 'draft')) return 'essay';
  if (has('read', 'reading', 'readings', 'chapter', 'textbook')) return 'reading';
  if (has('lab', 'labs')) return 'lab';
  if (has('project', 'presentation', 'slides')) return 'project';
  if (has('code', 'coding', 'bug', 'fix', 'implement', 'build', 'repo', 'commit', 'pr')) return 'code';
  if (has('discussion', 'post', 'forum', 'reply', 'respond')) return 'discussion';
  if (has('homework', 'hw', 'assignment', 'worksheet', 'problem set', 'pset')) return 'homework';
  return 'other';
}
function defaultMinutes(kind) {
  return { quiz: 45, exam: 180, essay: 180, reading: 45, lab: 120, homework: 60, project: 240, code: 90, discussion: 30 }[kind] ?? 30;
}

// ---------- gather ----------
function gather(now) {
  const all = liveItems();
  const done = all.filter((t) => doneOn(t, now)).sort((a, b) => String(a.title).localeCompare(String(b.title)));
  const slipping = all.filter((t) => t.kind === 'task' && !t.done && t.start != null && dateOnly(t.start).getTime() <= dateOnly(now).getTime() + 86400000)
    .sort((a, b) => (a.start - b.start) || (b.priority - a.priority));
  const moved = [];
  const tomorrow = dateOnly(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowEnd = new Date(tomorrow.getTime()); tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);
  const events = planner.list({ kind: 'event', from: tomorrow.getTime(), to: tomorrowEnd.getTime() }).sort((a, b) => a.start - b.start);
  let tomorrowStr = null;
  const ev = events.find((e) => !e.allDay);
  if (ev) tomorrowStr = `${new Date(ev.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · ${ev.title}`;
  else {
    const task = all.filter((t) => t.kind === 'task' && !t.done && t.start != null && sameDay(t.start, tomorrow)).sort((a, b) => b.priority - a.priority)[0];
    if (task) tomorrowStr = `${task.title} (due)`;
    else {
      const ad = events[0];
      if (ad) tomorrowStr = `${ad.title} · all day`;
    }
  }
  return { Done: done, Slipping: slipping, Moved: moved, Tomorrow: tomorrowStr };
}

export function rollMarkdown(now = Date.now()) {
  const nd = nowDate(now);
  const r = gather(nd);
  const sb = ['## Today', ''];
  if (r.Done.length > 0) {
    sb.push(`### Done (${r.Done.length})`);
    for (const t of r.Done.slice(0, 10)) sb.push(`• ${t.title}`);
  } else sb.push('Nothing ticked off today.');
  if (r.Slipping.length > 0) {
    sb.push('');
    sb.push(`### Slipping (${r.Slipping.length})`);
    for (const t of r.Slipping.slice(0, 8)) sb.push(`• ${slipLine(t, nd)}`);
  }
  if (r.Moved.length > 0) {
    sb.push('');
    sb.push('### Moved');
    for (const b of r.Moved.slice(0, 6)) sb.push(`• ${b.title}${b.start != null ? ' · now ' + new Date(b.start).toLocaleString() : ''}`);
  }
  if (r.Tomorrow != null) {
    sb.push('');
    sb.push('### Tomorrow starts with');
    sb.push(`• ${r.Tomorrow}`);
  }
  return sb.join('\n').trimEnd();
}
function slipLine(t, now) {
  const due = dueWord(t.start, now);
  const est = estimateFor(t);
  const mins = est;
  const leftStr = mins >= 90 ? `${(mins / 60).toFixed(1).replace(/\.0$/, '')} h left` : `${mins} min left`;
  return `${t.title} ${due} · ${leftStr}`;
}

function showRollover(now, notice) {
  const r = gather(now);
  if (r.Done.length === 0 && r.Slipping.length === 0) return;
  const sec = r.Slipping.length > 0 ? slipLine(r.Slipping[0], now) : (r.Tomorrow != null ? 'Tomorrow: ' + r.Tomorrow : '');
  const title = `Today: ${r.Done.length} done · ${r.Slipping.length} slipping`;
  nudgeMod.Show('coach-roll', title, sec, { ttl: 3 * 3600_000 });
  notice(title);
}

export function weekMarkdown(now = Date.now()) {
  const nd = nowDate(now);
  const all = liveItems();
  const from = weekStart(nd);
  const fromDate = from instanceof Date ? from : new Date(from);
  const byList = new Map();
  const apps = new Map();
  let taskSec = 0, appSec = 0;
  const entries = timelog.list();
  for (let d = new Date(fromDate.getTime()); d.getTime() <= nd.getTime(); d.setDate(d.getDate() + 1)) {
    const dk = dayKey(d);
    for (const e of entries) {
      if (dayKey(e.start) !== dk) continue;
      const mins = Number(e.minutes) || 0;
      const sec = mins * 60;
      if (e.itemId) {
        const it = all.find((x) => x.id === e.itemId);
        const listName = it ? (String(it.cat || '').trim() || 'Tasks') : 'Other';
        byList.set(listName, (byList.get(listName) || 0) + sec);
        taskSec += sec;
      }
      if (e.app) {
        apps.set(e.app, (apps.get(e.app) || 0) + sec);
        appSec += sec;
      }
    }
  }
  const sb = ['## Your week', '', '### Hours by list'];
  if (byList.size === 0) sb.push('No tracked task time yet.');
  for (const [k, v] of [...byList.entries()].sort((a, b) => b[1] - a[1])) {
    sb.push(`• ${k} · ${hours(v)}`);
  }
  if (appSec > taskSec && apps.size > 0) {
    sb.push('');
    sb.push(`### Not on a task (${hours(appSec - taskSec)}) · top apps`);
    for (const [k, v] of [...apps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      sb.push(`• ${k} · ${hours(v)}`);
    }
  }
  const fromMs = fromDate.getTime();
  const done = all.filter((t) => t.kind === 'task' && !t.deleted && (
    (t.done && t.updated != null && dateOnly(t.updated).getTime() >= fromMs && dateOnly(t.updated).getTime() <= nd.getTime()) ||
    (t.lastDone != null && dateOnly(t.lastDone).getTime() >= fromMs && dateOnly(t.lastDone).getTime() <= nd.getTime())
  ));
  sb.push('');
  sb.push(`### Done this week (${done.length})`);
  for (const t of done.slice(0, 10)) sb.push(`• ${t.title}`);
  const next = all.filter((t) => t.kind === 'task' && !t.done && !t.deleted && t.start != null && dateOnly(t.start).getTime() > nd.getTime() && dateOnly(t.start).getTime() <= nd.getTime() + 7 * 86400000)
    .sort((a, b) => a.start - b.start);
  sb.push('');
  sb.push(`### Due next week (${next.length})`);
  for (const t of next.slice(0, 10)) sb.push(`• ${t.title} · ${new Date(t.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`);
  let outlook = null;
  try { outlook = null; } catch {}
  if (outlook) {
    sb.push('');
    sb.push('### Grades');
    sb.push(String(outlook).trim());
  }
  return sb.join('\n').trimEnd();
}

export function morningBrief(now = Date.now()) {
  const nd = nowDate(now);
  const sb = [`## ${nd.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`];
  const tasks = openTasks();
  const due = tasks.filter((t) => t.start != null && dateOnly(t.start).getTime() <= nd.getTime());
  if (due.length > 0) {
    sb.push('');
    sb.push('### Due today');
    for (const t of due.slice(0, 6)) {
      const overdue = dateOnly(t.start).getTime() < nd.getTime() ? ' · overdue' : '';
      sb.push(`• ${t.title}${overdue} · ${left(estimateFor(t))}`);
    }
  }
  const from = nd.getTime(); // midnight? nd is now not midnight. Need midnight for occurrences.
  const midnight = dateOnly(now).getTime();
  const nextDay = midnight + 86400000;
  const occ = planner.occurrences(midnight, nextDay).filter((o) => (o.allDay ? dateOnly(o.start).getTime() === midnight : o.start >= midnight));
  const blocks = occ.filter((o) => o.blockFor);
  const events = occ.filter((o) => !o.blockFor);
  if (blocks.length > 0) {
    sb.push('');
    sb.push('### Work blocks');
    for (const o of blocks.slice(0, 6)) sb.push(`• ${new Date(o.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}–${new Date(o.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · ${o.title}`);
  }
  if (events.length > 0) {
    sb.push('');
    sb.push('### On your calendar');
    for (const o of events.slice(0, 6)) sb.push(`• ${o.allDay ? 'all day' : new Date(o.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · ${o.title}`);
  }
  let pick = null;
  try { pick = nowPick(nd); } catch {}
  if (pick) sb.push(`\n### Start with\n• ${pick.title} · ${left(estimateFor(pick))}`);
  const ready = [];
  if (ready.length > 0) {
    sb.push('');
    sb.push('### Ready from overnight');
    for (const l of ready.slice(0, 5)) sb.push(`• ${l}`);
  }
  const other = tasks.length - due.length;
  if (other > 0) sb.push(`\n${other} other open task${other === 1 ? '' : 's'}`);
  return sb.join('\n').trimEnd();
}
function nowPick(now) {
  const tasks = openTasks().filter((t) => t.start != null).sort((a, b) => a.start - b.start);
  return tasks[0] ?? null;
}

export function tryLocal(l, s) {
  const text = String(l ?? '').trim();
  if (/^(?:how (?:did i do|did today go|was my day)(?: today)?|how'?s my day going)$/i.test(text)) {
    return rollMarkdown(Date.now());
  }
  if (/^(?:(?:give me |show me |do )?(?:a |my |the )?(?:weekly|week) (?:review|recap|summary)|how was my week|how did my week go|how did i do this week)$/i.test(text)) {
    return weekMarkdown(Date.now());
  }
  return null;
}

// ---------- tick ----------
export async function tick(settings, now = Date.now(), options = {}) {
  const s = settings ?? {};
  const nd = nowDate(now);
  const say = typeof options.say === 'function' ? options.say : sayFn;
  const notice = options.notice ?? (() => {});
  if (isQuietNow(s, nd)) return;
  const st = loadState();
  let changed = false;
  const key = dayKey(nd);
  // clean old escalation records
  for (const k of Object.keys(st.esc)) {
    if (!k.startsWith(key)) { delete st.esc[k]; changed = true; }
  }
  const rolloverSpec = s.rollover ?? s.Rollover;
  if (rolloverSpec && timeReached(rolloverSpec, nd) && st.roll !== key) {
    st.roll = key; changed = true;
    showRollover(nd, notice);
  }
  if (nd.getDay() === 0 && nd.getHours() >= 18 && st.week !== key) {
    st.week = key; changed = true;
    showWeek(nd, notice);
  }
  if (s.escalate || s.Escalate) {
    const escChanged = escalate(s, nd, st, say, notice);
    if (escChanged) changed = true;
  }
  if (changed) await saveState(st);
}
function showWeek(now, notice) {
  const due = openTasks().filter((t) => t.start != null && dateOnly(t.start).getTime() > dateOnly(now).getTime() && dateOnly(t.start).getTime() <= dateOnly(now).getTime() + 7 * 86400000).length;
  const message = `${due} tasks due next week.`;
  nudgeMod.Show('coach-week', 'Your week', message, { ttl: 4 * 3600_000 });
  notice(message);
}
function escalate(s, now, st, say, notice) {
  let changed = false;
  const step = escStep(now);
  if (step <= 0) return false;
  const speakReplies = s.speakReplies ?? s.SpeakReplies ?? 'short';
  for (const t of openTasks().filter((x) => dueTonight(x, now))) {
    const k = `${dayKey(now)}|${t.id}`;
    if ((st.esc[k] ?? 0) >= step) continue;
    st.esc[k] = step; changed = true;
    const tm = titleTime(t.title);
    const when = tm != null ? ' at ' + formatTime(ndFromMinutes(tm)) : '';
    const message = `${t.title} is due tonight${when} and you haven't started it.`;
    if (step === 1) {
      nudgeMod.Show('coach-esc-' + t.id, message, '', { ttl: 2 * 3600_000 });
      notice(message);
    } else if (speakReplies !== 'off') {
      say(message);
    }
  }
  return changed;
}
function ndFromMinutes(mins) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setMinutes(mins); return d;
}
function formatTime(d) {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ---------- aliases ----------
export const Tick = tick;
export const RollMarkdown = rollMarkdown;
export const WeekMarkdown = weekMarkdown;
export const MorningBrief = morningBrief;
export const TryLocal = tryLocal;
export const TimeReached = timeReached;
export const EscStep = escStep;
export const WeekStart = weekStart;
export const Left = left;
export const DueWord = dueWord;
export const TitleTime = titleTime;
export const DueTonight = dueTonight;
export const DoneOn = doneOn;
export const Hours = hours;
export const DayKey = dayKey;
export { nudgeMod as Nudge };
export * from './nudge.mjs';
