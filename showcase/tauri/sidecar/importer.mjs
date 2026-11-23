// Brings the data of the old VowenLite app (Windows, C#) into this one: planner, time log, inbox, calendar feeds,
// saved logins, chats, meeting notes and a few settings. scan() is the dry run (counts only, never item text or
// secrets); run() imports what was chosen. Everything is written through the modules that own the data (planner,
// timelog, inbox, feeds, vault, store sessions), never by editing their files, and the VowenLite folders are only read.
// Data/import-vowenlite.json remembers what came across (by VowenLite's own ids), so a second run adds nothing.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { roamiesDir } from './datadir.mjs';
import { DIR, flushWrites, newSession, readJson, saveSession, writeJson } from './store.mjs';
import * as planner from './planner.mjs';
import * as timelog from './timelog.mjs';
import * as inbox from './inbox.mjs';
import { createFeeds } from './feeds.mjs';
import { runInput } from './secrets.mjs';
import { timeMinutes } from './quiet.mjs';

export const KINDS = ['planner', 'timelog', 'inbox', 'feeds', 'vault', 'threads', 'meetings', 'settings'];
const SOURCE = 'vowenlite';
/** An error whose message is a plain sentence the panel may show. */
export class ImportError extends Error { name = 'ImportError'; }
const RECORD = path.join(DIR, 'import-vowenlite.json');
const WEEK = 7 * 864e5;
const TICKS_AT_EPOCH = 621355968000000000;

// ---------- where it is ----------
/** The VowenLite folders, or null (not Windows, or no data folder). meetingsDir is null when there are no meeting notes. */
export function findVowenLite({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform !== 'win32') return null;
  const dir = (p) => { try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; } };
  const dataDir = env.VOWENLITE_DATA || path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'VowenLite');
  if (!dir(dataDir)) return null;
  const docs = [env.VOWENLITE_MEETINGS, ...[env.OneDrive, env.OneDriveConsumer].filter(Boolean).map((o) => path.join(o, 'Documents', 'VowenLite', 'Meetings')),
    path.join(home, 'Documents', 'VowenLite', 'Meetings'), path.join(home, 'OneDrive', 'Documents', 'VowenLite', 'Meetings')];
  return { dataDir, meetingsDir: docs.find(dir) ?? null };
}

