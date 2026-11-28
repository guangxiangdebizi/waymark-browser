import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import type { AppConfig, PageSummary, RefInfo, SnapshotResult } from '../types.js';
import { fromRoot } from '../config.js';
import { AuditLog } from '../audit/AuditLog.js';
import type { PointerActor, PointerInput } from './InputActor.js';
import type { CapabilityRegistry } from '../capabilities/CapabilityRegistry.js';
import type { ClipboardCapability, ClipboardPasteInput } from '../capabilities/ClipboardProvider.js';
import { IdleController, type IdlePlanner } from './IdleController.js';
import { AdaptivePlanner } from './IdlePlanners.js';
import { HumanPacing, clampDelay, looksLikeCommit, type PacingContext, type PacingModel } from './Pacing.js';
import { CAPABILITY_SLOTS, fitsSlot, type CapabilitySlot } from '../capabilities/slots.js';
import { HumanKeyboard, type KeyboardActor } from './HumanKeyboard.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentActor, type Actor } from '../audit/Actor.js';

/** What the local automation layer did for one agent step, so the dashboard can count it. */
export interface InputMeter { pointerPaths: number; clicks: number; keystrokes: number; pastes: number; pacedMs: number }
const meters = new AsyncLocalStorage<InputMeter>();
const newMeter = (): InputMeter => ({ pointerPaths: 0, clicks: 0, keystrokes: 0, pastes: 0, pacedMs: 0 });
import { domainMatches, readCdpCookies, toPlaywright, type CookieRecord } from './Cookies.js';

export interface ActInput {
  page: number;
  kind: 'click' | 'fill' | 'press' | 'scroll' | 'hover' | 'paste' | 'copy' | 'select' | 'type';
  ref?: string;
  fields?: Array<{ ref: string; value: string }>;
  value?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
}

export interface RuntimeDriver { context: BrowserContext; close(): Promise<void> }

export class BrowserRuntime {
  private context?: BrowserContext;
  private pages = new Map<number, Page>();
  private ids = new WeakMap<Page, number>();
  private refs = new Map<number, Map<string, RefInfo>>();
  private snapshotHashes = new Map<string, string>();
  private activePage = 0;
  private nextPageId = 1;
  private driver?: RuntimeDriver;
  private pageFactory?: (url: string) => Promise<Page>;
  private handleNavigation?: (page: Page, url: string) => Promise<boolean>;
  private pageActivator?: (page: Page) => Promise<void>;
  private pageCloser?: (page: Page) => Promise<void>;
  private pageFilter: (page: Page) => boolean = () => true;
  private actor: PointerActor;
  private clipboard: ClipboardCapability;
  private busyPages = new Set<number>();
  private ambient: IdleController;
  private keyboard: KeyboardActor;
  private pacing: PacingModel;
  private idle: IdlePlanner;
  /** When the agent last received each page's state, how many lines it was shown, and which refs were new. */
  private observedAt = new Map<number, number>();
  private shown = new Map<number, number>();
  private fresh = new Map<number, string[]>();
  /** Pages idle behaviour must not leave, and origins where an idle visit could not come back intact. */
  private pinnedPages = new Map<number, string>();
  private waiting = new Set<number>();
  private unrestorable = new Map<string, string>();
  /** The tab the agent last operated; ambient movement follows it rather than the most recently opened tab. */
  private agentPage = 0;
  private guard: (pageId: number) => void = () => undefined;
  private paused = false;
  private settledHook: (pageId: number) => Promise<unknown> = async () => null;

  constructor(private config: AppConfig, public audit: AuditLog, public capabilities: CapabilityRegistry, driver?: RuntimeDriver) {
    this.driver = driver;
    this.actor = capabilities.get<PointerInput, void>(config.capabilities.pointer) as unknown as PointerActor;
    this.clipboard = capabilities.get<ClipboardPasteInput, void>(config.capabilities.clipboard) as ClipboardCapability;
    // Configs written before the keyboard slot existed (or built by embedders) get the human keyboard.
    config.capabilities.keyboard ??= 'action.keyboard.human';
    this.keyboard = (capabilities.list().some(item => item.id === config.capabilities.keyboard)
      ? capabilities.get(config.capabilities.keyboard)
      : new HumanKeyboard(config.browser.typing)) as unknown as KeyboardActor;
    config.capabilities.pacing ??= 'action.pacing.human';
    config.capabilities.idle ??= 'idle.adaptive';
    this.pacing = (capabilities.list().some(item => item.id === config.capabilities.pacing)
      ? capabilities.get(config.capabilities.pacing) : new HumanPacing(config.browser.pacing)) as unknown as PacingModel;
    this.idle = (capabilities.list().some(item => item.id === config.capabilities.idle)
      ? capabilities.get(config.capabilities.idle) : new AdaptivePlanner()) as unknown as IdlePlanner;
    this.ambient = new IdleController(config.browser.ambientMouse, {
      target: () => {
        const operated = this.pages.get(this.agentPage);
        const id = operated && !operated.isClosed() ? this.agentPage : this.activePage;
        const page = this.pages.get(id);
        return page ? { id, page } : undefined;
      },
      busy: pageId => this.busyPages.has(pageId),
      guard: pageId => this.assertAllowed(pageId),
      actor: () => this.actor,
      planner: () => this.idle,
      sinceAgentMs: pageId => Date.now() - (this.observedAt.get(pageId) ?? 0),
      fresh: pageId => this.fresh.get(pageId) ?? [],
      pinned: pageId => {
        if (this.waiting.has(pageId)) return 'the agent is waiting on this page';
        const page = this.pages.get(pageId);
        let origin = '';
        try { origin = page ? new URL(page.url()).origin : ''; } catch { /* not a URL */ }
        return this.pinnedPages.get(pageId) ?? this.unrestorable.get(origin) ?? (origin === `http://${config.server.host}:${config.server.port}` ? 'Waymark page' : undefined);
      },
      unrestorable: (_pageId, origin, reason) => { this.unrestorable.set(origin, reason); },
      refs: pageId => [...this.refs.get(pageId)?.keys() ?? []]
    }, audit);
  }

