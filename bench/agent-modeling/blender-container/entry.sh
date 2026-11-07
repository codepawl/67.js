#!/bin/sh
# Blender add-on server in background mode (port 9876, container-local) plus the official MCP server over HTTP (9191).
/opt/blender/blender --online-mode -b --command blender_mcp --host 127.0.0.1 --port 9876 > /work/blender-addon.log 2>&1 &
sleep 5
cd /opt/blender_mcp/mcp && exec uv run blender-mcp --transport http --host 0.0.0.0 --port 9191
