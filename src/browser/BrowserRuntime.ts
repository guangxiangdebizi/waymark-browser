import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AppConfig, PageSummary, RefInfo, SnapshotResult } from '../types.js';
import { fromRoot } from '../config.js';
import { AuditLog } from '../audit/AuditLog.js';
import type { PointerActor, PointerInput } from './InputActor.js';
import type { CapabilityRegistry } from '../capabilities/CapabilityRegistry.js';
import type { ClipboardCapability, ClipboardPasteInput } from '../capabilities/ClipboardProvider.js';
import { AmbientMouseController } from './AmbientMouseController.js';
import { CAPABILITY_SLOTS, fitsSlot, type CapabilitySlot } from '../capabilities/slots.js';

export interface ActInput {
  page: number;
  kind: 'click' | 'fill' | 'press' | 'scroll' | 'hover' | 'paste' | 'copy';
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
  private pageActivator?: (page: Page) => Promise<void>;
  private pageCloser?: (page: Page) => Promise<void>;
  private pageFilter: (page: Page) => boolean = () => true;
  private actor: PointerActor;
  private clipboard: ClipboardCapability;
  private busyPages = new Set<number>();
  private ambient: AmbientMouseController;
  private guard: (pageId: number) => void = () => undefined;
  private paused = false;
  private settledHook: (pageId: number) => Promise<unknown> = async () => null;

  constructor(private config: AppConfig, public audit: AuditLog, public capabilities: CapabilityRegistry, driver?: RuntimeDriver) {
    this.driver = driver;
    this.actor = capabilities.get<PointerInput, void>(config.capabilities.pointer) as unknown as PointerActor;
    this.clipboard = capabilities.get<ClipboardPasteInput, void>(config.capabilities.clipboard) as ClipboardCapability;
    this.ambient = new AmbientMouseController(
      config.browser.ambientMouse,
      () => { const page = this.pages.get(this.activePage); return page ? { id: this.activePage, page } : undefined; },
      pageId => this.busyPages.has(pageId),
      pageId => this.assertAllowed(pageId),
      () => this.actor,
      audit
    );
  }

