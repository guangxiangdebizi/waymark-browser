import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fromRoot } from '../config.js';
import type { SnapshotResult } from '../types.js';

export interface AuditEvent {
  id: string;
  sequence: number;
  timestamp: string;
  session: string;
  pageId?: number;
  action: string;
  target?: unknown;
  basisSnapshotId?: string;
  basisSnapshotHash?: string;
  before?: { url: string; title: string };
  after?: { url: string; title: string };
  durationMs?: number;
  status: 'started' | 'success' | 'failure' | 'info';
  error?: string;
  detail?: unknown;
  capabilities?: Array<{ id: string; version: string }>;
}

export class AuditLog {
  private directory: string;
  private eventsPath: string;
  private sequence = 0;
  private session = 'default';
  private recent: AuditEvent[] = [];
  private static readonly RECENT_LIMIT = 5000;

  constructor(directory: string) {
    this.directory = fromRoot(directory);
    mkdirSync(join(this.directory, 'snapshots'), { recursive: true });
    this.eventsPath = join(this.directory, 'events.jsonl');
    if (existsSync(this.eventsPath)) {
      const lines = readFileSync(this.eventsPath, 'utf8').split(/\r?\n/).filter(Boolean);
      this.sequence = lines.length;
      for (const line of lines.slice(-AuditLog.RECENT_LIMIT)) {
        try { this.recent.push(JSON.parse(line) as AuditEvent); } catch { /* A torn trailing line is skipped, the file stays untouched. */ }
      }
    }
  }

  setSession(name: string): void { this.session = name; }
  getSession(): string { return this.session; }

  saveSnapshot(snapshot: Omit<SnapshotResult, 'hash'>): SnapshotResult {
    const hash = createHash('sha256').update(snapshot.text).digest('hex');
    const complete = { ...snapshot, hash };
    writeFileSync(join(this.directory, 'snapshots', `${snapshot.id}.json`), JSON.stringify(complete, null, 2));
    return complete;
  }

  record(input: Omit<AuditEvent, 'id' | 'sequence' | 'timestamp' | 'session'> & { session?: string }): AuditEvent {
    const event: AuditEvent = {
      id: randomUUID(), sequence: ++this.sequence, timestamp: new Date().toISOString(),
      session: input.session ?? this.session, ...input
    };
    appendFileSync(this.eventsPath, JSON.stringify(event) + '\n');
    this.recent.push(event);
    if (this.recent.length > AuditLog.RECENT_LIMIT * 1.2) this.recent.splice(0, this.recent.length - AuditLog.RECENT_LIMIT);
    return event;
  }

  /** Newest first. Served from memory so the cockpit can poll without re-reading the whole ledger. */
  list(limit = 100, filter?: (event: AuditEvent) => boolean): AuditEvent[] {
    const result: AuditEvent[] = [];
    for (let index = this.recent.length - 1; index >= 0 && result.length < limit; index--) {
      if (!filter || filter(this.recent[index])) result.push(this.recent[index]);
    }
    return result;
  }

  get(id: string): { event: AuditEvent; snapshot?: SnapshotResult } | undefined {
    const event = this.recent.find(item => item.id === id) ?? this.scan(id);
    if (!event) return undefined;
    let snapshot: SnapshotResult | undefined;
    if (event.basisSnapshotId) {
      const path = join(this.directory, 'snapshots', `${event.basisSnapshotId}.json`);
      if (existsSync(path)) snapshot = JSON.parse(readFileSync(path, 'utf8')) as SnapshotResult;
    }
    return { event, snapshot };
  }

  private scan(id: string): AuditEvent | undefined {
    if (!existsSync(this.eventsPath)) return undefined;
    const line = readFileSync(this.eventsPath, 'utf8').split(/\r?\n/).find(item => item.includes(id));
    return line ? JSON.parse(line) as AuditEvent : undefined;
  }
}
