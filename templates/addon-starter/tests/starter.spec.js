import assert from 'node:assert/strict';
import test from 'node:test';
import { createController, listControllerKinds } from '@codepawlhq/67js/addons/player';
import { registerHoverController } from '../src/index.js';

test('the hover kind is registered and holds its height while moving', () => {
  registerHoverController('hover');
  assert.ok(listControllerKinds().includes('hover'));
  const input = { getAxis: name => (name === 'moveX' ? 1 : 0) };
  const controller = createController('hover', { input, hoverHeight: 2, speed: 3 });
  controller.fixedUpdate(0.5);
  assert.deepEqual(controller.state.position, [1.5, 2, 0]);
});

test('registering the same kind twice names the clash', () => {
  assert.throws(() => registerHoverController('hover'), /already registered/);
});
