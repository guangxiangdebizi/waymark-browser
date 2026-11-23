import type { AuditEvent } from '../audit/AuditLog.js';
import { agentLabel } from '../audit/Actor.js';
import { assignSessions, computeInsights, isIdle, withFailedCalls, type SessionSummary, DEFAULT_ASSUMPTIONS, type EstimateAssumptions } from './Insights.js';

/** Agent → session → tab → step: the hierarchy the management window browses. */
export interface ProvenanceTree {
  agents: Array<{ agent: string; label: string; sessions: SessionSummary[]; calls: number; actions: number; failures: number; lastSeen: string; identity: Record<string, number> }>;
}

export function buildProvenance(events: AuditEvent[], options: { days?: number; agent?: string; q?: string; now?: number; assumptions?: Partial<EstimateAssumptions> } = {}): ProvenanceTree {
  const report = computeInsights(events, { days: options.days ?? 30, agent: options.agent, now: options.now, assumptions: options.assumptions });
  const q = options.q?.toLowerCase().trim();
  let sessions = report.sessions;
  if (q) {
    const steps = assignSessions(events, report.assumptions.sessionGapMinutes);
    const matching = new Set(steps.filter(s => JSON.stringify([s.event.action, s.event.before?.url, s.event.after?.url, s.event.before?.title, s.event.after?.title, s.event.error, s.event.session, s.event.id, s.event.actor?.window]).toLowerCase().includes(q)).map(s => s.sessionKey));
    sessions = sessions.filter(s => matching.has(s.key) || s.label.toLowerCase().includes(q) || s.agent.includes(q));
  }
  const agents = new Map<string, ProvenanceTree['agents'][number]>();
  for (const session of sessions) {
    const entry = agents.get(session.agent) ?? { agent: session.agent, label: agentLabel(session.agent), sessions: [], calls: 0, actions: 0, failures: 0, lastSeen: session.end, identity: {} };
    entry.sessions.push(session);
    entry.calls += session.calls; entry.actions += session.actions; entry.failures += session.failures;
    entry.identity[session.identity] = (entry.identity[session.identity] ?? 0) + 1;
    if (session.end > entry.lastSeen) entry.lastSeen = session.end;
    agents.set(session.agent, entry);
  }
  return { agents: [...agents.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)) };
}

export interface SessionDetail {
  session: SessionSummary;
  tabs: Array<{ tab: string; pageId: number; openedBy?: string; openedHere: boolean; firstUrl?: string; lastUrl?: string; lastTitle?: string; steps: number; screenshots: number }>;
  timeline: Array<AuditEvent & { tool?: string; responseChars?: number }>;
}

/** One session's tabs and step-by-step timeline (oldest first). Idle behaviour on its tabs is included on request. */
export function sessionDetail(rawEvents: AuditEvent[], key: string, options: { idle?: boolean; gapMinutes?: number } = {}): SessionDetail | undefined {
  const events = withFailedCalls(rawEvents);
  const steps = assignSessions(events, options.gapMinutes ?? DEFAULT_ASSUMPTIONS.sessionGapMinutes);
  const mine = steps.filter(step => step.sessionKey === key);
  if (!mine.length) return undefined;
  // The subset holds exactly this session's events, so it summarizes to one session (inferred keys are renumbered).
  const report = computeInsights(mine.map(s => s.event).filter(e => !(e.detail as { fromCall?: boolean })?.fromCall), { days: 36500, assumptions: { sessionGapMinutes: options.gapMinutes ?? DEFAULT_ASSUMPTIONS.sessionGapMinutes } });
  const session = report.sessions.find(s => s.key === key) ?? report.sessions[0];
  if (!session) return undefined;
  session.key = key;
  const tabKeys = new Set(mine.map(s => s.tab).filter((tab): tab is string => Boolean(tab)));
  const calls = new Map<string, { tool?: string; responseChars?: number }>();
  for (const step of mine) if (step.event.action === 'mcp.call' && step.event.actor?.call) calls.set(step.event.actor.call, step.event.detail as { tool?: string; responseChars?: number });
  const ids = new Set(mine.map(s => s.event.id));
  const timeline = events.filter(event => (ids.has(event.id) && event.action !== 'mcp.call' && event.action !== 'tabs.list' && event.action !== 'trace.screenshot')
    || (options.idle && isIdle(event.action) && tabKeys.has(`${event.run}:${event.pageId}`) && event.timestamp >= session.start && event.timestamp <= session.end))
    .map(event => { const call = event.actor?.call ? calls.get(event.actor.call) : undefined; return call ? { ...event, tool: call.tool, responseChars: call.responseChars } : event; });
  const tabs: SessionDetail['tabs'] = [];
  for (const tab of tabKeys) {
    const [run, page] = tab.split(':');
    const onTab = events.filter(event => event.run === run && String(event.pageId) === page && event.action !== 'trace.screenshot');
    const opened = onTab.find(event => event.action === 'tabs.new');
    const places = onTab.filter(event => ids.has(event.id)).map(event => event.after ?? event.before).filter(Boolean) as Array<{ url: string; title: string }>;
    tabs.push({
      tab, pageId: Number(page), openedBy: opened ? opened.actor ? agentLabel(opened.actor.agent) : undefined : undefined,
      openedHere: Boolean(opened && ids.has(opened.id)), firstUrl: places[0]?.url, lastUrl: places.at(-1)?.url, lastTitle: places.at(-1)?.title,
      steps: onTab.filter(event => ids.has(event.id) && event.action !== 'mcp.call').length,
      screenshots: onTab.filter(event => ids.has(event.id) && event.screenshot).length
    });
  }
  return { session, tabs, timeline };
}
