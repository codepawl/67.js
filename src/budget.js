const MEBIBYTE = 1024 * 1024;

/**
 * The error for a scene the memory budget cannot hold: the bytes it counted and the memoryBudgetMiB that fits them,
 * so one failed call says what to pass.
 */
export function memoryBudgetError(geometry, textures, frame, memoryBudgetMiB) {
  const mebibytes = bytes => (bytes / MEBIBYTE).toFixed(1);
  return new RangeError(`Memory budget cannot hold geometry ${mebibytes(geometry)} MiB, textures ${mebibytes(textures)} MiB and frame ${mebibytes(frame)} MiB, over memoryBudgetMiB ${memoryBudgetMiB}. Fix: pass { memoryBudgetMiB: ${Math.ceil((geometry + textures + frame) / MEBIBYTE)} }.`);
}

export const RENDER_PRESETS = Object.freeze({
  preview: { width: 960, height: 540, samples: 2, fps: 24, memoryBudgetMiB: 256 },
  balanced: { width: 1280, height: 720, samples: 4, fps: 24, memoryBudgetMiB: 384 },
  high: { width: 1920, height: 1080, samples: 4, fps: 24, memoryBudgetMiB: 512 },
  cpu: { width: 640, height: 360, samples: 1, fps: 12, memoryBudgetMiB: 192 },
});

export function estimateTextureBytes(width, height, { mipmaps = true } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('Texture dimensions must be positive integers.');
  let bytes = 0;
  do {
    bytes += width * height * 4;
    if (!mipmaps || (width === 1 && height === 1)) break;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  } while (true);
  return bytes;
}

export function estimateFrameBytes(width, height, samples, shadowResolution = 2048, { hdr = false, bloom = false, depth = false } = {}) {
  // Color/depth MSAA, resolve texture, browser buffers and one screenshot/encoder staging frame.
  const colorBytes = hdr ? 8 : 4;
  const frameBytes = width * height * ((colorBytes + 4) * Math.max(1, samples) + colorBytes + 16);
  const bloomBytes = bloom ? Math.ceil(width / 2) * Math.ceil(height / 2) * colorBytes * 2 : 0;
  return frameBytes + bloomBytes + (depth ? width * height * 4 : 0) + shadowResolution ** 2 * 4;
}

/**
 * Without memoryBudgetMiB the budget is sized to the scene: its geometry, textures and one full frame, at least 256 MiB
 * and at most 1024 MiB on a device that reports 8 GiB of memory or more (512 MiB otherwise). The plan returns it.
 */
export function planRenderSize({ width, height, pixelRatio = 1, samples = 4, memoryBudgetMiB, geometryBytes = 0, textureBytes = 0, hdr = false, bloom = false, depth = false, shadowResolution = 2048, maximumSize = 8192 }) {
  const requestedWidth = Math.max(1, Math.round(width * pixelRatio));
  const requestedHeight = Math.max(1, Math.round(height * pixelRatio));
  const fullFrameBytes = estimateFrameBytes(Math.min(requestedWidth, maximumSize), Math.min(requestedHeight, maximumSize), samples, shadowResolution, { hdr, bloom, depth });
  memoryBudgetMiB ??= Math.min(globalThis.navigator?.deviceMemory >= 8 ? 1024 : 512, Math.max(256, Math.ceil((geometryBytes + textureBytes + fullFrameBytes) / MEBIBYTE)));
  for (const value of [width, height, pixelRatio, samples, memoryBudgetMiB, maximumSize]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('Render dimensions, sample count and budget must be positive finite numbers.');
  }
  if (geometryBytes < 0 || !Number.isFinite(geometryBytes)) throw new Error('Geometry memory must be a nonnegative finite number.');
  if (textureBytes < 0 || !Number.isFinite(textureBytes)) throw new Error('Texture memory must be a nonnegative finite number.');
  if (!Number.isFinite(shadowResolution) || shadowResolution < 0) throw new Error('Shadow resolution must be nonnegative and finite.');
  const available = memoryBudgetMiB * MEBIBYTE - geometryBytes - textureBytes - shadowResolution ** 2 * 4;
  const bytesPerPixel = (hdr ? 12 : 8) * Math.max(1, samples) + (hdr ? 24 : 20) + (bloom ? hdr ? 4 : 2 : 0) + (depth ? 4 : 0);
  // The suggested budget fits the full requested frame, not only the minimum target.
  if (available < estimateFrameBytes(64, 64, samples, 0, { hdr, bloom, depth })) throw memoryBudgetError(geometryBytes, textureBytes, fullFrameBytes, memoryBudgetMiB);
  const scale = Math.min(1, maximumSize / requestedWidth, maximumSize / requestedHeight, Math.sqrt(available / (requestedWidth * requestedHeight * bytesPerPixel)));
  let renderWidth = Math.max(1, Math.floor(requestedWidth * scale));
  let renderHeight = Math.max(1, Math.floor(requestedHeight * scale));
  const budget = memoryBudgetMiB * MEBIBYTE;
  while (estimateFrameBytes(renderWidth, renderHeight, samples, shadowResolution, { hdr, bloom, depth }) + geometryBytes + textureBytes > budget) {
    renderWidth = Math.max(1, renderWidth - 1);
    renderHeight = Math.max(1, renderHeight - 1);
  }
  return { width: renderWidth, height: renderHeight, samples, hdr, bloom, depth, textureBytes, estimatedBytes: estimateFrameBytes(renderWidth, renderHeight, samples, shadowResolution, { hdr, bloom, depth }) + geometryBytes + textureBytes, memoryBudgetMiB, requiredMemoryMiB: Math.ceil((fullFrameBytes + geometryBytes + textureBytes) / MEBIBYTE), reduced: renderWidth < requestedWidth || renderHeight < requestedHeight };
}
