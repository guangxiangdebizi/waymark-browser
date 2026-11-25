# Agent provenance, the agent manager and insights

Waymark is shared by many agents at once: several Claude Code windows, a Codex session, WorkBuddy, a script, and you.
Every ledger entry records **who** drove the step, so you can see which agent, from which of its windows, did what in
which tabs, and what it cost.

## Who is who

Each step carries an `actor`:

| Field | Meaning |
|---|---|
| `agent` | `claude-code`, `codex`, `workbuddy`, `codebuddy`, `cursor`, `gemini-cli`, `human`, `waymark` (Waymark's own idle behaviour), a declared name, or `unknown` |
| `source` | How it was identified (below). Shown next to every agent and session in the manager |
| `session` | The agent's own session: one conversation / terminal window |
| `window` | A free label for the agent's window or worker, e.g. `codex #2` |
| `client` | The MCP clientInfo name and version, when the client sent one |
| `call`, `tool` | The MCP tool call that wrote the step; all entries of one call share it |

Identification never guesses. In order of precedence:

1. **`declared`**: the caller named itself: an `X-Waymark-Agent` header, `?agent=NAME` on the MCP URL, `name_session` with `agent`, or the CLI's `--agent` / `WAYMARK_AGENT`.
2. **`mcp-client`**: the `clientInfo` an MCP client sends in `initialize`. Claude Code sends `claude-code`, Codex `codex-mcp-client`. Each client that initializes gets its own MCP session (`Mcp-Session-Id`), so two windows of the same agent stay apart.
3. **`env`**: the Waymark CLI found the agent's own marker in its environment: `AI_AGENT`, `CLAUDECODE` / `CLAUDE_CODE_SESSION_ID`, `CODEX_*`, `WORKBUDDY_*`, `CODEBUDDY_*`, `CURSOR_AGENT`, `GEMINI_CLI`. The agent's own session id is used when it exports one.
4. **`user-agent`**: the HTTP User-Agent names a known agent.
5. **`tty`**: the CLI ran in an interactive terminal with no agent marker: a person.
6. **`local-ui`**: a click in Waymark's own window or pages (pause, settings, challenge hand-off).
7. **`unknown`**: nothing identified the caller. The manager shows how to fix it.

To make an agent unambiguous, give it a name in its MCP config:

```bash
claude mcp add --transport http waymark "http://127.0.0.1:9510/mcp?agent=claude-code&window=main"
```

```toml
# ~/.codex/config.toml
[mcp_servers.waymark]
url = "http://127.0.0.1:9510/mcp?agent=codex"
```

or declare it once per session: `name_session { name: "Weekly report", agent: "workbuddy", window: "WB-2" }`.

**Sessions.** Declared and MCP sessions keep their id. Steps of an agent that has no session id are grouped by the name
it gave with `name_session`, otherwise split where the agent was idle for more than 30 minutes; those sessions are
marked *inferred*.

**Tabs.** A tab is `(run, pageId)`: page ids restart every launch. The manager shows which session opened a tab and
which only used it. In the browser window, a tab an agent opened is badged with that agent's name instead of "AI".

## The agent manager (`/agents`, Ctrl+Shift+M)

A separate window (or `http://127.0.0.1:9510/agents` in any browser, or `waymark manager`):

- **Agents**: every agent seen in the period, how it was identified, sessions, actions, failures, last activity, and which agents are working right now.
- **Sessions**: newest first, with the agent's window, duration, steps, tabs, failures and sites.
- **Trace**: the session's tabs (opened here or reused), then every step in order with the tool call behind it, its duration, the page before and after, the error if any, a screenshot of the page after the step, and the snapshot the agent acted on with the targeted element highlighted. Filter by tab, show only failures, or include the idle behaviour Waymark ran on those tabs.
- Search across URLs, titles, errors, session names and windows.

## Insights (`/insights`, Ctrl+Shift+D)

A dashboard for people (`waymark dashboard`, or `waymark stats` in the terminal):

- **Headline**: AI steps, action success rate, browser I/O tokens (estimate), tokens Waymark saved (estimate).
- **What Waymark did for the agents**: ddddocr runs and success rate, human pointer paths and clicks, human-typed characters, idle behaviour (moves, scrolls, visits), reaction time added by pacing, CAPTCHAs and bot walls met, hand-offs to you, isolated pastes, trace screenshots.
- **AI steps per day** by agent, and **when agents work** (weekday × hour).
- **Suggestions** with evidence links into the manager: agents or sites with high failure rates, stale refs, snapshots of unchanged pages (and the tokens they cost), URLs and step sequences that recur (candidates for a cache, script or skill), slow sites, CAPTCHA hot spots, oversized reads, very long sessions, time dominated by agent thinking, unidentified agents, CAPTCHAs solved locally.
- **Agents compared**: sessions, actions, success, steps per session, minutes per session, tokens per session.
- **Savings and spend**, **where the time goes** (agent thinking between calls, browser execution, waiting, pacing), **tool calls**, **failures by cause**, **repetition**, **sites** (opens, failures, load p50/p90, challenges, agents).

### What is measured and what is estimated

Measured from the ledger: counts, durations, failures, characters sent to and from the agent in every tool call,
read truncation, snapshot sizes, OCR outcomes, pointer paths and keystrokes Waymark executed.

Estimated (marked *Estimate*, with the formula next to it): tokens (characters ÷ `charsPerToken`), tokens an agent
would spend solving a CAPTCHA itself, tokens saved because actions return a diff instead of a new snapshot, and tokens
saved by text snapshots versus screenshots. Agents can report their real usage with the `report_usage` tool or
`waymark usage --input N --output N`; reported numbers are shown beside the estimates.

The assumptions live in the config's `insights` section:

```json
"insights": {
  "charsPerToken": 4, "screenshotTokens": 1600, "captchaTokensPerAttempt": 1500, "captchaAttemptsWithoutOcr": 2,
  "humanSecondsPerCaptcha": 20, "sessionGapMinutes": 30, "thinkCapSeconds": 300, "slowNavigateMs": 5000, "repeatThreshold": 3
}
```

### Adding a metric or a suggestion

`src/insights/Insights.ts` keeps metrics in a registry and suggestions as rules:

```ts
import { registerMetric, RULES } from './insights/Insights.js';
registerMetric({ id: 'pdfDownloads', group: 'activity', unit: 'count', compute: ctx => ctx.events.filter(e => e.action === 'download').length });
RULES.push((ctx, report) => report.metric('pdfDownloads') > 50 ? [{ id: 'many_pdfs', severity: 'info', params: { count: report.metric('pdfDownloads') } }] : []);
```

Every metric appears in `/api/insights`, the MCP `stats` tool and `waymark stats --json`.

## Privacy and retention

- Everything stays on this computer. Nothing is uploaded.
- Fill values, typed text, pasted text and OCR answers never enter the ledger; only their length does. Password values never enter snapshots. Tool-call summaries keep argument names, refs and URL paths, never values.
- Credential-like URL parameters (`token`, `password`, `code`, `sig`, `session`, `api_key`, ...) are replaced by `***` in the ledger, including OAuth fragments. Turn off with `audit.redactUrls: false`.
- Screenshots are small JPEGs under `<audit dir>/screens/`, deleted after `audit.screenshotRetentionDays` (default 14). Turn them off with `audit.captureScreenshots: false`.
- `audit.retentionDays` (default 0 = keep) removes older ledger entries at startup. `waymark prune --days N` shows what would be removed and deletes with `--yes`; the ledger is rewritten through a temporary file, so an interruption never corrupts it.

## APIs

| Endpoint | |
|---|---|
| `GET /api/agents?days=&q=` | Agents with their sessions |
| `GET /api/sessions/:key?idle=1` | One session: tabs and timeline |
| `GET /api/insights?days=&agent=&session=` | The full statistics report |
| `GET /api/identity` | How Waymark identifies the caller |
| `GET /api/audit/events?agent=&session=&calls=1` | Ledger entries, filterable by agent and session |
| `GET /api/audit/screens/:file` | A trace screenshot |
| `POST /api/audit/prune {days, dryRun}` | Retention (dry run by default) |
| `POST /api/windows {kind: "agents" | "insights"}` | Open the manager or dashboard window |

MCP tools: `whoami`, `name_session` (with `agent`, `window`), `report_usage`, `stats`, `screenshot`, `audit`.
