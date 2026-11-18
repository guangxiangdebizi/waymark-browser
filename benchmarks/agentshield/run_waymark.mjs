// AgentShield form benchmark, Waymark arm: an LLM drives Waymark through MCP and fills the AgentShield test forms.
// Starts the AgentShield test site and N independent Waymark instances (own port, profile and audit dir each), runs
// sessions across them concurrently, then copies the site's telemetry to results/<form>/<label>/ for score.py.
//
//   LLM_BASE_URL  OpenAI-compatible endpoint (e.g. https://api.deepseek.com/v1)
//   LLM_API_KEY   key for that endpoint
//   LLM_MODEL     model id (default deepseek-chat)
//   AGENTSHIELD   path to a checkout of the AgentShield artifact repository (TestSite/ and FormInteraction/)
//
//   node run_waymark.mjs --form simpleForm|dynamicForm --n 10 --label waymark [--concurrency 4] [--ambient 1]
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RUNS = resolve(import.meta.dirname);
const AIB = resolve(RUNS, '..', '..');
const SHIELD = resolve(process.env.AGENTSHIELD ?? join(RUNS, 'AgentShield'));
const SITE = join(SHIELD, 'TestSite');
const SITE_PORT = 5001;
const ROUTE = { simpleForm: '/pledge-form', dynamicForm: '/dynamic-form' };
const sdk = p => pathToFileURL(join(AIB, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', p)).href;
const { Client } = await import(sdk('client/index.js'));
const { StreamableHTTPClientTransport } = await import(sdk('client/streamableHttp.js'));

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(s => s.trim().split(/\s+/)).map(([k, v]) => [k, v ?? '1']));
const form = args.form, n = Number(args.n ?? 10), label = args.label ?? 'aib', conc = Number(args.concurrency ?? 4);
const ambient = (args.ambient ?? '1') === '1';
const model = args.model ?? process.env.LLM_MODEL ?? 'deepseek-chat';
const baseUrl = (process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/$/, '');
if (!ROUTE[form]) throw new Error('--form simpleForm|dynamicForm');
const dest = join(RUNS, 'results', form, label); mkdirSync(dest, { recursive: true });
const token = process.env.LLM_API_KEY;
if (!token) throw new Error('set LLM_API_KEY (and LLM_BASE_URL / LLM_MODEL for a non-DeepSeek endpoint)');
const task = readFileSync(join(SHIELD, 'FormInteraction', 'dynamic_form_prompt.txt'), 'utf8')
  .replace('https://example.com/dynamic-form', `http://127.0.0.1:${SITE_PORT}${ROUTE[form]}`);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const children = [];

async function up(url, tries = 150) {
  for (let i = 0; i < tries; i++) { try { if ((await fetch(url)).ok) return; } catch {} await sleep(400); }
  throw new Error('not up: ' + url);
}

function startSite() {
  mkdirSync(join(SITE, 'logs'), { recursive: true });
  for (const p of [join(SITE, 'interaction-log.jsonl'), join(SITE, 'logs', 'tracker-log.jsonl')]) rmSync(p, { force: true });
  children.push(spawn('node', ['server.js'], { cwd: SITE, stdio: 'ignore', env: { ...process.env, PORT: String(SITE_PORT) } }));
  return up(`http://127.0.0.1:${SITE_PORT}/`);
}

function startInstance(i) {
  const dir = join(RUNS, 'instances', `inst${i}`); mkdirSync(dir, { recursive: true });
  const base = JSON.parse(readFileSync(join(AIB, 'config', 'electron.json'), 'utf8').replace(/^\uFEFF/, ''));
  const port = 9520 + i;
  const cfg = { ...base, settingsFile: join(dir, 'settings.json'), server: { ...base.server, port },
    browser: { ...base.browser, userDataDir: join(dir, 'profile'), ambientMouse: { ...base.browser.ambientMouse, enabled: ambient } },
    audit: { ...base.audit, directory: join(dir, 'audit') } };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ capabilities: { clipboard: 'action.clipboard.virtual' }, browser: { ambientMouse: { enabled: ambient } } }));
  const out = join(dir, 'app.log');
  const child = spawn('node', ['dist/app/launcher.js'], { cwd: AIB, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WAYMARK_CONFIG: join(dir, 'config.json') } });
  child.stdout.on('data', d => appendFileSync(out, d)); child.stderr.on('data', d => appendFileSync(out, d));
  children.push(child);
  return up(`http://127.0.0.1:${port}/health`).then(() => port);
}

