import type { AuditEvent } from '../audit/AuditLog.js';
import { agentLabel } from '../audit/Actor.js';

/**
 * Statistics and findings computed from the ledger. Everything here is derived from local ledger entries; numbers that
 * rest on an assumption are marked `estimate: true` and the assumption is returned alongside, so nothing is presented
 * as measured when it is not.
 *
 * To add a metric, push a definition onto METRICS (or call registerMetric); to add a finding, push a rule onto RULES.
 */
export interface EstimateAssumptions {
  /** Characters per token for text an agent receives or sends (rough average for mixed English/Chinese pages). */
  charsPerToken: number;
  /** Vision tokens one full-page screenshot costs an agent that works from screenshots instead of text snapshots. 0 turns the comparison off. */
  screenshotTokens: number;
  /** Tokens an agent spends on one CAPTCHA attempt by itself: image in, reasoning, answer out. */
  captchaTokensPerAttempt: number;
  /** Attempts an agent typically needs on a text CAPTCHA without a local OCR model. */
  captchaAttemptsWithoutOcr: number;
  /** Seconds a person needs to solve one text CAPTCHA when handed it. */
  humanSecondsPerCaptcha: number;
  /** A gap longer than this between two calls of one agent starts a new inferred session. */
  sessionGapMinutes: number;
  /** Gaps between calls longer than this are breaks, not thinking time. */
  thinkCapSeconds: number;
  /** A navigation slower than this counts as slow. */
  slowNavigateMs: number;
  /** How many times a URL or step sequence must recur to count as repetitive. */
  repeatThreshold: number;
}

export const DEFAULT_ASSUMPTIONS: EstimateAssumptions = {
  charsPerToken: 4,
  screenshotTokens: 1600,
  captchaTokensPerAttempt: 1500,
  captchaAttemptsWithoutOcr: 2,
  humanSecondsPerCaptcha: 20,
  sessionGapMinutes: 30,
  thinkCapSeconds: 300,
  slowNavigateMs: 5000,
  repeatThreshold: 3
};

export interface InsightOptions { days?: number; agent?: string; session?: string; now?: number; assumptions?: Partial<EstimateAssumptions> }

/** A step in an agent session after enrichment. */
export interface Step { event: AuditEvent; agent: string; sessionKey: string; tab?: string; host?: string }

export interface SessionSummary {
  key: string;
  agent: string;
  agentLabel: string;
  label: string;
  inferred: boolean;
  identity: string;
  window?: string;
  client?: string;
  start: string;
  end: string;
  durationMs: number;
  calls: number;
  actions: number;
  failures: number;
  challenges: number;
  tabs: string[];
  hosts: string[];
  tokensEstimated: number;
  tokensReported?: number;
  thinkMs: number;
  browserMs: number;
  signature: string;
}

export const isIdle = (action: string) => action === 'mouse.ambient' || action.startsWith('idle.');
const ACTIONS = new Set(['navigate', 'click', 'fill', 'press', 'scroll', 'hover', 'paste', 'copy', 'select', 'type']);
export const isAction = (event: AuditEvent) => ACTIONS.has(event.action) && (event.status === 'success' || event.status === 'failure');

export function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try { const parsed = new URL(url); return parsed.protocol.startsWith('http') ? parsed.host : undefined; } catch { return undefined; }
}
const pathOf = (url?: string) => { try { const parsed = new URL(url ?? ''); return parsed.host + parsed.pathname.replace(/\/\d+(?=\/|$)/g, '/:n'); } catch { return undefined; } };
const placeOf = (event: AuditEvent) => event.after?.url ?? event.before?.url ?? (event.target as { url?: string } | undefined)?.url;

/**
 * A tool call can fail before the browser does anything (a stale ref, a bad argument): then only its mcp.call entry
 * exists. For counting, such a call stands for the failed action it tried, carrying the call entry's id.
 */
export function withFailedCalls(events: AuditEvent[]): AuditEvent[] {
  const acted = new Set<string>();
  for (const event of events) if (event.actor?.call && (isAction(event) || event.status === 'started')) acted.add(event.actor.call);
  const out: AuditEvent[] = [];
  for (const event of events) {
    const call = event.action === 'mcp.call' ? event.detail as { tool?: string; ok?: boolean; error?: string; args?: { kind?: string } } : undefined;
    if (call && call.ok === false && (call.tool === 'act' || call.tool === 'navigate') && event.actor?.call && !acted.has(event.actor.call)) {
      out.push({ ...event, action: call.tool === 'act' ? String(call.args?.kind ?? 'act') : 'navigate', status: 'failure', error: call.error, detail: { fromCall: true } });
    }
    out.push(event);
  }
  return out;
}

/** Agent id of an event: identified actor, Waymark itself for idle behaviour, unknown for pre-0.6 entries. */
export function agentOf(event: AuditEvent): string {
  if (event.actor) return event.actor.agent;
  if (isIdle(event.action) || event.action === 'browser.launch') return 'waymark';
  return 'unknown';
}

