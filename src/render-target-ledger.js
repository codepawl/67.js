// Lists the GPU render targets a renderer owns, so an agent can read what each one costs.
// Sizes follow the texel format, so they are the same on every machine, whatever padding a driver adds.
const BYTES_PER_PIXEL = { R8: 1, RGBA8: 4, RGBA16F: 8, R11F_G11F_B10F: 4, R11F_G11F_B10F: 4, DEPTH_COMPONENT16: 2, DEPTH_COMPONENT24: 4, DEPTH_COMPONENT32F: 4 };
const BYTES_PER_MEGABYTE = 1048576;

export class RenderTargetLedger {
  targets = new Map();

  /** `samples` is 1 for a plain texture; `layers` is the slice count of an array texture. */
  record(name, { width, height, format, samples = 1, layers = 1 }) {
    const bytes = width * height * layers * samples * BYTES_PER_PIXEL[format];
    this.targets.set(name, { name, width, height, layers, format, samples, bytes, megabytes: Number((bytes / BYTES_PER_MEGABYTE).toFixed(2)) });
  }

  release(...names) {
    for (const name of names) this.targets.delete(name);
  }

  /** Every live target, largest first, and the total. */
  report() {
    const targets = [...this.targets.values()].sort((first, second) => second.bytes - first.bytes);
    const totalBytes = targets.reduce((total, target) => total + target.bytes, 0);
    return { totalBytes, totalMegabytes: Number((totalBytes / BYTES_PER_MEGABYTE).toFixed(2)), targets };
  }
}
