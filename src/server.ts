import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AppConfig } from './types.js';
import { BrowserRuntime } from './browser/BrowserRuntime.js';
import { ChallengeBroker } from './challenge/ChallengeBroker.js';
import { createMcpServer } from './mcp/server.js';
import { dashboardHtml } from './web/dashboard.js';
import { homeHtml } from './web/home.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromRoot } from './config.js';
import { languageCodes, normalizeLanguage } from './i18n.js';
import { CAPABILITY_SLOTS, type CapabilitySlot } from './capabilities/slots.js';
import { randomUUID } from 'node:crypto';
import v8 from 'node:v8';
import { IdentityRegistry, LOCAL_UI_ACTOR, runAs, agentLabel, KNOWN_AGENTS } from './audit/Actor.js';
import { computeInsights, serializeReport, agentOf } from './insights/Insights.js';
import { buildProvenance, sessionDetail } from './insights/Provenance.js';
import { agentsHtml } from './web/agents.js';
import { insightsHtml } from './web/insights.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface ServerHooks {
  /** Open a local page in its own desktop window (the Electron shell provides this). */
  openWindow?: (kind: 'agents' | 'insights', query?: string) => Promise<boolean> | boolean;
}

const isInitialize = (body: unknown) => (Array.isArray(body) ? body : [body]).some(message => (message as { method?: string })?.method === 'initialize');

