import type { Page } from 'playwright-core';
import type { AuditLog } from '../audit/AuditLog.js';
import type { PointerActor } from './InputActor.js';

const TICK_LIMIT_MS = 8000;

export class AmbientMouseController {
  private timer?: NodeJS.Timeout;
  private enabled = false;
  private moving = false;
  /** Tabs with a movement still in flight (possibly past its time limit); they get no second movement on top. */
  private inFlight = new Set<number>();

  constructor(
    private options: { minPauseMs: number; maxPauseMs: number; marginPx: number },
    private activePage: () => { id: number; page: Page } | undefined,
    private isBusy: (pageId: number) => boolean,
    private guard: (pageId: number) => void,
    private actor: () => PointerActor,
    private audit: AuditLog
  ) {}

  start(): void { if (!this.enabled) { this.enabled = true; this.schedule(); } }
  stop(): void { this.enabled = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  state(): { enabled: boolean; moving: boolean } { return { enabled: this.enabled, moving: this.moving }; }

  private schedule(): void {
    if (!this.enabled) return;
    const pause = this.integer(this.options.minPauseMs, this.options.maxPauseMs);
    // A tick is bounded: a renderer that stops answering (hidden or frozen tab) must not end ambient movement for good.
    this.timer = setTimeout(() => { void this.bounded(this.tick(), TICK_LIMIT_MS).finally(() => this.schedule()); }, pause);
    // Idle movement never keeps the process alive on its own.
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    const active = this.activePage();
    if (!active || active.page.isClosed() || this.isBusy(active.id) || active.page.url() === 'about:blank') return;
    if (this.inFlight.has(active.id)) return;
    try { this.guard(active.id); } catch { return; }
    this.moving = true;
    this.inFlight.add(active.id);
    try {
      const point = await this.safePoint(active.page);
      if (!point) return;
      const { visibility, ...target } = point;
      const actor = this.actor();
      await actor.move({ page: active.page, x: target.x, y: target.y }, 'ambient');
      this.audit.record({
        pageId: active.id, action: 'mouse.ambient', target,
        before: { url: active.page.url(), title: await active.page.title() },
        after: { url: active.page.url(), title: await active.page.title() },
        capabilities: [actor.manifest], status: 'info', detail: { autonomous: true, clicked: false, visibility }
      });
    } catch { /* A navigation or closed tab cancels this ambient movement without retries. */ }
    finally { this.moving = false; this.inFlight.delete(active.id); }
  }

  private bounded(work: Promise<void>, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>(resolve => { timer = setTimeout(resolve, ms); timer.unref?.(); });
    return Promise.race([work, limit]).finally(() => clearTimeout(timer));
  }

  private async safePoint(page: Page): Promise<{ x: number; y: number; visibility: string } | undefined> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const point = await page.evaluate(`(() => {
        const margin=${this.options.marginPx};
        const width=window.innerWidth,height=window.innerHeight;
        if(width<=margin*2||height<=margin*2)return null;
        const x=margin+Math.floor(Math.random()*(width-margin*2));
        const y=margin+Math.floor(Math.random()*(height-margin*2));
        const el=document.elementFromPoint(x,y);
        if(!el)return null;
        if(el.closest('a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]'))return null;
        return {x,y,visibility:document.visibilityState};
      })()`) as { x: number; y: number; visibility: string } | null;
      if (point) return point;
    }
    return undefined;
  }

  private integer(min: number, max: number): number { return Math.floor(min + Math.random() * (max - min + 1)); }
}