// ---------- reading the source (fs only: store.readJson would move a damaged file aside) ----------
const BOM = /^﻿/;
function readSource(ctx, name) {
  let text;
  try { text = fs.readFileSync(path.join(ctx.paths.dataDir, name), 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') ctx.problems.push(`${name} could not be read`); return null; }
  try { return JSON.parse(text.replace(BOM, '')); }
  catch { ctx.problems.push(`${name} is damaged and was skipped`); return null; }
}
function readList(ctx, name) {
  const data = readSource(ctx, name);
  if (data == null) return null;
  if (!Array.isArray(data)) { ctx.problems.push(`${name} is not a list and was skipped`); return null; }
  return data;
}
const str = (v) => (typeof v === 'string' ? v : '');
const ms = (v) => { const t = v == null ? NaN : Date.parse(v); return Number.isFinite(t) && t > 0 ? t : null; };
const count = (v, fallback = 0) => (Number.isSafeInteger(v) && v >= 0 ? v : fallback);
const hash = (...parts) => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------- the record of what was imported ----------
const EMPTY = () => ({ version: 1, lastRun: null, planner: {}, timelog: {}, inbox: {}, feeds: {}, vault: {}, threads: {}, meetings: {}, settings: null, googleClient: false });
function loadRecord() {
  const saved = readJson(RECORD);
  const record = EMPTY();
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    for (const key of ['planner', 'timelog', 'inbox', 'feeds', 'vault', 'threads', 'meetings']) {
      if (saved[key] && typeof saved[key] === 'object' && !Array.isArray(saved[key])) record[key] = saved[key];
    }
    record.lastRun = typeof saved.lastRun === 'number' ? saved.lastRun : null;
    record.settings = typeof saved.settings === 'number' ? saved.settings : null;
    record.googleClient = saved.googleClient === true;
  }
  return record;
}
const saveRecord = (record) => writeJson(RECORD, record);

// ---------- planner ----------
const plannerOf = (record) => {
  const byOld = new Map(Object.entries(record.planner));
  try { for (const item of planner.syncItems()) if (item.source === SOURCE && item.uid && !byOld.has(item.uid)) byOld.set(item.uid, item.id); } catch {}
  return byOld;
};

function planPlanner(ctx) {
  const rows = readList(ctx, 'planner.json');
  const plan = { found: 0, todo: [], linked: 0 };
  if (!rows) return plan;
  const have = plannerOf(ctx.record);
  let bad = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object' || r.Deleted) continue;
    // Feed items come back when the feed is refreshed; work blocks are rebuilt by the planner.
    if (str(r.Source).startsWith('feed:') || r.BlockFor) continue;
    const id = str(r.Id), title = str(r.Title).trim();
    const kind = r.Kind === 'event' ? 'event' : 'task';
    const start = ms(r.Start);
    let end = ms(r.End);
    if (!id || !title || (kind === 'event' && start == null)) { bad++; continue; }
    if (end != null && start != null && end <= start) end = null;
    plan.found++;
    if (r.GId) plan.linked++;
    if (have.has(id)) continue;
    plan.todo.push({
      id, done: kind === 'task' && r.Done === true,
      // Keep the Google link, so connecting Google here matches these items instead of adding them a second time.
      google: r.GId ? { gId: str(r.GId), gList: str(r.GList) || null, updated: ms(r.Updated) ?? 0 } : null,
      values: {
        kind, title, notes: str(r.Notes), start, end, allDay: r.AllDay === true, alert: count(r.Alert, 10),
        repeat: str(r.Repeat).trim() || null, skip: (Array.isArray(r.Skip) ? r.Skip : []).map(ms).filter((t) => t != null),
        cat: str(r.Cat).trim(), priority: Math.min(3, count(r.Priority)), est: count(r.Est), spent: count(r.Spent),
        link: str(r.Link), source: SOURCE, uid: id,
      },
    });
  }
  if (bad) ctx.problems.push(`${plural(bad, 'planner item')} had no title or date and can't be imported`);
  if (plan.linked) ctx.notes.push(`${plural(plan.linked, 'planner item')} ${plan.linked === 1 ? 'is' : 'are'} already in Google. If you connect Google here too, they'll be matched up, not added twice.`);
  return plan;
}

async function runPlanner(ctx, plan) {
  const out = { added: 0, already: plan.found - plan.todo.length, failed: 0 };
  for (const { id, values, done, google } of plan.todo) {
    let item = null;
    try { item = await planner.add(values); }
    catch {
      // A repeat rule this app can't read: keep the item, drop the repeat.
      try { item = await planner.add({ ...values, repeat: null, skip: [] }); } catch { item = null; }
    }
    if (!item) { out.failed++; continue; }
    ctx.record.planner[id] = item.id;
    out.added++;
    if (done && !item.repeat) await planner.complete(item.id).catch(() => {});
    if (google) {
      await planner.applySync((items) => {
        const saved = items.find((entry) => entry.id === item.id);
        if (saved) Object.assign(saved, { ...google, dirty: false });
      }).catch(() => {});
    }
  }
  return out;
}

// ---------- time log ----------
const dayStart = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

function planTimelog(ctx) {
  const log = readSource(ctx, 'timelog.json');
  const plan = { found: 0, todo: [] };
  if (log == null) return plan;
  if (typeof log !== 'object' || Array.isArray(log)) { ctx.problems.push('timelog.json is not in the expected shape and was skipped'); return plan; }
  const titles = new Map();
  for (const r of readList({ ...ctx, problems: [] }, 'planner.json') ?? []) if (r && str(r.Id)) titles.set(r.Id, str(r.Title).trim().slice(0, 120));
  for (const [day, info] of Object.entries(log)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(dayStart(day))) continue;
    const entries = [];
    for (const [oldId, seconds] of Object.entries(info?.Tasks && typeof info.Tasks === 'object' ? info.Tasks : {})) {
      const minutes = Math.round(Number(seconds) / 60);
      if (Number.isFinite(minutes) && minutes >= 1) entries.push({ oldId, title: titles.get(oldId) ?? '', minutes });
    }
    plan.found += entries.length;
    if (entries.length && !ctx.record.timelog[day]) plan.todo.push({ day, entries });
  }
  return plan;
}

