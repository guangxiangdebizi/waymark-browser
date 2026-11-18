import type { AppConfig } from '../types.js';
import { CapabilityRegistry } from './CapabilityRegistry.js';
import { InputActor } from '../browser/InputActor.js';
import { FastKeyboard, HumanKeyboard } from '../browser/HumanKeyboard.js';
import { DdddOcrWorker } from '../challenge/DdddOcrWorker.js';
import { ClipboardProvider } from './ClipboardProvider.js';
import { SystemClipboardProvider } from './SystemClipboardProvider.js';
import { loadPlugins } from './plugins.js';

export function createLocalCapabilities(config: AppConfig): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register(new InputActor(config.browser.mouse));
  registry.register(new HumanKeyboard(config.browser.typing));
  registry.register(new FastKeyboard());
  registry.register(new DdddOcrWorker(config.challenge));
  registry.register(new ClipboardProvider());
  registry.register(new SystemClipboardProvider(config.browser.systemPasteSettleMs));
  return registry;
}

/** Built-in capabilities plus the plugins listed in `capabilities.plugins`. */
export async function createCapabilities(config: AppConfig): Promise<CapabilityRegistry> {
  const registry = createLocalCapabilities(config);
  const builtin = registry.get('action.pointer.bezier') as unknown as InputActor;
  await loadPlugins(config, registry, builtin);
  const defaults = { pointer: 'action.pointer.bezier', keyboard: 'action.keyboard.human', challengeOcr: 'challenge.ocr.ddddocr', clipboard: 'action.clipboard.virtual' } as const;
  for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
    if (config.capabilities[key] === undefined) { config.capabilities[key] = defaults[key]; continue; }
    if (!registry.list().some(item => item.id === config.capabilities[key])) {
      console.warn(`[waymark] ${key} provider ${config.capabilities[key]} is not registered; using ${defaults[key]}`);
      config.capabilities[key] = defaults[key];
    }
  }
  return registry;
}
