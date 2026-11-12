// The page side of the native tracer (packages/render-native), shared by the agent preview page and the bench harness. The
// tracer runs in the host process; the host exposes it on the page as `__67jsNativeBake` (see the agent runtime), and
// everything here packs a scene into the tables it reads and unpacks its answer.

function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function bytesFromBase64(data) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(data);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Each typed array of a packed native input as base64 bytes, keyed by table name. */
export function encodeNativeTables(input) {
  const tables = {};
  for (const [name, values] of Object.entries(input)) {
    if (ArrayBuffer.isView(values)) tables[name] = bytesToBase64(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  }
  return tables;
}

/**
 * A FORMAT-v2 input (an instanced scene) as the job export: the tables as base64, the array type of each table and the record
 * counts, which is all the job runner needs to rebuild the input for the "cycles" kernel.
 */
export function encodeNativeInputV2(input) {
  const counts = {};
  const types = {};
  for (const [name, value] of Object.entries(input)) {
    if (ArrayBuffer.isView(value)) types[name] = value.constructor.name;
    else if (typeof value === 'number') counts[name] = value;
  }
  return { schemaVersion: input.schemaVersion, tables: encodeNativeTables(input), types, counts };
}

function floatsFromBase64(data) {
  const bytes = bytesFromBase64(data);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

function floatsToBase64(values) {
  return bytesToBase64(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
}

/**
 * The texel tracer of the light bake on the native backend: the packed scene and the texels go to the host, which traces
 * them with ray queries and answers with the light that reaches each texel. Same arguments and answer as `traceTexelsOnGpu`.
 */
export async function traceTexelsOnNative(scene, texels, options) {
  const [pack, { buildNativeTexelInput }] = await Promise.all([import('../src/path-tracer-gpu-pack.js'), import('../packages/render-native/pack-input.mjs')]);
  const input = buildNativeTexelInput(scene, { texelCount: texels.count, samples: options.samples, bounces: options.bounces, seed: options.seed, fireflyClamp: options.fireflyClamp }, pack);
  const answer = await globalThis.__67jsNativeBake({
    action: 'trace',
    tables: encodeNativeTables(input),
    triangleCount: input.triangleCount,
    samples: options.samples,
    texelCount: texels.count,
    points: floatsToBase64(texels.points.subarray(0, texels.count * 3)),
    normals: floatsToBase64(texels.normals.subarray(0, texels.count * 3)),
  });
  if (answer.error) throw new Error(answer.error);
  return { radiance: floatsFromBase64(answer.radiance), escaped: floatsFromBase64(answer.escaped), gpu: answer.adapter, compileSeconds: answer.compileSeconds };
}

/** `traceTexelsOnNative` when the host offers a tracer that can run here, otherwise undefined. */
export async function nativeTexelTracerIfAvailable() {
  if (typeof globalThis.__67jsNativeBake !== 'function') return undefined;
  const status = await globalThis.__67jsNativeBake({ action: 'probe' });
  return status.available ? traceTexelsOnNative : undefined;
}
