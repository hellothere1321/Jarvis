// Fix misheard names and terms in speech-to-text transcripts from a user-kept list.
// buildLexicon makes a small index, fixNames returns corrected text and the changes it made.
const TAG = Symbol('lexicon');

// Words whose windows are never changed phonetically: a wrong "to" is just a word, not a name.
const STOP = new Set(('the a an and i you it to of in on for is was that this with be are we they he she at or as but not so if do ' +
  'does did have has had my your me him her our us them their there here what when where who why how all any some more most ' +
  'then than now very can will would should could about into out up down over under again once please thanks okay ok yeah').split(' '));

// Everyday words that are never a misheard name on their own (single-word windows aren't fuzzed), and that keep
// their case even when a name is spelled the same ("I will" stays, though "Will" is on the list).
const COMMON = new Set([...STOP, ...('same open been seen bin ban bun sum son sun bed bet bat but bit man men mat met mad may might must ' +
  'make made take took come came go went get got see saw say said know knew think want need like look use find give tell work ' +
  'call try ask feel leave put mean keep let begin seem help talk turn start show hear play run move live believe hold bring ' +
  'happen write sit stand lose pay meet include continue set learn change lead understand watch follow stop create speak read ' +
  'spend grow win offer remember love consider appear buy wait serve die send expect build stay fall cut reach kill remain ' +
  'one two three four five six seven eight nine ten first last next new old good bad great little big long high small large ' +
  'other right left best better sure real whole just only also well back still even never always often way day time year ' +
  'week month today tomorrow yesterday night morning people thing things man woman child world life hand part place case point ' +
  'group number fact water room mother area money story issue side kind head house service friend father power hour game line ' +
  'end member law car city name team minute idea body information face others level office door health person art war history ' +
  'party result morning reason research girl guy moment air teacher force education foot boy age policy music market sense ' +
  'will mark bill rose june april august grace hope joy faith sue pat max ray dawn jack frank rob bob gene drew chase dean ' +
  'job plan meeting notes note budget email call deck slide test code bug fix ticket board review sprint team lunch break').split(' ')]);

// Sound groups, so p/b and c/k/qu spellings land in the same bucket.
const GROUP = { b: 'p', f: 'p', p: 'p', v: 'p', c: 'k', g: 'k', k: 'k', q: 'k', x: 'k', d: 't', t: 't', j: 'j', s: 's', z: 's' };

const WORD = /[A-Za-z0-9]+/g;
const wordsOf = (s) => { const out = []; const re = new RegExp(WORD.source, 'g'); let m; while ((m = re.exec(s))) out.push(m[0]); return out; };

/** A short Metaphone-style key: vowels and doubled sounds dropped, similar letters merged. */
export function phoneticKey(word) {
  try {
    if (typeof word !== 'string') return '';
    const s = word.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '');
    let key = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (!/[a-z]/.test(c)) continue;
      const two = s.slice(i, i + 2);
      if (i === 0 && (two === 'kn' || two === 'gn')) { key += 'n'; i++; continue; }
      if (i === 0 && two === 'wr') { key += 'r'; i++; continue; }
      if (two === 'ph') { key += 'f'; i++; continue; }
      if (two === 'sh') { key += 's'; i++; continue; }
      if (two === 'ch' || two === 'th') { key += 'k'; i++; continue; }
      if ('aeiouy'.includes(c)) continue;
      if (c === 'h' && i > 0) continue; // an inner h is usually just breath
      const g = GROUP[c] || c;
      if (g === 'ks') { key += 'ks'; continue; }
      if (key[key.length - 1] !== g) key += g;
    }
    return key;
  } catch { return ''; }
}

// Reusable rows for Damerau-Levenshtein; one call at a time, so sharing is safe.
let d0 = [], d1 = [], d2 = [];
function distance(a, b) {
  if (a === b) return 0;
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;
  if (n + 2 > d0.length) { d0 = new Array(n + 2); d1 = new Array(n + 2); d2 = new Array(n + 2); }
  for (let i = 0; i <= n; i++) d1[i] = i;
  for (let j = 1; j <= m; j++) {
    d2[0] = j;
    const bj = b.charCodeAt(j - 1), prevB = j > 1 ? b.charCodeAt(j - 2) : -1;
    for (let i = 1; i <= n; i++) {
      let v = Math.min(d1[i] + 1, d2[i - 1] + 1, d1[i - 1] + (a.charCodeAt(i - 1) === bj ? 0 : 1));
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === prevB && a.charCodeAt(i - 2) === bj) v = Math.min(v, d0[i - 2] + 1);
      d2[i] = v;
    }
    const row = d0; d0 = d1; d1 = d2; d2 = row;
  }
  return d1[n];
}

