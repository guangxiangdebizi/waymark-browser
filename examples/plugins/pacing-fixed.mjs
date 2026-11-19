// Example Waymark pacing model: a fixed think time before every step, minus whatever the agent already spent.
//
// Enable it in data/electron-settings.json (or config/electron.json):
//   { "capabilities": { "plugins": [{ "module": "./examples/plugins/pacing-fixed.mjs" }],
//                       "pacing": "action.pacing.fixed" } }
//
// A pacing model only returns a delay in ms; Waymark waits it out (clamped to 0-8000) and records it in the ledger.

export default {
  manifest: { id: 'action.pacing.fixed', version: '1.0.0', description: 'Every step starts at least 400 ms after the agent saw the page' },

  delay({ kind, sinceObservedMs }) {
    if (kind === 'field') return 250;
    return Math.max(0, 400 - sinceObservedMs);
  }
};