export async function startServer(config: AppConfig, runtime: BrowserRuntime, challenges: ChallengeBroker, hooks: ServerHooks = {}) {
  const app = express();
  config.uiLanguage = normalizeLanguage(config.uiLanguage);
  app.use(express.json({ limit: '1mb' }));
  // Pages in other tabs can fire simple cross-origin POSTs at localhost; cockpit writes require JSON and a local origin.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET') { next(); return; }
    const origin = req.get('origin');
    if (origin && origin !== `http://${config.server.host}:${config.server.port}`) { res.status(403).json({ error: 'Cross-origin cockpit request refused' }); return; }
    if (!req.is('application/json')) { res.status(415).json({ error: 'Use application/json' }); return; }
    next();
  });

  // MCP. A client that initializes gets a session (Mcp-Session-Id), so its clientInfo identifies every later call and
  // several windows of the same agent stay apart. Requests without a session id are served statelessly as before, so
  // simple clients (curl, the Waymark CLI, scripts) keep working; they can name themselves with X-Waymark-* headers.
  const identities = new IdentityRegistry();
  const mcpOptions = { identities, assumptions: config.insights };
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
  const closeSession = (id: string) => {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    identities.forgetSession(id);
    void entry.transport.close().catch(() => undefined);
    void entry.server.close().catch(() => undefined);
  };
  const sweeper = setInterval(() => { for (const id of identities.expire()) closeSession(id); }, 10 * 60 * 1000);
  sweeper.unref();
  app.post('/mcp', async (req, res) => {
    // An agent is here (connecting, listing tools or acting): have the OCR model ready before it meets a CAPTCHA.
    (challenges as { prepare?: (reason?: 'agent') => void }).prepare?.('agent');
    const sessionId = req.get('mcp-session-id');
    const known = sessionId ? sessions.get(sessionId) : undefined;
    if (known) { await known.transport.handleRequest(req, res, req.body); return; }
    const stateless = Boolean(sessionId) || req.get('x-waymark-stateless') === '1' || !isInitialize(req.body);
    if (stateless) {
      // An unknown session id (for example after Waymark restarted) is served statelessly rather than refused.
      const server = createMcpServer(runtime, challenges, mcpOptions);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    const server = createMcpServer(runtime, challenges, mcpOptions);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => { sessions.set(id, { transport, server }); identities.noteSession(id); },
      onsessionclosed: id => closeSession(id)
    });
    server.server.oninitialized = () => {
      const id = transport.sessionId;
      if (!id) return;
      const client = server.server.getClientVersion();
      identities.noteSession(id, client ? { name: client.name, version: client.version } : undefined);
      const actor = identities.resolve({ headers: req.headers as Record<string, string>, url: new URL(req.originalUrl, 'http://local'), sessionId: id });
      runtime.audit.record({ action: 'agent.connected', status: 'info', actor, detail: { client: client ? { name: client.name, version: client.version } : undefined, userAgent: req.get('user-agent')?.slice(0, 120) } });
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get('/mcp', async (req, res) => {
    const known = sessions.get(req.get('mcp-session-id') ?? '');
    if (known) { await known.transport.handleRequest(req, res); return; }
    res.status(405).json({ error: 'Use POST for MCP requests' });
  });
  app.delete('/mcp', async (req, res) => {
    const known = sessions.get(req.get('mcp-session-id') ?? '');
    if (known) { await known.transport.handleRequest(req, res); return; }
    res.status(404).json({ error: 'Unknown MCP session' });
  });
  app.get('/health', (_req, res) => res.json({ ok: true, mcp: '/mcp', audit: '/audit' }));
  const labelsPath = join(dirname(fileURLToPath(import.meta.url)), 'app', 'shell', 'labels.js');
  app.get('/assets/labels.js', (_req, res) => res.type('application/javascript').send(readFileSync(labelsPath, 'utf8')));
  for (const name of ['i18n.cjs', 'translations.cjs', 'home.js', 'dashboard.js', 'agents.js', 'insights.js', 'charts.js']) {
    app.get(`/assets/${name}`, (_req, res) => res.type('application/javascript').send(readFileSync(join(dirname(labelsPath), name), 'utf8')));
  }
  app.get('/', (_req, res) => res.redirect('/home'));
  app.get('/home', (_req, res) => res.type('html').send(homeHtml(config)));
  app.get('/audit', (_req, res) => res.type('html').send(dashboardHtml(config.uiLanguage)));
  app.get('/agents', (_req, res) => res.type('html').send(agentsHtml(config.uiLanguage)));
  app.get('/insights', (_req, res) => res.type('html').send(insightsHtml(config.uiLanguage)));

  // Provenance: agent -> session -> tab -> step, and the statistics built on it. Read-only, local only.
  const days = (value: unknown, fallback = 30) => Math.min(3650, Math.max(1, Number(value) || fallback));
  const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
  const since = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
  app.get('/api/agents', async (req, res) => {
    res.json({ ...buildProvenance(await runtime.audit.read(since(days(req.query.days))), { days: days(req.query.days), agent: text(req.query.agent), q: text(req.query.q), assumptions: config.insights }), known: KNOWN_AGENTS.map(({ id, label }) => ({ id, label })) });
  });
  app.get('/api/sessions/:key', async (req, res) => {
    const options = { idle: req.query.idle === '1', gapMinutes: config.insights?.sessionGapMinutes };
    // Sessions listed in the manager fall inside its window; an older key is looked up in the whole ledger.
    const detail = sessionDetail(await runtime.audit.read(since(days(req.query.days, 90))), req.params.key, options)
      ?? sessionDetail(await runtime.audit.read(), req.params.key, options);
    if (!detail) res.status(404).json({ error: 'Unknown session' }); else res.json(detail);
  });
  app.get('/api/insights', async (req, res) => {
    res.json(serializeReport(computeInsights(await runtime.audit.read(since(days(req.query.days))), { days: days(req.query.days), agent: text(req.query.agent), session: text(req.query.session), assumptions: config.insights })));
  });
  // Memory of the runtime process itself, for diagnostics and the memory benchmark.
  app.get('/api/memory', (_req, res) => {
    const usage = process.memoryUsage();
    const toMB = (bytes: number) => Math.round(bytes / 104857.6) / 10;
    res.json({
      pid: process.pid, rssMB: toMB(usage.rss), heapUsedMB: toMB(usage.heapUsed), heapTotalMB: toMB(usage.heapTotal), externalMB: toMB(usage.external), arrayBuffersMB: toMB(usage.arrayBuffers),
      spaces: Object.fromEntries(v8.getHeapSpaceStatistics().map(space => [space.space_name, { sizeMB: toMB(space.space_size), usedMB: toMB(space.space_used_size) }])),
      pages: runtime.pageCount()
    });
  });
  app.get('/api/identity', (req, res) => {
    const actor = identities.resolve({ headers: req.headers as Record<string, string>, url: new URL(req.originalUrl, 'http://local') });
    res.json({ ...actor, label: agentLabel(actor.agent) });
  });
  app.get('/api/audit/screens/:name', (req, res) => {
    const path = runtime.audit.screenshotPath(req.params.name);
    if (!path) { res.status(404).json({ error: 'not found' }); return; }
    res.set('Cache-Control', 'private, max-age=86400').sendFile(path);
  });
  app.post('/api/audit/prune', (req, res) => {
    try { res.json(runAs(LOCAL_UI_ACTOR, () => runtime.audit.prune(Number(req.body?.days), req.body?.dryRun !== false))); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post('/api/windows', async (req, res) => {
    const kind = req.body?.kind === 'insights' ? 'insights' : 'agents';
    const opened = hooks.openWindow ? await hooks.openWindow(kind, typeof req.body?.query === 'string' ? req.body.query : undefined) : false;
    res.json({ ok: true, opened, url: `http://${config.server.host}:${config.server.port}/${kind}` });
  });
  app.get('/api/audit/events', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const includeAmbient = req.query.ambient !== '0';
    const action = typeof req.query.action === 'string' && req.query.action ? req.query.action : undefined;
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase() : '';
    const agent = typeof req.query.agent === 'string' && req.query.agent ? req.query.agent : undefined;
    const session = typeof req.query.session === 'string' && req.query.session ? req.query.session : undefined;
    const includeCalls = req.query.calls === '1';
    res.json(runtime.audit.list(limit, event =>
      (includeAmbient || !isIdle(event.action)) &&
      (includeCalls || (event.action !== 'mcp.call' && event.action !== 'trace.screenshot')) &&
      (!agent || agentOf(event) === agent) &&
      (!session || event.session === session || event.actor?.session === session) &&
      (!action || event.action === action || event.action.startsWith(action + '.')) &&
      (!status || event.status === status) &&
      (!q || JSON.stringify([event.action, event.session, event.before, event.after, event.error, event.id, event.actor?.agent, event.actor?.window]).toLowerCase().includes(q))
    ));
  });
  app.get('/api/status', (_req, res) => {
    const latest = runtime.audit.list(1, event => !isIdle(event.action) && event.action !== 'tabs.list' && event.action !== 'mcp.call' && event.action !== 'trace.screenshot' && !event.action.startsWith('settings.'))[0];
    const recentAgents = new Map<string, string>();
    for (const event of runtime.audit.list(2000, item => item.action === 'mcp.call' && Date.now() - Date.parse(item.timestamp) < 10 * 60000)) if (!recentAgents.has(agentOf(event))) recentAgents.set(agentOf(event), event.timestamp);
    res.json({
      session: runtime.audit.getSession(), paused: runtime.isPaused(), busy: runtime.busyCount(), tabs: runtime.pageCount(),
      uiLanguage: config.uiLanguage,
      clipboardProvider: runtime.getClipboardProviderId(), ambientMouse: runtime.getAmbientMouseState(),
      slots: runtime.slots(),
      lastActionAt: latest?.timestamp ?? null,
      // Lets the side panel skip re-reading the timeline when nothing new was written.
      sequence: runtime.audit.list(1)[0]?.sequence ?? 0,
      agentSequence: latest?.sequence ?? 0,
      todayActions: runtime.audit.todayActions(),
      activeAgents: [...recentAgents.entries()].map(([agent, at]) => ({ agent, label: agentLabel(agent), lastCallAt: at })),
      challenges: challenges.list().slice(0, 30), mcp: `http://${config.server.host}:${config.server.port}/mcp`
    });
  });
  app.post('/api/control', (req, res) => {
    if (typeof req.body?.paused !== 'boolean') { res.status(400).json({ error: 'paused must be boolean' }); return; }
    runAs(LOCAL_UI_ACTOR, () => runtime.setPaused(req.body.paused));
    res.json({ ok: true, paused: runtime.isPaused() });
  });
  app.get('/api/audit/events/:id', (req, res) => {
    const item = runtime.audit.get(req.params.id);
    if (!item) res.status(404).json({ error: 'not found' }); else res.json(item);
  });
  app.get('/api/settings', (_req, res) => res.json({ uiLanguage: config.uiLanguage, clipboardProvider: runtime.getClipboardProviderId(), ambientMouse: runtime.getAmbientMouseState(), slots: runtime.slots() }));
  app.post('/api/settings', (req, res) => runAs(LOCAL_UI_ACTOR, () => {
    try {
      const uiLanguage = req.body?.uiLanguage;
      if (uiLanguage !== undefined && !languageCodes.includes(uiLanguage)) throw new Error('Unsupported UI language');
      if (req.body?.clipboardProvider !== undefined) runtime.setClipboardProvider(String(req.body.clipboardProvider));
      if (typeof req.body?.ambientMouseEnabled === 'boolean') runtime.setAmbientMouseEnabled(req.body.ambientMouseEnabled);
      if (typeof req.body?.pointerProvider === 'string') runtime.setSlot('pointer', req.body.pointerProvider);
      for (const [slot, value] of Object.entries(req.body?.slots ?? {})) {
        if (!(CAPABILITY_SLOTS as readonly string[]).includes(slot) || typeof value !== 'string') throw new Error(`Unknown slot ${slot}`);
        runtime.setSlot(slot as CapabilitySlot, value);
      }
      const path = fromRoot(config.settingsFile);
      mkdirSync(dirname(path), { recursive: true });
      const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
      current.uiLanguage = uiLanguage ?? config.uiLanguage;
      const slots = runtime.slots();
      current.capabilities = { ...current.capabilities, clipboard: slots.clipboard.active, pointer: slots.pointer.active, keyboard: slots.keyboard.active, pacing: slots.pacing.active, idle: slots.idle.active, challengeOcr: slots.ocr.active };
      current.browser = { ...current.browser, ambientMouse: { ...current.browser?.ambientMouse, enabled: runtime.getAmbientMouseState().enabled } };
      writeFileSync(path, JSON.stringify(current, null, 2));
      config.uiLanguage = current.uiLanguage;
      res.json({ ok: true, uiLanguage: config.uiLanguage, clipboardProvider: runtime.getClipboardProviderId(), ambientMouse: runtime.getAmbientMouseState(), slots });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  }));
  app.get('/api/challenges', (_req, res) => res.json(challenges.list()));
  for (const action of ['human_start', 'human_complete', 'cancel'] as const) {
    app.post(`/api/challenges/:id/${action}`, async (req, res) => {
      try { res.json(await runAs(LOCAL_UI_ACTOR, () => challenges.command(action, req.params.id, 'Updated from local audit cockpit'))); }
      catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
    });
  }

  return new Promise<{ close: () => Promise<void> }>(resolvePromise => {
    const http = app.listen(config.server.port, config.server.host, () => {
      console.log(`Waymark MCP: http://${config.server.host}:${config.server.port}/mcp`);
      console.log(`Waymark audit: http://${config.server.host}:${config.server.port}/audit`);
      console.log(`Waymark agents: http://${config.server.host}:${config.server.port}/agents  insights: /insights`);
      resolvePromise({ close: () => new Promise(resolveClose => { clearInterval(sweeper); for (const id of [...sessions.keys()]) closeSession(id); http.close(() => resolveClose()); }) });
    });
  });
}

/** Idle behaviour (pointer drift, idle clicks, scrolls and visits) is kept out of the agent's activity counts. */
function isIdle(action: string): boolean { return action === 'mouse.ambient' || action.startsWith('idle.'); }
