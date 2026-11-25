// Memory and speed benchmark: Waymark (any build) or Chrome / Edge, same scenarios, one JSON result.
//
//   node benchmarks/memory/bench.mjs --target waymark [--app-dir DIR] [--label NAME] [--sites local|web] [--out FILE]
//   node benchmarks/memory/bench.mjs --target chrome|edge [--executable PATH]
//
// Scenarios: cold start, idle, 1 tab, 5 tabs, an agent task (snapshot / fill / select / click / type loop), first and
// later CAPTCHA (ddddocr), background-tab restore and pointer smoothness. Memory is sampled for the whole process tree
// every second; each scenario reports the median of its samples and the run reports the peak.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { snapshotProcesses, tree, summarize, describe } from './procmem.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  // --key value, --key=value (use = for values that start with --), or a bare --flag.
  if (value.startsWith('--') && value.includes('=')) pairs.push([value.slice(2, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]);
  else if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : 'true']);
  return pairs;
}, []));
const target = args.target ?? 'waymark';
const appDir = resolve(args['app-dir'] ?? '.');
const label = args.label ?? target;
const settle = Number(args.settle ?? 8000);
const repeat = Number(args.repeat ?? 1);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const merge = (into, from) => { for (const [k, v] of Object.entries(from)) { if (v && typeof v === 'object' && !Array.isArray(v) && into[k] && typeof into[k] === 'object') merge(into[k], v); else into[k] = v; } return into; };
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; };
const p95 = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0; };

