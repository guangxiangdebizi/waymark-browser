import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';
import type { AppConfig } from '../types.js';
import { fromRoot } from '../config.js';
import type { CapabilityManifest, CapabilityProvider, CapabilityRegistry } from './CapabilityRegistry.js';
import type { PointerActor, PointerInput } from '../browser/InputActor.js';

/** One sample of a pointer path. `dt` is the pause in ms before moving to the next sample. */
export interface TrajectoryPoint { x: number; y: number; dt?: number }

export interface TrajectoryRequest {
  from: { x: number; y: number };
  to: { x: number; y: number };
  viewport?: { width: number; height: number };
  purpose: 'click' | 'hover' | 'ambient';
}

/**
 * A pluggable pointer behaviour model. It only computes a path: the browser executes it
 * through its own input pipeline, so a model never receives the page, cookies or the DOM.
 */
export interface TrajectoryModel {
  manifest: { id: string; version?: string; description?: string; runtime?: CapabilityManifest['runtime'] };
  trajectory(request: TrajectoryRequest): TrajectoryPoint[] | Promise<TrajectoryPoint[]>;
  /** Button hold time for clicks, in ms. */
  pressMs?(): number;
  close?(): Promise<void>;
}

/** Which slot an external-process plugin fills. Module plugins declare themselves by shape. */
export type PluginSlot = 'pointer' | 'ocr';

export type PluginEntry =
  | { module: string }
  | { id: string; command: string[]; kind?: PluginSlot; version?: string; description?: string; timeoutMs?: number };

const MAX_POINTS = 2000;
const MAX_DT = 250;

export class TrajectoryPointer implements PointerActor {
  readonly manifest: CapabilityManifest;
  private positions = new WeakMap<Page, { x: number; y: number }>();

  constructor(private model: TrajectoryModel, private fallback: PointerActor) {
    this.manifest = {
      id: model.manifest.id, version: model.manifest.version ?? '0.0.0', kind: 'action',
      runtime: model.manifest.runtime ?? 'node', dataEgress: 'local-only',
      description: model.manifest.description ?? 'Custom pointer trajectory model'
    };
  }

  async invoke(input: PointerInput): Promise<void> {
    await this.move(input, 'click');
    const hold = Math.max(0, Math.min(400, Number(this.model.pressMs?.() ?? 45)));
    await input.page.mouse.click(input.x, input.y, { delay: Number.isFinite(hold) ? hold : 45 });
  }

  async move(input: PointerInput, purpose: TrajectoryRequest['purpose'] = 'hover'): Promise<void> {
    const { page, x, y } = input;
    const from = this.positions.get(page) ?? { x: 0, y: 0 };
    let points: TrajectoryPoint[];
    try {
      points = sanitize(await this.model.trajectory({ from, to: { x, y }, viewport: page.viewportSize() ?? undefined, purpose }));
    } catch (error) {
      // A broken model must not break the agent's action: fall back to the built-in path.
      console.warn(`[waymark] pointer model ${this.manifest.id} failed, using fallback: ${error instanceof Error ? error.message : error}`);
      await this.fallback.move(input);
      this.positions.set(page, { x, y });
      return;
    }
    for (const point of points) {
      await page.mouse.move(point.x, point.y);
      if (point.dt) await page.waitForTimeout(point.dt);
    }
    const last = points.at(-1);
    if (!last || last.x !== x || last.y !== y) await page.mouse.move(x, y);
    this.positions.set(page, { x, y });
  }

  async close(): Promise<void> { await this.model.close?.(); }
}

function sanitize(points: unknown): TrajectoryPoint[] {
  if (!Array.isArray(points)) throw new Error('trajectory must return an array of {x, y, dt}');
  if (points.length > MAX_POINTS) throw new Error(`trajectory returned ${points.length} points (max ${MAX_POINTS})`);
  return points.map((point, index) => {
    const { x, y, dt } = (point ?? {}) as TrajectoryPoint;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`trajectory point ${index} is not finite`);
    return { x, y, dt: Number.isFinite(dt) ? Math.max(0, Math.min(MAX_DT, dt!)) : 0 };
  });
}

type ProcessEntry = { id: string; command: string[]; version?: string; description?: string; timeoutMs?: number };

/** A long-lived child process answering one JSON line per request on stdin/stdout, matched by `id`. */
class JsonLineProcess {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;

  constructor(private entry: ProcessEntry, private defaultTimeoutMs: number) {}

