#!/usr/bin/env node
import { constants, setPriority } from 'node:os';
import packageMetadata from '../package.json' with { type: 'json' };

const argumentsValue = process.argv.slice(2);
if (argumentsValue.length === 1 && argumentsValue[0] === '--version') {
  console.log(packageMetadata.version);
} else if (argumentsValue.length === 1 && argumentsValue[0] === '--check-update') {
  const { runCheckUpdateCli } = await import('../build/mcp/server.mjs');
  await runCheckUpdateCli({ version: packageMetadata.version });
} else if (argumentsValue.length === 1 && argumentsValue[0] === '--help') {
  console.log(`crucible-mcp ${packageMetadata.version}
Usage: crucible-mcp [--backend gpu|cpu] [--memory 32..384]
                 [--browser <Chrome/Chromium executable>] [--assets <absolute GLB directory>]
                 [--packs <absolute folder of data-only packs>]
                 [--jobs <absolute private output directory>] [--ffmpeg <absolute executable>]
       crucible-mcp --version | --check-update

Connect an MCP client over stdin/stdout. Chrome starts on the first scene.
Uses installed Chrome by default; supply --browser for another Chromium executable.
Render jobs require --jobs; MP4 encoding uses FFmpeg on PATH unless --ffmpeg is supplied.
Documentation: https://crucible.codepawl.com/mcp.md`);
} else {
  try {
    setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
    const { runMcpCli } = await import('../build/mcp/server.mjs');
    await runMcpCli({ argumentsValue, version: packageMetadata.version,
      previewUrl: new URL('../build/mcp/preview.js', import.meta.url),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
