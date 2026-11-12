import clipboard from 'clipboardy';
import type { ClipboardCapability, ClipboardPasteInput } from './ClipboardProvider.js';
import type { CapabilityManifest } from './CapabilityRegistry.js';

export class SystemClipboardProvider implements ClipboardCapability {
  readonly manifest: CapabilityManifest = { id: 'action.clipboard.system', version: '0.1.0', kind: 'action', runtime: 'node', dataEgress: 'local-only', description: 'Opt-in Windows clipboard integration. This mode intentionally shares clipboard state with other applications.' };
  constructor(private settleMs: number) {}
  async invoke({ page, text }: ClipboardPasteInput): Promise<void> {
    await this.write(text);
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(this.settleMs);
    const applied = await page.evaluate(`(() => { const el = document.activeElement; if (!el) return false; if ('value' in el) return String(el.value).endsWith(${JSON.stringify(text)}); return (el.textContent || '').endsWith(${JSON.stringify(text)}); })()`);
    if (!applied) await page.keyboard.insertText(text);
  }
  read(): Promise<string> { return clipboard.read(); }
  async write(text: string): Promise<void> { await clipboard.write(text); }
  async clear(): Promise<void> { await clipboard.write(''); }
}
