import type { CapabilityProvider } from './CapabilityRegistry.js';

/** The swappable steps of the automation layer. Plugins can add providers to any of them. */
export const CAPABILITY_SLOTS = ['pointer', 'keyboard', 'ocr', 'clipboard'] as const;
export type CapabilitySlot = typeof CAPABILITY_SLOTS[number];

/** Slot membership is decided by shape, so plugins need no registration flag. */
export function fitsSlot(slot: CapabilitySlot, provider: CapabilityProvider<any, any>): boolean {
  const value = provider as unknown as Record<string, unknown>;
  if (slot === 'pointer') return typeof value.move === 'function' && typeof value.invoke === 'function';
  if (slot === 'keyboard') return provider.manifest.kind === 'action' && typeof value.type === 'function';
  if (slot === 'clipboard') return typeof value.read === 'function' && typeof value.write === 'function' && typeof value.invoke === 'function';
  return provider.manifest.kind === 'challenge' && typeof value.invoke === 'function';
}
