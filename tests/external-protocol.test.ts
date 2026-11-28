import test from 'node:test';
import assert from 'node:assert/strict';
import { ExternalNavigation, externalTarget } from '../src/app/external-protocol.js';

test('external navigation requires a fresh matching intent and a registered handler', () => {
  let time = 0;
  const policy = new ExternalNavigation(() => time);
  const url = 'waymark-test://play';
  const appName = () => 'fixture';
  assert.equal(policy.consume(url, appName), false);
  policy.input('mouseMove');
  policy.navigation(url, false);
  assert.equal(policy.consume(url, appName), false);
  policy.input('keyDown');
  time = 4999;
  policy.navigation(url, false);
  assert.equal(policy.consume(url + 'other', appName), false);
  assert.equal(policy.consume(url, appName), true);
  assert.equal(policy.consume(url, appName), false);
  time = 5000;
  policy.navigation(url, false);
  assert.equal(policy.consume(url, appName), false);
  policy.navigation(url, true);
  assert.equal(policy.consume(url, () => ''), false);
  policy.navigation(url, true);
  assert.equal(policy.consume(url, () => { throw Error(); }), false);
  policy.navigation(url, true);
  assert.equal(policy.consume(url, appName), true);
});

test('browser-local and relative URLs are never external targets', () => {
  for (const url of ['https://example.org', 'about:blank', 'DATA:text/plain,x', 'blob:https://example.org/id',
    'file:///tmp/x', 'chrome-extension://id/x', 'devtools://devtools', 'view-source:https://example.org', '/relative']) {
    assert.equal(externalTarget(url), undefined, url);
  }
  assert.equal(externalTarget('mailto:contact@example.org'), 'mailto:contact@example.org');
});
