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

export async function startServer(config: AppConfig, runtime: BrowserRuntime, challenges: ChallengeBroker) {
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

  app.post('/mcp', async (req, res) => {
    const server = createMcpServer(runtime, challenges);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get('/mcp', (_req, res) => res.status(405).json({ error: 'Use POST for stateless MCP requests' }));
  app.get('/health', (_req, res) => res.json({ ok: true, mcp: '/mcp', audit: '/audit' }));
  const labelsPath = join(dirname(fileURLToPath(import.meta.url)), 'app', 'shell', 'labels.js');
  app.get('/assets/labels.js', (_req, res) => res.type('application/javascript').send(readFileSync(labelsPath, 'utf8')));
  for (const name of ['i18n.cjs', 'translations.cjs', 'home.js', 'dashboard.js']) {
    app.get(`/assets/${name}`, (_req, res) => res.type('application/javascript').send(readFileSync(join(dirname(labelsPath), name), 'utf8')));
  }
  app.get('/', (_req, res) => res.redirect('/home'));
  app.get('/home', (_req, res) => res.type('html').send(homeHtml(config)));
  app.get('/audit', (_req, res) => res.type('html').send(dashboardHtml(config.uiLanguage)));
  app.get('/api/audit/events', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const includeAmbient = req.query.ambient !== '0';
    const action = typeof req.query.action === 'string' && req.query.action ? req.query.action : undefined;
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase() : '';
    res.json(runtime.audit.list(limit, event =>
      (includeAmbient || event.action !== 'mouse.ambient') &&
      (!action || event.action === action || event.action.startsWith(action + '.')) &&
      (!status || event.status === status) &&
      (!q || JSON.stringify([event.action, event.session, event.before, event.after, event.error, event.id]).toLowerCase().includes(q))
    ));
  });
  app.get('/api/status', (_req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const latest = runtime.audit.list(1, event => event.action !== 'mouse.ambient' && event.action !== 'tabs.list' && !event.action.startsWith('settings.'))[0];
    res.json({
      session: runtime.audit.getSession(), paused: runtime.isPaused(), busy: runtime.busyCount(), tabs: runtime.pageCount(),
      uiLanguage: config.uiLanguage,
      clipboardProvider: runtime.getClipboardProviderId(), ambientMouse: runtime.getAmbientMouseState(),
      slots: runtime.slots(),
      lastActionAt: latest?.timestamp ?? null,
      todayActions: runtime.audit.list(5000, event => event.timestamp.startsWith(today) && (event.status === 'success' || event.status === 'failure')).length,
      challenges: challenges.list().slice(0, 30), mcp: `http://${config.server.host}:${config.server.port}/mcp`
    });
  });
  app.post('/api/control', (req, res) => {
    if (typeof req.body?.paused !== 'boolean') { res.status(400).json({ error: 'paused must be boolean' }); return; }
    runtime.setPaused(req.body.paused);
    res.json({ ok: true, paused: runtime.isPaused() });
  });
  app.get('/api/audit/events/:id', (req, res) => {
    const item = runtime.audit.get(req.params.id);
    if (!item) res.status(404).json({ error: 'not found' }); else res.json(item);
  });
  app.get('/api/settings', (_req, res) => res.json({ uiLanguage: config.uiLanguage, clipboardProvider: runtime.getClipboardProviderId(), ambientMouse: runtime.getAmbientMouseState(), slots: runtime.slots() }));
  app.post('/api/settings', (req, res) => {
    try {
      const uiLanguage = req.body?.uiLanguage;
      if (uiLanguage !== undefined && !languageCodes.includes(uiLanguage)) throw new Error('Unsupported UI language');
      if (req.body?.clipboardProvider !== undefined) runtime.setClipboardProvider(String(req.body.clipboardProvider));
      if (typeof req.body?.ambientMouseEnabled === 'boolean') runtime.setAmbientMouseEnabled(req.body.ambientMouseEnabled);
      if (typeof req.body?.pointerProvider === 'string') runtime.setSlot('pointer', req.body.pointerProvider);
      for (const [slot, value] of Object.entries(req.body?.slots ?? {})) {
        if (!['pointer', 'ocr', 'clipboard'].includes(slot) || typeof value !== 'string') throw new Error(`Unknown slot ${slot}`);
        runtime.setSlot(slot as 'pointer' | 'ocr' | 'clipboard', value);
      }
      const path = fromRoot(config.settingsFile);
      mkdirSync(dirname(path), { recursive: true });
      const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
      current.uiLanguage = uiLanguage ?? config.uiLanguage;
      const slots = runtime.slots();
      current.capabilities = { ...current.capabilities, clipboard: slots.clipboard.active, pointer: slots.pointer.active, challengeOcr: slots.ocr.active };
      current.browser = { ...current.browser, ambientMouse: { ...current.browser?.ambientMouse, enabled: runtime.getAmbientMouseState().enabled } };
      writeFileSync(path, JSON.stringify(current, null, 2));
      config.uiLanguage = current.uiLanguage;
      res.json({ ok: true, uiLanguage: config.uiLanguage, clipboardProvider: runtime.getClipboardProviderId(), ambientMouse: runtime.getAmbientMouseState(), slots });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get('/api/challenges', (_req, res) => res.json(challenges.list()));
  for (const action of ['human_start', 'human_complete', 'cancel'] as const) {
    app.post(`/api/challenges/:id/${action}`, async (req, res) => {
      try { res.json(await challenges.command(action, req.params.id, 'Updated from local audit cockpit')); }
      catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
    });
  }

  return new Promise<{ close: () => Promise<void> }>(resolvePromise => {
    const http = app.listen(config.server.port, config.server.host, () => {
      console.log(`Waymark MCP: http://${config.server.host}:${config.server.port}/mcp`);
      console.log(`Waymark audit: http://${config.server.host}:${config.server.port}/audit`);
      resolvePromise({ close: () => new Promise(resolveClose => http.close(() => resolveClose())) });
    });
  });
}