  /** Pages opened by an agent call, and the hook the desktop shell uses to badge the tab with that agent. */
  private openers = new Map<number, Actor>();
  private tabOpenedHook?: (pageId: number, actor: Actor | undefined, page: Page) => void | Promise<void>;
  setTabOpenedHook(hook: (pageId: number, actor: Actor | undefined, page: Page) => void | Promise<void>): void { this.tabOpenedHook = hook; }
  openerOf(pageId: number): Actor | undefined { return this.openers.get(pageId); }

  private async pointerInvoke(input: PointerInput): Promise<void> {
    const meter = meters.getStore();
    if (meter) { meter.pointerPaths++; meter.clicks++; }
    await this.actor.invoke(input);
  }
  private async pointerMove(input: PointerInput, purpose?: 'click' | 'hover' | 'ambient'): Promise<void> {
    const meter = meters.getStore();
    if (meter) meter.pointerPaths++;
    await this.actor.move(input, purpose);
  }
  private async typeText(page: Page, text: string): Promise<void> {
    const meter = meters.getStore();
    if (meter) meter.keystrokes += [...text].length;
    await this.keyboard.type(page, text);
  }

  /**
   * A small JPEG of the page right after a step, linked to the ledger entry. It runs beside the agent's next step
   * instead of in front of it (the step's result is not held back), at most one capture per tab at a time, and the
   * bytes go straight to disk.
   */
  private capturing = new Map<Page, Promise<void>>();
  /** Input never overlaps a capture: an action waits for one still running on its tab (normally done during pacing). */
  private async captureDone(page: Page): Promise<void> { await this.capturing.get(page); }
  private async capturePage(page: Page, event: { id: string }): Promise<void> {
    const options = this.config.audit;
    if (!options.captureScreenshots || page.isClosed() || this.capturing.has(page)) return;
    const done = page.screenshot({ type: 'jpeg', quality: options.screenshotQuality ?? 50, scale: 'css', timeout: 4000, caret: 'initial' })
      .then(bytes => { const name = this.audit.saveScreenshot(event.id, bytes); if (name) this.audit.attachScreenshot(event as Parameters<AuditLog['attachScreenshot']>[0], name); })
      .catch(() => undefined /* a page that cannot be captured right now just has no picture */)
      .finally(() => this.capturing.delete(page));
    this.capturing.set(page, done);
  }

  /** Save a PNG (or JPEG) of a tab on request; inline returns the bytes as base64 for callers on other machines. */
  async screenshot(pageId: number, options: { fullPage?: boolean; format?: 'png' | 'jpeg'; inline?: boolean } = {}): Promise<unknown> {
    await this.launch();
    this.assertAllowed(pageId);
    const page = this.page(pageId);
    await this.claim(pageId);
    try {
      const type = options.format === 'jpeg' ? 'jpeg' : 'png';
      const bytes = await page.screenshot({ type, fullPage: Boolean(options.fullPage), timeout: 15000, ...(type === 'jpeg' ? { quality: 80 } : {}) });
      const state = await this.pageState(page);
      const event = this.audit.record({ pageId, action: 'screenshot', before: state, after: state, status: 'success', detail: { bytes: bytes.length, fullPage: Boolean(options.fullPage), format: type } });
      const file = this.audit.saveScreenshot(event.id, bytes, type === 'jpeg' ? 'jpg' : 'png');
      if (file) this.audit.attachScreenshot(event, file);
      return { pageId, ...state, traceId: event.id, file, path: file ? this.audit.screenshotPath(file) : undefined, bytes: bytes.length, ...(options.inline ? { base64: bytes.toString('base64') } : {}) };
    } finally { this.release(pageId); }
  }

  /** Start of every agent call on a page: idle behaviour stops and undoes itself before the agent touches anything. */
  private async claim(pageId: number): Promise<void> {
    await this.ambient.yield();
    this.busyPages.add(pageId);
  }

  /** End of an agent call: the agent now holds this page's state, and thinks from here. */
  private release(pageId: number, shownLines?: number): void {
    this.busyPages.delete(pageId);
    this.observedAt.set(pageId, Date.now());
    if (shownLines !== undefined) this.shown.set(pageId, shownLines);
  }

  /** The agent waits on a page (for text, a selector or time): idle behaviour may move the pointer but not leave or click. */
  async waitOn<T>(pageId: number, work: (page: Page) => Promise<T>): Promise<T> {
    await this.launch();
    this.assertAllowed(pageId);
    await this.ambient.yield();
    this.waiting.add(pageId);
    try { return await work(this.page(pageId)); }
    finally { this.waiting.delete(pageId); this.observedAt.set(pageId, Date.now()); }
  }

  /** Wait out the pacing model's reaction time; returns the ms waited. */
  private async pace(context: Omit<PacingContext, 'sinceObservedMs' | 'shownLines'> & { pageId: number }): Promise<number> {
    const { pageId, ...rest } = context;
    const observed = this.observedAt.get(pageId);
    const full: PacingContext = { ...rest, sinceObservedMs: observed === undefined ? 60000 : Date.now() - observed, shownLines: this.shown.get(pageId) ?? 0 };
    let ms = 0;
    try { ms = clampDelay(await this.pacing.delay(full)); } catch { ms = 0; }
    if (ms > 0) await new Promise(resolve => setTimeout(resolve, Math.round(ms)));
    const meter = meters.getStore();
    if (meter) meter.pacedMs += Math.round(ms);
    return Math.round(ms);
  }

