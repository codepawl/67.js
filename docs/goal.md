# Goal

67js aims to be as capable as Blender, as light as three.js, and as AI friendly as possible. No public claim of parity or speed is allowed until the evidence below exists.

## Definitions

**As capable as Blender.** Every in-scope row of the parity ledger (`docs/parity.md`) has evidence, and the reference scenes reach an agreed score against Cycles and EEVEE. Evidence is a golden fixture or a reference render. A demo does not count.

**As light as three.js.** The same scene costs less than three.js, in bytes and at runtime, on every scene in the matrix. Each entry has a size budget that a pull request cannot pass (`bench/size/README.md`).

**As AI friendly as possible.** A cold agent is compared on the same tasks with the official Blender MCP server and with three.js code. It must succeed more often and use fewer tool calls and tokens, on more than one model, and it never executes generated code (`bench/agent-modeling`).

## Not in scope

- A mouse editor, and the Blender interface and editors. Agents are the user, and people review through images and artifacts.
- The Video Editing sequencer, and Motion Tracking and Masking.
- Grease Pencil.
- Reading `.blend` files, and compatibility with the Blender Python API. GLB is the exchange format.
- Execution of agent-written code inside the engine. Tools stay bounded and schema-checked.

Each of these has a row in `docs/parity.md` with this reason. A change of direction can reopen it.

## Where the work is

Open issues are grouped by the milestones `0 Measure`, `1 Lighter`, `2 Modeling`, `3 Look`, `4 Motion and simulation`, `5 Agent surface` and `6 Games` on GitHub. `6 Games` is a live runtime for browser games (loop, physics, input, player, animation graph, audio, streaming, a prompt-to-playable agent path, multiplayer); game logic comes from bounded systems and recipes, never from agent-written code run in the engine. Each issue has a `goal:capable`, `goal:light` or `goal:ai` label. There is no tracking issue.
