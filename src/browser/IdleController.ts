import type { Page } from 'playwright-core';
import type { AuditLog } from '../audit/AuditLog.js';
import type { CapabilityManifest } from '../capabilities/CapabilityRegistry.js';
import type { PointerActor } from './InputActor.js';

/**
 * What an idle planner sees while the agent is thinking. Like pointer models, planners never receive the page:
 * Waymark describes it (safe spots, text, new elements, links that can be visited and come back from), runs the
 * steps through its own input pipeline, checks each one again before running it, and undoes them before the agent's
 * next call.
 */
export interface IdleScene {
  viewport: { width: number; height: number };
  pointer: { x: number; y: number };
  /** Milliseconds since the agent's last call on this page returned. */
  sinceAgentMs: number;
  scroll: { y: number; maxY: number };
  /** What this page allows right now, and why not when it does not. */
  allow: { click: boolean; scroll: boolean; visit: boolean; reason?: string };
  /** Points on plain page background or text: nothing interactive under them. */
  spots: Array<{ x: number; y: number }>;
  /** Visible blocks of text, for reading sweeps. */
  text: Rect[];
  /** Elements that appeared in the agent's last result; a person looks at what just appeared. */
  fresh: Rect[];
  /** Same-origin links whose page can be left and returned to. Only present when `allow.visit`. */
  links: Rect[];
}
export interface Rect { x: number; y: number; width: number; height: number }

export type IdleStep =
  | { type: 'move'; x: number; y: number }
  | { type: 'pause'; ms: number }
  | { type: 'click'; x: number; y: number }
  | { type: 'scroll'; dy: number }
  | { type: 'visit'; link: number; dwellMs: number };

export interface IdlePlanner {
  readonly manifest: CapabilityManifest;
  plan(scene: IdleScene): IdleStep[] | Promise<IdleStep[]>;
  invoke(scene: IdleScene): Promise<IdleStep[]>;
  close?(): Promise<void>;
}

export interface IdleOptions {
  minPauseMs: number;
  maxPauseMs: number;
  marginPx: number;
  /** URL patterns (substring or /regex/) where idle behaviour never leaves the page, in addition to the built-in list. */
  protectedSites?: string[];
}

/** What the runtime tells the controller about a page. */
export interface IdleHost {
  target(): { id: number; page: Page } | undefined;
  busy(pageId: number): boolean;
  guard(pageId: number): void;
  actor(): PointerActor;
  planner(): IdlePlanner;
  sinceAgentMs(pageId: number): number;
  /** Refs the agent was shown as new in its last result. */
  fresh(pageId: number): string[];
  /** The page must not be left: it shows a form result, the agent is waiting on it, or an earlier return failed. */
  pinned(pageId: number): string | undefined;
  /** An idle visit could not bring the page back intact; never visit from this origin again in this session. */
  unrestorable(pageId: number, origin: string, reason: string): void;
  /** Refs that must keep resolving after a visit, with the CSS path to re-stamp them by if the page was rebuilt. */
  refs(pageId: number): string[];
}

const TICK_LIMIT_MS = 20000;
const STEP_LIMIT_MS = 8000;
const MAX_STEPS = 16;
const VISIT_EVERY_MS = 45000;

/** Pages that are part of a flow (checkout, applications, sign-in, appointments) are never left by idle behaviour. */
const SENSITIVE = /checkout|payment|\/pay\b|billing|\/order|\/cart|basket|visa|consular|ceac|\/apply|application|appointment|booking|reserv|\/login|signin|sign-in|sign_in|\/auth|oauth|sso|password|verify|captcha|bank|transfer|exam|survey|\/submit|wizard|\/step/i;
const RISKY_LINK = /logout|log out|sign ?out|delete|remove|cancel|unsubscribe|buy|order|pay|checkout|cart|submit|confirm|apply|download|退出|注销|删除|移除|取消|退订|购买|支付|下单|提交|确认|申请|下载/i;

export class IdleController {
  private timer?: NodeJS.Timeout;
  private enabled = false;
  private current?: Promise<void>;
  private abort?: AbortController;
  private lastVisit = new Map<number, number>();
  private moving = false;

  constructor(private options: IdleOptions, private host: IdleHost, private audit: AuditLog) {}

