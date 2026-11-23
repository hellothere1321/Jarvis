import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { chunkSegments, SUMMARY_SYSTEM } from '../summarise.mjs';

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'roamies-meetings-home-'));
process.env.ROAMIES_DATA_DIR = testHome;
after(() => fs.rmdir(testHome));
const { createMeetings, parseNames } = await import('../meetings.mjs');
const { meetingTools } = await import('../tools.mjs');

async function scratch(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'roamies-meetings-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

test('recording, stop, progress and transcript use one meeting folder', async (t) => {
  const base = await scratch(t);
  let folder;
  const notes = [];
  const meetings = createMeetings({
    base, now: () => new Date(2030, 5, 6, 12, 34),
    notify: (text) => notes.push(text),
    call: async (msg) => {
      if (msg.type === 'meeting_start') {
        folder = msg.folder;
        await fs.writeFile(path.join(folder, 'mic.wav'), Buffer.alloc(44 + 32000 * 2));
        meetings.handle({ state: 'recording', folder });
      } else {
        assert.equal(msg.type, 'meeting_stop');
        meetings.handle({ state: 'stopped', folder });
      }
      return { ok: true, folder };
    },
  });
  assert.deepEqual(await meetings.list(), []);
  const id = await meetings.start();
  assert.equal(id, '2030-06-06 1234');
  assert.equal(meetings.state().active, id);
  await assert.rejects(meetings.start(), /already recording/);
  await assert.rejects(meetings.remove(id), /until the meeting is finished/);
  meetings.handle({ state: 'device', folder, track: 'system', offline: true });
  assert.deepEqual(meetings.state().offline, ['system']);
  assert.equal(await meetings.stop(), id);
  assert.deepEqual(meetings.state().offline, []);
  meetings.handle({ state: 'progress', folder, pct: 38 });
  const [reading] = await meetings.list();
  assert.equal(reading.duration, 2);
  assert.equal(reading.status, 'transcribing');
  assert.equal(reading.pct, 38);
  await assert.rejects(meetings.remove(id), /until the meeting is finished/);
  const segments = [{ start: 0.25, end: 1.1, text: 'Speech from this fixture.', track: 'system' }];
  await fs.writeFile(path.join(folder, 'transcript.json'), JSON.stringify({ segments }));
  meetings.handle({ state: 'ready', folder });
  assert.equal((await meetings.list())[0].status, 'ready');
  assert.deepEqual(await meetings.read(id), { id, segments });
  assert.deepEqual(notes, ['Your meeting transcript is ready.']);
  const [, , , readTool] = meetingTools({ ...meetings, open: async (id) => { await meetings.read(id); } });
  assert.match(await readTool.execute({ id }), /^Opened the transcript/);
  assert.equal(await meetings.remove(id, { confirm: () => false }), false);
  assert.equal(await meetings.remove(id, { confirm: () => true }), true);
  assert.deepEqual(await meetings.list(), []);
});

test('existing folders get a suffix and meeting deletes stay within the managed files', async (t) => {
  const base = await scratch(t);
  const now = () => new Date(2030, 5, 6, 12, 34);
  const meetings = createMeetings({ base, now, call: async () => ({ ok: true }) });
  assert.equal(await meetings.start(), '2030-06-06 1234');
  const id = await meetings.start();
  assert.equal(id, '2030-06-06 1234-2');
  const folder = path.join(base, 'Roamies', 'Meetings', id);
  await fs.writeFile(path.join(folder, 'other.txt'), 'Keep this.');
  await assert.rejects(meetings.remove(id, { confirm: () => true }), /contains other files/);
  await assert.rejects(meetings.read('../outside'), /Choose a meeting/);
  await fs.writeFile(path.join(folder, 'transcript.json'), 'Malformed private transcript');
  await assert.rejects(meetings.read(id), { message: 'The transcript could not be read.' });
});

test('junctions pointing outside Meetings cannot be listed, read or removed', async (t) => {
  const base = await scratch(t);
  const root = path.join(base, 'Roamies', 'Meetings');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside);
  const id = '2030-06-06 1234';
  await fs.symlink(outside, path.join(root, id), process.platform === 'win32' ? 'junction' : 'dir');
  const meetings = createMeetings({ base });
  assert.deepEqual(await meetings.list(), []);
  await assert.rejects(meetings.read(id), /Meeting not found/);
  await assert.rejects(meetings.remove(id, { confirm: () => true }), /Meeting not found/);
  assert.equal((await fs.stat(outside)).isDirectory(), true);
});

test('a folder changed while confirming cannot redirect a deletion', async (t) => {
  const base = await scratch(t);
  const root = path.join(base, 'Roamies', 'Meetings');
  const id = '2030-06-06 1234';
  const folder = path.join(root, id);
  const outside = path.join(base, 'outside');
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'mic.wav'), 'keep');
  const meetings = createMeetings({ base });
  await assert.rejects(meetings.remove(id, { confirm: async () => {
    await fs.rmdir(folder);
    await fs.symlink(outside, folder, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } }), /Meeting not found/);
  assert.equal(await fs.readFile(path.join(outside, 'mic.wav'), 'utf8'), 'keep');
});

const seg = (start, text) => ({ start, end: start + 1, text, track: 'mic' });
async function readyMeeting(t, { segments, names = [], model, chunkWords }) {
  const base = await scratch(t);
  const id = '2030-06-06 1234';
  const folder = path.join(base, 'Roamies', 'Meetings', id);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'transcript.json'), JSON.stringify({ segments }));
  return { base, id, folder, meetings: createMeetings({ base, names: () => names, model, chunkWords }) };
}

