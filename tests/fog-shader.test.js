import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { agentSceneModulesNeeded } from '../src/agent-scene-modules.js';

// The registry is per process, so each check that needs "the addon not imported yet" runs in its own process.
function runModule(script) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim().split('\n');
}

test('the core post shader carries no fog march, and the fog code arrives with fog-shader.js', () => {
  const output = runModule(`
    const { postFragment, createPostFragment } = await import('./src/post.js');
    console.log(postFragment.includes('fogLightScattering'));
    console.log(createPostFragment(['finish']).includes('fogLightScattering'));
    try { createPostFragment(['volume']); console.log('no error'); } catch (error) { console.log(error.message); }
    await import('./src/fog-shader.js');
    const withFog = createPostFragment(['volume', 'field', 'lights']);
    console.log(withFog.includes('fogLightScattering') && withFog.includes('uniform sampler2D volumeField;'));
    console.log(createPostFragment(['finish']).includes('fogLightScattering'));
  `);
  assert.equal(output[0], 'false');
  assert.equal(output[1], 'false');
  assert.match(output[2], /volumeFog feature needs its shader code: add import '@codepawlhq\/67js\/addons\/fog-shader'/);
  assert.equal(output[3], 'true');
  assert.equal(output[4], 'false', 'a program without the volume step keeps the stub after the addon loads');
});

test('a renderer that draws a volume fog without the addon throws and names the import', () => {
  const output = runModule(`
    const { Renderer67 } = await import('./src/renderer.js');
    const rendererWithoutCanvas = { environment: {}, fogFieldOverride: null };
    const frame = { eye: [0, 1, 5], environment: { volumeFog: { density: 0.1 } } };
    try { Renderer67.prototype.render.call(rendererWithoutCanvas, frame); console.log('no error'); } catch (error) { console.log(error.message); }
  `);
  assert.match(output[0], /volumeFog feature needs its shader code: add import '@codepawlhq\/67js\/addons\/fog-shader'/);
});

test('a recipe with volumeFog loads the fog code on its own, and one without does not', async () => {
  const fogRecipe = { environment: { volumeFog: { density: 0.1 } } };
  assert.ok(agentSceneModulesNeeded(fogRecipe).includes('fogShader'));
  assert.ok(agentSceneModulesNeeded([{ type: 'set-environment', environment: { volumeFog: { density: 0 } } }]).includes('fogShader'));
  assert.equal(agentSceneModulesNeeded({ environment: { fogDensity: 0.01 } }).includes('fogShader'), false);
  const output = runModule(`
    const { loadAgentSceneModules } = await import('./src/agent-scene-modules.js');
    const { createPostFragment } = await import('./src/post.js');
    await loadAgentSceneModules({ environment: { volumeFog: { density: 0.1 } } });
    console.log(createPostFragment(['volume']).includes('vec3 volumeFog(vec3 background) {\\n') || createPostFragment(['volume']).includes('volumeLightPositions'));
  `);
  assert.equal(output[0], 'true');
});

test('the film imports the fog code, so its fog scene draws without further setup', () => {
  const output = runModule(`
    await import('./src/film.js');
    const { createPostFragment } = await import('./src/post.js');
    console.log(createPostFragment(['volume']).includes('volumeLightPositions'));
  `);
  assert.equal(output[0], 'true');
});
