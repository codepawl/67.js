// Brings the full world to a world that is drawing its first view. The first view keeps playing whatever happens here.
//
// Resolves with
//   { state: 'ready', bytes, milliseconds }  the full world is in and drawing;
//   { state: 'failed' }                      every attempt failed: the first view stays;
//   { state: 'freed' }                       the world left the loop first.
//
// A full world that did not arrive or did not build is asked for again after each pause in `retryDelays` (milliseconds).
export const DETAIL_RETRY_DELAYS_MS = [4000, 10000, 20000];

const waitMilliseconds = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function completeDetail({
  world,
  pendingDetail,
  fetchAgain,
  gate = Promise.resolve(),
  retryDelays = DETAIL_RETRY_DELAYS_MS,
  pause = waitMilliseconds,
  now = () => performance.now(),
  onFailure = () => {},
}) {
  let currentDetail = pendingDetail;
  for (let attempt = 0; ; attempt++) {
    try {
      const files = await currentDetail;
      await gate;
      if (world.disposed) return { state: 'freed' };
      const started = now();
      const swapped = await world.upgrade(files);
      if (!swapped) return { state: 'freed' };
      return { state: 'ready', bytes: files.bytes, milliseconds: Math.round(now() - started) };
    } catch (error) {
      if (world.disposed) return { state: 'freed' };
      onFailure(attempt, error);
      if (attempt >= retryDelays.length) return { state: 'failed' };
      await pause(retryDelays[attempt]);
      if (world.disposed) return { state: 'freed' };
      currentDetail = fetchAgain();
      currentDetail.catch(() => {});
    }
  }
}

// Builds a downloaded world. A first view that does not parse or upload is not the end of the hero: the full world, which is already
// on its way, is built instead. Resolves with the world and the download it was built from.
export async function buildWithFallback(download, build) {
  try {
    return { world: await build(download), builtFrom: download };
  } catch (error) {
    if (!download.isFirstView) throw error;
    const fullDownload = await download.detail;
    return { world: await build(fullDownload), builtFrom: fullDownload };
  }
}