// ---------- local fixture site: deterministic pages, a form, a CAPTCHA and a pointer recorder ----------
const captchaPng = existsSync(join(appDir, 'data/ocr-smoke.png')) ? readFileSync(join(appDir, 'data/ocr-smoke.png')) : readFileSync('data/ocr-smoke.png');
const article = n => `<!doctype html><html><head><meta charset="utf-8"><title>Article ${n}</title><style>body{font:16px/1.6 system-ui;max-width:860px;margin:40px auto}img{width:100%;height:180px;background:linear-gradient(90deg,#9ab,#cde)}</style></head><body><h1>Article ${n}</h1>${Array.from({ length: 40 }, (_, i) => `<h2>Section ${i}</h2><p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(12)}</p>${i % 5 === 0 ? '<img alt="">' : ''}<a href="#s${i}">link ${i}</a>`).join('')}<script>let t=0;setInterval(()=>{t++},1000)</script></body></html>`;
const pages = {
  '/form': `<!doctype html><html><head><meta charset="utf-8"><title>Form</title></head><body><h1>Order</h1>
<label>Name <input id="name"></label><label>Email <input id="email" type="email"></label>
<label>Size <select id="size"><option>Small</option><option>Medium</option><option>Large</option></select></label>
<label>Note <textarea id="note"></textarea></label><button id="go" onclick="document.querySelector('#out').textContent='sent '+Date.now()">Send order</button><div id="out"></div>
<pre id="moves"></pre><script>
// Pointer smoothness probe: gaps between mousemove events inside one movement (gaps under 250 ms), and moves per path.
const t=[];addEventListener('mousemove',()=>t.push(performance.now()),{passive:true});
setInterval(()=>{const g=[];let paths=t.length?1:0;for(let i=1;i<t.length;i++){const d=t[i]-t[i-1];if(d<250)g.push(d);else paths++;}g.sort((a,b)=>a-b);
const q=p=>g.length?g[Math.min(g.length-1,Math.floor(p*g.length))].toFixed(1):0;document.getElementById('moves').textContent='MOVES '+JSON.stringify({events:t.length,paths,gapP50:+q(.5),gapP95:+q(.95),gapMax:+(g.at(-1)||0).toFixed(1)});},300);
</script></body></html>`,
  '/captcha': `<!doctype html><html><head><meta charset="utf-8"><title>OCR challenge</title></head><body><h1>安全验证</h1><form onsubmit="event.preventDefault();if(document.querySelector('[name=captcha]').value.toUpperCase()==='A7B2'){document.body.innerHTML='<h1>Verified challenge</h1>'}else{document.querySelector('#state').textContent='wrong'}"><img alt="captcha" src="data:image/png;base64,${captchaPng.toString('base64')}"><input name="captcha" placeholder="验证码"><button type="submit">提交验证</button></form><div id="state"></div></body></html>`
};
const fixture = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  const match = req.url.match(/^\/article\/(\d+)/);
  res.end(match ? article(match[1]) : pages[req.url.split('?')[0]] ?? article(0));
});
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${fixture.address().port}`;
const webSites = ['https://www.bing.com/', 'https://www.wikipedia.org/', 'https://github.com/', 'https://www.baidu.com/', 'https://developer.mozilla.org/en-US/'];
const sites = args.sites === 'web' ? webSites : [1, 2, 3, 4, 5].map(n => `${site}/article/${n}`);

// ---------- memory sampling ----------
let rootPid = 0;
const samples = [];
let phase = 'start';
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    if (rootPid) {
      try {
        const list = tree(await snapshotProcesses(), rootPid);
        samples.push({ at: Date.now(), phase, ...summarize(list) });
      } catch { /* a process exited mid-query */ }
    }
    await sleep(1000);
  }
})();
async function measure(name, ms = 5000) {
  phase = name;
  const start = samples.length;
  await sleep(ms);
  const taken = samples.slice(start).filter(s => s.phase === name);
  const pick = taken.length ? taken.reduce((best, s) => Math.abs(s.privateMB - median(taken.map(t => t.privateMB))) < Math.abs(best.privateMB - median(taken.map(t => t.privateMB))) ? s : best) : undefined;
  // One detailed listing per scenario: which process (by role) holds how much.
  let roles;
  try { roles = await describe(tree(await snapshotProcesses(), rootPid)); } catch { roles = undefined; }
  return pick ? { privateMB: pick.privateMB, wsMB: pick.wsMB, commitMB: pick.commitMB, processes: pick.processes, byName: pick.byName, roles } : undefined;
}

const result = { label, target, at: new Date().toISOString(), platform: process.platform, sites: args.sites ?? 'local', scenarios: {}, speed: {} };

// ---------- Waymark driver: plain MCP over HTTP ----------
async function waymark() {
  const dir = mkdtempSync(join(tmpdir(), 'waymark-bench-'));
  const probe = createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const config = JSON.parse(readFileSync(join(appDir, 'config/electron.json'), 'utf8'));
  Object.assign(config.server, { port });
  config.settingsFile = join(dir, 'settings.json');
  config.browser.userDataDir = join(dir, 'profile');
  config.audit.directory = join(dir, 'audit');
  config.challenge.pythonCommand = process.env.WAYMARK_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  config.challenge.timeoutMs = 60000;
  if (args.config) merge(config, JSON.parse(args.config));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  // Start it the way `waymark start` does: Electron directly when the build runs the runtime in-process (0.6+),
  // otherwise the Node launcher (0.5 and earlier, or --legacy).
  const electronDir = join(appDir, 'node_modules/electron');
  const electronBinary = existsSync(join(electronDir, 'path.txt')) ? join(electronDir, 'dist', readFileSync(join(electronDir, 'path.txt'), 'utf8').trim()) : '';
  const inProcess = !args.legacy && existsSync(join(appDir, 'dist/app/inprocess.js')) && existsSync(electronBinary);
  const electronArgs = (args['electron-args'] ?? process.env.WAYMARK_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean);
  const command = inProcess ? [electronBinary, ...electronArgs, 'dist/app/electron-main.js'] : [process.execPath, ...(args['node-args'] ? args['node-args'].split(' ') : []), 'dist/app/launcher.js'];
  result.mode = inProcess ? 'in-process' : 'node-launcher';
  const child = spawn(command[0], command.slice(1), { cwd: appDir, env: { ...process.env, WAYMARK_CONFIG: join(dir, 'config.json'), ...(inProcess ? { WAYMARK_INPROCESS: '1' } : {}), ...(args.legacy ? { WAYMARK_LEGACY_DRIVER: '1' } : {}), ...(args['electron-args'] ? { WAYMARK_ELECTRON_ARGS: args['electron-args'] } : {}) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', () => undefined);
  child.stderr.on('data', chunk => { if (args.verbose) process.stderr.write(chunk); });
  rootPid = child.pid;
  let id = 0;
  const call = async (name, argsIn = {}) => {
    const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-waymark-agent': 'bench', 'x-waymark-stateless': '1' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: argsIn } }) });
    const text = await response.text();
    const line = text.split('\n').find(l => l.startsWith('data:'));
    const reply = JSON.parse(line ? line.slice(5) : text);
    const body = reply.result.content[0].text;
    const value = JSON.parse(body.slice(body.indexOf('\n') + 1, body.lastIndexOf('\n[END_UNTRUSTED')));
    if (reply.result.isError) throw new Error(value.error);
    return value;
  };
  // Ready = the API answers and the start page has loaded (checked without MCP, so no agent is seen yet).
  for (;;) {
    try { const status = await (await fetch(base + '/api/status')).json(); if (status.tabs >= 1) break; } catch { /* starting */ }
    if (Date.now() - started > 120000) throw new Error('Waymark did not start');
    await sleep(100);
  }
  result.speed.coldStartMs = Date.now() - started;
  const timed = async (fn) => { const t = performance.now(); const value = await fn(); return { ms: Math.round(performance.now() - t), value }; };
  return {
    call, timed, base,
    async close() {
      try { await fetch(base + '/api/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"paused":false}' }); } catch { /* ignore */ }
      child.kill();
      await sleep(1500);
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      await sleep(1500);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* files still locked */ }
    }
  };
}

async function runWaymark() {
  const app = await waymark();
  if (args['cold-captcha']) {
    // Worst case for OCR warm-up: the first thing the first agent ever does is open a page with a CAPTCHA.
    await sleep(Number(args.settle ?? 5000));
    const tab = (await app.call('tabs', { action: 'new', url: 'about:blank' })).id;
    const cold = await app.timed(() => app.call('navigate', { page: tab, action: 'url', url: site + '/captcha' }));
    result.speed.coldCaptchaMs = cold.ms;
    result.speed.coldCaptchaStatus = cold.value.challenge?.status;
    result.scenarios.afterColdCaptcha = await measure('afterColdCaptcha', 3000);
    return app;
  }
  try {
    result.scenarios.idle = await measure('idle', settle + 5000);
    result.runtimeIdle = await fetch(app.base + '/api/memory').then(r => r.json()).catch(() => undefined);
    const tabs = [];
    for (const [index, url] of sites.entries()) {
      const opened = await app.timed(() => app.call('tabs', { action: 'new', url: 'about:blank' }));
      const nav = await app.timed(() => app.call('navigate', { page: opened.value.id, action: 'url', url }));
      tabs.push(opened.value.id);
      (result.speed.pageOpenMs ??= []).push(nav.ms);
      if (index === 0) result.scenarios.tab1 = await measure('tab1', settle);
    }
    result.scenarios.tab5 = await measure('tab5', settle);
    // The same five tabs after they have sat in the background for a while (the visible tab is the last one).
    if (Number(args.later)) { await sleep(Number(args.later)); result.scenarios.tab5Later = await measure('tab5Later', 5000); }

    // Agent task on the form page.
    phase = 'agent';
    const form = (await app.call('tabs', { action: 'new', url: site + '/form' })).id;
    const actMs = [];
    const snapshotMs = [];
    for (let round = 0; round < 4; round++) {
      const snap = await app.timed(() => app.call('snapshot', { page: form }));
      snapshotMs.push(snap.ms);
      const refs = Object.values(snap.value.refs);
      const ref = name => refs.find(r => r.name.includes(name)).ref;
      for (const step of [
        { kind: 'fill', fields: [{ ref: ref('Name'), value: 'Ada Lovelace' }, { ref: ref('Email'), value: 'ada@example.com' }] },
        { kind: 'select', ref: ref('Size'), value: round % 2 ? 'Large' : 'Medium' },
        { kind: 'type', ref: ref('Note'), value: 'please ring twice' },
        { kind: 'click', ref: ref('Send order') }
      ]) {
        let r;
        try { r = await app.call('act', { page: form, ...step }); }
        catch (error) {
          // Like an agent would: take a fresh snapshot and try once more; counted, so a regression still shows.
          result.actRetries = [...(result.actRetries ?? []), `${step.kind}: ${String(error.message).slice(0, 80)}`];
          const fresh = Object.values((await app.call('snapshot', { page: form })).refs);
          const name = step.kind === 'fill' ? null : refs.find(x => x.ref === step.ref)?.name;
          const again = step.kind === 'fill'
            ? { ...step, fields: step.fields.map(f => ({ ...f, ref: fresh.find(x => x.name === refs.find(y => y.ref === f.ref)?.name)?.ref ?? f.ref })) }
            : { ...step, ref: fresh.find(x => x.name === name)?.ref ?? step.ref };
          r = await app.call('act', { page: form, ...again });
        }
        const trace = await app.call('audit', { action: 'get', id: r.traceId });
        actMs.push({ kind: step.kind, execMs: trace.event.durationMs, pacedMs: trace.event.detail?.pacedMs ?? 0 });
      }
    }
    result.scenarios.agentTask = await measure('agentTask', 3000);
    result.speed.snapshotMs = { median: median(snapshotMs), p95: p95(snapshotMs) };
    result.actRaw = actMs;
    for (const kind of ['fill', 'select', 'type', 'click']) {
      const values = actMs.filter(a => a.kind === kind).map(a => a.execMs);
      result.speed[`act_${kind}_ms`] = { median: median(values), p95: p95(values) };
    }
    // Pointer smoothness: mousemove events per pointer path and the gaps between them, measured inside the page.
    await sleep(500);
    const text = (await app.call('read', { page: form })).text;
    const probe = text.match(/MOVES (\{.*\})/);
    if (probe) { const stats = JSON.parse(probe[1]); result.speed.pointer = { ...stats, eventsPerPath: Math.round(stats.events / Math.max(1, stats.paths)) }; }

    // CAPTCHA: first solve, then a second one on a reload.
    const captchaTab = (await app.call('tabs', { action: 'new', url: 'about:blank' })).id;
    const first = await app.timed(() => app.call('navigate', { page: captchaTab, action: 'url', url: site + '/captcha' }));
    const second = await app.timed(() => app.call('navigate', { page: captchaTab, action: 'url', url: site + '/captcha?2' }));
    result.speed.captchaFirstMs = first.ms;
    result.speed.captchaFirstStatus = first.value.challenge?.status;
    result.speed.captchaSecondMs = second.ms;
    result.speed.captchaSecondStatus = second.value.challenge?.status;
    result.scenarios.afterCaptcha = await measure('afterCaptcha', 3000);

    // Background tab restore: the first site tab has sat in the background the whole time.
    const restore = await app.timed(async () => { await app.call('tabs', { action: 'active', page: tabs[0] }); return await app.call('snapshot', { page: tabs[0] }); });
    result.speed.tabRestoreMs = restore.ms;
    result.speed.restoredRefs = Object.keys(restore.value.refs).length;
    result.scenarios.idleAfterWork = await measure('idleAfterWork', settle + 5000);
    result.runtimeAfterWork = await fetch(app.base + '/api/memory').then(r => r.json()).catch(() => undefined);

    // Soak: keep an agent busy for N minutes (navigate, snapshot, fill, select, click, read, screenshot) and watch
    // memory per minute. A leak shows up as a steady slope after the first minutes.
    if (Number(args.soak)) {
      phase = 'soak';
      const until = Date.now() + Number(args.soak) * 60000;
      const perMinute = [];
      let nextMark = Date.now() + 60000;
      let rounds = 0;
      while (Date.now() < until) {
        const page = tabs[rounds % tabs.length];
        await app.call('navigate', { page, action: 'url', url: sites[rounds % sites.length] + (sites[0].startsWith(site) ? `?r=${rounds}` : '') }).catch(() => undefined);
        await app.call('snapshot', { page }).catch(() => undefined);
        await app.call('read', { page, limit: 4000 }).catch(() => undefined);
        const snap = await app.call('snapshot', { page: form }).catch(() => undefined);
        if (snap) {
          const refs = Object.values(snap.refs);
          const ref = name => refs.find(r => r.name.includes(name))?.ref;
          await app.call('act', { page: form, kind: 'select', ref: ref('Size'), value: rounds % 2 ? 'Small' : 'Large' }).catch(() => undefined);
          await app.call('act', { page: form, kind: 'click', ref: ref('Send order') }).catch(() => undefined);
        }
        if (rounds % 5 === 0) await app.call('screenshot', { page: form }).catch(() => undefined);
        rounds++;
        if (Date.now() >= nextMark) {
          nextMark += 60000;
          const now = samples.filter(x => x.phase === 'soak').at(-1);
          if (now) perMinute.push({ minute: perMinute.length + 1, privateMB: now.privateMB, rounds, runtime: await fetch(app.base + '/api/memory').then(r => r.json()).then(m => ({ rssMB: m.rssMB, heapUsedMB: m.heapUsedMB })).catch(() => undefined) });
        }
      }
      const tail = perMinute.slice(Math.floor(perMinute.length / 2));
      const slope = tail.length > 1 ? (() => {
        const n = tail.length, mx = tail.reduce((a, p) => a + p.minute, 0) / n, my = tail.reduce((a, p) => a + p.privateMB, 0) / n;
        const num = tail.reduce((a, p) => a + (p.minute - mx) * (p.privateMB - my), 0), den = tail.reduce((a, p) => a + (p.minute - mx) ** 2, 0);
        return den ? Math.round(num / den * 60 * 10) / 10 : 0;
      })() : 0;
      const heap = perMinute.map(p => p.runtime?.heapUsedMB).filter(v => v !== undefined);
      result.soak = { minutes: Number(args.soak), rounds, perMinute, slopeMBPerHourSecondHalf: slope, runtimeHeapFirstMB: heap[0], runtimeHeapLastMB: heap.at(-1) };
    }
    return app;
  } catch (error) { await app.close(); throw error; }
}

// ---------- Chrome / Edge driver: the same pages through CDP ----------
async function runBrowser(kind) {
  const defaults = process.platform === 'win32'
    ? { edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }
    : process.platform === 'darwin' ? { edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }
    : { edge: '/usr/bin/microsoft-edge', chrome: '/usr/bin/google-chrome' };
  const exe = args.executable ?? defaults[kind];
  if (!existsSync(exe)) throw new Error(`${kind} not found at ${exe}; pass --executable`);
  const dir = mkdtempSync(join(tmpdir(), `${kind}-bench-`));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const started = Date.now();
  const child = spawn(exe, [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore', windowsHide: false });
  rootPid = child.pid;
  let version;
  for (;;) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(100); }
    if (Date.now() - started > 60000) throw new Error(`${kind} did not start`);
  }
  result.speed.coldStartMs = Date.now() - started;
  result.version = version.Browser;
  // The first browser process may hand off to another; follow the tree from the process that owns the debug port.
  const { chromium } = await import(resolve(appDir, 'node_modules/playwright-core/index.mjs')).catch(() => import('playwright-core'));
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  result.scenarios.idle = await measure('idle', settle + 5000);
  for (const [index, url] of sites.entries()) {
    const page = await context.newPage();
    const t = performance.now();
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    (result.speed.pageOpenMs ??= []).push(Math.round(performance.now() - t));
    if (index === 0) result.scenarios.tab1 = await measure('tab1', settle);
  }
  result.scenarios.tab5 = await measure('tab5', settle);
  if (Number(args.later)) { await sleep(Number(args.later)); result.scenarios.tab5Later = await measure('tab5Later', 5000); }
  return { async close() { await browser.close().catch(() => undefined); child.kill(); await sleep(1500); if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); await sleep(1000); try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked */ } } };
}

let handle;
try {
  handle = target === 'waymark' ? await runWaymark() : await runBrowser(target);
  result.peak = samples.reduce((best, s) => s.privateMB > (best?.privateMB ?? 0) ? s : best, undefined);
  if (result.peak) result.peak = { privateMB: result.peak.privateMB, wsMB: result.peak.wsMB, phase: result.peak.phase };
  if (result.speed.pageOpenMs) result.speed.pageOpenMedianMs = median(result.speed.pageOpenMs);
} finally {
  sampling = false;
  await sampler;
  await handle?.close();
  fixture.close();
}
const out = args.out ?? `.research/memory/${label}-${Date.now()}.json`;
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 2));
const line = name => result.scenarios[name] ? `${name.padEnd(14)} ${String(result.scenarios[name].privateMB).padStart(7)} MB private  ${String(result.scenarios[name].wsMB).padStart(7)} MB WS  ${result.scenarios[name].processes} procs` : '';
console.log([`${label} (${target})`, ...Object.keys(result.scenarios).map(line), `peak           ${result.peak?.privateMB} MB (${result.peak?.phase})`, `speed          ${JSON.stringify(result.speed)}`, `-> ${out}`].join('\n'));
