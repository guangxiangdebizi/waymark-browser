import { chromium } from 'playwright-core';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../types.js';
import { bootRuntime, type ShellBridge } from './boot.js';

/**
 * Production mode: the runtime runs inside Electron's main process and drives the tabs over the browser's own
 * DevTools endpoint (loopback only, random port), so Waymark is one application process instead of a Node process
 * plus Electron. Started by electron-main.ts when WAYMARK_INPROCESS=1.
 */
export async function startInProcess(config: AppConfig, userData: string, shell: Record<string, (...args: any[]) => any>, quit: () => void) {
  const portFile = join(userData, 'DevToolsActivePort');
  let endpoint = '';
  for (let i = 0; i < 300 && !endpoint; i++) {
    if (existsSync(portFile)) {
      const [port] = readFileSync(portFile, 'utf8').split(/\r?\n/);
      if (/^\d+$/.test(port)) endpoint = `http://127.0.0.1:${port}`;
    }
    if (!endpoint) await new Promise(r => setTimeout(r, 50));
  }
  if (!endpoint) throw new Error('DevTools endpoint did not come up');
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const call = async <T>(name: string, ...args: unknown[]) => await shell[name](...args) as T;
  const bridge: ShellBridge = {
    createTab: token => call('createTab', token, 'about:blank'),
    activate: id => call('activate', id),
    close: id => call('close', id),
    setOwner: (id, owner) => call('setOwner', id, owner),
    setAgent: (id, label) => call('setAgent', id, label),
    openWindow: (kind, query) => call('openWindow', kind, query)
  };
  const booted = await bootRuntime(config, context, bridge, async () => { quit(); });
  return {
    ...booted,
    async shutdown() {
      await booted.server.close().catch(() => undefined);
      await booted.capabilities.close().catch(() => undefined);
    }
  };
}
