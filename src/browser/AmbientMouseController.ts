import type { Page } from 'playwright-core';
import type { AuditLog } from '../audit/AuditLog.js';
import type { PointerActor } from './InputActor.js';

export class AmbientMouseController {
  private timer?: NodeJS.Timeout;
  private enabled = false;
  private moving = false;

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
    this.timer = setTimeout(() => { void this.tick().finally(() => this.schedule()); }, pause);
  }

  private async tick(): Promise<void> {
    const active = this.activePage();
    if (!active || active.page.isClosed() || this.isBusy(active.id) || active.page.url() === 'about:blank') return;
    try { this.guard(active.id); } catch { return; }
    this.moving = true;
    try {
      const point = await this.safePoint(active.page);
      if (!point) return;
      const actor = this.actor();
      await actor.move({ page: active.page, x: point.x, y: point.y }, 'ambient');
      this.audit.record({
        pageId: active.id, action: 'mouse.ambient', target: point,
        before: { url: active.page.url(), title: await active.page.title() },
        after: { url: active.page.url(), title: await active.page.title() },
        capabilities: [actor.manifest], status: 'info', detail: { autonomous: true, clicked: false }
      });
    } catch { /* A navigation or closed tab cancels this ambient movement without retries. */ }
    finally { this.moving = false; }
  }

  private async safePoint(page: Page): Promise<{ x: number; y: number } | undefined> {
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
        return {x,y};
      })()`) as { x: number; y: number } | null;
      if (point) return point;
    }
    return undefined;
  }

  private integer(min: number, max: number): number { return Math.floor(min + Math.random() * (max - min + 1)); }
}
