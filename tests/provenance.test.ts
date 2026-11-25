import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog, redactUrl, sessionKey, type AuditEvent } from '../src/audit/AuditLog.js';
import { identify, normalizeAgent, agentFromUserAgent, IdentityRegistry, runAs, withCall, type Actor } from '../src/audit/Actor.js';
import { computeInsights, registerMetric, METRICS, assignSessions } from '../src/insights/Insights.js';
import { buildProvenance, sessionDetail } from '../src/insights/Provenance.js';
import { summarizeArgs } from '../src/mcp/server.js';

function tempLedger() {
  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  const root = mkdtempSync(join(process.cwd(), 'data', 'prov-test-'));
  return { root, audit: new AuditLog(root), done: () => rmSync(root, { recursive: true, force: true }) };
}

test('agent identity: declaration beats clientInfo beats User-Agent, and nothing is guessed', () => {
  assert.equal(normalizeAgent('codex-mcp-client'), 'codex');
  assert.equal(normalizeAgent('claude-code'), 'claude-code');
  assert.equal(normalizeAgent('claude-ai'), 'claude-desktop');
  assert.equal(normalizeAgent('WorkBuddy'), 'workbuddy');
  assert.equal(normalizeAgent('My Own Bot!'), 'my-own-bot');
  assert.equal(agentFromUserAgent('node'), undefined);
  assert.equal(agentFromUserAgent('python-urllib/3.12'), undefined);
  assert.equal(agentFromUserAgent('claude-code/2.1.0 (cli)'), 'claude-code');
  const declared = identify({ headers: { 'x-waymark-agent': 'workbuddy', 'user-agent': 'codex/1.0' }, clientInfo: { name: 'claude-code' } });
  assert.deepEqual([declared.agent, declared.source], ['workbuddy', 'declared']);
  const client = identify({ headers: { 'user-agent': 'node' }, clientInfo: { name: 'codex-mcp-client', version: '0.9' }, mcpSession: 'abcdef1234567890' });
  assert.deepEqual([client.agent, client.source, client.session, client.transport], ['codex', 'mcp-client', 'mcp-abcdef123456', 'mcp-session']);
  const query = identify({ query: { agent: 'codex', session: 'job-1', window: 'w2' } });
  assert.deepEqual([query.agent, query.session, query.window], ['codex', 'job-1', 'w2']);
  const cli = identify({ headers: { 'x-waymark-agent': 'human', 'x-waymark-agent-source': 'tty', 'x-waymark-client': 'cli', 'x-waymark-window': '%E7%AA%97%E5%8F%A3' } });
  assert.deepEqual([cli.agent, cli.source, cli.transport, cli.window], ['human', 'tty', 'cli', '窗口']);
  const unknown = identify({ headers: { 'user-agent': 'curl/8' } });
  assert.deepEqual([unknown.agent, unknown.source], ['unknown', 'unknown']);
});

test('identity registry carries clientInfo and name_session declarations across calls', () => {
  const registry = new IdentityRegistry();
  registry.noteSession('s-1', { name: 'claude-code', version: '2.1' });
  assert.equal(registry.resolve({ sessionId: 's-1' }).agent, 'claude-code');
  const anon = { headers: { 'user-agent': 'some-script/1' } };
  assert.equal(registry.resolve(anon).agent, 'unknown');
  registry.declare(anon, { agent: 'codex', window: 'codex #2' });
  const after = registry.resolve(anon);
  assert.deepEqual([after.agent, after.source, after.window], ['codex', 'declared', 'codex #2']);
  assert.equal(registry.resolve({ headers: { 'user-agent': 'other/2' } }).agent, 'unknown');
});

test('ledger attributes concurrent agents correctly and redacts URL secrets', async () => {
  const { audit, done } = tempLedger();
  try {
    const a: Actor = { agent: 'codex', source: 'declared', session: 'A', transport: 'mcp-http' };
    const b: Actor = { agent: 'claude-code', source: 'mcp-client', session: 'B', transport: 'mcp-session' };
    const work = (actor: Actor, n: number) => runAs(withCall(actor, 'act'), async () => {
      for (let i = 0; i < n; i++) { await new Promise(r => setTimeout(r, Math.random() * 5)); audit.record({ action: 'click', status: 'success', pageId: 1 }); }
    });
    await Promise.all([work(a, 20), work(b, 20)]);
    const events = audit.list(100);
    assert.equal(events.filter(e => e.actor?.agent === 'codex').length, 20);
    assert.ok(events.filter(e => e.actor?.agent === 'codex').every(e => e.session === 'A'));
    assert.ok(events.filter(e => e.actor?.agent === 'claude-code').every(e => e.session === 'B'));
    audit.labelSession(sessionKey(a), 'Buy groceries');
    assert.equal(runAs(a, () => audit.record({ action: 'read', status: 'success' })).session, 'Buy groceries');
    assert.equal(audit.record({ action: 'browser.launch', status: 'info' }).actor, undefined);
    const nav = audit.record({ action: 'navigate', status: 'success', after: { url: 'https://x.test/cb?code=abc&page=2&access_token=zzz#id_token=q', title: 't' }, target: { url: 'https://x.test/?password=hunter2' } });
    assert.equal(JSON.stringify(nav).includes('hunter2'), false);
    assert.equal(JSON.stringify(nav).includes('zzz'), false);
    assert.ok(nav.after!.url.includes('page=2'));
    assert.equal(redactUrl('https://plain.test/a?q=hello'), 'https://plain.test/a?q=hello');
  } finally { done(); }
});

