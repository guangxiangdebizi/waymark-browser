import type { Page } from 'playwright-core';
import type { CapabilityManifest } from '../capabilities/CapabilityRegistry.js';

/** What the runtime needs from a keyboard capability: enter text at the caret of the focused control. */
export interface KeyboardInput { page: Page; text: string }

export interface KeyboardActor {
  readonly manifest: CapabilityManifest;
  type(page: Page, text: string): Promise<void>;
  invoke(input: KeyboardInput): Promise<void>;
  close?(): Promise<void>;
}

export interface TypingOptions {
  dwellMedianMs: number;
  dwellSpread: number;
  gapMedianMs: number;
  gapSpread: number;
  wordPauseMs: [number, number];
  thinkPauseChance: number;
  thinkPauseMs: [number, number];
  typoChance: number;
}

/** Calibrated on human form-filling telemetry: ~105 ms key hold, ~120 ms between keys, longer pauses at word breaks. */
export const DEFAULT_TYPING: TypingOptions = {
  dwellMedianMs: 105, dwellSpread: 0.33,
  gapMedianMs: 120, gapSpread: 0.45,
  wordPauseMs: [60, 260],
  thinkPauseChance: 0.03, thinkPauseMs: [350, 1100],
  typoChance: 0.02
};

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** Human-paced typing: per-key hold time, uneven gaps, word pauses and rare typos corrected with Backspace. */
export class HumanKeyboard implements KeyboardActor {
  readonly manifest: CapabilityManifest = { id: 'action.keyboard.human', version: '0.1.0', kind: 'action', runtime: 'node', dataEgress: 'local-only', description: 'Human-paced typing with key hold time, variable gaps and corrected typos.' };
  private options: TypingOptions;
  constructor(options: Partial<TypingOptions> = {}) { this.options = { ...DEFAULT_TYPING, ...options }; }
  async invoke({ page, text }: KeyboardInput): Promise<void> { await this.type(page, text); }

  async type(page: Page, text: string): Promise<void> {
    for (const ch of text) {
      if (ch === '\n') await this.key(page, 'Enter');
      // Characters outside printable ASCII arrive through an input method, not as individual keys.
      else if (!/^[\x20-\x7e]$/.test(ch)) await page.keyboard.insertText(ch);
      else {
        const wrong = /[a-z]/i.test(ch) && Math.random() < this.options.typoChance ? this.neighbor(ch) : undefined;
        if (wrong) { await this.key(page, wrong); await this.gap(); await this.key(page, 'Backspace'); await this.gap(); }
        await this.key(page, ch);
      }
      await this.gap(ch);
    }
  }

  private async key(page: Page, key: string): Promise<void> {
    await page.keyboard.down(key);
    await sleep(clamp(lognormal(this.options.dwellMedianMs, this.options.dwellSpread), 35, 320));
    await page.keyboard.up(key);
  }

  private async gap(after?: string): Promise<void> {
    let ms = clamp(lognormal(this.options.gapMedianMs, this.options.gapSpread), 25, 900);
    if (after === ' ') ms += between(...this.options.wordPauseMs);
    if (Math.random() < this.options.thinkPauseChance) ms += between(...this.options.thinkPauseMs);
    await sleep(ms);
  }

  private neighbor(ch: string): string {
    const lower = ch.toLowerCase();
    for (const row of ROWS) {
      const i = row.indexOf(lower);
      if (i < 0) continue;
      const j = i === 0 ? 1 : i === row.length - 1 ? i - 1 : i + (Math.random() < 0.5 ? -1 : 1);
      return ch === lower ? row[j] : row[j].toUpperCase();
    }
    return ch;
  }
}

/** The pre-0.4 behaviour: every key pressed and released immediately, 8 ms apart. */
export class FastKeyboard implements KeyboardActor {
  readonly manifest: CapabilityManifest = { id: 'action.keyboard.fast', version: '0.1.0', kind: 'action', runtime: 'node', dataEgress: 'local-only', description: 'Fast typing: instant key presses 8 ms apart.' };
  async type(page: Page, text: string): Promise<void> { await page.keyboard.type(text, { delay: 8 }); }
  async invoke({ page, text }: KeyboardInput): Promise<void> { await this.type(page, text); }
}

function lognormal(median: number, spread: number): number {
  const u = 1 - Math.random(), v = Math.random();
  return median * Math.exp(spread * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}
function between(min: number, max: number): number { return min + Math.random() * (max - min); }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, Math.round(ms))); }
