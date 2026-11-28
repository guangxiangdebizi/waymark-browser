"""`waymark` command line."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime
from typing import Any

from . import __version__, app, bridge, identity
from .client import Client, WaymarkError


def emit(value: Any, as_json: bool) -> None:
    if as_json or not isinstance(value, str):
        print(json.dumps(value, ensure_ascii=False, indent=2))
    else:
        print(value)


def fmt_time(ts: str) -> str:
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().strftime("%m-%d %H:%M:%S")
    except ValueError:
        return ts


def show_status(status: dict) -> str:
    pending = [job for job in status.get("challenges", []) if job["status"] in ("detected", "ai_recovery_required", "human_required")]
    clipboard = "isolated" if status.get("clipboardProvider", "").endswith("virtual") else "system"
    lines = [
        f"State        {'PAUSED by user' if status.get('paused') else ('busy' if status.get('busy') else 'ready')}",
        f"Session      {status.get('session')}",
        f"Tabs         {status.get('tabs')}",
        f"Clipboard    {clipboard}",
        f"Ambient mouse {'on' if status.get('ambientMouse', {}).get('enabled') else 'off'}",
        f"Actions today {status.get('todayActions')}",
        f"Challenges   {len(pending)} waiting" + "".join(f"\n  - {job['status']} {job['origin']} ({job['id'][:8]})" for job in pending),
        f"MCP          {status.get('mcp')}",
    ]
    return "\n".join(lines)


def show_tabs(tabs: list) -> str:
    if not tabs:
        return "No tabs."
    return "\n".join(f"{'*' if tab.get('active') else ' '} {tab['id']:>3}  {tab.get('title') or '(untitled)'}\n       {tab.get('url')}" for tab in tabs)


def collapse_started(events: list) -> list:
    """Drop "started" rows that already have a matching completion (input is newest first)."""
    completed: dict = {}
    result = []
    for event in events:
        key = (event.get("pageId"), event["action"])
        if event["status"] in ("success", "failure"):
            completed[key] = completed.get(key, 0) + 1
        elif event["status"] == "started" and completed.get(key):
            completed[key] -= 1
            continue
        result.append(event)
    return result


def show_audit(events: list) -> str:
    rows = []
    for event in reversed(collapse_started([e for e in events if e["action"] != "tabs.list"])):
        where = (event.get("after") or event.get("before") or {}).get("url", "")
        target = event.get("target") or {}
        detail = target.get("ref") or target.get("url") or target.get("key") or ""
        status = {"success": "ok", "failure": "FAIL", "info": "-", "started": "..."}.get(event["status"], event["status"])
        line = f"{fmt_time(event['timestamp'])}  {status:<4} {event['action']:<16} {str(detail)[:40]:<40} {where[:70]}"
        if event.get("error"):
            line += f"\n{'':20}{event['error'].splitlines()[0][:120]}"
        rows.append(line)
    return "\n".join(rows) or "No events."


def fmt_duration(ms: float) -> str:
    seconds = (ms or 0) / 1000
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{seconds / 60:.0f}m"
    return f"{seconds / 3600:.1f}h"


def show_agents(tree: dict) -> str:
    if not tree.get("agents"):
        return "No agent activity in this period."
    lines = []
    for agent in tree["agents"]:
        ids = ", ".join(f"{k}:{v}" for k, v in agent.get("identity", {}).items())
        lines.append(f"{agent['label']:<16} sessions {len(agent['sessions']):>3}  actions {agent['actions']:>5}  failed {agent['failures']:>4}  last {fmt_time(agent['lastSeen'])}  [{ids}]")
    return "\n".join(lines)


def show_sessions(tree: dict, agent: str | None = None) -> str:
    rows = []
    for item in tree.get("agents", []):
        if agent and item["agent"] != agent:
            continue
        for session in item["sessions"]:
            rows.append(session)
    rows.sort(key=lambda s: s["end"], reverse=True)
    if not rows:
        return "No sessions."
    out = []
    for s in rows:
        flag = " (inferred)" if s.get("inferred") else ""
        out.append(f"{fmt_time(s['end'])}  {s['agentLabel']:<12} {s['label'][:40]:<40}{flag}\n"
                   f"    key {s['key']}  {s['actions']} actions, {s['failures']} failed, {len(s['tabs'])} tabs, {fmt_duration(s['durationMs'])}"
                   + (f"  window {s['window']}" if s.get("window") else "") + (f"\n    {' · '.join(s['hosts'][:6])}" if s.get("hosts") else ""))
    return "\n".join(out)


def show_session(detail: dict) -> str:
    s = detail["session"]
    lines = [f"{s['agentLabel']} · {s['label']}  ({s['identity']}{', inferred' if s.get('inferred') else ''})",
             f"{fmt_time(s['start'])} -> {fmt_time(s['end'])}  {s['actions']} actions, {s['failures']} failed, ~{s['tokensEstimated']} tokens (estimate)"]
    for tab in detail.get("tabs", []):
        opened = "opened here" if tab.get("openedHere") else (f"opened by {tab['openedBy']}" if tab.get("openedBy") else "existing tab")
        lines.append(f"  tab {tab['pageId']:>3}  {opened:<20} {(tab.get('lastUrl') or '')[:80]}")
    lines.append("")
    lines.append(show_audit(list(reversed(detail.get("timeline", [])))))
    return "\n".join(lines)


METRIC_LABELS = {
    "calls": "AI steps (tool calls)", "actions": "Browser actions", "successRate": "Action success %", "sessions": "Sessions", "agents": "Agents",
    "ocrRuns": "ddddocr runs", "ocrSolved": "ddddocr solved", "challengesDetected": "CAPTCHAs / bot walls", "humanHandoffs": "Handed to a person",
    "pointerPaths": "Human pointer paths", "humanKeystrokes": "Human-typed characters", "idleMoves": "Idle behaviour steps", "pacingSeconds": "Pacing wait (s)",
    "tokensBrowserIo": "Browser I/O tokens", "tokensReported": "Tokens reported by agents", "tokensSavedCaptcha": "Tokens saved: CAPTCHAs",
    "tokensSavedDiffs": "Tokens saved: diffs", "tokensSavedVsScreenshots": "Tokens saved: text vs screenshots", "tokensSavedTruncation": "Tokens not sent: read limit",
    "tokensWastedRedundantSnapshots": "Tokens wasted: repeat snapshots", "thinkSeconds": "Agent thinking (s)", "browserSeconds": "Browser execution (s)",
}


def show_stats(report: dict, suggestions_only: bool = False) -> str:
    lines = []
    if not suggestions_only:
        lines.append(f"Waymark insights, last {report['range']['days']} days" + (f" · agent {report['filter']['agent']}" if report.get("filter", {}).get("agent") else ""))
        for metric in report["metrics"]:
            if metric["id"] in METRIC_LABELS:
                est = "  (estimate)" if metric.get("estimate") else ""
                lines.append(f"  {METRIC_LABELS[metric['id']]:<34} {metric['value']:>10}{est}")
        if report.get("agents"):
            lines.append("")
            lines.append("  Agent            sessions  actions  success  steps/session  tokens/session(est)")
            for a in report["agents"]:
                lines.append(f"  {a['label']:<16} {a['sessions']:>8} {a['actions']:>8} {a['successRate']:>7}% {a['avgStepsPerSession']:>14} {a['tokensPerSession']:>20}")
        lines.append("")
    recs = report.get("recommendations", [])
    lines.append("Suggestions:" if recs else "Suggestions: none")
    for rec in recs:
        params = ", ".join(f"{k}={v}" for k, v in rec.get("params", {}).items())
        lines.append(f"  [{rec['severity']}] {rec['id']}  {params}")
    return "\n".join(lines)


def parse_fields(values: list[str]) -> list[dict]:
    if len(values) % 2:
        raise SystemExit("fill expects REF VALUE pairs, e.g. waymark fill 3 e4 hello e5 world")
    return [{"ref": values[index], "value": values[index + 1]} for index in range(0, len(values), 2)]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="waymark", description="Drive Waymark, the open-source browser for AI agents, from the terminal.")
    parser.add_argument("--url", help="Waymark base URL (default $WAYMARK_URL or http://127.0.0.1:9510)")
    parser.add_argument("--json", action="store_true", help="print raw JSON")
    parser.add_argument("--agent", help="who is driving (default $WAYMARK_AGENT, else detected from the agent's environment, else 'human' in a terminal)")
    parser.add_argument("--session", help="session id to group commands under (default $WAYMARK_SESSION or the agent's own session id)")
    parser.add_argument("--window", help="label for your window or worker, e.g. 'codex #2' (default $WAYMARK_WINDOW)")
    parser.add_argument("--version", action="version", version=f"waymark-browser {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="COMMAND")
    # Accept --json/--url after the subcommand too (`waymark audit --json`); SUPPRESS keeps the global value otherwise.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="print raw JSON")
    common.add_argument("--url", default=argparse.SUPPRESS, help="Waymark base URL")
    common.add_argument("--agent", default=argparse.SUPPRESS, help="who is driving: claude-code, codex, workbuddy, human... (default $WAYMARK_AGENT or auto-detected)")
    common.add_argument("--session", default=argparse.SUPPRESS, help="your session id, kept across commands (default $WAYMARK_SESSION or the agent's own)")
    common.add_argument("--window", default=argparse.SUPPRESS, help="label of your window or worker (default $WAYMARK_WINDOW)")
    original_add_parser = sub.add_parser
    sub.add_parser = lambda *a, **k: original_add_parser(*a, parents=[common], **k)  # type: ignore[method-assign]

    p = sub.add_parser("setup", help="download and build the Waymark desktop app")
    p.add_argument("--dir", help="install directory (default ~/.waymark/app)")
    p.add_argument("--ref", help="git tag or branch (default: the tag matching this CLI)")
    p.add_argument("--no-build", action="store_true", help="only download the source")

    p = sub.add_parser("start", help="start the desktop app")
    p.add_argument("--app-dir")
    p.add_argument("--port", type=int)
    p.add_argument("--foreground", action="store_true", help="stay attached (Ctrl+C to quit)")
    p.add_argument("--timeout", type=float, default=120)
    sub.add_parser("stop", help="stop the app started by `waymark start`")
    p = sub.add_parser("doctor", help="check Node.js, the app install and the connection")
    p.add_argument("--app-dir")

    sub.add_parser("status", help="show automation state, tabs and pending challenges")
    sub.add_parser("pause", help="pause all agent automation (the user takes the browser)")
    sub.add_parser("resume", help="let agents drive the browser again")
    sub.add_parser("tabs", help="list tabs")
    p = sub.add_parser("open", help="open a URL in a new tab")
    p.add_argument("target", metavar="url")
    p = sub.add_parser("goto", help="navigate a tab")
    p.add_argument("page", type=int)
    p.add_argument("target", metavar="url")
    for name in ("back", "forward", "reload", "close"):
        p = sub.add_parser(name, help=f"{name} a tab")
        p.add_argument("page", type=int)
    p = sub.add_parser("snapshot", help="list interactive elements with refs")
    p.add_argument("page", type=int)
    p = sub.add_parser("read", help="read page text (or rendered HTML)")
    p.add_argument("page", type=int)
    p.add_argument("--html", action="store_true")
    p.add_argument("--limit", type=int)
    p = sub.add_parser("click", help="click an element ref from the last snapshot")
    p.add_argument("page", type=int)
    p.add_argument("ref")
    p = sub.add_parser("hover", help="hover an element ref")
    p.add_argument("page", type=int)
    p.add_argument("ref")
    p = sub.add_parser("fill", help="fill inputs: REF VALUE [REF VALUE ...]")
    p.add_argument("page", type=int)
    p.add_argument("pairs", nargs="+")
    p = sub.add_parser("select", help="choose an option by its label in a select or combobox")
    p.add_argument("page", type=int)
    p.add_argument("ref")
    p.add_argument("option")
    p = sub.add_parser("type", help="type text with the keyboard provider, into REF or at the caret")
    p.add_argument("page", type=int)
    p.add_argument("text")
    p.add_argument("--ref")
    p = sub.add_parser("paste", help="paste text into an element through the clipboard provider")
    p.add_argument("page", type=int)
    p.add_argument("ref")
    p.add_argument("text")
    p = sub.add_parser("press", help="press a key, e.g. Enter or Control+A")
    p.add_argument("page", type=int)
    p.add_argument("key")
    p = sub.add_parser("scroll", help="scroll the page")
    p.add_argument("page", type=int)
    p.add_argument("direction", nargs="?", default="down", choices=["up", "down", "left", "right"])
    p.add_argument("--amount", type=float, default=3)
    p = sub.add_parser("wait", help="wait for text, a CSS selector or a number of milliseconds")
    p.add_argument("page", type=int)
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--text")
    group.add_argument("--selector")
    group.add_argument("--ms", type=int)
    p.add_argument("--timeout", type=int, default=10000)
    p = sub.add_parser("audit", help="show the action ledger")
    p.add_argument("--limit", type=int, default=30)
    p.add_argument("--failures", action="store_true")
    p.add_argument("--ambient", action="store_true", help="include ambient mouse moves")
    p.add_argument("--of", dest="of_agent", metavar="AGENT", help="only this agent's entries")
    p = sub.add_parser("trace", help="show one ledger event with its snapshot basis")
    p.add_argument("id")
    p = sub.add_parser("challenge", help="list or advance CAPTCHA challenge jobs")
    p.add_argument("action", nargs="?", default="list", choices=["list", "status", "ai_failed", "ai_resolved", "human_start", "cancel"])
    p.add_argument("id", nargs="?")
    p = sub.add_parser("activate", help="bring a tab to the front")
    p.add_argument("page", type=int)
    p = sub.add_parser("screenshot", help="save a screenshot of a tab (PNG)")
    p.add_argument("page", type=int)
    p.add_argument("-o", "--output", help="write the image here (default: keep it in Waymark's trace folder and print the path)")
    p.add_argument("--full", action="store_true", help="the whole page, not just the viewport")
    p.add_argument("--jpeg", action="store_true")
    sub.add_parser("whoami", help="show how Waymark identifies this CLI (agent, source, session)")
    p = sub.add_parser("name", help="name your session in the trace (optionally declare the agent)")
    p.add_argument("label")
    p.add_argument("--summary")
    p = sub.add_parser("agents", help="agents that used Waymark, with their sessions")
    p.add_argument("--days", type=int, default=30)
    p = sub.add_parser("sessions", help="agent sessions, newest first")
    p.add_argument("--days", type=int, default=30)
    p.add_argument("--of", dest="of_agent", metavar="AGENT", help="only this agent")
    p.add_argument("-q", "--query", help="search URLs, titles, errors")
    p = sub.add_parser("session", help="one session: its tabs and every step")
    p.add_argument("key", help="session key from `waymark sessions`")
    p.add_argument("--idle", action="store_true", help="include idle behaviour on its tabs")
    p = sub.add_parser("stats", help="statistics: work per agent, automation counts, token estimates, suggestions")
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--of", dest="of_agent", metavar="AGENT", help="only this agent")
    p = sub.add_parser("insights", help="only the improvement suggestions")
    p.add_argument("--days", type=int, default=30)
    p = sub.add_parser("usage", help="report model tokens your session spent (shown next to the estimates)")
    p.add_argument("--input", type=int, default=0, help="input tokens")
    p.add_argument("--output", type=int, default=0, help="output tokens")
    p.add_argument("--cost", type=float, help="cost in USD")
    p.add_argument("--model")
    p.add_argument("--task")
    for name, kind in (("manager", "agents"), ("dashboard", "insights")):
        p = sub.add_parser(name, help=f"open the {'agent manager' if kind == 'agents' else 'insights dashboard'} window")
        p.set_defaults(window_kind=kind)
    p = sub.add_parser("prune", help="delete trace entries older than N days (dry run unless --yes)")
    p.add_argument("--days", type=int, required=True)
    p.add_argument("--yes", action="store_true", help="really delete")
    p = sub.add_parser("cookies", help="export or import cookies (carry logins over from Chrome or another browser)")
    p.add_argument("action", choices=["export", "import"])
    p.add_argument("file", nargs="?", help="export: write JSON here (default stdout); import: read a JSON cookie array from here")
    p.add_argument("--from-cdp", metavar="URL", help="import straight from another Chromium's DevTools endpoint, e.g. http://127.0.0.1:9222")
    p.add_argument("--domain", action="append", help="only cookies for this domain and its subdomains (repeatable)")
    sub.add_parser("tools", help="list MCP tools exposed by the app")
    p = sub.add_parser("call", help="call any MCP tool with JSON arguments")
    p.add_argument("tool")
    p.add_argument("arguments", nargs="?", default="{}")
    p = sub.add_parser("mcp", help="stdio MCP bridge for clients without HTTP support")
    p.add_argument("--autostart", action="store_true", help="start the app if it is not running")
    return parser


def run(args: argparse.Namespace) -> int:
    command, as_json = args.command, args.json
    if command == "setup":
        app.setup(args.dir, args.ref, args.no_build)
        return 0
    if command == "start":
        return app.start(args.app_dir, args.port, args.foreground, args.timeout, args.url)
    if command == "stop":
        return app.stop()
    if command == "doctor":
        return app.doctor(args.app_dir, args.url)

    who = identity.detect(getattr(args, "agent", None), getattr(args, "session", None), getattr(args, "window", None))
    if command == "mcp":
        # The bridge speaks for the MCP client that spawned it: its clientInfo identifies it, unless --agent says otherwise.
        explicit = identity.detect(getattr(args, "agent", None), getattr(args, "session", None), getattr(args, "window", None), env={}, interactive=False)
        headers = explicit.headers() if explicit.agent or explicit.session or explicit.window else {}
        headers.pop("X-Waymark-Client", None)
        client = Client(args.url, headers=headers, stateless=False)
        def autostart() -> bool:
            # Keep startup and any child build tools off the JSON-RPC stdout stream.
            command = [sys.executable, "-m", "waymark_browser", "start", "--url", client.url]
            return subprocess.run(command, stdin=subprocess.DEVNULL, stdout=sys.stderr).returncode == 0

        return bridge.serve(client, on_down=autostart if args.autostart else None)
    client = Client(args.url, headers=who.headers())
    if command == "status":
        status = client.api("status")
        emit(status if as_json else show_status(status), as_json)
    elif command in ("pause", "resume"):
        result = client.api("control", {"paused": command == "pause"})
        emit(result if as_json else ("Automation paused; agents are refused until `waymark resume`." if result["paused"] else "Automation resumed."), as_json)
    elif command == "tabs":
        tabs = client.call("tabs", {"action": "list"})
        emit(tabs if as_json else show_tabs(tabs), as_json)
    elif command == "open":
        tab = client.call("tabs", {"action": "new", "url": args.target})
        emit(tab if as_json else f"Opened tab {tab['id']}: {tab.get('title')}\n{tab.get('url')}", as_json)
    elif command == "goto":
        emit(client.call("navigate", {"action": "url", "page": args.page, "url": args.target}), True)
    elif command in ("back", "forward", "reload"):
        emit(client.call("navigate", {"action": command, "page": args.page}), True)
    elif command == "close":
        emit(client.call("tabs", {"action": "close", "page": args.page}), True)
    elif command == "snapshot":
        snap = client.call("snapshot", {"page": args.page})
        emit(snap if as_json else snap["text"], as_json)
    elif command == "read":
        arguments = {"page": args.page, "format": "html" if args.html else "text"}
        if args.limit:
            arguments["limit"] = args.limit
        page = client.call("read", arguments)
        emit(page if as_json else page["text"] + ("\n[truncated]" if page.get("truncated") else ""), as_json)
    elif command in ("click", "hover"):
        emit(client.call("act", {"page": args.page, "kind": command, "ref": args.ref}), True)
    elif command == "fill":
        emit(client.call("act", {"page": args.page, "kind": "fill", "fields": parse_fields(args.pairs)}), True)
    elif command == "select":
        emit(client.call("act", {"page": args.page, "kind": "select", "ref": args.ref, "value": args.option}), True)
    elif command == "type":
        arguments = {"page": args.page, "kind": "type", "value": args.text}
        if args.ref:
            arguments["ref"] = args.ref
        emit(client.call("act", arguments), True)
    elif command == "paste":
        emit(client.call("act", {"page": args.page, "kind": "paste", "ref": args.ref, "value": args.text}), True)
    elif command == "press":
        emit(client.call("act", {"page": args.page, "kind": "press", "key": args.key}), True)
    elif command == "scroll":
        emit(client.call("act", {"page": args.page, "kind": "scroll", "direction": args.direction, "amount": args.amount}), True)
    elif command == "wait":
        kind, value = ("text", args.text) if args.text is not None else ("selector", args.selector) if args.selector is not None else ("time", args.ms)
        result = client.call("wait", {"page": args.page, "for": kind, "value": value, "timeout": args.timeout})
        emit(result, True)
        return 0 if result.get("matched") else 1
    elif command == "audit":
        query = f"audit/events?limit={args.limit}&ambient={1 if args.ambient else 0}" + ("&status=failure" if args.failures else "")
        if args.of_agent:
            query += f"&agent={args.of_agent}"
        events = client.api(query)
        emit(events if as_json else show_audit(events), as_json)
    elif command == "trace":
        emit(client.call("audit", {"action": "get", "id": args.id}), True)
    elif command == "challenge":
        arguments = {"action": args.action}
        if args.id:
            arguments["id"] = args.id
        emit(client.call("challenge", arguments), True)
    elif command == "activate":
        emit(client.call("tabs", {"action": "active", "page": args.page}), True)
    elif command == "screenshot":
        inline = bool(args.output)
        shot = client.call("screenshot", {"page": args.page, "fullPage": args.full, "format": "jpeg" if args.jpeg else "png", "inline": inline})
        if args.output:
            import base64
            with open(args.output, "wb") as handle:
                handle.write(base64.b64decode(shot.pop("base64")))
            shot["savedTo"] = args.output
        emit(shot if as_json else f"Saved {shot.get('savedTo') or shot.get('path')} ({shot.get('bytes')} bytes)", as_json)
    elif command == "whoami":
        server_view = client.call("whoami")
        local = {"agent": who.agent, "source": who.source, "session": who.session, "window": who.window}
        result = {"waymark": server_view, "cli": local}
        emit(result if as_json else f"agent    {server_view.get('label')} ({server_view.get('agent')}, identified by {server_view.get('identifiedBy')})\n"
             f"session  {server_view.get('session') or '-'}{' / ' + server_view['sessionLabel'] if server_view.get('sessionLabel') else ''}\n"
             f"window   {server_view.get('window') or '-'}" + (f"\nhint     {server_view['hint']}" if server_view.get("hint") else ""), as_json)
    elif command == "name":
        arguments = {"name": args.label}
        if args.summary:
            arguments["summary"] = args.summary
        emit(client.call("name_session", arguments), True)
    elif command in ("agents", "sessions"):
        query = f"agents?days={args.days}"
        if command == "sessions" and args.query:
            from urllib.parse import quote
            query += "&q=" + quote(args.query)
        tree = client.api(query)
        if as_json:
            emit(tree if command == "agents" else [s for a in tree["agents"] if not args.of_agent or a["agent"] == args.of_agent for s in a["sessions"]], True)
        else:
            emit(show_agents(tree) if command == "agents" else show_sessions(tree, args.of_agent), False)
    elif command == "session":
        from urllib.parse import quote
        detail = client.api(f"sessions/{quote(args.key, safe='')}" + ("?idle=1" if args.idle else ""))
        emit(detail if as_json else show_session(detail), as_json)
    elif command in ("stats", "insights"):
        query = f"insights?days={args.days}"
        if command == "stats" and args.of_agent:
            query += f"&agent={args.of_agent}"
        report = client.api(query)
        if as_json:
            emit(report if command == "stats" else report["recommendations"], True)
        else:
            emit(show_stats(report, suggestions_only=command == "insights"), False)
    elif command == "usage":
        arguments = {"inputTokens": args.input, "outputTokens": args.output}
        for key, value in (("costUsd", args.cost), ("model", args.model), ("task", args.task)):
            if value is not None:
                arguments[key] = value
        emit(client.call("report_usage", arguments), True)
    elif command in ("manager", "dashboard"):
        result = client.api("windows", {"kind": args.window_kind})
        if not result.get("opened"):
            import webbrowser
            webbrowser.open(result["url"])
        emit(result if as_json else f"Opened {result['url']}", as_json)
    elif command == "prune":
        result = client.api("audit/prune", {"days": args.days, "dryRun": not args.yes})
        if as_json:
            emit(result, True)
        else:
            verb = "Would remove" if result["dryRun"] else "Removed"
            emit(f"{verb} {result['removed']} entries older than {result['cutoff'][:10]}, {result['snapshotsRemoved']} snapshots and {result['screenshotsRemoved']} screenshots; {result['kept']} entries kept."
                 + ("\nRun again with --yes to delete." if result["dryRun"] else ""), False)
    elif command == "cookies":
        arguments: dict = {"action": args.action}
        if args.domain:
            arguments["domains"] = args.domain
        if args.action == "export":
            result = client.call("cookies", arguments)
            if args.file:
                with open(args.file, "w", encoding="utf-8") as handle:
                    json.dump(result["cookies"], handle, ensure_ascii=False, indent=2)
                emit(result if as_json else f"Exported {result['count']} cookies to {args.file}", as_json)
            else:
                emit(result["cookies"], True)
        else:
            if args.from_cdp:
                arguments["fromCdp"] = args.from_cdp
            elif args.file:
                with open(args.file, encoding="utf-8") as handle:
                    data = json.load(handle)
                arguments["cookies"] = data.get("cookies", data) if isinstance(data, dict) else data
            else:
                raise SystemExit("cookies import needs a JSON file or --from-cdp URL")
            result = client.call("cookies", arguments)
            emit(result if as_json else f"Imported {result['imported']} cookies for {', '.join(result['domains']) or 'no domains'}", as_json)
    elif command == "tools":
        tools = client.tools()
        emit(tools if as_json else "\n".join(f"{tool['name']:<14} {tool.get('description', '')}" for tool in tools), as_json)
    elif command == "call":
        try:
            arguments = json.loads(args.arguments)
        except json.JSONDecodeError as error:
            raise SystemExit(f"Arguments must be JSON: {error}")
        emit(client.call(args.tool, arguments), True)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 0
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        # MCP over stdio is UTF-8 by spec; page titles are often non-ASCII on Windows consoles too.
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    try:
        return run(args)
    except WaymarkError as error:
        print(f"waymark: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
