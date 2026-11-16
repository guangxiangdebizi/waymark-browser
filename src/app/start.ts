import { _electron as electron, type Page } from 'playwright-core';
import electronPath from 'electron';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { loadConfig, env } from '../config.js';
import { AuditLog } from '../audit/AuditLog.js';
import { BrowserRuntime } from '../browser/BrowserRuntime.js';
import { ChallengeBroker } from '../challenge/ChallengeBroker.js';
import { createCapabilities } from '../capabilities/local.js';
import { startServer } from '../server.js';

export async function startWaymark() {
  process.env.WAYMARK_CONFIG ??= process.env.AGENT_BROWSER_CONFIG ?? './config/electron.json';
  const config = loadConfig();
  const electronApp = await electron.launch({ executablePath: electronPath as unknown as string, args: [...(env('ELECTRON_ARGS')?.split(/\s+/).filter(Boolean) ?? []), resolve('dist/app/electron-main.js')], cwd: process.cwd() });
  await electronApp.firstWindow();
  const capabilities = await createCapabilities(config);
  const runtime = new BrowserRuntime(config, new AuditLog(config.audit.directory), capabilities, { context: electronApp.context(), close: () => electronApp.close() });
  const pageToWebContents = new Map<Page, number>();
  
  runtime.setPageHooks({
    filter: page => !page.url().includes('agent-shell=1'),
    factory: async () => {
      const token = randomUUID();
      const id = await electronApp.evaluate(async (_electron, value) => (globalThis as any).agentShell.createTab(value, 'about:blank'), token) as number;
      const page = await runtime.findPageByUrl(token);
      pageToWebContents.set(page, id);
      return page;
    },
    activate: async page => {
      const id = pageToWebContents.get(page);
      if (id) await electronApp.evaluate(async (_electron, value) => (globalThis as any).agentShell.activate(value), id);
    },
    close: async page => {
      const id = pageToWebContents.get(page);
      if (id) await electronApp.evaluate(async (_electron, value) => (globalThis as any).agentShell.close(value), id);
    }
  });
  
  const challenges = new ChallengeBroker(runtime, config, capabilities);
  await runtime.launch();
  const server = await startServer(config, runtime, challenges);
  // Reuse the blank page created at launch for the home page, and hand it to the user rather than labelling it as an AI tab.
  const homeUrl = `http://${config.server.host}:${config.server.port}/home`;
  const startup = await runtime.tabs('list') as Array<{ id: number; url: string }>;
  const blank = startup.length === 1 && startup[0].url.startsWith('about:blank') ? startup[0] : undefined;
  const home = blank ? (await runtime.navigateAction(blank.id, 'url', homeUrl), blank) : await runtime.tabs('new', undefined, homeUrl) as { id: number };
  const homePage = await runtime.getPage(home.id);
  const homeWebContents = pageToWebContents.get(homePage);
  if (homeWebContents) await electronApp.evaluate(async (_electron, value) => (globalThis as any).agentShell.setOwner(value, 'user'), homeWebContents);
  console.log('Waymark is running with native WebContentsView tabs.');
  const closed = new Promise<void>(resolveClose => electronApp.once('close', resolveClose)).then(async () => {
    await server.close();
    await capabilities.close();
  });
  return { electronApp, runtime, config, closed };
}
