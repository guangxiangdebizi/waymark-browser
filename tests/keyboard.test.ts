import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { FastKeyboard, HumanKeyboard } from '../src/browser/HumanKeyboard.js';
import { fitsSlot } from '../src/capabilities/slots.js';
import { InputActor } from '../src/browser/InputActor.js';
import { ClipboardProvider } from '../src/capabilities/ClipboardProvider.js';

/** A page stand-in that records key timing and the text a real input would end up holding. */
function recorder() {
  const events: Array<{ type: 'down' | 'up' | 'insert'; key: string; at: number }> = [];
  let text = '';
  const page = {
    keyboard: {
      down: async (key: string) => { events.push({ type: 'down', key, at: performance.now() }); if (key === 'Backspace') text = text.slice(0, -1); else if (key.length === 1) text += key; },
      up: async (key: string) => { events.push({ type: 'up', key, at: performance.now() }); },
      insertText: async (value: string) => { events.push({ type: 'insert', key: value, at: performance.now() }); text += value; },
      type: async (value: string) => { text += value; }
    }
  } as unknown as Page;
  return { page, events, text: () => text };
}

test('human keyboard holds keys and spaces them like a person, and the result equals the input', async () => {
  const { page, events, text } = recorder();
  await new HumanKeyboard({ gapMedianMs: 30, wordPauseMs: [0, 5], thinkPauseChance: 0, typoChance: 0 }).type(page, 'Hello there');
  assert.equal(text(), 'Hello there');
  const holds = events.filter(e => e.type === 'down').map((down, i) => events.filter(e => e.type === 'up')[i].at - down.at);
  assert.equal(holds.length, 11);
  const mean = holds.reduce((a, b) => a + b, 0) / holds.length;
  assert.ok(mean > 60 && mean < 200, `mean hold ${mean}`);
  assert.ok(Math.min(...holds) >= 30, 'no instant key presses');
});

test('typos are corrected with Backspace and non-ASCII text goes through the input method', async () => {
  const { page, events, text } = recorder();
  await new HumanKeyboard({ dwellMedianMs: 1, gapMedianMs: 1, wordPauseMs: [0, 1], thinkPauseChance: 0, typoChance: 1 }).type(page, 'ab 你好');
  assert.equal(text(), 'ab 你好');
  assert.ok(events.some(e => e.key === 'Backspace'));
  assert.deepEqual(events.filter(e => e.type === 'insert').map(e => e.key), ['你', '好']);
});

test('keyboard providers fill the keyboard slot and nothing else does', () => {
  assert.ok(fitsSlot('keyboard', new HumanKeyboard()));
  assert.ok(fitsSlot('keyboard', new FastKeyboard()));
  assert.equal(fitsSlot('keyboard', new InputActor({ minSteps: 1, maxSteps: 2, minDelayMs: 0, maxDelayMs: 1 })), false);
  assert.equal(fitsSlot('keyboard', new ClipboardProvider()), false);
  assert.equal(fitsSlot('pointer', new HumanKeyboard()), false);
});
