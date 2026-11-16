// Shared by the Electron shell (file://) and the local cockpit pages served at /assets/labels.js.
(function (root) {
  const I = root.WaymarkI18n;
  const t = I.t;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  const ICONS = {
    globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5C6.4 11.9 5.7 10.1 5.7 8S6.4 4.1 8 2.5"/>',
    close: '<path d="m4 4 8 8M12 4l-8 8"/>',
    click: '<path d="M5 2.5v8.5l2.2-2 1.6 3.6 1.6-.7-1.6-3.5H12z"/>',
    fill: '<path d="M10.5 3 13 5.5 6 12.5H3.5V10z"/>',
    nav: '<path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"/>',
    back: '<path d="M13 8H4M7.5 4.5 4 8l3.5 3.5"/>',
    reload: '<path d="M13 8a5 5 0 1 1-1.5-3.55M13 2.5v3h-3"/>',
    snapshot: '<path d="M2.5 5.5v-2a1 1 0 0 1 1-1h2M10.5 2.5h2a1 1 0 0 1 1 1v2M13.5 10.5v2a1 1 0 0 1-1 1h-2M5.5 13.5h-2a1 1 0 0 1-1-1v-2"/><path d="M5.5 6.5h5M5.5 9.5h3"/>',
    read: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3M6 8.5h4M6 11h4"/>',
    tab: '<rect x="2.5" y="4" width="11" height="9" rx="1.5"/><path d="M2.5 7h11M6 4v3"/>',
    wait: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
    shield: '<path d="M8 2.5 3.5 4v4c0 2.8 2 4.6 4.5 5.5 2.5-.9 4.5-2.7 4.5-5.5V4z"/>',
    gear: '<circle cx="8" cy="8" r="2"/><path d="M8 2.5v1.5M8 12v1.5M2.5 8H4M12 8h1.5M4.1 4.1l1.1 1.1M10.8 10.8l1.1 1.1M4.1 11.9l1.1-1.1M10.8 5.2l1.1-1.1"/>',
    tag: '<path d="M2.5 8.5V3.5a1 1 0 0 1 1-1h5l5 5-6 6z"/><circle cx="5.5" cy="5.5" r=".8"/>',
    mouse: '<rect x="4.5" y="2.5" width="7" height="11" rx="3.5"/><path d="M8 5v2"/>',
    scroll: '<path d="M8 2.5v11M5 5.5l3-3 3 3M5 10.5l3 3 3-3"/>',
    key: '<rect x="2" y="4.5" width="12" height="7" rx="1.5"/><path d="M4.5 7h1M7.5 7h1M10.5 7h1M5 9.5h6"/>',
    clip: '<rect x="4" y="3.5" width="8" height="10" rx="1.5"/><path d="M6 3.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v.5"/>',
    power: '<path d="M8 2.5V8M5 4.2a5 5 0 1 0 6 0"/>',
    hover: '<circle cx="8" cy="8" r="2"/><circle cx="8" cy="8" r="5.5"/>'
  };
  const icon = name => `<svg viewBox="0 0 16 16">${ICONS[name] || ICONS.globe}</svg>`;

  const CHALLENGE_LABEL = {
    detected: t("已发现"), ocr_running: t("本地 OCR 识别中"), ai_recovery_required: t("等待 AI 处理"), human_required: t("需要你接管"),
    human_takeover: t("你正在处理"), resolved_unverified: t("已通过（待确认结果）"), failed: t("失败"), cancelled: t("已取消")
  };
  const CHALLENGE_TONE = { detected: 'info', ocr_running: 'info', ai_recovery_required: 'warn', human_required: 'warn', human_takeover: 'info', resolved_unverified: 'ok', failed: 'bad', cancelled: '' };
  const CHALLENGE_DETAIL = {
    'Generic text/image challenge detected': t("检测到文字图片验证码"),
    'Interactive or unrecognized challenge signal detected': t("检测到交互式或无法识别的验证"),
    'Local ddddocr attempt started': t("本地 ddddocr 正在识别"),
    'OCR returned an empty answer': t("OCR 没有识别出内容，转交 AI"),
    'Challenge elements changed before OCR': t("识别前验证码元素发生变化，转交 AI"),
    'OCR answer filled; automatic submit disabled': t("OCR 已填入答案（未开启自动提交）"),
    'Challenge disappeared after OCR; verify the business result': t("OCR 提交后验证码消失，请确认业务结果"),
    'Challenge remains after the single OCR attempt': t("OCR 尝试后验证码仍在，转交 AI"),
    'Challenge type requires AI recovery': t("这类验证需要 AI 处理"),
    'AI recovery attempt failed': t("AI 这次没处理成功，还会再试"),
    'AI recovery budget exhausted': t("AI 尝试次数已用完，需要你来处理"),
    'AI reported challenge resolved; business result still requires verification': t("AI 报告已通过，业务结果仍需确认"),
    'Automation paused for human takeover': t("已暂停这个页面的自动化，等你处理"),
    'Human completed challenge; verify the business result before continuing': t("你已完成验证，继续前请确认业务结果"),
    'Origin changed during takeover; checkpoint invalidated': t("接管期间站点发生变化，断点已失效"),
    'Updated from local audit cockpit': t("在本地面板中更新"),
    'Cancelled': t("已取消")
  };
  const challengeDetail = text => CHALLENGE_DETAIL[text]
    || String(text ?? '').replace(/^OCR unavailable or failed: /, t("本地 OCR 不可用或识别失败："));
  const KIND_LABEL = { text_image: t("文字图片验证码"), interactive: t("交互式验证"), unknown: t("未知类型验证") };
  const STATUS_LABEL = { success: t("成功"), failure: t("失败"), started: t("进行中"), info: t("记录") };
  const ACT_ACTIONS = ['click', 'hover', 'fill', 'paste', 'copy', 'press', 'scroll', 'navigate', 'tabs.new', 'tabs.close', 'snapshot', 'read'];

  function host(url) {
    try { const parsed = new URL(url); return parsed.protocol.startsWith('http') ? parsed.host + (parsed.pathname.length > 1 ? parsed.pathname : '') : url; }
    catch { return url || ''; }
  }
  function formatSize(value) {
    if (!value) return t("0 字符");
    return value > 1e6 ? (value / 1e6).toFixed(1) + ' MB' : value > 1e3 ? (value / 1e3).toFixed(1) + t(" K 字符") : value + t(" 字符");
  }

  // ctx: { home?: string, api?: string } lets local pages be named instead of shown as 127.0.0.1 URLs.
  function place(event, ctx = {}) {
    const url = event.after?.url || event.before?.url || '';
    if (!url || url.startsWith('about:blank')) return '';
    if (ctx.home && url.startsWith(ctx.home)) return t("新标签页");
    if (ctx.api && url.startsWith(ctx.api)) return t("Waymark 本地页");
    const title = event.after?.title || event.before?.title;
    return (title ? title + ' · ' : '') + host(url);
  }

  function describe(event, ctx = {}) {
    const target = event.target || {};
    const detail = event.detail || {};
    const ref = target.ref ? t(" · 元素 {0}", [target.ref]) : '';
    switch (event.action) {
      case 'navigate': {
        const map = { back: ['back', t("后退")], forward: ['nav', t("前进")], reload: ['reload', t("刷新页面")] };
        if (map[target.action]) return { icon: map[target.action][0], what: map[target.action][1] };
        return { icon: 'nav', what: t("打开 ") + (ctx.home && String(target.url || '').startsWith(ctx.home) ? t("新标签页") : host(target.url)) };
      }
      case 'click': return { icon: 'click', what: t("点击") + ref };
      case 'hover': return { icon: 'hover', what: t("悬停") + ref };
      case 'fill': return { icon: 'fill', what: t("填写 {0} 个输入框", [target.fields?.length ?? '']) };
      case 'paste': return { icon: 'clip', what: t("粘贴 {0} 个字符", [target.valueLength ?? '']) + ref };
      case 'copy': return { icon: 'clip', what: t("复制内容") + ref };
      case 'press': return { icon: 'key', what: t("按键 ") + (target.key || '') };
      case 'scroll': return { icon: 'scroll', what: t("滚动") + ({ up: t("向上"), down: t("向下"), left: t("向左"), right: t("向右") }[target.direction] || t("向下")) };
      case 'snapshot': return { icon: 'snapshot', what: t("页面快照 · {0} 个可交互元素", [target.refCount ?? 0]) };
      case 'read': return { icon: 'read', what: t("读取页面{0} · {1}", [detail.format === 'html' ? ' HTML' : t("文字"), formatSize(detail.sourceLength ?? detail.textLength)]) };
      case 'wait': return { icon: 'wait', what: t("等待{0}{1}", [target.for === 'time' ? t(" {0} 毫秒", [target.value]) : `“${String(target.value ?? '').slice(0, 30)}”`, detail.matched === false ? t("（超时）") : '']) };
      case 'tabs.new': return { icon: 'tab', what: t("新建标签页") };
      case 'tabs.close': return { icon: 'tab', what: t("关闭标签页") };
      case 'tabs.active': return { icon: 'tab', what: t("切换标签页") };
      case 'tabs.list': return { icon: 'tab', what: t("查看标签页列表 · {0} 个", [detail.count ?? 0]) };
      case 'mouse.ambient': return { icon: 'mouse', what: t("鼠标游走（未点击）") };
      case 'session.named': return { icon: 'tag', what: t("开始会话 “") + (detail.name || event.session) + '”' };
      case 'settings.clipboard': return { icon: 'gear', what: t("剪贴板切换为") + ({ 'action.clipboard.virtual': t("隔离模式"), 'action.clipboard.system': t("系统全局") }[detail.provider] || ' ' + detail.provider) };
      case 'settings.pointer': return { icon: 'gear', what: t("鼠标轨迹模型切换为 ") + detail.provider };
      case 'settings.ocr': return { icon: 'gear', what: t("验证码识别切换为 ") + detail.provider };
      case 'settings.ambientMouse': return { icon: 'gear', what: t("自主鼠标游走") + ' · ' + (detail.enabled ? t("开启") : t("关闭")) };
      case 'settings.control': return { icon: 'gear', what: detail.paused ? t("用户暂停了 AI") : t("用户恢复了 AI") };
      case 'browser.launch': return { icon: 'power', what: t("浏览器启动") };
      default:
        if (event.action.startsWith('challenge.')) {
          const step = event.action.slice(10);
          const steps = { detected: t("发现验证码"), ocr_filled: t("OCR 已填入答案"), automation_blocked: t("验证未完成，拦下了 AI 操作"), detection_deferred: t("页面跳转中，稍后再检测") };
          return { icon: 'shield', what: t("验证挑战 · ") + (CHALLENGE_LABEL[step] || steps[step] || step) };
        }
        return { icon: 'globe', what: event.action };
    }
  }

  function when(ts) {
    const time = Date.parse(ts);
    const diff = (Date.now() - time) / 1000;
    if (diff < 10) return t("刚刚");
    const relative = new Intl.RelativeTimeFormat(I.locale, { numeric: 'always' });
    if (diff < 60) return relative.format(-Math.floor(diff), 'second');
    if (diff < 3600) return relative.format(-Math.floor(diff / 60), 'minute');
    return new Date(time).toLocaleTimeString(I.locale, { hour12: false });
  }
  function dayLabel(ts) {
    const date = new Date(ts);
    if (date.toDateString() === new Date().toDateString()) return t("今天");
    if (date.toDateString() === new Date(Date.now() - 864e5).toDateString()) return t("昨天");
    return date.toLocaleDateString(I.locale, { month: 'long', day: 'numeric', weekday: 'short' });
  }

  // Drops "started" rows that already have a matching completion, so each action shows once. Input is newest first.
  function collapseStarted(events) {
    const completed = new Map();
    const result = [];
    for (const event of events) {
      const key = `${event.pageId ?? ''}|${event.action}`;
      if (event.status === 'success' || event.status === 'failure') completed.set(key, (completed.get(key) || 0) + 1);
      if (event.status === 'started') {
        if (completed.get(key)) { completed.set(key, completed.get(key) - 1); continue; }
        if (Date.now() - Date.parse(event.timestamp) > 120000) continue;
      }
      result.push(event);
    }
    return result;
  }

  root.AgentLabels = { esc, icon, host, place, describe, when, dayLabel, collapseStarted, formatSize, challengeDetail, CHALLENGE_LABEL, CHALLENGE_TONE, KIND_LABEL, STATUS_LABEL, ACT_ACTIONS };
})(typeof window !== 'undefined' ? window : globalThis);
