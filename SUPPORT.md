# Getting help

## Read first

- The [guide](https://67js.codepawl.com/guide.md) covers install, scenes, materials, animation and export.
- The [MCP reference](docs/mcp.md) lists every tool, its limits and its errors.
- [llms.txt](https://67js.codepawl.com/llms.txt) is the same guide as plain text for an agent.
- The skills [build-67js-scene](skills/build-67js-scene/SKILL.md) and [render-67js-media](skills/render-67js-media/SKILL.md) teach an agent the MCP tools.

## Ask or report

Open an [issue](https://github.com/codepawl/67.js/issues/new/choose) and pick the form that fits: a bug, a feature or a question.
A bug report that has the version, the environment and the smallest recipe or script that shows the problem gets fixed first.

Issues are public. Leave out local paths, tokens and personal data.

## Security

Email legal@codepawl.com and do not open a public issue. [SECURITY.md](SECURITY.md) has the details.

## Common problems

- **The MCP server cannot find Chrome.** Install Chrome, or pass `--browser <path to a Chromium executable>`.
- **No GPU, or the GPU backend fails.** Start the server with `--backend cpu`. It is slower.
- **Render jobs fail at once.** Render jobs need `--jobs <absolute output folder>`, and MP4 needs FFmpeg on `PATH` or `--ffmpeg <path>`.
- **The server runs out of memory.** Change `--memory` (32 to 384) or split the scene. `npx 67js-mcp --help` lists every flag.
