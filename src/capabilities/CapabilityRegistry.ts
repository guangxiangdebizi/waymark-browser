export interface CapabilityManifest {
  id: string;
  version: string;
  kind: 'perception' | 'action' | 'challenge' | 'security' | 'recovery' | 'audit';
  runtime: 'node' | 'python' | 'external-process';
  dataEgress: 'local-only' | 'remote';
  description: string;
}

export interface CapabilityProvider<I = unknown, O = unknown> {
  manifest: CapabilityManifest;
  invoke(input: I): Promise<O>;
  health?(): Promise<{ ok: boolean; detail?: string }>;
  close?(): Promise<void>;
}

export class CapabilityRegistry {
  private providers = new Map<string, CapabilityProvider<any, any>>();
  register(provider: CapabilityProvider<any, any>): void {
    if (this.providers.has(provider.manifest.id)) throw new Error(`Duplicate capability: ${provider.manifest.id}`);
    this.providers.set(provider.manifest.id, provider);
  }
  get<I, O>(id: string): CapabilityProvider<I, O> {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Capability not registered: ${id}`);
    return provider;
  }
  async invoke<I, O>(id: string, input: I): Promise<O> { return this.get<I, O>(id).invoke(input); }
  async close(): Promise<void> { for (const provider of this.providers.values()) await provider.close?.(); }
  list(): CapabilityManifest[] { return [...this.providers.values()].map(p => p.manifest); }
}
