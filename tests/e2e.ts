import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AppConfig } from '../src/types.js';
import { AuditLog } from '../src/audit/AuditLog.js';
import { BrowserRuntime } from '../src/browser/BrowserRuntime.js';
import { ChallengeBroker } from '../src/challenge/ChallengeBroker.js';
import { startServer } from '../src/server.js';
import { createLocalCapabilities } from '../src/capabilities/local.js';

const fixture = createServer((req, res) => {
  const name = req.url?.startsWith('/challenge') ? 'challenge.html' : 'basic.html';
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(readFileSync(resolve('tests/fixtures', name)));
});
await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
const address = fixture.address();
if (!address || typeof address === 'string') throw new Error('fixture port unavailable');
const base = `http://127.0.0.1:${address.port}`;
const mcpPort = 19000 + Math.floor(Math.random() * 1000);
const config: AppConfig = {
  settingsFile: './data/e2e-settings.json',
  server: { host: '127.0.0.1', port: mcpPort },
  browser: { executablePath: 'auto', userDataDir: './data/e2e-profile', headless: true, settleMs: 20, readLimit: 10000, systemPasteSettleMs: 20, ambientMouse: { enabled: false, minPauseMs: 1000, maxPauseMs: 2000, marginPx: 40 }, mouse: { minSteps: 1, maxSteps: 2, minDelayMs: 1, maxDelayMs: 2 } },
  capabilities: { pointer: 'action.pointer.bezier', challengeOcr: 'challenge.ocr.ddddocr', clipboard: 'action.clipboard.virtual' },
  audit: { directory: './data/e2e-audit', captureScreenshots: false },
  challenge: { pythonCommand: './.missing/python.exe', pythonFallback: '__missing_python__', timeoutMs: 1000, maxImageBytes: 1000000, maxOcrAttempts: 1, maxAiAttempts: 2, autoSubmit: true }
};
const capabilities = createLocalCapabilities(config);
const runtime = new BrowserRuntime(config, new AuditLog(config.audit.directory), capabilities);
const challenges = new ChallengeBroker(runtime, config, capabilities);
const server = await startServer(config, runtime, challenges);
try {
  await runtime.launch();
  const client = new Client({ name: 'waymark-e2e', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`)));
  const tools = await client.listTools();
  assert.ok(tools.tools.some(t => t.name === 'snapshot'));
  assert.equal(JSON.stringify(tools.tools.find(t => t.name === 'challenge')).includes('human_complete'), false);
  await client.callTool({ name: 'name_session', arguments: { name: 'e2e-real-browser' } });
  const capabilityResult = await client.callTool({ name: 'capabilities', arguments: {} });
  assert.match(JSON.stringify(capabilityResult), /challenge\.ocr\.ddddocr/);
  assert.equal((await fetch(`http://127.0.0.1:${mcpPort}/audit`)).status, 200);
  const settings = await fetch(`http://127.0.0.1:${mcpPort}/api/settings`).then(r => r.json());
  assert.equal(settings.clipboardProvider, 'action.clipboard.virtual');
  const invalidSetting = await fetch(`http://127.0.0.1:${mcpPort}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clipboardProvider: 'invalid' }) });
  assert.equal(invalidSetting.status, 400);
  await client.close();

  const created = await runtime.tabs('new', undefined, base) as { id: number };
  const snapshot = await runtime.snapshot(created.id);
  assert.equal(snapshot.text.includes('do-not-record-this'), false);
  const input = Object.values(snapshot.refs).find(r => r.role === 'text' || r.name.includes('Search'));
  const button = Object.values(snapshot.refs).find(r => r.role === 'button');
  assert.ok(input && button);
  assert.equal(button.name, 'Run search');
  await runtime.act({ page: created.id, kind: 'paste', ref: input.ref, value: 'world' });
  await runtime.act({ page: created.id, kind: 'copy', ref: input.ref });
  await runtime.act({ page: created.id, kind: 'fill', fields: [{ ref: input.ref, value: '' }] });
  await runtime.act({ page: created.id, kind: 'paste', ref: input.ref });
  const clicked = await runtime.act({ page: created.id, kind: 'click', ref: button.ref }) as { traceId: string };
  const read = await runtime.read(created.id);
  assert.match(read.text, /hello world/);
  const trace = runtime.audit.get(clicked.traceId);
  assert.equal(trace?.event.status, 'success');
  assert.equal(trace?.snapshot?.id, snapshot.id);
  assert.ok(trace?.event.basisSnapshotHash);
  assert.equal(trace?.event.capabilities?.[0]?.id, 'action.pointer.bezier');

  await runtime.navigateAction(created.id, 'url', `${base}/challenge`);
  const job = challenges.list().find(j => j.pageId === created.id);
  assert.ok(job);
  assert.equal(job.status, 'ai_recovery_required');
  await challenges.command('ai_failed', job.id, 'AI could not classify the image');
  const exhausted = await challenges.command('ai_failed', job.id, 'AI recovery failed again') as { status: string };
  assert.equal(exhausted.status, 'human_required');
  await assert.rejects(() => runtime.read(created.id), /paused for human/);
  await challenges.command('human_start', job.id);
  const completed = await challenges.command('human_complete', job.id) as { status: string };
  assert.equal(completed.status, 'resolved_unverified');
  assert.ok(await runtime.read(created.id));
  console.log('E2E PASS: real Chrome + MCP + semantic actions + snapshot trace + OCR->AI->human recovery');
} finally {
  await server.close();
  await runtime.close();
  await new Promise<void>(r => fixture.close(() => r()));
}

