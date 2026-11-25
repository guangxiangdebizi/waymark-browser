"""Minimal MCP client for the Waymark app, using only the standard library.

The app serves stateless Streamable HTTP MCP at ``/mcp`` and a small JSON cockpit
API under ``/api``. Responses to MCP POSTs may be plain JSON or an SSE stream.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Iterable

from . import __version__

DEFAULT_URL = "http://127.0.0.1:9510"
PROTOCOL_VERSION = "2025-03-26"
END_MARKER = "\n[END_UNTRUSTED_PAGE_CONTENT"


class WaymarkError(RuntimeError):
    """Raised for connection problems and tool errors reported by the app."""


class NotRunningError(WaymarkError):
    pass


def base_url(url: str | None = None) -> str:
    value = url or os.environ.get("WAYMARK_URL") or DEFAULT_URL
    value = value.rstrip("/")
    return value[: -len("/mcp")] if value.endswith("/mcp") else value


def parse_messages(body: str, content_type: str) -> list[dict]:
    """Return JSON-RPC messages from a JSON or text/event-stream response body."""
    if not body.strip():
        return []
    if "text/event-stream" not in content_type:
        data = json.loads(body)
        return data if isinstance(data, list) else [data]
    messages, chunk = [], []
    for line in body.splitlines() + [""]:
        if line.startswith("data:"):
            chunk.append(line[5:].lstrip())
        elif not line.strip() and chunk:
            try:
                messages.append(json.loads("\n".join(chunk)))
            except json.JSONDecodeError:
                pass
            chunk = []
    return messages


def unwrap(result: dict) -> Any:
    """Decode a tool result: strip the untrusted-content envelope and parse its JSON body."""
    texts = [item.get("text", "") for item in result.get("content", []) if item.get("type") == "text"]
    text = texts[0] if texts else ""
    start, end = text.find("\n"), text.rfind(END_MARKER)
    body = text[start + 1:end] if text.startswith("[UNTRUSTED_PAGE_CONTENT") and 0 <= start < end else text
    try:
        value = json.loads(body)
    except json.JSONDecodeError:
        value = body
    if result.get("isError"):
        message = value.get("error") if isinstance(value, dict) else value
        raise WaymarkError(str(message))
    return value


class Client:
    def __init__(self, url: str | None = None, timeout: float = 120.0, headers: dict | None = None, stateless: bool = True):
        self.url = base_url(url)
        self.timeout = timeout
        self._initialized = False
        self._next_id = 1
        # Identity headers (see identity.py) go on every request, so the ledger knows which agent ran each command.
        self.headers = dict(headers or {})
        # One CLI command is one short exchange: ask the app not to open an MCP session for it. The stdio bridge
        # instead keeps the session the app hands out, so the real client's clientInfo identifies its calls.
        self.stateless = stateless
        self.session_id: str | None = None

    # ----- transport -----
    def _request(self, method: str, path: str, body: Any = None, headers: dict | None = None) -> tuple[int, str, str]:
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.url + path, data=data, method=method)
        if body is not None:
            request.add_header("Content-Type", "application/json")
        for key, value in {**self.headers, **(headers or {})}.items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                session = response.headers.get("Mcp-Session-Id")
                if session and not self.stateless:
                    self.session_id = session
                return response.status, response.headers.get("Content-Type", ""), response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            text = error.read().decode("utf-8", "replace")
            try:
                message = json.loads(text).get("error") or text
            except (json.JSONDecodeError, AttributeError):
                message = text
            raise WaymarkError(f"HTTP {error.code}: {message}") from None
        except (urllib.error.URLError, ConnectionError, TimeoutError) as error:
            raise NotRunningError(f"Waymark is not reachable at {self.url} ({getattr(error, 'reason', error)}). Start it with `waymark start`.") from None

    def post_rpc(self, message: dict) -> list[dict]:
        """Send one JSON-RPC message to /mcp and return the messages in the response."""
        headers = {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL_VERSION}
        if self.stateless:
            headers["X-Waymark-Stateless"] = "1"
        elif self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        status, content_type, body = self._request("POST", "/mcp", message, headers)
        return [] if status == 202 else parse_messages(body, content_type)

    def rpc(self, method: str, params: dict | None = None) -> Any:
        message_id = self._next_id
        self._next_id += 1
        replies = self.post_rpc({"jsonrpc": "2.0", "id": message_id, "method": method, "params": params or {}})
        reply = next((item for item in replies if item.get("id") == message_id), None)
        if reply is None:
            raise WaymarkError(f"No response to {method}")
        if "error" in reply:
            raise WaymarkError(reply["error"].get("message", str(reply["error"])))
        return reply.get("result")

    def initialize(self) -> dict:
        result = self.rpc("initialize", {
            "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
            "clientInfo": {"name": "waymark-cli", "version": __version__},
        })
        self.post_rpc({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self._initialized = True
        return result

    # ----- MCP tools -----
    def call(self, tool: str, arguments: dict | None = None) -> Any:
        if not self._initialized:
            self.initialize()
        return unwrap(self.rpc("tools/call", {"name": tool, "arguments": arguments or {}}))

    def tools(self) -> list[dict]:
        if not self._initialized:
            self.initialize()
        return self.rpc("tools/list").get("tools", [])

    # ----- cockpit API -----
    def api(self, path: str, body: Any = None) -> Any:
        status, _, text = self._request("GET" if body is None else "POST", "/api/" + path.lstrip("/"), body)
        return json.loads(text) if text else None

    def health(self) -> bool:
        try:
            _, _, text = self._request("GET", "/health")
            return bool(json.loads(text).get("ok"))
        except (WaymarkError, json.JSONDecodeError):
            return False


def compact(values: Iterable[str], width: int) -> str:
    text = " ".join(values)
    return text if len(text) <= width else text[: width - 1] + "…"