  start(): void { if (!this.enabled) { this.enabled = true; this.schedule(); } }
  stop(): void { this.enabled = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.abort?.abort(); }
  state(): { enabled: boolean; moving: boolean } { return { enabled: this.enabled, moving: this.moving }; }

  /** The agent is about to act: stop whatever idle behaviour is running and wait until the page is back as it was. */
  async yield(): Promise<void> {
    const running = this.current;
    if (!running) return;
    this.abort?.abort();
    await bounded(running, 12000);
  }

  private schedule(): void {
    if (!this.enabled) return;
    const pause = integer(this.options.minPauseMs, this.options.maxPauseMs);
    this.timer = setTimeout(() => {
      const tick = this.tick();
      // A tick is bounded: a renderer that stops answering (hidden or frozen tab) must not end idle behaviour for good.
      this.current = bounded(tick, TICK_LIMIT_MS).finally(() => { this.current = undefined; this.schedule(); });
    }, pause);
    // Idle behaviour never keeps the process alive on its own.
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    const target = this.host.target();
    if (!target || target.page.isClosed() || this.host.busy(target.id) || !/^(https?|file):/.test(target.page.url())) return;
    try { this.host.guard(target.id); } catch { return; }
    const { id, page } = target;
    const abort = this.abort = new AbortController();
    const signal = abort.signal;
    const planner = this.host.planner();
    const actor = this.host.actor();
    const before = { url: page.url(), title: await page.title().catch(() => '') };
    const done: string[] = [];
    let visit: Visit | undefined;
    let visited: string | undefined;
    let scrolled = 0;
    let status: 'info' | 'warning' = 'info';
    let restored: string | undefined;
    let visibility = 'unknown';
    this.moving = true;
    try {
      const scene = await this.scene(id, page);
      if (!scene) return;
      visibility = scene.visibility;
      const steps = validate(await planner.plan(scene.scene), scene.scene);
      for (const step of steps) {
        if (signal.aborted || page.isClosed() || this.host.busy(id)) break;
        if (step.type === 'move') await bounded(actor.move({ page, x: step.x, y: step.y, signal }, 'ambient'), STEP_LIMIT_MS);
        else if (step.type === 'pause') await sleep(step.ms, signal);
        else if (step.type === 'scroll') {
          if (!scene.scene.allow.scroll) continue;
          await page.mouse.wheel(0, step.dy);
          scrolled += step.dy;
        } else if (step.type === 'click') {
          if (!scene.scene.allow.click || !await this.safeToClick(page, step.x, step.y)) continue;
          if (!scene.restore.token) await this.prepare(page, scene.restore);
          await bounded(actor.invoke({ page, x: step.x, y: step.y, signal }), STEP_LIMIT_MS);
          // A click on page background that navigates anyway (a document-level handler) is undone like a visit.
          if (page.url() !== before.url) { await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => undefined); visit = { url: before.url, restore: scene.restore }; visited = page.url(); }
        } else if (step.type === 'visit') {
          if (visit || !scene.scene.allow.visit || Date.now() - (this.lastVisit.get(id) ?? 0) < VISIT_EVERY_MS) continue;
          const link = scene.links[step.link];
          if (!link) continue;
          const point = { x: link.x + link.width * (0.3 + Math.random() * 0.4), y: link.y + link.height * (0.3 + Math.random() * 0.4) };
          if (!await this.linkAt(page, point, link.href)) continue;
          this.lastVisit.set(id, Date.now());
          if (!scene.restore.token) await this.prepare(page, scene.restore);
          await bounded(actor.invoke({ page, x: point.x, y: point.y, signal }), STEP_LIMIT_MS);
          await page.waitForURL(url => url.href !== before.url, { timeout: 3000, waitUntil: 'domcontentloaded' }).catch(() => undefined);
          if (page.url() === before.url) continue;
          visit = { url: before.url, restore: scene.restore };
          visited = page.url();
          // Dwell like a person glancing at the page: the pointer drifts while it is open.
          const until = Date.now() + step.dwellMs;
          while (!signal.aborted && Date.now() < until) {
            const size = page.viewportSize() ?? scene.scene.viewport;
            await bounded(actor.move({ page, x: 40 + Math.random() * Math.max(1, size.width - 80), y: 40 + Math.random() * Math.max(1, size.height - 80), signal }, 'ambient'), STEP_LIMIT_MS);
            await sleep(integer(300, 900), signal);
          }
        }
        done.push(step.type);
      }
    } catch { status = 'warning'; /* A navigation or closed tab cancels the behaviour; the restore below still runs. */ }
    finally {
      try {
        // Returning restores the scroll position too; otherwise undo what an interrupted scroll left behind.
        if (visit) restored = await this.restore(id, page, visit);
        else if (scrolled && !page.isClosed()) await page.mouse.wheel(0, -scrolled);
      } catch (error) { restored = 'failed'; status = 'warning'; this.host.unrestorable(id, origin(before.url), String(error)); }
      if (restored && restored !== 'intact') status = 'warning';
      this.moving = false;
      if (done.length && !page.isClosed()) {
        const changed = done.some(type => type === 'click' || type === 'scroll' || type === 'visit');
        this.audit.record({
          pageId: id, action: changed ? `idle.${done.includes('visit') ? 'visit' : done.includes('click') ? 'click' : 'scroll'}` : 'mouse.ambient',
          before, after: { url: page.url(), title: await page.title().catch(() => '') },
          capabilities: [planner.manifest, actor.manifest], status,
          detail: { autonomous: true, clicked: done.includes('click') || done.includes('visit'), steps: done, interrupted: signal.aborted, visited, restored, visibility }
        });
      }
    }
  }

  /** Describe the page and decide what it allows, in one round trip. */
  private async scene(pageId: number, page: Page): Promise<{ scene: IdleScene; links: Array<Rect & { href: string }>; restore: RestorePoint; visibility: string } | undefined> {
    const pinned = this.host.pinned(pageId);
    const protectedSites = (this.options.protectedSites ?? []).map(pattern => pattern.startsWith('/') && pattern.endsWith('/') ? new RegExp(pattern.slice(1, -1), 'i') : pattern.toLowerCase());
    const url = page.url();
    const blocked = pinned ?? (SENSITIVE.test(url) ? 'part of a flow' : protectedSites.some(p => typeof p === 'string' ? url.toLowerCase().includes(p) : p.test(url)) ? 'protected site' : undefined);
    const raw = await page.evaluate(`(() => {
      const margin = ${this.options.marginPx};
      const width = window.innerWidth, height = window.innerHeight;
      if (width <= margin * 2 || height <= margin * 2) return null;
      const INTERACTIVE = 'a,button,input,textarea,select,option,label,summary,details,video,audio,iframe,canvas,[onclick],[tabindex],[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="combobox"],[role="option"],[role="menuitem"],[role="slider"],[contenteditable="true"],[draggable="true"]';
      const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < height && r.left < width && getComputedStyle(el).visibility !== 'hidden'; };
      const active = document.activeElement;
      const editing = !!active && active !== document.body && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
      const popup = Array.from(document.querySelectorAll('[aria-expanded="true"],dialog[open],[aria-modal="true"],[role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"]')).some(shown);
      const fields = Array.from(document.querySelectorAll('input,textarea,select'));
      const dirty = fields.some(el => el instanceof HTMLSelectElement ? Array.from(el.options).some(o => o.selected !== o.defaultSelected)
        : ['checkbox', 'radio'].includes(el.type) ? el.checked !== el.defaultChecked : !['button', 'submit', 'reset', 'image', 'hidden', 'file'].includes(el.type) && el.value !== el.defaultValue);
      const secret = fields.some(el => el.type === 'password' || el.type === 'file' || /one-time-code|cc-/.test(el.autocomplete || ''));
      // A pointer on page background, not on anything that reacts, and not on an overlay covering most of the view.
      const plain = (x, y) => {
        const el = document.elementFromPoint(x, y);
        if (!el || el.closest(INTERACTIVE)) return false;
        if (getComputedStyle(el).cursor === 'pointer') return false;
        const r = el.getBoundingClientRect(), position = getComputedStyle(el).position;
        return !((position === 'fixed' || position === 'absolute') && r.width * r.height > width * height * 0.6 && el !== document.body && el !== document.documentElement);
      };
      const spots = [];
      for (let i = 0; i < 24 && spots.length < 8; i++) {
        const x = margin + Math.floor(Math.random() * (width - margin * 2)), y = margin + Math.floor(Math.random() * (height - margin * 2));
        if (plain(x, y)) spots.push({ x, y });
      }
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(r.right, width) - Math.max(0, r.left), height: Math.min(r.bottom, height) - Math.max(0, r.top) }; };
      const text = Array.from(document.querySelectorAll('p,li,h1,h2,h3,td,blockquote')).filter(el => shown(el) && (el.innerText || '').trim().length > 30).slice(0, 12).map(rect);
      const fresh = ${JSON.stringify(this.host.fresh(pageId))}.map(ref => document.querySelector('[data-agent-ref="' + ref + '"]')).filter(el => el && shown(el)).slice(0, 6).map(rect);
      const links = Array.from(document.querySelectorAll('a[href]')).filter(a => {
        if (!shown(a) || a.target && a.target !== '_self' || a.hasAttribute('download') || a.closest('form,nav[aria-label*="breadcrumb" i]')) return false;
        let u; try { u = new URL(a.href, location.href); } catch { return false; }
        if (u.origin !== location.origin || !/^https?:$/.test(u.protocol) || u.href.split('#')[0] === location.href.split('#')[0]) return false;
        return !${RISKY_LINK}.test((a.innerText || '') + ' ' + a.getAttribute('href') + ' ' + (a.getAttribute('aria-label') || ''));
      }).slice(0, 20).map(a => ({ ...rect(a), href: a.href }));
      const scroller = document.scrollingElement || document.documentElement;
      return {
        width, height, spots, text, fresh, links, editing, popup, dirty, secret,
        beforeunload: typeof window.onbeforeunload === 'function',
        scrollX: window.scrollX, scrollY: window.scrollY, maxY: Math.max(0, scroller.scrollHeight - height),
        visibility: document.visibilityState
      };
    })()`) as RawScene | null;
    if (!raw) return undefined;
    const reason = blocked ?? (raw.editing ? 'editing a field' : raw.popup ? 'a popup is open' : raw.dirty ? 'unsaved input' : raw.secret ? 'sensitive fields' : raw.beforeunload ? 'page asks before leaving' : undefined);
    const visit = !reason && raw.links.length > 0 && /^https?:/.test(url);
    const scene: IdleScene = {
      viewport: { width: raw.width, height: raw.height },
      pointer: this.host.actor().position?.(page) ?? { x: 0, y: 0 },
      sinceAgentMs: this.host.sinceAgentMs(pageId),
      scroll: { y: raw.scrollY, maxY: raw.maxY },
      allow: { click: !blocked && !raw.editing && !raw.popup, scroll: !raw.popup && raw.maxY > 0, visit, reason: visit ? undefined : reason ?? (raw.links.length ? undefined : 'no links to visit') },
      spots: raw.spots, text: raw.text, fresh: raw.fresh,
      links: visit ? raw.links.map(({ href: _href, ...rect }) => rect) : []
    };
    return { scene, links: visit ? raw.links : [], restore: { scrollX: raw.scrollX, scrollY: raw.scrollY, refs: this.host.refs(pageId) }, visibility: raw.visibility };
  }

  private async safeToClick(page: Page, x: number, y: number): Promise<boolean> {
    return await page.evaluate(`(() => {
      const el = document.elementFromPoint(${x}, ${y});
      const active = document.activeElement;
      if (active && active !== document.body && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return false;
      return !!el && !el.closest('a,button,input,textarea,select,option,label,summary,details,video,audio,iframe,canvas,[onclick],[tabindex],[role],[contenteditable="true"],[draggable="true"]') && getComputedStyle(el).cursor !== 'pointer';
    })()`).catch(() => false) as boolean;
  }

  private async linkAt(page: Page, point: { x: number; y: number }, href: string): Promise<boolean> {
    return await page.evaluate(`(() => { const a = document.elementFromPoint(${point.x}, ${point.y})?.closest('a[href]'); return !!a && a.href === ${JSON.stringify(href)}; })()`).catch(() => false) as boolean;
  }

  /**
   * Go back to the page the agent last saw. Back/forward cache returns the same document with every field and ref;
   * otherwise the page is rebuilt, so refs are stamped again by their paths and the origin is not visited again.
   */
  private async restore(pageId: number, page: Page, visit: Visit): Promise<string> {
    if (page.isClosed()) return 'closed';
    if (page.url() !== visit.url) {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null);
      if (page.url() !== visit.url) {
        await page.goto(visit.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        this.host.unrestorable(pageId, origin(visit.url), 'back did not return to the page');
      }
    }
    const { token, paths = [], scrollX, scrollY } = visit.restore;
    const state = await page.evaluate(`((token, refs, x, y) => {
      const same = !!token && window.__waymarkIdle === token;
      let restamped = 0, missing = 0;
      for (const { ref, path, tag } of refs) {
        if (document.querySelector('[data-agent-ref="' + ref + '"]')) continue;
        const el = path ? document.querySelector(path) : null;
        if (el && el.tagName === tag && !el.hasAttribute('data-agent-ref')) { el.setAttribute('data-agent-ref', ref); restamped++; } else missing++;
      }
      window.scrollTo(x, y);
      return { same, restamped, missing };
    })(${JSON.stringify(token ?? '')}, ${JSON.stringify(paths)}, ${scrollX}, ${scrollY})`) as { same: boolean; restamped: number; missing: number };
    if (state.same && !state.missing && !state.restamped) return 'intact';
    this.host.unrestorable(pageId, origin(visit.url), state.missing ? `${state.missing} refs lost after returning` : 'page was rebuilt on return');
    return state.missing ? 'refs-lost' : 'rebuilt';
  }

  /** Before anything that may leave the page: mark the document, so an intact return can be told from a rebuild, and record ref paths. */
  private async prepare(page: Page, restore: RestorePoint): Promise<void> {
    const token = Math.random().toString(36).slice(2);
    restore.paths = await page.evaluate(`((token, refs) => {
      window.__waymarkIdle = token;
      const path = (el) => { const parts = []; for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) { let i = 1; for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++; parts.unshift(e.tagName.toLowerCase() + ':nth-of-type(' + i + ')'); } return 'html > ' + parts.join(' > '); };
      return refs.map(ref => { const el = document.querySelector('[data-agent-ref="' + ref + '"]'); return el ? { ref, path: path(el), tag: el.tagName } : { ref, path: '', tag: '' }; });
    })(${JSON.stringify(token)}, ${JSON.stringify(restore.refs)})`) as RestorePoint['paths'];
    restore.token = token;
  }
}

