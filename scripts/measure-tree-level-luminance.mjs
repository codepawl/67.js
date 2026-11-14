// Draws only the foliage of one tree at each level of detail, from three sides and under three lights (sky only, sun behind the
// tree, sun in front of it), in headless Chrome (SwiftShader unless `--gpu`). It prints, as JSON, the mean linear luminance of
// the pure leaf pixels (every pixel that differs from an empty frame) and each level's ratio to level 0 (issue #432).
//   --species a,b     limit the species (default all five)         --seed N     tree seed (default 3)
//   --pictures <dir>  also write every frame as <species>-<light>-L<level>.png
//   --fit             solve, per species and level, the colour gain and sky gain that bring all three ratios closest to 1 for
//                     this seed, and print them with the ratios (the gains in src/tree-level-gains.js are ignored while fitting);
//                     scripts/merge-tree-level-gains.mjs merges the fits of several seeds into that file
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

const port = 5189;
const useGpu = process.argv.includes('--gpu');
const fit = process.argv.includes('--fit');
const optionValue = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const speciesList = optionValue('--species', 'palm,broadleaf,conifer,birch,bush').split(',');
const seed = Number(optionValue('--seed', 3));
const plainMeanMode = process.argv.includes('--plain-mean');
const pictureDirectory = optionValue('--pictures', null);
if (pictureDirectory) await mkdir(pictureDirectory, { recursive: true });

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The server did not start.')), 30000);
    server.stdout.on('data', (data) => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('exit', (code) => reject(new Error(`The server exited ${code}.`)));
  });
  const args = useGpu ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'];
  browser = await chromium.launch({ headless: true, args });
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  page.on('pageerror', error => console.error(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  const result = await page.evaluate(async ({ speciesList, seed, pictureDirectory, fit, plainMeanMode }) => {
    const { createTree, vegetationParts } = await import('/src/vegetation.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { matchMeanVisibility, scaleVisibility } = await import('/src/tree-sky.js');
    const { TREE_LEVEL_GAINS } = await import('/src/tree-level-gains.js');
    const { constantLighting, environment, SUN_COLOR } = await import('/bench/reference/scenes.js');
    if (fit) for (const species of Object.keys(TREE_LEVEL_GAINS)) delete TREE_LEVEL_GAINS[species];

    const SIZE = 512;
    const AZIMUTHS = [0, 120, 240];
    const LIGHTS = ['sky', 'sunBehind', 'sunFront'];
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    document.body.append(canvas);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const sky = constantLighting(1);
    const toLinear = value => {
      const unit = value / 255;
      return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    const turn = ([x, y, z], degrees) => {
      const angle = degrees * Math.PI / 180;
      return [x * Math.cos(angle) + z * Math.sin(angle), y, -x * Math.sin(angle) + z * Math.cos(angle)];
    };
    const sunFor = (lightName, azimuth) => {
      if (lightName === 'sky') return environment(sky);
      const toward = lightName === 'sunBehind' ? [-3, 4, -6] : [3, 4, 6];
      return environment(sky, { lightDirection: turn(toward, azimuth), keyColor: SUN_COLOR });
    };

    function drawPixels(parts, frame) {
      const renderer = new CrucibleRenderer(canvas, parts, { ground: false, world: true, samples: 1, pixelRatio: 1 });
      renderer.render(frame);
      renderer.render(frame);
      const context = renderer.context;
      const pixels = new Uint8Array(SIZE * SIZE * 4);
      context.readPixels(0, 0, SIZE, SIZE, context.RGBA, context.UNSIGNED_BYTE, pixels);
      return pixels;
    }

    const pictures = {};
    const pictureOf = (pixels) => {
      const flat = document.createElement('canvas');
      flat.width = SIZE;
      flat.height = SIZE;
      const image = new ImageData(SIZE, SIZE);
      for (let row = 0; row < SIZE; row++) image.data.set(pixels.subarray(row * SIZE * 4, (row + 1) * SIZE * 4), (SIZE - 1 - row) * SIZE * 4);
      flat.getContext('2d').putImageData(image, 0, 0);
      return flat.toDataURL('image/png');
    };

    // Mean linear luminance of the pure leaf pixels of `parts`, pooled over the three sides, for each light. `sides` keeps the
    // mean of each side too, because a crown whose cards face one way averages out over the sides while it pops on screen.
    function measureLights(parts, view, label) {
      const means = { sides: {} };
      for (const lightName of LIGHTS) {
        let sum = 0;
        let count = 0;
        means.sides[lightName] = [];
        AZIMUTHS.forEach((azimuth, side) => {
          let sideSum = 0;
          let sideCount = 0;
          const frame = { eye: turn([0, 1.7 - view.middle, view.distance], azimuth).map((value, axis) => value + (axis === 1 ? view.middle : 0)), target: [0, view.middle, 0], up: [0, 1, 0], fov: 25, near: 0.1, far: 500, time: 0, wind: 0, exposure: 1, environment: sunFor(lightName, azimuth) };
          const empty = drawPixels([], frame);
          const pixels = drawPixels(parts, frame);
          for (let offset = 0; offset < pixels.length; offset += 4) {
            if (pixels[offset] === empty[offset] && pixels[offset + 1] === empty[offset + 1] && pixels[offset + 2] === empty[offset + 2]) continue;
            const luminance = 0.2126 * toLinear(pixels[offset]) + 0.7152 * toLinear(pixels[offset + 1]) + 0.0722 * toLinear(pixels[offset + 2]);
            sum += luminance;
            count++;
            sideSum += luminance;
            sideCount++;
          }
          means.sides[lightName].push(sideSum / Math.max(1, sideCount));
          if (pictureDirectory && side === 0) pictures[`${label}-${lightName}`] = pictureOf(pixels);
        });
        means[lightName] = sum / Math.max(1, count);
      }
      return means;
    }

    const foliageParts = (tree, level, override) => {
      const parts = vegetationParts(tree, identity, level).filter(part => part.name.endsWith('foliage'));
      // The shadow layers point at the original geometry, and the frames have no shadows.
      return override ? parts.map(part => ({ ...part, geometry: override(part.geometry), shadowLods: undefined })) : parts;
    };
    const ratiosOf = (means, reference) => LIGHTS.map(light => means[light] / reference[light]);

    // Solves for the two columns' weights that best reach `target` over the three lights (least squares).
    function solveTwo([first, second], target) {
      const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
      const firstSquared = dot(first, first);
      const cross = dot(first, second);
      const secondSquared = dot(second, second);
      const determinant = firstSquared * secondSquared - cross * cross;
      if (Math.abs(determinant) < 1e-9) return [0, 0];
      const firstTarget = dot(first, target);
      const secondTarget = dot(second, target);
      return [(firstTarget * secondSquared - cross * secondTarget) / determinant, (firstSquared * secondTarget - cross * firstTarget) / determinant];
    }

    const output = {};
    const gains = {};
    for (const species of speciesList) {
      const tree = createTree(species, seed);
      const crown = tree.levels[0].parts.find(part => part.role === 'foliage').geometry.positions;
      let top = -Infinity;
      let reach = 0;
      for (let offset = 0; offset < crown.length; offset += 3) {
        top = Math.max(top, crown[offset + 1]);
        reach = Math.max(reach, Math.hypot(crown[offset], crown[offset + 2]));
      }
      // A far tree is seen from the ground: eye at 1.7 m, so the flat clumps of the far levels show from below.
      const view = { middle: top / 2, distance: Math.max(top, reach * 2) * 3 };
      const reference = measureLights(foliageParts(tree, 0), view, `${species}-L0`);
      output[species] = { level0: reference, levels: [] };
      gains[species] = {};
      for (let level = 1; level < tree.levels.length; level++) {
        // `--plain-mean` re-matches the level to level 0 by the plain mean over vertices, as main did before #432.
        const plainMean = geometry => {
          const levelZero = tree.levels[0].parts.find(part => part.role === 'foliage').geometry.skyVisibility;
          const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
          return { ...geometry, skyVisibility: matchMeanVisibility(geometry.skyVisibility, mean(levelZero), new Float32Array(geometry.skyVisibility.length).fill(1)) };
        };
        const drawn = measureLights(foliageParts(tree, level, plainMeanMode ? plainMean : null), view, `${species}-L${level}`);
        const before = ratiosOf(drawn, reference);
        // The ratio of each light and side to level 0 from the same side.
        const sides = LIGHTS.map(light => drawn.sides[light].map((value, side) => Number((value / reference.sides[light][side]).toFixed(3))));
        let after = before;
        if (fit) {
          // The colour gain moves every light and the sky gain the sky share. Gauss-Newton steps on the log ratios of the three
          // lights, with a measured Jacobian.
          const drawWith = ([logColor, logSky]) => ratiosOf(measureLights(foliageParts(tree, level, geometry => ({
            ...geometry,
            colors: geometry.colors.map(channel => channel * Math.exp(logColor)),
            skyVisibility: scaleVisibility(geometry.skyVisibility, Math.exp(logSky)),
          })), view, `${species}-L${level}-fit`), reference).map(Math.log);
          const limits = [[-1, 1.6], [Math.log(0.25), Math.log(16)]];
          const steps = [0.15, 0.2];
          let parameters = [0, 0];
          let residual = before.map(Math.log);
          const worst = values => Math.max(...values.map(Math.abs));
          // A level that already passes keeps its look.
          for (let iteration = 0; iteration < 6 && worst(residual) > Math.log(1.08); iteration++) {
            const jacobian = steps.map((step, column) => {
              const moved = parameters.map((value, index) => index === column ? value + step : value);
              return drawWith(moved).map((value, light) => (value - residual[light]) / step);
            });
            const change = solveTwo(jacobian, residual.map(value => -value));
            // Damped: halve the step until the worst light improves, so a noisy Jacobian cannot throw the fit off.
            let improved = false;
            for (let scale = 1; scale >= 0.125 && !improved; scale /= 2) {
              const trial = parameters.map((value, index) => Math.min(limits[index][1], Math.max(limits[index][0], value + change[index] * scale)));
              const trialResidual = drawWith(trial);
              if (worst(trialResidual) < worst(residual)) {
                parameters = trial;
                residual = trialResidual;
                improved = true;
              }
            }
            if (!improved) break;
          }
          after = residual.map(Math.exp);
          gains[species][level] = { color: Number(Math.exp(parameters[0]).toFixed(3)), sky: Number(Math.exp(parameters[1]).toFixed(3)) };
        }
        output[species].levels.push({ level, before, after, sides });
      }
    }
    return { output, gains, pictures };
  }, { speciesList, seed, pictureDirectory, fit, plainMeanMode });
  for (const [name, dataUrl] of Object.entries(result.pictures)) {
    await writeFile(`${pictureDirectory}/${name}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  console.log(JSON.stringify({ ...result.output, seed, gains: fit ? result.gains : undefined }));
} finally {
  await browser?.close();
  server.kill();
}
