import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

/**
 * Who is driving the browser. Every ledger entry written while an agent call runs carries the actor, so the ledger can
 * be read per agent, per agent session and per tab instead of as one anonymous stream.
 *
 * Identity is only as strong as its source, and the source is always recorded:
 *  - `declared`    the client said who it is (X-Waymark-Agent header, ?agent= on the MCP URL, `name_session` agent,
 *                  or the CLI's --agent / WAYMARK_AGENT)
 *  - `mcp-client`  the clientInfo the MCP client sent in `initialize` (Claude Code, Codex and others send their name)
 *  - `env`         the Waymark CLI found an agent's own marker in its environment (AI_AGENT, CLAUDECODE, CODEX_*, ...)
 *  - `user-agent`  the HTTP User-Agent names a known agent
 *  - `tty`         the Waymark CLI ran in an interactive terminal with no agent marker: a person
 *  - `local-ui`    a click in Waymark's own window or cockpit pages: a person
 *  - `system`      Waymark itself (idle behaviour, startup)
 *  - `unknown`     nothing identified the caller; it is never guessed
 */
export type IdentitySource = 'declared' | 'mcp-client' | 'env' | 'user-agent' | 'tty' | 'local-ui' | 'system' | 'unknown';
export type Transport = 'mcp-http' | 'mcp-session' | 'cli' | 'cockpit' | 'internal';

export interface Actor {
  /** Normalized agent id: claude-code, codex, workbuddy, human, waymark, unknown, or the declared name as a slug. */
  agent: string;
  source: IdentitySource;
  /** Agent session: one terminal window / conversation of that agent. Inferred sessions are built later from time gaps. */
  session?: string;
  sessionSource?: 'declared' | 'mcp-session' | 'env' | 'fingerprint';
  /** Free label of the agent's own window or worker, e.g. "codex #2" or a tmux pane. */
  window?: string;
  client?: { name: string; version?: string };
  transport: Transport;
  /** One MCP tool call; every event the call writes shares it. */
  call?: string;
  tool?: string;
}

export interface KnownAgent { id: string; label: string; pattern: RegExp }

/** Order matters: the first pattern that matches wins. Extend here to recognise more agents. */
export const KNOWN_AGENTS: KnownAgent[] = [
  { id: 'claude-desktop', label: 'Claude Desktop', pattern: /claude[\s_-]*desktop|^claude-ai$/i },
  { id: 'claude-code', label: 'Claude Code', pattern: /claude/i },
  { id: 'codex', label: 'Codex', pattern: /codex/i },
  { id: 'workbuddy', label: 'WorkBuddy', pattern: /work[\s_-]*buddy/i },
  { id: 'codebuddy', label: 'CodeBuddy', pattern: /code[\s_-]*buddy/i },
  { id: 'cursor', label: 'Cursor', pattern: /cursor/i },
  { id: 'gemini-cli', label: 'Gemini CLI', pattern: /gemini/i },
  { id: 'windsurf', label: 'Windsurf', pattern: /windsurf|codeium/i },
  { id: 'cline', label: 'Cline', pattern: /\bcline\b|roo[\s_-]*code/i },
  { id: 'opencode', label: 'opencode', pattern: /opencode/i },
  { id: 'goose', label: 'Goose', pattern: /\bgoose\b/i },
  { id: 'qwen-code', label: 'Qwen Code', pattern: /qwen/i },
  { id: 'trae', label: 'Trae', pattern: /\btrae\b/i },
  { id: 'human', label: 'Human', pattern: /^(human|user|person|me|manual)$/i },
  { id: 'waymark-cli', label: 'Waymark CLI', pattern: /^waymark[\s_-]*cli$/i }
];

export function agentLabel(id: string): string {
  return KNOWN_AGENTS.find(agent => agent.id === id)?.label ?? (id === 'unknown' ? 'Unknown' : id === 'waymark' ? 'Waymark' : id);
}

/** Map a declared or reported name to a known agent id; an unrecognised name is kept (as a slug), never replaced. */
export function normalizeAgent(name: string | undefined | null): string | undefined {
  const value = String(name ?? '').trim();
  if (!value) return undefined;
  const known = KNOWN_AGENTS.find(agent => agent.pattern.test(value));
  if (known) return known.id;
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || undefined;
}

/** Only names a known agent: generic HTTP clients (node, python-urllib, curl) identify nothing. */
export function agentFromUserAgent(userAgent: string | undefined): string | undefined {
  if (!userAgent) return undefined;
  const known = KNOWN_AGENTS.find(agent => agent.id !== 'human' && agent.id !== 'waymark-cli' && agent.pattern.test(userAgent));
  return known?.id;
}

const clean = (value: unknown, max = 80): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return text || undefined;
};

export interface IdentityInput {
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  /** clientInfo the MCP session's initialize carried. */
  clientInfo?: { name?: string; version?: string };
  mcpSession?: string;
  remote?: string;
  /** Session-level declarations made with name_session (keyed by session key). */
  declared?: { agent?: string; window?: string };
}

const header = (headers: IdentityInput['headers'], name: string): string | undefined => {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  let text = Array.isArray(value) ? value[0] : value;
  // The CLI percent-encodes non-ASCII labels (HTTP headers are Latin-1).
  if (text && /%[0-9A-Fa-f]{2}/.test(text)) { try { text = decodeURIComponent(text); } catch { /* keep as sent */ } }
  return clean(text, 200);
};

