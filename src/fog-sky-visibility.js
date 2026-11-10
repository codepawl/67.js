import { skyVisibilityGrid } from './closed-room.js';
import { fogBounceGrid } from './fog-bounce.js';

// The post pass (src/renderer.js) reads the grid from this texture unit.
const FOG_SKY_TEXTURE_UNIT = 5;

const uploaded = new WeakMap();

// Red is the share of sky the cell sees (0 to 1); green, blue and alpha are the light that surfaces give it (fog-bounce.js).
function packCells(grid, bounce) {
  const cellCount = grid.data.length;
  const cells = new Float32Array(cellCount * 4);
  for (let cell = 0; cell < cellCount; cell++) {
    cells[cell * 4] = grid.data[cell] / 255;
    if (bounce) {
      cells.set(bounce.subarray(cell * 3, cell * 3 + 3), cell * 4 + 1);
    }
  }
  return cells;
}

// The irradiance grid's mean light at the centre of each cell, in the layout fogBounceGrid returns.
function gridBounce(irradianceGrid, size, minimum, maximum) {
  const data = new Float32Array(size[0] * size[1] * size[2] * 3);
  const point = [0, 0, 0];
  let cellIndex = 0;
  for (let z = 0; z < size[2]; z++) {
    for (let y = 0; y < size[1]; y++) {
      for (let x = 0; x < size[0]; x++) {
        [x, y, z].forEach((index, axis) => {
          point[axis] = minimum[axis] + (index + 0.5) / size[axis] * (maximum[axis] - minimum[axis]);
        });
        data.set(irradianceGrid.meanRadiance(point), cellIndex * 3);
        cellIndex++;
      }
    }
  }
  return data;
}

function uploadGrid(context, grid, bounce) {
  const texture = context.createTexture();
  context.bindTexture(context.TEXTURE_3D, texture);
  context.texImage3D(context.TEXTURE_3D, 0, context.RGBA16F, grid.size[0], grid.size[1], grid.size[2], 0, context.RGBA, context.FLOAT, packCells(grid, bounce));
  context.texParameteri(context.TEXTURE_3D, context.TEXTURE_MIN_FILTER, context.LINEAR);
  context.texParameteri(context.TEXTURE_3D, context.TEXTURE_MAG_FILTER, context.LINEAR);
  for (const wrap of [context.TEXTURE_WRAP_S, context.TEXTURE_WRAP_T, context.TEXTURE_WRAP_R]) {
    context.texParameteri(context.TEXTURE_3D, wrap, context.CLAMP_TO_EDGE);
  }
  return texture;
}

/**
 * The `fogSkyVisibility` option of `Renderer67`: a 3D texture of how much sky each point of the fog box sees and how much
 * light the surfaces around it give back, which the fog's ambient follows. It lives outside the core entry like
 * `skyOpenness`, and a scene without the option compiles the sampling out of the post shader. The rays run once per scene and
 * fog box, not per frame. The renderer calls it every frame with its resolved `volume` and the frame's `environment` and
 * gets the texture, already bound to the grid's texture unit, or null (no fog, a `shadowAmbient` the recipe set, or a scene
 * that is empty or too large to test), which draws as before.
 */
export function fogSkyVisibility(parts, volume, context, environment = {}) {
  if (!(volume.density > 0) || volume.shadowAmbient !== undefined) {
    return null;
  }
  const key = `${volume.minimum}|${volume.maximum}`;
  let entry = uploaded.get(parts);
  if (entry?.context !== context || entry.key !== key) {
    const grid = skyVisibilityGrid(parts, volume.minimum, volume.maximum);
    // The sun is left out of the bounce: see docs/volumetric.md. A scene with an irradiance grid already holds the sun's
    // bounce, the lights and the emission over several bounces, so the fog reads the grid instead of tracing its own.
    const irradianceGrid = parts.find(part => part.material?.irradianceGrid)?.material.irradianceGrid;
    const bounce = !grid ? null
      : irradianceGrid ? gridBounce(irradianceGrid, grid.size, volume.minimum, volume.maximum)
        : fogBounceGrid(parts, grid.size, volume.minimum, volume.maximum, { pointLights: environment.pointLights });
    entry = { context, key, texture: grid && uploadGrid(context, grid, bounce) };
    uploaded.set(parts, entry);
  }
  if (entry.texture) {
    context.activeTexture(context.TEXTURE0 + FOG_SKY_TEXTURE_UNIT);
    context.bindTexture(context.TEXTURE_3D, entry.texture);
  }
  return entry.texture;
}
