// An edge-avoiding wavelet filter (a-trous, after the SVGF paper without its temporal part) for path traced stills.
// It filters the light and leaves the texture alone: colour is divided by the first-hit albedo first, and the albedo
// is multiplied back at the end. Normals, depth and the per-pixel noise estimate stop it at edges and shadows.

const PASS_STEPS = [1, 2, 4, 8, 16];
const KERNEL = [1 / 16, 1 / 4, 3 / 8, 1 / 4, 1 / 16];
const NORMAL_POWER = 64;
const LUMINANCE_SIGMA = 3;
const ALBEDO_FLOOR = 0.02;

function luminanceOf(buffer, index) {
  return 0.2126 * buffer[index * 3] + 0.7152 * buffer[index * 3 + 1] + 0.0722 * buffer[index * 3 + 2];
}

function demodulate(color, albedo, pixelCount) {
  const light = new Float32Array(color.length);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      light[pixel * 3 + channel] = color[pixel * 3 + channel] / Math.max(albedo[pixel * 3 + channel], ALBEDO_FLOOR);
    }
  }
  return light;
}

/** The noise of each pixel's mean, as luminance variance in the light (albedo divided out), smoothed over 3 by 3. */
function smoothedVariance(variance, albedo, width, height) {
  const scaled = new Float32Array(width * height);
  for (let pixel = 0; pixel < scaled.length; pixel++) {
    const brightness = Math.max(luminanceOf(albedo, pixel), ALBEDO_FLOOR);
    scaled[pixel] = variance[pixel] / (brightness * brightness);
  }
  const smoothed = new Float32Array(scaled.length);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      let sum = 0;
      let count = 0;
      for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
        for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
          const neighborRow = row + rowOffset;
          const neighborColumn = column + columnOffset;
          if (neighborRow < 0 || neighborRow >= height || neighborColumn < 0 || neighborColumn >= width) continue;
          sum += scaled[neighborRow * width + neighborColumn];
          count++;
        }
      }
      smoothed[row * width + column] = sum / count;
    }
  }
  return smoothed;
}

function depthGradient(depth, width, height, row, column) {
  const left = depth[row * width + Math.max(column - 1, 0)];
  const right = depth[row * width + Math.min(column + 1, width - 1)];
  const above = depth[Math.max(row - 1, 0) * width + column];
  const below = depth[Math.min(row + 1, height - 1) * width + column];
  return [(right - left) / 2, (below - above) / 2];
}

function filterPass({ width, height, light, variance, normal, depth }, step, outputLight, outputVariance) {
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const center = row * width + column;
      const centerLuminance = luminanceOf(light, center);
      const [gradientX, gradientY] = depthGradient(depth, width, height, row, column);
      const luminanceScale = LUMINANCE_SIGMA * Math.sqrt(Math.max(variance[center], 0)) + 1e-4;
      let weightSum = 0;
      let squaredWeightSum = 0;
      let varianceSum = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let kernelRow = -2; kernelRow <= 2; kernelRow++) {
        const neighborRow = row + kernelRow * step;
        if (neighborRow < 0 || neighborRow >= height) continue;
        for (let kernelColumn = -2; kernelColumn <= 2; kernelColumn++) {
          const neighborColumn = column + kernelColumn * step;
          if (neighborColumn < 0 || neighborColumn >= width) continue;
          const neighbor = neighborRow * width + neighborColumn;
          const normalAgreement = Math.max(0, normal[center * 3] * normal[neighbor * 3] + normal[center * 3 + 1] * normal[neighbor * 3 + 1] + normal[center * 3 + 2] * normal[neighbor * 3 + 2]);
          const depthTolerance = Math.abs(gradientX * kernelColumn * step) + Math.abs(gradientY * kernelRow * step) + 1e-3 * Math.abs(depth[center]) + 1e-5;
          const depthWeight = Math.exp(-Math.abs(depth[center] - depth[neighbor]) / depthTolerance);
          const luminanceWeight = Math.exp(-Math.abs(centerLuminance - luminanceOf(light, neighbor)) / luminanceScale);
          const weight = KERNEL[kernelRow + 2] * KERNEL[kernelColumn + 2] * normalAgreement ** NORMAL_POWER * depthWeight * luminanceWeight;
          weightSum += weight;
          squaredWeightSum += weight * weight;
          varianceSum += weight * weight * variance[neighbor];
          red += weight * light[neighbor * 3];
          green += weight * light[neighbor * 3 + 1];
          blue += weight * light[neighbor * 3 + 2];
        }
      }
      // Background pixels carry a zero normal, so every weight is zero: keep the pixel as it is instead of dividing 0 by 0.
      if (!(weightSum > 0)) {
        outputLight[center * 3] = light[center * 3];
        outputLight[center * 3 + 1] = light[center * 3 + 1];
        outputLight[center * 3 + 2] = light[center * 3 + 2];
        outputVariance[center] = variance[center];
        continue;
      }
      outputLight[center * 3] = red / weightSum;
      outputLight[center * 3 + 1] = green / weightSum;
      outputLight[center * 3 + 2] = blue / weightSum;
      outputVariance[center] = varianceSum / (weightSum * weightSum);
    }
  }
}

/**
 * Filters a radiance image with the features gathered at each pixel's first hit. All buffers are row-major; colour,
 * albedo and normal hold three floats per pixel, depth and variance one. Returns a new colour buffer.
 */
export function denoiseRadiance({ width, height, color, albedo, normal, depth, variance }) {
  const pixelCount = width * height;
  let light = demodulate(color, albedo, pixelCount);
  let noise = smoothedVariance(variance, albedo, width, height);
  let nextLight = new Float32Array(light.length);
  let nextNoise = new Float32Array(noise.length);
  for (const step of PASS_STEPS) {
    filterPass({ width, height, light, variance: noise, normal, depth }, step, nextLight, nextNoise);
    [light, nextLight] = [nextLight, light];
    [noise, nextNoise] = [nextNoise, noise];
  }
  const result = new Float32Array(color.length);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      result[pixel * 3 + channel] = light[pixel * 3 + channel] * Math.max(albedo[pixel * 3 + channel], ALBEDO_FLOOR);
    }
  }
  return result;
}