test('screenshots link back to their events and prune removes old entries atomically', () => {
  const { audit, root, done } = tempLedger();
  try {
    const event = audit.record({ action: 'click', status: 'success', pageId: 2 });
    const name = audit.saveScreenshot(event.id, Buffer.from([0xff, 0xd8, 0xff]))!;
    audit.attachScreenshot(event, name);
    assert.equal(audit.all().find(e => e.id === event.id)?.screenshot, name);
    assert.equal(audit.all().some(e => e.action === 'trace.screenshot'), false);
    assert.equal(new AuditLog(root).get(event.id)?.event.screenshot, name);
    assert.equal(audit.screenshotPath('../events.jsonl'), undefined);
    assert.equal(AuditLog.safeName('..\\x.jpg'), false);
    // An old line written directly, as if from last year.
    const old = { ...event, id: '00000000-0000-0000-0000-000000000001', timestamp: '2020-01-01T00:00:00.000Z' };
    const path = join(root, 'events.jsonl');
    const content = readFileSync(path, 'utf8');
    writeFileSync(path, JSON.stringify(old) + '\n' + content);
    const reopened = new AuditLog(root);
    const dry = reopened.prune(30, true);
    assert.equal(dry.removed, 1);
    assert.equal(reopened.all().length, 2);
    const real = reopened.prune(30, false);
    assert.equal(real.removed, 1);
    assert.equal(reopened.all().some(e => e.id === old.id), false);
    assert.ok(existsSync(join(root, 'screens', name)));
    assert.equal(reopened.record({ action: 'after.prune', status: 'info' }).sequence > event.sequence, true);
    assert.throws(() => reopened.prune(0));
  } finally { done(); }
});

function ev(partial: Partial<AuditEvent> & { action: string; timestamp: string }): AuditEvent {
  return { id: Math.random().toString(36).slice(2), sequence: 0, session: 'default', status: 'success', run: 'r1', ...partial } as AuditEvent;
}

