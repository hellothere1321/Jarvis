// Meeting folders live beside Data. Only the panel gets the words from the transcript.
import fs from 'node:fs/promises';
import path from 'node:path';
import { baseDir } from './datadir.mjs';
import { buildLexicon, fixNames } from './lexicon.mjs';
import { ASK, BLOCK, SAFE, checkRead, checkWrite, classifyCommand } from './safety.mjs';
import { summariseTranscript } from './summarise.mjs';

const ID = /^\d{4}-\d{2}-\d{2} \d{4}(?:-\d+)?$/;
const FILES = new Set(['mic.wav', 'system.wav', 'transcript.json', 'transcript.json.tmp', 'transcription.pending', 'transcription.failed', 'summary.md', 'summary.md.tmp']);
const stamp = (date) => {
  const two = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}${two(date.getMinutes())}`;
};
const missing = (e) => { if (e.code !== 'ENOENT') throw e; return null; };
const stat = (p) => fs.lstat(p).catch(missing);
const check = (rule) => { if (rule.level === BLOCK) throw new Error(rule.reason); };

/** The user's names and words: one per line, at most 500, at most three words each. */
export function parseNames(value) {
  const lines = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : [];
  const out = [], seen = new Set();
  for (const line of lines) {
    const name = String(line ?? '').trim().replace(/\s+/g, ' ');
    if (!name || name.split(' ').length > 3) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length === 500) break;
  }
  return out;
}

export function createMeetings({ call, changed = () => {}, notify = () => {}, now = () => new Date(), base = baseDir(), names = () => [], model, chunkWords }) {
  base = path.resolve(base);
  const root = path.join(base, 'Roamies', 'Meetings');
  let active = null, switching = false;
  const progress = new Map(), offline = new Set(), summarising = new Set();

  async function checkRoot() {
    const real = await fs.realpath(root).catch(missing);
    if (!real) return false;
    if (path.relative(path.join(await fs.realpath(base), 'Roamies', 'Meetings'), real)) {
      throw new Error('The Meetings folder points outside its usual location.');
    }
    return true;
  }
  async function folderOf(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Choose a meeting from the list.');
    const folder = path.join(root, id);
    check(checkRead(folder, base));
    if (!await checkRoot()) throw new Error('Meeting not found.');
    const info = await stat(folder);
    if (!info?.isDirectory() || path.relative(await fs.realpath(root), await fs.realpath(folder)) !== id) {
      throw new Error('Meeting not found.');
    }
    return { folder, info };
  }
  async function file(folder, name) {
    const target = path.join(folder, name);
    check(checkRead(target, base));
    const info = await stat(target);
    if (!info?.isFile() || path.relative(await fs.realpath(folder), await fs.realpath(target)) !== name) return null;
    return info;
  }
  async function transcribing(folder) {
    if (!await file(folder, 'transcription.pending')) return false;
    const pid = Number(await fs.readFile(path.join(folder, 'transcription.pending'), 'utf8').catch(missing));
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try { return process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
  }
  async function row(id) {
    const { folder, info } = await folderOf(id);
    const wavs = await Promise.all([file(folder, 'mic.wav'), file(folder, 'system.wav')]);
    const duration = active === id ? Math.max(0, (now().getTime() - info.birthtimeMs) / 1000)
      : Math.max(0, (Math.max(...wavs.map((wav) => wav?.size ?? 44)) - 44) / 32000);
    const status = active === id ? 'recording' : progress.has(id) || await transcribing(folder) ? 'transcribing'
      : await file(folder, 'transcript.json') ? 'ready' : await file(folder, 'transcription.failed') ? 'failed' : 'audio_saved';
    return { id, folder, date: info.birthtime.toISOString(), duration, status, pct: progress.get(id), summary: !!(await file(folder, 'summary.md')) };
  }
  async function list() {
    check(checkRead(root, base));
    if (!await checkRoot()) return [];
    const entries = await fs.readdir(root, { withFileTypes: true });
    const rows = await Promise.all(entries.filter((e) => e.isDirectory() && ID.test(e.name)).map((e) => row(e.name).catch(() => null)));
    return rows.filter(Boolean).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  }
  async function summaryOf(folder) {
    if (!await file(folder, 'summary.md')) return null;
    return fs.readFile(path.join(folder, 'summary.md'), 'utf8');
  }
  async function summary(id) {
    const { folder } = await folderOf(id);
    return summaryOf(folder);
  }
  // Names are applied here, never to the saved transcript: changing the list fixes old meetings too.
  async function read(id, { summary: wantSummary = false } = {}) {
    const { folder } = await folderOf(id);
    if (!await file(folder, 'transcript.json')) throw new Error('This meeting has no transcript yet.');
    let fixed;
    try {
      const { segments } = JSON.parse(await fs.readFile(path.join(folder, 'transcript.json'), 'utf8'));
      if (!Array.isArray(segments) || !segments.every((s) => typeof s?.text === 'string' &&
          Number.isFinite(s.start) && s.start >= 0 && Number.isFinite(s.end) && s.end >= s.start &&
          ['mic', 'system'].includes(s.track))) throw new Error();
      const lexicon = buildLexicon(names());
      fixed = segments.map((s) => ({ ...s, text: fixNames(s.text, lexicon).text }));
    } catch {
      throw new Error('The transcript could not be read.');
    }
    return wantSummary ? { id, segments: fixed, summary: await summaryOf(folder) } : { id, segments: fixed };
  }
  // Only the panel's Summarise button (or an explicit request) gets here. The words go to the model and the panel,
  // never to a log; the result lands in summary.md in one rename, after every model call has succeeded.
  async function summarise(id) {
    if (summarising.has(id)) throw new Error('This meeting is already being summarised.');
    await folderOf(id);
    const { segments } = await read(id);
    summarising.add(id);
    changed();
    try {
      const markdown = await summariseTranscript({ segments, model, ...(chunkWords == null ? {} : { per: chunkWords }) });
      // The folder may have been removed or replaced while the model was working.
      const { folder } = await folderOf(id);
      const target = path.join(folder, 'summary.md'), tmp = path.join(folder, 'summary.md.tmp');
      for (const [p, exists] of [[target, !!(await file(folder, 'summary.md'))], [tmp, !!(await file(folder, 'summary.md.tmp'))]]) {
        const verdict = checkWrite(p, base, { exists, own: folder });
        check(verdict);
        if (verdict.level !== SAFE) throw new Error(verdict.reason);
      }
      await fs.writeFile(tmp, markdown, 'utf8');
      await fs.rename(tmp, target);
      changed();
      return markdown;
    } finally {
      summarising.delete(id);
      changed();
    }
  }
  async function remove(id, { confirm } = {}) {
    const { folder } = await folderOf(id);
    if (active === id || progress.has(id) || await transcribing(folder)) throw new Error('Wait until the meeting is finished.');
    const verdict = classifyCommand(`rm -r -- "${folder.replaceAll('\\', '/')}"`, base);
    check(verdict);
    if (verdict.level === ASK && !await confirm?.(verdict.reason)) return false;
    await folderOf(id);
    if (active === id || progress.has(id) || await transcribing(folder)) throw new Error('Wait until the meeting is finished.');
    const entries = await fs.readdir(folder, { withFileTypes: true });
    if (entries.some((e) => !FILES.has(e.name) || !e.isFile())) throw new Error('This meeting contains other files.');
    for (const entry of entries) await fs.unlink(path.join(folder, entry.name));
    await fs.rmdir(folder);
    changed();
    return true;
  }
  const idOf = (folder) => {
    if (typeof folder !== 'string') return null;
    const id = path.relative(root, folder);
    return ID.test(id) ? id : null;
  };
  function handle(m) {
    const id = idOf(m.folder);
    if (m.state === 'lost') {
      active = null;
      offline.clear();
      notify('The voice helper stopped. Check Meetings for the saved audio.', true);
    } else if (m.state === 'status' && m.ok) {
      active = id;
    } else if (id) {
      if (m.state === 'recording') { active = id; offline.clear(); }
      if (m.state === 'stopped') { active = null; offline.clear(); progress.set(id, 0); }
      if (m.state === 'device') {
        if (m.offline) offline.add(m.track); else offline.delete(m.track);
      }
      if (m.state === 'failed') { active = null; offline.clear(); if (m.id == null) notify('Recording stopped unexpectedly. Check Meetings for the saved audio.', true); }
      if (m.state === 'progress') progress.set(id, m.pct);
      if (m.state === 'ready' || m.state === 'transcription_failed') {
        progress.delete(id);
        if (m.state === 'ready') notify('Your meeting transcript is ready.');
        else notify('Transcription failed. The meeting audio is still saved.', true);
      }
    }
    changed();
  }
  async function start() {
    if (active || switching) throw new Error('A meeting is already recording or starting.');
    switching = true;
    changed();
    try {
      check(checkWrite(root, base));
      if (!await checkRoot()) {
        const parent = path.dirname(root);
        await fs.mkdir(parent, { recursive: true });
        if (path.relative(path.join(await fs.realpath(base), 'Roamies'), await fs.realpath(parent))) {
          throw new Error('The Roamies folder points outside its usual location.');
        }
        await fs.mkdir(root, { recursive: true });
        await checkRoot();
      }
      const prefix = stamp(now());
      let folder;
      for (let n = 1; ; n++) {
        folder = path.join(root, n === 1 ? prefix : `${prefix}-${n}`);
        try { await fs.mkdir(folder); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      const reply = await call({ type: 'meeting_start', folder });
      if (!reply.ok) {
        // The recorder can have saved audio before it reported failure.
        await fs.rmdir(folder).catch(() => {});
        throw new Error(reply.error);
      }
      return idOf(folder);
    } finally {
      switching = false;
      changed();
    }
  }
  async function stop() {
    if (switching) throw new Error('Wait for the current recording action to finish.');
    switching = true;
    changed();
    try {
      const reply = await call({ type: 'meeting_stop' });
      if (!reply.ok) throw new Error(reply.error);
      return idOf(reply.folder);
    } finally {
      switching = false;
      changed();
    }
  }
  return { list, read, summary, summarise, remove, start, stop, handle, state: () => ({ active, switching, offline: [...offline] }) };
}
