import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dashboardHtml } from '../src/web/dashboard.js';
import { homeHtml } from '../src/web/home.js';
import { loadConfig } from '../src/config.js';

const inlineScript = (html: string) => html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

test('dashboard has valid inline JavaScript and no corrupted question-mark labels', () => {
  const html = dashboardHtml();
  const script = inlineScript(html);
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.equal(html.includes('???'), false);
  assert.ok(html.includes('\u9694\u79bb\uff08\u9ed8\u8ba4\uff09'));
});

test('home page script is valid and points AI clients at the MCP endpoint', () => {
  const html = homeHtml(loadConfig());
  const script = inlineScript(html);
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(html, /\/mcp/);
  assert.equal(html.includes('???'), false);
});

test('shell scripts parse and avoid inline handlers blocked by the shell CSP', () => {
  for (const file of ['renderer.js', 'labels.js']) {
    const source = readFileSync(`src/app/shell/${file}`, 'utf8');
    assert.doesNotThrow(() => new Function(source), file);
    assert.equal(/\son[a-z]+="/.test(source), false, `${file} must not emit inline event handlers`);
  }
  // Sandboxed preloads cannot be ES modules; an ESM preload leaves window.agentShell undefined and the whole toolbar dead.
  assert.match(readFileSync('src/app/electron-main.ts', 'utf8'), /preload\.cjs/);
  const html = readFileSync('src/app/shell/index.html', 'utf8');
  assert.equal(/\son[a-z]+="/.test(html), false);
  assert.match(html, /script-src 'self'/);
});

test('activity labels describe ledger events in Chinese', async () => {
  await import('../src/app/shell/labels.js');
  const labels = (globalThis as any).AgentLabels;
  assert.equal(labels.describe({ action: 'click', target: { ref: 'e3' } }).what, '\u70b9\u51fb \u00b7 \u5143\u7d20 e3');
  const collapsed = labels.collapseStarted([
    { id: '2', action: 'click', pageId: 1, status: 'success', timestamp: new Date().toISOString() },
    { id: '1', action: 'click', pageId: 1, status: 'started', timestamp: new Date().toISOString() }
  ]);
  assert.deepEqual(collapsed.map((event: { id: string }) => event.id), ['2']);
});
