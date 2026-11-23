// Roamies' own browser: Chrome, Edge, Brave or Chromium with a profile of its own (Data/browser), run headless and
// driven over the DevTools protocol on a private pipe (no port any other program could reach). Web tasks run here,
// out of sight, so they never take over the user's screen, mouse or browser; show() brings the page onto the screen.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkFill } from './safety.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Browser programs to try, best first. */
export function browserCandidates(platform = process.platform, env = process.env) {
  if (env.ROAMIES_BROWSER) return [env.ROAMIES_BROWSER];
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'] ?? env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
    const apps = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'Chromium\\Application\\chrome.exe'];
    return apps.flatMap((a) => roots.map((r) => path.win32.join(r, a)));
  }
  if (platform === 'darwin') {
    const apps = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'].map((n) => `${n}.app/Contents/MacOS/${n}`);
    return apps.flatMap((a) => ['/Applications', path.join(env.HOME ?? '', 'Applications')].map((d) => path.posix.join(d, a)));
  }
  const names = ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser', 'chromium', 'chromium-browser'];
  return names.flatMap((n) => String(env.PATH ?? '/usr/bin').split(':').filter(Boolean).map((d) => path.posix.join(d, n)));
}
export const findBrowser = (platform, env, exists = fs.existsSync) => browserCandidates(platform, env).find((p) => exists(p)) ?? null;

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?::\d{1,5})?$/i;
/** A website as said or typed ("skool dot com", "you tube.com", "w w w dot bbc dot co dot uk slash news",
 *  "localhost:3000") → its https address, or null when it's a name with no domain ("skool", "the verge"). */