/**
 * Group events into agent sessions. Declared and MCP sessions keep their own id; named sessions (name_session) group by
 * label; everything else is split by idle gaps and marked inferred. Waymark's own events never form sessions.
 */
export function assignSessions(events: AuditEvent[], gapMinutes = DEFAULT_ASSUMPTIONS.sessionGapMinutes): Step[] {
  const lastSeen = new Map<string, { at: number; index: number }>();
  const steps: Step[] = [];
  for (const event of events) {
    const agent = agentOf(event);
    if (agent === 'waymark' || event.action === 'trace.screenshot') continue;
    const actor = event.actor;
    let sessionKey: string;
    if (actor?.session) sessionKey = `s:${actor.session}`;
    else if (event.session && event.session !== 'default') sessionKey = `n:${agent}:${event.session}`;
    else {
      const lane = `${agent}|${actor?.window ?? ''}|${event.run && !actor ? event.run : ''}`;
      const at = Date.parse(event.timestamp);
      const previous = lastSeen.get(lane);
      const index = previous && at - previous.at <= gapMinutes * 60000 ? previous.index : (previous?.index ?? 0) + 1;
      lastSeen.set(lane, { at, index });
      sessionKey = `i:${lane}:${index}`;
    }
    const tab = event.pageId !== undefined && event.run ? `${event.run}:${event.pageId}` : undefined;
    steps.push({ event, agent, sessionKey, tab, host: hostOf(placeOf(event)) });
  }
  return steps;
}

