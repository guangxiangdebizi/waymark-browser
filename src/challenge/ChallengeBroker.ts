import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import type { AppConfig, ChallengeJob } from '../types.js';
import { BrowserRuntime } from '../browser/BrowserRuntime.js';
import type { CapabilityRegistry } from '../capabilities/CapabilityRegistry.js';
import type { PointerActor } from '../browser/InputActor.js';
import { dragTo, nudge, release } from '../browser/HumanDrag.js';
import { hasVision, type ChallengeVision, type Region } from './DdddOcrWorker.js';

interface Detection {
  kind: ChallengeJob['kind'];
  hasImage: boolean;
  hasInput: boolean;
  hasSubmit: boolean;
  detail: string;
  /** Click targets the page spells out as text ("click 猫 山 水 in order"), so no OCR of the prompt is needed. */
  tokens?: string[];
}

type Box = { x: number; y: number; width: number; height: number };
const MARKS = ['image', 'input', 'submit', 'handle', 'bg', 'piece', 'prompt', 'canvas', 'confirm'];
const mark = (name: string) => `[data-agent-challenge-${name}]`;
const b64 = (buffer: Buffer) => buffer.toString('base64');
/** Pixel width of a PNG, to map frame pixels back to CSS pixels on high-DPI screens. */
const pngWidth = (png: Buffer) => png.readUInt32BE(16);
const sleep = (page: Page, min: number, max: number) => page.waitForTimeout(min + Math.random() * (max - min));

export class ChallengeBroker {
  private jobs = new Map<string, ChallengeJob>();
  private byPage = new Map<number, string>();


  constructor(private runtime: BrowserRuntime, private config: AppConfig, private capabilities: CapabilityRegistry) {
    runtime.setAutomationGuard(pageId => this.assertAutomationAllowed(pageId));
    runtime.setSettledHook(pageId => this.onSettled(pageId));
  }

  async onSettled(pageId: number): Promise<ChallengeJob | null> {
    const existing = this.activeForPage(pageId);
    if (existing && !['resolved_unverified', 'failed', 'cancelled'].includes(existing.status)) return existing;
    const page = await this.runtime.getPage(pageId);
    // The local cockpit pages talk about CAPTCHAs themselves; never treat them as a challenge.
    if (page.url().startsWith(`http://${this.config.server.host}:${this.config.server.port}/`)) return null;
    const detection = await this.detectSafely(page);
    if (!detection) return null;
    const now = new Date().toISOString();
    const job: ChallengeJob = {
      id: randomUUID(), pageId, origin: new URL(page.url()).origin, kind: detection.kind,
      status: 'detected', createdAt: now, updatedAt: now, ocrAttempts: 0, aiAttempts: 0,
      checkpointActionId: this.runtime.lastSuccessfulActionId(), checkpointUrl: page.url(), detail: detection.detail
    };
    this.jobs.set(job.id, job);
    this.byPage.set(pageId, job.id);
    this.runtime.audit.record({ pageId, action: 'challenge.detected', status: 'info', detail: { jobId: job.id, kind: job.kind, origin: job.origin, checkpointActionId: job.checkpointActionId } });
    if (job.ocrAttempts < this.config.challenge.maxOcrAttempts) {
      if (detection.kind === 'text_image') return this.runOcr(job);
      if (detection.kind === 'slider') return this.runLocal(job, () => this.solveSlider(job));
      if (detection.kind === 'click_sequence') return this.runLocal(job, () => this.solveClicks(job, detection));
    }
    return this.requireAi(job, detection.kind === 'interactive' ? 'Challenge type requires AI recovery' : 'Local attempt budget used up');
  }

  /** Get the local OCR model ready ahead of need (background, never blocks the caller). */
  prepare(reason: 'agent' | 'startup' = 'agent'): void {
    const policy = this.config.challenge.ocrPrewarm ?? 'agent';
    if (policy === false || policy === 'off') return;
    if (reason === 'startup' && policy !== 'startup' && policy !== true) return;
    try {
      const provider = this.capabilities.get(this.config.capabilities.challengeOcr) as unknown as { warm?: () => Promise<void> };
      void provider.warm?.();
    } catch { /* a missing provider is reported when it is used */ }
  }

  list(): ChallengeJob[] { return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id: string): ChallengeJob { const job = this.jobs.get(id); if (!job) throw new Error(`Unknown challenge job: ${id}`); return job; }

