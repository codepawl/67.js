// Live examples for the documentation: the code beside a small canvas that runs it.
// Each run gets a fresh same-origin iframe, so a loop, a listener or a WebGL context of the last run cannot leak into the
// next one. The iframe imports `67js` through an import map whose entries are small modules that re-export the engine
// this page already loaded, so the docs run the same build as the site and need no published package.
import { highlightCode } from './code-highlight.js';

// Every addon the package exports, loaded only when an example imports it (67js/addons/<name>).
const addonLoaders = import.meta.glob([
  './model.js',
  './nature.js',
  './motion.js',
  './canvas2d.js',
  './gltf.js',
  './modeling.js',
  './sculpt.js',
  './surface.js',
  './mesh-query.js',
  './mesh.js',
  './shrinkwrap.js',
  './surface-attachment.js',
  './physics.js',
  './spume.js',
  './retarget.js',
  './crowd-skinning.js',
  './skeleton-pose.js',
  './vehicle.js',
  './vegetation.js',
  './terrain.js',
  './heightfield.js',
  './navmesh.js',
  './grass.js',
  './clutter.js',
  './light-bake.js',
  './light-bake-gpu.js',
  './ground-bounce.js',
  './floor-sky-visibility.js',
  './path-tracer.js',
  './texture-set.js',
  './agent-scene.js',
  './agent-asset.js',
  './hdri.js',
  './camera-effects.js',
  './water-reflection.js',
  './render-passes.js',
  './user-pass.js',
  './line-art.js',
  './mesh-blend.js',
  './coplanar-overlap.js',
  './reversed-depth.js',
  './material-layer-shaders.js',
  './view-transform-shader.js',
  './view-transform.js',
  './liquid-shader.js',
  './world-material-shader.js',
  './splat-shader.js',
  './subsurface-shader.js',
  './fog-shader.js',
  './light-linking.js',
  './cascaded-shadows.js',
  './compact-color.js',
  './gaussian-splats.js',
  './replace-textured-parts.js',
  './texture-update.js',
  './cloth.js',
  './update-part-vertices.js',
]);
const moduleCache = new Map();
// One message listener for all examples: each iframe reports by its example id.
const messageHandlers = new Map();
addEventListener('message', event => {
  if (event.origin !== location.origin) return;
  messageHandlers.get(event.data?.docsLive)?.(event.data);
});
const liveModules = {};
window.__docsLiveModules = liveModules;
let nextExampleNumber = 0;