async function mcp(port) {
  const client = new Client({ name: 'agentshield-waymark', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

const TOOLS = ['tabs', 'navigate', 'snapshot', 'read', 'act', 'wait'];

async function chat(messages, tools) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${baseUrl}/chat/completions`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, max_tokens: 4000 }) });
    if (r.ok) return (await r.json()).choices[0].message;
    log('llm http', r.status, (await r.text()).slice(0, 200)); await sleep(2000 * (attempt + 1));
  }
  throw new Error('llm failed');
}

async function session(port, run, meta) {
  const client = await mcp(port);
  const listed = (await client.listTools()).tools.filter(t => TOOLS.includes(t.name));
  const tools = listed.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  const opened = await client.callTool({ name: 'tabs', arguments: { action: 'new', url: 'about:blank' } });
  const pageId = Number(opened.content[0].text.match(/"id":\s*(\d+)/)?.[1] ?? opened.content[0].text.match(/"pageId":\s*(\d+)/)?.[1]);
  const messages = [
    { role: 'system', content: `You are an autonomous browser agent operating Waymark through tools. Your tab is page ${pageId}; use it for every call. Take a snapshot to get element refs before acting; each act result lists the elements that appeared, disappeared or changed, so you usually do not need another snapshot. When the task is finished, reply with a short final report and no tool calls.` },
    { role: 'user', content: task }];
  const t0 = Date.now(); let steps = 0, final = '', error = null;
  try {
    for (; steps < 60; steps++) {
      const msg = await chat(messages, tools);
      messages.push({ role: 'assistant', content: msg.content ?? '', ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}), ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
      if (!msg.tool_calls?.length) { final = msg.content ?? ''; break; }
      for (const call of msg.tool_calls) {
        let text;
        try {
          const res = await client.callTool({ name: call.function.name, arguments: JSON.parse(call.function.arguments || '{}') });
          text = res.content.map(c => c.text ?? '').join('\n');
        } catch (e) { text = 'error: ' + e.message; }
        messages.push({ role: 'tool', tool_call_id: call.id, content: text.slice(0, 20000) });
      }
    }
  } catch (e) { error = String(e).slice(0, 400); }
  await sleep(3000); // tracker 每 2s 批量上报
  await client.callTool({ name: 'tabs', arguments: { action: 'close', page: pageId } }).catch(() => {});
  await client.close().catch(() => {});
  const rec = { form, run, port, model, ambient, steps, seconds: Math.round((Date.now() - t0) / 100) / 10, done: !!final, final: final.slice(0, 600), error };
  appendFileSync(meta, JSON.stringify(rec) + '\n');
  console.log(JSON.stringify({ form, run, port, steps, seconds: rec.seconds, done: rec.done, error }));
}

try {
  await startSite(); log('site up');
  const ports = await Promise.all(Array.from({ length: conc }, (_, i) => startInstance(i + 1)));
  log('instances up', ports.join(','));
  const caps = await (await mcp(ports[0])).callTool({ name: 'capabilities', arguments: {} });
  writeFileSync(join(dest, 'capabilities.json'), caps.content[0].text);
  let next = 0;
  const meta = join(dest, 'runs.jsonl');
  await Promise.all(ports.map(async port => { while (next < n) { const run = next++; await session(port, run, meta); } }));
} finally {
  await sleep(2000);
  for (const [src, name] of [[join(SITE, 'interaction-log.jsonl'), 'interaction-log.jsonl'], [join(SITE, 'logs', 'tracker-log.jsonl'), 'tracker-log.jsonl']])
    if (existsSync(src)) appendFileSync(join(dest, name), readFileSync(src));
  for (const c of children) { try { spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {} }
  log('logs ->', dest);
  setTimeout(() => process.exit(0), 3000);
}
