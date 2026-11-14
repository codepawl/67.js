// Longest main-thread block while parsing and packing a generated PLY, sync against async.
// Run: node bench/gaussian-splats/async-block.mjs [splatCount] [runs]
// The event loop is probed by a timer that re-arms every millisecond; the longest gap between two ticks is the
// longest time the page could not draw or answer input.
import { performance } from 'node:perf_hooks';
import { createGaussianSplats, createGaussianSplatsAsync, parseGaussianSplatPly, parseGaussianSplatPlyAsync } from '../../src/gaussian-splats.js';

const splatCount = Number(process.argv[2] ?? 1_000_000);
const runCount = Number(process.argv[3] ?? 3);
const PROPERTIES = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const limits = { maximumCount: splatCount, maximumBytes: 2 ** 31 };

function buildPly(count) {
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${count}`, ...PROPERTIES.map(name => `property float ${name}`), 'end_header', ''].join('\n');
  const headerBytes = new TextEncoder().encode(header);
  const body = new Float32Array(count * PROPERTIES.length);
  for (let index = 0; index < count; index++) {
    const angle = index * 0.37;
    body.set([Math.cos(angle) * 5, Math.sin(angle) * 5, (index % 1000) * 0.01, Math.sin(index), Math.cos(index), 0.3, Math.sin(angle), Math.log(0.05), Math.log(0.1), Math.log(0.2), Math.cos(angle), Math.sin(angle), 0.2, 0.1], index * PROPERTIES.length);
  }
  const file = new Uint8Array(headerBytes.length + body.byteLength);
  file.set(headerBytes, 0);
  file.set(new Uint8Array(body.buffer), headerBytes.length);
  return file.buffer;
}

function startProbe() {
  let longestGap = 0;
  let last = performance.now();
  let running = true;
  function tick() {
    const now = performance.now();
    longestGap = Math.max(longestGap, now - last);
    last = now;
    if (running) setTimeout(tick, 1);
  }
  setTimeout(tick, 1);
  return () => {
    running = false;
    longestGap = Math.max(longestGap, performance.now() - last);
    return longestGap;
  };
}

async function measure(work) {
  const stopProbe = startProbe();
  const started = performance.now();
  await work();
  const totalMilliseconds = performance.now() - started;
  return { longestBlockMilliseconds: stopProbe(), totalMilliseconds };
}

const file = buildPly(splatCount);
const variants = {
  sync: async () => createGaussianSplats(parseGaussianSplatPly(file, limits), limits),
  async: async () => createGaussianSplatsAsync(await parseGaussianSplatPlyAsync(file, limits), limits),
};
await variants.sync();
for (const [name, work] of Object.entries(variants)) {
  const runs = [];
  for (let run = 0; run < runCount; run++) runs.push(await measure(work));
  const longest = Math.max(...runs.map(entry => entry.longestBlockMilliseconds));
  const total = Math.min(...runs.map(entry => entry.totalMilliseconds));
  console.log(`${name}: splats ${splatCount}, longest block ${longest.toFixed(1)} ms (worst of ${runCount}), total ${total.toFixed(0)} ms (best of ${runCount})`);
}
