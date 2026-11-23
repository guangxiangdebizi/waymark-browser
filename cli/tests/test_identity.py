import io
import contextlib
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from waymark_browser import cli, identity
from waymark_browser.client import Client


class DetectTests(unittest.TestCase):
    def test_explicit_agent_wins(self):
        who = identity.detect("codex", "task-7", "codex #2", env={"CLAUDECODE": "1"}, interactive=True)
        self.assertEqual((who.agent, who.source, who.session, who.window), ("codex", "declared", "task-7", "codex #2"))
        self.assertEqual(who.headers()["X-Waymark-Agent-Source"], "declared")

    def test_ai_agent_convention(self):
        who = identity.detect(env={"AI_AGENT": "claude-code_2-1-330_agent", "CLAUDE_CODE_SESSION_ID": "abc"}, interactive=False)
        self.assertEqual((who.agent, who.source), ("claude-code", "env"))
        self.assertEqual((who.session, who.session_source), ("claude-code-abc", "env"))

    def test_env_markers(self):
        self.assertEqual(identity.detect(env={"CLAUDECODE": "1"}, interactive=False).agent, "claude-code")
        self.assertEqual(identity.detect(env={"CODEX_SANDBOX": "seatbelt"}, interactive=False).agent, "codex")
        self.assertEqual(identity.detect(env={"WORKBUDDY_HOME": "x"}, interactive=False).agent, "workbuddy")

    def test_terminal_is_human_and_nothing_is_unknown(self):
        self.assertEqual(identity.detect(env={}, interactive=True).agent, "human")
        unknown = identity.detect(env={}, interactive=False)
        self.assertIsNone(unknown.agent)
        self.assertEqual(unknown.source, "unknown")
        self.assertNotIn("X-Waymark-Agent", unknown.headers())

    def test_header_values_stay_ascii(self):
        who = identity.detect("codex\r\nX-Evil: 1", window="窗口 2", env={}, interactive=False)
        self.assertNotIn("\n", who.agent)
        self.assertEqual(who.window, "%E7%AA%97%E5%8F%A3 2")


