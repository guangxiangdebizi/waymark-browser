import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync, unlinkSync, renameSync, createReadStream, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fromRoot } from '../config.js';
import type { SnapshotResult } from '../types.js';
import { currentActor, type Actor } from './Actor.js';

export interface AuditEvent {
  id: string;
  sequence: number;
  timestamp: string;
  session: string;
  /** Who drove this step (see Actor.ts); absent on ledgers written before 0.6. */
  actor?: Actor;
  /** One app launch; page ids restart at 1 on every launch, so a tab is (run, pageId). */
  run?: string;
  pageId?: number;
  action: string;
  target?: unknown;
  basisSnapshotId?: string;
  basisSnapshotHash?: string;
  before?: { url: string; title: string };
  after?: { url: string; title: string };
  durationMs?: number;
  status: 'started' | 'success' | 'failure' | 'info' | 'warning';
  error?: string;
  detail?: unknown;
  capabilities?: Array<{ id: string; version: string }>;
  /** File name under the ledger's screens/ directory: the page right after this step. */
  screenshot?: string;
}

/** Query parameters that commonly carry credentials; their values never reach the ledger. */
const SECRET_PARAM = /pass|pwd|token|secret|api[-_]?key|apikey|access[-_]?key|auth|sig(nature)?$|session|sid$|ticket|otp|code$|credential/i;

export function redactUrl(url: string): string {
  if (!url || !/[?#]/.test(url)) return url;
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (SECRET_PARAM.test(key)) { parsed.searchParams.set(key, '***'); changed = true; }
    }
    // Fragments of OAuth-style redirects carry tokens too (#access_token=...).
    if (parsed.hash && /=/.test(parsed.hash)) {
      const params = new URLSearchParams(parsed.hash.slice(1));
      let hashChanged = false;
      for (const key of [...params.keys()]) if (SECRET_PARAM.test(key)) { params.set(key, '***'); hashChanged = true; }
      if (hashChanged) { parsed.hash = params.toString(); changed = true; }
    }
    return changed ? parsed.toString().replace(/%2A%2A%2A/g, '***') : url;
  } catch { return url; }
}

function redactPlace(place?: { url: string; title: string }) { return place ? { ...place, url: redactUrl(place.url) } : place; }

export interface PruneResult { cutoff: string; kept: number; removed: number; snapshotsRemoved: number; screenshotsRemoved: number; dryRun: boolean }

export class AuditLog {
  private directory: string;
  private eventsPath: string;
  private sequence = 0;
  private session = 'default';
  private recent: AuditEvent[] = [];
  private labels = new Map<string, string>();
  /** Parsed ledger windows for the dashboards, dropped shortly after use so they never stay resident. */
  private cache = new Map<string, { size: number; events: AuditEvent[]; timer: NodeJS.Timeout }>();
  private today = { day: '', count: 0 };
  readonly run = randomUUID().slice(0, 8);
  /** The side panel and the MCP audit tool read the newest entries; everything older is read from disk on demand. */
  private static readonly RECENT_LIMIT = 1000;
  private static readonly CACHE_MS = 15000;
  redactUrls = true;

  constructor(directory: string) {
    this.directory = fromRoot(directory);
    mkdirSync(join(this.directory, 'snapshots'), { recursive: true });
    mkdirSync(join(this.directory, 'screens'), { recursive: true });
    this.eventsPath = join(this.directory, 'events.jsonl');
    this.load();
  }