function categorizeError(error = ''): string {
  if (/Stale or unknown ref/i.test(error)) return 'stale_ref';
  if (/not visible|outside of the viewport|intercepts pointer/i.test(error)) return 'not_visible';
  if (/paused automation|paused for human/i.test(error)) return 'paused';
  if (/Timeout|timed out|exceeded/i.test(error)) return 'timeout';
  if (/net::ERR|ERR_|NS_ERROR|navigation/i.test(error)) return 'network';
  if (/Unknown or closed page|Target closed|has been closed/i.test(error)) return 'closed_page';
  if (/is required|takes a key|No option|cannot set files|Unsupported/i.test(error)) return 'bad_input';
  return 'other';
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
const round = (value: number, digits = 0) => { const f = 10 ** digits; return Math.round(value * f) / f; };
const dayOf = (timestamp: string) => { const d = new Date(timestamp); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

interface CallDetail { tool?: string; ok?: boolean; durationMs?: number; requestChars?: number; responseChars?: number; args?: Record<string, unknown> }
const callOf = (event: AuditEvent) => event.action === 'mcp.call' ? event.detail as CallDetail : undefined;

export interface Context {
  events: AuditEvent[];
  steps: Step[];
  sessions: Map<string, SessionSummary>;
  assumptions: EstimateAssumptions;
  tokens: (chars: number) => number;
}

export interface MetricDefinition {
  id: string;
  group: 'activity' | 'automation' | 'savings' | 'quality' | 'time';
  unit: 'count' | 'percent' | 'ms' | 'tokens' | 'chars' | 'seconds';
  estimate?: boolean;
  /** How the number is obtained, shown next to estimates. */
  formula?: string;
  compute: (ctx: Context) => number;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const countWhere = (ctx: Context, test: (event: AuditEvent) => boolean) => ctx.events.filter(test).length;
const inputTotal = (ctx: Context, key: 'pointerPaths' | 'clicks' | 'keystrokes' | 'pastes' | 'pacedMs') =>
  sum(ctx.events.filter(isAction).filter(e => e.status === 'success' || e.status === 'failure').map(e => Number((e.detail as { input?: Record<string, number> })?.input?.[key] ?? 0)));
const idleSteps = (ctx: Context, type?: string) => sum(ctx.events.filter(e => isIdle(e.action)).map(e => {
  const steps = ((e.detail as { steps?: string[] })?.steps ?? []);
  return type ? steps.filter(step => step === type).length : steps.length || 1;
}));
const ocrResolved = (ctx: Context) => ctx.events.filter(e => e.action === 'challenge.resolved_unverified' && /after OCR/i.test(String((e.detail as { reason?: string })?.reason ?? ''))).length;

export const METRICS: MetricDefinition[] = [
  { id: 'agents', group: 'activity', unit: 'count', compute: ctx => new Set([...ctx.sessions.values()].map(s => s.agent)).size },
  { id: 'sessions', group: 'activity', unit: 'count', compute: ctx => ctx.sessions.size },
  { id: 'tabs', group: 'activity', unit: 'count', compute: ctx => new Set(ctx.steps.map(s => s.tab).filter(Boolean)).size },
  { id: 'calls', group: 'activity', unit: 'count', compute: ctx => countWhere(ctx, e => e.action === 'mcp.call') },
  { id: 'actions', group: 'activity', unit: 'count', compute: ctx => countWhere(ctx, isAction) },
  { id: 'navigations', group: 'activity', unit: 'count', compute: ctx => countWhere(ctx, e => e.action === 'navigate' && e.status === 'success') },
  { id: 'snapshots', group: 'activity', unit: 'count', compute: ctx => countWhere(ctx, e => e.action === 'snapshot') },
  { id: 'reads', group: 'activity', unit: 'count', compute: ctx => countWhere(ctx, e => e.action === 'read') },
  { id: 'screenshots', group: 'activity', unit: 'count', compute: ctx => ctx.events.filter(e => e.screenshot).length },
  { id: 'successRate', group: 'quality', unit: 'percent', compute: ctx => { const done = ctx.events.filter(isAction); return done.length ? round(100 * done.filter(e => e.status === 'success').length / done.length, 1) : 0; } },
  { id: 'failures', group: 'quality', unit: 'count', compute: ctx => countWhere(ctx, e => isAction(e) && e.status === 'failure') },
  { id: 'challengesDetected', group: 'automation', unit: 'count', compute: ctx => countWhere(ctx, e => e.action === 'challenge.detected') },
  { id: 'ocrRuns', group: 'automation', unit: 'count', compute: ctx => countWhere(ctx, e => e.action === 'challenge.ocr_running') },
  { id: 'ocrSolved', group: 'automation', unit: 'count', compute: ocrResolved },
  { id: 'ocrSuccessRate', group: 'automation', unit: 'percent', compute: ctx => { const runs = countWhere(ctx, e => e.action === 'challenge.ocr_running'); return runs ? round(100 * ocrResolved(ctx) / runs, 1) : 0; } },
  { id: 'humanHandoffs', group: 'automation', unit: 'count', compute: ctx => countWhere(ctx, e => e.action === 'challenge.human_required') },
  { id: 'blockedByChallenge', group: 'automation', unit: 'count', compute: ctx => countWhere(ctx, e => e.action === 'challenge.automation_blocked') },
  { id: 'pointerPaths', group: 'automation', unit: 'count', compute: ctx => inputTotal(ctx, 'pointerPaths') },
  { id: 'pointerClicks', group: 'automation', unit: 'count', compute: ctx => inputTotal(ctx, 'clicks') },
  { id: 'humanKeystrokes', group: 'automation', unit: 'count', compute: ctx => inputTotal(ctx, 'keystrokes') },
  { id: 'isolatedPastes', group: 'automation', unit: 'count', compute: ctx => inputTotal(ctx, 'pastes') },
  { id: 'idleBehaviours', group: 'automation', unit: 'count', compute: ctx => countWhere(ctx, e => isIdle(e.action)) },
  { id: 'idleMoves', group: 'automation', unit: 'count', compute: ctx => idleSteps(ctx) },
  { id: 'idleScrolls', group: 'automation', unit: 'count', compute: ctx => idleSteps(ctx, 'scroll') },
  { id: 'idleVisits', group: 'automation', unit: 'count', compute: ctx => idleSteps(ctx, 'visit') },
  { id: 'pacingSeconds', group: 'time', unit: 'seconds', compute: ctx => round(inputTotal(ctx, 'pacedMs') / 1000, 1) },
  { id: 'browserSeconds', group: 'time', unit: 'seconds', compute: ctx => round(sum([...ctx.sessions.values()].map(s => s.browserMs)) / 1000, 1) },
  { id: 'thinkSeconds', group: 'time', unit: 'seconds', formula: 'gaps between consecutive calls of a session, each capped at thinkCapSeconds', compute: ctx => round(sum([...ctx.sessions.values()].map(s => s.thinkMs)) / 1000, 1) },
  { id: 'waitSeconds', group: 'time', unit: 'seconds', compute: ctx => round(sum(ctx.events.filter(e => e.action === 'mcp.call' && callOf(e)?.tool === 'wait').map(e => callOf(e)?.durationMs ?? 0)) / 1000, 1) },
  { id: 'tokensBrowserIo', group: 'savings', unit: 'tokens', estimate: true, formula: '(request + response characters of every tool call) / charsPerToken', compute: ctx => sum([...ctx.sessions.values()].map(s => s.tokensEstimated)) },
  { id: 'tokensReported', group: 'savings', unit: 'tokens', compute: ctx => sum(ctx.events.filter(e => e.action === 'usage.reported').map(e => { const d = e.detail as { inputTokens?: number; outputTokens?: number }; return (d?.inputTokens ?? 0) + (d?.outputTokens ?? 0); })) },
  { id: 'tokensSavedCaptcha', group: 'savings', unit: 'tokens', estimate: true, formula: 'ocrSolved × captchaTokensPerAttempt × captchaAttemptsWithoutOcr', compute: ctx => ocrResolved(ctx) * ctx.assumptions.captchaTokensPerAttempt * ctx.assumptions.captchaAttemptsWithoutOcr },
  { id: 'secondsSavedCaptcha', group: 'savings', unit: 'seconds', estimate: true, formula: 'ocrSolved × humanSecondsPerCaptcha', compute: ctx => ocrResolved(ctx) * ctx.assumptions.humanSecondsPerCaptcha },
  { id: 'tokensSavedDiffs', group: 'savings', unit: 'tokens', estimate: true, formula: 'per act: (last snapshot size on that tab − act response size) / charsPerToken', compute: ctx => ctx.tokens(diffSavings(ctx)) },
  { id: 'tokensSavedTruncation', group: 'savings', unit: 'tokens', formula: 'page text not sent because read stopped at its limit', compute: ctx => ctx.tokens(sum(ctx.events.filter(e => e.action === 'read').map(e => { const d = e.detail as { textLength?: number; sourceLength?: number }; return Math.max(0, (d?.sourceLength ?? 0) - (d?.textLength ?? 0)); }))) },
  { id: 'tokensSavedVsScreenshots', group: 'savings', unit: 'tokens', estimate: true, formula: 'per snapshot/read: max(0, screenshotTokens − response tokens)', compute: ctx => ctx.assumptions.screenshotTokens ? sum(ctx.events.filter(e => e.action === 'mcp.call' && ['snapshot', 'read'].includes(callOf(e)?.tool ?? '') && callOf(e)?.ok).map(e => Math.max(0, ctx.assumptions.screenshotTokens - ctx.tokens(callOf(e)?.responseChars ?? 0)))) : 0 },
  { id: 'tokensWastedRedundantSnapshots', group: 'quality', unit: 'tokens', estimate: true, formula: 'snapshots identical to the session\'s previous snapshot of that tab / charsPerToken', compute: ctx => ctx.tokens(sum(redundantSnapshots(ctx).map(r => r.chars))) }
];

export function registerMetric(definition: MetricDefinition): void {
  const index = METRICS.findIndex(metric => metric.id === definition.id);
  if (index >= 0) METRICS[index] = definition; else METRICS.push(definition);
}

function diffSavings(ctx: Context): number {
  const lastSnapshot = new Map<string, number>();
  const pending = new Map<string, string>();
  let saved = 0;
  for (const event of ctx.events) {
    const tab = event.run && event.pageId !== undefined ? `${event.run}:${event.pageId}` : undefined;
    if (event.action === 'snapshot' && tab) lastSnapshot.set(tab, Number((event.detail as { textLength?: number })?.textLength ?? 0));
    if (isAction(event) && event.action !== 'navigate' && event.status === 'success' && tab && event.actor?.call) pending.set(event.actor.call, tab);
    const call = callOf(event);
    if (call?.tool === 'act' && call.ok && event.actor?.call) {
      const actTab = pending.get(event.actor.call);
      const size = actTab ? lastSnapshot.get(actTab) ?? 0 : 0;
      saved += Math.max(0, size - (call.responseChars ?? 0));
    }
  }
  return saved;
}

export function redundantSnapshots(ctx: Context): Array<{ sessionKey: string; tab: string; url?: string; chars: number; eventId: string }> {
  const last = new Map<string, string>();
  const result: Array<{ sessionKey: string; tab: string; url?: string; chars: number; eventId: string }> = [];
  for (const step of ctx.steps) {
    const { event } = step;
    if (!step.tab) continue;
    const key = `${step.sessionKey}|${step.tab}`;
    if (event.action === 'snapshot') {
      const hash = (event.detail as { contentHash?: string })?.contentHash ?? event.basisSnapshotHash;
      if (hash && last.get(key) === hash) result.push({ sessionKey: step.sessionKey, tab: step.tab, url: event.after?.url, chars: Number((event.detail as { textLength?: number })?.textLength ?? 0), eventId: event.id });
      last.set(key, hash ?? '');
    } else if (isAction(event) || event.action === 'navigate') last.delete(key);
  }
  return result;
}

function summarizeSessions(steps: Step[], events: AuditEvent[], assumptions: EstimateAssumptions): Map<string, SessionSummary> {
  const sessions = new Map<string, SessionSummary & { lastCallAt?: number; sequence: string[] }>();
  const tokens = (chars: number) => Math.round(chars / assumptions.charsPerToken);
  for (const step of steps) {
    const { event } = step;
    let session = sessions.get(step.sessionKey);
    if (!session) {
      const actor = event.actor;
      const inferred = step.sessionKey.startsWith('i:');
      session = {
        key: step.sessionKey, agent: step.agent, agentLabel: agentLabel(step.agent),
        label: event.session && event.session !== 'default' ? event.session : actor?.session ?? (inferred ? `${agentLabel(step.agent)} · ${new Date(event.timestamp).toLocaleString()}` : step.sessionKey),
        inferred, identity: actor?.source ?? 'legacy', window: actor?.window, client: actor?.client ? `${actor.client.name}${actor.client.version ? ' ' + actor.client.version : ''}` : undefined,
        start: event.timestamp, end: event.timestamp, durationMs: 0, calls: 0, actions: 0, failures: 0, challenges: 0, tabs: [], hosts: [],
        tokensEstimated: 0, thinkMs: 0, browserMs: 0, signature: '', sequence: []
      };
      sessions.set(step.sessionKey, session);
    }
    if (event.session && event.session !== 'default') session.label = event.session;
    if (event.actor?.window && !session.window) session.window = event.actor.window;
    session.end = event.timestamp;
    if (step.tab && !session.tabs.includes(step.tab)) session.tabs.push(step.tab);
    if (step.host && !session.hosts.includes(step.host)) session.hosts.push(step.host);
    const call = callOf(event);
    if (call) {
      session.calls++;
      session.tokensEstimated += tokens((call.requestChars ?? 0) + (call.responseChars ?? 0));
      session.browserMs += call.durationMs ?? 0;
      const startedAt = Date.parse(event.timestamp) - (call.durationMs ?? 0);
      if (session.lastCallAt !== undefined) session.thinkMs += Math.max(0, Math.min(assumptions.thinkCapSeconds * 1000, startedAt - session.lastCallAt));
      session.lastCallAt = Date.parse(event.timestamp);
    }
    if (isAction(event)) {
      session.actions++;
      if (event.status === 'failure') session.failures++;
      const token = `${event.action}@${step.host ?? '-'}`;
      if (session.sequence.at(-1) !== token) session.sequence.push(token);
    }
    if (event.action === 'challenge.detected') session.challenges++;
    if (event.action === 'usage.reported') {
      const d = event.detail as { inputTokens?: number; outputTokens?: number };
      session.tokensReported = (session.tokensReported ?? 0) + (d?.inputTokens ?? 0) + (d?.outputTokens ?? 0);
    }
  }
  for (const session of sessions.values()) {
    session.durationMs = Date.parse(session.end) - Date.parse(session.start);
    session.signature = session.sequence.join(' > ');
    delete (session as { lastCallAt?: number }).lastCallAt;
    delete (session as { sequence?: string[] }).sequence;
  }
  void events;
  return sessions;
}

export interface Recommendation { id: string; severity: 'high' | 'medium' | 'info'; params: Record<string, string | number>; evidence?: { sessions?: string[]; hosts?: string[]; urls?: string[]; events?: string[] } }
type Rule = (ctx: Context, report: InsightReport) => Recommendation[];

export const RULES: Rule[] = [
  (_ctx, report) => report.agents.filter(a => a.actions >= 10 && a.successRate < 80).map(a => ({ id: 'agent_failure_rate', severity: 'high' as const, params: { agent: a.label, rate: a.successRate, failures: a.failures } })),
  (_ctx, report) => report.sites.filter(s => s.actions >= 8 && s.failures / s.actions > 0.2).slice(0, 3).map(s => ({ id: 'site_failure_rate', severity: 'high' as const, params: { host: s.host, failures: s.failures, actions: s.actions }, evidence: { hosts: [s.host] } })),
  (_ctx, report) => { const stale = report.failures.byCategory.find(c => c.category === 'stale_ref')?.count ?? 0; return stale >= 3 ? [{ id: 'stale_refs', severity: 'medium' as const, params: { count: stale } }] : []; },
  (ctx, report) => { const redundant = redundantSnapshots(ctx); return redundant.length >= 3 ? [{ id: 'redundant_snapshots', severity: 'medium' as const, params: { count: redundant.length, tokens: report.metric('tokensWastedRedundantSnapshots') }, evidence: { sessions: [...new Set(redundant.map(r => r.sessionKey))].slice(0, 10), events: redundant.slice(0, 20).map(r => r.eventId) } }] : []; },
  (_ctx, report) => report.repetition.urls.slice(0, 3).map(u => ({ id: 'repeated_url', severity: 'info' as const, params: { url: u.url, count: u.count, sessions: u.sessions }, evidence: { urls: [u.url] } })),
  (_ctx, report) => report.repetition.sequences.slice(0, 3).map(s => ({ id: 'repeated_sequence', severity: 'medium' as const, params: { steps: s.steps.split(' > ').length, count: s.count, sequence: s.steps.length > 160 ? s.steps.slice(0, 157) + '…' : s.steps }, evidence: { sessions: s.sessionKeys.slice(0, 10) } })),
  (ctx, report) => report.sites.filter(s => s.navigations >= 3 && s.p90NavigateMs > ctx.assumptions.slowNavigateMs).slice(0, 3).map(s => ({ id: 'slow_site', severity: 'info' as const, params: { host: s.host, p90: Math.round(s.p90NavigateMs / 100) / 10 }, evidence: { hosts: [s.host] } })),
  (_ctx, report) => report.sites.filter(s => s.humanHandoffs >= 2).slice(0, 3).map(s => ({ id: 'challenge_hotspot', severity: 'medium' as const, params: { host: s.host, count: s.humanHandoffs }, evidence: { hosts: [s.host] } })),
  (ctx) => { const big = ctx.events.filter(e => e.action === 'read' && Number((e.detail as { textLength?: number })?.textLength ?? 0) > 20000); return big.length >= 3 ? [{ id: 'large_reads', severity: 'info' as const, params: { count: big.length, tokens: ctx.tokens(sum(big.map(e => Number((e.detail as { textLength?: number }).textLength)))) }, evidence: { events: big.slice(0, 20).map(e => e.id) } }] : []; },
  (_ctx, report) => { const long = report.sessions.filter(s => s.actions >= 40).sort((a, b) => b.actions - a.actions); return long.length ? [{ id: 'long_sessions', severity: 'info' as const, params: { count: long.length, max: long[0].actions }, evidence: { sessions: long.slice(0, 10).map(s => s.key) } }] : []; },
  (_ctx, report) => { const think = report.metric('thinkSeconds'); const browser = report.metric('browserSeconds'); return think > 120 && think > browser * 3 ? [{ id: 'think_bound', severity: 'info' as const, params: { think: Math.round(think / 60), browser: Math.round(browser / 60) } }] : []; },
  (_ctx, report) => { const unknown = report.agents.find(a => a.agent === 'unknown'); return unknown && unknown.calls + unknown.actions > 0 ? [{ id: 'unknown_agent', severity: 'medium' as const, params: { count: unknown.calls || unknown.actions } }] : []; },
  (_ctx, report) => report.metric('ocrSolved') > 0 ? [{ id: 'captcha_saved', severity: 'info' as const, params: { count: report.metric('ocrSolved'), tokens: report.metric('tokensSavedCaptcha'), seconds: report.metric('secondsSavedCaptcha') } }] : []
];

export interface InsightReport {
  generatedAt: string;
  range: { from: string; to: string; days: number };
  filter: { agent?: string; session?: string };
  assumptions: EstimateAssumptions;
  metrics: Array<{ id: string; group: string; unit: string; value: number; estimate: boolean; formula?: string }>;
  metric: (id: string) => number;
  agents: Array<{ agent: string; label: string; sessions: number; calls: number; actions: number; failures: number; successRate: number; avgStepsPerSession: number; avgSessionMinutes: number; tokensEstimated: number; tokensPerSession: number; challenges: number; identity: Record<string, number>; lastSeen: string }>;
  sessions: SessionSummary[];
  daily: Array<{ day: string; calls: number; actions: number; failures: number; challenges: number; ocr: number; tokens: number; agents: Record<string, number> }>;
  heatmap: number[][];
  sites: Array<{ host: string; navigations: number; actions: number; failures: number; challenges: number; humanHandoffs: number; p50NavigateMs: number; p90NavigateMs: number; agents: string[] }>;
  slowPages: Array<{ url: string; durationMs: number; at: string; agent: string; eventId: string }>;
  failures: { byCategory: Array<{ category: string; count: number; example?: string }>; byAction: Array<{ action: string; count: number }>; recent: Array<{ at: string; agent: string; action: string; error: string; url?: string; eventId: string; sessionKey: string }> };
  tools: Array<{ tool: string; calls: number; failures: number; avgMs: number; tokens: number }>;
  repetition: { urls: Array<{ url: string; count: number; sessions: number; agents: string[] }>; sequences: Array<{ steps: string; count: number; sessionKeys: string[] }>; redundantSnapshots: number };
  automation: { ocr: { runs: number; solved: number; handedToAi: number; handedToHuman: number }; idleSteps: Record<string, number> };
  recommendations: Recommendation[];
}

/** Compute the full report. Pure: give it ledger events (oldest first) and options. */
export function computeInsights(allEvents: AuditEvent[], options: InsightOptions = {}): InsightReport {
  const assumptions = { ...DEFAULT_ASSUMPTIONS, ...options.assumptions };
  const now = options.now ?? Date.now();
  const days = options.days && options.days > 0 ? options.days : 30;
  const from = new Date(now - days * 86400000).toISOString();
  let events = withFailedCalls(allEvents.filter(e => e.timestamp >= from && e.action !== 'trace.screenshot'));
  let steps = assignSessions(events, assumptions.sessionGapMinutes);
  if (options.agent) {
    steps = steps.filter(step => step.agent === options.agent);
    const keep = new Set(steps.map(s => s.event.id));
    // Idle behaviour on the agent's tabs belongs to its picture too.
    const tabs = new Set(steps.map(s => s.tab).filter(Boolean));
    events = events.filter(e => keep.has(e.id) || (isIdle(e.action) && tabs.has(`${e.run}:${e.pageId}`)));
  }
  if (options.session) {
    steps = steps.filter(step => step.sessionKey === options.session);
    const keep = new Set(steps.map(s => s.event.id));
    events = events.filter(e => keep.has(e.id));
  }
  const sessions = summarizeSessions(steps, events, assumptions);
  const tokens = (chars: number) => Math.round(chars / assumptions.charsPerToken);
  const ctx: Context = { events, steps, sessions, assumptions, tokens };
  const metrics = METRICS.map(m => ({ id: m.id, group: m.group, unit: m.unit, estimate: Boolean(m.estimate), formula: m.formula, value: safe(() => m.compute(ctx)) }));
  const metric = (id: string) => metrics.find(m => m.id === id)?.value ?? 0;
  const sessionList = [...sessions.values()].sort((a, b) => b.end.localeCompare(a.end));

  const agentMap = new Map<string, InsightReport['agents'][number]>();
  for (const session of sessionList) {
    const entry = agentMap.get(session.agent) ?? { agent: session.agent, label: agentLabel(session.agent), sessions: 0, calls: 0, actions: 0, failures: 0, successRate: 0, avgStepsPerSession: 0, avgSessionMinutes: 0, tokensEstimated: 0, tokensPerSession: 0, challenges: 0, identity: {}, lastSeen: session.end };
    entry.sessions++; entry.calls += session.calls; entry.actions += session.actions; entry.failures += session.failures;
    entry.tokensEstimated += session.tokensEstimated; entry.challenges += session.challenges;
    entry.identity[session.identity] = (entry.identity[session.identity] ?? 0) + 1;
    entry.avgSessionMinutes += session.durationMs / 60000;
    if (session.end > entry.lastSeen) entry.lastSeen = session.end;
    agentMap.set(session.agent, entry);
  }
  for (const entry of agentMap.values()) {
    entry.successRate = entry.actions ? round(100 * (entry.actions - entry.failures) / entry.actions, 1) : 0;
    entry.avgStepsPerSession = round(entry.actions / entry.sessions, 1);
    entry.avgSessionMinutes = round(entry.avgSessionMinutes / entry.sessions, 1);
    entry.tokensPerSession = Math.round(entry.tokensEstimated / entry.sessions);
  }

  const daily = new Map<string, InsightReport['daily'][number]>();
  for (let t = Date.parse(from); t <= now; t += 86400000) { const day = dayOf(new Date(t).toISOString()); daily.set(day, { day, calls: 0, actions: 0, failures: 0, challenges: 0, ocr: 0, tokens: 0, agents: {} }); }
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  const stepById = new Map(steps.map(s => [s.event.id, s]));
  for (const event of events) {
    const day = daily.get(dayOf(event.timestamp));
    const call = callOf(event);
    if (day) {
      if (call) { day.calls++; day.tokens += tokens((call.requestChars ?? 0) + (call.responseChars ?? 0)); const agent = agentOf(event); day.agents[agent] = (day.agents[agent] ?? 0) + 1; }
      if (isAction(event)) { day.actions++; if (event.status === 'failure') day.failures++; }
      if (event.action === 'challenge.detected') day.challenges++;
      if (event.action === 'challenge.ocr_running') day.ocr++;
    }
    if (call || isAction(event) && !stepById.get(event.id)?.event.actor?.call) { const d = new Date(event.timestamp); heatmap[d.getDay()][d.getHours()]++; }
  }

  const siteMap = new Map<string, InsightReport['sites'][number] & { durations: number[]; agentSet: Set<string> }>();
  const site = (host: string) => { let s = siteMap.get(host); if (!s) { s = { host, navigations: 0, actions: 0, failures: 0, challenges: 0, humanHandoffs: 0, p50NavigateMs: 0, p90NavigateMs: 0, agents: [], durations: [], agentSet: new Set() }; siteMap.set(host, s); } return s; };
  for (const step of steps) {
    if (!step.host) continue;
    const s = site(step.host);
    const { event } = step;
    if (isAction(event)) { s.actions++; if (event.status === 'failure') s.failures++; s.agentSet.add(step.agent); }
    if (event.action === 'navigate' && event.status === 'success') { s.navigations++; if (event.durationMs) s.durations.push(event.durationMs); }
    if (event.action === 'challenge.detected') s.challenges++;
    if (event.action === 'challenge.human_required') s.humanHandoffs++;
  }
  const sites = [...siteMap.values()].map(({ durations, agentSet, ...s }) => ({ ...s, p50NavigateMs: percentile(durations, 0.5), p90NavigateMs: percentile(durations, 0.9), agents: [...agentSet] })).sort((a, b) => b.actions - a.actions);
  const slowPages = steps.filter(s => s.event.action === 'navigate' && s.event.status === 'success' && (s.event.durationMs ?? 0) > 0)
    .sort((a, b) => (b.event.durationMs ?? 0) - (a.event.durationMs ?? 0)).slice(0, 10)
    .map(s => ({ url: s.event.after?.url ?? '', durationMs: s.event.durationMs ?? 0, at: s.event.timestamp, agent: s.agent, eventId: s.event.id }));

  const categories = new Map<string, { count: number; example?: string }>();
  const byAction = new Map<string, number>();
  const failed = steps.filter(s => isAction(s.event) && s.event.status === 'failure');
  for (const { event } of failed) {
    const category = categorizeError(event.error);
    const entry = categories.get(category) ?? { count: 0, example: event.error?.split('\n')[0].slice(0, 160) };
    entry.count++; categories.set(category, entry);
    byAction.set(event.action, (byAction.get(event.action) ?? 0) + 1);
  }

  const toolMap = new Map<string, { tool: string; calls: number; failures: number; totalMs: number; tokens: number }>();
  for (const event of events) {
    const call = callOf(event);
    if (!call?.tool) continue;
    const entry = toolMap.get(call.tool) ?? { tool: call.tool, calls: 0, failures: 0, totalMs: 0, tokens: 0 };
    entry.calls++; if (!call.ok) entry.failures++; entry.totalMs += call.durationMs ?? 0; entry.tokens += tokens((call.requestChars ?? 0) + (call.responseChars ?? 0));
    toolMap.set(call.tool, entry);
  }

  const urlMap = new Map<string, { count: number; sessions: Set<string>; agents: Set<string> }>();
  for (const step of steps) {
    if (step.event.action !== 'navigate' || step.event.status !== 'success' || (step.event.target as { action?: string })?.action !== 'url') continue;
    const url = pathOf(step.event.after?.url);
    if (!url) continue;
    const entry = urlMap.get(url) ?? { count: 0, sessions: new Set(), agents: new Set() };
    entry.count++; entry.sessions.add(step.sessionKey); entry.agents.add(step.agent);
    urlMap.set(url, entry);
  }
  const sequenceMap = new Map<string, string[]>();
  for (const session of sessionList) {
    if (session.signature.split(' > ').length < 3) continue;
    sequenceMap.set(session.signature, [...(sequenceMap.get(session.signature) ?? []), session.key]);
  }
  // Also count recurring 4-step runs inside and across sessions: candidates for a script or a skill.
  const grams = new Map<string, Set<string>>();
  const gramCount = new Map<string, number>();
  for (const session of sessionList) {
    const parts = session.signature ? session.signature.split(' > ') : [];
    for (let i = 0; i + 4 <= parts.length; i++) {
      const gram = parts.slice(i, i + 4).join(' > ');
      grams.set(gram, (grams.get(gram) ?? new Set()).add(session.key));
      gramCount.set(gram, (gramCount.get(gram) ?? 0) + 1);
    }
  }
  const sequences = [
    ...[...sequenceMap.entries()].filter(([, keys]) => keys.length >= 2).map(([steps, keys]) => ({ steps, count: keys.length, sessionKeys: keys })),
    ...[...gramCount.entries()].filter(([gram, count]) => count >= assumptions.repeatThreshold && !sequenceMap.has(gram)).map(([steps, count]) => ({ steps, count, sessionKeys: [...grams.get(steps)!] }))
  ].sort((a, b) => b.count * b.steps.length - a.count * a.steps.length).slice(0, 10);

  const idleSteps: Record<string, number> = {};
  for (const event of events) if (isIdle(event.action)) for (const step of (event.detail as { steps?: string[] })?.steps ?? []) idleSteps[step] = (idleSteps[step] ?? 0) + 1;

  const report: InsightReport = {
    generatedAt: new Date(now).toISOString(), range: { from, to: new Date(now).toISOString(), days }, filter: { agent: options.agent, session: options.session },
    assumptions, metrics, metric,
    agents: [...agentMap.values()].sort((a, b) => b.calls + b.actions - a.calls - a.actions),
    sessions: sessionList, daily: [...daily.values()], heatmap, sites, slowPages,
    failures: {
      byCategory: [...categories.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.count - a.count),
      byAction: [...byAction.entries()].map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count),
      recent: failed.slice(-15).reverse().map(s => ({ at: s.event.timestamp, agent: s.agent, action: s.event.action, error: (s.event.error ?? '').split('\n')[0].slice(0, 200), url: s.event.before?.url, eventId: s.event.id, sessionKey: s.sessionKey }))
    },
    tools: [...toolMap.values()].map(t => ({ tool: t.tool, calls: t.calls, failures: t.failures, avgMs: Math.round(t.totalMs / t.calls), tokens: t.tokens })).sort((a, b) => b.calls - a.calls),
    repetition: {
      urls: [...urlMap.entries()].filter(([, v]) => v.count >= assumptions.repeatThreshold).map(([url, v]) => ({ url, count: v.count, sessions: v.sessions.size, agents: [...v.agents] })).sort((a, b) => b.count - a.count).slice(0, 15),
      sequences, redundantSnapshots: redundantSnapshots(ctx).length
    },
    automation: {
      ocr: { runs: metric('ocrRuns'), solved: metric('ocrSolved'), handedToAi: events.filter(e => e.action === 'challenge.ai_recovery_required').length, handedToHuman: metric('humanHandoffs') },
      idleSteps
    },
    recommendations: []
  };
  for (const rule of RULES) { try { report.recommendations.push(...rule(ctx, report)); } catch { /* one broken rule never hides the rest */ } }
  const order = { high: 0, medium: 1, info: 2 };
  report.recommendations.sort((a, b) => order[a.severity] - order[b.severity]);
  return report;
}

function safe(fn: () => number): number { try { const value = fn(); return Number.isFinite(value) ? value : 0; } catch { return 0; } }

/** JSON form (drops the helper function). */
export function serializeReport(report: InsightReport): Omit<InsightReport, 'metric'> {
  const { metric: _metric, ...rest } = report;
  return rest;
}
