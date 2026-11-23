// The background browser (browser.mjs). Run: npm test. ROAMIES_BROWSER_TEST=1 also drives a real Chrome or Edge
// against a sign-in page on this computer (off by default: CI machines may have no browser).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { browserCandidates, createBrowser, findBrowser, openTarget, siteAddress } from '../browser.mjs';

// Website names as said aloud or typed.
for (const [said, want] of [
  ['skool.com', 'https://skool.com/'], ['skool dot com', 'https://skool.com/'], ['Skool Dot Com.', 'https://skool.com/'],
  ['you tube.com', 'https://youtube.com/'], ['youtube dot com slash shorts', 'https://youtube.com/shorts'],
  ['w w w dot bbc dot co dot uk', 'https://www.bbc.co.uk/'], ['www.bbc.co.uk/news', 'https://www.bbc.co.uk/news'],
  ['chess dotcom', 'https://chess.com/'], ['https://example.com/a?b=1', 'https://example.com/a?b=1'], ['"x.com"', 'https://x.com/'],
  ['localhost:3000', 'http://localhost:3000/'], ['news.ycombinator.com', 'https://news.ycombinator.com/'],
  // Names, not addresses: a search finds them.
  ['skool', null], ['the verge', null], ['best pizza near me', null], ['Notes.app', null], ['report.pdf', null],
  ['https://user:pw@example.com', null], ['javascript:alert(1)', null], ['', null], ['a b c d.com', null],
]) assert.equal(siteAddress(said), want, said);
assert.equal(openTarget('skool dot com'), 'https://skool.com/');
assert.equal(openTarget('the verge'), 'https://duckduckgo.com/?q=!ducky%20the%20verge');

// Where browsers live: Chrome first, then Edge; ROAMIES_BROWSER wins.
const win = browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\L' });
assert.equal(win[0], 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
assert.ok(win.includes('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'));
assert.equal(findBrowser('win32', { 'PROGRAMFILES(X86)': 'C:\\X' }, (p) => p.endsWith('msedge.exe')), 'C:\\X\\Microsoft\\Edge\\Application\\msedge.exe');
assert.equal(findBrowser('linux', { PATH: '/usr/bin' }, () => false), null);
assert.deepEqual(browserCandidates('darwin', { ROAMIES_BROWSER: '/opt/chrome' }), ['/opt/chrome']);
assert.ok(browserCandidates('darwin', { HOME: '/Users/t' })[0].startsWith('/Applications/Google Chrome.app/'));

// No browser installed: a plain answer instead of a crash.
await assert.rejects(createBrowser({ dataDir: os.tmpdir(), find: () => null }).open('https://example.com'), /No Chrome, Edge/);

if (process.env.ROAMIES_BROWSER_TEST === '1' && findBrowser()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-test-'));
  let posted = [];
  const page = (body) => `<!doctype html><title>Test</title>${body}`;
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST') {
        posted.push(`${req.url} ${body}`);
        return res.end(page(req.url === '/step1' ? '<form method=post action=/done><input type=password name=pw autocomplete=current-password></form>' : '<h1>Welcome back</h1>'));
      }
      if (req.url === '/two') return res.end(page('<form method=post action=/step1><label>Email <input name=email type=email></label><button>Next</button></form>'));
      // Drawn by a script, as most sign-in pages are.
      res.end(page('<div id=app></div><script>app.innerHTML = `<form method=post action=/done><input name=username placeholder="Username"><input type=password name=password><button>Sign in</button></form>`</script>'));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = String(srv.address().port), base = `http://127.0.0.1:${port}`, row = { site: '127.0.0.1', scheme: 'http', port };
  const b = createBrowser({ dataDir: dir });
  try {
    const first = await b.open(`${base}/`);
    assert.match(first, /\[1\] textbox "Username"/);
    assert.match(first, /\[2\] password field "password" \(empty\)/);
    const one = await b.login(row, 'me@example.com', 'hunter2!');
    assert.deepEqual(posted, ['/done username=me%40example.com&password=hunter2%21']);
    assert.ok(!one.includes('hunter2'), 'the password never comes back');
    posted = [];
    await b.open(`${base}/two`);
    const two = await b.login(row, 'me@example.com', 'hunter2!');
    assert.deepEqual(posted, ['/step1 email=me%40example.com', '/done pw=hunter2%21'], 'username, then password on the next screen');
    assert.ok(!two.includes('hunter2'));
    // Typed text shows; a typed password only says it's filled.
    await b.open(`${base}/`);
    const typed = await b.act([{ do: 'type', ref: 1, text: 'someone' }, { do: 'type', ref: 2, text: 'secret-words' }]);
    assert.match(typed, /textbox "Username" = "someone"/);
    assert.match(typed, /password field "password" \(filled\)/);
    assert.ok(!typed.includes('secret-words'));
    // Another site's login is refused before anything is typed.
    await assert.rejects(b.login({ ...row, port: '1' }, 'u', 'p'), /another site/);
    assert.ok((await b.screenshot()).length > 1000);
  } finally {
    await b.close();
    srv.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
console.log('browser tests: passed');
