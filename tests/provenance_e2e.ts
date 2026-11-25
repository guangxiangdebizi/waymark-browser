// Real app, real agents: two CLI agents (Codex, Claude Code) and one MCP-session client (WorkBuddy) work in Waymark at
// the same time; the ledger, the agent manager and the insights dashboard must tell them apart. Screenshots of both
// windows go to .research/provenance/.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { startWaymark } from '../src/app/start.js';

const run = promisify(execFile);
const python = process.env.WAYMARK_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const directory = mkdtempSync(join(tmpdir(), 'waymark-provenance-'));
const output = resolve('.research/provenance');
mkdirSync(output, { recursive: true });
if (!existsSync('data/ocr-smoke.png')) execFileSync(python, ['python/generate_ocr_fixture.py']);
const captcha = readFileSync('data/ocr-smoke.png').toString('base64');
const pages: Record<string, string> = {
  '/': readFileSync('tests/fixtures/basic.html', 'utf8'),
  '/shop': `<!doctype html><html><head><meta charset="utf-8"><title>Fixture shop</title></head><body><h1>Shop</h1><label>Size <select id="s"><option>Small</option><option>Large</option></select></label><button onclick="document.querySelector('#r').textContent='added '+document.querySelector('#s').value">Add to cart</button><div id="r"></div><p>${'Long product description. '.repeat(200)}</p></body></html>`,
  '/captcha': `<!doctype html><html><head><meta charset="utf-8"><title>OCR challenge</title></head><body><h1>安全验证</h1><form onsubmit="event.preventDefault();if(document.querySelector('[name=captcha]').value.toUpperCase()==='A7B2'){document.body.innerHTML='<h1>Verified challenge</h1>'}else{document.querySelector('#state').textContent='wrong'}"><img alt="captcha" src="data:image/png;base64,${captcha}"><input name="captcha" placeholder="验证码"><button type="submit">提交验证</button></form><div id="state"></div></body></html>`
};
const fixture = createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(pages[req.url ?? '/'] ?? pages['/']); });
await new Promise<void>(done => fixture.listen(0, '127.0.0.1', done));
const site = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
const probe = createServer();
await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
const port = (probe.address() as { port: number }).port;
await new Promise<void>(done => probe.close(() => done()));
const config = JSON.parse(readFileSync('config/electron.json', 'utf8'));
config.server.port = port;
config.settingsFile = join(directory, 'settings.json');
config.browser.userDataDir = join(directory, 'profile');
config.audit.directory = join(directory, 'audit');
config.audit.captureScreenshots = true;
config.challenge.pythonCommand = python;
config.challenge.timeoutMs = 60000;
config.uiLanguage = process.env.WAYMARK_E2E_LANG ?? 'zh-CN';
writeFileSync(config.settingsFile, JSON.stringify({ uiLanguage: config.uiLanguage }));
const configFile = join(directory, 'config.json');
writeFileSync(configFile, JSON.stringify(config));
process.env.WAYMARK_CONFIG = configFile;
const base = `http://127.0.0.1:${port}`;

