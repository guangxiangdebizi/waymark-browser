import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fromRoot } from '../config.js';
import type { CapabilityManifest } from '../capabilities/CapabilityRegistry.js';

/** A 1×1 PNG: running the model once makes the first real CAPTCHA as fast as the next. */
const WARM_IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export interface OcrResult { text: string; probability?: number[] }
interface Pending { resolve: (value: OcrResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

export class DdddOcrWorker {
  readonly manifest: CapabilityManifest = { id: 'challenge.ocr.ddddocr', version: '0.2.0', kind: 'challenge', runtime: 'python', dataEgress: 'local-only', description: 'Persistent local ddddocr worker; answers never enter the model context.' };
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

  private send(payload: Record<string, unknown>, timeoutMs: number): Promise<OcrResult> {
    const child = this.ensureWorker();
    const id = randomUUID();
    return new Promise<OcrResult>((resolvePromise, reject) => {
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
          const response = JSON.parse(line) as { id?: string; text?: string; error?: string };
          if (response.id && this.pending.has(response.id)) {
            if (response.error) this.fail(response.id, new Error(response.error));
            else this.succeed(response.id, { text: response.text ?? '' });
          }
        } catch { this.rejectAll(new Error('Invalid OCR worker response')); this.stopWorker(); }
      }
      newline = this.stdout.indexOf('\n');
    }
  }

  private succeed(id: string, result: OcrResult): void {
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
