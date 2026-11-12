// The local page behind scene_ask_user (issue #922): it shows one rendered view, lets the person pin points on it with a short
// note each, and returns the marks when they press Send. It listens on loopback only, under a random path, with no remote assets.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { isPreviewHost } from './preview-host.mjs';
import { ANNOTATE_LIMITS, validateMarks, isBoundedPng } from '../src/agent-annotate.js';

const MAXIMUM_BODY_BYTES = 2 * 1024 * 1024;

function pageHtml({ prompt, width, height, maxMarks, maxNoteLength }) {
  const escaped = prompt.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mark the scene</title><style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#182126;color:#e8eef0;font:15px/1.4 system-ui,sans-serif;display:flex;flex-direction:column;gap:16px;padding:20px}
h1{margin:0;font-size:18px;font-weight:600}
main{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.stage{position:relative;line-height:0;flex:0 1 ${width}px;max-width:100%;cursor:crosshair;user-select:none}
.stage img{width:100%;height:auto;border-radius:8px;display:block}
.pin{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:#ff5a4f;color:#fff;font:600 13px/26px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff;pointer-events:none}
aside{flex:1 1 280px;max-width:380px;display:flex;flex-direction:column;gap:12px;user-select:none}
.row{display:flex;gap:10px;align-items:center}
.badge{flex:none;width:26px;height:26px;border-radius:50%;background:#ff5a4f;color:#fff;font:600 13px/26px system-ui,sans-serif;text-align:center}
input{flex:1;min-width:0;height:36px;border:0;border-radius:6px;background:#26343b;color:inherit;padding:0 10px;font:inherit;user-select:text}
input:focus{outline:2px solid #6fb7ff}
button{height:36px;border:0;border-radius:6px;padding:0 14px;font:inherit;color:inherit;background:transparent;cursor:pointer;display:inline-flex;gap:8px;align-items:center}
button:hover{background:#26343b}
button.primary{background:#2f7dd1;color:#fff}
button.primary:hover{background:#3a8ae0}
button.icon{width:36px;padding:0;justify-content:center;flex:none}
button:disabled{opacity:.5;cursor:default}
svg{width:18px;height:18px;flex:none}
.actions{display:flex;gap:8px;margin-top:4px}
.hint,.count{color:#9db0b8}
.done{display:flex;gap:10px;align-items:center;font-size:17px}
.done svg{width:26px;height:26px}
.ok{color:#58d68d}.stop{color:#f0b429}
</style></head><body>
<h1>${escaped || 'Click the scene to mark what you mean'}</h1>
<main>
<div class="stage" id="stage"><img id="frame" src="frame.png" width="${width}" height="${height}" alt="Rendered scene"></div>
<aside id="side">
<div class="hint" id="hint">Click the picture to drop a pin, then say what to change there.</div>
<div id="rows" style="display:flex;flex-direction:column;gap:8px"></div>
<div class="count" id="count"></div>
<div class="actions"><button class="primary" id="send">Send</button><button id="cancel">Cancel</button></div>
</aside>
</main>
<script type="application/json" id="limits">${JSON.stringify({ width, height, maxMarks, maxNoteLength })}</script>
<script src="app.js"></script>
</body></html>`;
}

// Served as its own file because the page's content security policy allows scripts from this origin only.
const PAGE_SCRIPT = `(() => {
const limits = JSON.parse(document.getElementById('limits').textContent);
const marks = [];
const stage = document.getElementById('stage');
const frame = document.getElementById('frame');
const rows = document.getElementById('rows');
const count = document.getElementById('count');
const sendButton = document.getElementById('send');
const trash = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
function render() {
  stage.querySelectorAll('.pin').forEach(pin => pin.remove());
  rows.textContent = '';
  marks.forEach((mark, index) => {
    const pin = document.createElement('div');
    pin.className = 'pin';
    pin.textContent = index + 1;
    pin.style.left = (mark.x / limits.width * 100) + '%';
    pin.style.top = (mark.y / limits.height * 100) + '%';
    stage.appendChild(pin);
    const row = document.createElement('div');
    row.className = 'row';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = index + 1;
    const input = document.createElement('input');
    input.maxLength = limits.maxNoteLength;
    input.value = mark.note;
    input.placeholder = 'What should change here?';
    input.addEventListener('input', () => { mark.note = input.value; });
    const remove = document.createElement('button');
    remove.className = 'icon';
    remove.title = 'Remove pin';
    remove.setAttribute('aria-label', 'Remove pin ' + (index + 1));
    remove.innerHTML = trash;
    remove.addEventListener('click', () => { marks.splice(index, 1); render(); });
    row.append(badge, input, remove);
    rows.appendChild(row);
    mark.input = input;
  });
  count.textContent = marks.length + ' of ' + limits.maxMarks + ' pins';
  sendButton.disabled = marks.length === 0;
}
stage.addEventListener('click', event => {
  if (marks.length >= limits.maxMarks) return;
  const box = frame.getBoundingClientRect();
  const x = (event.clientX - box.left) / box.width * limits.width;
  const y = (event.clientY - box.top) / box.height * limits.height;
  marks.push({ x, y, note: '' });
  render();
  marks[marks.length - 1].input.focus();
});
function markedImage() {
  const canvas = document.createElement('canvas');
  canvas.width = limits.width;
  canvas.height = limits.height;
  const context = canvas.getContext('2d');
  context.drawImage(frame, 0, 0, limits.width, limits.height);
  context.font = '600 15px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  marks.forEach((mark, index) => {
    context.beginPath();
    context.arc(mark.x, mark.y, 14, 0, Math.PI * 2);
    context.fillStyle = '#ff5a4f';
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = '#fff';
    context.stroke();
    context.fillStyle = '#fff';
    context.fillText(String(index + 1), mark.x, mark.y + 1);
  });
  return canvas.toDataURL('image/png').split(',')[1];
}
function finish(kind, text) {
  const icon = kind === 'ok'
    ? '<svg class="ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M7.5 12.5l3 3 6-6.5"/></svg>'
    : '<svg class="stop" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>';
  document.getElementById('side').innerHTML = '<div class="done">' + icon + '<span>' + text + '</span></div>';
}
async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.text()) || 'The request failed.');
}
sendButton.addEventListener('click', async () => {
  sendButton.disabled = true;
  try {
    await post('send', { marks: marks.map(({ x, y, note }) => ({ x, y, note })), image: markedImage() });
    finish('ok', 'Sent to the agent. You can close this tab.');
  } catch (error) {
    sendButton.disabled = false;
    document.getElementById('hint').textContent = error.message;
  }
});
document.getElementById('cancel').addEventListener('click', async () => {
  await post('cancel', {}).catch(() => {});
  finish('stop', 'Cancelled. You can close this tab.');
});
render();
})();`;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', chunk => {
      total += chunk.length;
      if (total > MAXIMUM_BODY_BYTES) {
        reject(new RangeError('The request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * Serves one annotate page and waits for the person. `open(url)` shows the page (the runtime opens the browser; a test fetches it).
 * Resolves { outcome: 'sent' | 'cancelled' | 'timeout', url, marks?, image? }; a rejected `open` rejects with the page address.
 */
export async function runAnnotateSession({ png, width, height, prompt = '', maxMarks = ANNOTATE_LIMITS.maxMarks, waitMs, open }) {
  const token = randomBytes(16).toString('hex');
  const base = `/${token}/`;
  const frameBytes = Buffer.from(png, 'base64');
  const html = pageHtml({ prompt, width, height, maxMarks, maxNoteLength: ANNOTATE_LIMITS.maxNoteLength });
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'");
    if (!isPreviewHost(request.headers.host, server.address().port) || !request.url.startsWith(base)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const route = request.url.slice(base.length);
    try {
      if (request.method === 'GET' && route === '') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(html);
      } else if (request.method === 'GET' && route === 'app.js') {
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.end(PAGE_SCRIPT);
      } else if (request.method === 'GET' && route === 'frame.png') {
        response.setHeader('Content-Type', 'image/png');
        response.end(frameBytes);
      } else if (request.method === 'POST' && route === 'cancel') {
        response.end('ok');
        finish({ outcome: 'cancelled' });
      } else if (request.method === 'POST' && route === 'send') {
        const body = JSON.parse(await readBody(request));
        const marks = validateMarks(body.marks, { width, height, maxMarks });
        if (!marks.length) throw new TypeError('Add at least one pin before sending.');
        if (!isBoundedPng(body.image)) throw new TypeError('The marked picture is not a PNG within 1 MiB.');
        response.end('ok');
        finish({ outcome: 'sent', marks, image: body.image });
      } else {
        response.writeHead(404);
        response.end();
      }
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}${base}`;
  let timer;
  try {
    try {
      await open(url);
    } catch (error) {
      throw new Error(`Could not open the browser (${error.message}). The annotate page was ${url}`);
    }
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ outcome: 'timeout' }), waitMs); });
    return { url, ...await Promise.race([finished, timeout]) };
  } finally {
    clearTimeout(timer);
    // Let the answer to the page finish: close idle connections now and any straggler after a second.
    const straggler = setTimeout(() => server.closeAllConnections?.(), 1000);
    await new Promise(resolve => {
      server.close(resolve);
      server.closeIdleConnections?.();
    });
    clearTimeout(straggler);
  }
}
