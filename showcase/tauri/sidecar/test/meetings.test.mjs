import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'roamies-meetings-home-'));
process.env.ROAMIES_DATA_DIR = testHome;
after(() => fs.rmdir(testHome));
const { createMeetings } = await import('../meetings.mjs');
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
