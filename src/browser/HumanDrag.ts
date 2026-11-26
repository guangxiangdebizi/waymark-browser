import type { Page } from 'playwright-core';

const pause = (page: Page, min: number, max: number) => page.waitForTimeout(min + Math.random() * (max - min));

/**
 * Drag with the button already held, the way a hand does it: a quick start that slows into the target, a few pixels
 * past it and back, a slight vertical wobble, a short hold before letting go. Ends with the button still down so the
 * caller can check the result first; `release` lets go.
 */
export async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const duration = Math.min(1600, 420 + distance * 2.4 + Math.random() * 260);
  const overshoot = distance > 40 ? 2 + Math.random() * 6 : 0;
  const direction = Math.sign(to.x - from.x) || 1;
  const peak = { x: to.x + direction * overshoot, y: to.y };
  const steps = Math.max(12, Math.round(duration / 16));
  let wobble = 0;
  let at = from;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = 1 - Math.pow(1 - t, 3);
    wobble = Math.max(-2.5, Math.min(2.5, wobble + (Math.random() - 0.5) * 0.9));
    at = { x: from.x + (peak.x - from.x) * eased, y: from.y + (peak.y - from.y) * eased + wobble * Math.sin(Math.PI * t) };
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(duration / steps * (0.6 + Math.random() * 0.8));
  }
  if (overshoot) {
    await pause(page, 60, 160);
    const back = Math.max(3, Math.round(overshoot * 1.5));
    for (let i = 1; i <= back; i++) {
      at = { x: peak.x + (to.x - peak.x) * (i / back), y: to.y };
      await page.mouse.move(at.x, at.y);
      await page.waitForTimeout(18 + Math.random() * 22);
    }
  }
  return at;
}

/** Small corrective move while still holding, as when a person sees they stopped short. */
export async function nudge(page: Page, from: { x: number; y: number }, dx: number): Promise<{ x: number; y: number }> {
  const steps = Math.max(3, Math.round(Math.abs(dx) / 2));
  let at = from;
  await pause(page, 120, 260);
  for (let i = 1; i <= steps; i++) {
    at = { x: from.x + dx * (i / steps), y: from.y };
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(20 + Math.random() * 25);
  }
  return at;
}

export async function release(page: Page): Promise<void> {
  await pause(page, 110, 280);
  await page.mouse.up();
}
