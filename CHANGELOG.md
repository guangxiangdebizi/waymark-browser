# Changelog

## v0.2.0 — first public release

- Closing the active tab selects a remaining tab for automation and ambient pointer input.
- The CLI installer refuses to replace unrelated non-empty directories or Git checkouts.
- **Waymark** is the new name of the project, previously an internal prototype called Agent Browser. `AGENT_BROWSER_*` environment variables are still honoured.
- **Desktop shell rebuilt.** Chrome-style tabs (drag to reorder, middle-click close, context menu), back/forward/reload/home, omnibox with search, page context menu and keyboard shortcuts.
- **Fixed the dead toolbar.** The sandboxed preload is now CommonJS, and the shell no longer uses inline handlers that CSP blocks.
- **AI side panel.** Live activity timeline in plain language with snapshot drill-down, CAPTCHA jobs (local OCR → AI → you), and settings.
- **Pause AI.** A user control lease: while paused, every agent read, write and tab operation is refused.
- **Capability slots and plugins.** Pointer movement, CAPTCHA/OCR and clipboard can each be replaced by a JS module or an external process (any language). Includes example minimum-jerk and WindMouse pointer models and an OCR solver. Providers can be switched at runtime, and the ledger records which one ran.
- **New pages.** A start page at `/home`, and a searchable, filterable audit ledger at `/audit`.
- **`waymark-browser` on PyPI.** Zero-dependency CLI: `setup`, `start`, `stop`, `doctor`, page actions, `audit`, `pause` / `resume`, and a stdio MCP bridge (`waymark mcp`).
- **Security.** Cockpit write APIs refuse cross-origin and non-JSON requests, and local cockpit pages are never treated as CAPTCHA challenges.
- **Bug fix.** Element names in snapshots no longer lose every letter "s" (an unescaped `\s` inside a page script).
- Runs on Windows, macOS and Linux. Pages fill the window instead of a fixed 1280×800 viewport, and minimizing no longer collapses the automation viewport.
- The audit log keeps recent events in memory, so the cockpit no longer re-reads the whole ledger on every poll.
