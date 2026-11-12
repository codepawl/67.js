// Image measures of the instancing equivalence test and bench: how far an instanced render sits from the flattened one.

/** Mean squared error over RGB, each term divided by the reference squared plus `epsilon` (0.01 keeps dark pixels from dominating). */
export function relativeMeanSquaredError(candidate, reference, pixelCount, epsilon = 0.01) {
  let total = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const expected = reference[pixel * 4 + channel];
      const difference = candidate[pixel * 4 + channel] - expected;
      total += (difference * difference) / (expected * expected + epsilon);
    }
  }
  return total / (pixelCount * 3);
}

/** Candidate sum over reference sum for each tile of a grid, leaving out tiles too dark to compare. */
export function tileMeanRatios(candidate, reference, width, height, tiles = 8) {
  const ratios = [];
  for (let tileRow = 0; tileRow < tiles; tileRow++) {
    for (let tileColumn = 0; tileColumn < tiles; tileColumn++) {
      let candidateSum = 0;
      let referenceSum = 0;
      for (let row = Math.floor(tileRow * height / tiles); row < Math.floor((tileRow + 1) * height / tiles); row++) {
        for (let column = Math.floor(tileColumn * width / tiles); column < Math.floor((tileColumn + 1) * width / tiles); column++) {
          for (let channel = 0; channel < 3; channel++) {
            candidateSum += candidate[(row * width + column) * 4 + channel];
            referenceSum += reference[(row * width + column) * 4 + channel];
          }
        }
      }
      if (referenceSum > 1e-3) ratios.push(candidateSum / referenceSum);
    }
  }
  return ratios;
}

/** Candidate mean over reference mean for each of R, G and B. */
export function meanRatioRgb(candidate, reference, pixelCount) {
  const candidateSums = [0, 0, 0];
  const referenceSums = [0, 0, 0];
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      candidateSums[channel] += candidate[pixel * 4 + channel];
      referenceSums[channel] += reference[pixel * 4 + channel];
    }
  }
  return candidateSums.map((sum, channel) => sum / referenceSums[channel]);
}
