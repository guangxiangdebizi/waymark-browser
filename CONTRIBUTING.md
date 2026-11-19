# Contributing to Waymark

Thanks for helping. Issues and pull requests in English or Chinese are both welcome.

## Setup

```bash
npm ci
npm run build && npm test        # TypeScript build + unit tests
npm run app                      # launch the desktop app (MCP on 127.0.0.1:9510)
npm run test:electron            # end-to-end, with the app running
npm run test:idle                # idle behaviour and restore, headless Chrome
cd cli && python -m unittest discover -s tests
```

On Linux without a display, run the app with `xvfb-run -a`. Set `WAYMARK_ELECTRON_ARGS="--no-sandbox"` if Electron's sandbox is unavailable.

## Guidelines

- Keep low-level work in the browser and out of the model. New features should make agents emit less, not more.
- New behaviour models and solvers belong behind a capability slot (`src/capabilities/`). Read [docs/plugins.md](docs/plugins.md) first.
- Never log secrets. Fill values, passwords, OCR answers and cookies must stay out of the ledger and out of tool results.
- Page-derived data goes back to agents only inside the untrusted-content envelope.
- Add or extend a test with every change. UI changes to the shell should keep `tests/dashboard.test.ts` passing; it forbids inline event handlers, which the shell CSP blocks.

## Releasing

Bump `cli/src/waymark_browser/__init__.py` and `package.json`, add a section to `CHANGELOG.md`, then push a `vX.Y.Z` tag. The release workflow publishes the CLI to PyPI through Trusted Publishing and creates the GitHub release.
