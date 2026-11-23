import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { clipboard, createVault, publicList } from '../vault.mjs';
import { createSecrets } from '../secrets.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-test-'));
process.env.ROAMIES_DATA_DIR = dir;
const { createTools } = await import('../tools.mjs');
const file = path.join(dir, 'vault.json');
const password = 'scratch-secret-' + randomBytes(16).toString('hex');
const logs = [], session = [], commands = [];
const original = [console.log, console.error, console.warn];
console.log = console.error = console.warn = (...args) => logs.push(args.join(' '));
try {
  // Another settings page can save a key while the vault creates its own.
  const ring = createSecrets({ platform: 'win32', dataDir: dir, exec: async (_cmd, _args, input) => ({ code: 0, stdout: input }) });
  await Promise.all([ring.set('vault-key', 'fake-key'), ring.set('another-key', 'second')]);
  assert.equal(await ring.get('vault-key'), 'fake-key');
  assert.equal(await ring.get('another-key'), 'second');
  let k, reads = 0, changed = false, helperError = false;
  const exec = async (cmd, args, input) => {
    commands.push(args);
    if (cmd === 'powershell.exe') {
      assert.equal(Buffer.from(input, 'base64').toString(), password);
      return { code: 0, stdout: password, stderr: password };
    }
    if (args[0] === 'vault-front') {
      const url = changed && ++reads === 2 ? 'https://other.test/' : 'https://example.test/';
      return { code: 0, stdout: JSON.stringify({ ok: true, exe: 'chrome', pid: 1, id: 2, document: [3, 7], title: 'Login', url }) };
    }
    assert.equal(args[0], 'vault-fill');
    assert.equal(JSON.parse(input).password, password);
    return helperError ? { code: 1, stderr: password } : { code: 0, stdout: JSON.stringify({ ok: true, accidental: password }) };
  };
  const vault = createVault({ dataDir: dir, secrets: { get: async () => k, set: async (_, v) => { k = v; } }, hands: 'fake', exec });
  const tools = createTools({ vault, allowActions: () => true }).tools;
  const fill = tools.find((t) => t.name === 'fill_login');
  assert.ok(!tools.some((t) => t.name === 'browser_login'), 'no browser sign-in without the background browser');
  const list = tools.find((t) => t.name === 'list_logins');
  const id = await vault.save({ address: 'EXAMPLE.test', username: 'user', password });
  assert.equal(await vault.reveal(id), password);
  const disk = await fs.readFile(file, 'utf8');
  assert.ok(!disk.includes(password));
  const saved = k;
  for (const invalid of [null, randomBytes(32).toString('base64')]) {
    k = invalid;
    await assert.rejects(vault.reveal(id), /refused/);
  }
  k = null;
  await assert.rejects(vault.save({ address: 'other.test', username: 'user', password }), /refused/);
  assert.equal(k, null);
  k = saved;
  const locked = createVault({ dataDir: path.join(dir, 'locked'), secrets: {
    get: async () => null, set: async () => { throw Error('key store unavailable'); },
  } });
  await assert.rejects(locked.save({ address: 'example.test', username: 'user', password }), /refused/);
  await assert.rejects(fs.access(path.join(dir, 'locked', 'vault.json')), { code: 'ENOENT' });
  for (const field of ['id', 'site', 'scheme', 'port', 'username', 'sealed']) {
    const [row] = JSON.parse(disk);
    if (field === 'sealed') {
      const bytes = Buffer.from(row.sealed.data, 'base64');
      bytes[0] ^= 1;
      row.sealed.data = bytes.toString('base64');
    } else row[field] += 'x';
    await fs.writeFile(file, JSON.stringify([row]));
    await assert.rejects(vault.reveal(row.id), /refused/);
  }
  await fs.writeFile(file, disk);
  // The background browser's sign-in gets the row and password; the result is whatever the browser says.
  assert.equal(await vault.login(id, (row, user, pass) => { assert.deepEqual([row.site, row.scheme, user, pass], ['example.test', 'https', 'user', password]); return 'signed in'; }), 'signed in');
  await assert.rejects(vault.login('00000000-0000-4000-8000-000000000000', () => 'no'), /refused/);
  changed = true;
  await assert.rejects(fill.execute({ id }), /refused/);
  assert.equal(commands.filter(([cmd]) => cmd === 'vault-fill').length, 0);
  changed = false;
  session.push(await fill.execute({ id }), await list.execute({}));
  helperError = true;
  await assert.rejects(fill.execute({ id }), (e) => { session.push(e.message); return e.message === 'Vault operation refused.'; });

  const alg = { name: 'ECDH', namedCurve: 'P-256' };
  const pair = await crypto.subtle.generateKey(alg, true, ['deriveKey']);
  const server = await crypto.subtle.importKey('raw', Buffer.from(vault.publicKey, 'base64'), alg, false, []);
  const key = await crypto.subtle.deriveKey({ name: 'ECDH', public: server }, pair.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  async function panel(request) {
    const iv = randomBytes(12);
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from('request') }, key, Buffer.from(JSON.stringify(request)));
    const msg = { peer: Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64'), box: { iv: iv.toString('base64'), data: Buffer.from(data).toString('base64') } };
    session.push(msg);
    return vault.panel(msg);
  }
  await panel({ action: 'save', id, address: 'example.test', username: 'changed', password });
  session.push(await panel({ action: 'reveal', id }), await panel({ action: 'copy', id }));
  assert.equal((await vault.list())[0].username, 'changed');
  await panel({ action: 'delete', id });
  assert.deepEqual(await vault.list(), []);
  assert.ok(!JSON.stringify([commands, session, logs]).includes(password));

  // Review fixes: the model's list has no usernames, a fresh nonce per seal, corrupt files are never overwritten,
  // and the clipboard copy opts out of Windows' history and cloud sync.
  {
    const name = 'sam-' + randomBytes(8).toString('hex'), other = 'pat-' + randomBytes(8).toString('hex');
    const sub = path.join(dir, 'review');
    let key2;
    const v = createVault({ dataDir: sub, secrets: { get: async () => key2, set: async (_, x) => { key2 = x; } }, hands: 'fake', exec });
    const a = await v.save({ address: 'shop.test', username: name, password });
    const b = await v.save({ address: 'shop.test', username: other, password });
    const c = await v.save({ address: 'bank.test:8443', username: name, password });
    const shown = JSON.stringify(publicList(await v.list()));
    assert.ok(!shown.includes(name) && !shown.includes(other) && !shown.includes('username'));
    assert.deepEqual(publicList(await v.list()).map((r) => r.account), ['1 of 2', '2 of 2', undefined]);
    const listed = createTools({ vault: v, allowActions: () => true }).tools.find((t) => t.name === 'list_logins');
    const result = await listed.execute({});
    session.push(result);
    assert.ok(!result.includes(name) && !result.includes(other) && result.includes(a) && result.includes(b) && result.includes(c));
    const rows = JSON.parse(await fs.readFile(path.join(sub, 'vault.json'), 'utf8'));
    assert.equal(new Set(rows.map((r) => r.sealed.iv)).size, 3);
    assert.equal(new Set(rows.map((r) => r.sealed.data)).size, 3);
    const before = rows[0].sealed;
    await v.save({ id: a, address: 'shop.test', username: name, password });
    const after = JSON.parse(await fs.readFile(path.join(sub, 'vault.json'), 'utf8'))[0].sealed;
    assert.notEqual(after.iv, before.iv);
    assert.notEqual(after.data, before.data);
    for (const bad of ['', '{"truncated":', 'null', '{}', '[null]', '[{"id":1}]']) {
      await fs.writeFile(path.join(sub, 'vault.json'), bad);
      for (const op of [() => v.list(), () => v.reveal(a), () => v.remove(a), () => v.save({ address: 'new.test', username: 'x', password })])
        await assert.rejects(op(), /refused/);
      assert.equal(await fs.readFile(path.join(sub, 'vault.json'), 'utf8'), bad);
      assert.deepEqual((await fs.readdir(sub)).filter((f) => f.endsWith('.tmp')), []);
    }
    for (const format of ['ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard'])
      assert.ok(clipboard.includes(format), format);
    assert.ok(!JSON.stringify([commands, session, logs]).includes(name));
    assert.ok(!JSON.stringify([commands, session, logs]).includes(other));
  }
} finally {
  [console.log, console.error, console.warn] = original;
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('vault tests: passed');