  setPageHooks(hooks: { factory?: (url: string) => Promise<Page>; navigate?: (page: Page, url: string) => Promise<boolean>; activate?: (page: Page) => Promise<void>; close?: (page: Page) => Promise<void>; filter?: (page: Page) => boolean }): void {
    this.pageFactory = hooks.factory;
    this.handleNavigation = hooks.navigate;
    this.pageActivator = hooks.activate;
    this.pageCloser = hooks.close;
    if (hooks.filter) this.pageFilter = hooks.filter;
  }

  setAutomationGuard(guard: (pageId: number) => void): void { this.guard = guard; }
  setSettledHook(hook: (pageId: number) => Promise<unknown>): void { this.settledHook = hook; }

  async launch(): Promise<void> {
    if (this.context) return;
    const executablePath = this.driver ? undefined : this.resolveExecutable();
    this.context = this.driver ? this.driver.context : await chromium.launchPersistentContext(fromRoot(this.config.browser.userDataDir), {
      executablePath,
      headless: this.config.browser.headless,
      viewport: null,
      args: ['--no-first-run', '--no-default-browser-check']
    });
    for (const page of this.context.pages()) {
      if (this.config.browser.automationViewport) await page.setViewportSize(this.config.browser.automationViewport);
      this.register(page);
    }
    this.context.on('page', page => this.register(page));
    if (!this.pages.size) await this.newPage('about:blank');
    if (this.config.browser.ambientMouse.enabled) this.ambient.start();
    this.audit.record({ action: 'browser.launch', status: 'info', detail: { executablePath, driver: this.driver ? 'electron' : 'chromium', headless: this.config.browser.headless } });
  }

  async close(): Promise<void> {
    this.ambient.stop();
    if (this.driver) await this.driver.close();
    else if (this.context) await this.context.close();
    this.context = undefined;
    this.pages.clear();
    await this.capabilities.close();
  }

  /** Export or import cookies. Values never go to the audit ledger, only counts and domains. */
  async cookies(action: 'export' | 'import', options: { domains?: string[]; cookies?: CookieRecord[]; fromCdp?: string } = {}): Promise<unknown> {
    await this.launch();
    const context = this.context!;
    if (action === 'export') {
      const list = (await context.cookies()).filter(cookie => domainMatches(cookie.domain, options.domains));
      this.audit.record({ action: 'cookies.export', status: 'success', detail: { count: list.length, domains: [...new Set(list.map(c => c.domain))] } });
      return { count: list.length, cookies: list };
    }
    const source = options.cookies ?? (options.fromCdp ? await readCdpCookies(options.fromCdp) : undefined);
    if (!source) throw new Error('import needs cookies (a JSON array) or fromCdp (a DevTools endpoint such as http://127.0.0.1:9222)');
    const list = source.filter(cookie => cookie?.name && cookie.domain && domainMatches(cookie.domain, options.domains)).map(toPlaywright);
    if (list.length) await context.addCookies(list);
    const domains = [...new Set(list.map(c => c.domain))];
    this.audit.record({ action: 'cookies.import', status: 'success', detail: { count: list.length, domains, from: options.fromCdp ? 'cdp' : 'json' } });
    return { imported: list.length, domains };
  }

  async tabs(action: 'list' | 'new' | 'close' | 'active', pageId?: number, url?: string): Promise<unknown> {
    await this.launch();
    if (action !== 'list' && this.paused) throw new Error('The user has paused automation in Waymark; wait for the user to resume before retrying.');
    if (action !== 'list') await this.ambient.yield();
    if (action === 'new') {
      const created = await this.newPage(url ?? 'about:blank');
      const actor = currentActor();
      if (actor) this.openers.set(created.id, actor);
      this.audit.record({ pageId: created.id, action: 'tabs.new', target: { url }, after: { url: created.url, title: created.title }, status: 'success' });
      try { await this.tabOpenedHook?.(created.id, actor, this.page(created.id)); } catch { /* badge only */ }
      return { ...created, openedBy: actor ? { agent: actor.agent, session: actor.session, window: actor.window } : undefined };
    }
    if (action === 'active') {
      if (!pageId) throw new Error('page is required for tabs.active');
      const page = this.page(pageId);
      await page.bringToFront();
      await this.pageActivator?.(page);
      this.activePage = pageId;
      this.audit.record({ pageId, action: 'tabs.active', status: 'success' });
      return { pageId };
    }
    if (action === 'close') {
      if (!pageId) throw new Error('page is required for tabs.close');
      const closing = this.page(pageId);
      const before = await this.pageState(closing);
      if (this.pageCloser) await this.pageCloser(closing);
      else await closing.close();
      this.unregister(pageId);
      this.audit.record({ pageId, action: 'tabs.close', before, status: 'success' });
      return { closed: pageId };
    }
    const pages = await this.listPages();
    this.audit.record({ action: 'tabs.list', status: 'info', detail: { count: pages.length } });
    return pages;
  }

