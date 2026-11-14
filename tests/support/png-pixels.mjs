import { inflateSync } from 'node:zlib';

// Decodes an 8-bit, non-interlaced RGB or RGBA PNG (what the preview page and the render jobs write) into rows of bytes, so a test can read pixels without
// an image library. Returns { width, height, channels, data } with data holding width * height * channels bytes.
export function decodePngPixels(bytes) {
  const buffer = Buffer.from(bytes);
  let width = 0;
  let height = 0;
  let channels = 0;
  const compressed = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) throw new RangeError('decodePngPixels reads 8-bit, non-interlaced PNGs only');
      channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0;
      if (!channels) throw new RangeError('decodePngPixels reads RGB or RGBA PNGs only');
    }
    if (type === 'IDAT') compressed.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)];
    for (let column = 0; column < stride; column++) {
      const left = column >= channels ? data[row * stride + column - channels] : 0;
      const up = row > 0 ? data[(row - 1) * stride + column] : 0;
      const upLeft = row > 0 && column >= channels ? data[(row - 1) * stride + column - channels] : 0;
      const stored = raw[row * (stride + 1) + 1 + column];
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      data[row * stride + column] = (stored + predicted) & 255;
    }
  }
  return { width, height, channels, data };
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  return distanceUp <= distanceUpLeft ? up : upLeft;
}

/** Mean red, green and blue (average of the three) over the rectangle of fractions [left, top, right, bottom] of the picture. */
export function meanBrightness(picture, [left, top, right, bottom]) {
  const firstColumn = Math.floor(left * picture.width);
  const lastColumn = Math.floor(right * picture.width);
  const firstRow = Math.floor(top * picture.height);
  const lastRow = Math.floor(bottom * picture.height);
  let total = 0;
  let count = 0;
  for (let row = firstRow; row < lastRow; row++) {
    for (let column = firstColumn; column < lastColumn; column++) {
      const at = (row * picture.width + column) * picture.channels;
      total += (picture.data[at] + picture.data[at + 1] + picture.data[at + 2]) / 3;
      count++;
    }
  }
  return total / count;
}
