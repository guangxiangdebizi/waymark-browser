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
| `mcp [--autostart]` | stdio MCP bridge |
| `tools`, `call` | Raw MCP access |

## 中文说明

`waymark-browser` 是开源 AI 浏览器 Waymark 的命令行工具：一条命令安装并启动浏览器、在终端里打开网页/点击/填写/读取、查看 AI 的每一步操作记录，并为只支持 stdio 的 MCP 客户端提供桥接。安装 `waymark-browser[ocr]` 可启用本地 ddddocr 识别文字验证码。需要 Node.js 22 及以上。

License: MIT
