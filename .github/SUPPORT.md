# Getting help

## Read first

- The [guide](https://crucible.codepawl.com/guide.md) covers install, scenes, materials, animation and export.
- The [MCP reference](../docs/mcp.md) lists every tool, its limits and its errors.
- [llms.txt](https://crucible.codepawl.com/llms.txt) is the same guide as plain text for an agent.
- The skills [build-crucible-scene](../skills/build-crucible-scene/SKILL.md) and [render-crucible-media](../skills/render-crucible-media/SKILL.md) teach an agent the MCP tools.

## Ask or report

Ask how to do something in [Discussions Q&A](https://github.com/codepawl/crucible/discussions/categories/q-a), and show what you made in [Show and tell](https://github.com/codepawl/crucible/discussions/categories/show-and-tell).
Open an [issue](https://github.com/codepawl/crucible/issues/new/choose) for a bug or a feature request.
A bug report that has the version, the environment and the smallest recipe or script that shows the problem gets fixed first.

Issues are public. Leave out local paths, tokens and personal data.

## Security

Report it [privately on GitHub](https://github.com/codepawl/crucible/security/advisories/new), or email legal@codepawl.com. Do not open a public issue. [SECURITY.md](SECURITY.md) has the details.

## Common problems

- **The MCP server cannot find Chrome.** Install Chrome, or pass `--browser <path to a Chromium executable>`.
- **No GPU, or the GPU backend fails.** Start the server with `--backend cpu`. It is slower.
- **Render jobs fail at once.** Render jobs need `--jobs <absolute output folder>`, and MP4 needs FFmpeg on `PATH` or `--ffmpeg <path>`.
- **The server runs out of memory.** Change `--memory` (32 to 384) or split the scene. `npx crucible-mcp --help` lists every flag.
