import type { PluginEntry } from './capabilities/plugins.js';

export interface AppConfig {
  uiLanguage?: string;
  settingsFile: string;
  server: { host: string; port: number };
  browser: {
    executablePath: string;
    userDataDir: string;
    headless: boolean;
    settleMs: number;
    readLimit: number;
    systemPasteSettleMs: number;
    automationViewport?: { width: number; height: number };
    /** Idle behaviour while the agent thinks; what it does is the `idle` slot. `protectedSites` are never left. */
    ambientMouse: { enabled: boolean; minPauseMs: number; maxPauseMs: number; marginPx: number; protectedSites?: string[] };
    /** Overrides for the human pacing model (see DEFAULT_PACING). */
    pacing?: Partial<import('./browser/Pacing.js').PacingOptions>;
    mouse: { minSteps: number; maxSteps: number; minDelayMs: number; maxDelayMs: number };
    /** Overrides for the human keyboard's timing model (see DEFAULT_TYPING). */
    typing?: Partial<import('./browser/HumanKeyboard.js').TypingOptions>;
    /** Per-step timeout for locating and acting on an element (default 5000 ms). */
    actionTimeoutMs?: number;
  };
  capabilities: { pointer: string; keyboard?: string; pacing?: string; idle?: string; challengeOcr: string; clipboard: string; plugins?: PluginEntry[] };
  audit: { directory: string; captureScreenshots: boolean };
  /** Start-page shortcuts; override per machine in the local settings file. */
  home?: { quickLinks?: Array<{ name: string; url: string; color?: string; icon?: string }> };
  challenge: {
    pythonCommand: string;
    pythonFallback: string;
    timeoutMs: number;
    maxImageBytes: number;
    maxOcrAttempts: number;
    maxAiAttempts: number;
    autoSubmit: boolean;
  };
}

export interface PageSummary { id: number; url: string; title: string; active: boolean }
export interface RefInfo { ref: string; role: string; name: string; snapshotId: string; line?: string }
export interface SnapshotResult {
  id: string;
  pageId: number;
  url: string;
  title: string;
  text: string;
  hash: string;
  refs: Record<string, RefInfo>;
}

export type ChallengeStatus =
  | 'detected' | 'ocr_running' | 'ai_recovery_required' | 'human_required'
  | 'human_takeover' | 'resolved_unverified' | 'failed' | 'cancelled';

export interface ChallengeJob {
  id: string;
  pageId: number;
  origin: string;
  kind: 'text_image' | 'interactive' | 'unknown';
  status: ChallengeStatus;
  createdAt: string;
  updatedAt: string;
  ocrAttempts: number;
  aiAttempts: number;
  checkpointActionId?: string;
  checkpointUrl: string;
  detail: string;
}

