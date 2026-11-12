import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry, type CapabilityProvider } from '../src/capabilities/CapabilityRegistry.js';

test('capability registry routes a custom versioned provider and rejects duplicates', async () => {
  const registry = new CapabilityRegistry();
  const provider: CapabilityProvider<number, number> = {
    manifest: { id: 'perception.example.double', version: '1.2.3', kind: 'perception', runtime: 'node', dataEgress: 'local-only', description: 'test provider' },
    invoke: async value => value * 2
  };
  registry.register(provider);
  assert.equal(await registry.invoke<number, number>(provider.manifest.id, 4), 8);
  assert.equal(registry.list()[0].version, '1.2.3');
  assert.throws(() => registry.register(provider), /Duplicate capability/);
  await assert.rejects(() => registry.invoke('missing', null), /not registered/);
});
