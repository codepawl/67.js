import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { cookFile, cookInstalled, cookModule, cookTest } from './support/cook.js';
import { createCamera } from '../src/path-tracer.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import * as pack from '../src/path-tracer-gpu-pack.js';

const cook = await cookModule();
const packInput = await cookModule('pack-input');
const { findNativeAddon, resolveNativeKernel, traceNative } = cook ?? {};
const { buildNativeInput } = packInput ?? {};

function floor() {
  return {
    positions: new Float32Array([-1, 0, 1, 1, 0, 1, 1, 0, -1, -1, 0, -1]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

const camera = createCamera({ eye: [0, 1, 4], target: [0, 1, 0], fov: 50 }, 16, 16);
const options = { width: 16, height: 16, samples: 1, bounces: 2, seed: 0 };
const plainParts = [{ name: 'floor', geometry: floor(), material: { color: [0.5, 0.5, 0.5] } }];
const subsurfaceParts = [{ name: 'skin', geometry: floor(), material: { color: [0.7, 0.4, 0.3], subsurface: { weight: 1, radius: [1, 0.2, 0.1], scale: 0.05 } } }];
const fog = { volumeFog: { minimum: [-30, 1, -30], maximum: [30, 2, 30], density: 0.5 } };

function floatWords(input) {
  return new Float32Array(input.parameters.buffer, input.parameters.byteOffset, input.parameters.byteLength / 4);
}

function unsignedWords(input) {
  return new Uint32Array(input.parameters.buffer, input.parameters.byteOffset, input.parameters.byteLength / 4);
}

cookTest('a plain scene packs no fog and no subsurface table, so the kernel compiles without either', () => {
  const input = buildNativeInput(buildTraceScene(plainParts, {}), camera, options, pack);
  assert.equal(input.parameters.byteLength, 16 * 16);
  assert.equal(floatWords(input)[51], 0, 'fog density');
  assert.equal(unsignedWords(input)[60], 0, 'subsurface offset');
  assert.equal(floatWords(input)[35], 0, 'noise threshold');
});

cookTest('fog packs its box, medium and density where the kernel reads them', () => {
  const input = buildNativeInput(buildTraceScene(plainParts, fog), camera, options, pack);
  const words = floatWords(input);
  assert.deepEqual([...words.subarray(48, 51)], [-30, 1, -30]);
  assert.equal(words[51], 0.5);
  assert.deepEqual([...words.subarray(52, 55)], [30, 2, 30]);
});

cookTest('subsurface appends its table after the materials and points the kernel at it', () => {
  const scene = buildTraceScene(subsurfaceParts, {});
  const plainMaterials = pack.packMaterials(scene.materials, pack.packAtlas(scene.materials)).data;
  const input = buildNativeInput(scene, camera, options, pack);
  const offset = unsignedWords(input)[60];
  assert.equal(offset, plainMaterials.length / 4);
  assert.equal(input.materials.length, plainMaterials.length + pack.packSubsurface(scene.materials).data.length);
  assert.equal(input.materials[offset * 4], 1, 'the subsurface weight of the first material');
});

cookTest('noiseThreshold lands in the parameter block and defaults to drawing every sample', () => {
  const input = buildNativeInput(buildTraceScene(plainParts, {}), camera, { ...options, noiseThreshold: 0.02 }, pack);
  assert.ok(Math.abs(floatWords(input)[35] - 0.02) < 1e-7);
});

cookTest('the kernel declares the two constants the host rewrites and reads the vectors the packer writes', () => {
  const kernel = readFileSync(cookFile('src/kernel.wgsl'), 'utf8');
  assert.match(kernel, /const HAS_VOLUME: bool = false;/);
  assert.match(kernel, /const HAS_SUBSURFACE: bool = false;/);
  assert.match(kernel, /volumeMinimumDensity: vec4<f32>,\s+volumeMaximumAnisotropy: vec4<f32>,\s+volumeAlbedoDistance: vec4<f32>,\s+\/\/[^\n]*\n\s+extras: vec4<u32>,/);
});

function withKernelEnv(value, callback) {
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'JS67_NATIVE_KERNEL');
  const previous = process.env.JS67_NATIVE_KERNEL;
  if (value === undefined) {
    delete process.env.JS67_NATIVE_KERNEL;
  } else {
    process.env.JS67_NATIVE_KERNEL = value;
  }
  try {
    return callback();
  } finally {
    if (hadKey) {
      process.env.JS67_NATIVE_KERNEL = previous;
    } else {
      delete process.env.JS67_NATIVE_KERNEL;
    }
  }
}

cookTest('resolveNativeKernel defaults to legacy, falls back to JS67_NATIVE_KERNEL, and rejects unknown names', () => {
  withKernelEnv(undefined, () => {
    assert.equal(resolveNativeKernel(undefined), 'legacy');
    assert.equal(resolveNativeKernel('legacy'), 'legacy');
    assert.equal(resolveNativeKernel('cycles'), 'cycles');
  });
  withKernelEnv('', () => {
    assert.equal(resolveNativeKernel(undefined), 'legacy');
  });
  withKernelEnv('cycles', () => {
    assert.equal(resolveNativeKernel(undefined), 'cycles');
    assert.equal(resolveNativeKernel('legacy'), 'legacy');
  });
  withKernelEnv('bogus', () => {
    assert.throws(() => resolveNativeKernel(undefined), /Invalid native kernel.*"legacy".*"cycles"/);
    assert.equal(resolveNativeKernel('legacy'), 'legacy');
  });
  const input = buildNativeInput(buildTraceScene(plainParts, {}), camera, options, pack);
  for (const invalid of ['optix', '', null, 42]) {
    assert.throws(
      () => traceNative(input, { ...options, kernel: invalid }),
      /Invalid native kernel.*"legacy".*"cycles"/,
    );
  }
});

cookTest('traceNative traces finite RGBA pixels on both legacy and cycles kernels', { skip: !cookInstalled || !findNativeAddon() }, () => {
  const input = buildNativeInput(buildTraceScene(plainParts, {}), camera, options, pack);
  const cyclesResult = traceNative(input, { ...options, kernel: 'cycles' });
  assert.equal(cyclesResult.rgba.length, options.width * options.height * 4);
  assert.ok(cyclesResult.rgba.every(Number.isFinite));
  assert.equal(cyclesResult.averageSamples, options.samples);
  withKernelEnv('cycles', () => {
    const envCyclesResult = traceNative(input, options);
    assert.equal(envCyclesResult.rgba.length, options.width * options.height * 4);
    assert.ok(envCyclesResult.rgba.every(Number.isFinite));
    const legacyResult = traceNative(input, { ...options, kernel: 'legacy' });
    assert.equal(legacyResult.rgba.length, options.width * options.height * 4);
    assert.ok(legacyResult.rgba.every(Number.isFinite));
  });
});

function wgslFieldMetrics(wgslType) {
  const table = {
    u32: { size: 4, align: 4 },
    i32: { size: 4, align: 4 },
    f32: { size: 4, align: 4 },
    'vec2<f32>': { size: 8, align: 8 },
    'vec2<u32>': { size: 8, align: 8 },
    'vec3<f32>': { size: 12, align: 16 },
    'vec3<u32>': { size: 12, align: 16 },
    'vec4<f32>': { size: 16, align: 16 },
    'vec4<u32>': { size: 16, align: 16 },
  };
  return table[wgslType] ?? null;
}

function parseWgslStructs(source) {
  const uncommented = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const structs = new Map();
  const structPattern = /struct\s+([A-Za-z_]\w*)\s*\{([^}]*)\}/g;
  for (const match of uncommented.matchAll(structPattern)) {
    const [, structName, body] = match;
    const fields = [];
    for (const rawField of body.split(/,(?![^<]*>)/)) {
      const trimmed = rawField.trim();
      if (!trimmed) continue;
      const fieldMatch = /^(?:@align\((\d+)\)\s+)?([A-Za-z_]\w*)\s*:\s*(.+)$/.exec(trimmed);
      assert.ok(fieldMatch, `Could not parse WGSL field in ${structName}: ${trimmed}`);
      fields.push({
        explicitAlign: fieldMatch[1] ? Number(fieldMatch[1]) : null,
        name: fieldMatch[2],
        type: fieldMatch[3].trim(),
      });
    }
    structs.set(structName, fields);
  }
  return { uncommented, structs };
}

function parseFormatV2Tables(markdown) {
  const sections = new Map();
  const sectionPattern = /^##\s+\d+\.[^\n]*`([A-Za-z0-9_]+)`[\s\S]*?Total (?:size|stride):\s*\*\*(\d+) bytes\*\*[\s\S]*?\n\| Byte Offset[^\n]*\n\|[-:\s|]+\n((?:\|[^\n]*\n)+)/gm;
  for (const match of markdown.matchAll(sectionPattern)) {
    const [, structName, strideText, rowsText] = match;
    const rows = rowsText
      .trim()
      .split(/\r?\n/)
      .map(line => {
        const columns = line.split('|').slice(1, -1).map(cell => cell.trim().replace(/^`|`$/g, ''));
        return {
          offset: Number(columns[0]),
          size: Number(columns[1]),
          align: Number(columns[2]),
          type: columns[3],
          name: columns[4],
        };
      });
    sections.set(structName, { totalStride: Number(strideText), rows });
  }
  return sections;
}

cookTest('cycles kernel manifest, signatures-only abi.wgsl, and FORMAT-v2.md agree byte for byte', () => {
  const manifestPath = cookFile('src/cycles/kernel-manifest.txt');
  const manifestEntries = readFileSync(manifestPath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.split('#')[0].trim())
    .filter(Boolean);
  assert.ok(manifestEntries.includes('abi.wgsl'), 'kernel-manifest.txt must list abi.wgsl first');
  for (const entry of manifestEntries) {
    assert.ok(
      existsSync(cookFile(`src/cycles/${entry}`)),
      `Missing WGSL file listed in kernel-manifest.txt: ${entry}`,
    );
  }

  const abiSource = readFileSync(cookFile('src/cycles/abi.wgsl'), 'utf8');
  assert.match(abiSource, /fn closure_eval\(closure: ptr<function, Closure>, wi: vec3<f32>, wo: vec3<f32>\) -> ClosureEval/);
  assert.match(abiSource, /fn closure_sample\(closure: ptr<function, Closure>, wo: vec3<f32>, u: vec3<f32>\) -> ClosureSample/);

  const { uncommented, structs } = parseWgslStructs(abiSource);
  assert.doesNotMatch(uncommented, /\bfn\s+[A-Za-z_]\w*/, 'abi.wgsl must be signatures-only with no stub fn bodies');
  for (const requiredStruct of ['ShadingPoint', 'Lobe', 'Closure', 'ClosureEval', 'ClosureSample']) {
    assert.ok(structs.has(requiredStruct), `abi.wgsl must define ${requiredStruct}`);
  }
  for (let binding = 0; binding <= 11; binding++) {
    assert.match(uncommented, new RegExp(`@group\\(0\\)\\s*@binding\\(${binding}\\)`));
  }

  const formatMarkdown = readFileSync(cookFile('FORMAT-v2.md'), 'utf8');
  const documentedStructs = parseFormatV2Tables(formatMarkdown);
  const expectedBufferStructs = [
    'KernelParamsV2',
    'InstanceRecord',
    'TriangleRecord',
    'MaterialRecord',
    'EmissiveTriangleRecord',
    'LightRecord',
    'LightTreeNode',
    'TextureDescriptor',
  ];
  assert.deepEqual([...documentedStructs.keys()].sort(), [...expectedBufferStructs].sort());

  for (const structName of expectedBufferStructs) {
    const wgslFields = structs.get(structName);
    assert.ok(wgslFields, `Missing ${structName} in abi.wgsl`);
    const documented = documentedStructs.get(structName);
    assert.equal(wgslFields.length, documented.rows.length, `${structName} field count mismatch`);
    let cursor = 0;
    let structAlign = 1;
    for (let index = 0; index < wgslFields.length; index++) {
      const wgslField = wgslFields[index];
      const docRow = documented.rows[index];
      const baseMetrics = wgslFieldMetrics(wgslField.type);
      assert.ok(baseMetrics, `Unsupported WGSL field type ${wgslField.type} in ${structName}.${wgslField.name}`);
      const fieldAlign = Math.max(baseMetrics.align, wgslField.explicitAlign ?? 0);
      assert.equal(wgslField.name, docRow.name, `${structName} field #${index} name`);
      assert.equal(wgslField.type, docRow.type, `${structName}.${wgslField.name} type`);
      assert.equal(cursor % fieldAlign, 0, `${structName}.${wgslField.name} has implicit padding at byte ${cursor}`);
      assert.equal(cursor, docRow.offset, `${structName}.${wgslField.name} byte offset`);
      assert.equal(baseMetrics.size, docRow.size, `${structName}.${wgslField.name} byte size`);
      assert.equal(fieldAlign, docRow.align, `${structName}.${wgslField.name} byte align`);
      cursor += baseMetrics.size;
      if (fieldAlign > structAlign) structAlign = fieldAlign;
    }
    assert.equal(structAlign, 16, `${structName} must stay 16-byte aligned`);
    assert.equal(cursor % structAlign, 0, `${structName} total stride ${cursor} must be a multiple of 16`);
    assert.equal(cursor, documented.totalStride, `${structName} total byte stride`);
  }
});