async function runTimelog(ctx, plan) {
  const out = { added: 0, already: plan.found - plan.todo.reduce((n, d) => n + d.entries.length, 0), failed: 0 };
  const known = plannerOf(ctx.record);
  for (const { day, entries } of plan.todo) {
    let ok = true;
    const start = dayStart(day);
    for (const e of entries) {
      try {
        await timelog.append({ itemId: known.get(e.oldId) ?? null, title: e.title, start, end: start + e.minutes * 60_000, minutes: e.minutes });
        out.added++;
      } catch { out.failed++; ok = false; }
    }
    if (ok) ctx.record.timelog[day] = 1;
  }
  return out;
}

// ---------- inbox ----------
function planInbox(ctx) {
  const rows = readList(ctx, 'inbox.json');
  const plan = { found: 0, todo: [] };
  for (const r of rows ?? []) {
    const id = str(r?.Id), title = str(r?.Title).trim();
    if (!id || !title) continue;
    plan.found++;
    if (!ctx.record.inbox[id]) plan.todo.push({ id, title });
  }
  return plan;
}

async function runInbox(ctx, plan) {
  const out = { added: 0, already: plan.found - plan.todo.length, failed: 0 };
  for (const { id, title } of plan.todo) {
    try {
      const item = await inbox.capture(title);
      ctx.record.inbox[id] = item?.id ?? 'duplicate';
      if (item) out.added++; else out.already++;
    } catch { out.failed++; }
  }
  return out;
}

// ---------- calendar feeds ----------
const WEB = /^(?:https?|webcals?):\/\/\S+$/i;

function planFeeds(ctx) {
  const settings = ctx.settings();
  const plan = { found: 0, todo: [], name: '' };
  if (!settings) return plan;
  plan.name = str(settings.FeedList).trim().slice(0, 60);
  let local = 0;
  const seen = new Set();
  for (const raw of Array.isArray(settings.Feeds) ? settings.Feeds : []) {
    const url = str(raw).trim();
    if (!url) continue;
    if (!WEB.test(url)) { local++; continue; }
    const key = hash(url.replace(/^webcals?:/i, 'https:'));
    if (seen.has(key)) continue;
    seen.add(key);
    plan.found++;
    if (!ctx.record.feeds[key]) plan.todo.push({ key, url });
  }
  if (local) ctx.problems.push(`${plural(local, 'calendar feed')} ${local === 1 ? 'is a file on this PC' : 'are files on this PC'} and can't be imported`);
  return plan;
}

async function runFeeds(ctx, plan) {
  const out = { added: 0, already: plan.found - plan.todo.length, failed: 0 };
  const feeds = ctx.opts.feeds ?? createFeeds();
  for (const { key, url } of plan.todo) {
    try {
      const feed = await feeds.add({ name: plan.name, url });
      ctx.record.feeds[key] = feed.id;
      out.added++;
    } catch (e) {
      if (/already added/i.test(String(e?.message))) { ctx.record.feeds[key] = 'existing'; out.already++; } else out.failed++;
    }
  }
  return out;
}

// ---------- saved logins (DPAPI → this app's vault) ----------
// One PowerShell run opens every blob: blob, salt and site come in on stdin as JSON, the opened bytes go back on
// stdout as base64. The entropy is the one Vault.cs builds: salt + "vowenlite-vault:" + site.
const UNPROTECT = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$rows=[Console]::In.ReadToEnd() | ConvertFrom-Json
$out=New-Object System.Collections.ArrayList
foreach ($r in $rows) {
  try {
    $salt=[Convert]::FromBase64String($r.salt)
    $entropy=[byte[]]($salt + [Text.Encoding]::UTF8.GetBytes('vowenlite-vault:' + $r.site))
    $plain=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($r.blob),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [void]$out.Add([Convert]::ToBase64String($plain))
  } catch { [void]$out.Add($null) }
}
[Console]::Out.Write((ConvertTo-Json -InputObject @($out.ToArray()) -Compress))`;

function planVault(ctx) {
  const rows = readList(ctx, 'vault.json');
  const plan = { found: 0, todo: [] };
  if (!rows) return plan;
  let expired = 0;
  for (const e of rows) {
    if (!e || typeof e !== 'object') continue;
    if (!str(e.Blob) || !str(e.Salt) || !str(e.Site)) { expired++; continue; }
    plan.found++;
    const key = hash(e.Site, str(e.Host), str(e.User));
    if (!ctx.record.vault[key]) plan.todo.push({ key, entry: e });
  }
  if (expired) ctx.problems.push(`${plural(expired, 'saved login')} ${expired === 1 ? 'has' : 'have'} expired in VowenLite and can't be imported`);
  return plan;
}

