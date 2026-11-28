import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';
import { resolve } from 'node:path';
import { loadConfig, env } from '../config.js';
import { bootRuntime, type ShellBridge } from './boot.js';

/**
 * Test and development harness: Electron is started and driven by Playwright from this Node process, which also hosts
 * the runtime. Production (`waymark start`) runs the runtime inside Electron's main process instead (inprocess.ts).
 */
export async function startWaymark() {
  process.env.WAYMARK_CONFIG ??= process.env.AGENT_BROWSER_CONFIG ?? './config/electron.json';
  const config = loadConfig();
  const electronApp = await electron.launch({ executablePath: electronPath as unknown as string, args: [...(env('ELECTRON_ARGS')?.split(/\s+/).filter(Boolean) ?? []), resolve('dist/app/electron-main.js')], cwd: process.cwd() });
  await electronApp.firstWindow();
  const shell = <T>(name: string, ...args: unknown[]) => electronApp.evaluate(async (_electron, value) => (globalThis as any).agentShell[value.name](...value.args), { name, args }) as Promise<T>;
  const bridge: ShellBridge = {
    createTab: token => shell('createTab', token, 'about:blank'),
    openDirectExternal: (tab, url) => shell('openDirectExternal', tab, url),
    activate: id => shell('activate', id),
    close: id => shell('close', id),
    setOwner: (id, owner) => shell('setOwner', id, owner),
    setAgent: (id, label) => shell('setAgent', id, label),
    openWindow: (kind, query) => shell('openWindow', kind, query)
  };
  const { runtime, server, capabilities } = await bootRuntime(config, electronApp.context(), bridge, () => electronApp.close());
  const closed = new Promise<void>(resolveClose => electronApp.once('close', resolveClose)).then(async () => {
    await server.close();
    await capabilities.close();
  });
  return { electronApp, runtime, config, closed };
}