export function siteAddress(text) {
  let s = String(text ?? '').trim().replace(/^["'“‘<(]+|["'”’>).,!?;:]+$/g, '').trim();
  if (!s || s.length > 2048) return null;
  if (/^https?:\/\//i.test(s)) {
    try { const u = new URL(s); return u.username || u.password || /\s/.test(s) ? null : u.href; } catch { return null; }
  }
  s = s.replace(/\bw\s*w\s*w\b/gi, 'www').replace(/\s*\bdot\s*com\b/gi, '.com').replace(/\s+dot\s+/gi, '.')
    .replace(/\s+(?:forward\s+)?slash(?:\s+|$)/gi, '/').replace(/\s*([./:])\s*/g, '$1');
  const cut = s.search(/[/?#]/), host = (cut < 0 ? s : s.slice(0, cut)), rest = cut < 0 ? '' : s.slice(cut);
  // Spoken names come with spaces inside ("you tube.com"); three words at most, and never in the path.
  if (host.split(/\s+/).length > 3 || /\s/.test(rest)) return null;
  const h = host.replace(/\s+/g, '').toLowerCase();
  if (!(DOMAIN.test(h) || /^localhost(?::\d{1,5})?$/.test(h)) || /\.(app|exe|txt|pdf|docx?|png|jpe?g)$/.test(h)) return null;
  try { return new URL(`${/^localhost/.test(h) ? 'http' : 'https'}://${h}${rest}`).href; } catch { return null; }
}
/** Where browser_open goes: the address itself, or for a bare name the site a search finds first. */
export const openTarget = (text) => siteAddress(text) ?? `https://duckduckgo.com/?q=${encodeURIComponent(`!ducky ${String(text).trim()}`)}`;

const KEYS = {
  enter: ['Enter', 'Enter', 13, '\r'], return: ['Enter', 'Enter', 13, '\r'], tab: ['Tab', 'Tab', 9], escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27],
  backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46], space: [' ', 'Space', 32, ' '],
  arrowdown: ['ArrowDown', 'ArrowDown', 40], down: ['ArrowDown', 'ArrowDown', 40], arrowup: ['ArrowUp', 'ArrowUp', 38], up: ['ArrowUp', 'ArrowUp', 38],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37], left: ['ArrowLeft', 'ArrowLeft', 37], arrowright: ['ArrowRight', 'ArrowRight', 39], right: ['ArrowRight', 'ArrowRight', 39],
  pagedown: ['PageDown', 'PageDown', 34], pageup: ['PageUp', 'PageUp', 33], home: ['Home', 'Home', 36], end: ['End', 'End', 35],
};

// Runs in an isolated world (the page's own scripts can't see or change it): numbers what can be clicked or typed in,
// and returns the page's text. Password and card numbers are never read back.
const SNAPSHOT = `(() => {
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true]';
  const found = [], seen = new Set();
  const walk = (root) => { for (const e of root.querySelectorAll(SEL)) if (!seen.has(e)) { seen.add(e); found.push(e); } for (const e of root.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot); };
  walk(document);
  const shown = (e) => { const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const clean = (t, n = 80) => String(t ?? '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const secret = (e) => e.type === 'password' || /cc-number|cc-csc|one-time-code/.test(e.autocomplete || '');
  const role = (e) => e.getAttribute('role') || ({ A: 'link', BUTTON: 'button', SELECT: 'dropdown', TEXTAREA: 'textbox', SUMMARY: 'button' })[e.tagName]
    || (e.tagName === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', file: 'file picker', range: 'slider' })[e.type] || (e.type === 'password' ? 'password field' : 'textbox') : e.isContentEditable ? 'textbox' : 'control');
  const label = (e) => clean(e.getAttribute('aria-label') || (e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('alt')
    || (e.tagName === 'INPUT' && /submit|button|reset/.test(e.type) ? e.value : '') || e.innerText || (e.querySelector && e.querySelector('img[alt]') && e.querySelector('img[alt]').alt) || e.getAttribute('name') || '');
  globalThis.__refs = [];
  const lines = [];
  for (const e of found) {
    if (!shown(e) || e.disabled) continue;
    if (globalThis.__refs.length >= 300) break;
    globalThis.__refs.push(e);
    const n = globalThis.__refs.length, r = role(e);
    let line = '[' + n + '] ' + r + (label(e) ? ' "' + label(e) + '"' : '');
    if (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') {
      if (/checkbox|radio/.test(e.type)) line += e.checked ? ' (checked)' : ' (not checked)';
      else if (secret(e)) line += e.value ? ' (filled)' : ' (empty)';
      else if (e.value && !/submit|button|reset/.test(e.type)) line += ' = "' + clean(e.value, 120) + '"';
    } else if (e.tagName === 'SELECT') line += ' = "' + clean(e.selectedOptions[0] && e.selectedOptions[0].text) + '" (options: ' + [...e.options].slice(0, 15).map((o) => clean(o.text, 30)).join(' | ') + ')';
    else if (e.getAttribute('aria-checked')) line += ' (' + (e.getAttribute('aria-checked') === 'true' ? 'checked' : 'not checked') + ')';
    if (e.tagName === 'A') { try { const u = new URL(e.href); line += ' -> ' + (u.host === location.host ? '' : u.host) + clean(u.pathname, 60); } catch {} }
    if (e === document.activeElement) line += ' (focused)';
    lines.push(line);
  }
  const text = (document.body ? document.body.innerText : '').replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n').trim();
  return { title: document.title, url: location.href, text, controls: lines, more: found.length > 300 };
})()`;

// A pipe to the browser: JSON messages ended by a NUL byte (Chrome's --remote-debugging-pipe).
function pipe(child) {
  const out = child.stdio[3], inn = child.stdio[4];
  let id = 0, buf = '';
  const pending = new Map(), handlers = new Set();
  inn.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let at;
    while ((at = buf.indexOf('\0')) >= 0) {
      const raw = buf.slice(0, at); buf = buf.slice(at + 1);
      let m; try { m = JSON.parse(raw); } catch { continue; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || 'The browser refused that.')); else p.resolve(m.result ?? {});
      } else if (m.method) for (const h of handlers) h(m);
    }
  });
  const fail = () => { for (const p of pending.values()) p.reject(new Error('The browser closed.')); pending.clear(); };
  inn.on('close', fail);
  return {
    send(method, params = {}, sessionId, ms = 30_000) {
      const n = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(n); reject(new Error(`The browser didn't answer (${method}).`)); }, ms);
        pending.set(n, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        out.write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
      });
    },
    on: (h) => { handlers.add(h); return () => handlers.delete(h); },
  };
}

