import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig } from './types.js';
import { normalizeLanguage } from './i18n.js';

/** WAYMARK_* is the public prefix; AGENT_BROWSER_* is still honoured for setups created before the rename. */
export function env(name: string): string | undefined {
  return process.env[`WAYMARK_${name}`] ?? process.env[`AGENT_BROWSER_${name}`];
}

export function loadConfig(): AppConfig {
  const path = env('CONFIG') ?? './config/development.json';
  const config = JSON.parse(readFileSync(resolve(path), 'utf8').replace(/^\uFEFF/, '')) as AppConfig;
  if (existsSync(resolve(config.settingsFile))) {
    const local = JSON.parse(readFileSync(resolve(config.settingsFile), 'utf8').replace(/^\uFEFF/, '')) as { uiLanguage?: string; capabilities?: { clipboard?: string; pointer?: string; keyboard?: string; challengeOcr?: string; plugins?: AppConfig['capabilities']['plugins'] }; browser?: { ambientMouse?: { enabled?: boolean } }; home?: AppConfig['home'] };
    if (typeof local.uiLanguage === 'string') config.uiLanguage = local.uiLanguage;
    const selected = local.capabilities?.clipboard;
    // Provider ids are validated once plugins are loaded (createCapabilities); unknown ids fall back to the defaults.
    if (typeof selected === 'string') config.capabilities.clipboard = selected;
    if (typeof local.capabilities?.challengeOcr === 'string') config.capabilities.challengeOcr = local.capabilities.challengeOcr;
    if (typeof local.capabilities?.pointer === 'string') config.capabilities.pointer = local.capabilities.pointer;
    if (typeof local.capabilities?.keyboard === 'string') config.capabilities.keyboard = local.capabilities.keyboard;
    if (Array.isArray(local.capabilities?.plugins)) config.capabilities.plugins = [...(config.capabilities.plugins ?? []), ...local.capabilities.plugins];
    if (typeof local.browser?.ambientMouse?.enabled === 'boolean') config.browser.ambientMouse.enabled = local.browser.ambientMouse.enabled;
    if (Array.isArray(local.home?.quickLinks)) config.home = { ...config.home, quickLinks: local.home.quickLinks };
  }
  if (env('PORT')) config.server.port = Number(env('PORT'));
  if (env('EXECUTABLE')) config.browser.executablePath = env('EXECUTABLE')!;
  if (env('HEADLESS')) config.browser.headless = env('HEADLESS') === '1';
  if (env('PYTHON')) config.challenge.pythonCommand = env('PYTHON')!;
  else if (!existsSync(resolve(config.challenge.pythonCommand)) && existsSync(resolve('.venv/bin/python'))) config.challenge.pythonCommand = './.venv/bin/python';
  if (config.challenge.pythonFallback === 'python' && process.platform !== 'win32') config.challenge.pythonFallback = 'python3';
  config.capabilities.keyboard ??= 'action.keyboard.human';
  config.uiLanguage = normalizeLanguage(config.uiLanguage);
  return config;
}

export function fromRoot(path: string): string {
  return resolve(process.cwd(), path);
}
