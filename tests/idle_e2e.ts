import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../src/types.js';
import { AuditLog } from '../src/audit/AuditLog.js';
import { BrowserRuntime } from '../src/browser/BrowserRuntime.js';
import { createLocalCapabilities } from '../src/capabilities/local.js';
import { PluginIdle } from '../src/capabilities/plugins.js';
import type { IdleScene } from '../src/browser/IdleController.js';

// Idle behaviour against real Chrome: a visit while the agent thinks comes back with the agent's refs working, an agent
// call during a visit waits for the page to be restored, and a page with unsaved input is never left.
const pages: Record<string, string> = {
  '/list': `<title>List</title><h1>Articles</h1>
    <p>${'A paragraph long enough to read with the pointer while the agent decides what to do next. '.repeat(3)}</p>
    <p><a href="/detail">Read the first article</a></p>
    <button onclick="const p = document.createElement('p'); p.textContent = 'More loaded'; document.body.append(p)">Show more</button>`,
  '/detail': `<title>Detail</title><h1>First article</h1><p>${'Body text of the article. '.repeat(10)}</p>`,
  '/form': `<title>Form</title><h1>Apply</h1><label>Name <input name="name"></label><p><a href="/detail">Help</a></p>`
};
const fixture = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><body style="min-height:1600px">${pages[req.url ?? ''] ?? pages['/list']}</body>`);
});
await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
const address = fixture.address();
if (!address || typeof address === 'string') throw new Error('fixture port unavailable');
const directory = mkdtempSync(join(tmpdir(), 'waymark-idle-'));

const scenes: IdleScene[] = [];
const config: AppConfig = {
  settingsFile: join(directory, 'settings.json'),
  server: { host: '127.0.0.1', port: 0 },
  browser: { executablePath: 'auto', userDataDir: join(directory, 'profile'), headless: true, settleMs: 20, readLimit: 10000, systemPasteSettleMs: 20, ambientMouse: { enabled: true, minPauseMs: 40, maxPauseMs: 80, marginPx: 20 }, mouse: { minSteps: 2, maxSteps: 3, minDelayMs: 1, maxDelayMs: 2 } },
  capabilities: { pointer: 'action.pointer.bezier', pacing: 'action.pacing.off', idle: 'idle.test', challengeOcr: 'challenge.ocr.ddddocr', clipboard: 'action.clipboard.virtual' },
  audit: { directory: join(directory, 'audit'), captureScreenshots: false },
  challenge: { pythonCommand: './.missing/python.exe', pythonFallback: '__missing_python__', timeoutMs: 1000, maxImageBytes: 1000000, maxOcrAttempts: 1, maxAiAttempts: 2, autoSubmit: true }
};
const capabilities = createLocalCapabilities(config);
// Deterministic planner: visit the first link whenever the page allows it, otherwise rest the pointer.
capabilities.register(new PluginIdle({
  manifest: { id: 'idle.test' },
  plan: scene => { scenes.push(scene); return scene.allow.visit ? [{ type: 'visit', link: 0, dwellMs: 2500 }] : scene.spots.slice(0, 1).map(spot => ({ type: 'move', ...spot })); }
}));
const runtime = new BrowserRuntime(config, new AuditLog(config.audit.directory), capabilities);

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 15000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${what}`);
}
const visits = (url: string) => runtime.audit.list(500, e => e.action === 'idle.visit' && Boolean(e.before?.url.includes(url)));

try {
  await runtime.launch();
  // 1. A visit while the agent thinks comes back, and refs from before the visit still work.
  const base = `http://127.0.0.1:${address.port}`;
  const list = await runtime.tabs('new', undefined, `${base}/list`) as { id: number };
  const snapshot = await runtime.snapshot(list.id);
  const more = Object.values(snapshot.refs).find(r => r.name === 'Show more');
  assert.ok(more);
  const visit = await until('an idle visit from /list', () => visits('/list')[0]);
  const detail = visit.detail as { visited: string; restored: string };
  assert.match(detail.visited, /\/detail$/);
  assert.ok(['intact', 'rebuilt'].includes(detail.restored), `restored: ${detail.restored}`);
  const clicked = await runtime.act({ page: list.id, kind: 'click', ref: more.ref }) as { after: { url: string }; changes: { added: string[] } };
  assert.equal(clicked.after.url, `${base}/list`);
  console.log(`visit restored ${detail.restored}; old ref still clicked after returning`);

  // 2. A page with unsaved input is never left (another origin: a rebuilt return stops further visits from the first).
  const other = `http://localhost:${address.port}`;
  const form = await runtime.tabs('new', undefined, `${other}/form`) as { id: number };
  const formSnapshot = await runtime.snapshot(form.id);
  const name = Object.values(formSnapshot.refs).find(r => r.role === 'text');
  assert.ok(name);
  await runtime.act({ page: form.id, kind: 'type', ref: name.ref, value: 'Ada' });
  // Blur the field so the remaining guard is the unsaved input, not the focused field.
  await (await runtime.getPage(form.id)).evaluate('document.activeElement.blur()');
  const seen = scenes.length;
  await until('idle scenes on the form', () => scenes.length > seen + 5);
  assert.equal(visits('/form').length, 0);
  assert.equal(scenes.at(-1)!.allow.visit, false);
  assert.equal(scenes.at(-1)!.allow.reason, 'unsaved input');
  assert.equal(await (await runtime.getPage(form.id)).inputValue('input[name="name"]'), 'Ada');
  // 3. An agent call in the middle of a visit waits until the page it left is back.
  const second = await runtime.tabs('new', undefined, `${other}/list`) as { id: number };
  await runtime.snapshot(second.id);
  const page = await runtime.getPage(second.id);
  await until('the idle visit to open /detail', () => page.url().endsWith('/detail'));
  const during = await runtime.snapshot(second.id);
  assert.equal(during.url, `${other}/list`);
  assert.match(during.text, /Show more/);
  console.log('agent call during a visit got the original page back');

  console.log('IDLE E2E PASS: visit + restore + refs, unsaved-input guard, preemption');
} finally {
  await runtime.close();
  await new Promise<void>(r => fixture.close(() => r()));
  rmSync(directory, { recursive: true, force: true });
}