  async navigateAction(pageId: number, action: 'url' | 'back' | 'forward' | 'reload', url?: string): Promise<unknown> {
    await this.launch();
    this.assertAllowed(pageId);
    this.agentPage = pageId;
    const page = this.page(pageId);
    const before = await this.pageState(page);
    await this.claim(pageId);
    const started = this.audit.record({ pageId, action: 'navigate', target: { action, url }, before, status: 'started' });
    const start = Date.now();
    let shownLines: number | undefined;
    try {
      if (action === 'url') { if (!url) throw new Error('url is required'); await this.goto(page, url); }
      else if (action === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
      else if (action === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
      else await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(this.config.browser.settleMs);
      this.refs.delete(pageId);
      this.fresh.delete(pageId);
      this.pinnedPages.delete(pageId);
      shownLines = 2;
      const after = await this.pageState(page);
      const event = this.audit.record({ pageId, action: 'navigate', target: { action, url }, before, after, durationMs: Date.now() - start, status: 'success' });
      await this.capturePage(page, event);
      return { pageId, ...after, traceId: event.id, challenge: await this.settledHook(pageId) };
    } catch (error) {
      const failed = this.audit.record({ pageId, action: 'navigate', target: { action, url }, before, durationMs: Date.now() - start, status: 'failure', error: message(error) });
      await this.capturePage(page, failed);
      throw error;
    } finally { this.release(pageId, shownLines); }
  }

  async snapshot(pageId: number): Promise<SnapshotResult> {
    await this.launch();
    this.assertAllowed(pageId);
    this.agentPage = pageId;
    const page = this.page(pageId);
    await this.claim(pageId);
    let shownLines: number | undefined;
    try {
      const { saved, refs } = await this.capture(pageId, page);
      shownLines = saved.text.split('\n').length;
      this.fresh.delete(pageId);
      this.audit.record({ pageId, action: 'snapshot', target: { snapshotId: saved.id, refCount: refs.size }, basisSnapshotId: saved.id, basisSnapshotHash: saved.hash, before: { url: saved.url, title: saved.title }, after: { url: saved.url, title: saved.title }, status: 'success', detail: { textLength: saved.text.length, lines: shownLines, contentHash: contentHash(saved.text) } });
      return saved;
    } finally { this.release(pageId, shownLines); }
  }

  /**
   * Collect visible interactive elements. Refs are stamped on the element and kept while it exists, so a ref from an
   * earlier snapshot stays valid and a later capture can report exactly which elements appeared or disappeared.
   */
  private async capture(pageId: number, page: Page, unchangedFrom?: Map<string, RefInfo>): Promise<{ saved: SnapshotResult; refs: Map<string, RefInfo> }> {
    const data = await page.evaluate(`(() => {
      // Visible to a person: has size, no transparent/hidden ancestor, not clipped away by an overflow:hidden|clip ancestor.
      // Scroll containers (overflow:auto|scroll) do not count as clipping: their content is reachable by scrolling.
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) return false;
        if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) <= 0.05) return false;
        for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
          const ps = getComputedStyle(p);
          if (!/hidden|clip/.test(ps.overflow + ps.overflowX + ps.overflowY)) continue;
          const pr = p.getBoundingClientRect();
          if (Math.min(rect.right, pr.right) - Math.max(rect.left, pr.left) <= 1 || Math.min(rect.bottom, pr.bottom) - Math.max(rect.top, pr.top) <= 1) return false;
        }
        return true;
      };
      const clean = (text) => (text || '').replace(/\\s+/g, ' ').trim().slice(0, 180);
      const labelOf = (el) => {
        const by = el.getAttribute('aria-labelledby');
        if (by) { const text = by.split(/\\s+/).map(id => document.getElementById(id)?.innerText || '').join(' '); if (clean(text)) return clean(text); }
        if (el.labels && el.labels.length) return clean(Array.from(el.labels).map(l => l.innerText).join(' '));
        const wrap = el.closest('label');
        return wrap ? clean(wrap.innerText) : '';
      };
      const nameOf = (el) => clean(
        el.getAttribute('aria-label') || labelOf(el) || el.getAttribute('title') ||
        (el instanceof HTMLInputElement ? el.placeholder || (['button', 'submit', 'reset'].includes(el.type) ? el.value : '') : '') ||
        (el instanceof HTMLSelectElement ? '' : el.textContent) || el.getAttribute('name') || ''
      );
      const stateOf = (el) => {
        if (el instanceof HTMLSelectElement) {
          const options = Array.from(el.options).filter(o => !o.disabled).map(o => clean(o.label || o.text)).filter(Boolean);
          const shown = options.slice(0, 15).map(o => JSON.stringify(o)).join(', ') + (options.length > 15 ? ', +' + (options.length - 15) + ' more' : '');
          return ' selected=' + JSON.stringify(clean(el.selectedOptions[0]?.label || '')) + ' options=[' + shown + ']';
        }
        if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) return el.checked ? ' checked' : ' unchecked';
        if ((el instanceof HTMLInputElement && !['button', 'submit', 'reset', 'image'].includes(el.type)) || el instanceof HTMLTextAreaElement) return el.value ? ' filled' : ' empty';
        const expanded = el.getAttribute('aria-expanded');
        return expanded ? ' expanded=' + expanded : '';
      };
      const selector = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="combobox"],[role="option"],[role="menuitem"],[contenteditable="true"]';
      window.__agentRefSeq = window.__agentRefSeq || 0;
      const items = [];
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (el.type === 'hidden') continue;
        // Styled controls hide the real input and draw their own look. A checkbox/radio is clicked through its visible label;
        // a transparent submit/button laid over a visible button face still takes the click itself.
        let target = el;
        if (!visible(el)) {
          const input = el instanceof HTMLInputElement ? el : null;
          const label = input && ['checkbox', 'radio'].includes(input.type) ? ((input.labels && input.labels[0]) || input.closest('label')) : null;
          const r = el.getBoundingClientRect();
          if (label && visible(label)) target = label;
          else if (!(input && ['submit', 'button'].includes(input.type) && r.width > 1 && r.height > 1 && el.parentElement && visible(el.parentElement))) continue;
        }
        let ref = target.getAttribute('data-agent-ref');
        if (!ref) { ref = 'e' + (++window.__agentRefSeq); target.setAttribute('data-agent-ref', ref); }
        const role = el.getAttribute('role') || (el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase());
        items.push({ ref, role, name: nameOf(el), state: stateOf(el) });
      }
      const headings = Array.from(document.querySelectorAll('h1,h2,h3')).filter(visible)
        .map(el => el.tagName.toLowerCase() + ': ' + nameOf(el)).slice(0, 60);
      return { items, headings };
    })()`) as { items: Array<{ ref: string; role: string; name: string; state: string }>; headings: string[] };
    const id = randomUUID();
    const refs = new Map<string, RefInfo>();
    const lines = [`Page: ${await page.title()}`, `URL: ${page.url()}`, `Snapshot: ${id}`, '', ...data.headings, ''];
    for (const item of data.items) {
      const line = `[ref=${item.ref}] ${item.role} ${JSON.stringify(item.name)}${item.state}`;
      // An element the agent is not told about again keeps the snapshot it was last observed in (trace basis).
      const seen = unchangedFrom?.get(item.ref);
      refs.set(item.ref, { ref: item.ref, role: item.role, name: item.name, snapshotId: seen && seen.line === line ? seen.snapshotId : id, line });
      lines.push(line);
    }
    this.refs.set(pageId, refs);
    const saved = this.audit.saveSnapshot({ id, pageId, url: page.url(), title: await page.title(), text: lines.join('\n'), refs: Object.fromEntries(refs) });
    this.snapshotHashes.set(id, saved.hash);
    // Only snapshots that a live ref still points at are needed as a trace basis; drop the rest (no growth over time).
    const live = new Set([...this.refs.values()].flatMap(map => [...map.values()].map(info => info.snapshotId)));
    for (const key of this.snapshotHashes.keys()) if (!live.has(key)) this.snapshotHashes.delete(key);
    return { saved, refs };
  }

  /** Wait until the DOM stops changing (quietMs without mutations) and finite CSS animations/transitions end, bounded by maxMs. */
  private async settle(page: Page, quietMs = 200, maxMs = 2000): Promise<void> {
    await page.evaluate(`new Promise(resolve => {
      let timer, finished = false;
      const done = () => {
        if (finished) return; finished = true; observer.disconnect(); clearTimeout(cap); clearTimeout(timer);
        const running = (document.getAnimations ? document.getAnimations() : [])
          .filter(a => a.playState === 'running' && a.effect && Number.isFinite(a.effect.getComputedTiming().endTime));
        Promise.race([Promise.all(running.map(a => a.finished.catch(() => null))), new Promise(r => setTimeout(r, 1500))]).then(() => resolve(true));
      };
      const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, ${quietMs}); });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(done, ${quietMs}); const cap = setTimeout(done, ${maxMs});
    })`).catch(() => undefined);
  }

  /** After an action: what appeared, disappeared or changed state, so the agent rarely needs a separate snapshot. */
  private async changes(pageId: number, page: Page, previous: Map<string, RefInfo> | undefined, beforeUrl: string): Promise<unknown> {
    const navigated = page.url() !== beforeUrl;
    const { saved, refs } = await this.capture(pageId, page, navigated ? undefined : previous);
    const full = () => { for (const info of refs.values()) info.snapshotId = saved.id; return saved.text; };
    if (!previous || navigated) { this.fresh.delete(pageId); return { navigated, snapshot: full() }; }
    const appeared = [...refs.values()].filter(r => !previous.has(r.ref));
    this.fresh.set(pageId, appeared.slice(0, 20).map(r => r.ref));
    const added = appeared.map(r => r.line);
    const removed = [...previous.keys()].filter(ref => !refs.has(ref));
    const changed = [...refs.values()].filter(r => previous.has(r.ref) && previous.get(r.ref)!.line !== r.line).map(r => r.line);
    if (added.length > 80) return { snapshotId: saved.id, note: `${added.length} elements appeared; full snapshot follows`, snapshot: full() };
    return { snapshotId: saved.id, added, removed, changed };
  }

  async read(pageId: number, limit?: number, format: 'text' | 'markdown' | 'html' = 'text'): Promise<{ pageId: number; url: string; title: string; text: string; sourceLength: number; truncated: boolean }> {
    await this.launch();
    this.assertAllowed(pageId);
    const page = this.page(pageId);
    await this.claim(pageId);
    let shownLines: number | undefined;
    try {
      const expression = format === 'html' ? 'document.documentElement?.outerHTML ?? ""' : 'document.body?.innerText ?? ""';
      const text = await page.evaluate(expression) as string;
      const title = await page.title();
      const clipped = text.slice(0, limit ?? this.config.browser.readLimit);
      this.audit.record({ pageId, action: 'read', before: { url: page.url(), title }, after: { url: page.url(), title }, status: 'success', detail: { format, textLength: clipped.length, sourceLength: text.length, truncated: clipped.length < text.length } });
      shownLines = Math.ceil(clipped.length / 120);
      return { pageId, url: page.url(), title, text: clipped, sourceLength: text.length, truncated: clipped.length < text.length };
    } finally { this.release(pageId, shownLines); }
  }

  async act(input: ActInput): Promise<unknown> {
    return await meters.run(newMeter(), () => this.actMetered(input));
  }

  private meter(): InputMeter | undefined { const meter = meters.getStore(); return meter ? { ...meter } : undefined; }

  private async actMetered(input: ActInput): Promise<unknown> {
    await this.launch();
    this.assertAllowed(input.page);
    this.agentPage = input.page;
    const page = this.page(input.page);
    await this.claim(input.page);
    let shownLines: number | undefined;
    try {
      const before = await this.pageState(page);
      const previous = this.refs.get(input.page);
      const basis = this.basisFor(input);
      const target = this.safeTarget(input);
      const capabilities = this.actionCapabilities(input);
      const info = input.ref ? previous?.get(input.ref) : undefined;
      const commit = looksLikeCommit(info?.role, info?.name);
      const pacedMs = input.kind === 'copy' ? 0 : await this.pace({ pageId: input.page, kind: input.kind, commit });
      await this.captureDone(page);
      const started = this.audit.record({ pageId: input.page, action: input.kind, target, basisSnapshotId: basis?.snapshotId, basisSnapshotHash: basis?.hash, capabilities: [...capabilities, this.pacing.manifest], before, status: 'started', detail: { pacedMs } });
      const start = Date.now();
      try {
        if (input.kind === 'click' || input.kind === 'hover') {
          const point = await this.pointOf(input.page, required(input.ref, 'ref'));
          if (input.kind === 'click') await this.pointerInvoke({ page, x: point.x, y: point.y });
          else await this.pointerMove({ page, x: point.x, y: point.y }, 'hover');
        } else if (input.kind === 'fill') {
          if (!input.fields?.length) throw new Error('fields is required for fill: [{ ref, value }]');
          for (const [index, field] of input.fields.entries()) {
            if (index > 0) await this.pace({ pageId: input.page, kind: 'field', commit: false, index });
            await this.fillField(input.page, page, field.ref, field.value);
          }
        } else if (input.kind === 'select') {
          await this.choose(input.page, page, required(input.ref, 'ref'), required(input.value, 'value'));
        } else if (input.kind === 'type') {
          const value = required(input.value, 'value');
          const kind = input.ref ? await this.kindOf(input.page, input.ref) : undefined;
          // Selects, toggles and date-like inputs cannot take keystrokes meaningfully: route them through fill's dispatch.
          if (input.ref && kind && (kind.tag === 'SELECT' || ['checkbox', 'radio', 'date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(kind.type))) await this.fillField(input.page, page, input.ref, value);
          else {
            if (input.ref) await this.focusText(input.page, page, input.ref, false);
            await this.typeText(page, value);
          }
        } else if (input.kind === 'paste') {
          await this.focusText(input.page, page, required(input.ref, 'ref'), false);
          await this.clipboard.invoke({ page, text: input.value ?? await this.clipboard.read() });
        } else if (input.kind === 'copy') {
          const locator = this.locator(input.page, required(input.ref, 'ref'));
          const text = await locator.inputValue().catch(async () => await locator.textContent() ?? '');
          await this.clipboard.write(text);
        } else if (input.kind === 'press') {
          const key = required(input.key, 'key');
          if (key.length > 1 && !/^([A-Z][A-Za-z0-9]*|F\d+)(\+([A-Z][A-Za-z0-9]*|.))*$/.test(key)) throw new Error(`press takes a key name such as Enter, Tab, ArrowDown or Control+A; to enter text use kind "type" or "fill"`);
          await page.keyboard.press(key);
        } else if (input.kind === 'scroll') {
          const amount = (input.amount ?? 3) * 160;
          const delta = input.direction === 'up' || input.direction === 'left' ? -amount : amount;
          await page.mouse.wheel(input.direction === 'left' || input.direction === 'right' ? delta : 0, input.direction === 'left' || input.direction === 'right' ? 0 : delta);
        }
        await page.waitForTimeout(this.config.browser.settleMs);
        const readyState = await page.evaluate('document.readyState').catch(() => null);
        if (readyState === 'loading') await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
        await this.settle(page);
        const after = await this.pageState(page);
        if (input.kind === 'paste') { const meter = meters.getStore(); if (meter) meter.pastes++; }
        const event = this.audit.record({ pageId: input.page, action: input.kind, target, basisSnapshotId: basis?.snapshotId, basisSnapshotHash: basis?.hash, capabilities: [...capabilities, this.pacing.manifest], before, after, durationMs: Date.now() - start, status: 'success', detail: { pacedMs, input: this.meter() } });
        await this.capturePage(page, event);
        const changes = input.kind === 'copy' ? undefined : await this.changes(input.page, page, previous, before.url).catch(() => undefined) as { added?: string[]; changed?: string[]; snapshot?: string } | undefined;
        shownLines = changes ? changes.snapshot ? changes.snapshot.split('\n').length : (changes.added?.length ?? 0) + (changes.changed?.length ?? 0) : 0;
        // A page reached by submitting something cannot always be returned to; idle behaviour stays on it.
        if (after.url !== before.url) {
          if (commit || input.kind === 'press' || info?.role === 'submit') this.pinnedPages.set(input.page, 'shows the result of a submission');
          else this.pinnedPages.delete(input.page);
        }
        return { ok: true, traceId: event.id, before, after, changes, challenge: await this.settledHook(input.page) };
      } catch (error) {
        const failed = this.audit.record({ pageId: input.page, action: input.kind, target, basisSnapshotId: basis?.snapshotId, basisSnapshotHash: basis?.hash, capabilities: [...capabilities, this.pacing.manifest], before, durationMs: Date.now() - start, status: 'failure', error: message(error), detail: { pacedMs, input: this.meter() } });
        await this.capturePage(page, failed);
        throw error;
      }
    } finally { this.release(input.page, shownLines); }
  }

  private timeout(): number { return this.config.browser.actionTimeoutMs ?? 5000; }

  private async pointOf(pageId: number, ref: string): Promise<{ x: number; y: number }> {
    const locator = this.locator(pageId, ref);
    await locator.scrollIntoViewIfNeeded({ timeout: this.timeout() }).catch(() => undefined);
    const box = await locator.boundingBox({ timeout: this.timeout() });
    if (!box) throw new Error(`Target ${ref} is not visible; take a snapshot to see what is on screen`);
    return { x: box.x + box.width * (0.3 + Math.random() * 0.4), y: box.y + box.height * (0.3 + Math.random() * 0.4) };
  }

  private async kindOf(pageId: number, ref: string): Promise<{ tag: string; type: string; role: string; checked: boolean }> {
    return await this.locator(pageId, ref).evaluate(el => ({
      tag: el.tagName, type: (el as HTMLInputElement).type ?? '', role: el.getAttribute('role') ?? '', checked: Boolean((el as HTMLInputElement).checked)
    }), undefined, { timeout: this.timeout() });
  }

  /** Click into a text control, clear it if asked, leaving the caret ready for typing. */
  private async focusText(pageId: number, page: Page, ref: string, clear: boolean): Promise<void> {
    const point = await this.pointOf(pageId, ref);
    await this.pointerInvoke({ page, x: point.x, y: point.y });
    if (clear) { await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace'); }
  }

  /** fill dispatches by control type: text-like controls are typed, selects chosen, checkboxes/radios toggled, date-like set. */
  private async fillField(pageId: number, page: Page, ref: string, value: string): Promise<void> {
    const kind = await this.kindOf(pageId, ref);
    if (kind.tag === 'SELECT' || kind.role === 'combobox' && kind.tag !== 'INPUT') return await this.choose(pageId, page, ref, value);
    if (kind.type === 'checkbox' || kind.type === 'radio' || kind.role === 'checkbox' || kind.role === 'radio' || kind.role === 'switch') {
      const want = kind.type === 'radio' || kind.role === 'radio' ? true : !/^(false|0|no|off|unchecked|)$/i.test(value.trim());
      if (want !== kind.checked) { const point = await this.pointOf(pageId, ref); await this.pointerInvoke({ page, x: point.x, y: point.y }); }
      return;
    }
    if (['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(kind.type)) {
      const point = await this.pointOf(pageId, ref);
      await this.pointerMove({ page, x: point.x, y: point.y });
      await this.locator(pageId, ref).fill(value, { timeout: this.timeout() });
      return;
    }
    if (kind.type === 'file') throw new Error('File inputs need an upload action; fill cannot set files');
    await this.focusText(pageId, page, ref, true);
    await this.typeText(page, value);
  }

  /** Choose an option by its visible label (or value): native <select>, or a custom combobox opened and picked by pointer. */
  private async choose(pageId: number, page: Page, ref: string, value: string): Promise<void> {
    const locator = this.locator(pageId, ref);
    const kind = await this.kindOf(pageId, ref);
    const point = await this.pointOf(pageId, ref);
    if (kind.tag === 'SELECT') {
      await this.pointerMove({ page, x: point.x, y: point.y });
      const options = await locator.evaluate(el => Array.from((el as HTMLSelectElement).options).map(o => ({ label: (o.label || o.text).trim(), value: o.value })));
      const wanted = value.trim().toLowerCase();
      const match = options.find(o => o.label.toLowerCase() === wanted || o.value.toLowerCase() === wanted)
        ?? options.find(o => o.label.toLowerCase().includes(wanted) && wanted.length > 0);
      if (!match) throw new Error(`No option "${value}" in ${ref}; options: ${options.map(o => o.label).filter(Boolean).slice(0, 20).join(' | ')}`);
      await locator.selectOption({ value: match.value }, { timeout: this.timeout() });
      return;
    }
    await this.pointerInvoke({ page, x: point.x, y: point.y });
    await this.settle(page, 150, 1500);
    const option = page.getByRole('option', { name: value }).or(page.getByRole('menuitem', { name: value })).first();
    const box = await option.boundingBox({ timeout: this.timeout() }).catch(() => null);
    if (!box) throw new Error(`Opened ${ref} but no visible option named "${value}"; take a snapshot to read the options`);
    await this.pointerInvoke({ page, x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }

  /** User-held control lease: while paused every agent read/write and ambient movement is refused. */
  isPaused(): boolean { return this.paused; }
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.audit.record({ action: 'settings.control', status: 'info', detail: { paused } });
  }
  busyCount(): number { return this.busyPages.size; }
  pageCount(): number { return [...this.pages.values()].filter(page => !page.isClosed()).length; }

  private assertAllowed(pageId: number): void {
    if (this.paused) throw new Error('The user has paused automation in Waymark; wait for the user to resume before retrying.');
    this.guard(pageId);
  }

  getAmbientMouseState(): { enabled: boolean; moving: boolean } { return this.ambient.state(); }
  setAmbientMouseEnabled(enabled: boolean): void {
    this.config.browser.ambientMouse.enabled = enabled;
    if (enabled) this.ambient.start(); else this.ambient.stop();
    this.audit.record({ action: 'settings.ambientMouse', status: 'info', detail: { enabled } });
  }

  /** Pluggable capability slots: which registered providers can fill each one, and which is active. */
  slots(): Record<CapabilitySlot, { active: string; providers: Array<{ id: string; version: string; description: string; runtime: string }> }> {
    const result = {} as ReturnType<BrowserRuntime['slots']>;
    for (const slot of CAPABILITY_SLOTS) {
      result[slot] = {
        active: this.activeId(slot),
        providers: this.capabilities.list().filter(item => fitsSlot(slot, this.capabilities.get(item.id)))
          .map(({ id, version, description, runtime }) => ({ id, version, description, runtime }))
      };
    }
    return result;
  }

  setSlot(slot: CapabilitySlot, id: string): void {
    if (this.activeId(slot) === id) return;
    const provider = this.capabilities.get(id);
    if (!fitsSlot(slot, provider)) throw new Error(`${id} cannot fill the ${slot} slot`);
    if (slot === 'pointer') { this.actor = provider as unknown as PointerActor; this.config.capabilities.pointer = id; }
    else if (slot === 'keyboard') { this.keyboard = provider as unknown as KeyboardActor; this.config.capabilities.keyboard = id; }
    else if (slot === 'pacing') { this.pacing = provider as unknown as PacingModel; this.config.capabilities.pacing = id; }
    else if (slot === 'idle') { this.idle = provider as unknown as IdlePlanner; this.config.capabilities.idle = id; }
    else if (slot === 'clipboard') { this.clipboard = provider as unknown as ClipboardCapability; this.config.capabilities.clipboard = id; }
    else this.config.capabilities.challengeOcr = id;
    this.audit.record({ action: `settings.${slot}`, status: 'info', detail: { provider: id } });
  }

  private activeId(slot: CapabilitySlot): string {
    if (slot === 'pacing') return this.config.capabilities.pacing ?? 'action.pacing.human';
    if (slot === 'idle') return this.config.capabilities.idle ?? 'idle.adaptive';
    return slot === 'pointer' ? this.config.capabilities.pointer : slot === 'keyboard' ? this.config.capabilities.keyboard ?? 'action.keyboard.human' : slot === 'clipboard' ? this.config.capabilities.clipboard : this.config.capabilities.challengeOcr;
  }

  getPointerProviderId(): string { return this.config.capabilities.pointer; }

  getClipboardProviderId(): string { return this.config.capabilities.clipboard; }
  setClipboardProvider(id: string): void { this.setSlot('clipboard', id); }

  async findPageByUrl(fragment: string): Promise<Page> {
    await this.launch();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const page = this.context!.pages().find(item => item.url().includes(fragment));
      if (page) return page;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Electron page target not found: ${fragment}`);
  }

  async getPage(pageId: number): Promise<Page> { await this.launch(); return this.page(pageId); }
  lastSuccessfulActionId(): string | undefined { return this.audit.list(20).find(e => e.status === 'success' && e.pageId)?.id; }

  private async goto(page: Page, url: string): Promise<void> {
    if (!await this.handleNavigation?.(page, url)) await page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  private async newPage(url: string): Promise<PageSummary> {
    const context = this.context!;
    const page = this.pageFactory ? await this.pageFactory('about:blank') : await context.newPage();
    if (this.config.browser.automationViewport) await page.setViewportSize(this.config.browser.automationViewport);
    const id = this.register(page);
    await this.goto(page, url);
    this.activePage = id;
    return { id, url: page.url(), title: await page.title(), active: true };
  }

  private register(page: Page): number {
    if (!this.pageFilter(page)) return 0;
    const existing = this.ids.get(page);
    if (existing) return existing;
    const id = this.nextPageId++;
    this.ids.set(page, id);
    this.pages.set(id, page);
    if (!this.activePage) this.activePage = id;
    page.on('close', () => this.unregister(id));
    // A window registered before its first load (blank URL) is checked again once it has one.
    if (!page.url() || page.url() === 'about:blank') page.once('framenavigated', () => { if (!this.pageFilter(page)) this.unregister(id); });
    return id;
  }

  private unregister(id: number): void {
    const order = [...this.pages.keys()];
    const index = order.indexOf(id);
    this.pages.delete(id);
    this.refs.delete(id);
    this.busyPages.delete(id);
    this.observedAt.delete(id);
    this.shown.delete(id);
    this.fresh.delete(id);
    this.pinnedPages.delete(id);
    this.openers.delete(id);
    if (this.activePage === id) this.activePage = order[index + 1] ?? order[index - 1] ?? 0;
  }

  private page(id: number): Page {
    const page = this.pages.get(id);
    if (!page || page.isClosed()) throw new Error(`Unknown or closed page: ${id}`);
    return page;
  }

  private async listPages(): Promise<PageSummary[]> {
    const result: PageSummary[] = [];
    for (const [id, page] of this.pages) {
      if (page.isClosed()) continue;
      const opener = this.openers.get(id);
      result.push({ id, url: page.url(), title: await page.title(), active: id === this.activePage, ...(opener ? { openedBy: { agent: opener.agent, session: opener.session, window: opener.window } } : {}) });
    }
    return result;
  }

  private locator(pageId: number, ref: string) {
    const info = this.refs.get(pageId)?.get(ref);
    if (!info) throw new Error(`Stale or unknown ref ${ref}; take a fresh snapshot`);
    return this.page(pageId).locator(`[data-agent-ref="${ref}"]`);
  }

  private basisFor(input: ActInput): { snapshotId: string; hash?: string } | undefined {
    const ref = input.ref ?? input.fields?.[0]?.ref;
    if (!ref) return undefined;
    const info = this.refs.get(input.page)?.get(ref);
    if (!info) throw new Error(`Stale or unknown ref ${ref}; take a fresh snapshot`);
    return { snapshotId: info.snapshotId, hash: this.snapshotHashes.get(info.snapshotId) };
  }

  private actionCapabilities(input: ActInput): Array<{ id: string; version: string }> {
    if (input.kind === 'click' || input.kind === 'hover' || input.kind === 'select') return [this.actor.manifest];
    if (input.kind === 'fill' || input.kind === 'type') return [this.actor.manifest, this.keyboard.manifest];
    if (input.kind === 'paste' || input.kind === 'copy') return [this.clipboard.manifest];
    return [];
  }

  private safeTarget(input: ActInput): unknown {
    if (input.kind === 'fill') return { fields: input.fields?.map(f => ({ ref: f.ref, valueLength: f.value.length })) };
    if (input.kind === 'paste' || input.kind === 'type' || input.kind === 'select') return { ref: input.ref, valueLength: input.value?.length };
    if (input.kind === 'copy') return { ref: input.ref };
    return { ref: input.ref, key: input.key, direction: input.direction, amount: input.amount };
  }

  private async pageState(page: Page): Promise<{ url: string; title: string }> { return { url: page.url(), title: await page.title() }; }

  private resolveExecutable(): string | undefined {
    if (this.config.browser.executablePath !== 'auto') return fromRoot(this.config.browser.executablePath);
    const local = process.env.LOCALAPPDATA ?? '';
    const candidates = process.platform === 'win32' ? [
      `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ] : process.platform === 'darwin' ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
    const found = candidates.find(existsSync);
    if (!found) throw new Error('No Chromium executable found; set browser.executablePath');
    return found;
  }
}

function required(value: string | undefined, name: string): string { if (!value) throw new Error(`${name} is required`); return value; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
/** Hash of what the page showed, without the per-capture snapshot id, so identical page states compare equal. */
function contentHash(text: string): string { return createHash('sha256').update(text.replace(/^Snapshot: .*$/m, '')).digest('hex').slice(0, 16); }