const bucketOf = (key) => (GROUP[key[0]] || key[0] || '_') + (GROUP[key[1]] || key[1] || '_');
const similarity = (a, b) => { const max = Math.max(a.length, b.length); return max ? 1 - distance(a, b) / max : 1; };

/** Index entries by exact spelling and by the first two sounds; blanks, duplicates and long entries go. */
export function buildLexicon(entries) {
  const index = { [TAG]: true, entries: [], exact: new Map(), buckets: new Map() };
  try {
    if (!Array.isArray(entries)) return index;
    const seen = new Set();
    for (const raw of entries) {
      if (typeof raw !== 'string') continue;
      const text = raw.trim();
      const words = wordsOf(text);
      if (!words.length || words.length > 3) continue;
      const lower = words.map((w) => w.toLowerCase());
      const exactKey = lower.join(' ');
      if (seen.has(exactKey)) continue;
      seen.add(exactKey);
      const key = lower.map(phoneticKey).join('');
      const entry = { text, exactKey, key, letters: lower.join(''), size: words.length };
      index.entries.push(entry);
      index.exact.set(exactKey, entry);
      const bucket = bucketOf(key);
      if (!index.buckets.has(bucket)) index.buckets.set(bucket, []);
      index.buckets.get(bucket).push(entry);
    }
  } catch { /* a bad list is an empty list */ }
  return index;
}

/** Replace misheard windows. at is the offset in the original text; punctuation and spacing stay put. */
export function fixNames(text, lexicon, options) {
  const unchanged = (t) => ({ text: t, changes: [] });
  try {
    if (typeof text !== 'string' || !text) return unchanged(typeof text === 'string' ? text : '');
    if (!lexicon || lexicon[TAG] !== true) return unchanged(text);
    let minScore = options?.minScore;
    if (typeof minScore !== 'number' || !Number.isFinite(minScore)) minScore = 0.82;

    // Word cores only: punctuation (including an apostrophe) stays in the original text.
    const tokens = [];
    let m;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(text))) {
      const glued = text[m.index - 1] === "'" || text[m.index - 1] === '\u2019';
      tokens.push({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length, key: phoneticKey(m[0]), glued });
    }
    if (!tokens.length) return unchanged(text);

    const candidates = [];
    const occupied = new Array(tokens.length).fill(false);
    for (let i = 0; i < tokens.length; i++) {
      let phrase = '', key = '', letters = '';
      for (let size = 1; size <= 3 && i + size <= tokens.length; size++) {
        const t = tokens[i + size - 1];
        if (t.glued) break; // never splice a contraction or possessive in half
        phrase += (size > 1 ? ' ' : '') + t.word;
        key += t.key;
        letters += t.word;
        const endToken = i + size;
        const span = text.slice(tokens[i].start, tokens[endToken - 1].end);

        // An exact spelling (ignoring case) always wins, even for a stopword.
        const exact = lexicon.exact.get(phrase);
        if (exact) {
          candidates.push({ score: 1, start: i, end: endToken, at: tokens[i].start, from: span,
            to: exact.text === span || (size === 1 && exact.size === 1 && COMMON.has(phrase) && span === span.toLowerCase()) ? null : exact.text, size });
          continue;
        }
        if (!key || tokens.slice(i, endToken).every((t2) => STOP.has(t2.word))) continue;
        if (size === 1 && COMMON.has(t.word)) continue;

        const bucket = lexicon.buckets.get(bucketOf(key));
        if (!bucket) continue;
        for (const entry of bucket) {
          if (Math.abs(entry.size - size) > 1 || Math.abs(entry.key.length - key.length) > 3) continue;
          // Sounds lead, but the letters must agree too: consonant keys alone make "open", "banana" and "Ben" the same.
          const spelled = similarity(letters, entry.letters);
          if (spelled < (entry.letters.length <= 4 ? 0.6 : 0.5)) continue;
          const score = 0.8 * similarity(key, entry.key) + 0.2 * spelled;
          if (score < minScore) continue;
          candidates.push({ score, start: i, end: endToken, at: tokens[i].start, from: span, to: entry.text, size });
        }
      }
    }
    if (!candidates.length) return unchanged(text);

    candidates.sort((a, b) => b.score - a.score || b.size - a.size || a.start - b.start);
    const changes = [];
    for (const c of candidates) {
      let free = true;
      for (let i = c.start; i < c.end; i++) if (occupied[i]) { free = false; break; }
      if (!free) continue;
      for (let i = c.start; i < c.end; i++) occupied[i] = true;
      if (c.to !== null && c.to !== c.from) changes.push({ from: c.from, to: c.to, at: c.at });
    }
    changes.sort((a, b) => a.at - b.at);
    let out = '', pos = 0;
    for (const c of changes) { out += text.slice(pos, c.at) + c.to; pos = c.at + c.from.length; }
    return { text: out + text.slice(pos), changes };
  } catch { return unchanged(typeof text === 'string' ? text : ''); }
}
