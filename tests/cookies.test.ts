import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookieUrl, domainMatches, restorable, toPlaywright, SESSION_COOKIE_MAX_AGE_DAYS } from '../src/browser/Cookies.js';

test('domain filter matches the domain and its subdomains only', () => {
  assert.equal(domainMatches('.qcc.com', ['qcc.com']), true);
  assert.equal(domainMatches('www.qcc.com', ['qcc.com']), true);
  assert.equal(domainMatches('notqcc.com', ['qcc.com']), false);
  assert.equal(domainMatches('a.example.org'), true);
});

test('CDP session cookies become Playwright session cookies', () => {
  const c = toPlaywright({ name: 'S', value: 'v', domain: '.qcc.com', path: '/', expires: -1, httpOnly: true, secure: false, session: true });
  assert.deepEqual(c, { name: 'S', value: 'v', domain: '.qcc.com', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' });
});

test('Electron cookie fields map over and SameSite=None needs Secure', () => {
  assert.equal(toPlaywright({ name: 'a', value: '1', domain: 'x.com', expirationDate: 1900000000.7, sameSite: 'no_restriction', secure: true }).sameSite, 'None');
  assert.equal(toPlaywright({ name: 'a', value: '1', domain: 'x.com', expirationDate: 1900000000.7, sameSite: 'no_restriction', secure: true }).expires, 1900000000);
  assert.equal(toPlaywright({ name: 'a', value: '1', domain: 'x.com', sameSite: 'None', secure: false }).sameSite, 'Lax');
});

test('stale session snapshots are not restored', () => {
  const cookies = [{ name: 'a', value: '1', domain: 'x.com' }];
  assert.equal(restorable({ savedAt: Date.now(), cookies }).length, 1);
  assert.equal(restorable({ savedAt: Date.now() - (SESSION_COOKIE_MAX_AGE_DAYS + 1) * 86400_000, cookies }).length, 0);
  assert.equal(restorable(undefined).length, 0);
});

test('cookie URL follows scheme and strips the leading dot', () => {
  assert.equal(cookieUrl({ name: 'a', value: '1', domain: '.qcc.com', path: '/web', secure: true }), 'https://qcc.com/web');
});
