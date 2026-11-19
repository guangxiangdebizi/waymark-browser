// Example Waymark idle planner: while the agent thinks, the pointer follows lines of text like a reader, and never clicks.
//
// Enable it in data/electron-settings.json (or config/electron.json):
//   { "capabilities": { "plugins": [{ "module": "./examples/plugins/idle-reader.mjs" }],
//                       "idle": "idle.reader" } }
//
// A planner only returns steps. Waymark checks each one against what the page allows (scene.allow), runs it through
// its own input pipeline, and undoes clicks, scrolls and visits before the agent's next call.

const rand = (min, max) => min + Math.random() * (max - min);

export default {
  manifest: { id: 'idle.reader', version: '1.0.0', description: 'Follows text line by line while the agent thinks; never clicks' },

  plan({ text, spots }) {
    const block = text[Math.floor(Math.random() * text.length)];
    if (!block) return spots.length ? [{ type: 'move', ...spots[0] }] : [];
    const steps = [];
    for (let line = 0; line < Math.min(3, Math.floor(block.height / 18) || 1); line++) {
      const y = block.y + 10 + line * 18;
      steps.push({ type: 'move', x: block.x + 4, y }, { type: 'pause', ms: rand(120, 300) });
      steps.push({ type: 'move', x: block.x + block.width - 8, y: y + rand(-2, 2) }, { type: 'pause', ms: rand(200, 500) });
    }
    return steps;
  }
};
