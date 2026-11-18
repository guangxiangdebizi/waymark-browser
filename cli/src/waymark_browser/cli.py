"""`waymark` command line."""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from typing import Any

from . import __version__, app, bridge
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


def parse_fields(values: list[str]) -> list[dict]:
    if len(values) % 2:
        raise SystemExit("fill expects REF VALUE pairs, e.g. waymark fill 3 e4 hello e5 world")
    return [{"ref": values[index], "value": values[index + 1]} for index in range(0, len(values), 2)]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="waymark", description="Drive Waymark, the open-source browser for AI agents, from the terminal.")
    parser.add_argument("--url", help="Waymark base URL (default $WAYMARK_URL or http://127.0.0.1:9510)")
    parser.add_argument("--json", action="store_true", help="print raw JSON")
    parser.add_argument("--version", action="version", version=f"waymark-browser {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="COMMAND")
    # Accept --json/--url after the subcommand too (`waymark audit --json`); SUPPRESS keeps the global value otherwise.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="print raw JSON")
    common.add_argument("--url", default=argparse.SUPPRESS, help="Waymark base URL")
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
    p = sub.add_parser("trace", help="show one ledger event with its snapshot basis")
    p.add_argument("id")
    p = sub.add_parser("challenge", help="list or advance CAPTCHA challenge jobs")
    p.add_argument("action", nargs="?", default="list", choices=["list", "status", "ai_failed", "ai_resolved", "human_start", "cancel"])
    p.add_argument("id", nargs="?")
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

    client = Client(args.url)
    if command == "mcp":
        on_down = (lambda: app.start(None, None, False, 120, args.url) == 0) if args.autostart else None
        return bridge.serve(client, on_down=on_down)
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
        events = client.api(query)
        emit(events if as_json else show_audit(events), as_json)
    elif command == "trace":
        emit(client.call("audit", {"action": "get", "id": args.id}), True)
    elif command == "challenge":
        arguments = {"action": args.action}
        if args.id:
            arguments["id"] = args.id
        emit(client.call("challenge", arguments), True)
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