  request<T>(payload: object): Promise<T> {
    const child = this.process();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.entry.id} timed out`)); }, this.entry.timeoutMs ?? this.defaultTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }

  close(): void { this.child?.kill(); this.child = undefined; }

  private process(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null) return this.child;
    const [command, ...args] = this.entry.command;
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    createInterface({ input: child.stdout }).on('line', line => {
      let message: { id?: number; error?: string };
      try { message = JSON.parse(line); } catch { return; }
      const waiter = message.id === undefined ? undefined : this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id!);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error));
      else waiter.resolve(message);
    });
    child.stderr.on('data', chunk => process.stderr.write(`[${this.entry.id}] ${chunk}`));
    const failAll = (reason: string) => { for (const [id, waiter] of this.pending) { clearTimeout(waiter.timer); waiter.reject(new Error(reason)); this.pending.delete(id); } };
    child.on('exit', code => failAll(`model process exited (${code})`));
    child.on('error', error => failAll(error.message));
    this.child = child;
    return child;
  }
}

/** Pointer model in another process (e.g. Python): `{id, from, to, viewport, purpose}` -> `{id, points, pressMs?}`. */
export class ProcessTrajectoryModel implements TrajectoryModel {
  readonly manifest: TrajectoryModel['manifest'];
  private process: JsonLineProcess;
  private lastPress = 45;

  constructor(entry: ProcessEntry) {
    this.manifest = { id: entry.id, version: entry.version, description: entry.description ?? `External pointer model: ${entry.command.join(' ')}`, runtime: 'external-process' };
    this.process = new JsonLineProcess(entry, 2000);
  }

  pressMs(): number { return this.lastPress; }

  async trajectory(request: TrajectoryRequest): Promise<TrajectoryPoint[]> {
    const reply = await this.process.request<{ points?: TrajectoryPoint[]; pressMs?: number }>(request);
    if (Number.isFinite(reply.pressMs)) this.lastPress = reply.pressMs!;
    if (!reply.points) throw new Error('model returned no points');
    return reply.points;
  }

  async close(): Promise<void> { this.process.close(); }
}

/** CAPTCHA/OCR solver in another process: `{id, image: <base64 PNG>}` -> `{id, text}`. Same contract as the ddddocr worker. */
export class ProcessOcrProvider implements CapabilityProvider<Buffer, { text: string }> {
  readonly manifest: CapabilityManifest;
  private process: JsonLineProcess;

  constructor(entry: ProcessEntry) {
    this.manifest = { id: entry.id, version: entry.version ?? '0.0.0', kind: 'challenge', runtime: 'external-process', dataEgress: 'local-only', description: entry.description ?? `External OCR solver: ${entry.command.join(' ')}` };
    this.process = new JsonLineProcess(entry, 15000);
  }

  async invoke(image: Buffer): Promise<{ text: string }> {
    const reply = await this.process.request<{ text?: unknown }>({ image: image.toString('base64') });
    if (typeof reply.text !== 'string' || reply.text.length > 128) throw new Error('solver returned an invalid answer');
    return { text: reply.text };
  }

  async close(): Promise<void> { this.process.close(); }
}

function isTrajectoryModel(value: any): value is TrajectoryModel { return value && typeof value.trajectory === 'function' && value.manifest?.id; }
function isProvider(value: any): value is CapabilityProvider { return value && typeof value.invoke === 'function' && value.manifest?.id; }

/**
 * Loads `capabilities.plugins` from config. A module may export (default or `providers`) a TrajectoryModel,
 * a full CapabilityProvider, an array of them, or a factory `({ config }) => ...` returning any of those.
 */
export async function loadPlugins(config: AppConfig, registry: CapabilityRegistry, fallbackPointer: PointerActor): Promise<string[]> {
  const loaded: string[] = [];
  for (const entry of config.capabilities.plugins ?? []) {
    try {
      if ('command' in entry) {
        registry.register(entry.kind === 'ocr' ? new ProcessOcrProvider(entry) : new TrajectoryPointer(new ProcessTrajectoryModel(entry), fallbackPointer));
        loaded.push(entry.id);
        continue;
      }
      const module = await import(pathToFileURL(fromRoot(entry.module)).href);
      let exported = module.default ?? module.providers ?? module;
      if (typeof exported === 'function' && !isTrajectoryModel(exported) && !isProvider(exported)) exported = await exported({ config });
      for (const item of Array.isArray(exported) ? exported : [exported]) {
        if (isTrajectoryModel(item)) registry.register(new TrajectoryPointer(item, fallbackPointer));
        else if (isProvider(item)) registry.register(item);
        else throw new Error('export a TrajectoryModel ({ manifest, trajectory }) or a CapabilityProvider ({ manifest, invoke })');
        loaded.push(item.manifest.id);
      }
    } catch (error) {
      console.warn(`[waymark] plugin ${'module' in entry ? entry.module : entry.id} not loaded: ${error instanceof Error ? error.message : error}`);
    }
  }
  return loaded;
}
