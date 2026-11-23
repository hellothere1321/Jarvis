import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createECDH, randomBytes, randomUUID } from 'node:crypto';
import { checkFill, loginOrigin } from './safety.mjs';
import { runInput } from './secrets.mjs';

const failed = () => new Error('Vault operation refused.');
const aad = (e) => JSON.stringify([e.id, e.site, e.scheme, e.port, e.username]);
// What the model may see: no usernames, so the transcript never holds a username with its site.
export function publicList(rows) {
  const seen = new Map(), total = new Map();
  for (const r of rows) total.set(`${r.scheme}://${r.site}:${r.port}`, (total.get(`${r.scheme}://${r.site}:${r.port}`) ?? 0) + 1);
  return rows.map((r) => {
    const origin = `${r.scheme}://${r.site}:${r.port}`, n = (seen.get(origin) ?? 0) + 1;
    seen.set(origin, n);
    return { id: r.id, site: r.site, scheme: r.scheme, port: r.port, ...(total.get(origin) > 1 ? { account: `${n} of ${total.get(origin)}` } : {}) };
  });
}
const metadata = ({ id, site, scheme, port, username, created, updated }) => ({ id, site, scheme, port, username, created, updated });

// Draw the reveal without accessible text and exclude its window from desktop capture before showing it.
const display = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms @'
using System;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public class VaultWindow : Form {
  [DllImport("user32")] public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint flags);
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x317 || m.Msg == 0x318) return; // WM_PRINT and WM_PRINTCLIENT
    base.WndProc(ref m);
  }
}
'@
$text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$form=New-Object VaultWindow
$form.Text='Saved password'
$form.StartPosition='CenterScreen'
$form.TopMost=$true
$form.ClientSize=New-Object Drawing.Size(560,180)
if (-not [VaultWindow]::SetWindowDisplayAffinity($form.Handle,17)) { exit 1 }
$form.Add_Paint({ param($sender,$e) $e.Graphics.DrawString($text,$form.Font,[Drawing.Brushes]::Black,[Drawing.RectangleF]::new(16,16,$form.ClientSize.Width-32,$form.ClientSize.Height-32)) })
$timer=New-Object Windows.Forms.Timer
$timer.Interval=10000
$timer.Add_Tick({ $form.Close() })
$timer.Start()
[void]$form.ShowDialog()
$timer.Dispose()
$form.Dispose()
`;

// Set Windows' clipboard-history exclusion. Hold the clipboard lock while comparing and clearing.
export const clipboard = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class VaultClipboard {
  [DllImport("user32")] public static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32")] public static extern bool CloseClipboard();
  [DllImport("user32")] public static extern bool EmptyClipboard();
  [DllImport("user32")] public static extern IntPtr GetClipboardData(uint format);
  [DllImport("kernel32")] public static extern IntPtr GlobalLock(IntPtr handle);
  [DllImport("kernel32")] public static extern bool GlobalUnlock(IntPtr handle);
}
'@
$text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$data=New-Object Windows.Forms.DataObject
$data.SetText($text)
foreach ($format in 'ExcludeClipboardContentFromMonitorProcessing','CanIncludeInClipboardHistory','CanUploadToCloudClipboard') { $data.SetData($format, [IO.MemoryStream]::new([byte[]](0,0,0,0))) }
[Windows.Forms.Clipboard]::SetDataObject($data,$true)
Start-Sleep -Seconds 30
while (-not [VaultClipboard]::OpenClipboard([IntPtr]::Zero)) { Start-Sleep -Milliseconds 100 }
try {
  $handle=[VaultClipboard]::GetClipboardData(13)
  if ($handle -ne [IntPtr]::Zero) {
    $ptr=[VaultClipboard]::GlobalLock($handle)
    if ($ptr -ne [IntPtr]::Zero) {
      try { $same=[String]::Equals($text,[Runtime.InteropServices.Marshal]::PtrToStringUni($ptr),[StringComparison]::Ordinal) }
      finally { [void][VaultClipboard]::GlobalUnlock($handle) }
      if ($same) { [void][VaultClipboard]::EmptyClipboard() }
    }
  }
} finally { [void][VaultClipboard]::CloseClipboard() }
`;

function seal(key, text, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString('base64'), data: data.toString('base64') };
}

function open(key, box, context) {
  const data = Buffer.from(box.data, 'base64');
  const iv = Buffer.from(box.iv, 'base64');
  if (iv.length !== 12 || data.length < 16) throw failed();
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8');
}

