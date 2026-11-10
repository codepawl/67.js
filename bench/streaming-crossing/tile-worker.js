// Builds one terrain tile off the main thread. Answers { asset, bytes } for the streaming worker loader.
import { generateTile, parseTileSource, tileBytes } from './world.js';

self.onmessage = event => {
  try {
    const geometry = generateTile(parseTileSource(event.data.source));
    const buffers = [geometry.positions.buffer, geometry.normals.buffer, geometry.indices.buffer];
    self.postMessage({ asset: geometry, bytes: tileBytes(geometry) }, buffers);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
