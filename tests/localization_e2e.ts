import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTranslator, languageCodes } from '../src/i18n.js';
import { startWaymark } from '../src/app/start.js';

const directory = mkdtempSync(join(tmpdir(), 'waymark-languages-'));
const output = resolve('.research/readme-en');
mkdirSync(output, { recursive: true });
const fixture = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  const name = req.url === '/challenge' ? 'challenge' : 'basic';
  res.end(readFileSync(`tests/fixtures/${name}.html`, 'utf8'));
});
await new Promise<void>(done => fixture.listen(0, '127.0.0.1', done));
const fixturePort = (fixture.address() as { port: number }).port;
const probe = createServer();
await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
const port = (probe.address() as { port: number }).port;
await new Promise<void>(done => probe.close(() => done()));
const config = JSON.parse(readFileSync('config/electron.json', 'utf8'));
config.server.port = port;
config.settingsFile = join(directory, 'settings.json');
config.browser.userDataDir = join(directory, 'profile');
config.audit.directory = join(directory, 'audit');
config.challenge.pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
const configFile = join(directory, 'config.json');
writeFileSync(configFile, JSON.stringify(config));
process.env.WAYMARK_CONFIG = configFile;
const base = `http://127.0.0.1:${port}`;
const post = async (path: string, body: unknown) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});
let app = await startWaymark();
const errors: string[] = [];
function trackErrors() {
  app.electronApp.context().on('page', page => page.on('pageerror', error => errors.push(error.message)));
  for (const page of app.electronApp.context().pages()) page.on('pageerror', error => errors.push(error.message));
}
trackErrors();
try {
  let shell = await app.electronApp.firstWindow();
  await shell.waitForFunction(() => document.getElementById('mcp-state')?.textContent?.includes('MCP online'));
  const home = app.electronApp.context().pages().find(page => page.url() === base + '/home')!;
  const auditTab = await app.runtime.tabs('new', undefined, base + '/audit') as { id: number };
  const audit = await app.runtime.getPage(auditTab.id);
  for (const locale of languageCodes) {
    await shell.locator('#panel-tabs [data-view=settings]').click();
    await shell.locator('#language').selectOption(locale);
    await shell.waitForFunction(locale => document.documentElement.lang === locale && (document.getElementById('language') as HTMLSelectElement)?.value === locale, locale);
    for (const page of [home, audit]) await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
    await shell.waitForFunction(text => document.getElementById('pause-btn')?.textContent === text, createTranslator(locale).t('暂停 AI'));
    assert.equal(JSON.parse(readFileSync(config.settingsFile, 'utf8')).uiLanguage, locale);
    assert.equal(await home.locator('title').textContent(), createTranslator(locale).t('新标签页'));
    assert.equal(await audit.locator('header .title b').textContent(), createTranslator(locale).t('溯源记录'));
    console.log(`UI LANGUAGE PASS: ${locale}`);
  }
  const invalid = await post('/api/settings', { uiLanguage: 'unsupported' });
  assert.equal(invalid.status, 400);
  assert.equal(JSON.parse(readFileSync(config.settingsFile, 'utf8')).uiLanguage, 'pt');

  await shell.locator('#language').selectOption('zh-CN');
  await shell.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  await app.runtime.close();
  await app.closed;
  app = await startWaymark();
  trackErrors();
  shell = await app.electronApp.firstWindow();
  await shell.waitForFunction(() => document.documentElement.lang === 'zh-CN' && document.getElementById('mcp-state')?.textContent?.includes('MCP 在线'));
  assert.equal(app.config.uiLanguage, 'zh-CN');
  console.log('LANGUAGE PERSISTENCE PASS: full app restart');
  await shell.locator('#panel-tabs [data-view=settings]').click();
  await shell.locator('#language').selectOption('en');
  await shell.waitForFunction(() => document.documentElement.lang === 'en' && document.getElementById('mcp-state')?.textContent?.includes('MCP online'));

  app.runtime.audit.setSession('README demo');
  const demo = await app.runtime.tabs('new', undefined, `http://127.0.0.1:${fixturePort}/`) as { id: number };
  const snapshot = await app.runtime.snapshot(demo.id);
  const refs = Object.values(snapshot.refs);
  const input = refs.find(ref => ref.name === 'Search value')!;
  const button = refs.find(ref => ref.name === 'Run search')!;
  await app.runtime.act({ page: demo.id, kind: 'fill', fields: [{ ref: input.ref, value: 'Waymark' }] });
  await app.runtime.act({ page: demo.id, kind: 'click', ref: button.ref });
  const read = await app.runtime.read(demo.id);
  assert.ok(read.text.includes('hello Waymark'));
  await app.runtime.tabs('close', demo.id);
  await shell.locator('#panel-tabs [data-view=activity]').click();
  await shell.waitForFunction(() => document.querySelector('#timeline')?.textContent?.includes('Click'));
  await shell.waitForFunction(() => document.getElementById('control-sub')?.textContent?.includes('README demo'));
  const currentHome = app.electronApp.context().pages().find(page => page.url() === base + '/home')!;
  await currentHome.waitForFunction(() => document.getElementById('s-ai')?.textContent?.includes('Ready'));
  const status = await (await fetch(base + '/api/status')).json();
  await currentHome.waitForFunction(count => document.getElementById('s-today')?.textContent === count + ' actions', status.todayActions);
  if (process.platform === 'linux') {
    // Capture the native window, including child WebContentsViews, not just the shell surface.
    const bounds = await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.focus();
      return window.getBounds();
    });
    execFileSync('scrot', ['-a', `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, join(output, 'main.png')]);
  } else {
    const image = await app.electronApp.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const bounds = window.getBounds();
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: bounds.width, height: bounds.height } });
      const source = sources.find(source => source.id === window.getMediaSourceId());
      if (!source || source.thumbnail.isEmpty()) throw new Error('Native window capture unavailable');
      return source.thumbnail.toPNG().toString('base64');
    });
    writeFileSync(join(output, 'main.png'), Buffer.from(image, 'base64'));
  }
  await shell.locator('#panel-tabs [data-view=settings]').click();
  await shell.locator('#slots .model').first().waitFor();
  await shell.locator('.view[data-view=settings] .group').nth(2).screenshot({ path: join(output, 'models.png') });

  const challengePage = await app.runtime.tabs('new', undefined, `http://127.0.0.1:${fixturePort}/challenge`) as { id: number };
  await app.runtime.navigateAction(challengePage.id, 'reload');
  await shell.locator('#panel-tabs [data-view=challenges]').click();
  await shell.locator('#challenges .card').first().waitFor();
  await shell.locator('#challenges').screenshot({ path: join(output, 'challenges.png') });

  const auditPage = await app.runtime.tabs('new', undefined, base + '/audit') as { id: number };
  const page = await app.runtime.getPage(auditPage.id);
  await page.locator('#events .row').first().waitFor();
  await page.screenshot({ path: join(output, 'audit.png'), fullPage: true });
  for (const width of [320, 768, 1024, 1440]) {
    for (const surface of [page, currentHome]) {
      await surface.setViewportSize({ width, height: 900 });
      const overflow = await surface.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(overflow, false, `${surface.url()} overflows at ${width}px`);
    }
  }
  assert.deepEqual(errors, [], 'renderer JavaScript errors');
  console.log('LOCALIZATION E2E PASS: eight languages, persistence, invalid locale, live actions, English screenshots');
} finally {
  await app.runtime.close();
  await app.closed;
  await new Promise<void>(done => fixture.close(() => done()));
}
