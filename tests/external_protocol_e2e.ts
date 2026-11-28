import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import electronPath from 'electron';
import { _electron } from 'playwright-core';

const dir = mkdtempSync(join(tmpdir(), 'waymark-protocol-'));
const config = JSON.parse(readFileSync('config/electron.json', 'utf8'));
config.browser.userDataDir = join(dir, 'profile');
config.settingsFile = join(dir, 'settings.json');
writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
const app = await _electron.launch({
  executablePath: String(electronPath),
  args: [...(process.env.WAYMARK_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean), resolve('tests/fixtures/external-protocol-main.mjs')],
  env: { ...process.env, WAYMARK_CONFIG: join(dir, 'config.json'), WAYMARK_INPROCESS: '0' }
});
try {
  await app.firstWindow();
  const create = async (name: string) => {
    const pending = app.context().waitForEvent('page');
    const id: number = await app.evaluate((_e, token) => (globalThis as any).agentShell.createTab(token), name);
    const page = await pending;
    await page.waitForURL('about:blank#' + name);
    await page.setContent('<button>Go</button>');
    return { page, id };
  };
  const decision = async (url: string, allow: boolean) => {
    const end = Date.now() + 5000;
    do {
      const result = await app.evaluate((_e, target) => (globalThis as any).externalDecisions.find(([u]: [string]) => u === target), url);
      if (result) { assert.equal(result[1], allow, url); return; }
      await delay(50);
    } while (Date.now() < end);
    assert.fail('No permission callback for ' + url);
  };
  const a = await create('test-a');
  const b = await create('test-b');
  await a.page.evaluate(() => { location.href = 'waymark-test://automatic'; });
  await decision('waymark-test://automatic', false);
  await a.page.evaluate(() => {
    const button = document.querySelector('button')!;
    button.onclick = () => { location.href = 'waymark-test://synthetic'; };
    button.click();
  });
  await decision('waymark-test://synthetic', false);
  await a.page.evaluate(() => { document.querySelector('button')!.onclick = () => { location.href = 'waymark-test://click'; }; });
  await a.page.locator('button').click();
  await decision('waymark-test://click', true);
  await b.page.evaluate(() => { location.href = 'waymark-test://other-tab'; });
  await decision('waymark-test://other-tab', false);
  await a.page.evaluate(() => { const f = document.createElement('iframe'); f.src = 'waymark-test://frame'; document.body.append(f); });
  await decision('waymark-test://frame', true);
  const count = app.context().pages().length;
  await a.page.evaluate(() => { window.open('waymark-test://popup'); });
  await app.evaluate((_e, id) => (globalThis as any).agentShell.navigate(id, 'waymark-missing://direct'), a.id);
  await decision('waymark-missing://direct', false);
  assert.equal(app.context().pages().length, count);
  assert.equal(await app.evaluate(() => (globalThis as any).externalDecisions.some(([u, ok]: [string, boolean]) => u === 'waymark-test://popup' && ok)), false);
  await app.evaluate((_e, id) => (globalThis as any).agentShell.openDirectExternal(id, 'waymark-test://direct'), b.id);
  await decision('waymark-test://direct', true);
  await app.evaluate((_e, id) => (globalThis as any).agentShell.navigate(id, 'waymark-test://address'), a.id);
  await decision('waymark-test://address', true);
  console.log('External protocol Electron E2E passed');
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
