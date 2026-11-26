# Plugins: swap any step of the automation layer

Waymark keeps low-level work on the browser side, and each step of that work is a **capability slot** you can fill with your own implementation:

| Slot | Built-in | Config key | Plugin shape |
|---|---|---|---|
| `pointer` | `action.pointer.bezier` | `capabilities.pointer` | trajectory model (below) |
| `keyboard` | `action.keyboard.human` (default), `action.keyboard.fast` | `capabilities.keyboard` | `type(page, text)` / `invoke({ page, text })` |
| `pacing` | `action.pacing.human` (default), `action.pacing.off` | `capabilities.pacing` | `delay(context)` → ms |
| `idle` | `idle.adaptive` (default), `idle.drift` | `capabilities.idle` | `plan(scene)` → steps |
| `ocr` | `challenge.ocr.ddddocr` | `capabilities.challengeOcr` | image in, text out |
| `clipboard` | `action.clipboard.virtual`, `action.clipboard.system` | `capabilities.clipboard` | `read` / `write` / `invoke({ page, text })` / `clear` |

Plugins are JavaScript modules or separate processes in any language, such as a Python model trained on your own data. Pick the active provider of each slot in the side panel (**设置 → 可插拔能力**), in config, or with `POST /api/settings {"slots": {"pointer": "...", "ocr": "..."}}`.

## Pointer model contract

A pointer model computes a path. It never touches the page. Waymark sends it a request:

```json
{ "from": { "x": 12, "y": 40 }, "to": { "x": 640, "y": 380 },
  "viewport": { "width": 1280, "height": 800 }, "purpose": "click" }
```

`purpose` is `click`, `hover` or `ambient` (idle wandering, which never clicks). The model returns samples:

```json
[ { "x": 30.5, "y": 51.2, "dt": 9 }, { "x": 58.1, "y": 70.4, "dt": 8 }, ... ]
```

- `dt` is the pause in milliseconds before the next sample. It is clamped to 0–250.
- At most 2000 samples are accepted. Waymark always finishes exactly on the target.
- For clicks, `pressMs` sets the button hold time (0–400 ms).
- If a model throws, times out or returns invalid points, Waymark logs a warning and uses the built-in Bézier path, so the agent's action still succeeds.

Waymark replays the samples through its own input pipeline. Events go only to the target tab, never to your desktop cursor. Every ledger entry records the model `id` and `version` that produced the input.

## JavaScript module

```js
// my-pointer.mjs
export default {
  manifest: { id: 'action.pointer.my-model', version: '1.0.0', description: 'What it does' },
  trajectory({ from, to, viewport, purpose }) {
    return [/* { x, y, dt } */];
  },
  pressMs: () => 80              // optional
};
```

A module can also export an array of models, or a factory `({ config }) => model | model[]`. Factories may be async, which suits loading weights. If a module exports a full `CapabilityProvider` (`{ manifest, invoke }`), it is registered as-is. See [`examples/plugins/pointer-minimum-jerk.mjs`](../examples/plugins/pointer-minimum-jerk.mjs).

## External process (Python or any other language)

The process reads one JSON request per line on stdin. It answers with one JSON line on stdout, echoing the request `id`:

```json
{ "id": 7, "points": [ { "x": 1, "y": 2, "dt": 8 } ], "pressMs": 70 }
```

Reply `{ "id": 7, "error": "..." }` to fail that request. The process starts on first use and is reused afterwards. Each request times out after `timeoutMs` (default 2000). Stderr goes to the app log. See [`examples/plugins/pointer_model.py`](../examples/plugins/pointer_model.py).

## Enabling plugins

Add them to `data/electron-settings.json` (per machine) or `config/electron.json` (shipped defaults):

```json
{
  "capabilities": {
    "plugins": [
      { "module": "./examples/plugins/pointer-minimum-jerk.mjs" },
      { "id": "action.pointer.windmouse", "command": ["python", "examples/plugins/pointer_model.py"],
        "description": "WindMouse path from a Python process", "timeoutMs": 2000 }
    ],
    "pointer": "action.pointer.minimum-jerk"
  }
}
```

Restart the app. New providers appear under **设置 → 可插拔能力** in the side panel and are listed by the MCP `capabilities` tool. Choose one there, or call:

```bash
curl -X POST -H "content-type: application/json" -d '{"slots":{"pointer":"action.pointer.windmouse"}}' http://127.0.0.1:9510/api/settings
```

