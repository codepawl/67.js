import { defineConfig } from 'vite';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glslCommentStripperForVite } from './scripts/strip-glsl-comments.mjs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
export const MCP_BUILD_RUNNING = 'SIXTYSEVEN_MCP_BUILD_RUNNING';

// build/mcp/preview.js imports the hashed chunks of this build, and emptyOutDir deletes build/mcp, so a library build on its
// own would leave the MCP server broken until someone reran build-mcp.mjs. Rebuild it after every build into build/.
// build-mcp.mjs reruns this configuration in memory and sets MCP_BUILD_RUNNING so that rebuild does not recurse; builds into
// another folder (the archive measurement's staging package) build their own MCP bundle.
function rebuildMcpAfterLibrary() {
  let outputFolder;
  return {
    name: 'rebuild-mcp-after-library',
    apply: 'build',
    configResolved(config) {
      outputFolder = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (process.env[MCP_BUILD_RUNNING] || outputFolder !== resolve(projectRoot, 'build')) return;
      const result = spawnSync(process.execPath, [resolve(projectRoot, 'scripts/build-mcp.mjs')], { cwd: projectRoot, stdio: 'inherit', windowsHide: true });
      if (result.status !== 0) throw new Error('The library built, but rebuilding build/mcp failed, so the MCP server would load stale chunks. See the error above.');
    },
  };
}

// The full texts sit once in LICENSE and THIRD-PARTY-NOTICES.md at the package root. Repeating them in each of the
// 80 built files cost about 4 KB of archive space per file.
const legalBanner = '/*! 67js, MIT License, Copyright (c) 2026 CodePawl. Bundled gl-matrix: Copyright (c) 2015-2025, Brandon Jones, Colin MacKenzie IV, MIT License. Complete license texts and third-party notices: LICENSE and THIRD-PARTY-NOTICES.md at the package root. */';

export default defineConfig({
  plugins: [glslCommentStripperForVite(), rebuildMcpAfterLibrary()],
  build: {
    copyPublicDir: false,
    rolldownOptions: {
      external: ['@dimforge/rapier3d-compat', 'manifold-3d'],
      output: { banner: legalBanner },
    },
    outDir: 'build',
    lib: {
      entry: {
        core: 'src/index.js',
        model: 'src/model.js',
        nature: 'src/nature.js',
        film: 'src/film.js',
        motion: 'src/motion.js',
        canvas2d: 'src/canvas2d.js',
        gltf: 'src/gltf.js',
        modeling: 'src/modeling.js',
        sculpt: 'src/sculpt.js',
        surface: 'src/surface.js',
        'mesh-query': 'src/mesh-query.js',
        'scene-query': 'src/scene-query.js',
        mesh: 'src/mesh.js',
        shrinkwrap: 'src/shrinkwrap.js',
        'surface-attachment': 'src/surface-attachment.js',
        physics: 'src/physics.js',
        spume: 'src/spume.js',
        retarget: 'src/retarget.js',
        'crowd-skinning': 'src/crowd-skinning.js',
        'skeleton-pose': 'src/skeleton-pose.js',
        vehicle: 'src/vehicle.js',
        vegetation: 'src/vegetation.js',
        terrain: 'src/terrain.js',
        heightfield: 'src/heightfield.js',
        'export-mesh': 'src/export-mesh.js',
        navmesh: 'src/navmesh.js',
        grass: 'src/grass.js',
        clutter: 'src/clutter.js',
        'light-bake': 'src/light-bake.js',
        'light-bake-gpu': 'src/light-bake-gpu.js',
        'ground-bounce': 'src/ground-bounce.js',
        'floor-sky-visibility': 'src/floor-sky-visibility.js',
        'path-tracer': 'src/path-tracer.js',
        'path-tracer-progressive': 'src/path-tracer-progressive.js',
        'path-tracer-realtime': 'src/path-tracer-realtime.js',
        'path-tracer-worker': 'src/path-tracer-worker.js',
        'kernel-worker': 'src/kernel-worker.js',
        'texture-set': 'src/texture-set.js',
        'agent-scene': 'src/agent-scene.js',
        'agent-asset': 'src/agent-asset.js',
        hdri: 'src/hdri.js',
        'camera-effects': 'src/camera-effects.js',
        'water-reflection': 'src/water-reflection.js',
        'render-passes': 'src/render-passes.js',
        'user-pass': 'src/user-pass.js',
        'line-art': 'src/line-art.js',
        'mesh-blend': 'src/mesh-blend.js',
        'coplanar-overlap': 'src/coplanar-overlap.js',
        'reversed-depth': 'src/reversed-depth.js',
        'material-layer-shaders': 'src/material-layer-shaders.js',
        'view-transform-shader': 'src/view-transform-shader.js',
        'view-transform': 'src/view-transform.js',
        'liquid-shader': 'src/liquid-shader.js',
        'world-material-shader': 'src/world-material-shader.js',
        'splat-shader': 'src/splat-shader.js',
        'subsurface-shader': 'src/subsurface-shader.js',
        'fog-shader': 'src/fog-shader.js',
        'light-linking': 'src/light-linking.js',
        'cascaded-shadows': 'src/cascaded-shadows.js',
        'light-shapes': 'src/light-shapes.js',
        'compact-color': 'src/compact-color.js',
        'gaussian-splats': 'src/gaussian-splats.js',
        'texture-update': 'src/texture-update.js',
        cloth: 'src/cloth.js',
        runtime: 'src/runtime.js',
        input: 'src/input.js',
        audio: 'src/audio.js',
        'animation-graph': 'src/animation-graph.js',
        player: 'src/player.js',
        'game-rules': 'src/game-rules.js',
        streaming: 'src/streaming.js',
        'update-part-vertices':'src/update-part-vertices.js',
        'replace-textured-parts': 'src/replace-textured-parts.js',
        // Page of the MCP preview. It imports the engine chunks above instead of bundling its own copy.
        'mcp/preview': 'scripts/agent-preview-browser.js',
      },
      formats: ['es'],
      fileName: (_, entry) => entry === 'core' ? '67.module.js' : `${entry}.js`,
    },
    minify: true,
  },
});
