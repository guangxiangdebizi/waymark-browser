import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog } from '../src/audit/AuditLog.js';
import { startServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

/** A runtime stand-in: just enough for the MCP tools these tests call. */
function fakeRuntime(audit: AuditLog) {
  let next = 1;
  return {
    audit,
    capabilities: { list: () => [] },
    isPaused: () => false, setPaused: () => undefined, busyCount: () => 0, pageCount: () => 0,
    getClipboardProviderId: () => 'action.clipboard.virtual', getAmbientMouseState: () => ({ enabled: false, moving: false }), slots: () => ({}),
    tabs: async (action: string, _page?: number, url?: string) => {
      if (action === 'new') { const id = next++; audit.record({ pageId: id, action: 'tabs.new', target: { url }, after: { url: url ?? 'about:blank', title: 't' }, status: 'success' }); return { id, url }; }
      audit.record({ action: 'tabs.list', status: 'info' });
      return [];
    }
  };
}

async function rpc(base: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
  const text = await response.text();
  const data = text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
  return { session: response.headers.get('mcp-session-id'), status: response.status, message: data[0] ?? (text ? JSON.parse(text) : undefined) };
}
const init = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name, version: '1.0' } } });
const callTool = (id: number, name: string, args: unknown = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('MCP sessions, declared headers and anonymous callers are told apart in the ledger and the APIs', async () => {
  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  const root = mkdtempSync(join(process.cwd(), 'data', 'server-prov-'));
  const config = loadConfig();
  config.server.port = 19000 + Math.floor(Math.random() * 900);
  const audit = new AuditLog(root);
  const server = await startServer(config, fakeRuntime(audit) as any, { list: () => [], command: async () => ({}) } as any);
  const base = `http://127.0.0.1:${config.server.port}`;
  try {
    // Two Codex windows and one Claude Code window, each with its own MCP session.
    const codexA = await rpc(base, init('codex-mcp-client'));
    const codexB = await rpc(base, init('codex-mcp-client'));
    const claude = await rpc(base, init('claude-code'));
    assert.ok(codexA.session && codexB.session && claude.session);
    assert.notEqual(codexA.session, codexB.session);
    for (const s of [codexA.session!, codexB.session!, claude.session!]) {
      await rpc(base, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': s, 'mcp-protocol-version': '2025-03-26' });
    }
    const opened = await rpc(base, callTool(2, 'tabs', { action: 'new', url: 'https://a.test/' }), { 'mcp-session-id': codexA.session!, 'mcp-protocol-version': '2025-03-26' });
    assert.equal(opened.status, 200);
    await rpc(base, callTool(2, 'tabs', { action: 'new', url: 'https://b.test/' }), { 'mcp-session-id': codexB.session!, 'mcp-protocol-version': '2025-03-26' });
    await rpc(base, callTool(2, 'tabs', { action: 'list' }), { 'mcp-session-id': claude.session!, 'mcp-protocol-version': '2025-03-26' });
    const who = await rpc(base, callTool(3, 'whoami'), { 'mcp-session-id': claude.session!, 'mcp-protocol-version': '2025-03-26' });
    assert.match(who.message.result.content[0].text, /"agent": "claude-code"/);
    assert.match(who.message.result.content[0].text, /"identifiedBy": "mcp-client"/);
    // A stateless caller that declares itself, and one that does not.
    await rpc(base, callTool(4, 'tabs', { action: 'new', url: 'https://c.test/' }), { 'x-waymark-agent': 'workbuddy', 'x-waymark-session': 'wb-1', 'x-waymark-stateless': '1' });
    await rpc(base, callTool(5, 'tabs', { action: 'list' }), { 'user-agent': 'curl/8' });
    // name_session can declare the agent for a stateless caller.
    await rpc(base, callTool(6, 'name_session', { name: 'nightly report', agent: 'gemini' }), { 'user-agent': 'my-script/1' });
    await rpc(base, callTool(7, 'tabs', { action: 'list' }), { 'user-agent': 'my-script/1' });

    const events = audit.all();
    const tabsNew = events.filter(e => e.action === 'tabs.new');
    assert.deepEqual(tabsNew.map(e => e.actor?.agent), ['codex', 'codex', 'workbuddy']);
    assert.notEqual(tabsNew[0].actor?.session, tabsNew[1].actor?.session);
    assert.equal(tabsNew[2].actor?.source, 'declared');
    assert.equal(events.filter(e => e.action === 'agent.connected').length, 3);
    const calls = events.filter(e => e.action === 'mcp.call');
    assert.ok(calls.every(c => typeof (c.detail as any).responseChars === 'number'));
    assert.ok(calls.some(c => c.actor?.agent === 'unknown'));
    const named = calls.filter(c => c.actor?.agent === 'gemini-cli');
    assert.equal(named.length, 2);
    assert.equal(named[1].session, 'nightly report');

    const tree = await fetch(base + '/api/agents?days=1').then(r => r.json());
    const codex = tree.agents.find((a: any) => a.agent === 'codex');
    assert.equal(codex.sessions.length, 2);
    const detail = await fetch(base + '/api/sessions/' + encodeURIComponent(codex.sessions[0].key)).then(r => r.json());
    assert.equal(detail.tabs.length, 1);
    assert.equal(detail.tabs[0].openedHere, true);
    const insights = await fetch(base + '/api/insights?days=1').then(r => r.json());
    assert.ok(insights.metrics.find((m: any) => m.id === 'calls').value >= 7);
    assert.equal(typeof insights.metric, 'undefined');
    const identity = await fetch(base + '/api/identity', { headers: { 'x-waymark-agent': 'codex' } }).then(r => r.json());
    assert.equal(identity.agent, 'codex');
    for (const page of ['/agents', '/insights']) {
      const html = await fetch(base + page).then(r => r.text());
      assert.match(html, /<script src="\/assets\/(agents|insights)\.js">/);
    }
    for (const asset of ['agents.js', 'insights.js', 'charts.js']) assert.equal((await fetch(base + '/assets/' + asset)).status, 200);
    assert.equal((await fetch(base + '/api/audit/screens/..%2Fevents.jsonl')).status, 404);
    // Audit list hides call bookkeeping by default and filters by agent.
    const list = await fetch(base + '/api/audit/events?limit=100&agent=codex').then(r => r.json());
    assert.ok(list.length > 0 && list.every((e: any) => e.actor?.agent === 'codex' && e.action !== 'mcp.call'));
    // Prune is a dry run unless asked otherwise, and refuses cross-origin writes.
    const dry = await fetch(base + '/api/audit/prune', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days: 30 }) }).then(r => r.json());
    assert.equal(dry.dryRun, true);
    assert.equal((await fetch(base + '/api/audit/prune', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.test' }, body: JSON.stringify({ days: 1, dryRun: false }) })).status, 403);
    // DELETE ends an MCP session; a later call with the stale id still works statelessly.
    assert.equal((await fetch(base + '/mcp', { method: 'DELETE', headers: { 'mcp-session-id': codexA.session!, 'mcp-protocol-version': '2025-03-26' } })).status, 200);
    const stale = await rpc(base, callTool(9, 'tabs', { action: 'list' }), { 'mcp-session-id': codexA.session! });
    assert.equal(stale.status, 200);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP tool list includes the provenance tools', async () => {
  const { createMcpServer } = await import('../src/mcp/server.js');
  const server = createMcpServer({ audit: {} } as any, {} as any);
  const names = Object.keys((server as any)._registeredTools);
  for (const name of ['whoami', 'report_usage', 'stats', 'screenshot', 'name_session']) assert.ok(names.includes(name), name);
});
