import { createEnvironmentMap, MAXIMUM_ENVIRONMENT_SIZE } from './environment.js';

const MAXIMUM_FILE_BYTES = 256 * 1024 ** 2;
const MINIMUM_RUN_LENGTH_WIDTH = 8;
const MAXIMUM_RUN_LENGTH_WIDTH = 32767;

function readLine(bytes, start) {
  let end = start;
  while (end < bytes.length && bytes[end] !== 0x0a) end++;
  if (end >= bytes.length) throw new Error('Radiance HDR header is truncated.');
  const text = String.fromCharCode(...bytes.subarray(start, Math.min(end, start + 256)));
  return { text: text.replace(/\r$/, ''), next: end + 1 };
}

function parseHeader(bytes) {
  let line = readLine(bytes, 0);
  if (!line.text.startsWith('#?')) throw new Error('Not a Radiance HDR file: missing #? signature.');
  let formatFound = false;
  let position = line.next;
  for (;;) {
    line = readLine(bytes, position);
    position = line.next;
    if (line.text === '') break;
    if (line.text.startsWith('FORMAT=')) {
      if (line.text !== 'FORMAT=32-bit_rle_rgbe') throw new Error(`Unsupported Radiance HDR format: ${line.text}.`);
      formatFound = true;
    }
  }
  if (!formatFound) throw new Error('Radiance HDR header has no FORMAT=32-bit_rle_rgbe line.');
  line = readLine(bytes, position);
  const resolution = /^-Y (\d+) \+X (\d+)$/.exec(line.text);
  if (!resolution) throw new Error('Unsupported Radiance HDR orientation. Only "-Y height +X width" is supported.');
  const height = Number(resolution[1]);
  const width = Number(resolution[2]);
  if (width < 1 || height < 1 || width > MAXIMUM_ENVIRONMENT_SIZE || height > MAXIMUM_ENVIRONMENT_SIZE) throw new RangeError('Radiance HDR dimensions are outside the supported range.');
  return { width, height, dataStart: line.next };
}

function readRunLengthScanline(bytes, startPosition, width, scanline) {
  let position = startPosition + 4;
  for (let channel = 0; channel < 4; channel++) {
    let column = 0;
    while (column < width) {
      if (position >= bytes.length) throw new Error('Radiance HDR pixel data is truncated.');
      const count = bytes[position++];
      const isRun = count > 128;
      const length = isRun ? count - 128 : count;
      if (length === 0 || column + length > width) throw new Error('Radiance HDR run length is invalid.');
      if (isRun) {
        if (position >= bytes.length) throw new Error('Radiance HDR pixel data is truncated.');
        const value = bytes[position++];
        for (let index = 0; index < length; index++) scanline[(column + index) * 4 + channel] = value;
      } else {
        if (position + length > bytes.length) throw new Error('Radiance HDR pixel data is truncated.');
        for (let index = 0; index < length; index++) scanline[(column + index) * 4 + channel] = bytes[position + index];
        position += length;
      }
      column += length;
    }
  }
  return position;
}

function startsRunLengthScanline(bytes, position, width) {
  return width >= MINIMUM_RUN_LENGTH_WIDTH && width <= MAXIMUM_RUN_LENGTH_WIDTH
    && bytes[position] === 2 && bytes[position + 1] === 2
    && ((bytes[position + 2] << 8) | bytes[position + 3]) === width;
}

// Parses Radiance RGBE (.hdr) data into linear RGB floats, top row first.
export function parseRadianceHdr(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length > MAXIMUM_FILE_BYTES) throw new RangeError('Radiance HDR file is larger than 256 MiB.');
  const { width, height, dataStart } = parseHeader(bytes);
  const data = new Float32Array(width * height * 3);
  const scanline = new Uint8Array(width * 4);
  let position = dataStart;
  for (let row = 0; row < height; row++) {
    if (startsRunLengthScanline(bytes, position, width)) {
      position = readRunLengthScanline(bytes, position, width, scanline);
    } else {
      if (position + width * 4 > bytes.length) throw new Error('Radiance HDR pixel data is truncated.');
      scanline.set(bytes.subarray(position, position + width * 4));
      position += width * 4;
    }
    for (let column = 0; column < width; column++) {
      const exponent = scanline[column * 4 + 3];
      const target = (row * width + column) * 3;
      if (exponent === 0) continue;
      const scale = 2 ** (exponent - 136);
      data[target] = scanline[column * 4] * scale;
      data[target + 1] = scanline[column * 4 + 1] * scale;
      data[target + 2] = scanline[column * 4 + 2] * scale;
    }
  }
  return { width, height, data };
}

// Fetches a .hdr file (for example a 1k or 2k Poly Haven HDRI) and returns an environment map descriptor.
export async function loadHdri(url, { intensity, rotation, showBackground, backgroundBlur, signal, fetchImplementation = globalThis.fetch } = {}) {
  const response = await fetchImplementation(url, { signal });
  if (!response.ok) throw new Error(`HDRI download failed: HTTP ${response.status}.`);
  const parsed = parseRadianceHdr(await response.arrayBuffer());
  return createEnvironmentMap({ ...parsed, intensity, rotation, showBackground, backgroundBlur });
}

