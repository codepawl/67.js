// One clock for every slicer: whichever job yielded last has given the page its turn, so two jobs that run one after the other
// in the same task share one slice instead of each spending its own.
let lastYieldAt = performance.now();

/** Hands the thread back so the page can draw and handle input between the slices of a long job. */
export async function yieldToPage() {
  await (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise(resolve => setTimeout(resolve, 0)));
  lastYieldAt = performance.now();
}

/** Elements a loop handles between two checks of the clock. A multiple of 3 and 4, so vec3 and vec4 data never splits an item. */
export const CHUNK_ELEMENTS = 49152;

/** Returns `checkpoint()`: it yields to the page once more than `sliceMilliseconds` have passed since anything last yielded, else it returns at once. */
export function createSlicer(sliceMilliseconds = 8) {
  return async function checkpoint() {
    if (performance.now() - lastYieldAt <= sliceMilliseconds) return;
    await yieldToPage();
  };
}

/** Calls `visit(from, to)` over [0, length) in chunks of CHUNK_ELEMENTS, with a checkpoint after each. */
export async function forEachChunk(length, checkpoint, visit) {
  for (let from = 0; from < length; from += CHUNK_ELEMENTS) {
    visit(from, Math.min(from + CHUNK_ELEMENTS, length));
    await checkpoint();
  }
}
