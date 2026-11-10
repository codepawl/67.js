import { createCloth, weldVertices } from './cloth.js';
import { updatePartVertices } from './update-part-vertices.js';
import { recomputeNormals } from './geometry-normals.js';

const STEP_SECONDS = 1 / 60;
// A seek replays this much time from rest, so a frame at time t looks the same however the page got there.
const REPLAY_SECONDS = 3;
const BREEZE_METRES_PER_SECOND = 1.5;
const GUST_METRES_PER_SECOND = 4.5;

// Steps the flag's cloth with the page clock and writes it into the part's GPU buffers. The wind runs along -x, the length of a flag
// pinned on its right edge. `windStrength` is the page's 0..1 wind slider.
export function createFlagAnimation(renderer, flagPart) {
  const geometry = flagPart.geometry;
  const welded = weldVertices(geometry.positions, geometry.indices);
  const restPositions = new Float32Array(welded.representatives.length * 3);
  welded.representatives.forEach((vertex, particle) => {
    restPositions.set(geometry.positions.subarray(vertex * 3, vertex * 3 + 3), particle * 3);
  });
  let poleEdge = -Infinity;
  for (let offset = 0; offset < restPositions.length; offset += 3) poleEdge = Math.max(poleEdge, restPositions[offset]);
  const pinned = [];
  for (let particle = 0; particle < restPositions.length / 3; particle++) {
    if (restPositions[particle * 3] > poleEdge - 1e-4) pinned.push(particle);
  }
  const restGeometry = { positions: Float32Array.from(geometry.positions), normals: Float32Array.from(geometry.normals), indices: geometry.indices };
  const vertexNormals = new Float32Array(geometry.normals.length);
  let cloth = null;
  let clothTime = 0;

  function restart(startTime) {
    cloth = createCloth(restPositions, welded.triangles, { pinned, density: 0.25 });
    clothTime = startTime;
  }

  function windAt(time, windStrength) {
    const gust = 0.5 + 0.5 * Math.sin(time * 1.3) * Math.sin(time * 0.47 + 1);
    const speed = BREEZE_METRES_PER_SECOND + windStrength * (GUST_METRES_PER_SECOND * gust + 1.5);
    return [-speed, 0, 0.35 * speed * Math.sin(time * 0.9)];
  }

  function write() {
    const positions = geometry.positions;
    welded.particleOfVertex.forEach((particle, vertex) => {
      positions.set(cloth.positions.subarray(particle * 3, particle * 3 + 3), vertex * 3);
    });
    vertexNormals.set(recomputeNormals(restGeometry, positions));
    updatePartVertices(renderer, flagPart, positions, vertexNormals);
  }

  return {
    update(time, windStrength) {
      let changed = false;
      if (!cloth || time < clothTime - STEP_SECONDS || time - clothTime > REPLAY_SECONDS) {
        restart(Math.max(0, time - REPLAY_SECONDS));
        changed = true;
      }
      while (clothTime + STEP_SECONDS <= time) {
        cloth.step(STEP_SECONDS, { wind: windAt(clothTime, windStrength) });
        clothTime += STEP_SECONDS;
        changed = true;
      }
      if (changed) write();
    },
  };
}
