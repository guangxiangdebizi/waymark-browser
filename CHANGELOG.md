# Changelog

## v0.4.0 — human-paced input and the AgentShield benchmark

- **Keyboard slot.** Typing is a capability slot like the pointer. The new default `action.keyboard.human` holds each key for a human-like time (median 105 ms), varies the gap between keys, pauses at word breaks, and now and then mistypes a neighbouring key and corrects it. Text such as Chinese goes through the input method. `action.keyboard.fast` keeps the old behaviour, and plugins can fill the slot. Tune timing with `browser.typing`.
- **`select` and `type` actions.** `act` can pick an option by its label in a native `<select>` or a custom combobox, and type at the caret or into a ref. `fill` now handles each control by type: text is typed, selects are chosen, checkboxes and radios toggled, date-like inputs set. Locating an element times out after 5 s (`browser.actionTimeoutMs`) instead of 30 s, with an error that says what to do next. `press` rejects text and points to `type`.
- **Actions report what changed.** Every `act` result lists the elements that appeared (with refs), disappeared or changed state, or the full snapshot after a navigation, so agents need far fewer snapshot round trips. Refs stay stable while their element exists; navigation invalidates them.
- **Richer snapshots.** Labels (from `<label>` and `aria-labelledby`), selected option and available options of selects, checked state, and filled or empty for inputs. Values are never included.
- **Only what a person can see.** Snapshots leave out elements that are transparent, clipped away by an `overflow: hidden` ancestor or zero-size, including hidden honeypot fields. Waiting for a page to settle now also waits for CSS animations to finish.
- **Pages stay visible.** A covered, minimized or locked window no longer demotes its pages to hidden. Before, such pages reported `visibilityState=hidden`, stopped receiving pointer movement and dropped keystrokes.
- **Ambient pointer follows the agent and keeps going.** It moves on the tab the agent last operated, not the most recently opened tab. A movement that gets no answer from the page is abandoned after 8 s instead of stopping ambient movement for the rest of the session, and each ledger entry records the page's visibility state.
- **CLI.** `waymark select PAGE REF OPTION` and `waymark type PAGE TEXT [--ref REF]`.
- **AgentShield benchmark.** Same model, same forms, same detector: browser-use against Waymark on the IEEE S&P 2027 AgentShield behavioural detector. See [docs/benchmark-agentshield.md](docs/benchmark-agentshield.md) and `benchmarks/agentshield/`.

## v0.3.0 — multilingual interface

- English is the default interface language. Added Simplified Chinese, Japanese, Korean, Spanish, French, German and Portuguese.
- Language selection in Settings, the start page and the audit page is saved locally and shared across app surfaces, including native context menus.
- Localized navigation, status messages, activity descriptions, challenge handling, dates and audit controls. Website content, user input and raw records stay unchanged; CLI and MCP identifiers remain in English.
- The English README uses new screenshots captured from the running app and bundled local demos. Chinese screenshots are retained in the Chinese README.
- Added eight-language switching, restart-persistence, responsive audit-page and translation-completeness tests.

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
