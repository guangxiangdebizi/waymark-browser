(() => {
  const I = window.WaymarkI18n;
  const { t, th } = I;
  const shell = window.agentShell;
  const $ = selector => document.querySelector(selector);
  const store = {
    get: (key, fallback) => { try { const value = localStorage.getItem('ab.' + key); return value === null ? fallback : JSON.parse(value); } catch { return fallback; } },
    set: (key, value) => { try { localStorage.setItem('ab.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ } }
  };

  const L = window.AgentLabels;
  const { esc, icon, when, dayLabel, CHALLENGE_LABEL, CHALLENGE_TONE, KIND_LABEL } = L;

  const state = {
    tabs: [], info: null, status: null, online: false, events: [], challenges: [],
    view: store.get('view', 'activity'), filter: store.get('filter', 'all'), showAmbient: store.get('showAmbient', false),
    open: new Set(), details: new Map(), editing: false, dragId: null
  };
  const active = () => state.tabs.find(tab => tab.active);

  /* ---------------- tabs ---------------- */
  function renderTabs() {
    const box = $('#tabs');
    const width = Math.max(64, Math.min(220, (box.parentElement.clientWidth - 230) / Math.max(1, state.tabs.length)));
    box.innerHTML = state.tabs.map(tab => {
      const fav = tab.loading ? '<span class="spinner"></span>'
        : tab.isHome ? '<span class="logo" style="width:16px;height:16px;font-size:9px;border-radius:5px">W</span>'
        : tab.favicon ? `<img src="${esc(tab.favicon)}" alt="" draggable="false">`
        : `<span class="globe">${icon('globe')}</span>`;
      return `<div class="tab${tab.active ? ' active' : ''}${width < 96 ? ' narrow' : ''}" role="tab" draggable="true" data-id="${tab.id}" title="${esc(tab.title)}
${esc(tab.url)}" style="flex-basis:${width}px">
        <span class="fav">${fav}</span><span class="title">${esc(tab.title)}</span>${tab.owner === 'agent' ? `<span class="badge" title="${th("此标签页由 AI 打开")}">${esc(tab.agent || 'AI')}</span>` : ''}
        <button class="x" data-close="${tab.id}" title="${th("关闭标签页 (Ctrl+W)")}">${icon('close')}</button></div>`;
    }).join('');
    box.querySelectorAll('.fav img').forEach(img => img.addEventListener('error', () => { img.replaceWith(Object.assign(document.createElement('span'), { className: 'globe', innerHTML: icon('globe') })); }, { once: true }));
  }

  function renderToolbar() {
    const tab = active();
    $('#back').disabled = !tab?.canGoBack;
    $('#forward').disabled = !tab?.canGoForward;
    $('#reload').classList.toggle('loading', Boolean(tab?.loading));
    $('#reload').title = tab?.loading ? t("停止加载") : t("重新加载 (Ctrl+R)");
    $('#agent-tag').hidden = tab?.owner !== 'agent';
    $('#agent-tag').textContent = tab?.agent ? tab.agent : t("AI 标签页");
    $('#zoom-tag').hidden = !tab || tab.zoom === 100;
    $('#zoom-tag').textContent = (tab?.zoom ?? 100) + '%';
    if (!state.editing) {
      $('#address').value = !tab || tab.isHome || tab.url.startsWith('about:blank') ? '' : prettyUrl(tab.url);
      setSiteKind(tab);
    }
  }

  function prettyUrl(url) { try { return decodeURI(url); } catch { return url; } }
  function setSiteKind(tab) {
    const site = $('#site-icon');
    if (state.editing || !tab || tab.isHome || !tab.url || tab.url.startsWith('about:')) { site.dataset.kind = 'search'; site.title = ''; return; }
    const secure = tab.url.startsWith('https://');
    site.dataset.kind = secure ? 'secure' : 'info';
    site.title = secure ? t("连接是安全的") : t("此连接不是 HTTPS");
  }

  $('#tabs').addEventListener('mousedown', event => {
    const tab = event.target.closest('.tab');
    if (!tab || event.target.closest('.x')) return;
    if (event.button === 1) { event.preventDefault(); shell.close(Number(tab.dataset.id)); }
    else if (event.button === 0) shell.activate(Number(tab.dataset.id));
  });
  $('#tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-close]');
    if (button) { event.stopPropagation(); shell.close(Number(button.dataset.close)); }
  });
  $('#tabs').addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault(); });
  $('#tabs').addEventListener('contextmenu', event => {
    const tab = event.target.closest('.tab');
    if (tab) { event.preventDefault(); shell.tabMenu(Number(tab.dataset.id)); }
  });
  $('#tabs').addEventListener('dragstart', event => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    state.dragId = Number(tab.dataset.id);
    tab.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
  });
  $('#tabs').addEventListener('dragover', event => { if (state.dragId) event.preventDefault(); });
  $('#tabs').addEventListener('drop', event => {
    event.preventDefault();
    if (!state.dragId) return;
    const target = event.target.closest('.tab');
    let before = null;
    if (target) {
      const rect = target.getBoundingClientRect();
      const id = Number(target.dataset.id);
      if (event.clientX < rect.left + rect.width / 2) before = id;
      else { const index = state.tabs.findIndex(tab => tab.id === id); before = state.tabs[index + 1]?.id ?? null; }
    }
    shell.move(state.dragId, before);
  });
  $('#tabs').addEventListener('dragend', () => { state.dragId = null; renderTabs(); });
  $('#strip').addEventListener('dblclick', event => { if (event.target === $('#strip') || event.target.classList.contains('strip-fill')) shell.newTab(); });

  $('#new-tab').addEventListener('click', () => { shell.newTab(); setTimeout(focusAddress, 60); });
  $('#back').addEventListener('click', () => active() && shell.history(active().id, 'back'));
  $('#forward').addEventListener('click', () => active() && shell.history(active().id, 'forward'));
  $('#reload').addEventListener('click', () => active() && shell.history(active().id, active().loading ? 'stop' : 'reload'));
  $('#home').addEventListener('click', () => active() ? shell.history(active().id, 'home') : shell.newTab());
  $('#zoom-tag').addEventListener('click', () => active() && shell.zoom(active().id, 0));

  const address = $('#address');
  function focusAddress() { address.focus(); address.select(); }
  address.addEventListener('focus', () => { state.editing = true; $('#omnibox').classList.add('focus'); setSiteKind(active()); setTimeout(() => address.select(), 0); });
  address.addEventListener('blur', () => { state.editing = false; $('#omnibox').classList.remove('focus'); renderToolbar(); });
  address.addEventListener('keydown', event => { if (event.key === 'Escape') { state.editing = false; renderToolbar(); address.blur(); } });
  $('#omnibox').addEventListener('submit', event => {
    event.preventDefault();
    const value = address.value.trim();
    if (!value) return;
    const tab = active();
    if (tab) shell.navigate(tab.id, value); else shell.newTab(value);
    state.editing = false;
    address.blur();
  });

  shell.onTabs(next => { state.tabs = next; renderTabs(); renderToolbar(); });
  shell.onCommand(command => { if (command === 'focus-address') focusAddress(); });
  window.addEventListener('resize', renderTabs);

  /* ---------------- panel ---------------- */
  function applyPanel(open) {
    document.body.classList.toggle('panel-closed', !open);
    $('#panel-toggle').classList.toggle('on', open);
    if (open) refreshPanel();
  }
  $('#panel-toggle').addEventListener('click', async () => shell.setPanel(!(await shell.getPanel())));
  $('#open-agents').addEventListener('click', () => shell.openWindow('agents'));
  $('#open-insights').addEventListener('click', () => shell.openWindow('insights'));
  shell.onPanel(applyPanel);

  function setView(view) {
    state.view = view;
    store.set('view', view);
    document.querySelectorAll('#panel-tabs button').forEach(button => button.classList.toggle('on', button.dataset.view === view));
    document.querySelectorAll('.view').forEach(section => section.classList.toggle('on', section.dataset.view === view));
    refreshPanel();
  }
  $('#panel-tabs').addEventListener('click', event => { const button = event.target.closest('button'); if (button) setView(button.dataset.view); });
  $('#ai-pill').addEventListener('click', async () => {
    if (!(await shell.getPanel())) await shell.setPanel(true);
    setView(needsHuman().length ? 'challenges' : 'activity');
  });

  $('#filter-chips').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    state.filter = button.dataset.filter;
    store.set('filter', state.filter);
    renderFilters();
    renderTimeline();
  });
  $('#show-ambient').addEventListener('change', event => { state.showAmbient = event.target.checked; store.set('showAmbient', state.showAmbient); loadEvents(); });
  function renderFilters() {
    document.querySelectorAll('#filter-chips button').forEach(button => button.classList.toggle('on', button.dataset.filter === state.filter));
    $('#show-ambient').checked = state.showAmbient;
  }

  function toast(text) {
    const box = $('#toast');
    box.textContent = text;
    box.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { box.hidden = true; }, 1800);
  }

  /* ---------------- status & control ---------------- */
  const needsHuman = () => state.challenges.filter(job => ['human_required', 'ai_recovery_required', 'detected'].includes(job.status));

  async function loadStatus() {
    try {
      state.status = await shell.apiGet('/api/status');
      if (state.status.uiLanguage && state.status.uiLanguage !== I.locale) {
        const url = new URL(location.href);
        url.searchParams.set('lang', state.status.uiLanguage);
        location.replace(url.href);
        return;
      }
      state.challenges = state.status.challenges || [];
      state.online = true;
    } catch {
      state.online = false;
    }
    renderStatus();
  }

  function renderStatus() {
    const pill = $('#ai-pill');
    const status = state.status;
    pill.className = 'ai-pill';
    let text = t("MCP 未连接");
    if (!state.online || !status) pill.classList.add('alert');
    else if (needsHuman().some(job => job.status === 'human_required')) { pill.classList.add('alert'); text = t("需要你处理验证"); }
    else if (status.paused) { pill.classList.add('paused'); text = t("AI 已暂停"); }
    else if (status.busy > 0) { pill.classList.add('busy'); text = t("AI 正在操作"); }
    else { pill.classList.add('ok'); text = status.lastActionAt && Date.now() - Date.parse(status.lastActionAt) < 60000 ? t("AI 刚刚操作过") : t("AI 就绪"); }
    $('#ai-pill-text').textContent = text;

    const pending = needsHuman().length;
    $('#challenge-count').hidden = !pending;
    $('#challenge-count').textContent = String(pending);

    $('#mcp-dot').className = 'dot ' + (state.online ? 'ok' : 'bad');
    $('#mcp-state').textContent = state.online ? t("MCP 在线 · {0}", [state.info?.mcp ?? '']) : t("MCP 未连接（App 内核未启动或已退出）");
    if (!status) return;

    const card = $('#control-card');
    card.classList.toggle('paused', Boolean(status.paused));
    $('#control-title').textContent = status.paused ? t("AI 已暂停，浏览器由你控制") : status.busy ? t("AI 正在操作浏览器") : t("AI 可以操作浏览器");
    $('#control-sub').textContent = t("会话 {0} · {1} 个标签页 · 今日 {2} 次动作", [status.session, status.tabs, status.todayActions]);
    const pause = $('#pause-btn');
    pause.textContent = status.paused ? t("恢复 AI") : t("暂停 AI");
    pause.className = status.paused ? 'btn primary' : 'btn';

    if (document.activeElement !== $('#ambient-switch')) $('#ambient-switch').checked = Boolean(status.ambientMouse?.enabled);
    const slots = status.slots ? SLOT_ORDER.map(([slot, title, hint]) => {
      const data = status.slots[slot];
      if (!data) return '';
      const items = data.providers.map(provider => {
        const friendly = BUILTIN_NAMES[provider.id];
        return `<button class="model${provider.id === data.active ? ' on' : ''}" data-slot="${slot}" data-provider="${esc(provider.id)}"><span class="radio"></span><div><b>${esc(friendly || provider.id)} <small>v${esc(provider.version)}</small></b><span>${esc(friendly ? provider.id : provider.description)}${provider.runtime === 'external-process' ? t(" · 外部进程") : ''}</span></div></button>`;
      }).join('');
      return `<span class="slot-title">${title} <small class="muted">${hint}</small></span><div class="models">${items}</div>`;
    }).join('') : '';
    if ($('#slots').dataset.sig !== slots) { $('#slots').innerHTML = slots; $('#slots').dataset.sig = slots; }
  }

  async function post(path, body, message) {
    try { await shell.apiPost(path, body); if (message) toast(message); }
    catch (error) { toast(t("操作失败：") + (error?.message || error)); }
    await loadStatus();
    if (state.view !== 'settings') refreshPanel();
  }
  $('#pause-btn').addEventListener('click', () => post('/api/control', { paused: !state.status?.paused }, state.status?.paused ? t("已恢复 AI 自动化") : t("已暂停：AI 的所有操作会被拒绝")));
  const SLOT_ORDER = [['pointer', t("鼠标轨迹"), t("点击 / 悬停 / 游走")], ['keyboard', t("键盘输入"), t("打字节奏与纠错")], ['pacing', t("操作节奏"), t("AI 回得太快时补上人的反应时间")], ['idle', t("空闲行为"), t("AI 思考时指针做什么")], ['ocr', t("验证码识别"), t("本地优先，失败才交给 AI")], ['clipboard', t("剪贴板"), t("AI 复制粘贴走哪里")]];
  const BUILTIN_NAMES = {
    'action.pointer.bezier': t("内置贝塞尔轨迹"), 'action.keyboard.human': t("拟人打字（默认）"), 'action.keyboard.fast': t("快速输入"),
    'action.pacing.human': t("拟人节奏（默认）"), 'action.pacing.off': t("立即执行"), 'idle.adaptive': t("自适应（默认）"), 'idle.drift': t("只悬停不点击"), 'challenge.ocr.ddddocr': t("本地 ddddocr"),
    'action.clipboard.virtual': t("隔离（默认）"), 'action.clipboard.system': t("系统全局")
  };
  $('#slots').addEventListener('click', event => {
    const button = event.target.closest('[data-slot]');
    if (button && !button.classList.contains('on')) post('/api/settings', { slots: { [button.dataset.slot]: button.dataset.provider } }, t("已切换：") + (BUILTIN_NAMES[button.dataset.provider] || button.dataset.provider));
  });
  $('#ambient-switch').addEventListener('change', event => post('/api/settings', { ambientMouseEnabled: event.target.checked }, event.target.checked ? t("已开启自主鼠标游走") : t("已关闭自主鼠标游走")));
  $('#language').addEventListener('change', async event => {
    event.target.disabled = true;
    await post('/api/settings', { uiLanguage: event.target.value });
    event.target.value = I.locale;
    event.target.disabled = false;
  });
  $('#open-audit').addEventListener('click', () => shell.newTab(state.info.api + '/audit'));

  const commands = {};
  document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', () => { shell.copy(commands[button.dataset.copy] || ''); toast(t("已复制")); }));

  /* ---------------- activity timeline ---------------- */
  async function loadEvents() {
    try { state.events = await shell.apiGet(`/api/audit/events?limit=200&ambient=${state.showAmbient ? 1 : 0}`); }
    catch { state.events = []; }
    renderTimeline(false);
  }

  const ctx = () => ({ home: state.info?.home, api: state.info?.api });
  const host = L.host;

  function visibleEvents() {
    return L.collapseStarted(state.events).filter(event => event.action !== 'tabs.list'
      && (state.filter !== 'failure' || event.status === 'failure')
      && (state.filter !== 'act' || L.ACT_ACTIONS.includes(event.action)));
  }

  function renderTimeline(force = true) {
    if (state.view !== 'activity') return;
    const box = $('#timeline');
    const events = visibleEvents();
    const signature = [state.online, state.filter, events.length, events[0]?.id, events[0]?.timestamp, [...state.open].join(), state.details.size, Math.floor(Date.now() / 30000)].join('|');
    if (!force && signature === renderTimeline.signature) return;
    renderTimeline.signature = signature;
    if (!state.online) { box.innerHTML = ("<div class=\"empty\"><b>" + th("未连接到浏览器内核") + "</b>" + th("请用 npm run app 启动完整 App") + "</div>"); return; }
    if (!events.length) {
      box.innerHTML = `<div class="empty"><b>${state.filter === 'failure' ? t("没有失败的动作") : t("还没有 AI 操作")}</b>${th("AI 通过 MCP 打开网页、点击、读取时，每一步都会出现在这里，并能追溯到当时依据的页面快照。")}</div>`;
      return;
    }
    let html = '';
    let day = '';
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      const label = dayLabel(event.timestamp);
      if (label !== day) { day = label; html += `<div class="day">${esc(label)}</div>`; }
      if (event.action === 'mouse.ambient') {
        let end = index;
        while (events[end + 1]?.action === 'mouse.ambient') end++;
        const count = end - index + 1;
        html += `<div class="ambient-row">${icon('mouse')}${th("鼠标游走")} ${count} ${th("次 · 未点击 ·")} ${esc(when(events[end].timestamp))} – ${esc(when(event.timestamp))}</div>`;
        index = end;
        continue;
      }
      const info = L.describe(event, ctx());
      const where = L.place(event, ctx());
      const kind = event.status === 'failure' ? 'failure' : event.status === 'started' ? 'running' : event.action.startsWith('challenge.') ? 'challenge' : '';
      const open = state.open.has(event.id);
      html += `<div class="ev ${kind}${open ? ' open' : ''}" data-id="${esc(event.id)}">
        <span class="ico">${icon(info.icon)}</span>
        <div class="main"><div class="what">${esc(info.what)}${event.status === 'started' ? ' …' : ''}</div>${where ? `<div class="where">${esc(where)}</div>` : ''}${event.error ? `<div class="err">${esc(event.error.split('\n')[0].slice(0, 200))}</div>` : ''}</div>
        <span class="when" title="${esc(new Date(event.timestamp).toLocaleString(I.locale, { hour12: false }))}">${esc(when(event.timestamp))}</span>
        <div class="more">${open ? detailHtml(event) : ''}</div></div>`;
    }
    box.innerHTML = html;
  }

  function detailHtml(event) {
    const extra = state.details.get(event.id);
    const rows = [
      [t("会话"), event.session],
      [t("标签页"), event.pageId != null ? '#' + event.pageId : '—'],
      event.before?.url ? [t("操作前"), event.before.url] : null,
      event.after?.url && event.after.url !== event.before?.url ? [t("操作后"), event.after.url] : null,
      event.durationMs != null ? [t("耗时"), event.durationMs + ' ms'] : null,
      event.capabilities?.length ? [t("能力"), event.capabilities.map(cap => `${cap.id}@${cap.version}`).join(', ')] : null,
      event.basisSnapshotId ? [t("依据快照"), event.basisSnapshotId.slice(0, 8) + (event.basisSnapshotHash ? ' · sha256 ' + event.basisSnapshotHash.slice(0, 12) : '')] : null,
      [t("记录 ID"), event.id]
    ].filter(Boolean);
    let html = `<dl class="kv">${rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`;
    if (extra?.snapshot) {
      const lines = extra.snapshot.text.split('\n');
      const refLine = event.target?.ref ? lines.find(line => line.startsWith(`[ref=${event.target.ref}]`)) : '';
      if (refLine) html += `<div>${th("AI 当时操作的元素：")}<b>${esc(refLine.replace(/^\[ref=\w+\]\s*/, ''))}</b></div>`;
      html += `<div class="snap">${esc(lines.slice(0, 80).join('\n'))}${lines.length > 80 ? t("\n… 共 {0} 行", [lines.length]) : ''}</div>`;
    } else if (event.basisSnapshotId && !extra) html += ("<div class=\"muted\">" + th("正在加载快照…") + "</div>");
    html += `<p><button class="link" data-copy-id="${esc(event.id)}">${th("复制记录 ID")}</button></p>`;
    return html;
  }

  $('#timeline').addEventListener('click', async event => {
    const copy = event.target.closest('[data-copy-id]');
    if (copy) { shell.copy(copy.dataset.copyId); toast(t("已复制记录 ID")); return; }
    if (event.target.closest('.more') && window.getSelection()?.toString()) return;
    const row = event.target.closest('.ev');
    if (!row) return;
    const id = row.dataset.id;
    if (state.open.has(id)) state.open.delete(id); else state.open.add(id);
    renderTimeline();
    if (state.open.has(id) && !state.details.has(id)) {
      try { state.details.set(id, await shell.apiGet('/api/audit/events/' + encodeURIComponent(id))); }
      catch { state.details.set(id, {}); }
      renderTimeline();
    }
  });

  /* ---------------- challenges ---------------- */
  function stepState(job) {
    const order = ['ocr', 'ai', 'human'];
    const now = { detected: 'ocr', ocr_running: 'ocr', ai_recovery_required: 'ai', human_required: 'human', human_takeover: 'human' }[job.status];
    return order.map(step => {
      if (now) { const index = order.indexOf(now); return order.indexOf(step) < index ? 'done' : step === now ? 'now' : ''; }
      return job.status === 'resolved_unverified' ? 'done' : '';
    });
  }

  function renderChallenges() {
    const box = $('#challenges');
    if (!state.challenges.length) { box.innerHTML = ("<div class=\"empty\"><b>" + th("暂无验证挑战") + "</b>" + th("页面出现验证码时会自动处理，处理不了才会请你帮忙。") + "</div>"); return; }
    box.innerHTML = state.challenges.map(job => {
      const steps = stepState(job);
      const terminal = ['resolved_unverified', 'failed', 'cancelled'].includes(job.status);
      const actions = [
        `<button class="btn" data-focus="${esc(job.origin)}">${th("定位标签页")}</button>`,
        ['detected', 'ai_recovery_required', 'human_required'].includes(job.status) ? `<button class="btn primary" data-job="${esc(job.id)}" data-cmd="human_start">${th("我来处理")}</button>` : '',
        job.status === 'human_takeover' ? `<button class="btn primary" data-job="${esc(job.id)}" data-cmd="human_complete">${th("我已完成验证")}</button>` : '',
        !terminal ? `<button class="btn ghost danger" data-job="${esc(job.id)}" data-cmd="cancel">${th("取消")}</button>` : ''
      ].join('');
      return `<div class="card${job.status === 'human_required' ? ' need' : ''}">
        <div class="top"><span class="origin">${esc(host(job.origin))}</span><span class="status ${CHALLENGE_TONE[job.status] || ''}">${esc(CHALLENGE_LABEL[job.status] || job.status)}</span></div>
        <div class="steps"><span class="${steps[0]}">${th("本地 OCR")}</span><span class="${steps[1]}">${th("AI 处理")}</span><span class="${steps[2]}">${th("人工")}</span></div>
        <p>${esc(L.challengeDetail(job.detail))}</p>
        <div class="meta">${esc(KIND_LABEL[job.kind] || job.kind)} · ${th('识别尝试：OCR {0} · AI {1}', [job.ocrAttempts, job.aiAttempts])} · ${esc(when(job.updatedAt))}</div>
        <div class="actions">${actions}</div></div>`;
    }).join('');
  }
  $('#challenges').addEventListener('click', async event => {
    const focus = event.target.closest('[data-focus]');
    if (focus) { if (!(await shell.focusOrigin(focus.dataset.focus))) toast(t("没有找到对应的标签页")); return; }
    const button = event.target.closest('[data-cmd]');
    if (!button) return;
    const messages = { human_start: t("AI 已暂停这个页面，请在页面里完成验证"), human_complete: t("已交还 AI 继续任务"), cancel: t("已取消") };
    if (button.dataset.cmd === 'human_start') await shell.focusOrigin(state.challenges.find(job => job.id === button.dataset.job)?.origin || '');
    await post(`/api/challenges/${encodeURIComponent(button.dataset.job)}/${button.dataset.cmd}`, {}, messages[button.dataset.cmd]);
  });

  /* ---------------- loop ---------------- */
  function refreshPanel(force) {
    if (document.body.classList.contains('panel-closed')) return;
    if (state.view === 'activity') {
      // Re-read the timeline only when the ledger moved (idle behaviour counts only when it is shown).
      const seq = state.showAmbient ? state.status?.sequence : state.status?.agentSequence;
      if (force === true || seq === undefined || seq !== state.timelineSeq || state.timelineAmbient !== state.showAmbient) {
        state.timelineSeq = seq;
        state.timelineAmbient = state.showAmbient;
        loadEvents();
      } else renderTimeline(false);
    }
    if (state.view === 'challenges') renderChallenges();
  }

  async function init() {
    state.info = await shell.info();
    commands.mcp = state.info.mcp;
    commands.claude = `claude mcp add --transport http waymark ${state.info.mcp}`;
    commands.codex = `[mcp_servers.waymark]\nurl = "${state.info.mcp}"`;
    $('#mcp-url').textContent = commands.mcp;
    $('#cmd-claude').textContent = commands.claude;
    $('#cmd-codex').textContent = commands.codex.replace('\n', '  ');
    renderFilters();
    setView(state.view);
    applyPanel(await shell.getPanel());
    state.tabs = await shell.list();
    renderTabs();
    renderToolbar();
    await loadStatus();
    refreshPanel();
    setInterval(async () => { await loadStatus(); refreshPanel(); }, 2000);
  }
  init();
})();
