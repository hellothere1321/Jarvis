// Meeting summaries: split a name-fixed transcript, ask the model for markdown, merge long ones.
// The model call is passed in, so this file holds no credentials and no transcript words reach the logs.
export const WORDS_PER_CHUNK = 12_000;

export const SUMMARY_SYSTEM = `You summarise meeting transcripts. Reply in markdown only, with these sections in this order:
## Overview
## Decisions
## Action items
## Open questions

Overview: a few sentences on what the meeting was about. Decisions: what was settled. Action items: one line each, with who, what, and when only if a time was actually said. Open questions: what was left unresolved. Keep names, numbers and times exactly as given. If a section has nothing, write "None mentioned". Never invent a decision, owner, date or question.`;

/** One part of a longer meeting: cover only what is in this part, in the same four sections. */
export const chunkPrompt = (transcript) => `Summarise this part of a meeting transcript:\n\n${transcript}`;

/** The last call: combine the parts into one meeting summary, without repeating or losing anything. */
export const mergePrompt = (partials) => `These are summaries of the parts of one meeting, in order. Merge them into a single markdown summary with the same four sections (Overview, Decisions, Action items, Open questions). Keep every distinct decision, action item and question once; keep names, times and numbers as they are. Don't mention the parts.\n\n${partials.map((p, i) => `### Part ${i + 1}\n${p}`).join('\n\n')}`;

const wordsOf = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
const two = (n) => String(n).padStart(2, '0');
const timeOf = (s) => {
  const t = Math.floor(s);
  return `${Math.floor(t / 3600) ? `${Math.floor(t / 3600)}:` : ''}${two(Math.floor(t / 60) % 60)}:${two(t % 60)}`;
};
const lineOf = (s) => `${timeOf(s.start)}–${timeOf(s.end)} ${s.track === 'mic' ? 'Microphone' : 'Computer audio'}: ${s.text.trim()}`;

/** Chunks are whole segments: a segment is never cut in half, even if it is longer than the target. */
export function chunkSegments(segments, per = WORDS_PER_CHUNK) {
  const limit = Number.isFinite(per) && per > 0 ? per : WORDS_PER_CHUNK;
  const chunks = [];
  let current = [], words = 0;
  for (const s of segments) {
    const n = wordsOf(s.text);
    if (current.length && words + n > limit) { chunks.push(current); current = []; words = 0; }
    current.push(s);
    words += n;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * { segments, model({ system, text }) -> markdown, per }. One model call for a short transcript;
 * one per chunk and a final merge for a long one. Resolves the finished markdown.
 */
export async function summariseTranscript({ segments, model, per = WORDS_PER_CHUNK }) {
  if (typeof model !== 'function') throw new Error('No model is set for summaries.');
  const chunks = chunkSegments(segments, per);
  if (!chunks.length) throw new Error('This meeting has no speech to summarise.');
  const ask = async (text) => {
    const out = await model({ system: SUMMARY_SYSTEM, text });
    if (typeof out !== 'string' || !out.trim()) throw new Error('The model returned an empty summary.');
    return out.trim();
  };
  if (chunks.length === 1) return ask(chunkPrompt(chunks[0].map(lineOf).join('\n')));
  const partials = [];
  for (const chunk of chunks) partials.push(await ask(chunkPrompt(chunk.map(lineOf).join('\n'))));
  return ask(mergePrompt(partials));
}
