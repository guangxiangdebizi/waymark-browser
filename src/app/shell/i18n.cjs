(function (root) {
  const rows = typeof module !== 'undefined' && module.exports ? require('./translations.cjs') : root.WaymarkTranslations;
  const languages = { en: 'English', 'zh-CN': '简体中文', ja: '日本語', ko: '한국어', es: 'Español', fr: 'Français', de: 'Deutsch', pt: 'Português' };
  const codes = Object.keys(languages);
  const messages = new Map(rows.map(row => [row[0], row.slice(1)]));
  function normalize(value) {
    const tag = String(value || '').replace(/_/g, '-').toLowerCase();
    if (tag === 'zh' || tag === 'zh-cn' || tag === 'zh-hans') return 'zh-CN';
    const base = tag.split('-')[0];
    return Object.hasOwn(languages, base) ? base : 'en';
  }
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function create(locale) {
    locale = normalize(locale);
    function t(key, values = []) {
      const row = messages.get(key) || messages.get(key.trim());
      let text = locale === 'zh-CN' ? key : row?.[codes.filter(code => code !== 'zh-CN').indexOf(locale)] ?? row?.[0] ?? key;
      if (!messages.has(key) && row) text = key.match(/^\s*/)[0] + text + key.match(/\s*$/)[0];
      return text.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
    }
    return { locale, t, th: (key, values) => escapeHtml(t(key, values)) };
  }
  function applyStatic(document, translator) {
    // Run once, before live page data is rendered. Never translate websites, inputs, or audit payloads.
    document.documentElement.lang = translator.locale;
    const walker = document.createTreeWalker(document.documentElement, 4);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement.closest('script,style,code,pre,[translate="no"]')) continue;
      const key = node.textContent.trim();
      if (messages.has(key)) node.textContent = node.textContent.replace(key, translator.t(key));
    }
    document.querySelectorAll('[title],[placeholder],[aria-label]').forEach(element => {
      if (element.closest('[translate="no"]')) return;
      for (const attribute of ['title', 'placeholder', 'aria-label']) {
        const value = element.getAttribute(attribute);
        if (value && messages.has(value)) element.setAttribute(attribute, translator.t(value));
      }
    });
    document.querySelectorAll('button[title]:not([aria-label]),input[placeholder]:not([aria-label])').forEach(element => {
      element.setAttribute('aria-label', element.getAttribute('title') || element.getAttribute('placeholder'));
    });
    document.querySelectorAll('[data-language-select]').forEach(select => {
      select.replaceChildren(...codes.map(code => {
        const option = document.createElement('option');
        option.value = code; option.textContent = languages[code]; option.lang = code;
        return option;
      }));
      select.value = translator.locale;
      select.setAttribute('aria-label', translator.t('语言'));
    });
  }
  const api = { languages, codes, rows, normalize, create, applyStatic };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    const locale = root.location.protocol === 'file:' ? new URLSearchParams(root.location.search).get('lang') : root.document.documentElement.lang;
    Object.assign(api, create(locale));
    root.WaymarkI18n = api;
    applyStatic(root.document, api);
  }
})(globalThis);