export { createEnvironmentMap };

const SUN_PEAK_TO_MEAN_RATIO = 20;
const SUN_SEARCH_RADIUS = Math.PI / 18;

function luminanceAt(data, offset) {
  return 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
}

// Equirect pixel to a direction in the map's own frame (the inverse of the shader lookup, before `rotation`).
function mapDirection(column, row, width, height) {
  const azimuth = ((column + 0.5) / width - 0.5) * 2 * Math.PI;
  const polar = ((row + 0.5) / height) * Math.PI;
  return [Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), -Math.sin(polar) * Math.cos(azimuth)];
}

// The shader turns a world direction into the map frame with a turn about +Y; this is the inverse.
function worldFromMapDirection([x, y, z], rotation) {
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  return [cosine * x + sine * z, y, -sine * x + cosine * z];
}

/**
 * Finds the sun in an HDR environment map: the brightest 3 by 3 block, then the luminance-weighted centre of the pixels
 * within 10 degrees of it that reach half its brightness, so a single hot pixel does not move it.
 * Returns `{ lightDirection, keyColor, keyIntensity }` (world direction toward the sun with `rotation` applied, colour
 * with its largest channel at 1, and `irradiance / PI` of the sun disc scaled by the map intensity), or `null` when the
 * peak is under 20 times the mean luminance, as on an overcast sky.
 */
export function sunFromEnvironmentMap(map) {
  const { width, height, channels, data } = map;
  const rowWeights = Float64Array.from({ length: height }, (_, row) => Math.sin(((row + 0.5) / height) * Math.PI));
  const luminance = new Float32Array(width * height);
  let weightedTotal = 0;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const value = luminanceAt(data, (row * width + column) * channels);
      luminance[row * width + column] = value;
      weightedTotal += value * rowWeights[row];
    }
  }
  const meanLuminance = weightedTotal / (rowWeights.reduce((sum, weight) => sum + weight, 0) * width);

  let peakValue = 0;
  let peakColumn = 0;
  let peakRow = 0;
  for (let row = 1; row < height - 1; row++) {
    for (let column = 0; column < width; column++) {
      let blockSum = 0;
      for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
        for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
          blockSum += luminance[(row + rowOffset) * width + ((column + columnOffset + width) % width)];
        }
      }
      if (blockSum / 9 > peakValue) {
        peakValue = blockSum / 9;
        peakColumn = column;
        peakRow = row;
      }
    }
  }
  if (!(peakValue > SUN_PEAK_TO_MEAN_RATIO * meanLuminance)) return null;

  const peakDirection = mapDirection(peakColumn, peakRow, width, height);
  const minimumCosine = Math.cos(SUN_SEARCH_RADIUS);
  const pixelSolidAngle = ((2 * Math.PI) / width) * (Math.PI / height);
  const centre = [0, 0, 0];
  const colorSum = [0, 0, 0];
  let irradiance = 0;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const value = luminance[row * width + column];
      if (value < peakValue * 0.5) continue;
      const direction = mapDirection(column, row, width, height);
      const cosine = direction[0] * peakDirection[0] + direction[1] * peakDirection[1] + direction[2] * peakDirection[2];
      if (cosine < minimumCosine) continue;
      const weight = value * rowWeights[row];
      for (let axis = 0; axis < 3; axis++) {
        centre[axis] += direction[axis] * weight;
        colorSum[axis] += data[(row * width + column) * channels + axis] * weight;
      }
      irradiance += value * rowWeights[row] * pixelSolidAngle * Math.max(cosine, 0);
    }
  }
  const length = Math.hypot(...centre);
  const brightest = Math.max(...colorSum);
  return {
    lightDirection: worldFromMapDirection(centre.map((component) => component / length), map.rotation),
    keyColor: colorSum.map((component) => component / brightest),
    keyIntensity: (irradiance * map.intensity) / Math.PI,
  };
}

/**
 * Lights a scene from the HDRI sun. Spread the result into the renderer's `environment` and pass its `shadowBounds`:
 * `{ environment: { lightDirection, keyColor, keyIntensity }, shadowBounds }`. The shadow view looks at the middle of
 * `bounds` ({ min, max }) from the sun side and covers its bounding sphere. Without a distinct sun it returns `null`,
 * so the caller keeps its defaults.
 */
export function keyLightFromHdri(map, bounds) {
  const sun = sunFromEnvironmentMap(map);
  if (!sun) return null;
  const target = bounds.min.map((minimum, axis) => (minimum + bounds.max[axis]) / 2);
  const extent = Math.max(Math.hypot(...bounds.max.map((maximum, axis) => maximum - bounds.min[axis])) / 2, 1e-3);
  const eye = target.map((component, axis) => component + sun.lightDirection[axis] * extent * 2);
  const { lightDirection, keyColor, keyIntensity } = sun;
  return { environment: { lightDirection, keyColor, keyIntensity }, shadowBounds: { target, eye, extent, near: extent * 0.5, far: extent * 3.5 } };
}
