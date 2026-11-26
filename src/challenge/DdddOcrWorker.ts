import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fromRoot } from '../config.js';
import type { CapabilityManifest } from '../capabilities/CapabilityRegistry.js';

/** A 1×1 PNG: running the model once makes the first real CAPTCHA as fast as the next. */
const WARM_IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export interface OcrResult { text: string; probability?: number[] }
interface Pending { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

export interface Region { x: number; y: number; w: number; h: number }
/** The worker's multi-frame and geometry operations, beyond reading one still image. */
export interface VisionOps {
  /** Load OpenCV (and for clicks the detector) ahead of the first frame, while the pointer travels. */
  prepare: { in: { kind: string }; out: { ready: boolean } };
  /** Frames of one image that shows its text piece by piece: merged into one frame, then read. */
  classify_frames: { in: { frames: string[] }; out: { text: string; keyframes: number } };
  /** What changed between the frame before a press and the frames while it is held (the gap, often the piece). */
  reveal: { in: { before: string; frames: string[]; threshold?: number }; out: { width: number; height: number; regions: Array<Region & { area: number }> } };
  /** Classic slider with a separate piece image: where the piece fits in the background. */
  slide_match: { in: { piece: string; background: string; simple?: boolean }; out: { target?: number[]; confidence?: number } };
  /** Ordered click points for "click these in order" challenges; the prompt may be DOM text, a still or a sequence. */
  click_plan: {
    in: { frames: string[]; times?: number[]; prompt?: Region; canvas: Region; exclude?: Region; tokens?: string[] };
    out: { points: Array<{ x: number; y: number }>; method: string; items: number; textMatched?: number; candidates?: number; cycled?: boolean; reason?: string };
  };
}
/** A challenge provider that can do more than read text; the built-in ddddocr worker is one. */
export interface ChallengeVision { vision<K extends keyof VisionOps>(op: K, payload: VisionOps[K]['in']): Promise<VisionOps[K]['out']> }
export const hasVision = (provider: unknown): provider is ChallengeVision => typeof (provider as ChallengeVision)?.vision === 'function';

export class DdddOcrWorker {
  readonly manifest: CapabilityManifest = { id: 'challenge.ocr.ddddocr', version: '0.3.0', kind: 'challenge', runtime: 'python', dataEgress: 'local-only', description: 'Persistent local ddddocr worker for text, multi-frame, slider and ordered-click challenges; answers never enter the model context.' };
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private stdout = '';
  private stderr = '';

  private warming?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  /** How long the loaded model stays resident without agent activity (0 keeps it for the app's lifetime). */
  private idleUnloadMs: number;

  constructor(private options: { pythonCommand: string; pythonFallback: string; timeoutMs: number; maxImageBytes: number; ocrIdleUnloadMinutes?: number }) {
    this.idleUnloadMs = Math.max(0, options.ocrIdleUnloadMinutes ?? 20) * 60000;
  }

  /**
   * Make sure the model is loaded before it is needed: Waymark calls this shortly after startup and on every agent
   * call, so a CAPTCHA never waits for Python and the model to start. Cheap when already warm.
   */
  warm(): Promise<void> {
    this.armIdle();
    if (this.child && !this.warming) return Promise.resolve();
    this.warming ??= this.send({ warm: true, image: WARM_IMAGE }, Math.max(this.options.timeoutMs, 60000))
      .then(() => undefined, () => undefined)
      .finally(() => { this.warming = undefined; });
    return this.warming;
  }

  isLoaded(): boolean { return Boolean(this.child); }

  /** With no agent activity for idleUnloadMs the worker exits and its memory returns to the system; warm() restarts it. */
  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.idleUnloadMs) return;
    this.idleTimer = setTimeout(() => { if (!this.pending.size) this.stopWorker(); }, this.idleUnloadMs);
    this.idleTimer.unref?.();
  }

  async invoke(image: Buffer): Promise<OcrResult> {
    if (image.byteLength > this.options.maxImageBytes) throw new Error('Challenge image exceeds configured byte limit');
    this.armIdle();
    return await this.send({ image: image.toString('base64') }, this.options.timeoutMs);
  }

  async vision<K extends keyof VisionOps>(op: K, payload: VisionOps[K]['in']): Promise<VisionOps[K]['out']> {
    const images = Object.values(payload).flatMap(v => Array.isArray(v) ? v : [v]).filter((v): v is string => typeof v === 'string' && v.length > 64);
    if (images.some(image => image.length * 0.75 > this.options.maxImageBytes)) throw new Error('Challenge image exceeds configured byte limit');
    this.armIdle();
    return await this.send<VisionOps[K]['out']>({ op, ...payload }, this.options.timeoutMs);
  }

  private send<T = OcrResult>(payload: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const child = this.ensureWorker();
    const id = randomUUID();
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('OCR worker timed out');
        this.rejectAll(error);
        this.stopWorker();
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      child.stdin.write(JSON.stringify({ id, ...payload }) + '\n', error => {
        if (error) this.fail(id, error);
      });
    });
  }

  async close(): Promise<void> { if (this.idleTimer) clearTimeout(this.idleTimer); this.stopWorker(); }

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const primary = this.options.pythonCommand.includes('/') || this.options.pythonCommand.includes('\\') ? fromRoot(this.options.pythonCommand) : this.options.pythonCommand;
    const command = existsSync(primary) ? primary : this.options.pythonFallback;
    const child = spawn(command, ['python/ocr_worker.py'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.stdout = '';
    this.stderr = '';
    child.stdout.on('data', chunk => this.onStdout(chunk.toString()));
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-1000); });
    child.on('error', error => { this.rejectAll(new Error(`OCR worker unavailable: ${error.message}`)); this.stopWorker(); });
    child.on('close', code => {
      if (this.pending.size) this.rejectAll(new Error(`OCR worker exited with ${code}: ${this.stderr.slice(-300)}`));
      if (this.child === child) this.child = undefined;
    });
    return child;
  }

  private onStdout(chunk: string): void {
    this.stdout += chunk;
    if (this.stdout.length > 65536) { this.rejectAll(new Error('OCR worker output exceeded limit')); this.stopWorker(); return; }
    let newline = this.stdout.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (line) {
        try {
          const { id, error, ...response } = JSON.parse(line) as { id?: string; text?: string; error?: string };
          if (id && this.pending.has(id)) {
            if (error) this.fail(id, new Error(error));
            else this.succeed(id, 'text' in response ? { ...response, text: response.text ?? '' } : response);
          }
        } catch { this.rejectAll(new Error('Invalid OCR worker response')); this.stopWorker(); }
      }
      newline = this.stdout.indexOf('\n');
    }
  }

  private succeed(id: string, result: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(result);
  }

  private fail(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.fail(id, error);
  }

  private stopWorker(): void {
    const child = this.child;
    this.child = undefined;
    if (child) { child.stdin.end(); child.kill(); }
  }
}