const iconPaths = {
  run: '<path d="m8 5 11 7-11 7V5Z"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  warning: '<path d="M12 3 2 21h20L12 3Zm0 7v5m0 3v.01"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${iconPaths[name]}</svg>`;
}

function importSpecifiers(source) {
  const specifiers = new Set();
  for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specifiers.add(match[1]);
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.add(match[1]);
  return [...specifiers];
}

function sourceFileFor(specifier) {
  if (specifier === '67js' || specifier === '@codepawlhq/67js') return 'core';
  const addon = specifier.match(/^(?:67js|@codepawlhq\/67js)\/addons\/([\w-]+)$/);
  return addon ? `./${addon[1]}.js` : null;
}

async function loadNamespace(sourceFile) {
  if (!moduleCache.has(sourceFile)) {
    const loader = sourceFile === 'core' ? () => import('./index.js') : addonLoaders[sourceFile];
    if (!loader) throw new Error(`The live example cannot load ${sourceFile.slice(2, -3)}. Copy the code into a local project to use that addon.`);
    moduleCache.set(sourceFile, loader());
  }
  return moduleCache.get(sourceFile);
}

// One re-export module per specifier. Blob URLs are same-origin, so they pass the site's cross-origin isolation headers.
async function importMapFor(source) {
  const imports = {};
  for (const specifier of importSpecifiers(source)) {
    const sourceFile = sourceFileFor(specifier);
    if (!sourceFile) continue;
    const namespace = await loadNamespace(sourceFile);
    liveModules[sourceFile] = namespace;
    const names = Object.keys(namespace).filter(name => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name));
    const lines = names.map(name => `export const ${name} = modules[${JSON.stringify(sourceFile)}].${name};`);
    const text = `const modules = window.parent.__docsLiveModules;\n${lines.join('\n')}\n`;
    imports[specifier] = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  }
  return imports;
}

// The engine runs in the page and checks `instanceof Float32Array` and friends, which fails for arrays made in the iframe's
// own realm. The iframe uses the page's typed array constructors, so example code can write `new Float32Array(...)` as usual.
const typedArrayAliases = `
  for (const name of ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array']) {
    window[name] = parent[name];
  }`;

// The example's console.log, info, warn and error go to the page as text, so the docs can show what a call returns.
// Typed arrays print their length and first values; deep objects stop at three levels.
const consoleRelay = `
  const formatValue = (value, depth = 0) => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(Math.round(value * 1e4) / 1e4);
    if (value === null || typeof value !== 'object') return String(value);
    if (ArrayBuffer.isView(value)) {
      const head = Array.from(value.slice(0, 6), number => formatValue(number)).join(', ');
      return value.constructor.name + '(' + value.length + ') [' + head + (value.length > 6 ? ', …' : '') + ']';
    }
    if (value instanceof Error) return value.message;
    if (depth >= 3) return Array.isArray(value) ? '[…]' : '{…}';
    if (Array.isArray(value)) return '[' + value.slice(0, 20).map(item => formatValue(item, depth + 1)).join(', ') + (value.length > 20 ? ', …' : '') + ']';
    const entries = Object.entries(value).slice(0, 20).map(([key, item]) => key + ': ' + formatValue(item, depth + 1));
    return '{ ' + entries.join(', ') + ' }';
  };
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...values) => {
      original(...values);
      report({ log: { level, text: values.map(value => formatValue(value)).join(' ') } });
    };
  }`;
const CONSOLE_LINE_LIMIT = 200;

// Capture mode replaces the clock, so the media script can step a loop frame by frame and get the same picture every time.
const captureClock = `
  let virtualTime = 0;
  let queued = [];
  performance.now = () => virtualTime;
  window.requestAnimationFrame = callback => { queued.push(callback); return queued.length; };
  window.cancelAnimationFrame = () => {};
  window.__advance = milliseconds => {
    virtualTime += milliseconds;
    const callbacks = queued;
    queued = [];
    for (const callback of callbacks) callback(virtualTime);
  };`;

function frameDocument(source, imports, exampleId, capture) {
  const importMap = JSON.stringify({ imports }).replace(/</g, '\\u003c');
  const code = source.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#101014}#scene{display:block;width:100%;height:100%}</style>
<script type="importmap">${importMap}</script>
<script>
  const report = message => parent.postMessage({ docsLive: ${JSON.stringify(exampleId)}, ...message }, parent.location.origin);
  addEventListener('error', event => report({ error: event.message || 'The example failed.' }));
  addEventListener('unhandledrejection', event => report({ error: String(event.reason?.message ?? event.reason) }));
  ${typedArrayAliases}
  ${consoleRelay}
  ${capture ? captureClock : ''}
</script></head><body><canvas id="scene"></canvas>
<script type="module">${code}</script>
<script type="module">report({ ready: true });</script>
</body></html>`;
}

function releaseFrame(frame) {
  if (!frame) return;
  try {
    frame.contentWindow?.dispatchEvent(new Event('pagehide'));
    const canvas = frame.contentDocument?.querySelector('#scene');
    canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    // A frame that never loaded has nothing to release.
  }
  frame.remove();
}

function lineCount(text) {
  return text.split('\n').length;
}