  /**
   * Startup reads only the tail of the ledger: the newest RECENT_LIMIT entries, the line count (for sequence numbers)
   * and today's action count. The file is scanned in chunks, so a large ledger is never held in memory as one string.
   */
  private load(): void {
    this.recent = [];
    this.sequence = 0;
    this.today = { day: localDay(new Date().toISOString()), count: 0 };
    if (!existsSync(this.eventsPath)) return;
    const tail: string[] = [];
    let lines = 0;
    const todayKey = `"timestamp":"${new Date().toISOString().slice(0, 10)}`;
    forEachLine(this.eventsPath, line => {
      lines++;
      tail.push(line);
      if (tail.length > AuditLog.RECENT_LIMIT) tail.shift();
      if (line.includes(todayKey) && /"status":"(success|failure)"/.test(line) && !/"action":"(mcp\.call|trace\.screenshot)"/.test(line)) this.today.count++;
    });
    let last = 0;
    for (const line of tail) {
      try { const event = JSON.parse(line) as AuditEvent; this.recent.push(event); last = Math.max(last, event.sequence ?? 0); } catch { /* A torn trailing line is skipped, the file stays untouched. */ }
    }
    this.sequence = Math.max(lines, last);
  }

  /** Successful and failed steps today (UTC day, as before), kept as a counter instead of a scan. */
  todayActions(): number {
    const day = localDay(new Date().toISOString());
    if (this.today.day !== day) this.today = { day, count: 0 };
    return this.today.count;
  }

  get root(): string { return this.directory; }

  /** Legacy default label for callers that identify nothing; identified agents get per-session labels. */
  setSession(name: string): void { this.session = name; }
  getSession(): string { return this.session; }
  /** Label one agent session (key from sessionKey()); later entries of that session carry the label. */
  labelSession(key: string, label: string): void { this.labels.set(key, label); }
  sessionLabel(key: string): string | undefined { return this.labels.get(key); }

  saveSnapshot(snapshot: Omit<SnapshotResult, 'hash'>): SnapshotResult {
    const hash = createHash('sha256').update(snapshot.text).digest('hex');
    const complete = { ...snapshot, hash };
    writeFileSync(join(this.directory, 'snapshots', `${snapshot.id}.json`), JSON.stringify(complete, null, 2));
    return complete;
  }

  /** Store a screenshot for an event; returns the file name, or undefined for an unsafe name. */
  saveScreenshot(eventId: string, bytes: Buffer, extension = 'jpg'): string | undefined {
    const name = `${eventId}.${extension}`;
    if (!AuditLog.safeName(name)) return undefined;
    writeFileSync(join(this.directory, 'screens', name), bytes);
    return name;
  }

  screenshotPath(name: string): string | undefined {
    if (!AuditLog.safeName(name)) return undefined;
    const path = join(this.directory, 'screens', name);
    return existsSync(path) ? path : undefined;
  }

  static safeName(name: string): boolean { return /^[A-Za-z0-9-]{6,64}\.(jpg|png)$/.test(name); }

  record(input: Omit<AuditEvent, 'id' | 'sequence' | 'timestamp' | 'session' | 'run'> & { session?: string }): AuditEvent {
    const actor = input.actor ?? currentActor();
    const key = actor ? sessionKey(actor) : undefined;
    const session = input.session ?? (key && this.labels.get(key)) ?? actor?.session ?? this.session;
    const event: AuditEvent = {
      id: randomUUID(), sequence: ++this.sequence, timestamp: new Date().toISOString(),
      ...input, session, run: this.run, ...(actor ? { actor } : {})
    };
    if (this.redactUrls) {
      event.before = redactPlace(event.before);
      event.after = redactPlace(event.after);
      const target = event.target as { url?: unknown } | undefined;
      if (target && typeof target.url === 'string') event.target = { ...target, url: redactUrl(target.url) };
    }
    appendFileSync(this.eventsPath, JSON.stringify(event) + '\n');
    if ((event.status === 'success' || event.status === 'failure')) { this.todayActions(); this.today.count++; }
    this.recent.push(event);
    if (this.recent.length > AuditLog.RECENT_LIMIT * 1.2) this.recent.splice(0, this.recent.length - AuditLog.RECENT_LIMIT);
    return event;
  }

  /** Attach a screenshot to an event already written (the ledger line is append-only; a small info entry links them). */
  attachScreenshot(event: AuditEvent, name: string): void {
    event.screenshot = name;
    this.record({ action: 'trace.screenshot', status: 'info', pageId: event.pageId, actor: event.actor, session: event.session, detail: { eventId: event.id, file: name } });
  }

