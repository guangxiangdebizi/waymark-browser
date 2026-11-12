import { themeCss } from './theme.js';

export function dashboardHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waymark · 溯源记录</title><style>${themeCss}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:12px 24px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
header .logo{width:30px;height:30px;border-radius:9px;font-size:14px}
header .title{display:flex;flex-direction:column;line-height:1.25}
header .title b{font-size:15px}
header .title span{font-size:12px;color:var(--text-3)}
header .spacer{flex:1}
header label{display:flex;align-items:center;gap:6px;color:var(--text-2);font-size:13px}
select,input[type=search]{height:32px;border-radius:8px;border:1px solid var(--line-2);background:var(--surface);padding:0 10px;outline:0}
select:focus,input[type=search]:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
input[type=checkbox]{accent-color:var(--accent)}
#health{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-3)}
main{max-width:1440px;margin:0 auto;padding:18px 24px 40px}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
.tile{padding:14px 16px}
.tile span{display:block;color:var(--text-3);font-size:12px}
.tile b{display:block;font-size:22px;font-weight:650;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile.small b{font-size:15px;margin-top:8px}
.filters{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.filters input[type=search]{flex:1;min-width:220px}
.filters .count{color:var(--text-3);font-size:12px;margin-left:auto}
.layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,38%);gap:16px;align-items:start}
.list{overflow:hidden}
.day{padding:10px 16px 6px;font-size:12px;color:var(--text-3);background:var(--surface-2);border-bottom:1px solid var(--line)}
.row{display:grid;grid-template-columns:70px 30px minmax(0,1.1fr) minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 16px;border-bottom:1px solid var(--line);cursor:pointer}
.row:hover{background:var(--surface-2)}
.row.sel{background:var(--accent-soft)}
.row .time{font-family:"Cascadia Mono",Consolas,monospace;font-size:12px;color:var(--text-3)}
.row .ico{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;background:var(--surface-2);color:var(--text-2)}
.row.failure .ico{background:var(--bad-soft);color:var(--bad)}
.row.challenge .ico{background:var(--warn-soft);color:var(--warn)}
.row .ico svg{width:14px;height:14px}
.row .what{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .what small{display:block;font-weight:400;color:var(--bad);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .where{color:var(--text-2);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .right{display:flex;align-items:center;gap:8px;justify-content:flex-end}
.row .dur{font-size:12px;color:var(--text-3);min-width:52px;text-align:right}
.ambient{display:flex;align-items:center;gap:8px;padding:7px 16px 7px 96px;border-bottom:1px solid var(--line);color:var(--text-3);font-size:12px}
.ambient svg{width:13px;height:13px}
.side{position:sticky;top:76px;display:flex;flex-direction:column;gap:14px;max-height:calc(100vh - 92px);overflow:auto}
.side .card{padding:16px 18px}
.side h3{margin:0 0 10px;font-size:13px;color:var(--text-3);font-weight:600}
.kv{display:grid;grid-template-columns:76px 1fr;gap:6px 10px;margin:0;font-size:13px}
.kv dt{color:var(--text-3)}
.kv dd{margin:0;word-break:break-all}
.snap{margin:12px 0 0;max-height:420px;overflow:auto;padding:10px 12px;border-radius:9px;background:var(--surface-2);font:12px/1.55 "Cascadia Mono",Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.snap mark{background:var(--warn-soft);color:var(--warn);border-radius:3px;padding:0 2px}
.job{padding:12px 0;border-bottom:1px solid var(--line)}
.job:last-child{border-bottom:0;padding-bottom:0}
.job:first-child{padding-top:0}
.job .top{display:flex;justify-content:space-between;gap:8px;font-weight:600}
.job p{margin:6px 0 8px;font-size:12.5px;color:var(--text-2)}
.job .btns{display:flex;gap:6px}
.job .btn{height:28px;font-size:12.5px}
.empty{padding:50px 20px;text-align:center;color:var(--text-3)}
.more{display:block;width:100%;height:40px;border:0;background:transparent;color:var(--accent-text);cursor:pointer}
@media(max-width:1180px){.row{grid-template-columns:62px 30px minmax(0,1fr) auto}.row .where{display:none}}
@media(max-width:860px){.layout{grid-template-columns:1fr}.side{position:static;max-height:none}.tiles{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<header><div class="logo">W</div><div class="title"><b>溯源记录</b><span>AI 在什么时候、基于哪个页面、做了什么</span></div><div class="spacer"></div>
<label>剪贴板 <select id="clipboard"><option value="action.clipboard.virtual">隔离（默认）</option><option value="action.clipboard.system">系统全局</option></select></label>
<label><input type="checkbox" id="ambient"> 自动鼠标游走（不点击）</label>
<button class="btn" id="pause">暂停 AI</button>
<span id="health"><span class="dot"></span><span id="health-text">loading</span></span></header>
<main>
<section class="tiles">
  <div class="card tile"><span>今日动作</span><b id="t-today">—</b></div>
  <div class="card tile"><span>今日失败</span><b id="t-fail">—</b></div>
  <div class="card tile small"><span>当前会话</span><b id="t-session">—</b></div>
  <div class="card tile"><span>待处理验证</span><b id="t-ch">—</b></div>
</section>
<section class="filters">
  <input type="search" id="q" placeholder="搜索网址、标题、会话、错误或记录 ID">
  <select id="f-action"><option value="">全部动作</option><option value="navigate">打开 / 导航</option><option value="click">点击</option><option value="fill">填写</option><option value="paste">粘贴</option><option value="read">读取</option><option value="snapshot">快照</option><option value="tabs">标签页</option><option value="challenge">验证挑战</option><option value="settings">设置变更</option><option value="mouse.ambient">鼠标游走</option></select>
  <select id="f-status"><option value="">全部状态</option><option value="success">成功</option><option value="failure">失败</option><option value="info">记录</option></select>
  <label class="muted"><input type="checkbox" id="f-ambient"> 显示鼠标游走</label>
  <span class="count" id="count"></span>
</section>
<section class="layout">
  <div class="card list" id="events"><div class="empty">读取中…</div></div>
  <aside class="side">
    <div class="card"><h3>验证挑战</h3><div id="challenges"></div></div>
    <div class="card"><h3>溯源详情</h3><div id="detail" class="muted">选择左侧一条记录，查看 AI 当时依据的页面快照</div></div>
  </aside>
</section>
</main>
<script src="/assets/labels.js"></script>
<script>
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
function timeOf(ts) { return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }); }
function renderEvents(events) {
  var rows = L.collapseStarted(events).filter(function (e) { return e.action !== 'tabs.list' || q('f-action').value === 'tabs'; });
  q('count').textContent = '显示 ' + rows.length + ' 条';
  if (!rows.length) { q('events').innerHTML = '<div class="empty">没有符合条件的记录</div>'; return; }
  var html = '', day = '';
  for (var i = 0; i < rows.length; i++) {
    var e = rows[i];
    var label = L.dayLabel(e.timestamp);
    if (label !== day) { day = label; html += '<div class="day">' + esc(label) + '</div>'; }
    if (e.action === 'mouse.ambient' && q('f-action').value !== 'mouse.ambient') {
      var end = i;
      while (rows[end + 1] && rows[end + 1].action === 'mouse.ambient') end++;
      html += '<div class="ambient">' + L.icon('mouse') + '鼠标游走 ' + (end - i + 1) + ' 次，未点击 · ' + timeOf(rows[end].timestamp) + ' – ' + timeOf(e.timestamp) + '</div>';
      i = end;
      continue;
    }
    var d = L.describe(e, ctx), where = L.place(e, ctx);
    var kind = e.status === 'failure' ? 'failure' : e.action.indexOf('challenge.') === 0 ? 'challenge' : '';
    html += '<div class="row ' + kind + (selected === e.id ? ' sel' : '') + '" data-id="' + esc(e.id) + '">' +
      '<span class="time">' + timeOf(e.timestamp) + '</span><span class="ico">' + L.icon(d.icon) + '</span>' +
      '<span class="what">' + esc(d.what) + (e.error ? '<small>' + esc(String(e.error).split('\\n')[0]) + '</small>' : '') + '</span>' +
      '<span class="where">' + esc(where) + '</span>' +
      '<span class="right"><span class="status info">' + esc(e.session) + '</span><span class="status ' + esc(e.status) + '">' + esc(L.STATUS_LABEL[e.status] || e.status) + '</span><span class="dur">' + (e.durationMs != null ? e.durationMs + ' ms' : '') + '</span></span></div>';
  }
  if (events.length >= limit) html += '<button class="more" id="more">加载更早的记录</button>';
  q('events').innerHTML = html;
  q('events').querySelectorAll('.row').forEach(function (el) { el.addEventListener('click', function () { detail(el.dataset.id); }); });
  if (q('more')) q('more').addEventListener('click', function () { limit = Math.min(limit + 200, 500); load(); });
}
function renderChallenges(jobs) {
  q('challenges').innerHTML = jobs.length ? jobs.map(function (j) {
    var buttons = '';
    if (['detected', 'ai_recovery_required', 'human_required'].indexOf(j.status) >= 0) buttons += '<button class="btn primary" data-human="human_start" data-id="' + esc(j.id) + '">人工接管</button>';
    if (j.status === 'human_takeover') buttons += '<button class="btn primary" data-human="human_complete" data-id="' + esc(j.id) + '">接管完成</button>';
    if (['resolved_unverified', 'failed', 'cancelled'].indexOf(j.status) < 0) buttons += '<button class="btn" data-human="cancel" data-id="' + esc(j.id) + '">取消</button>';
    return '<div class="job"><div class="top"><span>' + esc(L.host(j.origin)) + '</span><span class="status ' + (L.CHALLENGE_TONE[j.status] || '') + '">' + esc(L.CHALLENGE_LABEL[j.status] || j.status) + '</span></div>' +
      '<p>' + esc(L.KIND_LABEL[j.kind] || j.kind) + ' · OCR ' + j.ocrAttempts + ' 次 · AI ' + j.aiAttempts + ' 次 · ' + esc(L.challengeDetail(j.detail)) + '</p><div class="btns">' + buttons + '</div></div>';
  }).join('') : '<div class="muted">无挑战任务</div>';
  q('challenges').querySelectorAll('[data-human]').forEach(function (el) { el.addEventListener('click', function () { post('/api/challenges/' + el.dataset.id + '/' + el.dataset.human).then(load).catch(reportLoadError); }); });
}
function renderStatus(s) {
  lastStatus = s;
  var clipboard = q('clipboard'), ambient = q('ambient');
  if (document.activeElement !== clipboard) clipboard.value = s.clipboardProvider;
  if (document.activeElement !== ambient) ambient.checked = s.ambientMouse.enabled;
  q('pause').textContent = s.paused ? '恢复 AI' : '暂停 AI';
  q('pause').className = s.paused ? 'btn primary' : 'btn';
  q('health').firstChild.className = 'dot ' + (s.paused ? 'warn' : 'ok');
  q('health-text').textContent = 'MCP 127.0.0.1 · ' + (s.paused ? 'AI 已暂停 · ' : '') + new Date().toLocaleTimeString('zh-CN', { hour12: false });
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
    var e = d.event, rows = [['动作', L.describe(e, ctx).what], ['时间', new Date(e.timestamp).toLocaleString('zh-CN', { hour12: false })], ['会话', e.session], ['状态', L.STATUS_LABEL[e.status] || e.status], ['标签页', e.pageId != null ? '#' + e.pageId : '—']];
    if (e.before && e.before.url) rows.push(['操作前', (e.before.title ? e.before.title + ' · ' : '') + e.before.url]);
    if (e.after && e.after.url) rows.push(['操作后', (e.after.title ? e.after.title + ' · ' : '') + e.after.url]);
    if (e.durationMs != null) rows.push(['耗时', e.durationMs + ' ms']);
    if (e.capabilities && e.capabilities.length) rows.push(['能力', e.capabilities.map(function (c) { return c.id + '@' + c.version; }).join(', ')]);
    if (e.target) rows.push(['目标', JSON.stringify(e.target)]);
    if (e.detail) rows.push(['附加', JSON.stringify(e.detail)]);
    if (e.error) rows.push(['错误', e.error]);
    if (e.basisSnapshotId) rows.push(['依据快照', e.basisSnapshotId + (e.basisSnapshotHash ? '\\nsha256 ' + e.basisSnapshotHash : '')]);
    rows.push(['记录 ID', e.id]);
    var html = '<dl class="kv">' + rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]).replace(/\\n/g, '<br>') + '</dd>'; }).join('') + '</dl>';
    if (d.snapshot) {
      var ref = e.target && e.target.ref ? '[ref=' + e.target.ref + ']' : null;
      html += '<pre class="snap">' + d.snapshot.text.split('\\n').map(function (line) { return ref && line.indexOf(ref + ' ') === 0 ? '<mark>' + esc(line) + '</mark>' : esc(line); }).join('\\n') + '</pre>';
    }
    q('detail').className = '';
    q('detail').innerHTML = html;
    var mark = q('detail').querySelector('mark');
    if (mark) mark.parentElement.scrollTop = mark.offsetTop - mark.parentElement.offsetTop - mark.parentElement.clientHeight / 2;
  }).catch(reportLoadError);
}
function saveSettings() { return post('/api/settings', { clipboardProvider: q('clipboard').value, ambientMouseEnabled: q('ambient').checked }).then(load); }
function reportLoadError(error) { q('health-text').textContent = '加载失败: ' + (error && error.message || error); console.error(error); }
var searchTimer;
q('q').addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(function () { load().catch(reportLoadError); }, 250); });
['f-action', 'f-status', 'f-ambient'].forEach(function (id) { q(id).addEventListener('change', function () { load().catch(reportLoadError); }); });
q('clipboard').addEventListener('change', function () { saveSettings().catch(reportLoadError); });
q('ambient').addEventListener('change', function () { saveSettings().catch(reportLoadError); });
q('pause').addEventListener('click', function () { post('/api/control', { paused: !(lastStatus && lastStatus.paused) }).then(load).catch(reportLoadError); });
load().catch(reportLoadError);
setInterval(function () { if (!document.hidden) load().catch(reportLoadError); }, 4000);
</script></body></html>`;
}
