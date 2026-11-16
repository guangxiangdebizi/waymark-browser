var I = window.WaymarkI18n, t = I.t, th = I.th;
var L = window.AgentLabels;
var ctx = { home: location.origin + '/home', api: location.origin };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var limit = 200, selected = null, lastStatus = null;
function q(id) { return document.getElementById(id); }
function json(url, options) { return fetch(url, options).then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status)); return data; }); }); }
function post(url, body) { return json(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); }
function eventsUrl() {
  var params = new URLSearchParams({ limit: String(limit) });
  var action = q('f-action').value;
  if (action) params.set('action', action);
  if (q('f-status').value) params.set('status', q('f-status').value);
  if (q('q').value.trim()) params.set('q', q('q').value.trim());
  params.set('ambient', q('f-ambient').checked || action === 'mouse.ambient' ? '1' : '0');
  return '/api/audit/events?' + params.toString();
}
function timeOf(ts) { return new Date(ts).toLocaleTimeString(I.locale, { hour12: false }); }
function renderEvents(events) {
  var rows = L.collapseStarted(events).filter(function (e) { return e.action !== 'tabs.list' || q('f-action').value === 'tabs'; });
  q('count').textContent = t("显示 ") + rows.length + t(" 条");
  if (!rows.length) { q('events').innerHTML = ("<div class=\"empty\">" + th("没有符合条件的记录") + "</div>"); return; }
  var html = '', day = '';
  for (var i = 0; i < rows.length; i++) {
    var e = rows[i];
    var label = L.dayLabel(e.timestamp);
    if (label !== day) { day = label; html += '<div class="day">' + esc(label) + '</div>'; }
    if (e.action === 'mouse.ambient' && q('f-action').value !== 'mouse.ambient') {
      var end = i;
      while (rows[end + 1] && rows[end + 1].action === 'mouse.ambient') end++;
      html += '<div class="ambient">' + L.icon('mouse') + t("鼠标游走 ") + (end - i + 1) + t(" 次，未点击 · ") + timeOf(rows[end].timestamp) + ' – ' + timeOf(e.timestamp) + '</div>';
      i = end;
      continue;
    }
    var d = L.describe(e, ctx), where = L.place(e, ctx);
    var kind = e.status === 'failure' ? 'failure' : e.action.indexOf('challenge.') === 0 ? 'challenge' : '';
    html += '<div class="row ' + kind + (selected === e.id ? ' sel' : '') + '" data-id="' + esc(e.id) + '">' +
      '<span class="time">' + timeOf(e.timestamp) + '</span><span class="ico">' + L.icon(d.icon) + '</span>' +
      '<span class="what">' + esc(d.what) + (e.error ? '<small>' + esc(String(e.error).split('\n')[0]) + '</small>' : '') + '</span>' +
      '<span class="where">' + esc(where) + '</span>' +
      '<span class="right"><span class="status info">' + esc(e.session) + '</span><span class="status ' + esc(e.status) + '">' + esc(L.STATUS_LABEL[e.status] || e.status) + '</span><span class="dur">' + (e.durationMs != null ? e.durationMs + ' ms' : '') + '</span></span></div>';
  }
  if (events.length >= limit) html += ("<button class=\"more\" id=\"more\">" + th("加载更早的记录") + "</button>");
  q('events').innerHTML = html;
  q('events').querySelectorAll('.row').forEach(function (el) { el.addEventListener('click', function () { detail(el.dataset.id); }); });
  if (q('more')) q('more').addEventListener('click', function () { limit = Math.min(limit + 200, 500); load(); });
}
function renderChallenges(jobs) {
  q('challenges').innerHTML = jobs.length ? jobs.map(function (j) {
    var buttons = '';
    if (['detected', 'ai_recovery_required', 'human_required'].indexOf(j.status) >= 0) buttons += '<button class="btn primary" data-human="human_start" data-id="' + esc(j.id) + ("\">" + th("人工接管") + "</button>");
    if (j.status === 'human_takeover') buttons += '<button class="btn primary" data-human="human_complete" data-id="' + esc(j.id) + ("\">" + th("接管完成") + "</button>");
    if (['resolved_unverified', 'failed', 'cancelled'].indexOf(j.status) < 0) buttons += '<button class="btn" data-human="cancel" data-id="' + esc(j.id) + ("\">" + th("取消") + "</button>");
    return '<div class="job"><div class="top"><span>' + esc(L.host(j.origin)) + '</span><span class="status ' + (L.CHALLENGE_TONE[j.status] || '') + '">' + esc(L.CHALLENGE_LABEL[j.status] || j.status) + '</span></div>' +
      '<p>' + esc(L.KIND_LABEL[j.kind] || j.kind) + ' · ' + th('识别尝试：OCR {0} · AI {1}', [j.ocrAttempts, j.aiAttempts]) + ' · ' + esc(L.challengeDetail(j.detail)) + '</p><div class="btns">' + buttons + '</div></div>';
  }).join('') : ("<div class=\"muted\">" + th("无挑战任务") + "</div>");
  q('challenges').querySelectorAll('[data-human]').forEach(function (el) { el.addEventListener('click', function () { post('/api/challenges/' + el.dataset.id + '/' + el.dataset.human).then(load).catch(reportLoadError); }); });
}
function renderStatus(s) {
  if (s.uiLanguage && s.uiLanguage !== I.locale) { location.reload(); return; }
  lastStatus = s;
  var clipboard = q('clipboard'), ambient = q('ambient');
  if (document.activeElement !== clipboard) clipboard.value = s.clipboardProvider;
  if (document.activeElement !== ambient) ambient.checked = s.ambientMouse.enabled;
  q('pause').textContent = s.paused ? t("恢复 AI") : t("暂停 AI");
  q('pause').className = s.paused ? 'btn primary' : 'btn';
  q('health').firstChild.className = 'dot ' + (s.paused ? 'warn' : 'ok');
  q('health-text').textContent = 'MCP 127.0.0.1 · ' + (s.paused ? t("AI 已暂停 · ") : '') + new Date().toLocaleTimeString(I.locale, { hour12: false });
  q('t-today').textContent = s.todayActions;
  q('t-session').textContent = s.session;
  var pending = s.challenges.filter(function (j) { return ['human_required', 'ai_recovery_required', 'detected'].indexOf(j.status) >= 0; }).length;
  q('t-ch').textContent = pending;
  renderChallenges(s.challenges);
}
function load() {
  var today = new Date().toISOString().slice(0, 10);
  return Promise.all([json(eventsUrl()), json('/api/status'), json('/api/audit/events?limit=500&status=failure&ambient=0')]).then(function (r) {
    renderStatus(r[1]);
    renderEvents(r[0]);
    q('t-fail').textContent = r[2].filter(function (e) { return e.timestamp.indexOf(today) === 0; }).length;
  });
}
function detail(id) {
  selected = id;
  document.querySelectorAll('.row').forEach(function (el) { el.classList.toggle('sel', el.dataset.id === id); });
  json('/api/audit/events/' + encodeURIComponent(id)).then(function (d) {
    var e = d.event, rows = [[t("动作"), L.describe(e, ctx).what], [t("时间"), new Date(e.timestamp).toLocaleString(I.locale, { hour12: false })], [t("会话"), e.session], [t("状态"), L.STATUS_LABEL[e.status] || e.status], [t("标签页"), e.pageId != null ? '#' + e.pageId : '—']];
    if (e.before && e.before.url) rows.push([t("操作前"), (e.before.title ? e.before.title + ' · ' : '') + e.before.url]);
    if (e.after && e.after.url) rows.push([t("操作后"), (e.after.title ? e.after.title + ' · ' : '') + e.after.url]);
    if (e.durationMs != null) rows.push([t("耗时"), e.durationMs + ' ms']);
    if (e.capabilities && e.capabilities.length) rows.push([t("能力"), e.capabilities.map(function (c) { return c.id + '@' + c.version; }).join(', ')]);
    if (e.target) rows.push([t("目标"), JSON.stringify(e.target)]);
    if (e.detail) rows.push([t("附加"), JSON.stringify(e.detail)]);
    if (e.error) rows.push([t("错误"), e.error]);
    if (e.basisSnapshotId) rows.push([t("依据快照"), e.basisSnapshotId + (e.basisSnapshotHash ? '\nsha256 ' + e.basisSnapshotHash : '')]);
    rows.push([t("记录 ID"), e.id]);
    var html = '<dl class="kv">' + rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]).replace(/\n/g, '<br>') + '</dd>'; }).join('') + '</dl>';
    if (d.snapshot) {
      var ref = e.target && e.target.ref ? '[ref=' + e.target.ref + ']' : null;
      html += '<pre class="snap">' + d.snapshot.text.split('\n').map(function (line) { return ref && line.indexOf(ref + ' ') === 0 ? '<mark>' + esc(line) + '</mark>' : esc(line); }).join('\n') + '</pre>';
    }
    q('detail').className = '';
    q('detail').innerHTML = html;
    var mark = q('detail').querySelector('mark');
    if (mark) mark.parentElement.scrollTop = mark.offsetTop - mark.parentElement.offsetTop - mark.parentElement.clientHeight / 2;
  }).catch(reportLoadError);
}
function saveSettings() { return post('/api/settings', { clipboardProvider: q('clipboard').value, ambientMouseEnabled: q('ambient').checked }).then(load); }
function reportLoadError(error) { q('health-text').textContent = t("加载失败: ") + (error && error.message || error); console.error(error); }
var searchTimer;
q('q').addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(function () { load().catch(reportLoadError); }, 250); });
['f-action', 'f-status', 'f-ambient'].forEach(function (id) { q(id).addEventListener('change', function () { load().catch(reportLoadError); }); });
q('clipboard').addEventListener('change', function () { saveSettings().catch(reportLoadError); });
q('ambient').addEventListener('change', function () { saveSettings().catch(reportLoadError); });
q('language').addEventListener('change', function () {
  q('language').disabled = true;
  post('/api/settings', { uiLanguage: q('language').value }).then(function () { location.reload(); }).catch(function (error) {
    q('language').value = I.locale; q('language').disabled = false; reportLoadError(error);
  });
});
q('pause').addEventListener('click', function () { post('/api/control', { paused: !(lastStatus && lastStatus.paused) }).then(load).catch(reportLoadError); });
load().catch(reportLoadError);
setInterval(function () { if (!document.hidden) load().catch(reportLoadError); }, 4000);
