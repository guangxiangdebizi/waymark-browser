import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import type { AppConfig, ChallengeJob } from '../types.js';
import { BrowserRuntime } from '../browser/BrowserRuntime.js';
import type { CapabilityRegistry } from '../capabilities/CapabilityRegistry.js';

interface Detection {
  kind: ChallengeJob['kind'];
  hasImage: boolean;
  hasInput: boolean;
  hasSubmit: boolean;
  detail: string;
}

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
    if (detection.kind === 'text_image' && job.ocrAttempts < this.config.challenge.maxOcrAttempts) return this.runOcr(job);
    return this.requireAi(job, 'Challenge type requires AI recovery');
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
      const result = await this.capabilities.invoke<Buffer, { text: string }>(this.config.capabilities.challengeOcr, bytes);
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
      document.querySelectorAll('[data-agent-challenge-image],[data-agent-challenge-input],[data-agent-challenge-submit]')
        .forEach(el => { el.removeAttribute('data-agent-challenge-image'); el.removeAttribute('data-agent-challenge-input'); el.removeAttribute('data-agent-challenge-submit'); });
      const text = (document.body?.innerText || '').slice(0, 50000);
      const signal = /captcha|\\u4eba\\u673a\\u9a8c\\u8bc1|\\u5b89\\u5168\\u9a8c\\u8bc1|\\u9a8c\\u8bc1\\u7801|verify you are human|security check/i.test(text);
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
      if (signal || knownFrame) return { kind: 'interactive', hasImage: !!images.length, hasInput: !!inputs.length, hasSubmit: !!submit, detail: 'Interactive or unrecognized challenge signal detected' };
      return null;
    })()`)) as Detection | null;
  }
}


