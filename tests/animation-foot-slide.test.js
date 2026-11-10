import assert from 'node:assert/strict';
import test from 'node:test';
import { locomotionGraph, measureFootSlide } from './fixtures/foot-slide.js';

// A character walks and runs through a blend space with root motion. A planted foot must hold still in the world, so the
// drift of each contact (how far the foot strays from where it landed) is measured and held under a bound.

const CONSTANT_SPEED_BOUND = 1e-6;
const CHANGING_SPEED_BOUND = 0.03;
const MINIMUM_CONTACTS = 6;

function worstDrift(contactsByFoot) {
  return Math.max(...Object.values(contactsByFoot).flatMap(contacts => contacts.map(contact => contact.drift)));
}

function contactCount(contactsByFoot) {
  return Math.min(...Object.values(contactsByFoot).map(contacts => contacts.length));
}

for (const [label, speed] of [['walk', 1.4], ['run', 3.6], ['a walk to run blend', 2.5], ['an idle to walk blend', 0.7]]) {
  test(`a planted foot does not slide while ${label} holds a constant speed`, () => {
    const contacts = measureFootSlide({ seconds: 8, speedAt: () => speed });
    assert.ok(contactCount(contacts) >= MINIMUM_CONTACTS, `each foot lands at least ${MINIMUM_CONTACTS} times`);
    assert.ok(worstDrift(contacts) < CONSTANT_SPEED_BOUND, `worst drift ${worstDrift(contacts)} m`);
  });
}

test('a planted foot stays under the drift bound while the speed ramps from idle to run', () => {
  const contacts = measureFootSlide({ seconds: 12, speedAt: time => Math.min(3.6, time * 0.4) });
  assert.ok(contactCount(contacts) >= MINIMUM_CONTACTS);
  assert.ok(worstDrift(contacts) < CHANGING_SPEED_BOUND, `worst drift ${worstDrift(contacts)} m`);
});

test('the same speed sequence gives the same contacts and drift', () => {
  const speedAt = time => 1.8 + 1.2 * Math.sin(time * 0.5);
  const first = measureFootSlide({ seconds: 6, speedAt });
  const second = measureFootSlide({ seconds: 6, speedAt });
  assert.deepEqual(first, second);
  assert.ok(worstDrift(first) < CHANGING_SPEED_BOUND, `worst drift ${worstDrift(first)} m`);
});

test('a walk to run blend halfway chains its pose weights to half walk and half run', () => {
  const graph = locomotionGraph();
  graph.set('speed', 2.5).advance(1 / 60);
  const weights = graph.poseLayers().map(layer => layer.weight());
  // Idle 0, walk about 0.5 of the pose so far, run 0.5: the later clips share what the earlier ones leave free.
  assert.equal(weights[0], 0);
  assert.ok(Math.abs(weights[1] - 1) < 1e-9);
  assert.ok(weights[2] > 0.45 && weights[2] < 0.55);
});
