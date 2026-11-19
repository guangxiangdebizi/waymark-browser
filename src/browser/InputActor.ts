import type { Page } from 'playwright-core';
import type { CapabilityManifest } from '../capabilities/CapabilityRegistry.js';

/** `signal` lets idle movement be cut short the moment the agent acts. */
export interface PointerInput { page: Page; x: number; y: number; signal?: AbortSignal }

/** What the runtime needs from a pointer capability: click at a point, or just travel there. */
export interface PointerActor {
  readonly manifest: CapabilityManifest;
  invoke(input: PointerInput): Promise<void>;
  move(input: PointerInput, purpose?: 'click' | 'hover' | 'ambient'): Promise<void>;
  /** Where this actor last left the pointer on a page. */
  position?(page: Page): { x: number; y: number } | undefined;
  close?(): Promise<void>;
}

export class InputActor implements PointerActor {
  readonly manifest: CapabilityManifest = { id: 'action.pointer.bezier', version: '0.1.0', kind: 'action', runtime: 'node', dataEgress: 'local-only', description: 'Configurable curved pointer trajectory with local timing.' };
  private positions = new WeakMap<Page, { x: number; y: number }>();
  constructor(private options: { minSteps: number; maxSteps: number; minDelayMs: number; maxDelayMs: number }) {}
  position(page: Page): { x: number; y: number } | undefined { return this.positions.get(page); }
  async invoke(input: PointerInput): Promise<void> {
    await this.move(input);
    if (input.signal?.aborted) return;
    await input.page.mouse.click(input.x, input.y, { delay: this.integer(20, 65) });
  }

  async move({ page, x, y, signal }: PointerInput): Promise<void> {
    const start = this.positions.get(page) ?? { x: 0, y: 0 };
    const steps = this.integer(this.options.minSteps, this.options.maxSteps);
    const bend = (Math.random() - 0.5) * Math.min(160, Math.hypot(x - start.x, y - start.y) * 0.35);
    const length = Math.hypot(x - start.x, y - start.y) || 1;
    const control = { x: (start.x + x) / 2 - ((y - start.y) / length) * bend, y: (start.y + y) / 2 + ((x - start.x) / length) * bend };
    for (let i = 1; i <= steps; i++) {
      if (signal?.aborted) return;
      const t = i / steps;
      const eased = t * t * (3 - 2 * t);
      const u = 1 - eased;
      const point = { x: u * u * start.x + 2 * u * eased * control.x + eased * eased * x, y: u * u * start.y + 2 * u * eased * control.y + eased * eased * y };
      await page.mouse.move(point.x, point.y);
      this.positions.set(page, point);
      await page.waitForTimeout(this.integer(this.options.minDelayMs, this.options.maxDelayMs));
    }
    this.positions.set(page, { x, y });
  }
  private integer(min: number, max: number): number { return Math.floor(min + Math.random() * (max - min + 1)); }
}
