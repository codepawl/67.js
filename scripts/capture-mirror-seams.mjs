// Writes the water mirror picture itself (not the lit frame) for a hilly terrain seen at a grazing angle, so a crack between
// terrain chunks that the mirror draws at different levels shows as sky through the ground:
//   node scripts/capture-mirror-seams.mjs <folder>
// truth.png: finest terrain only. stitched.png: terrain with mirrorLevels 3 (finest-grid chunk edges and skirts).
// unstitched.png: the same levels as plain grid meshes with no stitching and no skirt, as the first version of the option drew them.
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const folder = process.argv[2];
if (!folder) throw new Error('Give the output folder.');
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.route('**/seams.html', route => route.fulfill({ contentType: 'text/html', body: '<canvas style="width:960px;height:540px;display:block"></canvas>' }));
  await page.goto(`${serverUrl}/seams.html`);
  const results = await page.evaluate(async () => {
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { box } = await import('/src/geometry.js');
    const { createTerrain } = await import('/src/terrain.js');
    const { applyWaterReflection, attachWaterReflection } = await import('/src/water-reflection.js');
    const canvas = document.querySelector('canvas');
    const options = { size: 450, resolution: 64, chunks: 8, levels: 1, height: (x, z) => 16 * Math.sin(x * 0.06) * Math.cos(z * 0.05) + 7 * Math.sin(x * 0.19 + z * 0.14) + 2 * Math.sin(x * 0.51) * Math.sin(z * 0.43) - 2 };
    const sea = { name: 'sea', geometry: box(0, 1), matrix: new Float32Array([4000, 0, 0, 0, 0, 1, 0, 0, 0, 0, 4000, 0, 0, -0.5, 0, 1]), material: { tag: 'surface', color: [0.02, 0.06, 0.1], metallic: 0, roughness: 0.04, emission: 0 } };
    // A terrain whose chunks are all at one level: the plain grid mesh of that level, with no stitching.
    const uniformGeometries = [0, 1, 2, 3].map(level => createTerrain({ ...options, levels: level + 1, lodDistance: 1e-6 }).parts.map(part => part.geometry));
    const truthTerrain = createTerrain(options);
    const stitchedTerrain = createTerrain({ ...options, mirrorLevels: 3 });
    const unstitchedTerrain = createTerrain({ ...options, mirrorLevels: 3 });
    unstitchedTerrain.parts.forEach((part, index) => {
      part.lods = part.lods.map((level, step) => (step === 0 ? level : { geometry: { ...uniformGeometries[step][index], mirrorOnly: true }, error: level.error, mirrorOnly: true }));
    });

    function mirrorPicture(terrain) {
      const marked = applyWaterReflection([...terrain.parts, sea]);
      const renderer = new CrucibleRenderer(canvas, marked.parts, { hdr: false, depth: true, world: true, ground: false, pixelRatio: 1, samples: 1 });
      const context = renderer.context;
      const detach = attachWaterReflection(renderer, marked.surface);
      renderer.render({ eye: [0, 12, 160], target: [0, 4, -100], time: 1 });
      const unit = 7;
      context.activeTexture(context.TEXTURE0 + unit);
      const texture = context.getParameter(context.TEXTURE_BINDING_2D);
      context.activeTexture(context.TEXTURE0);
      const width = Math.ceil(canvas.width * 0.75);
      const height = Math.ceil(canvas.height * 0.75);
      const framebuffer = context.createFramebuffer();
      context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
      context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
      const pixels = new Uint8Array(width * height * 4);
      context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);
      context.bindFramebuffer(context.FRAMEBUFFER, null);
      const picture = document.createElement('canvas');
      picture.width = width;
      picture.height = height;
      const image = new ImageData(new Uint8ClampedArray(pixels), width, height);
      picture.getContext('2d').putImageData(image, 0, 0);
      detach();
      renderer.dispose();
      return picture.toDataURL('image/png');
    }
    // Worst case: chunks in a checkerboard draw their coarsest mesh and the others their finest, so every shared edge joins two levels.
    function forceCheckerboard(terrain) {
      terrain.parts.forEach((part, index) => {
        const coarse = (index % 8 + Math.floor(index / 8)) % 2 === 0;
        part.lods = part.lods.map((level, step) => ({ ...level, error: step === 0 ? 0 : coarse ? 1e-6 * step : 1e6 * step }));
      });
      return terrain;
    }
    const checkerboardStitched = forceCheckerboard(createTerrain({ ...options, mirrorLevels: 3 }));
    const checkerboardUnstitched = createTerrain({ ...options, mirrorLevels: 3 });
    checkerboardUnstitched.parts.forEach((part, index) => {
      part.lods = part.lods.map((level, step) => (step === 0 ? level : { geometry: { ...uniformGeometries[step][index], mirrorOnly: true }, error: level.error, mirrorOnly: true }));
    });
    forceCheckerboard(checkerboardUnstitched);
    return {
      truth: mirrorPicture(truthTerrain), stitched: mirrorPicture(stitchedTerrain), unstitched: mirrorPicture(unstitchedTerrain),
      checkerboardStitched: mirrorPicture(checkerboardStitched), checkerboardUnstitched: mirrorPicture(checkerboardUnstitched),
    };
  });
  await mkdir(folder, { recursive: true });
  for (const [name, image] of Object.entries(results)) await writeFile(`${folder}/${name}.png`, Buffer.from(image.split(',')[1], 'base64'));
  console.log('written', Object.keys(results).join(', '));
} finally {
  await browser.close();
  await server.close();
}
