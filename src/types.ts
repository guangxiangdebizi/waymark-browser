import type { PluginEntry } from './capabilities/plugins.js';

export interface AppConfig {
  uiLanguage?: string;
  settingsFile: string;
  server: { host: string; port: number };
  browser: {
    executablePath: string;
    userDataDir: string;
    /** Keep session cookies across restarts like a normal browser (default true). */
    persistSessionCookies?: boolean;
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
    /** Memory housekeeping that never costs speed; see docs/memory.md. */
    memory?: { networkServiceInProcess?: boolean };
    /** Per-step timeout for locating and acting on an element (default 5000 ms). */
    actionTimeoutMs?: number;
  };
  capabilities: { pointer: string; keyboard?: string; pacing?: string; idle?: string; challengeOcr: string; clipboard: string; plugins?: PluginEntry[] };
  audit: {
    directory: string;
    /** Save a small JPEG of the page after every navigation and action (local only). */
    captureScreenshots: boolean;
    screenshotQuality?: number;
    /** Screenshots older than this many days are deleted at startup (0 keeps them). */
    screenshotRetentionDays?: number;
    /** Ledger entries older than this many days are removed at startup (0 keeps everything, the default). */
    retentionDays?: number;
    /** Mask credential-like URL query parameters (token, password, sig, ...) in the ledger. Default true. */
    redactUrls?: boolean;
  };
  /** Assumptions behind the dashboard's estimates; every estimate is labelled as such. */
  insights?: Partial<import('./insights/Insights.js').EstimateAssumptions>;
  /** Start-page shortcuts; override per machine in the local settings file. */
  home?: { quickLinks?: Array<{ name: string; url: string; color?: string; icon?: string }> };
  challenge: {
    pythonCommand: string;
    pythonFallback: string;
    /**
     * When the OCR model is loaded ahead of need: 'agent' (default) as soon as any agent talks to Waymark (MCP
     * connect, any tool call, any CLI command); 'startup' also right after launch; 'off' only when a CAPTCHA appears.
     */
    ocrPrewarm?: 'agent' | 'startup' | 'off' | boolean;
    /** Unload the OCR worker after this many minutes without agent activity (default 20, 0 = never). */
    ocrIdleUnloadMinutes?: number;
    timeoutMs: number;
    maxImageBytes: number;
    maxOcrAttempts: number;
    maxAiAttempts: number;
    autoSubmit: boolean;
  };
}

export interface PageSummary { id: number; url: string; title: string; active: boolean; openedBy?: { agent: string; session?: string; window?: string } }
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

