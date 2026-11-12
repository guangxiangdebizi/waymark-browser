import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const fixture = createServer((_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(readFileSync(resolve('tests/fixtures/basic.html'))); });
await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
const address = fixture.address();
if (!address || typeof address === 'string') throw new Error('fixture port unavailable');
const client = new Client({ name: 'electron-acceptance', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:9510/mcp')));
const unwrap = (result: any) => {
  const text = result.content[0].text as string;
  return JSON.parse(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n[END_UNTRUSTED_PAGE_CONTENT')));
};
try {
  const initial = unwrap(await client.callTool({ name: 'tabs', arguments: { action: 'list' } }));
  assert.ok(Array.isArray(initial));
  assert.equal(JSON.stringify(initial).includes('agent-shell=1'), false, 'Electron shell leaked into agent tabs');
  const homeTab = initial.find(tab => tab.url.includes('/home'));
  assert.ok(homeTab, 'Startup home tab missing');
  const homeText = unwrap(await client.callTool({ name: 'read', arguments: { page: homeTab.id } })).text;
  assert.ok(homeText.includes('Waymark') && homeText.includes('/mcp'), homeText.slice(0, 1200));
  assert.equal(homeText.includes('???'), false);
  const audited = unwrap(await client.callTool({ name: 'navigate', arguments: { action: 'url', page: homeTab.id, url: 'http://127.0.0.1:9510/audit' } }));
  assert.equal(audited.challenge, null, 'local cockpit pages must not be detected as CAPTCHA challenges');
  await client.callTool({ name: 'navigate', arguments: { action: 'url', page: homeTab.id, url: 'http://127.0.0.1:9510/home' } });
  const auditHtml = await fetch('http://127.0.0.1:9510/audit').then(r => r.text());
  assert.ok(auditHtml.includes('\u9694\u79bb\uff08\u9ed8\u8ba4\uff09'));
  const refused = await fetch('http://127.0.0.1:9510/api/control', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.test' }, body: JSON.stringify({ paused: true }) });
  assert.equal(refused.status, 403, 'cross-origin cockpit write must be refused');
  const plain = await fetch('http://127.0.0.1:9510/api/control', { method: 'POST', body: 'paused=true' });
  assert.equal(plain.status, 415, 'non-JSON cockpit write must be refused');
  const settingsResponse = await fetch('http://127.0.0.1:9510/api/settings').then(r => r.json());
  assert.equal(settingsResponse.ambientMouse.enabled, true);
  const created = unwrap(await client.callTool({ name: 'tabs', arguments: { action: 'new', url: `http://127.0.0.1:${address.port}` } }));
  const control = (paused: boolean) => fetch('http://127.0.0.1:9510/api/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused }) }).then(r => r.json());
  assert.equal((await control(true)).paused, true);
  try {
    const blocked = await client.callTool({ name: 'snapshot', arguments: { page: created.id } }) as any;
    assert.equal(blocked.isError, true, 'automation must be refused while the user holds control');
    assert.match(blocked.content[0].text, /paused/);
    const status = await fetch('http://127.0.0.1:9510/api/status').then(r => r.json());
    assert.equal(status.paused, true);
  } finally { await control(false); }
  const snapshot = unwrap(await client.callTool({ name: 'snapshot', arguments: { page: created.id } }));
  const refs = Object.values(snapshot.refs) as any[];
  const input = refs.find(ref => ref.name.includes('Search'));
  const button = refs.find(ref => ref.role === 'button');
  assert.ok(input && button);
  // Regression: the page script once stripped every letter "s" from element names (an unescaped \s in a template literal).
  assert.equal(button.name, 'Run search');
  assert.equal(input.name, 'Search value');
  const pasted = unwrap(await client.callTool({ name: 'act', arguments: { page: created.id, kind: 'paste', ref: input.ref, value: 'electron' } }));
  assert.equal(pasted.ok, true, JSON.stringify(pasted));
  const clicked = unwrap(await client.callTool({ name: 'act', arguments: { page: created.id, kind: 'click', ref: button.ref } }));
  const settled = unwrap(await client.callTool({ name: 'wait', arguments: { page: created.id, for: 'text', value: 'hello electron', timeout: 3000 } }));
  assert.equal(settled.matched, true);
  const read = unwrap(await client.callTool({ name: 'read', arguments: { page: created.id } }));
  assert.match(read.text, /hello electron/);
  assert.equal(read.truncated, false);
  const html = unwrap(await client.callTool({ name: 'read', arguments: { page: created.id, format: 'html', limit: 1000000 } }));
  assert.match(html.text, /<html[\s>]/i);
  assert.match(html.text, /hello electron/);
  assert.equal(html.truncated, false);
  const trace = unwrap(await client.callTool({ name: 'audit', arguments: { action: 'get', id: clicked.traceId } }));
  assert.equal(trace.snapshot.id, snapshot.id);
  assert.equal(trace.event.capabilities[0].id, 'action.pointer.bezier');
  await client.callTool({ name: 'tabs', arguments: { action: 'close', page: created.id } });
  await new Promise(resolve => setTimeout(resolve, 4000));
  const events = unwrap(await client.callTool({ name: 'audit', arguments: { action: 'list', limit: 200 } }));
  const ambient = events.find(event => event.action === 'mouse.ambient');
  assert.ok(ambient, 'No autonomous ambient mouse event was generated');
  assert.equal(ambient.detail.clicked, false);
  console.log('ELECTRON E2E PASS: home tab + cockpit guards + pause lease + native app tab + MCP + virtual clipboard + click + snapshot trace + autonomous ambient mouse');
} finally {
  await client.close();
  await new Promise<void>(r => fixture.close(() => r()));
}
