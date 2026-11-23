// Quiet hours: a daily local-time window when Roamies keeps alerts on screen but holds the voice and focus nudges.
export const DEFAULT_QUIET = { on: true, start: '00:30', end: '08:00' };

/** Minutes since local midnight, or null when the text isn't a 24-hour HH:MM. */
export function timeMinutes(value) {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const minuteOf = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  return Number.isFinite(d.getTime()) ? d.getHours() * 60 + d.getMinutes() : null;
};

/** Whether `date` is inside the window. Start is inclusive, end exclusive; the range may cross midnight. */
export function isQuiet(date, hours = DEFAULT_QUIET) {
  if (!hours || typeof hours !== 'object') return false;
  if (hours.on !== true) return false;
  const start = timeMinutes(hours.start), end = timeMinutes(hours.end), now = minuteOf(date);
  if (start == null || end == null || now == null || start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}
