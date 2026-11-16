import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { BrowserRuntime } from '../src/browser/BrowserRuntime.js';
import { AuditLog } from '../src/audit/AuditLog.js';
import { createLocalCapabilities } from '../src/capabilities/local.js';
import type { AppConfig, PageSummary } from '../src/types.js';

class FakePage extends EventEmitter {
  closed = false;
  url() { return 'https://example.test/'; }
  async title() { return 'fixture'; }
  isClosed() { return this.closed; }
  async bringToFront() {}
  async close() { this.closed = true; this.emit('close'); }
}

test('closing tabs preserves a live active page for CLI and ambient input', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'waymark-tabs-'));
  const config = JSON.parse(readFileSync('config/electron.json', 'utf8')) as AppConfig;
  config.browser.ambientMouse.enabled = false;
  const pages = [new FakePage(), new FakePage(), new FakePage()];
  const context = new EventEmitter() as EventEmitter & { pages: () => Page[] };
  context.pages = () => pages as unknown as Page[];
  const capabilities = createLocalCapabilities(config);
  const runtime = new BrowserRuntime(config, new AuditLog(directory), capabilities, {
    context: context as unknown as BrowserContext,
    close: async () => { for (const page of pages) await page.close(); }
  });
  const active = async () => (await runtime.tabs('list') as PageSummary[]).filter(page => page.active).map(page => page.id);
  try {
    await runtime.launch();
    await runtime.tabs('active', 2);
    await runtime.tabs('close', 2);
    assert.deepEqual(await active(), [3]);
    await pages[0].close();
    assert.deepEqual(await active(), [3]);
    await pages[2].close();
    assert.deepEqual(await active(), []);
    const replacement = new FakePage();
    context.emit('page', replacement);
    assert.deepEqual(await active(), [4]);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