The choice is saved to the settings file.

## CAPTCHA / OCR solver

An `ocr` provider receives the cropped challenge image (PNG) and returns the answer. The browser types the answer itself. The answer never reaches the model context, and the ledger records only its length.

- **JS module**: export a provider `{ manifest: { id, version, kind: 'challenge', runtime: 'node', dataEgress: 'local-only', description }, invoke(png) => ({ text }) }`.
- **Process**: add `"kind": "ocr"` to a `command` plugin. Requests are `{"id": 3, "image": "<base64 PNG>"}` and replies are `{"id": 3, "text": "A7B2"}`. See [`examples/plugins/ocr_solver.py`](../examples/plugins/ocr_solver.py), which runs ddddocr's beta model and is easy to swap for your own engine.

Answers longer than 128 characters are rejected. If the solver fails, the challenge moves on to the AI step, exactly as when the built-in OCR fails.

```json
{ "capabilities": {
    "plugins": [{ "id": "challenge.ocr.ddddocr-beta", "kind": "ocr", "command": ["python", "examples/plugins/ocr_solver.py"] }],
    "challengeOcr": "challenge.ocr.ddddocr-beta" } }
```

### Sliders, ordered clicks and animated images

These challenges need more than one still image in and one string out. Waymark takes the frames (before and while
holding a slider handle, or over a few seconds for a prompt that plays), and asks the provider through
`vision(op, payload)`; it does the pointer work itself. The built-in ddddocr worker implements all four operations. A
JS module provider that implements `vision` takes them over; a provider without it reads text only, and these
challenges go to the AI step. Images are base64 PNGs, coordinates are image pixels.

| `op` | Input | Output |
|---|---|---|
| `classify_frames` | `frames`: one image over time (characters blinking in one by one) | `text` read from all frames merged into one |
| `reveal` | `before`, `frames`: the slider image before and while the handle is held | `regions`: what the press revealed (piece, gap) as `{x, y, w, h, area}` |
| `slide_match` | `piece`, `background` | `target`: where the piece fits |
| `click_plan` | `frames`, `times`, `canvas` and `prompt` regions, optional `tokens` (targets the page spells out) and `exclude` (the instruction text) | `points` to click, in order |

`click_plan` in the built-in worker: a prompt that plays is split into its items in order, starting after the longest
pause, so sampling that began mid-cycle still gets the order right; a still prompt is split by the detector. Each
item is matched to a detected character by its text first, then searched for by shape at several sizes and slight
rotations, then by the closest detected shape.

## Keyboard provider

A `keyboard` provider enters text at the caret of the focused control. `fill`, `type` and the text part of every form action go through it. Export an object with a `manifest` (kind `action`) and `type(page, text)`, plus `invoke({ page, text })` calling the same thing. It appears in the keyboard slot automatically.

The built-in `action.keyboard.human` presses each key for a log-normal hold time (median 105 ms), waits a log-normal gap between keys (median 120 ms) with longer pauses at word breaks and occasional thinking pauses, mistypes a neighbouring key about 2% of the time and corrects it with Backspace, and enters non-ASCII text such as Chinese through the input method rather than as individual keys. Tune it with `browser.typing` in the config:

```json
{ "browser": { "typing": { "dwellMedianMs": 105, "gapMedianMs": 120, "typoChance": 0.02 } } }
```

`action.keyboard.fast` is the pre-0.4 behaviour (instant key presses 8 ms apart). It is quicker, and much easier to tell apart from a person; see [the AgentShield benchmark](benchmark-agentshield.md).

## Pacing model

Before each agent step starts, the pacing model returns how long to wait. Export `{ manifest, delay(context) }`; it appears in the pacing slot automatically. Waymark clamps the answer to 0–8000 ms, writes it to the ledger entry as `pacedMs`, and treats a model that throws as 0 ms, so pacing never blocks the agent.

`context` never contains the page:

| Field | Meaning |
|---|---|
| `kind` | the `act` kind (`click`, `fill`, `type`, `select`, …), `navigate`, or `field` for the pause between fields of one `fill` |
| `sinceObservedMs` | time since the agent received this page's state (the result of its previous call) |
| `shownLines` | lines the agent was shown in that result, a rough measure of how much a person would read |
| `commit` | the target looks like a commit step: submit, next, confirm, pay, sign in |
| `index` | field position within a `fill` |