test('insights: per-agent work, automation counts, savings estimates, repetition and suggestions', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const t = (min: number) => new Date(now - 3600000 + min * 60000).toISOString();
  const codex: Actor = { agent: 'codex', source: 'declared', session: 'c1', transport: 'mcp-http' };
  const claude: Actor = { agent: 'claude-code', source: 'mcp-client', session: 'k1', transport: 'mcp-session' };
  const events: AuditEvent[] = [];
  const call = (actor: Actor, minute: number, tool: string, page: number, extra: Partial<AuditEvent>[] = [], responseChars = 400) => {
    const id = `${actor.agent}-${minute}`;
    const a = { ...actor, call: id, tool };
    for (const item of extra) events.push(ev({ timestamp: t(minute), actor: a, pageId: page, ...item } as AuditEvent));
    events.push(ev({ action: 'mcp.call', status: 'info', timestamp: t(minute), actor: a, pageId: page, detail: { tool, ok: true, durationMs: 800, requestChars: 80, responseChars } }));
  };
  call(codex, 0, 'tabs', 2, [{ action: 'tabs.new', after: { url: 'https://shop.test/', title: 'Shop' } }]);
  for (let i = 0; i < 4; i++) {
    call(codex, 1 + i * 3, 'navigate', 2, [{ action: 'navigate', durationMs: 7000, target: { action: 'url', url: 'https://shop.test/list' }, after: { url: 'https://shop.test/list', title: 'List' } }]);
    call(codex, 2 + i * 3, 'snapshot', 2, [{ action: 'snapshot', basisSnapshotHash: 'h1', detail: { textLength: 4000 }, after: { url: 'https://shop.test/list', title: 'List' } }], 4100);
    call(codex, 2 + i * 3, 'snapshot', 2, [{ action: 'snapshot', basisSnapshotHash: 'h1', detail: { textLength: 4000 }, after: { url: 'https://shop.test/list', title: 'List' } }], 4100);
  }
  call(codex, 15, 'act', 2, [{ action: 'click', status: 'failure', error: 'Stale or unknown ref e9; take a fresh snapshot', before: { url: 'https://shop.test/list', title: 'List' }, detail: { input: { pointerPaths: 0, clicks: 0, keystrokes: 0, pastes: 0, pacedMs: 300 } } }]);
  call(claude, 5, 'act', 7, [
    { action: 'fill', status: 'success', after: { url: 'https://login.test/', title: 'Login' }, detail: { input: { pointerPaths: 2, clicks: 2, keystrokes: 14, pastes: 0, pacedMs: 900 } } },
    { action: 'challenge.detected', status: 'info' }, { action: 'challenge.ocr_running', status: 'info' },
    { action: 'challenge.resolved_unverified', status: 'info', detail: { reason: 'Challenge disappeared after OCR; verify the business result' } }
  ], 300);
  events.push(ev({ action: 'idle.scroll', status: 'info', timestamp: t(6), pageId: 7, detail: { steps: ['look', 'scroll', 'rest'] } }));
  events.push(ev({ action: 'click', status: 'success', timestamp: t(7), pageId: 9, after: { url: 'https://old.test/', title: 'legacy' } }));
  events.push(ev({ action: 'usage.reported', status: 'info', timestamp: t(8), actor: claude, detail: { inputTokens: 1000, outputTokens: 200 } }));

  const report = computeInsights(events, { days: 7, now });
  const m = (id: string) => report.metrics.find(x => x.id === id)!.value;
  assert.equal(m('agents'), 3);
  assert.equal(m('ocrRuns'), 1);
  assert.equal(m('ocrSolved'), 1);
  assert.equal(m('ocrSuccessRate'), 100);
  assert.equal(m('pointerPaths'), 2);
  assert.equal(m('humanKeystrokes'), 14);
  assert.equal(m('idleMoves'), 3);
  assert.equal(m('idleScrolls'), 1);
  assert.equal(m('tokensReported'), 1200);
  assert.equal(m('tokensSavedCaptcha'), 3000);
  assert.ok(report.metrics.find(x => x.id === 'tokensSavedCaptcha')!.estimate);
  assert.equal(m('challengesDetected'), 1);
  const codexRow = report.agents.find(a => a.agent === 'codex')!;
  assert.equal(codexRow.actions, 5);
  assert.equal(codexRow.failures, 1);
  assert.equal(report.agents.find(a => a.agent === 'unknown')!.actions, 1);
  assert.equal(report.failures.byCategory[0].category, 'stale_ref');
  assert.equal(report.repetition.urls[0].url, 'shop.test/list');
  assert.equal(report.repetition.redundantSnapshots, 4);
  assert.ok(m('tokensWastedRedundantSnapshots') >= 4000);
  assert.equal(report.sites.find(s => s.host === 'shop.test')!.p90NavigateMs, 7000);
  const ids = report.recommendations.map(r => r.id);
  for (const id of ['redundant_snapshots', 'repeated_url', 'slow_site', 'unknown_agent', 'captcha_saved']) assert.ok(ids.includes(id), id);
  assert.equal(report.heatmap.flat().reduce((a, b) => a + b, 0) > 0, true);
  // The idle event belongs to Waymark, not a session.
  assert.equal(assignSessions(events).some(s => s.event.action === 'idle.scroll'), false);
  // Filters
  assert.equal(computeInsights(events, { days: 7, now, agent: 'claude-code' }).agents.length, 1);
  // Extensible: a new metric is one registration.
  registerMetric({ id: 'testFills', group: 'activity', unit: 'count', compute: ctx => ctx.events.filter(e => e.action === 'fill').length });
  assert.equal(computeInsights(events, { days: 7, now }).metrics.find(x => x.id === 'testFills')!.value, 1);
  METRICS.splice(METRICS.findIndex(x => x.id === 'testFills'), 1);
  // Assumptions are configurable and reported.
  const custom = computeInsights(events, { days: 7, now, assumptions: { captchaTokensPerAttempt: 100, captchaAttemptsWithoutOcr: 1 } });
  assert.equal(custom.metrics.find(x => x.id === 'tokensSavedCaptcha')!.value, 100);
  assert.equal(custom.assumptions.captchaTokensPerAttempt, 100);

  const tree = buildProvenance(events, { days: 7, now });
  assert.deepEqual(tree.agents.map(a => a.agent).sort(), ['claude-code', 'codex', 'unknown']);
  const detail = sessionDetail(events, 's:c1')!;
  assert.equal(detail.session.agent, 'codex');
  assert.equal(detail.tabs[0].openedHere, true);
  assert.equal(detail.timeline.some(e => e.action === 'mcp.call'), false);
  assert.ok(detail.timeline.find(e => e.action === 'navigate')?.tool === 'navigate');
  assert.equal(buildProvenance(events, { days: 7, now, q: 'login.test' }).agents.map(a => a.agent).join(), 'claude-code');
});

test('inferred sessions split on idle gaps and tool-call summaries never carry values', () => {
  const base = Date.parse('2026-11-23T00:00:00Z');
  const actor: Actor = { agent: 'codex', source: 'declared', transport: 'mcp-http' };
  const events = [0, 5, 10, 80, 85].map(min => ev({ action: 'click', timestamp: new Date(base + min * 60000).toISOString(), actor }));
  const keys = new Set(assignSessions(events, 30).map(s => s.sessionKey));
  assert.equal(keys.size, 2);
  const summary = summarizeArgs('act', { page: 2, kind: 'fill', fields: [{ ref: 'e1', value: 'secret-password' }], value: 'typed text' });
  assert.equal(JSON.stringify(summary).includes('secret'), false);
  assert.equal(JSON.stringify(summary).includes('typed'), false);
  assert.equal(summary.fields, 1);
  assert.equal(summarizeArgs('navigate', { url: 'https://a.test/p?token=abc' }).url, 'https://a.test/p');
});
