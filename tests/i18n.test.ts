import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createTranslator, normalizeLanguage } from '../src/i18n.js';
import { homeHtml } from '../src/web/home.js';
import { dashboardHtml } from '../src/web/dashboard.js';
import { loadConfig } from '../src/config.js';

const { rows, codes } = createRequire(import.meta.url)('../src/app/shell/i18n.cjs');
const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();

test('all eight languages have complete messages and matching placeholders', () => {
  assert.equal(codes.length, 8);
  const seen = new Set();
  for (const row of rows as string[][]) {
    assert.equal(row.length, 8, row[0]);
    assert.ok(!seen.has(row[0]), `duplicate: ${row[0]}`);
    seen.add(row[0]);
    for (const translated of row.slice(1)) {
      assert.ok(translated.trim(), row[0]);
      assert.deepEqual(placeholders(translated), placeholders(row[0]), row[0]);
    }
  }
});

test('language fallback and escaped interpolation keep page data inert', () => {
  assert.equal(normalizeLanguage('fr-CA'), 'fr');
  assert.equal(normalizeLanguage('zh_Hans'), 'zh-CN');
  assert.equal(normalizeLanguage('ar'), 'en');
  const en = createTranslator('invalid');
  assert.equal(en.t('暂停 AI'), 'Pause AI');
  assert.equal(en.t('plugin.custom'), 'plugin.custom');
  assert.equal(en.th(' · 元素 {0}', ['<script>&']), ' · Element &lt;script&gt;&amp;');
  assert.equal(en.t('会话 {0} · {1} 个标签页 · 今日 {2} 次动作', ['测试', 2, 5]), 'Session 测试 · Tabs: 2 · Actions today: 5');
});

test('activity labels, dates and challenge statuses localize in every language', () => {
  for (const locale of codes) {
    const I = createTranslator(locale);
    const context: any = { WaymarkI18n: I, URL, Date, Intl };
    vm.runInNewContext(readFileSync('src/app/shell/labels.js', 'utf8'), context);
    const L = context.AgentLabels;
    assert.equal(L.describe({ action: 'click', target: { ref: 'e3' } }).what, I.t('点击') + I.t(' · 元素 {0}', ['e3']));
    assert.equal(L.CHALLENGE_LABEL.failed, I.t('失败'));
    assert.equal(L.dayLabel(new Date().toISOString()), I.t('今天'));
    assert.equal(L.place({ after: { title: '用户原文', url: 'https://example.test/' } }), '用户原文 · example.test');
  }
});

test('local pages carry the persisted locale and external localization assets', () => {
  const config = loadConfig();
  for (const locale of codes) {
    config.uiLanguage = locale;
    for (const html of [homeHtml(config), dashboardHtml(locale)]) {
      assert.ok(html.includes(`lang="${locale}"`));
      assert.ok(html.includes('/assets/i18n.cjs'));
      assert.ok(html.includes('data-language-select'));
      assert.equal(html.includes('<script>'), false);
    }
  }
  config.home = { quickLinks: [{ name: '溯源记录', url: 'https://example.test/' }] };
  assert.match(homeHtml(config), /translate="no"[^>]*href="https:\/\/example.test\/"/);
  assert.ok(homeHtml(config).includes('<span>溯源记录</span>'));
});