// "v1|<utc ticks>|<password>" → the save time and the password, or null.
function unpack(bytes) {
  const text = bytes.toString('utf8');
  const a = text.indexOf('|'), b = a < 0 ? -1 : text.indexOf('|', a + 1);
  if (b < 0 || text.slice(0, a) !== 'v1') return null;
  const ticks = Number(text.slice(a + 1, b));
  if (!Number.isFinite(ticks) || ticks <= 0) return null;
  return { saved: (ticks - TICKS_AT_EPOCH) / 1e4, password: text.slice(b + 1) };
}

async function runVault(ctx, plan) {
  const out = { added: 0, already: plan.found - plan.todo.length, failed: 0, expired: 0 };
  if (!plan.todo.length) return out;
  const vault = ctx.opts.vault;
  if (!vault) { ctx.problems.push("The password vault isn't available here, so saved logins were not imported"); out.failed = plan.todo.length; return out; }
  const exec = ctx.opts.exec ?? runInput;
  let opened;
  try {
    const input = JSON.stringify(plan.todo.map(({ entry }) => ({ blob: entry.Blob, salt: entry.Salt, site: entry.Site })));
    const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', UNPROTECT], input, 60_000);
    opened = r.code === 0 ? JSON.parse(String(r.stdout).trim()) : null;
  } catch { opened = null; }
  if (!Array.isArray(opened) || opened.length !== plan.todo.length) opened = plan.todo.map(() => null);
  let have = [];
  try { have = await vault.list(); } catch {}
  for (let i = 0; i < plan.todo.length; i++) {
    const { key, entry } = plan.todo[i];
    let bytes = null, parsed = null;
    try {
      bytes = typeof opened[i] === 'string' ? Buffer.from(opened[i], 'base64') : null;
      parsed = bytes && unpack(bytes);
      if (!parsed || !parsed.password) { out.failed++; continue; }
      if (Date.now() >= parsed.saved + WEEK) { out.expired++; continue; }
      const host = (str(entry.Host) || str(entry.Site)).trim().toLowerCase();
      if (have.some((row) => row.site === host && row.username === str(entry.User))) { ctx.record.vault[key] = 'existing'; out.already++; continue; }
      const id = await vault.save({ address: host, username: str(entry.User), password: parsed.password });
      ctx.record.vault[key] = id;
      out.added++;
    } catch { out.failed++; }
    finally { bytes?.fill(0); if (parsed) parsed.password = ''; opened[i] = null; }
  }
  if (out.failed) ctx.problems.push(`${plural(out.failed, 'saved login')} could not be read`);
  if (out.expired) ctx.problems.push(`${plural(out.expired, 'saved login')} ${out.expired === 1 ? 'was' : 'were'} older than a week and left out`);
  return out;
}

// ---------- chats ----------
const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function planThreads(ctx) {
  const rows = readList(ctx, 'threads.json');
  const plan = { found: 0, todo: [] };
  for (const t of rows ?? []) {
    const id = str(t?.Id);
    const messages = [];
    for (const turn of Array.isArray(t?.Turns) ? t.Turns : []) {
      const q = str(turn?.Q).trim(), a = str(turn?.A).trim();
      if (q && a) messages.push({ role: 'user', content: q }, { role: 'assistant', content: [{ type: 'text', text: a }] });
    }
    if (!id || !messages.length) continue;
    plan.found++;
    if (!ctx.record.threads[id]) plan.todo.push({ id, messages, at: ms(t.Updated) ?? Date.now() });
  }
  return plan;
}

async function runThreads(ctx, plan) {
  const out = { added: 0, already: plan.found - plan.todo.length, failed: 0 };
  for (const { id, messages, at } of plan.todo) {
    try {
      const when = new Date(at);
      const session = {
        ...newSession(null, null), id: `${stamp(when)}-${randomBytes(3).toString('hex')}`,
        startedAt: at, lastActiveAt: at, messages, importedFrom: SOURCE,
      };
      await saveSession(session);
      ctx.record.threads[id] = session.id;
      out.added++;
    } catch { out.failed++; }
  }
  return out;
}

