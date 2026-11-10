// Declarative game logic for a live game: variables, triggers and actions held in one JSON document.
// The document is data, never code: there is no eval, no Function and no script. Expressions are arrays such as
// ["+", "score", 1] over a fixed set of operators. Rules run in document order on every fixed step, so the same
// inputs give the same event log. Every count is bounded, and every validation error names the field and says what
// to pass. docs/game-rules.md describes the document and the system.

export const GAME_RULES_LIMITS = Object.freeze({
  maximumVariables: 32,
  maximumZones: 64,
  maximumParts: 64,
  maximumPrefabs: 16,
  maximumRules: 64,
  maximumActionsPerRule: 8,
  maximumSpawns: 64,
  maximumTagsPerPart: 8,
  maximumExpressionDepth: 4,
  maximumEventLogEntries: 2000,
  maximumNameLength: 64,
});

export const GAME_RULE_TRIGGERS = Object.freeze(['enter', 'exit', 'contact', 'input', 'timer', 'variable']);
export const GAME_RULE_ACTIONS = Object.freeze(['set', 'add', 'show', 'hide', 'spawn', 'animation', 'sound', 'win', 'lose', 'restart']);
export const GAME_RULE_OPERATORS = Object.freeze(['+', '-', '*', '/', '<', '<=', '>', '>=', '==', '!=']);

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const INPUT_PHASES = ['pressed', 'released', 'held'];
const TIMER_EPSILON = 1e-9;

const COMPARISONS = {
  '<': (left, right) => left < right,
  '<=': (left, right) => left <= right,
  '>': (left, right) => left > right,
  '>=': (left, right) => left >= right,
  '==': (left, right) => left === right,
  '!=': (left, right) => left !== right,
};

const ARITHMETIC = {
  '+': (left, right) => left + right,
  '-': (left, right) => left - right,
  '*': (left, right) => left * right,
  '/': (left, right) => (right === 0 ? 0 : left / right), // division by zero gives 0, so a state never turns NaN
};

