# Security

## Report a problem

Report it privately on GitHub: open the [Security tab](https://github.com/codepawl/67.js/security/advisories/new) and choose "Report a vulnerability", with the steps to reproduce the problem. If you cannot use GitHub, email legal@codepawl.com. Do not open a public issue for a vulnerability.

## Supported versions

Only the latest published version of `@codepawlhq/67js` gets security fixes.

## What the MCP server protects

The MCP server takes input from AI agents, and that input can come from a prompt injection. The server must therefore hold these limits:

- It runs no code that a tool call supplies.
- It reads assets only from the configured catalog, and it fetches no remote URLs for assets.
- It writes render output and GLB exports (`scene_export_glb`, under `exports/`, server-chosen names) only to the configured jobs folder.
- It bounds every collection, count and size before it allocates memory.

`docs/mcp.md` describes each limit and its boundary tests.

## Dependencies

The `Test` workflow runs `npm audit` on each pull request and fails on a high or critical advisory. `zod` and other packages count even when they are development dependencies, because the build bundles them into the MCP server. Dependabot opens grouped updates each week.
