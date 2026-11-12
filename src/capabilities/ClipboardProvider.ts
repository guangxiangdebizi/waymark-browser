import type { Page } from 'playwright-core';
import type { CapabilityManifest } from '../capabilities/CapabilityRegistry.js';

export interface ClipboardPasteInput { page: Page; text: string }
export interface ClipboardCapability {
  manifest: CapabilityManifest;
  invoke(input: ClipboardPasteInput): Promise<void>;
  read(): string | Promise<string>;
  write(text: string): void | Promise<void>;
  clear(): void | Promise<void>;
}

export class ClipboardProvider {
  readonly manifest: CapabilityManifest = { id: 'action.clipboard.virtual', version: '0.2.0', kind: 'action', runtime: 'node', dataEgress: 'local-only', description: 'Session-local virtual clipboard. It never reads or writes the operating-system clipboard.' };
  private text = '';

  async invoke({ page, text }: ClipboardPasteInput): Promise<void> {
    this.text = text;
    const useDefaultInsertion = await page.evaluate(`(() => {
      const target = document.activeElement;
      if (!target) return true;
      const transfer = new DataTransfer();
      transfer.setData('text/plain', ${JSON.stringify(text)});
      const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
      return target.dispatchEvent(event);
    })()`);
    if (useDefaultInsertion) await page.keyboard.insertText(text);
  }

  read(): string { return this.text; }
  write(text: string): void { this.text = text; }
  clear(): void { this.text = ''; }
}
