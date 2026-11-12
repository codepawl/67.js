// Draws each three.js-style snippet through the addon and reports the picture, so the test can tell a lit scene from a blank one.
import * as core from '../../../src/index.js';
import { loadGltf } from '../../../src/gltf.js';
import { createThreeCompat } from '../../../packages/three-compat/index.mjs';
import { snippets } from './snippets.mjs';

function checkerboard() {
  const picture = document.createElement('canvas');
  picture.width = 64;
  picture.height = 64;
  const context = picture.getContext('2d');
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      context.fillStyle = (row + column) % 2 ? '#f4f4f4' : '#2255aa';
      context.fillRect(column * 8, row * 8, 8, 8);
    }
  }
  return picture;
}

function describePicture(canvas) {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const context = copy.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0);
  const { data } = context.getImageData(0, 0, copy.width, copy.height);
  const colors = new Set();
  let hash = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    const packed = (data[offset] >> 3) << 10 | (data[offset + 1] >> 3) << 5 | data[offset + 2] >> 3;
    colors.add(packed);
    hash = (hash * 31 + packed) >>> 0;
  }
  return { distinctColors: colors.size, hash };
}

// Each snippet draws on its own canvas, so no snippet inherits the context of the one before.
function freshCanvas() {
  document.querySelector('#scene').remove();
  const canvas = document.createElement('canvas');
  canvas.id = 'scene';
  document.body.append(canvas);
  return canvas;
}

const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

window.snippetNames = snippets.map(snippet => snippet.name);
window.drawSnippet = async name => {
  const snippet = snippets.find(entry => entry.name === name);
  const THREE = createThreeCompat({ ...core, loadGltf });
  const canvas = freshCanvas();
  const { scene, camera, animate } = await snippet.build(THREE, { canvas, checkerboard });
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(256, 256);
  let frames = 0;
  let picture = null;
  if (snippet.loop) {
    // The picture is read inside the frame that drew it, because the canvas does not keep its pixels afterwards.
    renderer.setAnimationLoop(() => {
      animate();
      renderer.render(scene, camera);
      frames += 1;
      if (frames === 3) picture = describePicture(canvas);
    });
    while (frames < 3) await nextFrame();
    renderer.setAnimationLoop(null);
  } else {
    renderer.render(scene, camera);
    frames = 1;
    picture = describePicture(canvas);
  }
  renderer.dispose();
  return { frames, ...picture };
};
