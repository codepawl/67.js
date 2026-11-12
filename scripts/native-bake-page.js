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

// The triangle bound of a scene exported to the "cycles" kernel (see buildTraceScene's maximumTriangles); the legacy kernel and every
// other tracer keep the 400,000 of the CPU and WebGL paths.
export const NATIVE_JOB_MAXIMUM_TRIANGLES = 1_500_000;
// The instance bound of the same export (see buildTraceScene's maximumInstances).
export const NATIVE_JOB_MAXIMUM_INSTANCES = 1_000_000;

// Every table of the export travels as base64 inside one evaluate result, one JSON string, and V8 refuses a string above
// 536,870,888 characters. The bounds above are independent (about 299 characters per unique triangle, 214 per instance whose material record is shared
// and up to 555 per instance with a record of its own), so the export checks the sum of its real tables against this share of the limit; the rest is the JSON around the tables.
export const V8_MAXIMUM_STRING_LENGTH = 536_870_888;
export const NATIVE_EXPORT_MAXIMUM_CHARACTERS = Math.floor(V8_MAXIMUM_STRING_LENGTH * 0.95);

/** The base64 length of tables of these byte lengths: `4 * ceil(bytes / 3)` each, summed. */
export function encodedExportLength(byteLengths) {
  return byteLengths.reduce((total, bytes) => total + 4 * Math.ceil(bytes / 3), 0);
}

/**
 * Refuses tables, given as `[name, byteLength]` pairs, that would not fit one message. The error carries `exportTooLarge`, so the
 * export rethrows it (like `texturePoolFull`) and the job reports it instead of trying another packing of the same scene.
 */
export function requireTableSizesFit(tables) {
  const total = encodedExportLength(tables.map(([, bytes]) => bytes));
  if (total <= NATIVE_EXPORT_MAXIMUM_CHARACTERS) return;
  const largest = [...tables].sort((first, second) => second[1] - first[1]).slice(0, 3).map(([name, bytes]) => `${name} ${encodedExportLength([bytes])}`).join(', ');
  const error = new RangeError(`The native scene export is ${total} base64 characters in total (largest tables: ${largest}), over the ${NATIVE_EXPORT_MAXIMUM_CHARACTERS} one message can carry. Pass fewer parts (each instance takes about 214 characters, 555 when its material is not shared with another part), fewer unique triangles (about 299 each), or smaller textures.`);
  error.exportTooLarge = true;
  throw error;
}

/** `requireTableSizesFit` over the typed-array tables of a packed input. */
export function requireExportFits(input) {
  requireTableSizesFit(Object.entries(input).filter(([, values]) => ArrayBuffer.isView(values)).map(([name, values]) => [name, values.byteLength]));
}

/**
 * The scene of a native render job as the tables the job runner traces. With the "cycles" kernel (`kernel`) every scene is
 * exported as FORMAT-v2, so its materials reach the kernel whole; parts that share a geometry stay instances when
 * `instancing` is on. A scene the packer refuses (copies of an emissive mesh that emit different triangles, say) is
 * exported flattened, and a scene whose FORMAT-v2 materials cannot be built is exported as the v1 tables the legacy kernel
 * reads; each says why in `instancing` and `instancingReason`, or `materialsReason`. `wholeMaterials` tells whether the
 * kernel gets whole materials. `modules` holds buildTraceScene, refuseLocalVolumes, resolveTexture, buildNativeInput,
 * buildJobNativeInput, buildFlattenedJobNativeInput and `pack` (src/path-tracer-gpu-pack.js), which the page loads on demand.
 */
export function exportNativeSceneTables({ parts, environment, camera, options, kernel, instancing, modules }) {
  const { buildTraceScene, refuseLocalVolumes, resolveTexture, buildNativeInput, buildJobNativeInput, buildFlattenedJobNativeInput, pack } = modules;
  const wholeMaterials = kernel === 'cycles';
  const nativeLimits = wholeMaterials ? { maximumTriangles: NATIVE_JOB_MAXIMUM_TRIANGLES, maximumInstances: NATIVE_JOB_MAXIMUM_INSTANCES } : {};
  let traceScene = buildTraceScene(parts, environment, { instancing: wholeMaterials && instancing === true, ...nativeLimits });
  refuseLocalVolumes(traceScene, 'the native path tracer');
  let flattenedBecause;
  if (traceScene.instances) {
    try {
      const input = buildJobNativeInput(traceScene, camera, options, pack, resolveTexture);
      requireExportFits(input);
      return { ...encodeNativeInputV2(input), triangleCount: input.triangleCount, triangles: input.triangleCount, instances: input.instanceCount, wholeMaterials };
    } catch (error) {
      // A scene over the texture pool stays over it flattened: the caller gets that refusal, not a v1 atlas one.
      if (!(error instanceof RangeError) || error.texturePoolFull || error.exportTooLarge) throw error;
      flattenedBecause = error.message;
      traceScene = flattenRefusedScene(buildTraceScene, parts, environment, nativeLimits, flattenedBecause);
    }
  }
  const instancingNote = flattenedBecause === undefined ? {} : { instancing: 'flattened', instancingReason: flattenedBecause };
  let materialsReason;
  if (wholeMaterials) {
    try {
      const input = buildFlattenedJobNativeInput(traceScene, camera, options, pack, resolveTexture);
      requireExportFits(input);
      return { ...encodeNativeInputV2(input), triangleCount: input.triangleCount, triangles: traceScene.indices.length / 3, wholeMaterials, ...instancingNote };
    } catch (error) {
      if (error.texturePoolFull || error.exportTooLarge) throw error;
      // The scene stays traceable: the v1 tables carry what the kernel read before, and the report says why they were used.
      materialsReason = error.message;
    }
  }
  if (traceScene.partRayVisibility && !wholeMaterials) {
    throw new TypeError('A part sets rayVisibility to hide from a ray kind, which only the "cycles" kernel can carry. Use kernel "cycles", or drop the rayVisibility of the part.');
  }
  // The v1 tables of the "cycles" job fallback cannot carry visibility: the scene is drawn without it, and the report says so.
  const visibilityNote = traceScene.partRayVisibility ? { rayVisibility: 'ignored', rayVisibilityReason: materialsReason } : {};
  const input = buildNativeInputOrExplain(buildNativeInput, { ...traceScene, partRayVisibility: null }, camera, options, pack, materialsReason);
  requireExportFits(input);
  return { tables: encodeNativeTables(input), triangleCount: input.triangleCount, triangles: traceScene.indices.length / 3, wholeMaterials: false,
    ...(materialsReason === undefined ? {} : { materialsReason }), ...visibilityNote, ...instancingNote };
}

// The v1 tables are the fallback for a scene whose FORMAT-v2 materials failed; when they fail too, the error keeps the first reason.
function buildNativeInputOrExplain(buildNativeInput, traceScene, camera, options, pack, materialsReason) {
  try {
    return buildNativeInput(traceScene, camera, options, pack);
  } catch (error) {
    if (materialsReason === undefined || !(error instanceof RangeError)) throw error;
    throw new RangeError(`${error.message} The FORMAT-v2 export had already failed: ${materialsReason}`);
  }
}

// The flattened scene of parts the packer refused as instances. Every copy counts against the bound once flattened, so a scene
// that fitted as instances can be over it; the error then names the packer's refusal, since the geometry was already shared.
function flattenRefusedScene(buildTraceScene, parts, environment, nativeLimits, refusal) {
  try {
    return buildTraceScene(parts, environment, nativeLimits);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new RangeError(`The scene could not stay instanced (${refusal}) and is too large once every copy is flattened: ${error.message}`);
  }
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
