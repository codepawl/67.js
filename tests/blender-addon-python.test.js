import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const UNITTEST_ARGUMENTS = ['-m', 'unittest', 'discover', '-s', 'packages/blender-addon/tests', '-p', 'test_blender_conversions.py'];

function runnerWithNumpy() {
  for (const interpreter of ['python3', 'python']) {
    const probe = spawnSync(interpreter, ['-c', 'import numpy'], { encoding: 'utf8' });
    if (probe.status === 0) {
      return { command: interpreter, arguments: UNITTEST_ARGUMENTS };
    }
  }
  const uvProbe = spawnSync('uv', ['--version'], { encoding: 'utf8' });
  if (uvProbe.status === 0) {
    return { command: 'uv', arguments: ['run', '--no-project', '--with', 'numpy', 'python', ...UNITTEST_ARGUMENTS] };
  }
  return null;
}

// The Blender add-on's pure-Python tests need Python with numpy (or uv); the Blender exporter test needs Blender and runs by hand.
test('the Blender add-on conversion tests pass', (testContext) => {
  const runner = runnerWithNumpy();
  if (!runner) {
    testContext.skip('no python3 or python with numpy, and no uv, on PATH');
    return;
  }
  const result = spawnSync(runner.command, runner.arguments, { cwd: REPOSITORY_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
