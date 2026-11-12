# Plugins: swap any step of the automation layer

Waymark keeps low-level work on the browser side, and each step of that work is a **capability slot** you can fill with your own implementation:

| Slot | Built-in | Config key | Plugin shape |
|---|---|---|---|
| `pointer` | `action.pointer.bezier` | `capabilities.pointer` | trajectory model (below) |
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

## Clipboard provider

Export an object with a `manifest` (kind `action`), plus `invoke({ page, text })` (paste into the focused element), `read()`, `write(text)` and `clear()`. It appears in the clipboard slot automatically.

## Trust

Plugins run with your user's permissions inside the Waymark process, or as a child process you configured. Only load code you trust. The model interface is deliberately narrow (coordinates in, coordinates out), so a model never needs page or account access.

## Roadmap

Planned slots: typing cadence, scrolling, and slider or click-order challenge solvers. Pull requests are welcome.