  setPageHooks(hooks: { factory?: (url: string) => Promise<Page>; activate?: (page: Page) => Promise<void>; close?: (page: Page) => Promise<void>; filter?: (page: Page) => boolean }): void {
    this.pageFactory = hooks.factory;
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

  async tabs(action: 'list' | 'new' | 'close' | 'active', pageId?: number, url?: string): Promise<unknown> {
    await this.launch();
    if (action !== 'list' && this.paused) throw new Error('The user has paused automation in Waymark; wait for the user to resume before retrying.');
    if (action === 'new') {
      const created = await this.newPage(url ?? 'about:blank');
      this.audit.record({ pageId: created.id, action: 'tabs.new', target: { url }, after: { url: created.url, title: created.title }, status: 'success' });
      return created;
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
      this.pages.delete(pageId);
      this.refs.delete(pageId);
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
    const page = this.page(pageId);
    const before = await this.pageState(page);
    const started = this.audit.record({ pageId, action: 'navigate', target: { action, url }, before, status: 'started' });
    const start = Date.now();
    this.busyPages.add(pageId);
    try {
      if (action === 'url') { if (!url) throw new Error('url is required'); await page.goto(url, { waitUntil: 'domcontentloaded' }); }
      else if (action === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
      else if (action === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
      else await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(this.config.browser.settleMs);
      const after = await this.pageState(page);
      const event = this.audit.record({ pageId, action: 'navigate', target: { action, url }, before, after, durationMs: Date.now() - start, status: 'success' });
      return { pageId, ...after, traceId: event.id, challenge: await this.settledHook(pageId) };
    } catch (error) {
      this.audit.record({ pageId, action: 'navigate', target: { action, url }, before, durationMs: Date.now() - start, status: 'failure', error: message(error) });
      throw error;
    } finally { this.busyPages.delete(pageId); }
  }

  async snapshot(pageId: number): Promise<SnapshotResult> {
    await this.launch();
    this.assertAllowed(pageId);
    const page = this.page(pageId);
    const data = await page.evaluate(`(() => {
      document.querySelectorAll('[data-agent-ref]').forEach(el => el.removeAttribute('data-agent-ref'));
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const nameOf = (el) => (
        el.getAttribute('aria-label') || el.getAttribute('title') ||
        (el instanceof HTMLInputElement ? el.placeholder || (['button', 'submit', 'reset'].includes(el.type) ? el.value : '') : '') ||
        el.textContent || ''
      ).replace(/\\s+/g, ' ').trim().slice(0, 180);
      const selector = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="tab"],[contenteditable="true"]';
      const items = [];
      let index = 0;
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (!visible(el)) continue;
        const ref = 'e' + (++index);
        el.setAttribute('data-agent-ref', ref);
        const role = el.getAttribute('role') || (el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase());
        items.push({ ref, role, name: nameOf(el) });
      }
      const headings = Array.from(document.querySelectorAll('h1,h2,h3')).filter(visible)
        .map(el => el.tagName.toLowerCase() + ': ' + nameOf(el)).slice(0, 60);
      return { items, headings };
    })()`) as { items: Array<{ ref: string; role: string; name: string }>; headings: string[] };
    const id = randomUUID();
    const refs = new Map<string, RefInfo>();
    const lines = [`Page: ${await page.title()}`, `URL: ${page.url()}`, `Snapshot: ${id}`, '', ...data.headings, ''];
    for (const item of data.items) {
      const info = { ...item, snapshotId: id };
      refs.set(item.ref, info);
      lines.push(`[ref=${item.ref}] ${item.role} ${JSON.stringify(item.name)}`);
    }
    this.refs.set(pageId, refs);
    const saved = this.audit.saveSnapshot({ id, pageId, url: page.url(), title: await page.title(), text: lines.join('\n'), refs: Object.fromEntries(refs) });
    this.snapshotHashes.set(id, saved.hash);
    this.audit.record({ pageId, action: 'snapshot', target: { snapshotId: id, refCount: refs.size }, basisSnapshotId: id, basisSnapshotHash: saved.hash, before: { url: saved.url, title: saved.title }, after: { url: saved.url, title: saved.title }, status: 'success' });
    return saved;
  }

  async read(pageId: number, limit?: number, format: 'text' | 'markdown' | 'html' = 'text'): Promise<{ pageId: number; url: string; title: string; text: string; sourceLength: number; truncated: boolean }> {
    await this.launch();
    this.assertAllowed(pageId);
    const page = this.page(pageId);
    const expression = format === 'html' ? 'document.documentElement?.outerHTML ?? ""' : 'document.body?.innerText ?? ""';
    const text = await page.evaluate(expression) as string;
    const title = await page.title();
    const clipped = text.slice(0, limit ?? this.config.browser.readLimit);
    this.audit.record({ pageId, action: 'read', before: { url: page.url(), title }, after: { url: page.url(), title }, status: 'success', detail: { format, textLength: clipped.length, sourceLength: text.length, truncated: clipped.length < text.length } });
    return { pageId, url: page.url(), title, text: clipped, sourceLength: text.length, truncated: clipped.length < text.length };
  }

  async act(input: ActInput): Promise<unknown> {
    await this.launch();
    this.assertAllowed(input.page);
    const page = this.page(input.page);
    const before = await this.pageState(page);
    const basis = this.basisFor(input);
    const target = this.safeTarget(input);
    const capabilities = this.actionCapabilities(input);
    const started = this.audit.record({ pageId: input.page, action: input.kind, target, basisSnapshotId: basis?.snapshotId, basisSnapshotHash: basis?.hash, capabilities, before, status: 'started' });
    const start = Date.now();
    this.busyPages.add(input.page);
    try {
      if (input.kind === 'click' || input.kind === 'hover') {
        const locator = this.locator(input.page, required(input.ref, 'ref'));
        await locator.scrollIntoViewIfNeeded();
        const box = await locator.boundingBox();
        if (!box) throw new Error('Target is not visible');
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        if (input.kind === 'click') await this.actor.invoke({ page, x: point.x, y: point.y });
        else await this.actor.move({ page, x: point.x, y: point.y }, 'hover');
      } else if (input.kind === 'fill') {
        if (!input.fields?.length) throw new Error('fields is required for fill');
        for (const field of input.fields) {
          const locator = this.locator(input.page, field.ref);
          await locator.scrollIntoViewIfNeeded();
          await locator.click();
          await page.keyboard.press('Control+A');
          await page.keyboard.type(field.value, { delay: 8 });
        }
      } else if (input.kind === 'paste') {
        const locator = this.locator(input.page, required(input.ref, 'ref'));
        await locator.click();
        await this.clipboard.invoke({ page, text: input.value ?? await this.clipboard.read() });
      } else if (input.kind === 'copy') {
        const locator = this.locator(input.page, required(input.ref, 'ref'));
        const text = await locator.inputValue().catch(async () => await locator.textContent() ?? '');
        await this.clipboard.write(text);
      } else if (input.kind === 'press') {
        await page.keyboard.press(required(input.key, 'key'));
      } else if (input.kind === 'scroll') {
        const amount = (input.amount ?? 3) * 160;
        const delta = input.direction === 'up' || input.direction === 'left' ? -amount : amount;
        await page.mouse.wheel(input.direction === 'left' || input.direction === 'right' ? delta : 0, input.direction === 'left' || input.direction === 'right' ? 0 : delta);
      }
      await page.waitForTimeout(this.config.browser.settleMs);
      const readyState = await page.evaluate('document.readyState').catch(() => null);
      if (readyState === 'loading') await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
      const after = await this.pageState(page);
      const event = this.audit.record({ pageId: input.page, action: input.kind, target, basisSnapshotId: basis?.snapshotId, basisSnapshotHash: basis?.hash, capabilities, before, after, durationMs: Date.now() - start, status: 'success' });
      return { ok: true, traceId: event.id, before, after, challenge: await this.settledHook(input.page) };
    } catch (error) {
      this.audit.record({ pageId: input.page, action: input.kind, target, basisSnapshotId: basis?.snapshotId, basisSnapshotHash: basis?.hash, capabilities, before, durationMs: Date.now() - start, status: 'failure', error: message(error) });
      throw error;
    } finally { this.busyPages.delete(input.page); }
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
    else if (slot === 'clipboard') { this.clipboard = provider as unknown as ClipboardCapability; this.config.capabilities.clipboard = id; }
    else this.config.capabilities.challengeOcr = id;
    this.audit.record({ action: `settings.${slot}`, status: 'info', detail: { provider: id } });
  }

  private activeId(slot: CapabilitySlot): string {
    return slot === 'pointer' ? this.config.capabilities.pointer : slot === 'clipboard' ? this.config.capabilities.clipboard : this.config.capabilities.challengeOcr;
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

  private async newPage(url: string): Promise<PageSummary> {
    const context = this.context!;
    const page = this.pageFactory ? await this.pageFactory('about:blank') : await context.newPage();
    if (this.config.browser.automationViewport) await page.setViewportSize(this.config.browser.automationViewport);
    const id = this.register(page);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
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
    page.on('close', () => { this.pages.delete(id); this.refs.delete(id); });
    return id;
  }

  private page(id: number): Page {
    const page = this.pages.get(id);
    if (!page || page.isClosed()) throw new Error(`Unknown or closed page: ${id}`);
    return page;
  }

  private async listPages(): Promise<PageSummary[]> {
    const result: PageSummary[] = [];
    for (const [id, page] of this.pages) if (!page.isClosed()) result.push({ id, url: page.url(), title: await page.title(), active: id === this.activePage });
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
    if (input.kind === 'click' || input.kind === 'hover') return [this.actor.manifest];
    if (input.kind === 'paste' || input.kind === 'copy') return [this.clipboard.manifest];
    return [];
  }

  private safeTarget(input: ActInput): unknown {
    if (input.kind === 'fill') return { fields: input.fields?.map(f => ({ ref: f.ref, valueLength: f.value.length })) };
    if (input.kind === 'paste') return { ref: input.ref, valueLength: input.value?.length };
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