interface RawScene {
  width: number; height: number; spots: Array<{ x: number; y: number }>; text: Rect[]; fresh: Rect[]; links: Array<Rect & { href: string }>;
  editing: boolean; popup: boolean; dirty: boolean; secret: boolean; beforeunload: boolean; scrollX: number; scrollY: number; maxY: number; visibility: string;
}
interface RestorePoint { scrollX: number; scrollY: number; refs: string[]; token?: string; paths?: Array<{ ref: string; path: string; tag: string }> }
interface Visit { url: string; restore: RestorePoint }

/** Keep a planner's steps inside the page and inside sane bounds; drop anything malformed. */
function validate(steps: unknown, scene: IdleScene): IdleStep[] {
  if (!Array.isArray(steps)) return [];
  const { width, height } = scene.viewport;
  const inside = (x: unknown, y: unknown) => Number.isFinite(x) && Number.isFinite(y) && (x as number) >= 0 && (y as number) >= 0 && (x as number) < width && (y as number) < height;
  const out: IdleStep[] = [];
  for (const raw of steps.slice(0, MAX_STEPS) as IdleStep[]) {
    if (!raw || typeof raw !== 'object') continue;
    if ((raw.type === 'move' || raw.type === 'click') && inside(raw.x, raw.y)) out.push({ type: raw.type, x: raw.x, y: raw.y });
    else if (raw.type === 'pause' && Number.isFinite(raw.ms)) out.push({ type: 'pause', ms: Math.max(0, Math.min(3000, raw.ms)) });
    else if (raw.type === 'scroll' && Number.isFinite(raw.dy)) out.push({ type: 'scroll', dy: Math.max(-600, Math.min(600, raw.dy)) });
    else if (raw.type === 'visit' && Number.isInteger(raw.link) && Number.isFinite(raw.dwellMs)) out.push({ type: 'visit', link: raw.link, dwellMs: Math.max(500, Math.min(6000, raw.dwellMs)) });
  }
  return out;
}

function origin(url: string): string { try { return new URL(url).origin; } catch { return url; } }
function integer(min: number, max: number): number { return Math.floor(min + Math.random() * (max - min + 1)); }
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}
function bounded<T>(work: Promise<T>, ms: number): Promise<T | void> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>(resolve => { timer = setTimeout(resolve, ms); timer.unref?.(); });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}