  /** Newest first. Served from memory so the cockpit can poll without re-reading the whole ledger. */
  list(limit = 100, filter?: (event: AuditEvent) => boolean): AuditEvent[] {
    const result: AuditEvent[] = [];
    for (let index = this.recent.length - 1; index >= 0 && result.length < limit; index--) {
      if (!filter || filter(this.recent[index])) result.push(this.recent[index]);
    }
    return result;
  }

  /**
   * Ledger events at or after `since` (ISO time), oldest first, with screenshots linked back onto their events.
   * Lines older than `since` are skipped by their timestamp prefix without being parsed. The result is shared for a
   * few seconds (dashboards poll) and then released.
   */
  all(since = ''): AuditEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const size = statSync(this.eventsPath).size;
    const cached = this.cache.get(since);
    if (cached && cached.size === size) return cached.events;
    const events: AuditEvent[] = [];
    const byId = new Map<string, AuditEvent>();
    forEachLine(this.eventsPath, line => { collect(line, since, events, byId); });
    this.remember(since, size, events);
    return events;
  }

  /** The same as all(), streamed from disk without blocking the event loop on a large ledger. */
  async read(since = ''): Promise<AuditEvent[]> {
    if (!existsSync(this.eventsPath)) return [];
    const size = statSync(this.eventsPath).size;
    const cached = this.cache.get(since);
    if (cached && cached.size === size) return cached.events;
    const events: AuditEvent[] = [];
    const byId = new Map<string, AuditEvent>();
    const lines = createInterface({ input: createReadStream(this.eventsPath, { encoding: 'utf8', highWaterMark: 256 * 1024 }), crlfDelay: Infinity });
    for await (const line of lines) collect(line, since, events, byId);
    this.remember(since, size, events);
    return events;
  }

  private remember(since: string, size: number, events: AuditEvent[]): void {
    const previous = this.cache.get(since);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.cache.delete(since), AuditLog.CACHE_MS);
    timer.unref?.();
    this.cache.set(since, { size, events, timer });
  }

  get(id: string): { event: AuditEvent; snapshot?: SnapshotResult } | undefined {
    const event = this.recent.find(item => item.id === id) ?? this.scan(id);
    if (!event) return undefined;
    if (!event.screenshot) {
      const link = this.recent.find(item => item.action === 'trace.screenshot' && (item.detail as { eventId?: string })?.eventId === id);
      const file = (link?.detail as { file?: string } | undefined)?.file ?? (existsSync(join(this.directory, 'screens', `${id}.jpg`)) ? `${id}.jpg` : undefined);
      if (file) event.screenshot = file;
    }
    let snapshot: SnapshotResult | undefined;
    if (event.basisSnapshotId) {
      const path = join(this.directory, 'snapshots', `${event.basisSnapshotId}.json`);
      if (existsSync(path)) snapshot = JSON.parse(readFileSync(path, 'utf8')) as SnapshotResult;
    }
    return { event, snapshot };
  }

  private scan(id: string): AuditEvent | undefined {
    return this.all().find(event => event.id === id);
  }

  /**
   * Remove ledger entries older than `days`, with the snapshots and screenshots only they referenced. The kept entries
   * are written to a temporary file first and swapped in, so an interruption never leaves a half-written ledger.
   */
  prune(days: number, dryRun = false): PruneResult {
    if (!(days > 0)) throw new Error('days must be a positive number');
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const lines = existsSync(this.eventsPath) ? readFileSync(this.eventsPath, 'utf8').split(/\r?\n/).filter(Boolean) : [];
    const kept: string[] = [];
    const removedIds = new Set<string>();
    const keptSnapshots = new Set<string>();
    for (const line of lines) {
      let event: AuditEvent | undefined;
      try { event = JSON.parse(line) as AuditEvent; } catch { kept.push(line); continue; }
      if (event.timestamp < cutoff) { removedIds.add(event.id); continue; }
      kept.push(line);
      if (event.basisSnapshotId) keptSnapshots.add(event.basisSnapshotId);
      const target = event.target as { snapshotId?: string } | undefined;
      if (target?.snapshotId) keptSnapshots.add(target.snapshotId);
    }
    let snapshotsRemoved = 0;
    let screenshotsRemoved = 0;
    const snapshotDir = join(this.directory, 'snapshots');
    for (const file of existsSync(snapshotDir) ? readdirSync(snapshotDir) : []) {
      const id = file.replace(/\.json$/, '');
      const path = join(snapshotDir, file);
      if (!keptSnapshots.has(id) && statSync(path).mtime.toISOString() < cutoff) { snapshotsRemoved++; if (!dryRun) unlinkSync(path); }
    }
    const screenDir = join(this.directory, 'screens');
    for (const file of existsSync(screenDir) ? readdirSync(screenDir) : []) {
      const path = join(screenDir, file);
      if (removedIds.has(file.replace(/\.(jpg|png)$/, '')) || statSync(path).mtime.toISOString() < cutoff) { screenshotsRemoved++; if (!dryRun) unlinkSync(path); }
    }
    if (!dryRun && removedIds.size) {
      const temporary = `${this.eventsPath}.prune-tmp`;
      writeFileSync(temporary, kept.map(line => line + '\n').join(''));
      renameSync(temporary, this.eventsPath);
      for (const entry of this.cache.values()) clearTimeout(entry.timer);
      this.cache.clear();
      const sequence = this.sequence;
      this.load();
      this.sequence = Math.max(this.sequence, sequence);
    }
    return { cutoff, kept: kept.length, removed: removedIds.size, snapshotsRemoved, screenshotsRemoved, dryRun };
  }

  /** Screenshots are the bulkiest part of the trace; they can expire sooner than the ledger. */
  pruneScreenshots(days: number): number {
    if (!(days > 0)) return 0;
    const cutoff = Date.now() - days * 86400000;
    const screenDir = join(this.directory, 'screens');
    let removed = 0;
    for (const file of existsSync(screenDir) ? readdirSync(screenDir) : []) {
      const path = join(screenDir, file);
      if (statSync(path).mtimeMs < cutoff) { unlinkSync(path); removed++; }
    }
    return removed;
  }
}

