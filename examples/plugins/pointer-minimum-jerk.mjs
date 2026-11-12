// Example Waymark pointer model: minimum-jerk reaching movement with a small overshoot and correction.
// Minimum-jerk profiles (Flash & Hogan, 1985) are a classic model of human point-to-point arm motion.
//
// Enable it in data/electron-settings.json (or config/electron.json):
//   { "capabilities": { "plugins": [{ "module": "./examples/plugins/pointer-minimum-jerk.mjs" }],
//                       "pointer": "action.pointer.minimum-jerk" } }
//
// A model only returns points; Waymark executes them, so the model never sees the page.

const rand = (min, max) => min + Math.random() * (max - min);

export default {
  manifest: {
    id: 'action.pointer.minimum-jerk',
    version: '1.0.0',
    description: 'Minimum-jerk reach with Fitts-law duration and slight overshoot'
  },

  trajectory({ from, to, purpose }) {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (distance < 2) return [{ x: to.x, y: to.y }];
    // Fitts' law: movement time grows with log2(distance / target width + 1). Assume ~24px targets.
    const duration = purpose === 'ambient' ? rand(500, 1100) : 120 + 110 * Math.log2(distance / 24 + 1);
    const steps = Math.max(8, Math.min(90, Math.round(duration / 12)));
    const overshoot = purpose === 'click' && distance > 120 ? rand(0.02, 0.06) : 0;
    const aim = { x: to.x + (to.x - from.x) * overshoot, y: to.y + (to.y - from.y) * overshoot };
    const wobble = rand(-0.08, 0.08) * distance;
    const nx = -(to.y - from.y) / distance, ny = (to.x - from.x) / distance;
    const points = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const s = 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5; // minimum-jerk position profile
      const arc = Math.sin(Math.PI * t) * wobble;
      points.push({ x: from.x + (aim.x - from.x) * s + nx * arc, y: from.y + (aim.y - from.y) * s + ny * arc, dt: Math.round(duration / steps) });
    }
    if (overshoot) points.push({ x: to.x + rand(-1, 1), y: to.y + rand(-1, 1), dt: Math.round(rand(40, 90)) }, { x: to.x, y: to.y, dt: 0 });
    return points;
  },

  pressMs: () => Math.round(rand(55, 120))
};