  async command(action: 'list' | 'status' | 'ai_failed' | 'ai_resolved' | 'human_start' | 'human_complete' | 'cancel', id?: string, detail?: string): Promise<unknown> {
    if (action === 'list') return this.list();
    const job = this.get(id ?? '');
    if (action === 'status') return job;
    if (action === 'ai_failed') {
      job.aiAttempts += 1;
      if (job.aiAttempts >= this.config.challenge.maxAiAttempts) this.transition(job, 'human_required', detail || 'AI recovery budget exhausted');
      else this.transition(job, 'ai_recovery_required', detail || 'AI recovery attempt failed');
      return job;
    }
    if (action === 'ai_resolved') { this.transition(job, 'resolved_unverified', detail || 'AI reported challenge resolved; business result still requires verification'); return job; }
    if (action === 'human_start') { this.transition(job, 'human_takeover', detail || 'Automation paused for human takeover'); return job; }
    if (action === 'human_complete') {
      const page = await this.runtime.getPage(job.pageId);
      if (new URL(page.url()).origin !== job.origin) { this.transition(job, 'failed', 'Origin changed during takeover; checkpoint invalidated'); throw new Error('Origin changed; checkpoint invalidated'); }
      this.transition(job, 'resolved_unverified', detail || 'Human completed challenge; verify the business result before continuing');
      return job;
    }
    this.transition(job, 'cancelled', detail || 'Cancelled');
    return job;
  }