class Recorder(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *args):
        pass

    def reply(self, body, content_type="application/json", headers=None):
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        Recorder.seen.append(("GET", self.path, dict(self.headers)))
        if self.path.startswith("/api/agents"):
            session = {"key": "s:t1", "agent": "codex", "agentLabel": "Codex", "label": "task one", "inferred": False, "identity": "declared",
                       "start": "2026-11-23T06:00:00Z", "end": "2026-11-23T06:05:00Z", "durationMs": 300000, "actions": 4, "failures": 1,
                       "tabs": ["r:2"], "hosts": ["example.com"], "tokensEstimated": 900, "window": "codex #2"}
            self.reply(json.dumps({"agents": [{"agent": "codex", "label": "Codex", "sessions": [session], "calls": 6, "actions": 4, "failures": 1, "lastSeen": session["end"], "identity": {"declared": 1}}]}))
        elif self.path.startswith("/api/insights"):
            self.reply(json.dumps({"range": {"days": 7}, "filter": {}, "metrics": [{"id": "ocrRuns", "value": 3, "estimate": False}, {"id": "tokensSavedCaptcha", "value": 9000, "estimate": True}],
                                   "agents": [{"label": "Codex", "sessions": 1, "actions": 4, "successRate": 75, "avgStepsPerSession": 4, "tokensPerSession": 900}],
                                   "recommendations": [{"id": "stale_refs", "severity": "medium", "params": {"count": 3}}]}))
        elif self.path.startswith("/api/sessions/"):
            self.reply(json.dumps({"session": {"agentLabel": "Codex", "label": "task one", "identity": "declared", "start": "2026-11-23T06:00:00Z", "end": "2026-11-23T06:05:00Z", "actions": 4, "failures": 1, "tokensEstimated": 900},
                                   "tabs": [{"pageId": 2, "openedHere": True, "lastUrl": "https://example.com/"}],
                                   "timeline": [{"id": "e1", "timestamp": "2026-11-23T06:01:00Z", "action": "navigate", "status": "success", "target": {"url": "https://example.com/"}, "after": {"url": "https://example.com/", "title": "Example"}}]}))
        else:
            self.reply("{}")

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
        Recorder.seen.append(("POST", self.path, dict(self.headers), body))
        if self.path == "/api/windows":
            return self.reply(json.dumps({"ok": True, "opened": True, "url": "http://x/agents"}))
        if self.path == "/api/audit/prune":
            return self.reply(json.dumps({"cutoff": "2026-10-01T00:00:00Z", "kept": 5, "removed": 2, "snapshotsRemoved": 1, "screenshotsRemoved": 0, "dryRun": body.get("dryRun")}))
        if "id" not in body:
            return self.reply("")
        if body["method"] == "initialize":
            result = {"protocolVersion": "2025-03-26", "capabilities": {}, "serverInfo": {"name": "waymark", "version": "0"}}
            return self.reply(json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result}), headers={"Mcp-Session-Id": "sess-1"})
        name = body["params"].get("name")
        value = {"agent": "codex", "label": "Codex", "identifiedBy": "declared", "session": "t1"} if name == "whoami" else {"ok": True, "args": body["params"].get("arguments")}
        text = f"[UNTRUSTED_PAGE_CONTENT nonce=n origin=x]\n{json.dumps(value)}\n[END_UNTRUSTED_PAGE_CONTENT nonce=n]"
        self.reply(json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": {"content": [{"type": "text", "text": text}]}}))


class ProvenanceCommandTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def run_cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = cli.run(cli.build_parser().parse_args(["--url", self.url, *argv]))
        return code, out.getvalue()

    def test_identity_headers_reach_every_request(self):
        Recorder.seen.clear()
        self.run_cli("--agent", "codex", "--session", "t1", "--window", "codex #2", "whoami")
        posts = [entry for entry in Recorder.seen if entry[0] == "POST"]
        self.assertTrue(posts)
        for _, _, headers, _ in posts:
            self.assertEqual(headers.get("X-Waymark-Agent"), "codex")
            self.assertEqual(headers.get("X-Waymark-Session"), "t1")
            self.assertEqual(headers.get("X-Waymark-Window"), "codex #2")
            self.assertEqual(headers.get("X-Waymark-Stateless"), "1")
            self.assertNotIn("Mcp-Session-Id", headers)

    def test_subcommand_agent_flag(self):
        Recorder.seen.clear()
        code, out = self.run_cli("whoami", "--agent", "workbuddy", "--json")
        self.assertEqual(json.loads(out)["cli"]["agent"], "workbuddy")

    def test_agents_sessions_session_stats(self):
        code, out = self.run_cli("--agent", "human", "agents")
        self.assertIn("Codex", out)
        code, out = self.run_cli("--agent", "human", "sessions", "--of", "codex")
        self.assertIn("task one", out)
        self.assertIn("s:t1", out)
        code, out = self.run_cli("--agent", "human", "session", "s:t1")
        self.assertIn("opened here", out)
        self.assertIn("navigate", out)
        code, out = self.run_cli("--agent", "human", "stats")
        self.assertIn("ddddocr runs", out)
        self.assertIn("(estimate)", out)
        self.assertIn("stale_refs", out)
        code, out = self.run_cli("--agent", "human", "insights", "--json")
        self.assertEqual(json.loads(out)[0]["id"], "stale_refs")

    def test_screenshot_usage_windows_prune(self):
        code, out = self.run_cli("--agent", "human", "usage", "--input", "1200", "--output", "300", "--model", "m")
        self.assertEqual(json.loads(out)["args"], {"inputTokens": 1200, "outputTokens": 300, "model": "m"})
        code, out = self.run_cli("--agent", "human", "manager")
        self.assertIn("Opened", out)
        code, out = self.run_cli("--agent", "human", "prune", "--days", "30")
        self.assertIn("Would remove 2", out)
        self.assertIn("--yes", out)
        Recorder.seen.clear()
        self.run_cli("--agent", "human", "prune", "--days", "30", "--yes")
        self.assertFalse([e for e in Recorder.seen if e[1] == "/api/audit/prune"][0][3]["dryRun"])
        code, out = self.run_cli("--agent", "human", "activate", "2")
        self.assertEqual(json.loads(out)["args"], {"action": "active", "page": 2})

    def test_bridge_keeps_the_mcp_session(self):
        client = Client(self.url, stateless=False)
        client.call("tabs", {"action": "list"})
        Recorder.seen.clear()
        client.call("tabs", {"action": "list"})
        headers = [entry[2] for entry in Recorder.seen if entry[0] == "POST"][0]
        self.assertEqual(headers.get("Mcp-Session-Id"), "sess-1")
        self.assertNotIn("X-Waymark-Stateless", headers)


if __name__ == "__main__":
    unittest.main()
