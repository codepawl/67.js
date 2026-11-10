/**
 * Wording for the agent errors that recorded runs hit most. The session errors alone were a third of all tool errors
 * (21 of 68): an agent used an ID it invented, or one from a scene that was disposed or never created.
 *
 * `openSessionIds` lists the open scenes from least to most recently used; `evictedSessionIds` lists scenes the server
 * closed to stay under its scene cap.
 */
export function sessionProblem(requestedSessionId, activeSessionId, { openSessionIds = [], evictedSessionIds = [] } = {}) {
  if (evictedSessionIds.includes(requestedSessionId)) {
    const open = openSessionIds.length ? ` Open scenes: ${openSessionIds.join(', ')}.` : '';
    return `sessionId ${requestedSessionId} was evicted: the server keeps a limited number of open scenes and closes the least recently used one when a new scene is created.${open} Pass the sessionId of an open scene, or call scene_create again (scene_export_recipe saves a scene before it is evicted).`;
  }
  if (!activeSessionId) {
    return 'No scene is active: it was never created, was disposed, or scene_create failed. Call scene_create or scene_create_asset first, then pass the sessionId it returns.';
  }
  if (openSessionIds.length > 1) {
    return `Unknown scene session ${requestedSessionId}. Open scenes: ${openSessionIds.join(', ')}; the last used is ${activeSessionId}. Pass one of them as sessionId, leave sessionId out for the last used scene, or call scene_create for a new scene.`;
  }
  return `Unknown scene session ${requestedSessionId}. The active session is ${activeSessionId}; leave sessionId out or pass that one, or call scene_dispose and then scene_create for a new scene.`;
}

/** How many scenes one server keeps open, and the resident geometry bytes they may hold together. */
export const SCENE_STORE_LIMITS = Object.freeze({ maxOpenScenes: 4, maxOpenSceneBytes: 96 * 1024 * 1024 });
