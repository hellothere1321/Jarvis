'use strict';

const invoke = window.__TAURI_INTERNALS__.invoke;
const frame = document.querySelector('#widget');
const statusText = document.querySelector('#status');
// srcdoc inherits the host's CSP. This policy also denies same-origin scripts and styles in the widget.
const widgetPolicy = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">`;

// What the CSP may not stop in WebView2: preconnect/prefetch links reaching the network, a base address, and
// http-equiv metas (a refresh that navigates). A widget is one self-contained file, so it needs none of them.
function clean(html) {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  for (const el of doc.querySelectorAll('link, base, meta[http-equiv]')) el.remove();
  return doc.documentElement.outerHTML;
}

function control(action) {
  invoke('widget_control', { action }).catch(console.error);
}

document.querySelector('#drag').addEventListener('pointerdown', (e) => {
  if (e.isPrimary && e.button === 0 && e.isTrusted) control('drag');
});
document.querySelector('#close').addEventListener('click', () => control('close'));

invoke('widget_html').then(({ title, html }) => {
  document.querySelector('#title').textContent = title;
  frame.title = title;
  frame.srcdoc = widgetPolicy + clean(html);
  frame.hidden = false;
  statusText.hidden = true;
}, () => {
  statusText.textContent = 'This widget could not be loaded.';
});