// ---------- meeting notes ----------
const MEETING_DIR = /^(\d{4}-\d{2}-\d{2})[_ ](\d{2})-?(\d{2})$/;
const LINE = /^\[(?:(\d+):)?(\d{1,2}):(\d{2})\]\s+(You|Others):\s*(.*)$/;

// transcript.md ("[mm:ss] You: text") → the segments transcript.json holds.
export function parseTranscript(text) {
  const rows = [];
  for (const line of text.replace(BOM, '').split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m || !m[5].trim()) continue;
    rows.push({ start: Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]), track: m[4] === 'You' ? 'mic' : 'system', text: m[5].trim() });
  }
  return rows.map((r, i) => ({ ...r, end: Math.max(r.start, rows[i + 1]?.start ?? r.start + 3) }));
}

const meetingsRoot = () => path.join(roamiesDir(), 'Meetings');
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

function planMeetings(ctx) {
  const plan = { found: 0, todo: [] };
  const root = ctx.paths.meetingsDir;
  if (!root) return plan;
  let names = [], odd = 0;
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { ctx.problems.push('The meetings folder could not be read'); return plan; }
  for (const name of names) {
    const m = MEETING_DIR.exec(name);
    if (!m) { odd++; continue; }
    const folder = path.join(root, name);
    const transcript = readText(path.join(folder, 'transcript.md'));
    const segments = transcript ? parseTranscript(transcript) : [];
    const summary = readText(path.join(folder, 'summary.md'));
    if (!segments.length && !summary?.trim()) continue; // audio only: nothing to carry over
    plan.found++;
    if (!ctx.record.meetings[name]) plan.todo.push({ name, id: `${m[1]} ${m[2]}${m[3]}`, segments, summary });
  }
  if (odd) ctx.problems.push(`${plural(odd, 'meeting folder')} had an unfamiliar name and ${odd === 1 ? 'was' : 'were'} left out`);
  return plan;
}

async function runMeetings(ctx, plan) {
  const out = { added: 0, already: plan.found - plan.todo.length, failed: 0 };
  const root = meetingsRoot();
  for (const { name, id, segments, summary } of plan.todo) {
    try {
      const target = path.join(root, id);
      if (fs.existsSync(target)) { ctx.record.meetings[name] = id; out.already++; continue; }
      // Written beside the others, then renamed in one step, so a half-copied meeting never shows in the list.
      const tmp = path.join(root, `.import-${randomBytes(4).toString('hex')}`);
      fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
      try {
        if (segments.length) fs.writeFileSync(path.join(tmp, 'transcript.json'), JSON.stringify({ segments }), { mode: 0o600 });
        if (summary?.trim()) fs.writeFileSync(path.join(tmp, 'summary.md'), summary, { mode: 0o600 });
        fs.renameSync(tmp, target);
      } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
      ctx.record.meetings[name] = id;
      out.added++;
    } catch { out.failed++; }
  }
  return out;
}

// ---------- settings ----------
/** What carries over from settings.json: quiet hours, distractions, the names list and dictation on/off. */
export function settingsPatch(s) {
  const patch = {};
  if (!s || typeof s !== 'object') return patch;
  if (typeof s.QuietHours === 'string') {
    const text = s.QuietHours.trim();
    const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(text);
    if (!text) patch.quietHours = { on: false };
    else if (m) {
      const pad = (t) => t.padStart(5, '0');
      if (timeMinutes(pad(m[1])) != null && timeMinutes(pad(m[2])) != null) patch.quietHours = { on: true, start: pad(m[1]), end: pad(m[2]) };
    }
  }
  if (Array.isArray(s.Distractions)) {
    const list = [...new Set(s.Distractions.map((x) => str(x).trim().slice(0, 60)).filter(Boolean))].slice(0, 50);
    if (list.length) patch.distractions = list;
  }
  if (typeof s.Names === 'string') {
    const names = s.Names.split(/[,;\r\n]+/).map((x) => x.trim()).filter(Boolean);
    if (names.length) patch.names = names;
  }
  if (typeof s.Dictation === 'boolean') patch.voice = s.Dictation;
  return patch;
}

