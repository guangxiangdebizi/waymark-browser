// Agent manager: agents -> sessions -> tabs -> steps. Chinese for zh-CN, English otherwise.
(function () {
  const esc = window.WaymarkCharts.esc;
  const zh = document.documentElement.lang === 'zh-CN';
  const D = zh ? {
    title: '管理中心', subtitle: '哪个 agent、哪个窗口、在哪些标签页里做了什么，每一步都可追溯', search: '搜索网址、标题、错误、会话或窗口', openInsights: '数据面板 →',
    agents: 'Agent', sessions: '会话', trace: '溯源', loading: '读取中…', none: '这段时间没有记录。', pick: '选择左侧的会话，查看它的每一步。', allAgents: '全部 agent',
    sessionsN: '{0} 个会话', steps: '{0} 步', fails: '失败 {0}', tabsN: '{0} 个标签页', inferred: '推断会话', identity: '身份来源', client: '客户端', window: '窗口',
    duration: '时长', calls: '工具调用', actions: '动作', failures: '失败', tokens: 'token（估算）', reported: '已上报 token', start: '开始', end: '结束',
    tabs: '用到的标签页', openedBy: '由 {0} 打开', openedHere: '本会话打开', usedOnly: '使用了已有标签页', idle: '显示空闲行为', failOnly: '只看失败', allTabs: '全部标签页',
    snapshot: 'AI 当时依据的页面快照', screenshot: '操作后的页面', noShot: '没有截图（可在配置 audit.captureScreenshots 打开）', target: '目标', before: '之前', after: '之后', error: '错误', provider: '执行者', detail: '附加', call: '调用', active: '正在工作',
    ids: { declared: '自报', 'mcp-client': 'MCP 客户端', env: '环境变量', 'user-agent': 'UA 推断', tty: '终端（人）', 'local-ui': '本地界面', system: '系统', unknown: '未知', legacy: '旧记录' },
    act: { navigate: '打开', click: '点击', fill: '填写', type: '输入', select: '选择', press: '按键', scroll: '滚动', hover: '悬停', paste: '粘贴', copy: '复制', read: '读取页面', snapshot: '快照', screenshot: '截图', wait: '等待', 'tabs.new': '新建标签页', 'tabs.close': '关闭标签页', 'tabs.active': '切换标签页', 'session.named': '命名会话', 'agent.connected': 'Agent 连接', 'usage.reported': '上报用量', 'challenge.detected': '发现验证', 'challenge.ocr_running': 'ddddocr 识别中', 'challenge.input': 'ddddocr 输入整理', 'challenge.ocr_filled': 'ddddocr 已填入', 'challenge.resolved_unverified': '验证已通过', 'challenge.ai_recovery_required': '交给 AI', 'challenge.human_required': '需要人工', 'challenge.automation_blocked': '自动化被拦下', 'mouse.ambient': '鼠标游走', 'idle.scroll': '空闲滚动', 'idle.click': '空闲点击', 'idle.visit': '空闲浏览', 'settings.control': '暂停/恢复' },
    ago: { s: '{0} 秒前', m: '{0} 分钟前', h: '{0} 小时前', d: '{0} 天前' }
  } : {
    title: 'Agent manager', subtitle: 'Which agent, from which window, did what in which tabs: every step traceable', search: 'Search URLs, titles, errors, sessions or windows', openInsights: 'Insights →',
    agents: 'Agents', sessions: 'Sessions', trace: 'Trace', loading: 'Loading…', none: 'Nothing recorded in this period.', pick: 'Pick a session to see every step.', allAgents: 'All agents',
    sessionsN: '{0} sessions', steps: '{0} steps', fails: '{0} failed', tabsN: '{0} tabs', inferred: 'Inferred session', identity: 'Identified by', client: 'Client', window: 'Window',
    duration: 'Duration', calls: 'Tool calls', actions: 'Actions', failures: 'Failures', tokens: 'Tokens (est.)', reported: 'Reported tokens', start: 'Start', end: 'End',
    tabs: 'Tabs used', openedBy: 'Opened by {0}', openedHere: 'Opened in this session', usedOnly: 'Existing tab', idle: 'Show idle behaviour', failOnly: 'Failures only', allTabs: 'All tabs',
    snapshot: 'Snapshot the agent acted on', screenshot: 'Page after the step', noShot: 'No screenshot (enable audit.captureScreenshots)', target: 'Target', before: 'Before', after: 'After', error: 'Error', provider: 'Provider', detail: 'Detail', call: 'Call', active: 'Working now',
    ids: { declared: 'Declared', 'mcp-client': 'MCP client', env: 'Environment', 'user-agent': 'User-Agent', tty: 'Terminal (person)', 'local-ui': 'Local UI', system: 'System', unknown: 'Unknown', legacy: 'Legacy' },
    act: { navigate: 'Open', click: 'Click', fill: 'Fill', type: 'Type', select: 'Select', press: 'Press', scroll: 'Scroll', hover: 'Hover', paste: 'Paste', copy: 'Copy', read: 'Read page', snapshot: 'Snapshot', screenshot: 'Screenshot', wait: 'Wait', 'tabs.new': 'New tab', 'tabs.close': 'Close tab', 'tabs.active': 'Switch tab', 'session.named': 'Named session', 'agent.connected': 'Agent connected', 'usage.reported': 'Usage reported', 'challenge.detected': 'Challenge found', 'challenge.ocr_running': 'ddddocr running', 'challenge.input': 'ddddocr input prepared', 'challenge.ocr_filled': 'ddddocr filled', 'challenge.resolved_unverified': 'Challenge passed', 'challenge.ai_recovery_required': 'Handed to AI', 'challenge.human_required': 'Needs a person', 'challenge.automation_blocked': 'Automation blocked', 'mouse.ambient': 'Pointer drift', 'idle.scroll': 'Idle scroll', 'idle.click': 'Idle click', 'idle.visit': 'Idle visit', 'settings.control': 'Pause / resume' },
    ago: { s: '{0}s ago', m: '{0} min ago', h: '{0} h ago', d: '{0} d ago' }
  };
  const f = (text, ...values) => String(text).replace(/\{(\d+)\}/g, (_, i) => values[i] ?? '');
  const $ = selector => document.querySelector(selector);
  const params = new URLSearchParams(location.search);
  const state = { days: 7, q: '', agent: params.get('agent') || '', session: params.get('session') || '', focusEvent: params.get('event') || '', tree: null, detail: null, idle: false, failOnly: false, tab: '', open: new Set() };
  const colors = new Map();
  const colorOf = agent => { if (!colors.has(agent)) colors.set(agent, `var(--series-${(colors.size % 8) + 1})`); return colors.get(agent); };
  const ago = ts => { const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000); return s < 60 ? f(D.ago.s, Math.round(s)) : s < 3600 ? f(D.ago.m, Math.round(s / 60)) : s < 86400 ? f(D.ago.h, Math.round(s / 3600)) : f(D.ago.d, Math.round(s / 86400)); };
  const durText = ms => ms < 60000 ? `${Math.round(ms / 1000)}s` : ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`;
  const time = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const host = url => { try { return new URL(url).host; } catch { return url || ''; } };
  const initials = label => label.replace(/[^A-Za-z0-9一-鿿 ]/g, '').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';

  document.querySelectorAll('[data-i]').forEach(node => { node.textContent = D[node.dataset.i] ?? ''; });
  $('#q').placeholder = D.search;
  document.title = 'Waymark · ' + D.title;
  document.querySelectorAll('#range button').forEach(button => button.addEventListener('click', () => {
    state.days = Number(button.dataset.days);
    document.querySelectorAll('#range button').forEach(b => b.classList.toggle('on', b === button));
    loadTree();
  }));
  let typing;
  $('#q').addEventListener('input', event => { clearTimeout(typing); typing = setTimeout(() => { state.q = event.target.value; loadTree(); }, 250); });

  async function loadTree() {
    const query = new URLSearchParams({ days: String(state.days) });
    if (state.q) query.set('q', state.q);
    try { state.tree = await fetch('/api/agents?' + query).then(r => r.json()); } catch { return; }
    state.tree.agents.map(a => a.agent).sort().forEach(colorOf);
    if (state.session && !state.agent) state.agent = state.tree.agents.find(a => a.sessions.some(s => s.key === state.session))?.agent || '';
    renderAgents();
    renderSessions();
    if (state.session) loadDetail(state.session, false);
    else $('#detail').innerHTML = `<div class="empty">${esc(state.tree.agents.length ? D.pick : D.none)}</div>`;
  }

  function renderAgents() {
    const agents = state.tree.agents;
    const total = agents.reduce((n, a) => n + a.sessions.length, 0);
    $('#agents').innerHTML = `<div class="item${state.agent ? '' : ' sel'}" data-agent=""><div class="av" style="background:var(--text-3)">∑</div><div class="body"><div class="name">${esc(D.allAgents)}</div><div class="meta">${esc(f(D.sessionsN, total))}</div></div></div>` +
      agents.map(a => `<div class="item${state.agent === a.agent ? ' sel' : ''}" data-agent="${esc(a.agent)}"><div class="av" style="background:${colorOf(a.agent)}">${esc(initials(a.label))}</div><div class="body">
        <div class="name">${esc(a.label)}</div><div class="meta">${esc(f(D.sessionsN, a.sessions.length))} · ${esc(f(D.steps, a.actions))}${a.failures ? ` · <span class="bad-n">${esc(f(D.fails, a.failures))}</span>` : ''}</div>
        <div class="meta">${Object.keys(a.identity).map(k => `<span class="tag ${esc(k)}">${esc(D.ids[k] || k)}</span>`).join('')} ${esc(ago(a.lastSeen))}</div></div></div>`).join('') || `<div class="empty">${esc(D.none)}</div>`;
    $('#agents').querySelectorAll('.item').forEach(item => item.addEventListener('click', () => { state.agent = item.dataset.agent; renderAgents(); renderSessions(); }));
  }

  function renderSessions() {
    const sessions = state.tree.agents.filter(a => !state.agent || a.agent === state.agent).flatMap(a => a.sessions).sort((a, b) => b.end.localeCompare(a.end));
    $('#sessions').innerHTML = sessions.map(s => `<div class="item${state.session === s.key ? ' sel' : ''}" data-key="${esc(s.key)}"><div class="av" style="background:${colorOf(s.agent)};width:10px;height:34px;border-radius:5px"></div><div class="body">
      <div class="name">${esc(s.label)}</div>
      <div class="meta">${esc(s.agentLabel)}${s.window ? ' · ' + esc(s.window) : ''} · ${esc(ago(s.end))} · ${esc(durText(s.durationMs))}</div>
      <div class="meta">${esc(f(D.steps, s.actions))} · ${esc(f(D.tabsN, s.tabs.length))}${s.failures ? ` · <span class="bad-n">${esc(f(D.fails, s.failures))}</span>` : ''}${s.inferred ? ` · <span class="tag">${esc(D.inferred)}</span>` : ''}</div>
      <div class="hosts">${esc(s.hosts.join(' · '))}</div></div></div>`).join('') || `<div class="empty">${esc(D.none)}</div>`;
    $('#sessions').querySelectorAll('.item').forEach(item => item.addEventListener('click', () => { state.session = item.dataset.key; state.tab = ''; state.open.clear(); renderSessions(); loadDetail(state.session, true); }));
  }

  async function loadDetail(key, push) {
    if (push) history.replaceState(null, '', `?session=${encodeURIComponent(key)}`);
    const response = await fetch(`/api/sessions/${encodeURIComponent(key)}${state.idle ? '?idle=1' : ''}`);
    if (!response.ok) { $('#detail').innerHTML = `<div class="empty">${esc(D.none)}</div>`; return; }
    state.detail = await response.json();
    if (state.focusEvent) { state.open.add(state.focusEvent); }
    renderDetail();
    if (state.focusEvent) { document.querySelector(`[data-id="${CSS.escape(state.focusEvent)}"]`)?.scrollIntoView({ block: 'center' }); state.focusEvent = ''; }
  }

  function describe(event) {
    const target = event.target || {};
    const name = D.act[event.action] || event.action;
    let what = name;
    if (event.action === 'navigate') what += ' ' + host(event.after?.url || target.url);
    else if (target.ref) what += ' · ' + target.ref;
    else if (target.fields) what += ' · ' + target.fields.map(x => x.ref).join(', ');
    else if (target.key) what += ' · ' + target.key;
    if (target.valueLength !== undefined) what += ` (${target.valueLength})`;
    return what;
  }

  function renderDetail() {
    const { session: s, tabs, timeline } = state.detail;
    const steps = timeline.filter(e => (!state.tab || `${e.run}:${e.pageId}` === state.tab) && (!state.failOnly || e.status === 'failure'))
      .filter((e, i, all) => !(e.status === 'started' && all.some(o => o.actor?.call && o.actor?.call === e.actor?.call && o.action === e.action && (o.status === 'success' || o.status === 'failure'))));
    $('#detail').innerHTML = `<div class="dh"><div class="item" style="padding:0;border:0;cursor:default"><div class="av" style="background:${colorOf(s.agent)};width:44px;height:44px;border-radius:14px;font-size:15px">${esc(initials(s.agentLabel))}</div></div>
      <div style="flex:1;min-width:0"><h2>${esc(s.label)}</h2><div class="muted" style="font-size:13px">${esc(s.agentLabel)} · <span class="tag ${esc(s.identity)}">${esc(D.identity)}: ${esc(D.ids[s.identity] || s.identity)}</span>${s.client ? ` <span class="tag">${esc(D.client)}: ${esc(s.client)}</span>` : ''}${s.window ? ` <span class="tag">${esc(D.window)}: ${esc(s.window)}</span>` : ''}${s.inferred ? ` <span class="tag">${esc(D.inferred)}</span>` : ''}</div>
      <div class="muted" style="font-size:12px;margin-top:4px">${esc(new Date(s.start).toLocaleString())} → ${esc(new Date(s.end).toLocaleString())}</div></div></div>
      <div class="facts"><div class="fact"><span>${D.duration}</span><b>${esc(durText(s.durationMs))}</b></div><div class="fact"><span>${D.actions}</span><b>${s.actions}</b></div><div class="fact"><span>${D.failures}</span><b>${s.failures}</b></div><div class="fact"><span>${s.tokensReported ? D.reported : D.tokens}</span><b>${(s.tokensReported ?? s.tokensEstimated).toLocaleString()}</b></div></div>
      <div class="tabs"><div class="tabc${state.tab ? '' : ' on'}" data-tab=""><b>${esc(D.allTabs)}</b><span>${esc(f(D.steps, timeline.length))}</span></div>${tabs.map(t => `<div class="tabc${state.tab === t.tab ? ' on' : ''}" data-tab="${esc(t.tab)}" title="${esc(t.lastUrl || '')}"><b>#${t.pageId} ${esc(t.lastTitle || host(t.lastUrl) || '')}</b><span>${esc(t.openedHere ? D.openedHere : t.openedBy ? f(D.openedBy, t.openedBy) : D.usedOnly)} · ${esc(f(D.steps, t.steps))}</span></div>`).join('')}</div>
      <div class="tools"><label><input type="checkbox" id="idle"${state.idle ? ' checked' : ''}> ${esc(D.idle)}</label><label><input type="checkbox" id="failonly"${state.failOnly ? ' checked' : ''}> ${esc(D.failOnly)}</label></div>
      <div id="steps">${steps.map(stepHtml).join('') || `<div class="empty">${esc(D.none)}</div>`}</div>`;
    $('#detail').querySelectorAll('.tabc').forEach(chip => chip.addEventListener('click', () => { state.tab = chip.dataset.tab; renderDetail(); }));
    $('#idle').addEventListener('change', event => { state.idle = event.target.checked; loadDetail(state.session, false); });
    $('#failonly').addEventListener('change', event => { state.failOnly = event.target.checked; renderDetail(); });
    $('#detail').querySelectorAll('.step').forEach(row => row.addEventListener('click', () => toggle(row.dataset.id)));
    for (const id of state.open) fillMore(id);
  }

  function stepHtml(event) {
    const idle = event.action === 'mouse.ambient' || event.action.startsWith('idle.');
    const place = event.after?.url || event.before?.url || '';
    const shot = event.screenshot ? `<img class="thumb" loading="lazy" src="/api/audit/screens/${encodeURIComponent(event.screenshot)}" alt="">` : '';
    return `<div class="step ${esc(event.status)}${idle ? ' idle' : ''}" data-id="${esc(event.id)}"><span class="t">${esc(time(event.timestamp))}</span><span class="ic">${event.status === 'failure' ? '!' : idle ? '~' : event.action.startsWith('challenge') ? '◆' : '›'}</span>
      <div class="w"><b>${esc(describe(event))}</b>${event.tool ? ` <span class="tag">${esc(event.tool)}${event.responseChars ? ' · ' + Math.round(event.responseChars / 4) + ' tok' : ''}</span>` : ''}<div class="u">${esc(event.after?.title || event.before?.title || '')} ${esc(place)}</div>${event.error ? `<div class="e">${esc(event.error.split('\n')[0])}</div>` : ''}</div>
      <div class="r">${event.durationMs !== undefined ? esc(event.durationMs + ' ms') : ''}${shot}</div></div>${state.open.has(event.id) ? `<div class="more" id="more-${esc(event.id)}">…</div>` : ''}`;
  }

  function toggle(id) {
    if (state.open.has(id)) state.open.delete(id); else state.open.add(id);
    renderDetail();
  }

  async function fillMore(id) {
    const box = document.getElementById('more-' + id);
    if (!box) return;
    const item = await fetch('/api/audit/events/' + encodeURIComponent(id)).then(r => r.ok ? r.json() : null).catch(() => null);
    if (!item) { box.textContent = '—'; return; }
    const e = item.event;
    const ref = e.target?.ref || e.target?.fields?.[0]?.ref;
    const snap = item.snapshot?.text ? esc(item.snapshot.text).replace(ref ? new RegExp(`(\\[ref=${ref}\\][^\\n]*)`) : /$^/, '<mark>$1</mark>') : '';
    box.innerHTML = `<dl class="kv">${e.target ? `<dt>${D.target}</dt><dd class="mono">${esc(JSON.stringify(e.target))}</dd>` : ''}${e.before ? `<dt>${D.before}</dt><dd>${esc(e.before.title)} · ${esc(e.before.url)}</dd>` : ''}${e.after ? `<dt>${D.after}</dt><dd>${esc(e.after.title)} · ${esc(e.after.url)}</dd>` : ''}${e.capabilities?.length ? `<dt>${D.provider}</dt><dd>${esc(e.capabilities.map(c => c.id + '@' + c.version).join(', '))}</dd>` : ''}${e.actor?.call ? `<dt>${D.call}</dt><dd class="mono">${esc(e.actor.tool || '')} ${esc(e.actor.call)}</dd>` : ''}${e.detail ? `<dt>${D.detail}</dt><dd class="mono">${esc(JSON.stringify(e.detail))}</dd>` : ''}${e.error ? `<dt>${D.error}</dt><dd>${esc(e.error)}</dd>` : ''}</dl>
      ${e.screenshot ? `<div style="margin-top:10px"><b>${D.screenshot}</b><img src="/api/audit/screens/${encodeURIComponent(e.screenshot)}" alt=""></div>` : ['navigate', 'click', 'fill', 'type', 'select', 'press', 'scroll', 'hover', 'paste'].includes(e.action) ? `<div class="muted" style="margin-top:8px">${D.noShot}</div>` : ''}
      ${snap ? `<div style="margin-top:10px"><b>${D.snapshot}</b><pre>${snap}</pre></div>` : ''}`;
  }

  async function live() {
    try {
      const status = await fetch('/api/status').then(r => r.json());
      $('#live').innerHTML = (status.activeAgents || []).map(a => `<span class="pill" title="${esc(D.active)}"><span class="dot ok"></span>${esc(a.label)} · ${esc(ago(a.lastCallAt))}</span>`).join('');
    } catch { /* offline */ }
  }

  loadTree();
  live();
  // Poll only while visible; a hidden manager window costs nothing.
  setInterval(() => { if (document.hidden) return; live(); }, 5000);
  setInterval(() => { if (!document.hidden) loadTree(); }, 20000);
})();
