import test from 'node:test';
import assert from 'node:assert/strict';
import { ClipboardProvider } from '../src/capabilities/ClipboardProvider.js';

test('virtual clipboard is session-local and never needs an OS clipboard', () => {
  const first = new ClipboardProvider();
  const second = new ClipboardProvider();
  first.write('session-one');
  second.write('session-two');
  assert.equal(first.read(), 'session-one');
  assert.equal(second.read(), 'session-two');
  first.clear();
  assert.equal(first.read(), '');
  assert.equal(second.read(), 'session-two');
});