The built-in `action.pacing.human` adds what a person would need: a log-normal reaction per kind (about 0.85 s before a click, 1 s before a fill), 90 ms reading time per line shown (capped at 2.2 s), 0.3–0.9 s extra before a commit step and about 0.5 s between fields. It subtracts the time the agent already spent, so an LLM that takes several seconds per step waits for nothing and a fast one is slowed to a human pace. Tune it with `browser.pacing`:

```json
{ "browser": { "pacing": { "reactionMs": { "click": 700 }, "readPerLineMs": 60, "fieldGapMs": 400 } } }
```

`action.pacing.off` starts every step immediately (the pre-0.5 behaviour). See [`examples/plugins/pacing-fixed.mjs`](../examples/plugins/pacing-fixed.mjs).

## Idle planner

While the agent thinks, the idle planner decides what the pointer does. Export `{ manifest, plan(scene) }` returning a list of steps; it appears in the idle slot automatically. The **自主鼠标游走** switch turns idle behaviour on and off; this slot decides what it does.

`scene` describes the page without exposing it: viewport and pointer position, `sinceAgentMs`, scroll position, `spots` (points on plain background or text with nothing interactive under them), `text` (visible text blocks), `fresh` (elements that appeared in the agent's last result), `links` (same-origin links that can be visited and returned from) and `allow`, which says whether the page allows idle clicks, scrolls and visits right now and why not.

Steps:

```json
[{ "type": "move", "x": 400, "y": 300 }, { "type": "pause", "ms": 600 }, { "type": "click", "x": 400, "y": 300 },
 { "type": "scroll", "dy": 240 }, { "type": "visit", "link": 0, "dwellMs": 2500 }]
```

Waymark runs the steps through the pointer slot and checks each one again before running it: a click only lands on page background, a visit only follows a link that is still under the pointer and not a risky one (sign out, delete, pay, submit, download and similar). The page decides what is allowed. Pages that look like part of a flow (checkout, sign-in, applications, appointments, payments), sites listed in `browser.ambientMouse.protectedSites`, pages the agent is waiting on and pages with unsaved input, sensitive fields, an open popup or a focused field are never left. Flow pages, protected sites, open popups and focused fields get no idle clicks either.

Whatever the planner did is undone before the agent's next call. A call that arrives mid-step interrupts it, waits until the page is back, and then runs. A visit goes back to the page the agent left: from the back/forward cache with every field and ref intact, or rebuilt with the agent's refs stamped again. If a page cannot be brought back intact, its origin is never visited from again in that session. Ledger entries are `mouse.ambient` (pointer only), `idle.click`, `idle.scroll` and `idle.visit`, with the steps taken and how the page was restored; they are kept out of the agent's activity counts.

The built-in `idle.adaptive` looks at what just appeared, sweeps the pointer along text as if reading, rests, clicks empty page, scrolls a little and back, and now and then (at most once every 45 s) opens a link for a few seconds. After two minutes without an agent call it only drifts now and then. `idle.drift` is the pre-0.5 behaviour: the pointer drifts over page background and never clicks. See [`examples/plugins/idle-reader.mjs`](../examples/plugins/idle-reader.mjs).

```json
{ "browser": { "ambientMouse": { "protectedSites": ["mail.example.com", "/bank\\./"] } } }
```

## External pacing and idle processes

Pacing models and idle planners can also run as processes, with the same JSON-lines protocol as pointer models. Set `kind` to `pacing` or `idle`:

```json
{ "capabilities": { "plugins": [{ "id": "action.pacing.mine", "kind": "pacing", "command": ["python", "pacing.py"] }], "pacing": "action.pacing.mine" } }
```

A pacing request is `{ "id": 1, "context": { ... } }` and the answer `{ "id": 1, "delayMs": 900 }`. An idle request is `{ "id": 2, "scene": { ... } }` and the answer `{ "id": 2, "steps": [ ... ] }`.

## Clipboard provider

Export an object with a `manifest` (kind `action`), plus `invoke({ page, text })` (paste into the focused element), `read()`, `write(text)` and `clear()`. It appears in the clipboard slot automatically.

## Trust

Plugins run with your user's permissions inside the Waymark process, or as a child process you configured. Only load code you trust. The model interface is deliberately narrow (coordinates in, coordinates out), so a model never needs page or account access.

## Roadmap

Planned slots: scrolling, and slider or click-order challenge solvers. Pull requests are welcome.
