// Production layout: Electron started directly (as `waymark start` does), runtime inside its main process.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import electronPath from 'electron';

const directory = mkdtempSync(join(tmpdir(), 'waymark-inprocess-'));
const fixture = createServer((_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(readFileSync('tests/fixtures/basic.html', 'utf8')); });
await new Promise<void>(done => fixture.listen(0, '127.0.0.1', done));
const site = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
const probe = createServer();
await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
const port = (probe.address() as { port: number }).port;
await new Promise<void>(done => probe.close(() => done()));
const config = JSON.parse(readFileSync('config/electron.json', 'utf8'));
Object.assign(config.server, { port });
config.settingsFile = join(directory, 'settings.json');
config.browser.userDataDir = join(directory, 'profile');
config.audit.directory = join(directory, 'audit');
writeFileSync(join(directory, 'config.json'), JSON.stringify(config));
const base = `http://127.0.0.1:${port}`;
const extra = (process.env.WAYMARK_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean);
const child = spawn(electronPath as unknown as string, [...extra, resolve('dist/app/electron-main.js')], { env: { ...process.env, WAYMARK_CONFIG: join(directory, 'config.json'), WAYMARK_INPROCESS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', chunk => { log += chunk; });
child.stderr.on('data', chunk => { log += chunk; });
let id = 0;
async function call(name: string, args: unknown = {}) {
  const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-waymark-agent': 'codex', 'x-waymark-session': 'inproc' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
  const text = await response.text();
  const reply = JSON.parse(text.split('\n').find(line => line.startsWith('data:'))!.slice(5));
  const body: string = reply.result.content[0].text;
  const value = JSON.parse(body.slice(body.indexOf('\n') + 1, body.lastIndexOf('\n[END_UNTRUSTED')));
  if (reply.result.isError) throw new Error(value.error);
  return value;
}
try {
  const started = Date.now();
  for (;;) {
    try { if ((await (await fetch(base + '/api/status')).json()).tabs >= 1) break; } catch { /* starting */ }
    if (Date.now() - started > 60000) throw new Error('in-process Waymark did not start:\n' + log);
    await new Promise(r => setTimeout(r, 200));
  }
  const tab = await call('tabs', { action: 'new', url: site });
  const snapshot = await call('snapshot', { page: tab.id });
  const refs = Object.values(snapshot.refs) as Array<{ ref: string; name: string }>;
  await call('act', { page: tab.id, kind: 'fill', fields: [{ ref: refs.find(r => r.name === 'Search value')!.ref, value: 'in process' }] });
  await call('act', { page: tab.id, kind: 'click', ref: refs.find(r => r.name === 'Run search')!.ref });
  assert.match((await call('read', { page: tab.id })).text, /hello in process/);
  const shot = await call('screenshot', { page: tab.id });
  assert.ok(shot.bytes > 1000);
  const tabs = await call('tabs', { action: 'list' });
  assert.ok(tabs.find((t: any) => t.id === tab.id).openedBy.agent === 'codex');
  const tree = await (await fetch(base + '/api/agents?days=1')).json();
  assert.deepEqual(tree.agents.map((a: any) => a.agent), ['codex']);
  const memory = await (await fetch(base + '/api/memory')).json();
  assert.equal(memory.pid, child.pid, 'the runtime runs inside the Electron main process');
  console.log(`IN-PROCESS E2E PASS: runtime in Electron main (pid ${memory.pid}, heap ${memory.heapUsedMB} MB), whole flow ${Date.now() - started} ms`);
} finally {
  child.kill();
  await new Promise(r => setTimeout(r, 1500));
  fixture.close();
}
