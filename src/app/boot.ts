import type { BrowserContext, Page } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../types.js';
import { AuditLog } from '../audit/AuditLog.js';
import { BrowserRuntime } from '../browser/BrowserRuntime.js';
import { ChallengeBroker } from '../challenge/ChallengeBroker.js';
import { createCapabilities } from '../capabilities/local.js';
import { startServer } from '../server.js';
import { agentLabel } from '../audit/Actor.js';
import { applyRetention } from '../audit/retention.js';
import { runAs, SYSTEM_ACTOR } from '../audit/Actor.js';

/** What the runtime needs from the desktop shell (electron-main.ts's agentShell), however it reaches it. */
export interface ShellBridge {
  createTab(token: string): Promise<number>;
  activate(id: number): Promise<void>;
  close(id: number): Promise<void>;
  setOwner(id: number, owner: 'agent' | 'user'): Promise<void>;
  setAgent(id: number, label: string): Promise<void>;
  openWindow(kind: 'agents' | 'insights', query: string): Promise<boolean>;
  visibleTab(): Promise<{ id: number; url: string } | null>;
}

/**
 * Wire the runtime, the challenge broker and the local server to the desktop shell. Used both when Playwright drives
 * Electron from a separate Node process (tests) and when the runtime lives inside Electron's own main process.
 */
export async function bootRuntime(config: AppConfig, context: BrowserContext, bridge: ShellBridge, closeApp: () => Promise<void>) {
  const capabilities = await createCapabilities(config);
  const audit = new AuditLog(config.audit.directory);
  applyRetention(audit, config);
  const runtime = new BrowserRuntime(config, audit, capabilities, { context, close: closeApp });
  const pageToWebContents = new Map<Page, number>();
  runtime.setPageHooks({
    filter: page => !page.url().includes('agent-shell=1') && !page.url().includes('waymark-window=1') && !page.url().startsWith('devtools://'),
    factory: async () => {
      const token = randomUUID();
      const id = await bridge.createTab(token);
      const page = await runtime.findPageByUrl(token);
      pageToWebContents.set(page, id);
      return page;
    },
    activate: async page => { const id = pageToWebContents.get(page); if (id) await bridge.activate(id); },
    close: async page => { const id = pageToWebContents.get(page); if (id) await bridge.close(id); }
  });
  runtime.setVisibleTabResolver(async () => {
    const visible = await bridge.visibleTab();
    if (!visible) return [];
    for (const [page, id] of pageToWebContents) if (id === visible.id) { const pageId = runtime.idOf(page); return pageId ? [pageId] : []; }
    // A tab the user opened is not in the map: every tab showing the same URL counts as visible.
    return runtime.pageIdsWithUrl(visible.url);
  });
  runtime.setTabOpenedHook(async (_pageId, actor, page) => {
    const id = pageToWebContents.get(page);
    if (id && actor && actor.agent !== 'unknown') await bridge.setAgent(id, agentLabel(actor.agent));
  });
  const challenges = new ChallengeBroker(runtime, config, capabilities);
  // Startup steps (opening the start page) are Waymark's own, not an unknown agent's.
  return await runAs(SYSTEM_ACTOR, async () => {
  await runtime.launch();
  const server = await startServer(config, runtime, challenges, { openWindow: async (kind, query) => await bridge.openWindow(kind, query ?? '') });
  // Reuse the blank page created at launch for the home page, and hand it to the user rather than labelling it as an AI tab.
  const homeUrl = `http://${config.server.host}:${config.server.port}/home`;
  const startup = await runtime.tabs('list') as Array<{ id: number; url: string }>;
  const blank = startup.length === 1 && startup[0].url.startsWith('about:blank') ? startup[0] : undefined;
  const home = blank ? (await runtime.navigateAction(blank.id, 'url', homeUrl), blank) : await runtime.tabs('new', undefined, homeUrl) as { id: number };
  const homeWebContents = pageToWebContents.get(await runtime.getPage(home.id));
  if (homeWebContents) await bridge.setOwner(homeWebContents, 'user');
  console.log('Waymark is running with native WebContentsView tabs.');
  // Warm the OCR model once the window is up and idle, so the first CAPTCHA is not a cold start.
  setTimeout(() => challenges.prepare('startup'), 3000).unref();
  return { runtime, server, challenges, capabilities };
  });
}
