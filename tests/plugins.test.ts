import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry } from '../src/capabilities/CapabilityRegistry.js';
import { InputActor } from '../src/browser/InputActor.js';
import { loadPlugins, TrajectoryPointer } from '../src/capabilities/plugins.js';
import { fitsSlot } from '../src/capabilities/slots.js';
import { createLocalCapabilities } from '../src/capabilities/local.js';
import type { AppConfig } from '../src/types.js';

/** Records pointer events instead of driving a browser. */
function fakePage() {
  const moves: Array<[number, number]> = [];
  const clicks: Array<{ x: number; y: number; delay?: number }> = [];
  const page = {
    mouse: {
      move: async (x: number, y: number) => { moves.push([x, y]); },
      click: async (x: number, y: number, options?: { delay?: number }) => { clicks.push({ x, y, delay: options?.delay }); }
    },
    waitForTimeout: async () => undefined,
    viewportSize: () => ({ width: 1280, height: 800 })
  };
  return { page: page as any, moves, clicks };
}

const builtin = new InputActor({ minSteps: 2, maxSteps: 3, minDelayMs: 0, maxDelayMs: 0 });
const python = process.platform === 'win32' ? 'python' : 'python3';
const config = (plugins: AppConfig['capabilities']['plugins']) => ({ capabilities: { pointer: 'action.pointer.bezier', challengeOcr: '', clipboard: '', plugins } }) as AppConfig;

test('JS trajectory plugin is loaded, registered and drives clicks through its own path', async () => {
  const registry = new CapabilityRegistry();
  const loaded = await loadPlugins(config([{ module: './examples/plugins/pointer-minimum-jerk.mjs' }]), registry, builtin);
  assert.deepEqual(loaded, ['action.pointer.minimum-jerk']);
  const pointer = registry.get('action.pointer.minimum-jerk') as unknown as TrajectoryPointer;
  const { page, moves, clicks } = fakePage();
  await pointer.invoke({ page, x: 600, y: 400 });
  assert.ok(moves.length >= 8, `expected a multi-sample path, got ${moves.length}`);
  assert.deepEqual(moves.at(-1), [600, 400]);
  assert.equal(clicks.length, 1);
  assert.ok(clicks[0].delay! >= 55 && clicks[0].delay! <= 120);
});

test('external-process (Python) trajectory plugin speaks JSON lines', async () => {
  const registry = new CapabilityRegistry();
  await loadPlugins(config([{ id: 'action.pointer.windmouse', command: [python, 'examples/plugins/pointer_model.py'], timeoutMs: 5000 }]), registry, builtin);
  const pointer = registry.get('action.pointer.windmouse') as unknown as TrajectoryPointer;
  const { page, moves } = fakePage();
  try {
    await pointer.move({ page, x: 300, y: 200 });
    assert.ok(moves.length > 5);
    assert.deepEqual(moves.at(-1), [300, 200]);
    assert.equal(pointer.manifest.runtime, 'external-process');
  } finally { await registry.close(); }
});

test('a failing model falls back to the built-in path instead of failing the action', async () => {
  const broken = new TrajectoryPointer({ manifest: { id: 'action.pointer.broken' }, trajectory: () => [{ x: Number.NaN, y: 1 }] }, builtin);
  const { page, moves } = fakePage();
  const warn = console.warn;
  console.warn = () => undefined;
  try { await broken.move({ page, x: 50, y: 60 }); } finally { console.warn = warn; }
  assert.deepEqual(moves.at(-1), [50, 60]);
});

test('bad plugin modules are reported and skipped', async () => {
  const registry = new CapabilityRegistry();
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => { warnings.push(message); };
  try { assert.deepEqual(await loadPlugins(config([{ module: './examples/plugins/does-not-exist.mjs' }]), registry, builtin), []); }
  finally { console.warn = warn; }
  assert.match(warnings[0], /not loaded/);
});

test('external OCR solver fills the ocr slot with the same contract as ddddocr', async () => {
  const registry = new CapabilityRegistry();
  await loadPlugins(config([{ id: 'challenge.ocr.fake', kind: 'ocr', command: [python, 'tests/fixtures/fake_ocr.py'] }]), registry, builtin);
  try {
    const solver = registry.get('challenge.ocr.fake');
    assert.equal(fitsSlot('ocr', solver), true);
    assert.equal(fitsSlot('pointer', solver), false);
    assert.deepEqual(await registry.invoke('challenge.ocr.fake', Buffer.from('12345')), { text: 'LEN5' });
  } finally { await registry.close(); }
});

test('built-in providers land in the right slots', () => {
  const registry = createLocalCapabilities({ browser: { mouse: { minSteps: 1, maxSteps: 1, minDelayMs: 0, maxDelayMs: 0 }, systemPasteSettleMs: 0 }, challenge: { pythonCommand: 'python', pythonFallback: 'python', timeoutMs: 1, maxImageBytes: 1 } } as any);
  const slotOf = (id: string) => (['pointer', 'ocr', 'clipboard'] as const).filter(slot => fitsSlot(slot, registry.get(id)));
  assert.deepEqual(slotOf('action.pointer.bezier'), ['pointer']);
  assert.deepEqual(slotOf('challenge.ocr.ddddocr'), ['ocr']);
  assert.deepEqual(slotOf('action.clipboard.virtual'), ['clipboard']);
  assert.deepEqual(slotOf('action.clipboard.system'), ['clipboard']);
});
