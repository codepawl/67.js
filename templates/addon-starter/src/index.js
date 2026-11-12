import { registerController } from '@codepawlhq/67js/addons/player';

const DEFAULT_HOVER_HEIGHT = 1.5;
const DEFAULT_SPEED = 4;

// A controller kind that holds a body at a fixed height and moves it with two input axes.
function createHoverController(options = {}) {
  const hoverHeight = options.hoverHeight ?? DEFAULT_HOVER_HEIGHT;
  const speed = options.speed ?? DEFAULT_SPEED;
  const state = { position: [0, hoverHeight, 0] };
  return {
    name: options.name ?? 'player',
    kind: 'hover',
    state,
    fixedUpdate(stepSeconds) {
      const sideways = options.input?.getAxis('moveX') ?? 0;
      const forward = options.input?.getAxis('moveForward') ?? 0;
      state.position[0] += sideways * speed * stepSeconds;
      state.position[2] -= forward * speed * stepSeconds;
      state.position[1] = hoverHeight;
    },
  };
}

// Call once per page or process: a kind name can be registered only one time.
export function registerHoverController(kind = 'hover') {
  registerController(kind, createHoverController);
  return kind;
}
