// The agent bench: the tasks that make up one bench run, each tagged with the kind of work it tests. Ids come from
// tasks.mjs (every one has a reference solution and an automatic grader). SMOKE_TASKS is the two-task subset used to
// prove the pipeline end to end without paying for a full run.

export const BENCH_TASKS = [
  { id: 'crate', kind: 'modeling' },
  { id: 'bolt', kind: 'modeling' },
  { id: 'table', kind: 'modeling' },
  { id: 'mug', kind: 'modeling' },
  { id: 'gear', kind: 'modeling' },
  { id: 'pillar-court', kind: 'modeling' },
  { id: 'chair', kind: 'modeling' },
  { id: 'crate-uv', kind: 'modeling' },
  { id: 'crate-revision', kind: 'revision' },
  { id: 'bracket-revision', kind: 'revision' },
  { id: 'kettle-resize', kind: 'revision' },
  { id: 'workshop', kind: 'scene' },
  { id: 'desk-resize', kind: 'scene' },
  { id: 'terrain-hole-walk', kind: 'scene' },
  { id: 'look-pick', kind: 'look' },
  { id: 'look-metal', kind: 'look' },
  { id: 'look-fog', kind: 'look' },
  { id: 'render-pick', kind: 'light' },
  { id: 'light-pick-hard', kind: 'light' },
  { id: 'light-key-fill', kind: 'light' },
  { id: 'light-spot-shadow', kind: 'light' },
  { id: 'camera-closeup', kind: 'camera' },
  { id: 'camera-orbit', kind: 'camera' },
  { id: 'robot-shot', kind: 'camera' },
  { id: 'overshoot-lift', kind: 'animation' },
  { id: 'robot-walk-wave', kind: 'animation' },
  { id: 'sunset-timelapse', kind: 'film' },
  { id: 'film-reveal', kind: 'film' },
];

export const SMOKE_TASKS = ['bolt', 'camera-closeup'];

export const kindOf = Object.fromEntries(BENCH_TASKS.map(task => [task.id, task.kind]));