/** The Python CLI, run the way an agent would run it. */
async function waymark(identity: string[], ...args: string[]): Promise<any> {
  const env = { ...process.env, PYTHONPATH: resolve('cli/src'), PYTHONIOENCODING: 'utf-8' };
  for (const key of Object.keys(env)) if (/^(CLAUDE|CODEX|AI_AGENT|CURSOR|WAYMARK_(AGENT|SESSION|WINDOW))/.test(key)) delete env[key];
  const { stdout } = await run(python, ['-m', 'waymark_browser', '--url', base, ...identity, '--json', ...args], { env, maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(stdout);
}

/** A minimal MCP client that keeps its session, like Claude Code or Codex do over HTTP. */
async function mcpSession(name: string) {
  let session: string | null = null;
  let id = 0;
  const send = async (method: string, params?: unknown, notify = false) => {
    const response = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26', ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++id, method, params })
    });
    session ??= response.headers.get('mcp-session-id');
    const text = await response.text();
    const line = text.split('\n').find(item => item.startsWith('data:'));
    return line ? JSON.parse(line.slice(5)) : undefined;
  };
  await send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name, version: '1.0.0' } });
  await send('notifications/initialized', undefined, true);
  return async (tool: string, args: unknown = {}) => {
    const reply = await send('tools/call', { name: tool, arguments: args });
    const text: string = reply.result.content[0].text;
    const body = JSON.parse(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n[END_UNTRUSTED')));
    if (reply.result.isError) throw new Error(body.error);
    return body;
  };
}

const refOf = (snapshot: any, name: string) => (Object.values(snapshot.refs) as Array<{ ref: string; name: string }>).find(ref => ref.name.includes(name))!.ref;

const app = await startWaymark();
const errors: string[] = [];
app.electronApp.context().on('page', page => page.on('pageerror', error => errors.push(`${page.url()}: ${error.message}`)));
try {
  const shell = await app.electronApp.firstWindow();
  await shell.waitForFunction(() => document.getElementById('mcp-state')?.textContent?.match(/MCP/));
  const codex = ['--agent', 'codex', '--session', 'codex-checkout', '--window', 'codex #1'];
  const claude = ['--agent', 'claude-code', '--session', 'cc-research', '--window', 'claude #2'];
  const workbuddy = await mcpSession('WorkBuddy');

  const codexWork = (async () => {
    await waymark(codex, 'name', '比价下单流程');
    const tab = await waymark(codex, 'open', site + '/shop');
    for (let i = 0; i < 3; i++) {
      await waymark(codex, 'goto', String(tab.id), site + '/shop');
      const snap = await waymark(codex, 'snapshot', String(tab.id));
      await waymark(codex, 'snapshot', String(tab.id));
      await waymark(codex, 'select', String(tab.id), refOf(snap, 'Size'), 'Large');
      await waymark(codex, 'click', String(tab.id), refOf(snap, 'Add to cart'));
    }
    await waymark(codex, 'click', String(tab.id), 'e999').catch(() => undefined);
    const shot = await waymark(codex, 'screenshot', String(tab.id), '-o', join(output, 'codex-tab.png'));
    assert.ok(shot.bytes > 1000);
    await waymark(codex, 'usage', '--input', '18000', '--output', '2400', '--model', 'gpt-5-codex');
    return tab.id as number;
  })();

  const claudeWork = (async () => {
    const tab = await waymark(claude, 'open', site + '/');
    const snap = await waymark(claude, 'snapshot', String(tab.id));
    await waymark(claude, 'fill', String(tab.id), refOf(snap, 'Search value'), 'Waymark provenance');
    await waymark(claude, 'click', String(tab.id), refOf(snap, 'Run search'));
    const page = await waymark(claude, 'read', String(tab.id));
    assert.match(page.text, /hello Waymark provenance/);
    const captchaTab = await waymark(claude, 'open', site + '/captcha');
    await waymark(claude, 'reload', String(captchaTab.id));
    const after = await waymark(claude, 'read', String(captchaTab.id));
    assert.match(after.text, /Verified challenge/, 'ddddocr should solve the fixture CAPTCHA');
    return tab.id as number;
  })();

  const workbuddyWork = (async () => {
    await workbuddy('name_session', { name: '资料整理', window: 'WorkBuddy 主窗口' });
    const tab = await workbuddy('tabs', { action: 'new', url: site + '/shop' });
    await workbuddy('read', { page: tab.id, limit: 500 });
    await workbuddy('act', { page: tab.id, kind: 'scroll', direction: 'down', amount: 3 });
    const who = await workbuddy('whoami');
    assert.equal(who.agent, 'workbuddy');
    assert.equal(who.identifiedBy, 'mcp-client');
    return tab.id as number;
  })();

  const [codexTab, claudeTab, workbuddyTab] = await Promise.all([codexWork, claudeWork, workbuddyWork]);
  // A person at a terminal: no agent marker, so the CLI says "human".
  const human = await waymark(['--agent', 'human'], 'whoami');
  assert.equal(human.waymark.agent, 'human');

  // The ledger: every step belongs to the right agent and session.
  const tree = await (await fetch(base + '/api/agents?days=1')).json();
  const byAgent = Object.fromEntries(tree.agents.map((a: any) => [a.agent, a]));
  for (const agent of ['codex', 'claude-code', 'workbuddy']) assert.ok(byAgent[agent], `${agent} missing from the manager`);
  assert.equal(byAgent.codex.sessions[0].label, '比价下单流程');
  assert.equal(byAgent.codex.sessions[0].window, 'codex #1');
  assert.equal(byAgent.codex.identity.declared, 1);
  assert.equal(byAgent.workbuddy.sessions[0].label, '资料整理');
  assert.equal(byAgent.workbuddy.identity['mcp-client'], 1);
  const codexSession = await (await fetch(base + '/api/sessions/' + encodeURIComponent(byAgent.codex.sessions[0].key))).json();
  assert.equal(codexSession.tabs.length, 1);
  assert.equal(codexSession.tabs[0].pageId, codexTab);
  assert.equal(codexSession.tabs[0].openedHere, true);
  assert.ok(codexSession.timeline.every((e: any) => e.actor.agent === 'codex'));
  assert.ok(codexSession.timeline.filter((e: any) => e.screenshot).length >= 6, 'trace screenshots');
  const shotEvent = codexSession.timeline.find((e: any) => e.screenshot);
  assert.equal((await fetch(base + '/api/audit/screens/' + shotEvent.screenshot)).headers.get('content-type'), 'image/jpeg');
  const claudeSession = await (await fetch(base + '/api/sessions/' + encodeURIComponent(byAgent['claude-code'].sessions[0].key))).json();
  assert.equal(claudeSession.tabs.length, 2);
  assert.ok(claudeSession.tabs.some((t: any) => t.pageId === claudeTab && t.openedHere));
  assert.ok(claudeSession.timeline.some((e: any) => e.action === 'challenge.ocr_filled'));
  const ledger = readFileSync(join(config.audit.directory, 'events.jsonl'), 'utf8');
  assert.equal(ledger.includes('Waymark provenance'), false, 'fill value leaked into the ledger');
  assert.equal(ledger.includes('do-not-record-this'), false, 'password leaked into the ledger');
  assert.equal(ledger.includes('A7B2') || /"a7b2"/i.test(ledger), false, 'OCR answer leaked into the ledger');

  // Insights: the numbers match what was done.
  const insights = await (await fetch(base + '/api/insights?days=1')).json();
  const metric = (id: string) => insights.metrics.find((m: any) => m.id === id).value;
  assert.equal(metric('ocrSolved'), 1);
  assert.equal(metric('ocrRuns'), 1);
  assert.ok(metric('pointerPaths') >= 7, `pointer paths ${metric('pointerPaths')}`);
  assert.ok(metric('humanKeystrokes') >= 'Waymark provenance'.length);
  assert.ok(metric('tokensReported') === 20400);
  assert.ok(metric('tokensBrowserIo') > 0);
  assert.ok(metric('tokensSavedCaptcha') > 0);
  assert.equal(insights.repetition.redundantSnapshots, 3);
  assert.ok(insights.recommendations.some((r: any) => r.id === 'redundant_snapshots'));
  assert.ok(insights.failures.byCategory.some((c: any) => c.category === 'stale_ref'));
  const codexRow = insights.agents.find((a: any) => a.agent === 'codex');
  assert.equal(codexRow.failures, 1);
  writeFileSync(join(output, 'insights.json'), JSON.stringify(insights, null, 2));

  // The tab strip names the agent that opened each tab.
  await shell.waitForFunction(() => [...document.querySelectorAll('.tab .badge')].map(b => b.textContent).join(',').includes('Codex'));
  const badges = await shell.evaluate(() => [...document.querySelectorAll('.tab .badge')].map(b => b.textContent));
  for (const label of ['Codex', 'Claude Code', 'WorkBuddy']) assert.ok(badges.includes(label), `badge ${label}: ${badges}`);
  await shell.screenshot({ path: join(output, 'browser-window.png') });
  void workbuddyTab;

  // The two windows open on their own, outside the tab strip, and agents cannot reach them.
  const opened = await (await fetch(base + '/api/windows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'agents' }) })).json();
  assert.equal(opened.opened, true);
  await fetch(base + '/api/windows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'insights' }) });
  const findWindow = async (path: string) => {
    for (let i = 0; i < 100; i++) {
      const page = app.electronApp.windows().find(item => item.url().startsWith(base + path));
      if (page) return page;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`window ${path} did not open`);
  };
  const manager = await findWindow('/agents');
  const dashboard = await findWindow('/insights');
  const tabs = await waymark(['--agent', 'human'], 'tabs');
  assert.equal(tabs.some((t: any) => /waymark-window=1/.test(t.url)), false, 'manager windows leaked into the agent tab list');
  for (const page of [manager, dashboard]) await page.setViewportSize({ width: 1440, height: 1000 });
  await manager.locator('#sessions .item').first().waitFor();
  await manager.locator(`#agents .item[data-agent="codex"]`).click();
  await manager.locator('#sessions .item').first().click();
  await manager.locator('#steps .step').first().waitFor();
  await manager.locator('#steps .step img.thumb').first().waitFor();
  await manager.waitForFunction(() => [...document.querySelectorAll('#steps img.thumb')].some(img => (img as HTMLImageElement).naturalWidth > 0));
  const failed = manager.locator('#steps .step.failure').first();
  await failed.click();
  await manager.locator('.more dl').first().waitFor();
  await manager.screenshot({ path: join(output, 'manager.png') });
  await dashboard.locator('.hero .card').first().waitFor();
  await dashboard.waitForFunction(() => document.querySelectorAll('#trend svg rect').length > 0);
  await dashboard.screenshot({ path: join(output, 'insights.png'), fullPage: true });
  await dashboard.screenshot({ path: join(output, 'insights-top.png') });
  for (const width of [800, 1280]) {
    await dashboard.setViewportSize({ width, height: 900 });
    assert.equal(await dashboard.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `insights overflows at ${width}px`);
  }
  assert.deepEqual(errors, [], 'renderer JavaScript errors');
  console.log(`PROVENANCE E2E PASS: 3 agents told apart (declared, MCP clientInfo, terminal), ${codexSession.timeline.length} codex steps, ddddocr solved 1, screenshots in ${output}`);
} finally {
  await app.runtime.close();
  await app.closed.catch(() => undefined);
  await new Promise<void>(r => fixture.close(() => r()));
}