export function createVault({ dataDir, secrets, hands, exec = runInput }) {
  const file = path.join(dataDir, 'vault.json');
  const channel = createECDH('prime256v1');
  const publicKey = channel.generateKeys('base64');
  let queue = Promise.resolve();
  const serial = (fn) => {
    const result = queue.then(fn).catch(() => { throw failed(); });
    queue = result.catch(() => {});
    return result;
  };
  async function read() {
    try {
      const rows = JSON.parse(await fs.readFile(file, 'utf8'));
      // A damaged file is refused as a whole and left as it is: nothing here ever rewrites rows it could not read.
      const text = (v) => typeof v === 'string';
      if (!Array.isArray(rows) || !rows.every((r) => r && ['id', 'site', 'scheme', 'port', 'username'].every((k) => text(r[k])) &&
          text(r.sealed?.iv) && text(r.sealed?.data))) throw failed();
      return rows;
    } catch (e) { if (e.code === 'ENOENT') return []; throw failed(); }
  }
  async function write(rows) {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const tmp = file + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(tmp, JSON.stringify(rows), { mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, file);
    } finally { await fs.rm(tmp, { force: true }); }
  }
  async function key(create = false) {
    let k = await secrets.get('vault-key');
    if (k == null && create) {
      k = randomBytes(32).toString('base64');
      await secrets.set('vault-key', k);
    }
    if (typeof k !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(k)) throw failed();
    return Buffer.from(k, 'base64');
  }
  async function helper(command, payload) {
    if (!hands) throw failed();
    const r = await exec(hands, [command], payload ? JSON.stringify(payload) : '');
    if (r.code !== 0) throw failed();
    const result = JSON.parse(r.stdout);
    if (result.ok !== true) throw failed();
    return result;
  }
  const list = () => serial(async () => (await read()).map(metadata));
  const entry = (rows, id) => {
    const found = rows.find((r) => r.id === id);
    if (!found) throw failed();
    return found;
  };
  function save({ id, address, username, password }) {
    return serial(async () => {
      const origin = loginOrigin(/^https?:\/\//i.test(address) ? address : 'https://' + address);
      if (typeof address !== 'string' || !origin || typeof username !== 'string' || typeof password !== 'string' || !password || !username ||
          /[\x00-\x1f\x7f]/.test(username + password) || username.length > 4096 || password.length > 8192) throw failed();
      const rows = await read();
      const prior = id ? entry(rows, id) : null;
      const now = Date.now();
      const row = { ...origin, username, id: prior?.id ?? randomUUID(), created: prior?.created ?? now, updated: now };
      row.sealed = seal(await key(!rows.length), password, aad(row));
      if (prior) rows[rows.indexOf(prior)] = row;
      else rows.push(row);
      await write(rows);
      return row.id;
    });
  }
  const reveal = (id) => serial(async () => {
    const row = entry(await read(), id);
    return open(await key(), row.sealed, aad(row));
  });
  const remove = (id) => serial(async () => {
    const rows = await read();
    rows.splice(rows.indexOf(entry(rows, id)), 1);
    await write(rows);
  });
  const fill = (id) => serial(async () => {
    const row = entry(await read(), id);
    const first = await helper('vault-front');
    if (!Number.isSafeInteger(first.id) || !Number.isSafeInteger(first.pid) || !first.exe ||
        !Array.isArray(first.document) || !first.document.length || !checkFill(first.url, row)) throw failed();
    const password = open(await key(), row.sealed, aad(row));
    const last = await helper('vault-front');
    if (['url', 'exe', 'id', 'pid', 'title'].some((k) => first[k] !== last[k]) ||
        JSON.stringify(first.document) !== JSON.stringify(last.document)) throw failed();
    await helper('vault-fill', { expected: first, username: row.username, password });
    return 'Filled the login. The form is ready for review.';
  });
  // The background browser's sign-in (browser.mjs): the password goes from here straight into that page, never to the model.
  const login = async (id, use) => {
    const { row, password } = await serial(async () => {
      const found = entry(await read(), id);
      return { row: metadata(found), password: open(await key(), found.sealed, aad(found)) };
    });
    return use(row, row.username, password);
  };
  // Only ciphertext crosses the webview bridge. Reveal and copy happen locally, outside the webview.
  async function panel(m) {
    try {
      const shared = channel.computeSecret(Buffer.from(m.peer, 'base64'));
      const request = JSON.parse(open(shared, m.box, 'request'));
      if (request.action === 'save') await save(request);
      else if (request.action === 'delete') await remove(request.id);
      else if (request.action === 'reveal' || request.action === 'copy') {
        const input = Buffer.from(await reveal(request.id)).toString('base64');
        const script = request.action === 'copy' ? clipboard : display;
        const result = await exec('powershell.exe', ['-STA', '-NoProfile', '-NonInteractive', '-Command', script], input, 60_000);
        if (result.code !== 0) throw failed();
      } else throw failed();
    } catch { throw failed(); }
  }
  return { publicKey, list, publicList, save, remove, reveal, fill, login, panel };
}
