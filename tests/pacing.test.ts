import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry } from '../src/capabilities/CapabilityRegistry.js';
import { InputActor } from '../src/browser/InputActor.js';
import { HumanPacing, NoPacing, looksLikeCommit } from '../src/browser/Pacing.js';
import { AdaptivePlanner, DriftPlanner } from '../src/browser/IdlePlanners.js';
import type { IdleScene } from '../src/browser/IdleController.js';
import { loadPlugins, PluginIdle, PluginPacing } from '../src/capabilities/plugins.js';
import { fitsSlot } from '../src/capabilities/slots.js';
import type { AppConfig } from '../src/types.js';

const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const context = { kind: 'click', shownLines: 0, commit: false };

test('human pacing waits out a human reaction only when the agent answered faster than a person', () => {
  const pacing = new HumanPacing();
  const instant = median(Array.from({ length: 401 }, () => pacing.delay({ ...context, sinceObservedMs: 0 })));
  assert.ok(instant > 600 && instant < 1200, `median reaction for an instant answer: ${instant}`);
  // An LLM round trip of several seconds already covers it: nothing is added.
  assert.equal(Math.max(...Array.from({ length: 200 }, () => pacing.delay({ ...context, sinceObservedMs: 6000 }))), 0);
  const reading = median(Array.from({ length: 401 }, () => pacing.delay({ ...context, sinceObservedMs: 0, shownLines: 20 })));
  assert.ok(reading > instant + 1200, `20 new lines take longer to read: ${reading} vs ${instant}`);
  const gap = median(Array.from({ length: 401 }, () => pacing.delay({ kind: 'field', sinceObservedMs: 0, shownLines: 0, commit: false, index: 1 })));
  assert.ok(gap > 350 && gap < 750, `pause between fields: ${gap}`);
  assert.equal(new NoPacing().delay(), 0);
});

test('commit steps are recognised by role and name', () => {
  assert.ok(looksLikeCommit('button', 'Submit application'));
  assert.ok(looksLikeCommit('submit', '下一步'));
  assert.equal(looksLikeCommit('text', 'Submit'), false);
  assert.equal(looksLikeCommit('button', 'Show details'), false);
});

const scene = (overrides: Partial<IdleScene> = {}): IdleScene => ({
  viewport: { width: 1200, height: 800 }, pointer: { x: 0, y: 0 }, sinceAgentMs: 3000, scroll: { y: 0, maxY: 2000 },
  allow: { click: true, scroll: true, visit: true }, spots: [{ x: 300, y: 300 }, { x: 600, y: 500 }],
  text: [{ x: 100, y: 100, width: 600, height: 60 }], fresh: [], links: [{ x: 50, y: 700, width: 80, height: 20 }], ...overrides
});

test('the adaptive planner looks at new content first and only plans what the page allows', () => {
  const planner = new AdaptivePlanner();
  const first = planner.plan(scene({ fresh: [{ x: 400, y: 200, width: 200, height: 30 }] }));
  assert.equal(first[0].type, 'move');
  assert.ok(first[0].type === 'move' && first[0].x >= 400 && first[0].x <= 600 && first[0].y >= 200 && first[0].y <= 230);
  const kinds = new Set<string>();
  for (let i = 0; i < 400; i++) for (const step of planner.plan(scene({ allow: { click: false, scroll: false, visit: false } }))) kinds.add(step.type);
  assert.deepEqual([...kinds].sort(), ['move', 'pause']);
  const all = new Set<string>();
  for (let i = 0; i < 2000; i++) for (const step of planner.plan(scene())) all.add(step.type);
  assert.deepEqual([...all].sort(), ['click', 'move', 'pause', 'scroll', 'visit']);
  // An agent that has gone quiet is not thinking: no clicks, scrolls or visits.
  const quiet = new Set<string>();
  for (let i = 0; i < 400; i++) for (const step of planner.plan(scene({ sinceAgentMs: 600000 }))) quiet.add(step.type);
  assert.deepEqual([...quiet], quiet.size ? ['move'] : []);
  assert.deepEqual(new DriftPlanner().plan(scene({ spots: [] })), []);
});

test('pacing and idle plugins load from modules, fit their slots, and fail safe', async () => {
  const registry = new CapabilityRegistry();
  const builtin = new InputActor({ minSteps: 1, maxSteps: 1, minDelayMs: 0, maxDelayMs: 0 });
  const config = { capabilities: { pointer: 'action.pointer.bezier', challengeOcr: '', clipboard: '', plugins: [{ module: './examples/plugins/pacing-fixed.mjs' }, { module: './examples/plugins/idle-reader.mjs' }] } } as AppConfig;
  assert.deepEqual(await loadPlugins(config, registry, builtin), ['action.pacing.fixed', 'idle.reader']);
  const pacing = registry.get('action.pacing.fixed');
  const idle = registry.get('idle.reader');
  assert.ok(fitsSlot('pacing', pacing) && !fitsSlot('idle', pacing));
  assert.ok(fitsSlot('idle', idle) && !fitsSlot('pacing', idle));
  assert.equal(await (pacing as unknown as PluginPacing).delay({ ...context, sinceObservedMs: 0 }), 400);
  assert.ok((await (idle as unknown as PluginIdle).plan(scene())).length > 0);
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(await new PluginPacing({ manifest: { id: 'broken' }, delay: () => { throw new Error('boom'); } }).delay({ ...context, sinceObservedMs: 0 }), 0);
    assert.equal(await new PluginPacing({ manifest: { id: 'huge' }, delay: () => 1e9 }).delay({ ...context, sinceObservedMs: 0 }), 8000);
    assert.deepEqual(await new PluginIdle({ manifest: { id: 'broken' }, plan: () => { throw new Error('boom'); } }).plan(scene()), []);
  } finally { console.warn = warn; }
});
