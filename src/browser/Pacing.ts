import type { CapabilityManifest } from '../capabilities/CapabilityRegistry.js';

/**
 * What a pacing model sees before Waymark carries out an agent's step. It never receives the page:
 * only timing and a coarse description of the step and of what the agent was last shown.
 */
export interface PacingContext {
  /** `act` kinds, `navigate`, or `field` for the pause between fields of one multi-field fill. */
  kind: string;
  /** Milliseconds since the agent last received this page's state (the result of its previous call). */
  sinceObservedMs: number;
  /** Lines (elements and headings) the agent was shown in that result; a rough measure of what a person would read. */
  shownLines: number;
  /** The target looks like a commit step: submit, next, confirm, pay. */
  commit: boolean;
  /** Zero-based field position within a fill. */
  index?: number;
}

/** A pacing model returns how long to wait, in ms, before the step starts. Waymark clamps it to 0–8000. */
export interface PacingModel {
  readonly manifest: CapabilityManifest;
  delay(context: PacingContext): number | Promise<number>;
  invoke(context: PacingContext): Promise<number>;
  close?(): Promise<void>;
}

export interface PacingOptions {
  /** Median reaction from seeing a page to starting each kind of step, before any reading time. */
  reactionMs: Record<string, number>;
  reactionSpread: number;
  /** Reading time per line the agent was shown, capped by `readCapMs`. */
  readPerLineMs: number;
  readCapMs: number;
  /** Extra hesitation before a commit step. */
  commitMs: [number, number];
  /** Median pause between fields of one fill. */
  fieldGapMs: number;
}

/** Calibrated on human form-filling: about 1 s from seeing a field to acting on it, half a second between fields. */
export const DEFAULT_PACING: PacingOptions = {
  reactionMs: { click: 850, hover: 600, fill: 1000, type: 950, select: 1000, press: 450, scroll: 550, paste: 900, copy: 700, navigate: 700 },
  reactionSpread: 0.35,
  readPerLineMs: 90,
  readCapMs: 2200,
  commitMs: [300, 900],
  fieldGapMs: 520
};

/**
 * Human reaction pacing. A person needs time to read what appeared and decide; an agent that answers faster than that
 * waits for the difference, and an agent that already took longer (an LLM round trip) waits for nothing.
 */
export class HumanPacing implements PacingModel {
  readonly manifest: CapabilityManifest = { id: 'action.pacing.human', version: '0.1.0', kind: 'action', runtime: 'node', dataEgress: 'local-only', description: 'Waits out a human reaction time when the agent answers faster than a person could.' };
  private options: PacingOptions;
  constructor(options: Partial<PacingOptions> = {}) { this.options = { ...DEFAULT_PACING, ...options, reactionMs: { ...DEFAULT_PACING.reactionMs, ...options.reactionMs } }; }

  delay(context: PacingContext): number {
    const o = this.options;
    if (context.kind === 'field') return lognormal(o.fieldGapMs, o.reactionSpread);
    const reaction = lognormal(o.reactionMs[context.kind] ?? 800, o.reactionSpread);
    const reading = Math.min(o.readCapMs, context.shownLines * o.readPerLineMs);
    const commit = context.commit ? between(...o.commitMs) : 0;
    return Math.max(0, reaction + reading + commit - context.sinceObservedMs);
  }

  async invoke(context: PacingContext): Promise<number> { return this.delay(context); }
}

/** No pacing: every step starts as soon as it arrives (the pre-0.5 behaviour). */
export class NoPacing implements PacingModel {
  readonly manifest: CapabilityManifest = { id: 'action.pacing.off', version: '0.1.0', kind: 'action', runtime: 'node', dataEgress: 'local-only', description: 'Steps start immediately.' };
  delay(): number { return 0; }
  async invoke(): Promise<number> { return 0; }
}

const COMMIT = /submit|send|next|continue|confirm|pay|place order|checkout|sign in|log in|register|apply|book|提交|发送|下一步|继续|确认|支付|付款|下单|登录|注册|申请|预约/i;
export function looksLikeCommit(role: string | undefined, name: string | undefined): boolean {
  return Boolean(name) && /button|submit|link|a$/i.test(role ?? '') && COMMIT.test(name!);
}

export function clampDelay(ms: unknown): number { return Number.isFinite(ms) ? Math.max(0, Math.min(8000, Number(ms))) : 0; }

export function lognormal(median: number, spread: number): number {
  const u = 1 - Math.random(), v = Math.random();
  return median * Math.exp(spread * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}
function between(min: number, max: number): number { return min + Math.random() * (max - min); }
