import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AppConfig } from '../src/types.js';
import { AuditLog } from '../src/audit/AuditLog.js';
import { BrowserRuntime } from '../src/browser/BrowserRuntime.js';
import { ChallengeBroker } from '../src/challenge/ChallengeBroker.js';
import { createLocalCapabilities } from '../src/capabilities/local.js';

// Challenges whose answer is not in a single still frame: a slider gap drawn only while the handle is held, a prompt
// that plays its characters one by one, and an animated GIF that shows one character of the code at a time.
const gif = readFileSync('data/ocr-blink.gif').toString('base64');
const blink = `<!doctype html><html><head><meta charset="utf-8"><title>Blink</title></head><body><h1>安全验证</h1><form onsubmit="event.preventDefault();if(document.querySelector('[name=captcha]').value.toUpperCase()==='K9P4'){document.body.innerHTML='<h1>Verified blink</h1>'}else{document.querySelector('#state').textContent='wrong'}"><img alt="captcha" src="data:image/gif;base64,${gif}"><input name="captcha" placeholder="验证码"><button type="submit">提交验证</button></form><div id="state"></div></body></html>`;
const fixture = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url?.startsWith('/slider')) res.end(readFileSync('tests/fixtures/challenge-slider.html'));
  else if (req.url?.startsWith('/clicks')) res.end(readFileSync('tests/fixtures/challenge-clicks.html'));
  else res.end(blink);
});
await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
const address = fixture.address();
if (!address || typeof address === 'string') throw new Error('fixture port unavailable');
const base = `http://127.0.0.1:${address.port}`;
const config: AppConfig = {
  settingsFile: './data/challenge-e2e-settings.json', server: { host: '127.0.0.1', port: 0 },
  browser: { executablePath: 'auto', userDataDir: './data/challenge-e2e-profile', headless: true, settleMs: 50, readLimit: 10000, systemPasteSettleMs: 20, ambientMouse: { enabled: false, minPauseMs: 1000, maxPauseMs: 2000, marginPx: 40 }, mouse: { minSteps: 8, maxSteps: 14, minDelayMs: 4, maxDelayMs: 10 } },
  capabilities: { pointer: 'action.pointer.bezier', challengeOcr: 'challenge.ocr.ddddocr', clipboard: 'action.clipboard.virtual' },
  audit: { directory: './data/challenge-e2e-audit', captureScreenshots: false },
  challenge: { pythonCommand: process.env.WAYMARK_PYTHON ?? './.venv/Scripts/python.exe', pythonFallback: process.platform === 'win32' ? 'python' : 'python3', timeoutMs: 30000, maxImageBytes: 5000000, maxOcrAttempts: 1, maxAiAttempts: 2, autoSubmit: true }
};
const capabilities = createLocalCapabilities(config);
const audit = new AuditLog(config.audit.directory);
const runtime = new BrowserRuntime(config, audit, capabilities);
const challenges = new ChallengeBroker(runtime, config, capabilities);
const open = async (path: string) => {
  const tab = await runtime.tabs('new', undefined, 'about:blank') as { id: number };
  await runtime.navigateAction(tab.id, 'url', base + path);
  const job = challenges.list().find(item => item.pageId === tab.id);
  assert.ok(job, `no challenge job for ${path}`);
  return { tab: tab.id, job, page: await runtime.getPage(tab.id) };
};
const input = (kind: string) => audit.list(200).find(e => e.action === 'challenge.input' && (e.detail as { kind?: string }).kind === kind)?.detail as Record<string, unknown>;
try {
  const slider = await open('/slider?gap=' + (process.env.GAP ?? 130 + Math.floor(Math.random() * 100)));
  const sliderTrace = await slider.page.evaluate('window.trace') as { moves: number; heldMs: number; offBy: number };
  assert.equal(slider.job.kind, 'slider');
  assert.equal(slider.job.status, 'resolved_unverified', `${slider.job.detail} ${JSON.stringify(sliderTrace)} ${JSON.stringify(input('slider'))}`);
  assert.match((await runtime.read(slider.tab)).text, /Verified slider/);
  assert.equal(input('slider').revealedBy, 'press');
  assert.ok(sliderTrace.moves >= 15 && sliderTrace.heldMs >= 400, `drag looks mechanical: ${JSON.stringify(sliderTrace)}`);
  console.log(`slider: gap revealed only on press, dragged in ${sliderTrace.moves} moves over ${sliderTrace.heldMs} ms, off by ${sliderTrace.offBy}px`);
  if (process.env.SLIDER_ONLY) { await runtime.close(); process.exit(0); }

  for (const [query, method] of [['', 'prompt-sequence'], ['?still=1', 'prompt-still'], ['?dom=1', 'dom-text']]) {
    const clicks = await open('/clicks' + query);
    const seen = input('click_sequence');
    assert.equal(clicks.job.kind, 'click_sequence');
    assert.equal(clicks.job.status, 'resolved_unverified', `${clicks.job.detail} ${JSON.stringify(seen)} ${(await runtime.read(clicks.tab)).text}`);
    assert.match((await runtime.read(clicks.tab)).text, /Verified clicks/);
    assert.equal(seen.method, method);
    console.log(`clicks (${method}): ${seen.keyframes} keyframes, ${seen.textMatched}/3 matched by text, clicked in order`);
  }

  const gifJob = await open('/blink');
  assert.equal(gifJob.job.kind, 'text_image');
  assert.equal(gifJob.job.status, 'resolved_unverified', gifJob.job.detail);
  assert.match((await runtime.read(gifJob.tab)).text, /Verified blink/);
  assert.equal(input('text_image').method, 'merged-frames');
  console.log(`gif: ${input('text_image').frames} frames merged into one before OCR`);

  const ledger = readFileSync('data/challenge-e2e-audit/events.jsonl', 'utf8');
  for (const secret of ['K9P4', 'k9p4', '猫山水']) assert.equal(ledger.includes(secret), false, `answer ${secret} leaked into audit`);
  console.log('CHALLENGE INPUT E2E PASS');
} finally {
  await runtime.close();
  await new Promise<void>(r => fixture.close(() => r()));
}
