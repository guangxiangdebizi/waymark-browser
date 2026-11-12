import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AppConfig } from '../src/types.js';
import { AuditLog } from '../src/audit/AuditLog.js';
import { BrowserRuntime } from '../src/browser/BrowserRuntime.js';
import { ChallengeBroker } from '../src/challenge/ChallengeBroker.js';
import { createLocalCapabilities } from '../src/capabilities/local.js';

const image = readFileSync('data/ocr-smoke.png').toString('base64');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>OCR challenge</title></head><body><h1>安全验证</h1><form onsubmit="event.preventDefault();if(document.querySelector('[name=captcha]').value==='A7B2'){document.body.innerHTML='<h1>Verified challenge</h1>'}else{document.querySelector('#state').textContent='wrong'}"><img alt="captcha" src="data:image/png;base64,${image}"><input name="captcha" placeholder="验证码"><button type="submit">提交验证</button></form><div id="state"></div></body></html>`;
const fixture = createServer((_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); });
await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
const address = fixture.address();
if (!address || typeof address === 'string') throw new Error('fixture port unavailable');
const config: AppConfig = {
  settingsFile: './data/ocr-e2e-settings.json', server: { host: '127.0.0.1', port: 0 },
  browser: { executablePath: 'auto', userDataDir: './data/ocr-e2e-profile', headless: true, settleMs: 50, readLimit: 10000, systemPasteSettleMs: 20, ambientMouse: { enabled: false, minPauseMs: 1000, maxPauseMs: 2000, marginPx: 40 }, mouse: { minSteps: 1, maxSteps: 2, minDelayMs: 1, maxDelayMs: 2 } },
  capabilities: { pointer: 'action.pointer.bezier', challengeOcr: 'challenge.ocr.ddddocr', clipboard: 'action.clipboard.virtual' },
  audit: { directory: './data/ocr-e2e-audit', captureScreenshots: false },
  challenge: { pythonCommand: process.env.WAYMARK_PYTHON ?? './.venv/Scripts/python.exe', pythonFallback: process.platform === 'win32' ? 'python' : 'python3', timeoutMs: 30000, maxImageBytes: 5000000, maxOcrAttempts: 1, maxAiAttempts: 2, autoSubmit: true }
};
const capabilities = createLocalCapabilities(config);
const audit = new AuditLog(config.audit.directory);
const runtime = new BrowserRuntime(config, audit, capabilities);
const challenges = new ChallengeBroker(runtime, config, capabilities);
try {
  const tab = await runtime.tabs('new', undefined, 'about:blank') as { id: number };
  await runtime.navigateAction(tab.id, 'url', `http://127.0.0.1:${address.port}/`);
  const job = challenges.list().find(item => item.pageId === tab.id);
  assert.ok(job);
  assert.equal(job.status, 'resolved_unverified');
  assert.equal(job.ocrAttempts, 1);
  assert.match((await runtime.read(tab.id)).text, /Verified challenge/);
  assert.equal(readFileSync('data/ocr-e2e-audit/events.jsonl', 'utf8').includes('A7B2'), false, 'OCR answer leaked into audit');
  assert.ok(audit.list().some(event => event.action === 'challenge.ocr_filled' && event.capabilities?.[0]?.id === 'challenge.ocr.ddddocr'));
  console.log('OCR E2E PASS: detect -> ddddocr -> fill -> submit -> resolved_unverified; answer absent from audit');
} finally {
  await runtime.close();
  await new Promise<void>(r => fixture.close(() => r()));
}
