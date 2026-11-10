import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from '../src/runtime.js';
import { createGameRules, GAME_RULES_LIMITS, validateGameRules } from '../src/game-rules.js';

const STEP = 1 / 60;

function pickupGameDocument() {
  const coinRule = number => ({
    id: `collect-coin-${number}`,
    once: true,
    when: { type: 'enter', zone: `coin-zone-${number}`, tag: 'player' },
    do: [
      { type: 'add', variable: 'score', value: 1 },
      { type: 'hide', part: `coin-${number}` },
      { type: 'sound', name: 'coin' },
    ],
  });
  return {
    version: 1,
    variables: { score: 0, secondsLeft: 10 },
    zones: [
      { id: 'coin-zone-1', shape: 'sphere', center: [2, 0, 0], radius: 0.5 },
      { id: 'coin-zone-2', shape: 'sphere', center: [4, 0, 0], radius: 0.5 },
      { id: 'coin-zone-3', shape: 'sphere', center: [6, 0, 0], radius: 0.5 },
      { id: 'goal-zone', shape: 'box', center: [8, 0, 0], size: [1, 2, 2] },
    ],
    parts: [
      { id: 'player', tags: ['player'], position: [0, 0, 0] },
      { id: 'coin-1', tags: ['coin'] },
      { id: 'coin-2', tags: ['coin'] },
      { id: 'coin-3', tags: ['coin'] },
    ],
    rules: [
      coinRule(1),
      coinRule(2),
      coinRule(3),
      { id: 'tick', when: { type: 'timer', seconds: 1, repeat: true }, do: [{ type: 'add', variable: 'secondsLeft', value: -1 }] },
      { id: 'out-of-time', when: { type: 'variable', expression: ['<=', 'secondsLeft', 0] }, do: [{ type: 'lose' }] },
      {
        id: 'reach-goal',
        when: { type: 'enter', zone: 'goal-zone', tag: 'player' },
        if: ['>=', 'score', 3],
        do: [{ type: 'animation', event: 'celebrate' }, { type: 'win' }],
      },
    ],
  };
}

// Moves the player along x at `speed` units per second, one fixed step at a time, and returns the rules.
function playPickupGame({ speed, steps }) {
  const rules = createGameRules(pickupGameDocument());
  const runtimeSystem = {
    name: 'player-mover',
    fixedUpdate(step) {
      const x = rules.state.parts.find(part => part.id === 'player').position[0] + speed * step;
      rules.setPartPosition('player', [x, 0, 0]);
    },
  };
  for (let index = 0; index < steps; index += 1) {
    runtimeSystem.fixedUpdate(STEP);
    rules.fixedUpdate(STEP);
  }
  return rules;
}

test('a pickup game collects three coins, reaches the goal and wins', () => {
  const rules = playPickupGame({ speed: 2, steps: 600 });
  const { state } = rules;
  assert.equal(state.won, true);
  assert.equal(state.lost, false);
  assert.equal(state.variables.score, 3);
  assert.deepEqual(state.parts.filter(part => part.tags.includes('coin')).map(part => part.visible), [false, false, false]);
  const summary = rules.eventLog.map(entry => entry.action ?? `trigger:${entry.trigger}`);
  assert.deepEqual(summary, [
    'trigger:enter', 'add', 'hide', 'sound',
    'trigger:timer', 'add',
    'trigger:enter', 'add', 'hide', 'sound',
    'trigger:timer', 'add',
    'trigger:enter', 'add', 'hide', 'sound',
    'trigger:timer', 'add',
    'trigger:enter', 'animation', 'win',
  ]);
  assert.deepEqual(rules.eventLog.at(-1), { step: state.step, rule: 5, action: 'win' });
  assert.equal(rules.eventLog.find(entry => entry.name === 'coin').step, rules.eventLog[0].step);
});

