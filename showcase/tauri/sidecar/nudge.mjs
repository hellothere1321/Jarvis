// One-tap cards for the assistant modules. A key identifies a nudge: showing the same key replaces it.
import { DEFAULT_QUIET, isQuiet, timeMinutes } from './quiet.mjs';

const MAX_SHOWN = 2;
let order = 0;
const list = [];

function nowMs() { return Date.now(); }

export function Show(key, primary, secondary = '', options = {}) {
  const ttl = options.ttl != null ? (typeof options.ttl === 'number' ? options.ttl : 4 * 3600_000) : 4 * 3600_000;
  const n = {
    key, primary, secondary: secondary ?? '', detail: options.detail ?? null,
    icon: options.icon ?? 'dot', click: options.click ?? null, dismissed: options.dismissed ?? null,
    until: nowMs() + ttl, order: ++order,
  };
  const idx = list.findIndex((x) => x.key === key);
  if (idx >= 0) list.splice(idx, 1);
  list.push(n);
  return n;
}

export function Remove(key) {
  const i = list.findIndex((x) => x.key === key);
  if (i >= 0) list.splice(i, 1);
}

export function Has(key) {
  const n = list.find((x) => x.key === key);
  return !!n && n.until > nowMs();
}

export function Rows() {
  const t = nowMs();
  for (let i = list.length - 1; i >= 0; i--) if (list[i].until <= t) list.splice(i, 1);
  return list.slice().sort((a, b) => b.order - a.order).slice(0, MAX_SHOWN).map((n) => ({
    icon: n.icon, primary: n.primary, secondary: n.secondary, detail: n.detail, id: 'nudge:' + n.key,
  }));
}

export function Activate(id) {
  const key = String(id).startsWith('nudge:') ? String(id).slice('nudge:'.length) : id;
  const n = list.find((x) => x.key === key);
  if (n) {
    const i = list.indexOf(n);
    if (i >= 0) list.splice(i, 1);
    try { n.click?.(); } catch {}
  }
}

export function Dismiss(id) {
  const key = String(id).startsWith('nudge:') ? String(id).slice('nudge:'.length) : id;
  const n = list.find((x) => x.key === key);
  if (n) {
    const i = list.indexOf(n);
    if (i >= 0) list.splice(i, 1);
    try { n.dismissed?.(); } catch {}
  }
}

export function quietConfig(settings) {
  const s = settings ?? {};
  if (s.quietHours != null) {
    if (typeof s.quietHours === 'string') {
      const parts = s.quietHours.split('-').map((x) => x.trim());
      return { on: true, start: parts[0], end: parts[1] };
    }
    return s.quietHours;
  }
  if (typeof s.quiet === 'string') {
    const parts = s.quiet.split('-').map((x) => x.trim());
    return { on: true, start: parts[0], end: parts[1] };
  }
  return DEFAULT_QUIET;
}

export function InWindow(spec, date) {
  if (typeof spec === 'string') {
    const d = date instanceof Date ? date : new Date(date);
    const parts = spec.split('-').map((x) => x.trim());
    if (parts.length !== 2) return false;
    const start = timeMinutes(parts[0]), end = timeMinutes(parts[1]);
    const now = Number.isFinite(d.getTime()) ? d.getHours() * 60 + d.getMinutes() : null;
    if (start == null || end == null || now == null || start === end) return false;
    return start < end ? now >= start && now < end : now >= start || now < end;
  }
  return isQuiet(date, spec ?? DEFAULT_QUIET);
}

export function Quiet(settings, date) {
  const cfg = quietConfig(settings);
  return isQuiet(date, cfg);
}

export { Show as show, Remove as remove, Has as has };