  private async runOcr(job: ChallengeJob): Promise<ChallengeJob> {
    job.ocrAttempts += 1;
    this.transition(job, 'ocr_running', 'Local ddddocr attempt started');
    try {
      const page = await this.runtime.getPage(job.pageId);
      const image = page.locator('[data-agent-challenge-image]').first();
      const input = page.locator('[data-agent-challenge-input]').first();
      if (!await image.count() || !await input.count()) return this.requireAi(job, 'Challenge elements changed before OCR');
      const bytes = await image.screenshot({ type: 'png' });
      const frames = await this.sampleIfAnimated(page, image, bytes);
      const provider = this.vision();
      const result = frames.length > 1 && provider
        ? await provider.vision('classify_frames', { frames: frames.map(b64) })
        : await this.capabilities.invoke<Buffer, { text: string }>(this.config.capabilities.challengeOcr, bytes);
      if (frames.length > 1) this.observed(job, { frames: frames.length, keyframes: (result as { keyframes?: number }).keyframes, method: provider ? 'merged-frames' : 'first-frame' });
      const answer = result.text.replace(/\s+/g, '').trim();
      if (!answer) return this.requireAi(job, 'OCR returned an empty answer');
      await input.fill(answer);
      this.runtime.audit.record({ pageId: job.pageId, action: 'challenge.ocr_filled', status: 'info', detail: { jobId: job.id, answerLength: answer.length }, capabilities: [this.capabilities.get(this.config.capabilities.challengeOcr).manifest] });
      if (!this.config.challenge.autoSubmit) return this.requireAi(job, 'OCR answer filled; automatic submit disabled');
      const submit = page.locator('[data-agent-challenge-submit]').first();
      if (await submit.count()) await submit.click();
      else await input.press('Enter');
      await page.waitForTimeout(this.config.browser.settleMs);
      const remaining = await this.detectSafely(page);
      if (!remaining) {
        this.transition(job, 'resolved_unverified', 'Challenge disappeared after OCR; verify the business result');
      } else {
        this.requireAi(job, 'Challenge remains after the single OCR attempt');
      }
      return job;
    } catch (error) {
      return this.requireAi(job, `OCR unavailable or failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private vision(): ChallengeVision | undefined {
    const provider = this.capabilities.get(this.config.capabilities.challengeOcr);
    return hasVision(provider) ? provider : undefined;
  }

  private pointer(): PointerActor { return this.capabilities.get(this.config.capabilities.pointer) as unknown as PointerActor; }

  /** Records what the input layer showed ddddocr (frame counts, method, regions), never the answer. */
  private observed(job: ChallengeJob, detail: Record<string, unknown>): void {
    this.runtime.audit.record({ pageId: job.pageId, action: 'challenge.input', status: 'info', detail: { jobId: job.id, kind: job.kind, ...detail } });
  }

  /** A text image that changes over time (blinking or one character at a time): frames over the sample window. */
  private async sampleIfAnimated(page: Page, image: ReturnType<Page['locator']>, first: Buffer): Promise<Buffer[]> {
    await page.waitForTimeout(150);
    const second = await image.screenshot({ type: 'png' }).catch(() => first);
    if (second.equals(first)) return [first];
    const frames = [first, second];
    const until = Date.now() + this.sampleMs() / 2;
    while (Date.now() < until && frames.length < 40) {
      await page.waitForTimeout(this.config.challenge.frameIntervalMs ?? 100);
      frames.push(await image.screenshot({ type: 'png' }));
    }
    return frames;
  }

  private sampleMs(): number { return this.config.challenge.sampleMs ?? 4000; }

  private async runLocal(job: ChallengeJob, solve: () => Promise<string | null>): Promise<ChallengeJob> {
    if (!this.config.challenge.autoSubmit) return this.requireAi(job, 'Automatic solving disabled');
    const provider = this.vision();
    if (!provider) return this.requireAi(job, `The ${this.config.capabilities.challengeOcr} provider reads text only`);
    job.ocrAttempts += 1;
    void provider.vision('prepare', { kind: job.kind }).catch(() => undefined);
    this.transition(job, 'ocr_running', `Local ddddocr ${job.kind === 'slider' ? 'slider' : 'ordered-click'} attempt started`);
    const page = await this.runtime.getPage(job.pageId);
    try {
      const failure = await solve();
      if (failure) return this.requireAi(job, failure);
      await page.waitForTimeout(Math.max(this.config.browser.settleMs, 600));
      const remaining = await this.detectSafely(page);
      if (!remaining) this.transition(job, 'resolved_unverified', `Challenge disappeared after OCR ${job.kind === 'slider' ? 'slider drag' : 'ordered clicks'}; verify the business result`);
      else this.requireAi(job, `Challenge remains after the local ${job.kind === 'slider' ? 'slider' : 'ordered-click'} attempt`);
      return job;
    } catch (error) {
      await page.mouse.up().catch(() => undefined);
      return this.requireAi(job, `Local ${job.kind} attempt failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async box(page: Page, name: string): Promise<Box | null> {
    const locator = page.locator(mark(name)).first();
    if (!await locator.count()) return null;
    const box = await locator.boundingBox();
    return box && box.width > 2 && box.height > 2 ? box : null;
  }

  private async shot(page: Page, clip: Box): Promise<Buffer> { return await page.screenshot({ type: 'png', clip }); }

  /**
   * Slider puzzles. Many show the gap (and often the piece) only while the pointer is on the handle or holding it,
   * so one screenshot of the idle widget has nothing to match. The handle is approached and held the way a person
   * does it, frames are taken before and while holding, and what the press revealed locates the piece and the gap.
   */
  private async solveSlider(job: ChallengeJob): Promise<string | null> {
    const page = await this.runtime.getPage(job.pageId);
    const vision = this.vision()!;
    const pointer = this.pointer();
    await page.locator(mark('handle')).first().scrollIntoViewIfNeeded().catch(() => undefined);
    const handle = await this.box(page, 'handle');
    if (!handle) return 'Slider handle disappeared';
    const idleBg = await this.box(page, 'bg');
    const idleFrame = idleBg ? await this.shot(page, idleBg) : null;
    const grip = { x: handle.x + handle.width * (0.35 + Math.random() * 0.3), y: handle.y + handle.height * (0.35 + Math.random() * 0.3) };
    await pointer.move({ page, x: grip.x, y: grip.y }, 'click');
    await sleep(page, 220, 420);
    await this.markSlider(page);
    const bg = await this.box(page, 'bg');
    if (!bg) return 'No slider image appeared on hover';
    const hoverFrame = await this.shot(page, bg);
    await page.mouse.down();
    await sleep(page, 260, 420);
    const scale = bg.width / pngWidth(hoverFrame);
    const plausible = (r: Region) => r.h > bg.height / scale * 0.12 && r.h < bg.height / scale * 0.9 && r.w > bg.width / scale * 0.06 && r.w < bg.width / scale * 0.45;
    // Keep holding and looking for up to three rounds: some widgets draw the gap a moment after the press.
    let held: Buffer[] = [], found: Array<Region & { area: number }> = [], regions: Region[] = [], rounds = 0;
    while (rounds < 3 && !regions.length) {
      if (rounds++) await page.waitForTimeout(250);
      held = [];
      for (let i = 0; i < 3; i++) { held.push(await this.shot(page, bg)); await page.waitForTimeout(90); }
      found = (await vision.vision('reveal', { before: b64(hoverFrame), frames: held.map(b64) })).regions;
      regions = found.filter(plausible);
    }
    let revealedBy = 'press';
    if (!regions.length && idleFrame && idleBg && idleBg.width === bg.width && idleBg.height === bg.height) {
      found = (await vision.vision('reveal', { before: b64(idleFrame), frames: held.map(b64) })).regions;
      regions = found.filter(plausible);
      revealedBy = 'hover';
    }
    const pieceBox = await this.box(page, 'piece');
    let pieceX: number | undefined, gapX: number | undefined;
    if (regions.length >= 2) {
      const sorted = [...regions].sort((a, b) => a.x - b.x);
      const piece = sorted[0];
      const gap = sorted.slice(1).sort((a, b) => Math.abs(a.w - piece.w) + Math.abs(a.h - piece.h) - (Math.abs(b.w - piece.w) + Math.abs(b.h - piece.h)))[0];
      pieceX = piece.x * scale; gapX = gap.x * scale;
    } else if (regions.length === 1) {
      gapX = regions[0].x * scale;
      pieceX = pieceBox ? pieceBox.x - bg.x : Math.max(0, handle.x - bg.x);
    } else if (pieceBox) {
      revealedBy = 'none';
      const piece = await page.locator(mark('piece')).first().screenshot({ type: 'png' });
      const background = await this.shot(page, bg);
      const target = (await vision.vision('slide_match', { piece: b64(piece), background: b64(background) })).target;
      if (target?.length) { gapX = target[0] * scale; pieceX = pieceBox.x - bg.x; }
    }
    this.observed(job, { frames: rounds * held.length + 1 + (idleFrame ? 1 : 0), rounds, revealedBy, regions: regions.length, changed: found.map(r => `${r.w}x${r.h}`), piece: pieceBox ? 'element' : 'drawn' });
    if (pieceX === undefined || gapX === undefined) { await release(page); return 'Could not locate the slider gap, before or while holding the handle'; }
    let at = await dragTo(page, grip, { x: grip.x + (gapX - pieceX), y: grip.y });
    if (pieceBox) {
      // The piece is an element: read where it actually went and correct, in case handle and piece move at different rates.
      const now = await this.box(page, 'piece');
      const off = now ? gapX - (now.x - bg.x) : 0;
      if (Math.abs(off) > 1.5 && Math.abs(off) < bg.width / 3) at = await nudge(page, at, off);
    }
    await release(page);
    pointer.place?.(page, at);
    return null;
  }

  /** After hover or press the widget may have rendered its image; mark it again. */
  private async markSlider(page: Page): Promise<void> {
    await page.evaluate(`(() => {
      const handle = document.querySelector('[data-agent-challenge-handle]');
      if (!handle) return;
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
      let box = handle.parentElement;
      for (let i = 0; box && i < 6; i++, box = box.parentElement) {
        const pics = [...box.querySelectorAll('img,canvas')].filter(visible).map(el => ({ el, r: el.getBoundingClientRect() })).filter(p => p.r.width >= 120 && p.r.height >= 50);
        if (!pics.length) continue;
        pics.sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
        document.querySelectorAll('[data-agent-challenge-bg],[data-agent-challenge-piece]').forEach(el => { el.removeAttribute('data-agent-challenge-bg'); el.removeAttribute('data-agent-challenge-piece'); });
        const bg = pics[0];
        bg.el.setAttribute('data-agent-challenge-bg', '1');
        const piece = [...box.querySelectorAll('img,canvas')].filter(el => el !== bg.el && visible(el)).map(el => ({ el, r: el.getBoundingClientRect() }))
          .find(p => p.r.width < bg.r.width * 0.45 && p.r.height < bg.r.height && p.r.top < bg.r.bottom && p.r.bottom > bg.r.top && p.r.left >= bg.r.left - 4);
        if (piece) piece.el.setAttribute('data-agent-challenge-piece', '1');
        return;
      }
    })()`);
  }

  /**
   * "Click these in order" challenges. The prompt may be DOM text, a still image, or play its items one after
   * another; frames over the sample window keep that order. ddddocr's detector finds the candidates in the image,
   * each is read (or compared by shape for icons) and the matches are clicked in prompt order.
   */
  private async solveClicks(job: ChallengeJob, detection: Detection): Promise<string | null> {
    const page = await this.runtime.getPage(job.pageId);
    const vision = this.vision()!;
    await page.locator(mark('canvas')).first().scrollIntoViewIfNeeded().catch(() => undefined);
    const canvas = await this.box(page, 'canvas');
    if (!canvas) return 'Click challenge image disappeared';
    const prompt = await this.box(page, 'prompt');
    const area = [canvas, ...(prompt ? [prompt] : [])];
    const left = Math.max(0, Math.min(...area.map(b => b.x))), top = Math.max(0, Math.min(...area.map(b => b.y)));
    const clip = { x: left, y: top, width: Math.max(...area.map(b => b.x + b.width)) - left, height: Math.max(...area.map(b => b.y + b.height)) - top };
    const frames: Buffer[] = [], times: number[] = [];
    const start = Date.now();
    const interval = this.config.challenge.frameIntervalMs ?? 100;
    // Sample until the window ends. A widget unchanged for 1.5 s (longer than the pause most prompts take between
    // rounds) is treated as still.
    while (Date.now() - start < this.sampleMs() && frames.length < 60) {
      frames.push(await this.shot(page, clip)); times.push(Date.now() - start);
      if (Date.now() - start > 1500 && frames.every(f => f.equals(frames[0]))) break;
      await page.waitForTimeout(interval);
    }
    const scale = clip.width / pngWidth(frames[0]);
    const rel = (b: Box): Region => ({ x: Math.round((b.x - clip.x) / scale), y: Math.round((b.y - clip.y) / scale), w: Math.round(b.width / scale), h: Math.round(b.height / scale) });
    const unique = frames.filter((f, i) => !i || !f.equals(frames[i - 1]));
    const kept = frames.map((f, i) => ({ f, t: times[i] })).filter((_, i) => !i || !frames[i].equals(frames[i - 1]) || i === frames.length - 1);
    // The instruction itself ("please click in order:") sits in the prompt area; its characters are not targets.
    const said = await page.evaluate(`(() => {
      const prompt = document.querySelector('[data-agent-challenge-prompt]');
      if (!prompt) return null;
      const walker = document.createTreeWalker(prompt, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) if ((walker.currentNode.textContent || '').trim()) {
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        const r = range.getBoundingClientRect(); if (r.width > 2) return { x: r.x, y: r.y, width: r.width, height: r.height };
      }
      return null;
    })()`) as Box | null;
    const plan = await vision.vision('click_plan', { frames: kept.map(k => b64(k.f)), times: kept.map(k => k.t), canvas: rel(canvas), prompt: prompt ? rel(prompt) : undefined, exclude: said ? rel(said) : undefined, tokens: detection.tokens });
    this.observed(job, { frames: frames.length, keyframes: unique.length, method: plan.method, items: plan.items, textMatched: plan.textMatched, candidates: plan.candidates, cycled: plan.cycled });
    if (!plan.points.length) return `Ordered-click plan failed: ${plan.reason ?? 'no targets'}`;
    const pointer = this.pointer();
    for (const point of plan.points) {
      await sleep(page, 280, 720);
      await pointer.invoke({ page, x: clip.x + point.x * scale + (Math.random() - 0.5) * 4, y: clip.y + point.y * scale + (Math.random() - 0.5) * 4 });
    }
    const confirm = await this.box(page, 'confirm');
    if (confirm) {
      await sleep(page, 350, 700);
      await pointer.invoke({ page, x: confirm.x + confirm.width * (0.3 + Math.random() * 0.4), y: confirm.y + confirm.height * (0.3 + Math.random() * 0.4) });
    }
    return null;
  }

  private requireAi(job: ChallengeJob, detail: string): ChallengeJob {
    if (job.aiAttempts >= this.config.challenge.maxAiAttempts) this.transition(job, 'human_required', detail);
    else this.transition(job, 'ai_recovery_required', detail);
    return job;
  }

  private transition(job: ChallengeJob, status: ChallengeJob['status'], detail: string): void {
    job.status = status;
    job.detail = detail;
    job.updatedAt = new Date().toISOString();
    this.runtime.audit.record({ pageId: job.pageId, action: `challenge.${status}`, status: status === 'failed' ? 'failure' : 'info', detail: { jobId: job.id, reason: detail, ocrAttempts: job.ocrAttempts, aiAttempts: job.aiAttempts } });
  }

  private activeForPage(pageId: number): ChallengeJob | undefined {
    const id = this.byPage.get(pageId);
    return id ? this.jobs.get(id) : undefined;
  }

  private assertAutomationAllowed(pageId: number): void {
    const job = this.activeForPage(pageId);
    if (job && ['human_required', 'human_takeover'].includes(job.status)) {
      this.runtime.audit.record({ pageId, action: 'challenge.automation_blocked', status: 'failure', detail: { jobId: job.id, state: job.status } });
      throw new Error(`Page is paused for human challenge recovery (job ${job.id}); automated reads/actions are blocked`);
    }
  }

  private async detectSafely(page: Page): Promise<Detection | null> {
    try { return await this.detect(page); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!/Execution context was destroyed|Target closed|navigation/i.test(detail)) throw error;
      if (page.isClosed()) return null;
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
      try { return await this.detect(page); }
      catch (retryError) {
        this.runtime.audit.record({ action: 'challenge.detection_deferred', status: 'info', detail: { reason: retryError instanceof Error ? retryError.message.slice(0, 200) : String(retryError).slice(0, 200) } });
        return null;
      }
    }
  }

  private async detect(page: Page): Promise<Detection | null> {
    return (await page.evaluate(`(() => {
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
      const area = el => { const r = el.getBoundingClientRect(); return r.width * r.height; };
      const marks = ${JSON.stringify(MARKS.map(m => 'data-agent-challenge-' + m))};
      document.querySelectorAll(marks.map(m => '[' + m + ']').join(',')).forEach(el => marks.forEach(m => el.removeAttribute(m)));
      const text = (document.body?.innerText || '').slice(0, 50000);
      const signal = /captcha|\\u4eba\\u673a\\u9a8c\\u8bc1|\\u5b89\\u5168\\u9a8c\\u8bc1|\\u9a8c\\u8bc1\\u7801|\\u5b8c\\u6210\\u9a8c\\u8bc1|verify you are human|security check/i.test(text);
      // Dragging and clicking are only done inside something that is plainly a challenge widget.
      const widget = el => { for (let n = el, i = 0; n && i < 10; n = n.parentElement, i++) if (/captcha|verif|geetest|yidun|tcaptcha|nc[-_]|puzzle|\\u9a8c\\u8bc1/i.test((n.id || '') + ' ' + (typeof n.className === 'string' ? n.className : '') + ' ' + (n.getAttribute('aria-label') || ''))) return true; return false; };
      const knownFrame = document.querySelector('iframe[src*="captcha"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="turnstile"]');
      const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]),textarea')).filter(el => {
        const formText = el.closest('form')?.textContent || '';
        return /captcha|\\u9a8c\\u8bc1\\u7801/i.test([el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('placeholder'), formText].join(' '));
      });
      const images = Array.from(document.images).filter(img => {
        const formText = img.closest('form')?.textContent || '';
        return /captcha|\\u9a8c\\u8bc1\\u7801|verify/i.test([img.src, img.alt, img.id, img.className, formText].join(' '));
      });
      if (inputs[0]) inputs[0].setAttribute('data-agent-challenge-input', '1');
      if (images[0]) images[0].setAttribute('data-agent-challenge-image', '1');
      const container = inputs[0]?.closest('form') || images[0]?.closest('form') || inputs[0]?.parentElement;
      const submit = container?.querySelector('button[type="submit"],input[type="submit"],button:not([type])');
      if (submit) submit.setAttribute('data-agent-challenge-submit', '1');
      if (inputs.length && images.length) return { kind: 'text_image', hasImage: true, hasInput: true, hasSubmit: !!submit, detail: 'Generic text/image challenge detected' };
      // Slider: a small grip inside a widget that says to drag; its image may only render on hover or press.
      if (/\u62d6\u52a8|\u6ed1\u52a8|\u5411\u53f3\u6ed1|\u62fc\u56fe|slide to|drag the|slide the|slide right/i.test(text)) {
        const grips = Array.from(document.querySelectorAll('[class*="slid" i],[class*="drag" i],[class*="handle" i],[class*="knob" i],[class*="thumb" i],[id*="slid" i],[id*="drag" i],[role="slider"]'))
          .filter(el => { const r = el.getBoundingClientRect(); return (signal || widget(el)) && visible(el) && r.width >= 16 && r.width <= 100 && r.height >= 16 && r.height <= 100; })
          .sort((a, b) => (/grab|move|pointer/.test(getComputedStyle(b).cursor) - /grab|move|pointer/.test(getComputedStyle(a).cursor)) || area(a) - area(b));
        if (grips[0]) {
          grips[0].setAttribute('data-agent-challenge-handle', '1');
          let box = grips[0].parentElement;
          for (let i = 0; box && i < 6; i++, box = box.parentElement) {
            const pics = Array.from(box.querySelectorAll('img,canvas')).filter(el => visible(el) && el.getBoundingClientRect().width >= 120 && el.getBoundingClientRect().height >= 50).sort((a, b) => area(b) - area(a));
            if (pics[0]) { pics[0].setAttribute('data-agent-challenge-bg', '1'); break; }
          }
          return { kind: 'slider', hasImage: !!document.querySelector('[data-agent-challenge-bg]'), hasInput: false, hasSubmit: false, detail: 'Slider challenge detected' };
        }
      }
      // Ordered clicks: an instruction such as "please click in order" next to a large image.
      const order = /\u4f9d\u6b21\u70b9\u51fb|\u6309\u987a\u5e8f\u70b9\u51fb|\u987a\u5e8f\u70b9\u51fb|click (on )?(the )?.{0,40}in (this |the following )?order|in the order shown/i;
      if (order.test(text)) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let hint = null;
        while (walker.nextNode()) if (order.test(walker.currentNode.textContent || '') && walker.currentNode.parentElement && visible(walker.currentNode.parentElement)) { hint = walker.currentNode.parentElement; break; }
        let box = hint, canvas = null;
        for (let i = 0; box && i < 6; i++, box = box.parentElement) {
          canvas = Array.from(box.querySelectorAll('img,canvas')).filter(el => visible(el) && el.getBoundingClientRect().width >= 150 && el.getBoundingClientRect().height >= 100).sort((a, b) => area(b) - area(a))[0] || null;
          if (canvas) break;
        }
        if (hint && canvas && (signal || widget(hint))) {
          canvas.setAttribute('data-agent-challenge-canvas', '1');
          let prompt = hint;
          while (prompt.parentElement && !prompt.parentElement.contains(canvas) && prompt.parentElement.getBoundingClientRect().height <= 90) prompt = prompt.parentElement;
          prompt.setAttribute('data-agent-challenge-prompt', '1');
          const full = prompt.innerText || '', hit = full.match(order);
          const said = hit ? full.slice((hit.index || 0) + hit[0].length) : '';
          const quoted = [...said.matchAll(/[\u3010\u300c\u201c"'\u300e]([^\u3011\u300d\u201d"'\u300f]{1,4})[\u3011\u300d\u201d"'\u300f]/g)].map(m => m[1]);
          const words = said.replace(/^[\\s:\uff1a,\uff0c]+/, '').split(/[\\s,\uff0c\u3001]+/).filter(Boolean);
          let tokens = quoted.length ? quoted : words.length > 1 ? words : words[0] && /^[\u4e00-\u9fff]{2,6}$/.test(words[0]) ? [...words[0]] : [];
          if (tokens.length > 6 || tokens.some(t => t.length > 4)) tokens = [];
          const confirm = Array.from(box ? box.querySelectorAll('button,[role="button"],a,div,span') : []).find(el => visible(el) && el.children.length === 0 && /^\\s*(\u786e\u5b9a|\u786e\u8ba4|\u63d0\u4ea4|\u9a8c\u8bc1|submit|confirm|verify|done|ok)\\s*$/i.test(el.textContent || ''));
          if (confirm) confirm.setAttribute('data-agent-challenge-confirm', '1');
          return { kind: 'click_sequence', hasImage: true, hasInput: false, hasSubmit: !!confirm, detail: 'Ordered-click challenge detected', tokens };
        }
      }
      if (signal || knownFrame) return { kind: 'interactive', hasImage: !!images.length, hasInput: !!inputs.length, hasSubmit: !!submit, detail: 'Interactive or unrecognized challenge signal detected' };
      return null;
    })()`)) as Detection | null;
  }
}


