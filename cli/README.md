# waymark-browser

Command-line companion for **[Waymark](https://github.com/guangxiangdebizi/waymark-browser)**, an open-source desktop browser that AI agents and people use together. Waymark gives agents an MCP endpoint, keeps their clipboard and pointer isolated from your desktop, routes CAPTCHAs through local OCR → AI → human hand-off, and records every action with the page snapshot it was based on.

This package installs and runs the desktop app, drives it from your terminal, and bridges it to MCP clients that only speak stdio. It has no Python dependencies.

```bash
pip install waymark-browser            # CLI only
pip install "waymark-browser[ocr]"     # plus local ddddocr for text CAPTCHAs
```

Waymark itself is an Electron app, so you also need **Node.js 22+**.

The desktop interface supports English (default), Simplified Chinese, Japanese, Korean, Spanish, French, German and Portuguese. Choose **Settings → Language** in the app, or use the selector on the start or audit page. The choice persists across restarts. CLI commands, diagnostics and MCP fields remain in English.

## Quick start

```bash
waymark setup        # download and build the app into ~/.waymark/app
waymark start        # open the browser window; MCP at http://127.0.0.1:9510/mcp
waymark doctor       # check Node.js, the install and the connection
```

On a Linux server without a display, use `xvfb-run -a waymark start --foreground`.

## Connect an AI agent

Claude Code (HTTP):

```bash
claude mcp add --transport http waymark http://127.0.0.1:9510/mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.waymark]
url = "http://127.0.0.1:9510/mcp"
```

Clients that only support stdio:

```json
{ "mcpServers": { "waymark": { "command": "waymark", "args": ["mcp", "--autostart"] } } }
```

## Drive the browser from the terminal

```bash
waymark open https://example.com     # -> Opened tab 2
waymark snapshot 2                   # interactive elements with refs e1, e2, ...
waymark fill 2 e4 "noise cancelling headphones"
waymark press 2 Enter
waymark read 2 --limit 2000          # visible text (or --html for the rendered DOM)
waymark audit --limit 20             # what happened, when, on which page
waymark pause / waymark resume       # take the browser back from agents
```

### Who is driving

Every command tells Waymark who ran it, so the trace can be read per agent. `--agent NAME` (or `WAYMARK_AGENT`) says it
explicitly; otherwise the CLI recognises the agent from its own environment (`AI_AGENT`, `CLAUDECODE`, `CODEX_*`,
`WORKBUDDY_*`, `CURSOR_AGENT`, ...) and reports `human` when run in an interactive terminal. `--session` /
`WAYMARK_SESSION` groups commands into one session (an agent's own session id is used when it exports one), and
`--window` / `WAYMARK_WINDOW` labels the window or worker. Nothing is guessed: with no marker and no terminal the agent
is `unknown`. Check with `waymark whoami`. Details: [docs/provenance.md](../docs/provenance.md).

```bash
export WAYMARK_AGENT=codex WAYMARK_SESSION=refund-batch-7 WAYMARK_WINDOW="codex #2"
waymark open https://example.com
waymark sessions --of codex          # this session, with its tabs and steps
waymark session s:refund-batch-7     # every step, with errors
waymark stats --days 7               # ddddocr runs, pointer paths, tokens, suggestions
```

All commands accept `--json` for machine-readable output and `--url` (or `WAYMARK_URL`) to target another instance. `waymark call TOOL '{"json": "args"}'` reaches any MCP tool directly.

| Command | What it does |
|---|---|
| `setup [--dir] [--ref]` | Download the app source for this CLI's version and build it |
| `start [--port] [--foreground]` / `stop` | Run the desktop app in the background or attached |
| `status`, `doctor` | Automation state, pending challenges; environment checks |
| `tabs`, `open`, `goto`, `back`, `forward`, `reload`, `close` | Tabs and navigation |
| `snapshot`, `read`, `click`, `hover`, `fill`, `paste`, `press`, `scroll`, `wait` | Page actions by snapshot ref |
| `audit`, `trace ID` | Action ledger and the snapshot behind one action |
| `challenge [action] [id]` | Inspect or advance CAPTCHA jobs |
| `pause`, `resume` | User control lease: agents are refused while paused |
| `activate PAGE`, `screenshot PAGE [-o FILE] [--full]` | Bring a tab to the front; save a screenshot |
| `whoami`, `name LABEL` | How Waymark identifies you; name your session in the trace |
| `agents`, `sessions [--of AGENT] [-q TEXT]`, `session KEY` | Which agents used Waymark, their sessions, and every step of one session |
| `stats [--days N] [--of AGENT]`, `insights` | Statistics and improvement suggestions |
| `usage --input N --output N [--model M]` | Report the model tokens your session spent |
| `manager`, `dashboard` | Open the agent manager or the insights window |
| `prune --days N [--yes]` | Delete trace entries older than N days (dry run without `--yes`) |
| `mcp [--autostart]` | stdio MCP bridge |
| `tools`, `call` | Raw MCP access |

## 中文说明

`waymark-browser` 是开源 AI 浏览器 Waymark 的命令行工具：一条命令安装并启动浏览器、在终端里打开网页/点击/填写/选择/截图/读取、查看每个 agent（Claude Code、Codex、WorkBuddy……）在哪些会话和标签页里做了什么（`waymark agents / sessions / session`）、查看统计与改进建议（`waymark stats`），并为只支持 stdio 的 MCP 客户端提供桥接。所有命令都支持 `--json`，方便 agent 调用。安装 `waymark-browser[ocr]` 可启用本地 ddddocr 识别文字验证码。需要 Node.js 22 及以上。

License: MIT