const CLIENT_LIMIT = 32_768;
function clientFile(ctx) {
  const text = readText(path.join(ctx.paths.dataDir, 'google-client.json'));
  if (!text || text.length > CLIENT_LIMIT) return null;
  try { const j = JSON.parse(text.replace(BOM, '')); return j && typeof j === 'object' && (j.installed || j.web) ? text : null; } catch { return null; }
}

function planSettings(ctx) {
  const patch = settingsPatch(ctx.settings());
  const client = clientFile(ctx);
  const found = Object.keys(patch).length + (client ? 1 : 0);
  const todo = (ctx.record.settings ? 0 : Object.keys(patch).length) + (client && !ctx.record.googleClient && !fs.existsSync(path.join(DIR, 'google-client.json')) ? 1 : 0);
  return { found, todo, patch, client };
}

async function runSettings(ctx, plan) {
  const out = { added: 0, already: plan.found - plan.todo, failed: 0 };
  const keys = Object.keys(plan.patch);
  if (keys.length && !ctx.record.settings) {
    if (!ctx.opts.applySettings) { ctx.problems.push("Settings can't be changed from here"); out.failed += keys.length; }
    else {
      try { await ctx.opts.applySettings(plan.patch); ctx.record.settings = Date.now(); out.added += keys.length; } catch { out.failed += keys.length; }
    }
  }
  const target = path.join(DIR, 'google-client.json');
  if (plan.client && !ctx.record.googleClient) {
    try {
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
      try { fs.writeFileSync(target, plan.client, { mode: 0o600, flag: 'wx' }); out.added++; } catch (e) { if (e.code !== 'EEXIST') throw e; }
      ctx.record.googleClient = true;
    } catch { out.failed++; }
  }
  return out;
}

// ---------- scan and run ----------
const PLANS = { planner: planPlanner, timelog: planTimelog, inbox: planInbox, feeds: planFeeds, vault: planVault, threads: planThreads, meetings: planMeetings, settings: planSettings };
const RUNS = { planner: runPlanner, timelog: runTimelog, inbox: runInbox, feeds: runFeeds, vault: runVault, threads: runThreads, meetings: runMeetings, settings: runSettings };
const newCount = (plan) => (Array.isArray(plan.todo) ? plan.todo.reduce((n, x) => n + (x.entries ? x.entries.length : 1), 0) : plan.todo);

function context(opts, kinds) {
  const paths = opts.paths ?? findVowenLite();
  if (!paths) throw new ImportError("VowenLite's data wasn't found on this PC.");
  const ctx = { paths, opts, record: loadRecord(), problems: [], notes: [] };
  let settings;
  ctx.settings = () => {
    if (settings === undefined) {
      const s = readSource(ctx, 'settings.json');
      settings = s && typeof s === 'object' && !Array.isArray(s) ? s : null;
    }
    return settings;
  };
  ctx.kinds = KINDS.filter((k) => kinds == null || kinds.includes(k));
  return ctx;
}

/** The dry run: how much there is of each kind and how much of it is new. Counts only, no item text, no secrets. */
export function scan(opts = {}) {
  const ctx = context(opts, null);
  const kinds = {};
  for (const kind of KINDS) {
    const plan = PLANS[kind](ctx);
    kinds[kind] = { found: plan.found, new: newCount(plan) };
  }
  return { kinds, problems: ctx.problems, notes: ctx.notes, lastRun: ctx.record.lastRun };
}

let running = null;
/** Imports the chosen kinds (all by default). `vault` and `applySettings` come from the app; `feeds` may too. */
export function run({ kinds = null, ...opts } = {}) {
  if (running) return Promise.reject(new ImportError('An import is already running.'));
  if (kinds != null && !Array.isArray(kinds)) return Promise.reject(new ImportError('Choose what to import.'));
  running = (async () => {
    const ctx = context(opts, kinds);
    const result = {};
    for (const kind of ctx.kinds) {
      const plan = PLANS[kind](ctx);
      try { result[kind] = await RUNS[kind](ctx, plan); }
      catch { result[kind] = { added: 0, already: 0, failed: newCount(plan) }; ctx.problems.push(`${kind} could not be imported`); }
      await saveRecord({ ...ctx.record, lastRun: Date.now() });
    }
    ctx.record.lastRun = Date.now();
    await saveRecord(ctx.record);
    await flushWrites();
    return { kinds: result, problems: ctx.problems, notes: ctx.notes, at: ctx.record.lastRun };
  })().finally(() => { running = null; });
  return running;
}