test('the event log is byte stable for the same inputs', () => {
  const first = JSON.stringify(playPickupGame({ speed: 2, steps: 600 }).eventLog);
  const second = JSON.stringify(playPickupGame({ speed: 2, steps: 600 }).eventLog);
  assert.equal(first, second);
  assert.match(first, /^\[\{"step":\d+,"rule":0,"trigger":"enter","part":"player"\},\{"step":\d+,"rule":0,"action":"add","variable":"score","value":1\}/);
});

test('standing still loses when the timer runs out, and the game then stops', () => {
  const rules = playPickupGame({ speed: 0, steps: 700 });
  assert.equal(rules.state.lost, true);
  assert.equal(rules.state.variables.secondsLeft, 0);
  assert.equal(rules.state.variables.score, 0);
  const lastStep = rules.state.step;
  assert.ok(lastStep > 595 && lastStep < 605, `lost at step ${lastStep}`);
  rules.fixedUpdate(STEP);
  assert.equal(rules.state.step, lastStep);
});

test('reaching the goal without all coins does not win', () => {
  const document = pickupGameDocument();
  document.rules = document.rules.filter(rule => rule.id !== 'collect-coin-2');
  const rules = createGameRules(document);
  rules.setPartPosition('player', [8, 0, 0]);
  rules.fixedUpdate(STEP);
  assert.equal(rules.state.status, 'playing');
});

test('the rules run as a runtime system after other systems', () => {
  const rules = createGameRules(pickupGameDocument());
  let time = 0;
  const frames = [];
  let scheduled = null;
  const runtime = createRuntime({ render: frame => frames.push(frame) }, {
    mode: 'fixed',
    fixedRate: 60,
    clock: () => time,
    scheduler: { request: callback => { scheduled = callback; return 1; }, cancel: () => {} },
    visibility: { hidden: false, subscribe: () => () => {} },
    systems: [
      { name: 'mover', fixedUpdate: step => rules.setPartPosition('player', [rules.state.parts[0].position[0] + 2 * step, 0, 0]) },
      rules,
    ],
  });
  runtime.start();
  for (let frame = 0; frame < 20; frame += 1) {
    time += 50;
    scheduled(time);
  }
  assert.ok(rules.state.step >= 55);
  assert.equal(rules.state.variables.score, 1);
  runtime.dispose();
});

test('exit, input, contact and variable triggers fire in rule order', () => {
  const heldActions = new Set();
  const pressedActions = new Set();
  const input = {
    wasPressed: action => pressedActions.has(action),
    wasReleased: () => false,
    isHeld: action => heldActions.has(action),
  };
  const rules = createGameRules({
    version: 1,
    variables: { hits: 0, jumps: 0, exits: 0, boosted: 0 },
    zones: [{ id: 'pad', shape: 'box', center: [0, 0, 0], size: [2, 2, 2] }],
    parts: [
      { id: 'hero', tags: ['hero'], position: [0, 0, 0] },
      { id: 'rock', tags: ['hazard'] },
    ],
    prefabs: [{ id: 'spark', tags: ['effect'] }],
    rules: [
      { when: { type: 'input', action: 'jump' }, do: [{ type: 'add', variable: 'jumps', value: 1 }, { type: 'spawn', prefab: 'spark', position: [0, 1, 0] }] },
      { when: { type: 'contact', between: ['hazard', 'hero'] }, do: [{ type: 'add', variable: 'hits', value: 1 }, { type: 'show', part: 'rock' }] },
      { when: { type: 'exit', zone: 'pad', tag: 'hero' }, do: [{ type: 'add', variable: 'exits', value: 1 }] },
      { when: { type: 'variable', expression: ['>=', ['+', 'hits', 'jumps'], 2] }, do: [{ type: 'set', variable: 'boosted', value: ['*', 'hits', 10] }] },
    ],
  }, { input });

  rules.fixedUpdate(STEP);
  pressedActions.add('jump');
  rules.reportContact('hero', 'rock');
  rules.fixedUpdate(STEP);
  pressedActions.clear();
  rules.setPartPosition('hero', [5, 0, 0]);
  rules.fixedUpdate(STEP);
  rules.fixedUpdate(STEP);

  assert.deepEqual(rules.state.variables, { hits: 1, jumps: 1, exits: 1, boosted: 10 });
  assert.equal(rules.state.parts.at(-1).id, 'spark#1');
  assert.deepEqual(rules.state.parts.at(-1).tags, ['effect']);
  const triggers = rules.eventLog.filter(entry => entry.trigger).map(entry => `${entry.step}:${entry.trigger}`);
  assert.deepEqual(triggers, ['2:input', '2:contact', '2:variable', '3:exit']);
  assert.equal(rules.eventLog.filter(entry => entry.trigger === 'variable').length, 1);
});

test('restart resets play, onEvent sees every entry and spawns are bounded', () => {
  const seen = [];
  const rules = createGameRules({
    version: 1,
    variables: { score: 0 },
    prefabs: [{ id: 'dot', tags: [] }],
    rules: [
      { id: 'spawner', when: { type: 'timer', seconds: STEP, repeat: true }, do: [{ type: 'spawn', prefab: 'dot', position: [0, 0, 0] }, { type: 'add', variable: 'score', value: 1 }] },
    ],
  }, { onEvent: entry => seen.push(entry) });
  for (let index = 0; index < GAME_RULES_LIMITS.maximumSpawns + 5; index += 1) rules.fixedUpdate(STEP);
  assert.equal(rules.state.parts.length, GAME_RULES_LIMITS.maximumSpawns);
  assert.ok(rules.eventLog.some(entry => entry.refused === 'spawn limit'));
  assert.equal(seen.length, rules.eventLog.length);
  rules.restart();
  assert.equal(rules.state.parts.length, 0);
  assert.equal(rules.state.variables.score, 0);
  assert.equal(rules.eventLog.at(-1).action, 'restart');
});

test('a restart action stops the step and the event log is capped', () => {
  const rules = createGameRules({
    version: 1,
    variables: { score: 0 },
    rules: [
      { when: { type: 'timer', seconds: STEP, repeat: true }, do: [{ type: 'add', variable: 'score', value: 5 }, { type: 'restart' }, { type: 'add', variable: 'score', value: 99 }] },
    ],
  });
  for (let index = 0; index < GAME_RULES_LIMITS.maximumEventLogEntries; index += 1) rules.fixedUpdate(STEP);
  assert.equal(rules.state.variables.score, 0);
  assert.equal(rules.eventLog.length, GAME_RULES_LIMITS.maximumEventLogEntries);
  assert.ok(rules.droppedEvents > 0);
});

test('expressions never produce NaN: division by zero gives 0', () => {
  const rules = createGameRules({
    version: 1,
    variables: { ratio: 5, zero: 0 },
    rules: [{ when: { type: 'timer', seconds: STEP }, do: [{ type: 'set', variable: 'ratio', value: ['/', 'ratio', 'zero'] }] }],
  });
  rules.fixedUpdate(STEP);
  assert.equal(rules.state.variables.ratio, 0);
});

test('host calls name the unknown part', () => {
  const rules = createGameRules({ version: 1, parts: [{ id: 'hero', tags: ['hero'] }] });
  assert.throws(() => rules.setPartPosition('villain', [0, 0, 0]), /part "villain".*Use one of: hero/);
  assert.throws(() => rules.reportContact('hero', 'villain'), /part "villain"/);
  assert.throws(() => rules.setPartPosition('hero', [0, 0]), /Pass \[x, y, z\]/);
  assert.throws(() => rules.fixedUpdate(0), /above 0 seconds/);
});

const validBase = () => ({
  version: 1,
  variables: { score: 0 },
  zones: [{ id: 'zone', shape: 'sphere', center: [0, 0, 0], radius: 1 }],
  parts: [{ id: 'hero', tags: ['hero'] }],
  prefabs: [{ id: 'dot', tags: ['dot'] }],
  rules: [{ when: { type: 'enter', zone: 'zone', tag: 'hero' }, do: [{ type: 'add', variable: 'score', value: 1 }] }],
});

const invalidCases = [
  ['a non-object document', () => 'rules', /document must be an object/],
  ['an unknown top-level field', document => ({ ...document, scripts: [] }), /scripts is not a known field.*Use one of: version/],
  ['a wrong version', document => ({ ...document, version: 2 }), /version is 2.*Pass version: 1/],
  ['a non-numeric variable', document => ({ ...document, variables: { score: 'high' } }), /variables\.score is "high".*finite number/],
  ['too many variables', document => ({ ...document, variables: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`v${index}`, 0])) }), /variables has 33 variables.*at most 32/],
  ['a bad zone shape', document => ({ ...document, zones: [{ id: 'z', shape: 'cone', center: [0, 0, 0] }] }), /zones\[0\]\.shape is "cone".*box, sphere/],
  ['a sphere with a size', document => ({ ...document, zones: [{ id: 'z', shape: 'sphere', center: [0, 0, 0], radius: 1, size: [1, 1, 1] }] }), /zones\[0\]\.size does not apply to a sphere/],
  ['a zero radius', document => ({ ...document, zones: [{ id: 'z', shape: 'sphere', center: [0, 0, 0], radius: 0 }] }), /zones\[0\]\.radius is 0.*above 0/],
  ['a short center', document => ({ ...document, zones: [{ id: 'z', shape: 'sphere', center: [0, 0], radius: 1 }] }), /zones\[0\]\.center.*\[x, y, z\]/],
  ['a repeated part id', document => ({ ...document, parts: [{ id: 'a' }, { id: 'a' }] }), /parts\[1\]\.id repeats the id "a"/],
  ['too many parts', document => ({ ...document, parts: Array.from({ length: 65 }, (_, index) => ({ id: `p${index}` })) }), /parts has 65 items.*at most 64/],
  ['a bad name', document => ({ ...document, parts: [{ id: 'bad name' }] }), /parts\[0\]\.id is "bad name"/],
  ['too many rules', document => ({ ...document, rules: Array.from({ length: 65 }, () => document.rules[0]) }), /rules has 65 items.*at most 64/],
  ['an empty action list', document => ({ ...document, rules: [{ ...document.rules[0], do: [] }] }), /rules\[0\]\.do is empty/],
  ['too many actions', document => ({ ...document, rules: [{ ...document.rules[0], do: Array.from({ length: 9 }, () => ({ type: 'win' })) }] }), /rules\[0\]\.do has 9 items.*at most 8/],
  ['an unknown trigger type', document => ({ ...document, rules: [{ when: { type: 'script' }, do: [{ type: 'win' }] }] }), /rules\[0\]\.when\.type is "script".*enter, exit, contact/],
  ['an unknown zone', document => ({ ...document, rules: [{ when: { type: 'enter', zone: 'nowhere', tag: 'hero' }, do: [{ type: 'win' }] }] }), /rules\[0\]\.when\.zone names the zone "nowhere".*Use one of: zone/],
  ['an unknown tag', document => ({ ...document, rules: [{ when: { type: 'enter', zone: 'zone', tag: 'ghost' }, do: [{ type: 'win' }] }] }), /rules\[0\]\.when\.tag names the tag "ghost".*hero, dot/],
  ['a contact with one tag', document => ({ ...document, rules: [{ when: { type: 'contact', between: ['hero'] }, do: [{ type: 'win' }] }] }), /rules\[0\]\.when\.between has 1 tags.*exactly two/],
  ['a timer of zero', document => ({ ...document, rules: [{ when: { type: 'timer', seconds: 0 }, do: [{ type: 'win' }] }] }), /rules\[0\]\.when\.seconds is 0.*above 0/],
  ['an input phase typo', document => ({ ...document, rules: [{ when: { type: 'input', action: 'jump', phase: 'down' }, do: [{ type: 'win' }] }] }), /rules\[0\]\.when\.phase is "down".*pressed, released, held/],
  ['an unknown field in a trigger', document => ({ ...document, rules: [{ when: { type: 'timer', seconds: 1, code: 'x' }, do: [{ type: 'win' }] }] }), /rules\[0\]\.when\.code is not a known field/],
  ['an unknown action type', document => ({ ...document, rules: [{ when: { type: 'timer', seconds: 1 }, do: [{ type: 'eval' }] }] }), /rules\[0\]\.do\[0\]\.type is "eval".*set, add, show/],
  ['an undeclared variable in an action', document => ({ ...document, rules: [{ when: { type: 'timer', seconds: 1 }, do: [{ type: 'add', variable: 'scor', value: 1 }] }] }), /rules\[0\]\.do\[0\]\.variable names the variable "scor".*Use one of: score/],
  ['an undeclared variable in an expression', document => ({ ...document, rules: [{ when: { type: 'timer', seconds: 1 }, do: [{ type: 'set', variable: 'score', value: ['+', 'lives', 1] }] }] }), /rules\[0\]\.do\[0\]\.value\[1\] names the variable "lives".*Declare it/],
  ['an unknown operator', document => ({ ...document, rules: [{ when: { type: 'timer', seconds: 1 }, do: [{ type: 'set', variable: 'score', value: ['%', 'score', 2] }] }] }), /rules\[0\]\.do\[0\]\.value\[0\] is "%".*\+, -, \*, \//],
  ['an expression of the wrong shape', document => ({ ...document, rules: [{ when: { type: 'timer', seconds: 1 }, if: ['+', 1], do: [{ type: 'win' }] }] }), /rules\[0\]\.if is \["\+",1\].*\[operator, left, right\]/],
  ['an expression nested too deep', document => ({ ...document, rules: [{ when: { type: 'timer', seconds: 1 }, if: ['+', ['+', ['+', ['+', ['+', 1, 1], 1], 1], 1], 1], do: [{ type: 'win' }] }] }), /nests deeper than the limit/],
  ['an unknown part to hide', document => ({ ...document, rules: [{ when: { type: 'timer', seconds: 1 }, do: [{ type: 'hide', part: 'coin' }] }] }), /rules\[0\]\.do\[0\]\.part names the part "coin".*Use one of: hero/],
  ['an unknown prefab to spawn', document => ({ ...document, rules: [{ when: { type: 'timer', seconds: 1 }, do: [{ type: 'spawn', prefab: 'bomb', position: [0, 0, 0] }] }] }), /rules\[0\]\.do\[0\]\.prefab names the prefab "bomb".*Use one of: dot/],
  ['a spawn without a position', document => ({ ...document, rules: [{ when: { type: 'timer', seconds: 1 }, do: [{ type: 'spawn', prefab: 'dot' }] }] }), /rules\[0\]\.do\[0\]\.position is undefined/],
  ['a sound with a bad name', document => ({ ...document, rules: [{ when: { type: 'timer', seconds: 1 }, do: [{ type: 'sound', name: 'a b' }] }] }), /rules\[0\]\.do\[0\]\.name is "a b"/],
  ['a once flag that is not a boolean', document => ({ ...document, rules: [{ ...document.rules[0], once: 'yes' }] }), /rules\[0\]\.once is "yes".*true or false/],
];

for (const [label, mutate, expected] of invalidCases) {
  test(`validation rejects ${label}`, () => {
    assert.throws(() => validateGameRules(mutate(validBase())), expected);
  });
}

test('the second rule is named when its field is wrong', () => {
  const document = validBase();
  document.rules.push({ when: { type: 'timer', seconds: 1 }, do: [{ type: 'win' }, { type: 'add', variable: 'nope', value: 1 }] });
  assert.throws(() => validateGameRules(document), /rules\[1\]\.do\[1\]\.variable/);
});

test('an input trigger needs an input source', () => {
  const document = validBase();
  document.rules = [{ when: { type: 'input', action: 'jump' }, do: [{ type: 'win' }] }];
  assert.throws(() => createGameRules(document), /rules\[0\]\.when is an input trigger.*options\.input/);
  assert.doesNotThrow(() => createGameRules(document, { input: { wasPressed: () => false } }));
});

test('the validated copy does not share memory with the document', () => {
  const document = validBase();
  const checked = validateGameRules(document);
  document.variables.score = 99;
  document.zones[0].center[0] = 99;
  assert.equal(checked.variables.score, 0);
  assert.equal(checked.zones[0].center[0], 0);
});