function fail(path, problem, fix) {
  throw new RangeError(`Game rules ${path} ${problem}. ${fix}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, path, allowedFields) {
  if (!isPlainObject(value)) fail(path, 'must be an object', `Pass { ${allowedFields.join(', ')} }.`);
  for (const field of Object.keys(value)) {
    if (!allowedFields.includes(field)) fail(`${path}.${field}`, 'is not a known field', `Use one of: ${allowedFields.join(', ')}.`);
  }
}

function requireArray(value, path, maximum) {
  if (!Array.isArray(value)) fail(path, 'must be an array', `Pass an array of at most ${maximum} items.`);
  if (value.length > maximum) fail(path, `has ${value.length} items`, `Pass at most ${maximum}; split the game or drop some.`);
}

function requireName(value, path) {
  const valid = typeof value === 'string'
    && value.length <= GAME_RULES_LIMITS.maximumNameLength
    && NAME_PATTERN.test(value);
  if (!valid) {
    fail(path, `is ${JSON.stringify(value)}`, `Pass a name of letters, digits, "_", "-" or "." that starts with a letter or digit, at most ${GAME_RULES_LIMITS.maximumNameLength} characters.`);
  }
  return value;
}

function requireNumber(value, path, minimumExclusive) {
  if (!Number.isFinite(value) || (minimumExclusive !== undefined && value <= minimumExclusive)) {
    const bound = minimumExclusive === undefined ? 'a finite number' : `a finite number above ${minimumExclusive}`;
    fail(path, `is ${JSON.stringify(value)}`, `Pass ${bound}.`);
  }
  return value;
}

function requireVector(value, path) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
    fail(path, `is ${JSON.stringify(value)}`, 'Pass [x, y, z] with three finite numbers.');
  }
  return [...value];
}

function requireBoolean(value, path) {
  if (typeof value !== 'boolean') fail(path, `is ${JSON.stringify(value)}`, 'Pass true or false.');
  return value;
}

function requireUniqueId(value, path, seen) {
  requireName(value, path);
  if (seen.has(value)) fail(path, `repeats the id "${value}"`, 'Give every entry its own id.');
  seen.add(value);
  return value;
}

function validateTags(tags, path) {
  if (tags === undefined) return [];
  requireArray(tags, path, GAME_RULES_LIMITS.maximumTagsPerPart);
  return tags.map((tag, index) => requireName(tag, `${path}[${index}]`));
}

function requireOneOf(value, path, choices) {
  if (!choices.includes(value)) fail(path, `is ${JSON.stringify(value)}`, `Pass one of: ${choices.join(', ')}.`);
  return value;
}

function validateVariables(variables) {
  if (variables === undefined) return {};
  if (!isPlainObject(variables)) fail('variables', 'must be an object', 'Pass { "score": 0 }, a name for each number.');
  const names = Object.keys(variables);
  if (names.length > GAME_RULES_LIMITS.maximumVariables) {
    fail('variables', `has ${names.length} variables`, `Pass at most ${GAME_RULES_LIMITS.maximumVariables}.`);
  }
  const checked = {};
  for (const name of names) {
    requireName(name, `variables.${name}`);
    checked[name] = requireNumber(variables[name], `variables.${name}`);
  }
  return checked;
}

function validateZones(zones) {
  if (zones === undefined) return [];
  requireArray(zones, 'zones', GAME_RULES_LIMITS.maximumZones);
  const seen = new Set();
  return zones.map((zone, index) => {
    const path = `zones[${index}]`;
    requireObject(zone, path, ['id', 'shape', 'center', 'size', 'radius']);
    const id = requireUniqueId(zone.id, `${path}.id`, seen);
    const shape = requireOneOf(zone.shape, `${path}.shape`, ['box', 'sphere']);
    const center = requireVector(zone.center, `${path}.center`);
    if (shape === 'box') {
      if (zone.radius !== undefined) fail(`${path}.radius`, 'does not apply to a box', 'Pass size: [x, y, z] for a box, or shape "sphere" with radius.');
      const size = requireVector(zone.size, `${path}.size`);
      if (!size.every(extent => extent > 0)) fail(`${path}.size`, `is ${JSON.stringify(size)}`, 'Pass three extents above 0.');
      return { id, shape, center, size };
    }
    if (zone.size !== undefined) fail(`${path}.size`, 'does not apply to a sphere', 'Pass radius for a sphere, or shape "box" with size.');
    return { id, shape, center, radius: requireNumber(zone.radius, `${path}.radius`, 0) };
  });
}

function validateParts(parts) {
  if (parts === undefined) return [];
  requireArray(parts, 'parts', GAME_RULES_LIMITS.maximumParts);
  const seen = new Set();
  return parts.map((part, index) => {
    const path = `parts[${index}]`;
    requireObject(part, path, ['id', 'tags', 'position', 'visible']);
    return {
      id: requireUniqueId(part.id, `${path}.id`, seen),
      tags: validateTags(part.tags, `${path}.tags`),
      position: part.position === undefined ? null : requireVector(part.position, `${path}.position`),
      visible: part.visible === undefined ? true : requireBoolean(part.visible, `${path}.visible`),
    };
  });
}

function validatePrefabs(prefabs) {
  if (prefabs === undefined) return [];
  requireArray(prefabs, 'prefabs', GAME_RULES_LIMITS.maximumPrefabs);
  const seen = new Set();
  return prefabs.map((prefab, index) => {
    const path = `prefabs[${index}]`;
    requireObject(prefab, path, ['id', 'tags']);
    return { id: requireUniqueId(prefab.id, `${path}.id`, seen), tags: validateTags(prefab.tags, `${path}.tags`) };
  });
}

function validateExpression(expression, path, context, depth = 1) {
  if (typeof expression === 'number') return requireNumber(expression, path);
  if (typeof expression === 'string') {
    if (!context.variableNames.has(expression)) {
      const declared = [...context.variableNames].join(', ') || 'none declared';
      fail(path, `names the variable "${expression}", which is not declared`, `Declare it under "variables", or use one of: ${declared}.`);
    }
    return expression;
  }
  const shape = 'Pass a number, a variable name, or [operator, left, right].';
  if (!Array.isArray(expression) || expression.length !== 3) fail(path, `is ${JSON.stringify(expression)}`, shape);
  if (depth > GAME_RULES_LIMITS.maximumExpressionDepth) {
    fail(path, 'nests deeper than the limit', `Nest at most ${GAME_RULES_LIMITS.maximumExpressionDepth} levels; compute part of it into a variable first.`);
  }
  const [operator, left, right] = expression;
  requireOneOf(operator, `${path}[0]`, GAME_RULE_OPERATORS);
  return [
    operator,
    validateExpression(left, `${path}[1]`, context, depth + 1),
    validateExpression(right, `${path}[2]`, context, depth + 1),
  ];
}

function requireKnown(value, path, knownIds, kind) {
  requireName(value, path);
  if (!knownIds.has(value)) {
    const known = [...knownIds].join(', ') || `none declared; add one under "${kind}"`;
    fail(path, `names the ${kind.replace(/s$/, '')} "${value}", which is not declared`, `Use one of: ${known}.`);
  }
  return value;
}

function validateTrigger(trigger, path, context) {
  if (!isPlainObject(trigger)) fail(path, 'must be an object', `Pass { type } with type one of: ${GAME_RULE_TRIGGERS.join(', ')}.`);
  const type = requireOneOf(trigger.type, `${path}.type`, GAME_RULE_TRIGGERS);
  switch (type) {
    case 'enter':
    case 'exit':
      requireObject(trigger, path, ['type', 'zone', 'tag']);
      return {
        type,
        zone: requireKnown(trigger.zone, `${path}.zone`, context.zoneIds, 'zones'),
        tag: requireKnown(trigger.tag, `${path}.tag`, context.tags, 'tags'),
      };
    case 'contact':
      requireObject(trigger, path, ['type', 'between']);
      requireArray(trigger.between, `${path}.between`, 2);
      if (trigger.between.length !== 2) fail(`${path}.between`, `has ${trigger.between.length} tags`, 'Pass exactly two tags, such as ["player", "enemy"].');
      return { type, between: trigger.between.map((tag, index) => requireKnown(tag, `${path}.between[${index}]`, context.tags, 'tags')) };
    case 'input': {
      requireObject(trigger, path, ['type', 'action', 'phase']);
      if (!context.hasInput) context.usesInput = true;
      const phase = trigger.phase === undefined ? 'pressed' : requireOneOf(trigger.phase, `${path}.phase`, INPUT_PHASES);
      return { type, action: requireName(trigger.action, `${path}.action`), phase };
    }
    case 'timer': {
      requireObject(trigger, path, ['type', 'seconds', 'repeat']);
      const repeat = trigger.repeat === undefined ? false : requireBoolean(trigger.repeat, `${path}.repeat`);
      return { type, seconds: requireNumber(trigger.seconds, `${path}.seconds`, 0), repeat };
    }
    default:
      requireObject(trigger, path, ['type', 'expression']);
      return { type, expression: validateExpression(trigger.expression, `${path}.expression`, context) };
  }
}

function validateAction(action, path, context) {
  if (!isPlainObject(action)) fail(path, 'must be an object', `Pass { type } with type one of: ${GAME_RULE_ACTIONS.join(', ')}.`);
  const type = requireOneOf(action.type, `${path}.type`, GAME_RULE_ACTIONS);
  switch (type) {
    case 'set':
    case 'add':
      requireObject(action, path, ['type', 'variable', 'value']);
      return {
        type,
        variable: requireKnown(action.variable, `${path}.variable`, context.variableNames, 'variables'),
        value: validateExpression(action.value, `${path}.value`, context),
      };
    case 'show':
    case 'hide':
      requireObject(action, path, ['type', 'part']);
      return { type, part: requireKnown(action.part, `${path}.part`, context.partIds, 'parts') };
    case 'spawn':
      requireObject(action, path, ['type', 'prefab', 'position']);
      return {
        type,
        prefab: requireKnown(action.prefab, `${path}.prefab`, context.prefabIds, 'prefabs'),
        position: requireVector(action.position, `${path}.position`),
      };
    case 'animation':
      requireObject(action, path, ['type', 'event']);
      return { type, event: requireName(action.event, `${path}.event`) };
    case 'sound':
      requireObject(action, path, ['type', 'name']);
      return { type, name: requireName(action.name, `${path}.name`) };
    default:
      requireObject(action, path, ['type']);
      return { type };
  }
}

function validateRules(rules, context) {
  if (rules === undefined) return [];
  requireArray(rules, 'rules', GAME_RULES_LIMITS.maximumRules);
  const seen = new Set();
  return rules.map((rule, index) => {
    const path = `rules[${index}]`;
    requireObject(rule, path, ['id', 'when', 'if', 'once', 'do']);
    requireArray(rule.do, `${path}.do`, GAME_RULES_LIMITS.maximumActionsPerRule);
    if (rule.do.length === 0) fail(`${path}.do`, 'is empty', 'Pass at least one action, such as { "type": "add", "variable": "score", "value": 1 }.');
    return {
      id: rule.id === undefined ? `rule${index}` : requireUniqueId(rule.id, `${path}.id`, seen),
      when: validateTrigger(rule.when, `${path}.when`, context),
      condition: rule.if === undefined ? null : validateExpression(rule.if, `${path}.if`, context),
      once: rule.once === undefined ? false : requireBoolean(rule.once, `${path}.once`),
      actions: rule.do.map((action, actionIndex) => validateAction(action, `${path}.do[${actionIndex}]`, context)),
    };
  });
}

/**
 * Check a rule document and return a normalised copy. Throws a RangeError that names the field and says what to pass.
 * `hasInput` says whether the game will have an input source, so an input trigger without one fails here.
 */
export function validateGameRules(document, { hasInput = true } = {}) {
  requireObject(document, 'document', ['version', 'variables', 'zones', 'parts', 'prefabs', 'rules']);
  if (document.version !== 1) fail('version', `is ${JSON.stringify(document.version)}`, 'Pass version: 1.');
  const variables = validateVariables(document.variables);
  const zones = validateZones(document.zones);
  const parts = validateParts(document.parts);
  const prefabs = validatePrefabs(document.prefabs);
  const context = {
    variableNames: new Set(Object.keys(variables)),
    zoneIds: new Set(zones.map(zone => zone.id)),
    partIds: new Set(parts.map(part => part.id)),
    prefabIds: new Set(prefabs.map(prefab => prefab.id)),
    tags: new Set([...parts, ...prefabs].flatMap(entry => entry.tags)),
    hasInput,
    usesInput: false,
  };
  const rules = validateRules(document.rules, context);
  if (context.usesInput) {
    const index = rules.findIndex(rule => rule.when.type === 'input');
    fail(`rules[${index}].when`, 'is an input trigger, and the game has no input', 'Pass options.input from createInput, or use another trigger.');
  }
  return { version: 1, variables, zones, parts, prefabs, rules };
}

function evaluate(expression, variables) {
  if (typeof expression === 'number') return expression;
  if (typeof expression === 'string') return variables[expression];
  const [operator, left, right] = expression;
  const leftValue = evaluate(left, variables);
  const rightValue = evaluate(right, variables);
  const arithmetic = ARITHMETIC[operator];
  if (arithmetic !== undefined) return arithmetic(leftValue, rightValue);
  return COMPARISONS[operator](leftValue, rightValue) ? 1 : 0;
}

function isInside(zone, position) {
  if (zone.shape === 'sphere') {
    const distanceSquared = position.reduce((sum, value, axis) => sum + (value - zone.center[axis]) ** 2, 0);
    return distanceSquared <= zone.radius ** 2;
  }
  return position.every((value, axis) => Math.abs(value - zone.center[axis]) <= zone.size[axis] / 2);
}

function pairKey(zoneId, partId) {
  return `${zoneId}\u0000${partId}`;
}

/**
 * A runtime system that plays a rule document. Put it after input and physics in `systems`.
 * Options: `input` (a createInput object, for input triggers), `getPartPosition(partId)` (returns [x, y, z] or undefined,
 * read once per part on each fixed step) and `onEvent(entry)` (called for each event log entry, such as a sound marker).
 * The host also calls `setPartPosition` and `reportContact`. Read `state` and `eventLog` from game code.
 */
export function createGameRules(document, options = {}) {
  const rules = validateGameRules(document, { hasInput: options.input !== undefined });
  const initialVariables = rules.variables;
  const prefabTags = new Map(rules.prefabs.map(prefab => [prefab.id, prefab.tags]));
  const eventLog = [];
  let droppedEvents = 0;
  let step = 0;
  let elapsedSeconds = 0;
  let status = 'playing';
  let variables = { ...initialVariables };
  let parts = [];
  let occupied = new Set();
  let spawnCount = 0;
  let firedOnce = new Set();
  let variableWasTrue = new Map();
  let contacts = [];
  let entered = [];
  let exited = [];

  function resetPlay() {
    variables = { ...initialVariables };
    parts = rules.parts.map(part => ({ ...part, tags: [...part.tags], position: part.position && [...part.position] }));
    occupied = new Set();
    spawnCount = 0;
    firedOnce = new Set();
    variableWasTrue = new Map();
    contacts = [];
    entered = [];
    exited = [];
    status = 'playing';
    elapsedSeconds = 0;
  }
  resetPlay();

  function record(entry) {
    if (eventLog.length >= GAME_RULES_LIMITS.maximumEventLogEntries) {
      droppedEvents += 1;
      return;
    }
    eventLog.push(entry);
    options.onEvent?.(entry);
  }

  function findPart(partId, label) {
    const part = parts.find(candidate => candidate.id === partId);
    if (part === undefined) {
      throw new RangeError(`${label} names the part "${partId}", which the game does not have. Use one of: ${parts.map(candidate => candidate.id).join(', ') || 'none declared'}.`);
    }
    return part;
  }

  function trackZoneOccupancy() {
    const nowOccupied = new Set();
    for (const part of parts) {
      const reported = options.getPartPosition?.(part.id);
      if (reported !== undefined) part.position = requireVector(reported, `getPartPosition("${part.id}") result`);
      if (!part.visible || part.position === null) continue;
      for (const zone of rules.zones) {
        if (isInside(zone, part.position)) nowOccupied.add(pairKey(zone.id, part.id));
      }
    }
    entered = [];
    exited = [];
    for (const zone of rules.zones) {
      for (const part of parts) {
        const key = pairKey(zone.id, part.id);
        if (nowOccupied.has(key) && !occupied.has(key)) entered.push({ zone: zone.id, part });
        if (!nowOccupied.has(key) && occupied.has(key)) exited.push({ zone: zone.id, part });
      }
    }
    occupied = nowOccupied;
  }

  function matchZoneChange(changes, trigger) {
    const change = changes.find(candidate => candidate.zone === trigger.zone && candidate.part.tags.includes(trigger.tag));
    return change === undefined ? null : { part: change.part.id };
  }

  function matchContact(trigger) {
    const [firstTag, secondTag] = trigger.between;
    for (const [first, second] of contacts) {
      if (first.tags.includes(firstTag) && second.tags.includes(secondTag)) return { parts: [first.id, second.id] };
      if (second.tags.includes(firstTag) && first.tags.includes(secondTag)) return { parts: [second.id, first.id] };
    }
    return null;
  }

  function matchInput(trigger) {
    const { input } = options;
    const hit = { pressed: input.wasPressed, released: input.wasReleased, held: input.isHeld }[trigger.phase](trigger.action);
    return hit ? { action: trigger.action } : null;
  }

  function matchTimer(trigger, previousSeconds) {
    if (trigger.repeat) {
      const before = Math.floor(previousSeconds / trigger.seconds + TIMER_EPSILON);
      const now = Math.floor(elapsedSeconds / trigger.seconds + TIMER_EPSILON);
      return now > before ? {} : null;
    }
    const crossed = previousSeconds < trigger.seconds - TIMER_EPSILON && elapsedSeconds >= trigger.seconds - TIMER_EPSILON;
    return crossed ? {} : null;
  }

  // A variable trigger fires when its expression turns true, not on every step it stays true.
  function matchVariable(trigger, ruleIndex) {
    const isTrue = evaluate(trigger.expression, variables) !== 0;
    const wasTrue = variableWasTrue.get(ruleIndex) === true;
    variableWasTrue.set(ruleIndex, isTrue);
    return isTrue && !wasTrue ? {} : null;
  }

  function matchTrigger(rule, ruleIndex, previousSeconds) {
    const trigger = rule.when;
    switch (trigger.type) {
      case 'enter': return matchZoneChange(entered, trigger);
      case 'exit': return matchZoneChange(exited, trigger);
      case 'contact': return matchContact(trigger);
      case 'input': return matchInput(trigger);
      case 'timer': return matchTimer(trigger, previousSeconds);
      default: return matchVariable(trigger, ruleIndex);
    }
  }

  function runAction(action, ruleIndex) {
    const base = { step, rule: ruleIndex, action: action.type };
    switch (action.type) {
      case 'set':
      case 'add': {
        const value = evaluate(action.value, variables);
        variables[action.variable] = action.type === 'set' ? value : variables[action.variable] + value;
        record({ ...base, variable: action.variable, value: variables[action.variable] });
        return;
      }
      case 'show':
      case 'hide':
        findPart(action.part, `rules[${ruleIndex}] action`).visible = action.type === 'show';
        record({ ...base, part: action.part });
        return;
      case 'spawn':
        if (spawnCount >= GAME_RULES_LIMITS.maximumSpawns) {
          record({ ...base, prefab: action.prefab, refused: 'spawn limit' });
          return;
        }
        spawnCount += 1;
        parts.push({ id: `${action.prefab}#${spawnCount}`, tags: [...prefabTags.get(action.prefab)], position: [...action.position], visible: true });
        record({ ...base, prefab: action.prefab, part: parts[parts.length - 1].id });
        return;
      case 'animation':
        record({ ...base, event: action.event });
        return;
      case 'sound':
        record({ ...base, name: action.name });
        return;
      case 'win':
      case 'lose':
        status = action.type === 'win' ? 'won' : 'lost';
        record(base);
        return;
      default:
        record(base);
        resetPlay();
    }
  }

  // Runs one rule's actions. Returns false when the rule ended the game or restarted it, which stops the step.
  function runRule(rule, ruleIndex, match) {
    record({ step, rule: ruleIndex, trigger: rule.when.type, ...match });
    for (const action of rule.actions) {
      const previousStatus = status;
      runAction(action, ruleIndex);
      if (action.type === 'restart' || status !== previousStatus) return false;
    }
    return true;
  }

  function fixedUpdate(stepSeconds) {
    if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) {
      throw new RangeError(`fixedUpdate step must be a number above 0 seconds, got ${String(stepSeconds)}.`);
    }
    if (status !== 'playing') return;
    step += 1;
    const previousSeconds = elapsedSeconds;
    elapsedSeconds += stepSeconds;
    trackZoneOccupancy();
    for (const [ruleIndex, rule] of rules.rules.entries()) {
      if (rule.once && firedOnce.has(ruleIndex)) continue;
      const match = matchTrigger(rule, ruleIndex, previousSeconds);
      if (match === null) continue;
      if (rule.condition !== null && evaluate(rule.condition, variables) === 0) continue;
      firedOnce.add(ruleIndex);
      if (!runRule(rule, ruleIndex, match)) break;
    }
    contacts = [];
  }

  function restart() {
    record({ step, rule: null, action: 'restart' });
    resetPlay();
  }

  return {
    name: options.name ?? 'game-rules',
    fixedUpdate,
    restart,
    /** Tell the rules where a part is. Call it from the system that owns the part, before this system's fixedUpdate. */
    setPartPosition(partId, position) {
      findPart(partId, 'setPartPosition').position = requireVector(position, `setPartPosition("${partId}") position`);
    },
    /** Tell the rules two parts touched during the coming step. Physics calls this from its contact callback. */
    reportContact(firstPartId, secondPartId) {
      contacts.push([findPart(firstPartId, 'reportContact'), findPart(secondPartId, 'reportContact')]);
    },
    get state() {
      return {
        status,
        won: status === 'won',
        lost: status === 'lost',
        step,
        elapsedSeconds,
        variables: { ...variables },
        parts: parts.map(part => ({ id: part.id, tags: [...part.tags], position: part.position && [...part.position], visible: part.visible })),
      };
    },
    get eventLog() {
      return eventLog.map(entry => ({ ...entry }));
    },
    get droppedEvents() {
      return droppedEvents;
    },
  };
}
