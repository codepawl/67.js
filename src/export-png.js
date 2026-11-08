const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAXIMUM_STORED_BLOCK = 65535;
const CRC_TABLE = createCrcTable();

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let byte = 0; byte < 256; byte++) {
    let value = byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
    table[byte] = value >>> 0;
  }
  return table;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let low = 1;
  let high = 0;
  for (let index = 0; index < bytes.length; index++) {
    low = (low + bytes[index]) % 65521;
    high = (high + low) % 65521;
  }
  return (high << 16 | low) >>> 0;
}

/** zlib stream made of stored blocks: no compression, so encoding stays synchronous and needs no platform API. */
function storedZlib(raw) {
  const blockCount = Math.max(1, Math.ceil(raw.length / MAXIMUM_STORED_BLOCK));
  const output = new Uint8Array(2 + raw.length + blockCount * 5 + 4);
  const view = new DataView(output.buffer);
  output[0] = 0x78;
  output[1] = 0x01;
  let writeOffset = 2;
  for (let block = 0; block < blockCount; block++) {
    const start = block * MAXIMUM_STORED_BLOCK;
    const length = Math.min(MAXIMUM_STORED_BLOCK, raw.length - start);
    output[writeOffset] = block === blockCount - 1 ? 1 : 0;
    view.setUint16(writeOffset + 1, length, true);
    view.setUint16(writeOffset + 3, ~length & 0xffff, true);
    output.set(raw.subarray(start, start + length), writeOffset + 5);
    writeOffset += 5 + length;
  }
  view.setUint32(writeOffset, adler32(raw));
  return output;
}

function chunk(type, data) {
  const output = new Uint8Array(12 + data.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index++) output[4 + index] = type.charCodeAt(index);
  output.set(data, 8);
  view.setUint32(8 + data.length, crc32(output.subarray(4, 8 + data.length)));
  return output;
}

export { PNG_SIGNATURE, chunk as pngChunk };

function hasTransparentPixel(pixels) {
  for (let offset = 3; offset < pixels.length; offset += 4) {
    if (pixels[offset] !== 255) return true;
  }
  return false;
}

/**
 * Encode RGBA8 pixels as a PNG. Rows are reversed when `flipRows` is true, for textures uploaded with flipY.
 * Pixels with full alpha everywhere are written as RGB, a quarter smaller.
 */
export function encodePng(pixels, width, height, { flipRows = false } = {}) {
  const withAlpha = hasTransparentPixel(pixels);
  const channels = withAlpha ? 4 : 3;
  const rowBytes = width * channels;
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let row = 0; row < height; row++) {
    const sourceRow = flipRows ? height - 1 - row : row;
    const target = row * (rowBytes + 1);
    raw[target] = 0;
    for (let column = 0; column < width; column++) {
      const source = (sourceRow * width + column) * 4;
      const destination = target + 1 + column * channels;
      raw[destination] = pixels[source];
      raw[destination + 1] = pixels[source + 1];
      raw[destination + 2] = pixels[source + 2];
      if (withAlpha) raw[destination + 3] = pixels[source + 3];
    }
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8;
  header[9] = withAlpha ? 6 : 2;
  const parts = [Uint8Array.from(PNG_SIGNATURE), chunk('IHDR', header), chunk('IDAT', storedZlib(raw)), chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