test('the names list keeps one name per line, at most three words and 500 entries', () => {
  assert.deepEqual(parseNames('  Mira Voss \n korbett labs inc \nMira Voss\n\nKorbett'), ['Mira Voss', 'korbett labs inc', 'Korbett']);
  assert.equal(parseNames(Array.from({ length: 600 }, (_, i) => `Name ${i}`)).length, 500);
  assert.deepEqual(parseNames(null), []);
});

test('names are fixed when a transcript is read, never in the saved file', async (t) => {
  const segments = [seg(0, 'Mira Vos met Korbet.')];
  const { base, id, folder, meetings } = await readyMeeting(t, { segments, names: ['Mira Voss', 'Korbett'] });
  const raw = await fs.readFile(path.join(folder, 'transcript.json'), 'utf8');
  assert.deepEqual(await meetings.read(id), { id, segments: [seg(0, 'Mira Voss met Korbett.')] });
  assert.equal(await fs.readFile(path.join(folder, 'transcript.json'), 'utf8'), raw);
  // Editing the list changes what old meetings show, without touching their transcript.
  assert.deepEqual(await createMeetings({ base }).read(id), { id, segments });
});

test('chunks end on segment boundaries and never cut a segment in half', () => {
  const a = seg(0, 'one two'), b = seg(2, 'three four'), c = seg(4, 'five');
  assert.deepEqual(chunkSegments([a, b, c], 3).map((chunk) => chunk.map((s) => s.text)), [['one two'], ['three four', 'five']]);
  assert.deepEqual(chunkSegments([], 3), []);
  assert.deepEqual(chunkSegments([seg(0, 'one two three four five')], 3).map((c) => c.length), [1]);
});

test('a short transcript takes one model call and its summary is saved and read back', async (t) => {
  const calls = [];
  const model = async (prompt) => { calls.push(prompt); return '# Meeting notes'; };
  const { id, folder, meetings } = await readyMeeting(t, {
    segments: [seg(0, 'Mira Vos agreed to the Korbett launch.')], names: ['Mira Voss'], model,
  });
  assert.equal(await meetings.summarise(id), '# Meeting notes');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].system, SUMMARY_SYSTEM);
  for (const heading of ['## Overview', '## Decisions', '## Action items', '## Open questions']) assert.ok(calls[0].system.includes(heading));
  assert.match(calls[0].text, /Mira Voss agreed/);
  assert.doesNotMatch(calls[0].text, /Mira Vos agreed/);
  assert.equal(await fs.readFile(path.join(folder, 'summary.md'), 'utf8'), '# Meeting notes');
  assert.equal(await meetings.summary(id), '# Meeting notes');
  assert.deepEqual(await meetings.read(id, { summary: true }), {
    id, segments: [seg(0, 'Mira Voss agreed to the Korbett launch.')], summary: '# Meeting notes',
  });
  assert.equal((await meetings.list())[0].summary, true);
  const [, , , readTool] = meetingTools({ ...meetings, open: (wanted, options) => meetings.read(wanted, options) });
  assert.equal(await readTool.execute({ id }), `Opened the transcript for ${id} in Meetings.`);
  assert.equal(await readTool.execute({ id, summary: true }), '# Meeting notes');
});

test('a long transcript is summarised per chunk and then merged', async (t) => {
  const calls = [];
  const model = async (prompt) => { calls.push(prompt); return `Part ${calls.length}`; };
  const { id, folder, meetings } = await readyMeeting(t, {
    segments: [seg(0, 'alpha bravo charlie'), seg(3, 'delta echo foxtrot'), seg(6, 'golf hotel india'), seg(9, 'juliet kilo lima')],
    model, chunkWords: 7,
  });
  assert.equal(await meetings.summarise(id), 'Part 3');
  assert.equal(calls.length, 3);
  assert.match(calls[0].text, /alpha bravo charlie/);
  assert.doesNotMatch(calls[0].text, /golf hotel/);
  assert.match(calls[1].text, /golf hotel india/);
  assert.match(calls[2].text, /### Part 1[\s\S]*Part 1[\s\S]*### Part 2[\s\S]*Part 2/);
  assert.doesNotMatch(calls[2].text, /alpha bravo charlie/);
  assert.equal(await fs.readFile(path.join(folder, 'summary.md'), 'utf8'), 'Part 3');
});

test('a model error leaves no partial summary file and keeps the old one', async (t) => {
  const { base, id, folder } = await readyMeeting(t, { segments: [seg(0, 'Mira Voss spoke.')] });
  const good = createMeetings({ base, model: async () => '# Saved summary' });
  assert.equal(await good.summarise(id), '# Saved summary');
  const bad = createMeetings({ base, model: async () => { throw new Error('model offline'); } });
  await assert.rejects(bad.summarise(id), /model offline/);
  assert.equal(await fs.readFile(path.join(folder, 'summary.md'), 'utf8'), '# Saved summary');
  await fs.rm(path.join(folder, 'summary.md'));
  await assert.rejects(bad.summarise(id), /model offline/);
  assert.equal(await fs.readFile(path.join(folder, 'summary.md'), 'utf8').catch((e) => e.code), 'ENOENT');
  assert.equal(await fs.readFile(path.join(folder, 'summary.md.tmp'), 'utf8').catch((e) => e.code), 'ENOENT');
  assert.equal(await bad.summary(id), null);
});