/** Key a session label is stored under: the agent session if it has one, else the agent (and its window). */
export function sessionKey(actor: Actor): string {
  return actor.session ? `s:${actor.session}` : `a:${actor.agent}${actor.window ? '/' + actor.window : ''}`;
}

function localDay(iso: string): string { return iso.slice(0, 10); }

function collect(line: string, since: string, events: AuditEvent[], byId: Map<string, AuditEvent>): void {
  if (!line) return;
  if (since) {
    const at = line.indexOf('"timestamp":"');
    if (at >= 0 && line.slice(at + 13, at + 13 + since.length) < since) return;
  }
  try {
    const event = JSON.parse(line) as AuditEvent;
    if (event.action === 'trace.screenshot') {
      const detail = event.detail as { eventId?: string; file?: string } | undefined;
      const owner = detail?.eventId ? byId.get(detail.eventId) : undefined;
      if (owner && detail?.file) owner.screenshot = detail.file;
      return;
    }
    events.push(event);
    byId.set(event.id, event);
  } catch { /* torn line */ }
}

/** Call fn for every line of a file, reading it in 1 MB chunks. */
function forEachLine(path: string, fn: (line: string) => void): void {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(1 << 20);
    let rest = '';
    let position = 0;
    const size = fstatSync(fd).size;
    while (position < size) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      position += read;
      const text = rest + buffer.toString('utf8', 0, read);
      const parts = text.split(/\r?\n/);
      rest = parts.pop() ?? '';
      for (const part of parts) if (part) fn(part);
    }
    if (rest) fn(rest);
  } finally { closeSync(fd); }
}