export function createBrowser({ dataDir, find = findBrowser, launch = spawn, idleMs = 10 * 60_000, log = () => {} }) {
  const profile = path.join(dataDir, 'browser');
  let b = null; // { child, cdp, headless, target, session, world, dialogs }
  let queue = Promise.resolve(), idle = null;
  const serial = (fn) => { const r = queue.then(fn); queue = r.catch(() => {}); return r; };

  function stopIdle() { clearTimeout(idle); idle = null; }
  function armIdle() {
    stopIdle();
    // A hidden browser nobody is using is closed after a while; one on screen is the user's until they close it.
    idle = setTimeout(() => { if (b?.headless) serial(() => close()); }, idleMs);
    idle.unref?.();
  }

  async function start({ headless = true, url = 'about:blank' } = {}) {
    const exe = find();
    if (!exe) throw new Error('No Chrome, Edge, Brave or Chromium is installed, so there is no background browser. Use web_fetch to read pages, or open to show one.');
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const args = ['--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--hide-crash-restore-bubble', '--disable-features=Translate,MediaRouter', '--window-size=1280,900',
      ...(headless ? ['--headless=new', '--mute-audio'] : []), url];
    const child = launch(exe, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: headless });
    const cdp = pipe(child);
    const me = { child, cdp, headless, target: null, session: null, world: null, dialogs: [] };
    b = me;
    // A hidden browser left running would hold the profile (and memory) after Roamies quits.
    const reap = () => { if (headless) try { child.kill(); } catch { /* gone */ } };
    process.once('exit', reap);
    child.on('exit', () => { process.off('exit', reap); if (b === me) { b = null; stopIdle(); } });
    child.on('error', () => { if (b === me) b = null; });
    let version;
    try { version = await cdp.send('Browser.getVersion', {}, undefined, 15_000); }
    catch {
      try { child.kill(); } catch { /* gone */ }
      b = null;
      throw new Error('The background browser didn\'t start (another copy may still be closing). Try again in a moment.');
    }
    // Headless Chrome names itself in its user agent and some sites turn it away: it says plain Chrome instead.
    me.agent = String(version.userAgent ?? '').replace('HeadlessChrome', 'Chrome');
    cdp.on((m) => {
      if (m.method === 'Target.targetCreated' && m.params.targetInfo.type === 'page' && m.params.targetInfo.openerId && m.params.targetInfo.openerId === me.target) {
        // A link that opens a new tab: carry on in that tab.
        attach(me, m.params.targetInfo.targetId).catch(() => {});
      }
      if (m.sessionId !== me.session) return;
      if (m.method === 'Runtime.executionContextsCleared') me.world = null;
      if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) me.world = null;
      if (m.method === 'Page.javascriptDialogOpening') {
        const { type, message } = m.params;
        me.dialogs.push(`${type} "${String(message).slice(0, 200)}"`);
        // Alerts are closed; anything that asks (confirm, prompt, leave page) is answered no.
        cdp.send('Page.handleJavaScriptDialog', { accept: type === 'alert' }, me.session).catch(() => {});
      }
    });
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await cdp.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    await attach(me, page ? page.targetId : (await cdp.send('Target.createTarget', { url })).targetId);
    log({ browser: 'started', headless });
    return me;
  }

  async function attach(me, targetId) {
    const { sessionId } = await me.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    me.target = targetId; me.session = sessionId; me.world = null;
    const s = (m, p) => me.cdp.send(m, p, sessionId);
    await Promise.all([s('Page.enable'), s('Runtime.enable'), me.agent ? s('Emulation.setUserAgentOverride', { userAgent: me.agent }) : null]);
  }

  const ready = async () => { const me = b ?? await start(); armIdle(); return me; };
  const send = (me, method, params) => me.cdp.send(method, params, me.session);

  // The isolated world for this document, made on first use.
  async function world(me) {
    if (me.world) return me.world;
    const { frameTree } = await send(me, 'Page.getFrameTree');
    const { executionContextId } = await send(me, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'roamies' });
    me.world = executionContextId;
    return me.world;
  }
  async function evaluate(me, expression) {
    for (let tries = 0; ; tries++) {
      try {
        const r = await send(me, 'Runtime.evaluate', { expression, contextId: await world(me), returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || 'The page script failed.');
        return r.result.value;
      } catch (e) {
        if (tries >= 2 || !/context|Cannot find|destroyed|navigat/i.test(e.message)) throw e;
        me.world = null; await sleep(300);
      }
    }
  }
  const pageUrl = async (me) => (await send(me, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result.value;

  // Waits for the page to finish loading (or 12 s), then a moment for scripts to draw it.
  async function settle(me, ms = 12_000) {
    await sleep(350);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const state = await send(me, 'Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }).then((r) => r.result.value, () => null);
      if (state === 'complete') break;
      await sleep(250);
    }
    await sleep(400);
  }

  async function snapshot(me, offset = 0) {
    const s = await evaluate(me, SNAPSHOT);
    const PAGE = 6000, text = s.text.slice(offset, offset + PAGE);
    const dialogs = me.dialogs.splice(0);
    return [`Page: ${s.title || '(no title)'}`, `Address: ${s.url}`,
      ...(dialogs.length ? [`The page showed: ${dialogs.join('; ')} (closed)`] : []),
      `Text${offset ? ` from character ${offset}` : ''}:`, text || '(none)',
      ...(s.text.length > offset + PAGE ? [`(more text: browser_read with more=${offset + PAGE})`] : []),
      `Controls (use the numbers with browser_act; they change when the page does):`, ...s.controls,
      ...(s.more ? ['(more controls further on: scroll, then browser_read)'] : [])].join('\n');
  }

  // The element numbered n in the last snapshot: scrolled into view, with its label and centre.
  async function element(me, n, focus = false) {
    const r = await evaluate(me, `(() => { const e = (globalThis.__refs || [])[${Number(n) - 1}];
      if (!e || !e.isConnected) return null;
      e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      ${focus ? 'e.focus(); if (e.select && !/checkbox|radio|file/.test(e.type)) e.select(); else if (e.isContentEditable) document.getSelection().selectAllChildren(e);' : ''}
      const b = e.getBoundingClientRect();
      const label = String(e.getAttribute('aria-label') || e.innerText || e.value && e.type !== 'password' && e.value || e.getAttribute('title') || e.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, label, focused: document.activeElement === e || (e.shadowRoot && e.shadowRoot.activeElement != null) };
    })()`);
    if (!r) throw new Error(`There's no control ${n} on the page now (it changed). Call browser_read for the new numbers.`);
    return r;
  }

  async function key(me, name) {
    const k = KEYS[String(name).toLowerCase().replace(/[\s_]/g, '')];
    if (!k) throw new Error(`Unknown key "${name}". Use enter, tab, escape, backspace, delete, space, the arrows, pageup, pagedown, home or end.`);
    const [keyName, code, vk, text] = k;
    await send(me, 'Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
    await send(me, 'Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk });
  }
  async function click(me, x, y) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send(me, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }

  async function go(me, url) {
    const r = await send(me, 'Page.navigate', { url });
    if (r.errorText) {
      const why = /NAME_NOT_RESOLVED/.test(r.errorText) ? 'that site doesn\'t exist (no such address)' : r.errorText;
      throw new Error(`Couldn't open ${url}: ${why}. Check the address, or pass the site's name to browser_open to search for it.`);
    }
    await settle(me);
  }

  async function close() {
    stopIdle();
    const me = b; b = null;
    if (!me) return;
    await me.cdp.send('Browser.close', {}, undefined, 5000).catch(() => {});
    await new Promise((r) => { if (me.child.exitCode != null) return r(); me.child.once('exit', r); setTimeout(r, 5000); });
    try { me.child.kill(); } catch { /* gone */ }
  }

  return {
    profile,
    running: () => !!b,
    open: (url) => serial(async () => { const me = await ready(); await go(me, url); return snapshot(me); }),
    read: (offset = 0) => serial(async () => snapshot(await ready(), offset)),
    url: () => serial(async () => pageUrl(await ready())),
    /** Steps: click {ref}, type {ref, text, enter}, choose {ref, option}, key {key}, scroll {direction}, wait {seconds}, back. */
    act: (steps, { beforeClick = async () => true } = {}) => serial(async () => {
      const me = await ready();
      const done = [];
      for (const s of steps) {
        if (s.do === 'click') {
          const e = await element(me, s.ref);
          if (!(await beforeClick(e.label))) throw new Error(`Stopped before clicking "${e.label}" (nothing after it ran either).${done.length ? ` Done: ${done.join('; ')}.` : ''}`);
          await click(me, e.x, e.y); done.push(`clicked "${e.label || s.ref}"`); await settle(me, 8000);
        } else if (s.do === 'type') {
          const e = await element(me, s.ref, true);
          if (!e.focused) await click(me, e.x, e.y);
          await send(me, 'Input.insertText', { text: String(s.text ?? '') });
          done.push(`typed in ${s.ref}`);
          if (s.enter) { await key(me, 'enter'); await settle(me, 8000); }
        } else if (s.do === 'choose') {
          const ok = await evaluate(me, `(() => { const e = (globalThis.__refs || [])[${Number(s.ref) - 1}]; if (!e || e.tagName !== 'SELECT') return false;
            const want = ${JSON.stringify(String(s.option ?? '').toLowerCase())};
            const o = [...e.options].find((o) => o.text.trim().toLowerCase() === want) || [...e.options].find((o) => o.text.toLowerCase().includes(want));
            if (!o) return false; e.value = o.value; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
          if (!ok) throw new Error(`Control ${s.ref} isn't a dropdown with "${s.option}". For a custom menu, click it, then click the option.`);
          done.push(`chose "${s.option}"`); await settle(me, 4000);
        } else if (s.do === 'key') { await key(me, s.key); done.push(`pressed ${s.key}`); await settle(me, 6000); }
        else if (s.do === 'scroll') {
          const dy = { down: 700, up: -700 }[s.direction ?? 'down'] ?? 0, dx = { right: 700, left: -700 }[s.direction] ?? 0;
          await send(me, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 450, deltaX: dx, deltaY: dy }); await sleep(500);
        } else if (s.do === 'wait') await sleep(Math.min(15, Math.max(0.2, Number(s.seconds) || 1)) * 1000);
        else if (s.do === 'back') { await evaluate(me, 'history.back()'); await settle(me); }
      }
      return snapshot(me);
    }),
    screenshot: () => serial(async () => {
      const me = await ready();
      const { data } = await send(me, 'Page.captureScreenshot', { format: 'jpeg', quality: 70 });
      return data;
    }),
    /** Signs in with a saved login on the page open now, only on that login's own site. The password goes from the
     *  vault straight into the page as typing; it never comes back out. */
    login: (row, username, password, { submit = true } = {}) => serial(async () => {
      const me = await ready();
      const onSite = async () => { if (!checkFill(await pageUrl(me), row)) throw new Error(`The page isn't on ${row.site} any more, so I didn't fill the login.`); };
      if (!checkFill(await pageUrl(me), row)) throw new Error(`This login is for ${row.site}, but the page is on another site. Open ${row.site}'s sign-in page first.`);
      // The visible username and password fields of the page itself (never one inside a frame from another site).
      const FIELDS = `(() => { const shown = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && !e.disabled && !e.readOnly; };
        const inputs = [...document.querySelectorAll('input')].filter(shown);
        const pass = inputs.find((e) => e.type === 'password' && e.autocomplete !== 'new-password') || inputs.find((e) => e.type === 'password');
        const users = inputs.filter((e) => /^(text|email|tel|)$/.test(e.type) && (pass ? (e.compareDocumentPosition(pass) & 4) : true));
        const user = users.find((e) => /username|email/.test(e.autocomplete)) || users.find((e) => /user|email|login|account|identifier|phone/i.test(e.name + ' ' + e.id + ' ' + (e.getAttribute('aria-label') || '') + ' ' + e.placeholder)) || (pass ? users[users.length - 1] : null);
        globalThis.__login = { user, pass };
        return { user: !!user, pass: !!pass, userFilled: !!(user && user.value) }; })()`;
      const focusField = (which) => evaluate(me, `(() => { const e = (globalThis.__login || {})['${which}']; if (!e || !e.isConnected) return false;
        e.scrollIntoView({ block: 'center', behavior: 'instant' }); e.focus(); e.select(); return document.activeElement === e; })()`);
      const typeInto = async (which, text) => {
        await onSite();
        if (!(await focusField(which))) throw new Error('The sign-in form changed while filling it. Try again.');
        await send(me, 'Input.insertText', { text });
      };
      let f = await evaluate(me, FIELDS);
      if (!f.user && !f.pass) throw new Error('There\'s no sign-in form on this page. Open the sign-in page (often a "Sign in" or "Log in" link) first.');
      if (f.user && f.pass) {
        await typeInto('user', username); await typeInto('pass', password);
        if (!submit) return `Filled the login. ${await snapshot(me)}`;
        await key(me, 'enter'); await settle(me);
        return `Filled the login and sent it.\n${await snapshot(me)}`;
      }
      if (f.user) {
        // Two steps (username, then password on the next screen).
        await typeInto('user', username);
        await key(me, 'enter'); await settle(me, 8000);
        for (const until = Date.now() + 8000; Date.now() < until; await sleep(400)) { f = await evaluate(me, FIELDS).catch(() => ({})); if (f.pass) break; }
        if (!f.pass) return `Sent the username; no password field came up (maybe a code or another step). ${await snapshot(me)}`;
      }
      await typeInto('pass', password);
      if (!submit) return `Filled the password. ${await snapshot(me)}`;
      await key(me, 'enter'); await settle(me);
      return `Filled the login and sent it.\n${await snapshot(me)}`;
    }),
    /** Brings the page onto the user's screen: the hidden browser is closed and the same profile opened in a window
     *  at the same address (sign-ins carry over). */
    show: () => serial(async () => {
      if (b && !b.headless) { await send(b, 'Page.bringToFront').catch(() => {}); return pageUrl(b); }
      const url = b ? await pageUrl(b).catch(() => 'about:blank') : 'about:blank';
      await close();
      const me = await start({ headless: false, url });
      stopIdle();
      return url ?? pageUrl(me);
    }),
    close: () => serial(close),
  };
}
