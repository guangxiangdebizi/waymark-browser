"""stdio <-> Streamable HTTP bridge so stdio-only MCP clients can drive Waymark.

Usage in an MCP client config:  {"command": "waymark", "args": ["mcp"]}
"""
from __future__ import annotations

import json
import sys
from typing import Callable, TextIO

from .client import Client, NotRunningError, WaymarkError


def serve(client: Client, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout, on_down: Callable[[], bool] | None = None) -> int:
    def emit(message: dict) -> None:
        stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
        stdout.flush()

    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
            continue
        try:
            try:
                replies = client.post_rpc(message)
            except NotRunningError:
                if not (on_down and on_down()):
                    raise
                replies = client.post_rpc(message)
            for reply in replies:
                emit(reply)
        except WaymarkError as error:
            if isinstance(message, dict) and "id" in message:
                emit({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000, "message": str(error)}})
            else:
                print(f"waymark mcp: {error}", file=sys.stderr, flush=True)
    return 0