/** Resolve who made an HTTP request to Waymark. Precedence: declaration, MCP clientInfo, User-Agent, unknown. */
export function identify(input: IdentityInput): Actor {
  const headers = input.headers ?? {};
  const query = input.query ?? {};
  const declaredAgent = header(headers, 'x-waymark-agent') ?? clean(query.agent) ?? input.declared?.agent;
  const declaredSource = header(headers, 'x-waymark-agent-source');
  const declaredSession = header(headers, 'x-waymark-session') ?? clean(query.session);
  const window = header(headers, 'x-waymark-window') ?? clean(query.window) ?? input.declared?.window;
  const viaCli = header(headers, 'x-waymark-client') === 'cli';
  const client = input.clientInfo?.name ? { name: clean(input.clientInfo.name)!, version: clean(input.clientInfo.version, 40) } : undefined;
  let agent: string | undefined;
  let source: IdentitySource = 'unknown';
  if (declaredAgent) {
    agent = normalizeAgent(declaredAgent);
    // The CLI says how it knew (env marker or a terminal); anything else that names itself is a declaration.
    source = declaredSource === 'env' || declaredSource === 'tty' ? declaredSource : 'declared';
  }
  if (!agent && client) { agent = normalizeAgent(client.name); source = 'mcp-client'; }
  if (!agent) { agent = agentFromUserAgent(header(headers, 'user-agent')); if (agent) source = 'user-agent'; }
  if (!agent) { agent = 'unknown'; source = 'unknown'; }
  let session: string | undefined;
  let sessionSource: Actor['sessionSource'];
  if (declaredSession) { session = declaredSession; sessionSource = header(headers, 'x-waymark-session-source') === 'env' ? 'env' : 'declared'; }
  else if (input.mcpSession) { session = `mcp-${input.mcpSession.slice(0, 12)}`; sessionSource = 'mcp-session'; }
  return {
    agent, source, session, sessionSource, window, client,
    transport: viaCli ? 'cli' : input.mcpSession ? 'mcp-session' : 'mcp-http'
  };
}

export function fingerprint(parts: Array<string | undefined>): string {
  return createHash('sha256').update(parts.map(part => part ?? '').join('|')).digest('hex').slice(0, 10);
}

export const SYSTEM_ACTOR: Actor = { agent: 'waymark', source: 'system', transport: 'internal' };
export const LOCAL_UI_ACTOR: Actor = { agent: 'human', source: 'local-ui', transport: 'cockpit' };

const store = new AsyncLocalStorage<Actor>();

export function currentActor(): Actor | undefined { return store.getStore(); }

/** Run work as an actor; every ledger write inside it (including async continuations) is attributed to that actor. */
export function runAs<T>(actor: Actor, work: () => T): T { return store.run(actor, work); }

/** A fresh call id inside the current actor, for one MCP tool call. */
export function withCall(actor: Actor, tool: string): Actor { return { ...actor, call: randomUUID().slice(0, 8), tool }; }

interface RequestLike { headers?: Record<string, string | string[] | undefined>; url?: URL | string; sessionId?: string; remote?: string }

/**
 * Remembers what each MCP session said about itself (clientInfo at initialize, name_session declarations) so every
 * later request of that session resolves to the same actor. Stateless callers that declare nothing are keyed by their
 * User-Agent, which is only good enough to carry a name_session declaration forward, never to invent an identity.
 */
export class IdentityRegistry {
  private sessions = new Map<string, { clientInfo?: { name?: string; version?: string }; lastSeen: number }>();
  private declarations = new Map<string, { agent?: string; window?: string }>();
  private static readonly SESSION_TTL_MS = 6 * 3600 * 1000;

  noteSession(sessionId: string, clientInfo?: { name?: string; version?: string }): void {
    this.sessions.set(sessionId, { clientInfo: clientInfo ?? this.sessions.get(sessionId)?.clientInfo, lastSeen: Date.now() });
    if (this.sessions.size > 500) this.expire();
  }
  forgetSession(sessionId: string): void { this.sessions.delete(sessionId); this.declarations.delete(`mcp:${sessionId}`); }
  knows(sessionId: string): boolean { return this.sessions.has(sessionId); }
  expire(now = Date.now()): string[] {
    const gone: string[] = [];
    for (const [id, entry] of this.sessions) if (now - entry.lastSeen > IdentityRegistry.SESSION_TTL_MS) { this.sessions.delete(id); this.declarations.delete(`mcp:${id}`); gone.push(id); }
    // Declarations of callers without an MCP session are tiny, but never let them grow without bound.
    if (this.declarations.size > 2000) for (const key of [...this.declarations.keys()].slice(0, this.declarations.size - 1000)) this.declarations.delete(key);
    return gone;
  }

  private declarationKey(request: RequestLike): string {
    const headers = request.headers ?? {};
    const explicit = headers['x-waymark-session'];
    if (request.sessionId) return `mcp:${request.sessionId}`;
    if (explicit) return `session:${Array.isArray(explicit) ? explicit[0] : explicit}`;
    const ua = headers['user-agent'];
    return `ua:${fingerprint([Array.isArray(ua) ? ua[0] : ua, request.remote])}`;
  }

  /** name_session can declare the agent and its window; later calls of the same caller inherit it. */
  declare(request: RequestLike, declaration: { agent?: string; window?: string }): void {
    const key = this.declarationKey(request);
    const current = this.declarations.get(key) ?? {};
    this.declarations.set(key, { agent: declaration.agent ?? current.agent, window: declaration.window ?? current.window });
  }

  resolve(request: RequestLike): Actor {
    const url = typeof request.url === 'string' ? new URL(request.url, 'http://local') : request.url;
    const query: Record<string, unknown> = {};
    url?.searchParams.forEach((value, key) => { query[key] = value; });
    const session = request.sessionId ? this.sessions.get(request.sessionId) : undefined;
    if (session) session.lastSeen = Date.now();
    return identify({ headers: request.headers, query, clientInfo: session?.clientInfo, mcpSession: request.sessionId, declared: this.declarations.get(this.declarationKey(request)) });
  }
}
