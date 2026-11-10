# Connect the MCP server

This page connects the 67js MCP server to an AI agent harness. A harness is the program that runs the agent, such as Claude Code or Cursor. At the end, the agent can build a scene and show you a picture of it.

## What the server is

`67js-mcp` is a local program. The harness starts it and talks to it over stdin and stdout. It has no network listener for MCP.

The server holds a few open scenes and uses the last one you used when a call has no `sessionId`. When the agent calls `scene_create`, the server starts your installed Chrome in the background and renders the scene there. It gives the agent 24 tools to build, look at and export the scene. The tools take JSON, and they never run code that the agent writes.

You need two things:

- **Node.js 20.19 or later.** Run `node --version` to check.
- **Google Chrome or another Chromium.** The server does not download a browser.

Check that the server starts. This command downloads the package and prints its version:

```sh
npx -y --package @codepawlhq/67js 67js-mcp --version
```

The command prints the version, for example `0.15.0`. The package on npm is `@codepawlhq/67js` and its command is `67js-mcp`.

## The launch command

Every harness below runs the same command. These are the parts of it:

```text
npx -y --package @codepawlhq/67js 67js-mcp --backend gpu --memory 192
```

`--backend` is `gpu` or `cpu`. Use `cpu` on a machine with no graphics card or on a remote machine. `--memory` is the render budget in MiB, from 32 to 384. The default is 192. These options are optional too:

| Option | Value | What it does |
| --- | --- | --- |
| `--browser` | Path to a Chrome or Chromium executable | Use a browser other than the installed Google Chrome. |
| `--assets` | Absolute path to a folder of GLB files | Lets the agent place those models. |
| `--jobs` | Absolute path to a private folder | Turns on the render job tools for PNG, image sequences and MP4. |
| `--ffmpeg` | Absolute path to FFmpeg | Sets the encoder for MP4 jobs. FFmpeg on `PATH` works without it. |
| `--audio` | Absolute path to a folder of sound files | Lets video jobs add sound. |

`67js-mcp --help` prints the same list. Add `@0.15.0` after the package name to pin a version, as in `@codepawlhq/67js@0.15.0`.

### The node form

The first `npx` run downloads the package, which can take longer than a harness waits for a server to start. A harness on Windows can also fail to start `npx`. In both cases, install the package once and start Node directly:

```sh
npm install 67js@npm:@codepawlhq/67js
```

Then replace `command` and `args` in any snippet below with the absolute path of Node and of the installed script. This example is for Windows:

```json
{
  "command": "C:/Program Files/nodejs/node.exe",
  "args": ["C:/projects/my-scene/node_modules/67js/bin/67js-mcp.mjs", "--backend", "gpu", "--memory", "192"]
}
```

On macOS and Linux, use the output of `which node` as the command. Use forward slashes in JSON on Windows. A backslash needs a second backslash.

## Claude Code

The plugin is the shortest route. It adds the server and the `build-67js-scene` and `render-67js-media` skills:

```text
/plugin marketplace add codepawl/67.js
/plugin install 67js@67js
```

The plugin starts the server with `npx` from the published npm package. For a manual setup, Claude Code can add the server with one command. Everything after `--` is the launch command:

```sh
claude mcp add --transport stdio 67js-scene -- npx -y --package @codepawlhq/67js 67js-mcp --backend gpu --memory 192
```

The command writes to your local scope. Add `--scope project` to write a `.mcp.json` file in the project root that you can commit, or `--scope user` to use the server in every project. You can also write `.mcp.json` yourself:

```json
{
  "mcpServers": {
    "67js-scene": {
      "command": "npx",
      "args": ["-y", "--package", "@codepawlhq/67js", "67js-mcp", "--backend", "gpu", "--memory", "192"]
    }
  }
}
```

Claude Code asks you to approve a server from `.mcp.json` the first time you run `claude` in that folder. Run `claude mcp get 67js-scene` to see its status. Inside a session, `/mcp` shows the same list.

If the server needs more than the default time to start, set `MCP_TIMEOUT` in milliseconds, as in `MCP_TIMEOUT=60000 claude`. Source: [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).

## Claude Desktop