/** Build a live example: a stage with the running scene, a toolbar, and an editor with the highlighted source. */
export function createLiveExample({ source, title, poster, file = 'main.js', aspect = '16 / 9' }) {
  const exampleId = `live-${nextExampleNumber++}`;
  const capture = new URLSearchParams(location.search).has('capture');
  const root = document.createElement('figure');
  root.className = 'live-example';
  root.dataset.example = exampleId;
  if (poster) root.dataset.media = poster;
  root.innerHTML = `
    <div class="live-stage" style="aspect-ratio:${aspect}">
      ${poster ? `<img class="live-poster" src="/docs-media/${poster}.webp" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
      <button class="live-start" type="button">${icon('run')}Run example</button>
    </div>
    <pre class="live-console" aria-label="Console output" hidden></pre>
    <div class="live-toolbar">
      <span class="live-file">${file}</span>
      <span class="live-status" role="status" aria-live="polite"></span>
      <button class="live-run" type="button" title="Run (Ctrl+Enter)">${icon('run')}Run</button>
      <button class="live-reset" type="button" disabled>${icon('reset')}Reset</button>
      <button class="live-copy" type="button">${icon('copy')}Copy</button>
    </div>
    <div class="live-editor">
      <pre aria-hidden="true"><code class="hljs language-javascript"></code></pre>
      <textarea spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Editable code for ${title}"></textarea>
    </div>`;
  const stage = root.querySelector('.live-stage');
  const startButton = root.querySelector('.live-start');
  const status = root.querySelector('.live-status');
  const consoleOutput = root.querySelector('.live-console');
  const resetButton = root.querySelector('.live-reset');
  const copyButton = root.querySelector('.live-copy');
  const editor = root.querySelector('textarea');
  const highlighted = root.querySelector('.live-editor code');
  editor.value = source;
  let frame = null;
  let running = false;
  let runTimer = 0;
  let runNumber = 0;

  function paintSource() {
    highlighted.innerHTML = `${highlightCode(editor.value, 'javascript')}\n`;
    editor.rows = lineCount(editor.value);
    resetButton.disabled = editor.value === source;
  }

  function setStatus(kind, text) {
    status.dataset.kind = kind;
    status.replaceChildren();
    if (!text) return;
    status.insertAdjacentHTML('afterbegin', icon(kind === 'error' ? 'warning' : 'check'));
    const label = document.createElement('span');
    label.textContent = text;
    status.append(label);
  }

  function clearConsole() {
    consoleOutput.replaceChildren();
    consoleOutput.hidden = true;
  }

  function appendConsoleLine({ level, text }) {
    if (consoleOutput.childElementCount >= CONSOLE_LINE_LIMIT) consoleOutput.firstElementChild.remove();
    const line = document.createElement('span');
    line.className = 'live-console-line';
    line.dataset.level = level;
    line.textContent = text;
    consoleOutput.append(line);
    consoleOutput.hidden = false;
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
  }

  async function run() {
    const thisRun = ++runNumber;
    running = true;
    clearConsole();
    root.classList.add('is-running');
    setStatus('busy', '');
    let imports;
    try {
      imports = await importMapFor(editor.value);
    } catch (error) {
      setStatus('error', error.message);
      return;
    }
    if (thisRun !== runNumber) return;
    releaseFrame(frame);
    for (const url of Object.values(root.dataset.imports ? JSON.parse(root.dataset.imports) : {})) URL.revokeObjectURL(url);
    root.dataset.imports = JSON.stringify(imports);
    frame = document.createElement('iframe');
    frame.className = 'live-frame';
    frame.title = `Result of ${title}`;
    frame.srcdoc = frameDocument(editor.value, imports, exampleId, capture);
    stage.append(frame);
  }

  function stop() {
    runNumber++;
    releaseFrame(frame);
    frame = null;
    running = false;
    root.classList.remove('is-running');
    delete root.dataset.ready;
    setStatus('idle', '');
  }

  messageHandlers.set(exampleId, message => {
    if (message.log) appendConsoleLine(message.log);
    else if (message.error) setStatus('error', message.error);
    else if (message.ready && status.dataset.kind !== 'error') {
      setStatus('ok', 'Running');
      root.dataset.ready = 'true';
    }
  });

  startButton.addEventListener('click', run);
  root.querySelector('.live-run').addEventListener('click', run);
  resetButton.addEventListener('click', () => {
    editor.value = source;
    paintSource();
    run();
  });
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(editor.value);
      copyButton.innerHTML = `${icon('check')}Copied`;
    } catch {
      editor.focus();
      editor.select();
      copyButton.innerHTML = `${icon('warning')}Select and copy`;
    }
    setTimeout(() => { copyButton.innerHTML = `${icon('copy')}Copy`; }, 2000);
  });
  editor.addEventListener('input', () => {
    paintSource();
    clearTimeout(runTimer);
    if (running) runTimer = setTimeout(run, 700);
  });
  editor.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      run();
    } else if (event.key === 'Tab' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
      paintSource();
    }
  });

  // Browsers allow a few WebGL contexts per page, so only examples near the screen keep one.
  const visibility = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting && running) stop();
    }
  }, { rootMargin: '400px 0px' });
  visibility.observe(root);
  function dispose() {
    stop();
    visibility.disconnect();
    messageHandlers.delete(exampleId);
  }
  root.liveExample = { run, stop, dispose };
  paintSource();
  return root;
}

/** Start the examples that show on screen, when the reader has not asked for reduced data or motion. */
export function autoRunVisibleExamples(container) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || navigator.connection?.saveData) return;
  const starter = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const example = entry.target;
      if (!example.classList.contains('is-running')) example.liveExample.run();
    }
  }, { threshold: 0.35 });
  for (const example of container.querySelectorAll('.live-example')) starter.observe(example);
  return starter;
}
