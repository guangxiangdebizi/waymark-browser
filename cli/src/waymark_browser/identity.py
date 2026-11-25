"""Who is running the CLI: an explicit --agent, an agent's own environment marker, a person at a terminal, or unknown.

Nothing here guesses. Each answer says how it was found (``declared``, ``env``, ``tty``), and when no marker is present
and stdin is not a terminal the agent is left unknown.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Mapping, Optional
from urllib.parse import quote

# (agent id, exact variable names, variable-name prefixes). The first match wins; extend to recognise more agents.
ENV_MARKERS = [
    ("claude-code", ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID"), ()),
    ("codex", ("CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_MANAGED_BY_NPM"), ()),
    ("workbuddy", (), ("WORKBUDDY_",)),
    ("codebuddy", (), ("CODEBUDDY_",)),
    ("gemini-cli", ("GEMINI_CLI",), ()),
    ("cursor", ("CURSOR_AGENT",), ()),
    ("opencode", ("OPENCODE",), ("OPENCODE_",)),
    ("qwen-code", ("QWEN_CODE",), ()),
]

# Variables that carry the agent's own conversation/session id.
SESSION_VARS = [
    ("claude-code", "CLAUDE_CODE_SESSION_ID"),
    ("codex", "CODEX_THREAD_ID"),
    ("codex", "CODEX_SESSION_ID"),
    ("cursor", "CURSOR_CONVERSATION_ID"),
]


@dataclass
class Identity:
    agent: Optional[str]
    source: str  # declared | env | tty | unknown
    session: Optional[str] = None
    session_source: Optional[str] = None
    window: Optional[str] = None

    def headers(self) -> dict:
        headers = {"X-Waymark-Client": "cli"}
        if self.agent:
            headers["X-Waymark-Agent"] = self.agent
            headers["X-Waymark-Agent-Source"] = self.source
        if self.session:
            headers["X-Waymark-Session"] = self.session
            headers["X-Waymark-Session-Source"] = self.session_source or "declared"
        if self.window:
            headers["X-Waymark-Window"] = self.window
        return headers


def _ascii(value: Optional[str], limit: int = 120) -> Optional[str]:
    """Header-safe text: control characters dropped, non-ASCII percent-encoded (Waymark decodes it)."""
    if not value:
        return None
    text = "".join(ch for ch in value if ord(ch) >= 32 and ord(ch) != 127).strip()[:limit]
    text = "".join(ch if ord(ch) < 127 and ch != "%" else quote(ch) for ch in text)
    return text or None


def detect(agent: Optional[str] = None, session: Optional[str] = None, window: Optional[str] = None,
           env: Optional[Mapping[str, str]] = None, interactive: Optional[bool] = None) -> Identity:
    env = os.environ if env is None else env
    if interactive is None:
        interactive = bool(getattr(sys.stdin, "isatty", lambda: False)())
    window = _ascii(window or env.get("WAYMARK_WINDOW"))
    explicit_session = _ascii(session or env.get("WAYMARK_SESSION"))
    explicit = _ascii(agent or env.get("WAYMARK_AGENT"), 60)
    found, source = None, "unknown"
    if explicit:
        found, source = explicit, "declared"
    elif env.get("AI_AGENT"):
        # Emerging convention: AI_AGENT=<name>_<version>_<kind>, e.g. claude-code_2-1-330_agent.
        found, source = _ascii(env["AI_AGENT"].split("_")[0], 60), "env"
    else:
        for name, exact, prefixes in ENV_MARKERS:
            if any(env.get(var) for var in exact) or any(key.startswith(prefix) for key in env for prefix in prefixes):
                found, source = name, "env"
                break
    if not found and interactive:
        found, source = "human", "tty"
    session_value, session_source = explicit_session, ("declared" if explicit_session else None)
    if not session_value and found:
        for name, var in SESSION_VARS:
            if name == found and env.get(var):
                session_value, session_source = f"{name}-{_ascii(env[var], 40)}", "env"
                break
    return Identity(found, source if found else "unknown", session_value, session_source, window)