Open Settings, then Developer, then Edit Config. The file is:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Add the server under `mcpServers`:

```json
{
  "mcpServers": {
    "67js-scene": {
      "command": "npx",
      "args": ["-y", "--package", "@codepawlhq/67js", "67js-mcp", "--backend", "gpu", "--memory", "192"]
    }
  }
}
```

Restart Claude Desktop completely. A desktop app does not read your shell `PATH`, so it can start a different Node than your terminal does. If the server does not appear, use the node form with absolute paths. The logs are in `%APPDATA%\Claude\logs` on Windows. Source: [Model Context Protocol, connect local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

## Cursor

Cursor reads `.cursor/mcp.json` in a project and `~/.cursor/mcp.json` for every project. Use the same `mcpServers` shape:

```json
{
  "mcpServers": {
    "67js-scene": {
      "command": "npx",
      "args": ["-y", "--package", "@codepawlhq/67js", "67js-mcp", "--backend", "gpu", "--memory", "192"]
    }
  }
}
```

Cursor lists the server under its Customize page. Source: [Cursor MCP docs](https://cursor.com/docs/mcp).

## VS Code

VS Code runs MCP servers for GitHub Copilot chat. It reads `.vscode/mcp.json` in a workspace, or an `mcp.json` in your user profile. This file uses `servers`, not `mcpServers`, and it has a `type`:

```json
{
  "servers": {
    "67js-scene": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "--package", "@codepawlhq/67js", "67js-mcp", "--backend", "gpu", "--memory", "192"]
    }
  }
}
```

To see the server's tools, open Chat, then Customizations, then Tools. In a local harness session, use Configure Tools in the chat input. Source: [VS Code MCP configuration reference](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration).

## OpenAI Codex CLI

Codex stores MCP servers in `~/.codex/config.toml`. A project can have its own `.codex/config.toml`. Add a table for the server:

```toml
[mcp_servers.67js-scene]
command = "npx"
args = ["-y", "--package", "@codepawlhq/67js", "67js-mcp", "--backend", "gpu", "--memory", "192"]
startup_timeout_sec = 60
tool_timeout_sec = 120
```

The default start timeout is 10 seconds, so the first `npx` download can fail without `startup_timeout_sec`. The default tool timeout is 60 seconds. You can also add the server from the shell:

```sh
codex mcp add 67js-scene -- npx -y --package @codepawlhq/67js 67js-mcp --backend gpu --memory 192
```

Source: [Codex MCP docs](https://developers.openai.com/codex/mcp).

## Gemini CLI

Gemini CLI reads `~/.gemini/settings.json` for every project and `.gemini/settings.json` for one project. Add `mcpServers` to the file. Keep the other settings in it:

```json
{
  "mcpServers": {
    "67js-scene": {
      "command": "npx",
      "args": ["-y", "--package", "@codepawlhq/67js", "67js-mcp", "--backend", "gpu", "--memory", "192"],
      "timeout": 120000
    }
  }
}
```

`timeout` is in milliseconds. Leave `trust` at its default of `false`, so Gemini CLI asks before each tool call. Sources: [Gemini CLI MCP docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md) and [its settings reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md).

## Google Antigravity

Antigravity reads `~/.gemini/config/mcp_config.json` for every project and `<workspace>/.agents/mcp_config.json` for one workspace. In the IDE, open Manage MCP Servers, then View raw config, and edit the same file:

```json
{
  "mcpServers": {
    "67js-scene": {
      "command": "npx",
      "args": ["-y", "--package", "@codepawlhq/67js", "67js-mcp", "--backend", "gpu", "--memory", "192"]
    }
  }
}
```

In the Antigravity CLI, type `/mcp` to see the status of each server. Source: [Antigravity MCP docs](https://antigravity.google/docs/mcp).

## Cline

Cline stores its servers in a JSON file. In the IDE extension, open the MCP Servers icon, then the Configure tab, then Configure MCP Servers. The Cline CLI uses `~/.cline/data/settings/cline_mcp_settings.json`.

```json
{
  "mcpServers": {
    "67js-scene": {
      "command": "npx",
      "args": ["-y", "--package", "@codepawlhq/67js", "67js-mcp", "--backend", "gpu", "--memory", "192"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

An empty `autoApprove` list makes Cline ask before each tool call. The Cline CLI can also add the server: `cline mcp add 67js-scene --yes -- npx -y --package @codepawlhq/67js 67js-mcp --backend gpu --memory 192`. Source: [Cline MCP docs](https://docs.cline.bot/mcp/mcp-overview).

## Zed

Zed calls MCP servers context servers. Open the settings file with the `zed: open settings file` action and add the server under `context_servers`:

```json
{
  "context_servers": {
    "67js-scene": {
      "command": "npx",
      "args": ["-y", "--package", "@codepawlhq/67js", "67js-mcp", "--backend", "gpu", "--memory", "192"],
      "env": {}
    }
  }
}
```

You can also use Settings, then AI, then MCP Servers, then Add Server. The Agent Panel then lists the server's tools. Source: [Zed MCP docs](https://zed.dev/docs/ai/mcp).

## Not covered: Windsurf

The Windsurf documentation pages now redirect to Devin Desktop, which names `.devin/mcp_config.json` and `~/.config/devin/mcp_config.json`. The pages do not show the Windsurf editor's own file, so this page has no Windsurf snippet. If you use Devin Desktop, put the same `mcpServers` entry in one of those two files.

## Check that it works

First, ask the harness to list its MCP tools. You must see 24 tools whose names start with `scene_`, `mesh_` or `scene_render_`. Some harnesses add the server name in front, for example `mcp__67js-scene__scene_look` in Claude Code.

Then give the agent this prompt:

```text
Use 67js to build a small wooden table with a top and four legs. Show me a picture of it.
```

The agent calls these tools in this order. [Working with agents](#agent-workflows) shows the real result of each call.

1. `scene_capabilities` reads the limits.
2. `scene_create` makes the scene. This call starts Chrome. It took 1.2 seconds with the `cpu` backend in a local test.
3. `scene_look` returns a PNG picture and a small JSON record.

If the agent answers with JavaScript instead of tool calls, the server is not connected. Open the harness's MCP status view and read the error there.

## Troubleshooting

- **The server never appears.** Run the launch command in a terminal. If it works there and not in the harness, the harness uses another `PATH` or another Node. Use the node form with absolute paths.
- **The server times out on first start.** The first `npx` run downloads the package. Install it once with `npm install 67js@npm:@codepawlhq/67js`, or raise the harness start timeout as shown above.
- **Node is too old.** The package needs Node 20.19 or later. Run `node --version`, and use the Node that the harness starts, not only the one in your terminal.
- **`scene_create` fails.** The server could not start Chrome or the preview page. Install Google Chrome, or pass `--browser` with the path of a Chromium executable. The server writes the cause to stderr, which the harness shows in its MCP log.
- **A sandbox blocks the tool.** The server starts a browser and serves its preview page on the loopback interface. A sandbox that blocks either one makes `scene_create` fail. Allow both for this server, or run the harness without that sandbox.
- **The connection breaks with a parse error.** The server writes only MCP messages to stdout. Its errors go to stderr. A wrapper script that prints to stdout breaks the connection, so do not wrap the launch command in a script that echoes text.
- **Render job tools are missing.** The job tools need `--jobs` with an absolute path to a private folder.
- **A tool call asks for approval each time.** This is the harness policy. Approve the read-only tools `scene_look`, `scene_inspect` and `scene_capabilities` once, and review the rest.

## Security limits

The server is built so that an agent cannot do more than build scenes:

- No tool runs JavaScript or any other code from the agent. Every argument is checked against a schema before it runs.
- No tool takes a remote URL. Remote asset requests are blocked in the preview page.
- No tool takes a file path for output. Render jobs and GLB exports go to a fixed folder under `--jobs` with names that the server picks.
- Models load only from the `--assets` folder, and only as self-contained GLB files within fixed size limits.
- The only text that reaches a shader is a bounded fragment snippet in `postPasses`, which a strict validator checks first.
- The process runs below normal priority, so it does not slow down your other work.

Give `--jobs` and `--assets` folders that hold nothing private. The [MCP guide](/mcp.md) lists every limit.
