import type { AppConfig } from '../types.js';
import type { AuditLog } from './AuditLog.js';

/** Startup housekeeping from config.audit: URL redaction switch, ledger retention and screenshot retention. */
export function applyRetention(audit: AuditLog, config: AppConfig): void {
  audit.redactUrls = config.audit.redactUrls !== false;
  try {
    if (config.audit.retentionDays && config.audit.retentionDays > 0) {
      const result = audit.prune(config.audit.retentionDays, false);
      if (result.removed) console.log(`Waymark: removed ${result.removed} ledger entries older than ${config.audit.retentionDays} days`);
    }
    const screenshotDays = config.audit.screenshotRetentionDays ?? 14;
    if (screenshotDays > 0) audit.pruneScreenshots(screenshotDays);
  } catch (error) { console.warn('Waymark: retention skipped:', error instanceof Error ? error.message : error); }
}
