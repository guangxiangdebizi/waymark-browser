import type { AppConfig } from '../types.js';
import { themeCss } from './theme.js';

const DEFAULT_LINKS = [
  { name: 'Google', url: 'https://www.google.com/', color: '#4285f4' },
  { name: '必应', url: 'https://www.bing.com/', color: '#0c8484' },
  { name: 'GitHub', url: 'https://github.com/', color: '#24292f' },
  { name: 'Wikipedia', url: 'https://www.wikipedia.org/', color: '#636466' },
  { name: '溯源记录', url: '/audit', color: '#5b5bd6' }
];

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const safeColor = (value?: string) => value && /^#[0-9a-f]{3,8}$/i.test(value) ? value : '#5b5bd6';
const safeUrl = (value: string) => /^(https?:\/\/|\/)/i.test(value) ? value : '#';

export function homeHtml(config: AppConfig): string {
  const mcp = `http://${config.server.host}:${config.server.port}/mcp`;
  const links = (config.home?.quickLinks?.length ? config.home.quickLinks : DEFAULT_LINKS).slice(0, 15).map(link => {
    const label = escapeHtml(('icon' in link && link.icon) || Array.from(link.name)[0] || '?');
    return `<a class="quick" href="${escapeHtml(safeUrl(link.url))}"><span class="qi" style="background:${safeColor(link.color)}">${label}</span><span>${escapeHtml(link.name)}</span></a>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>新标签页</title><link rel="icon" href="data:,"><style>${themeCss}
body{min-height:100vh;background:radial-gradient(1200px 500px at 50% -120px,var(--accent-soft),transparent 70%),var(--bg)}
main{max-width:860px;margin:0 auto;padding:9vh 24px 48px}
.hero{display:flex;flex-direction:column;align-items:center;gap:10px;margin-bottom:28px}
.hero .logo{width:56px;height:56px;border-radius:16px;font-size:26px}
.quicks:has(.quick:nth-child(-n+5):last-child){grid-template-columns:repeat(auto-fit,minmax(110px,1fr))}
.hero h1{margin:6px 0 0;font-size:26px;font-weight:650;letter-spacing:.2px}
.hero p{margin:0;color:var(--text-2)}
form{display:flex;align-items:center;gap:10px;height:52px;padding:0 8px 0 20px;border-radius:26px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow);transition:border-color .15s,box-shadow .15s}
form:focus-within{border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
form svg{color:var(--text-3);width:18px;height:18px}
#q{flex:1;min-width:0;border:0;outline:0;background:transparent;font-size:16px;color:var(--text)}
form .btn{height:38px;border-radius:19px;padding:0 18px}
.quicks{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:26px 0 30px}
.quick{display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px 6px;border-radius:12px;color:var(--text-2);text-decoration:none;font-size:12.5px;transition:background .12s}
.quick:hover{background:var(--surface)}
.qi{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;color:#fff;font-weight:700;font-size:16px;box-shadow:var(--shadow)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.card{padding:16px 18px}
.card h3{margin:0 0 12px;font-size:13px;color:var(--text-3);font-weight:600}
.stat{display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line)}
.stat:last-child{border-bottom:0}
.stat span:first-child{color:var(--text-2)}
.stat b{font-weight:600;display:flex;align-items:center;gap:8px}
.copy{display:flex;align-items:center;gap:8px;padding:6px 6px 6px 12px;border-radius:9px;background:var(--surface-2);margin-bottom:8px}
.copy code{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.copy .btn{height:28px;padding:0 10px;font-size:12px}
.small{font-size:12px;color:var(--text-3);margin:10px 0 6px}
.recent{list-style:none;margin:0;padding:0}
.recent li{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);font-size:13px}
.recent li:last-child{border-bottom:0}
.recent .ico{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;background:var(--surface-2);color:var(--text-2)}
.recent .ico svg{width:13px;height:13px}
.recent .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.recent .w{color:var(--text-3);font-size:12px;white-space:nowrap}
.wide{grid-column:1/3}
@media(max-width:720px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}.quicks{grid-template-columns:repeat(4,1fr)}}
</style></head><body><main>
<section class="hero"><div class="logo">W</div><h1>Waymark</h1><p>给 AI 用的浏览器 · 你和 AI 共用同一个窗口，每一步都可追溯</p></section>
<form id="search"><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/></svg><input id="q" placeholder="搜索必应，或输入网址" autofocus autocomplete="off" spellcheck="false"><button class="btn primary">前往</button></form>
<nav class="quicks">${links}</nav>
<section class="grid">
  <div class="card"><h3>浏览器状态</h3>
    <div class="stat"><span>AI 控制</span><b id="s-ai"><span class="dot"></span>读取中</b></div>
    <div class="stat"><span>剪贴板</span><b id="s-clip">—</b></div>
    <div class="stat"><span>自主鼠标游走</span><b id="s-mouse">—</b></div>
    <div class="stat"><span>今日 AI 动作</span><b id="s-today">—</b></div>
    <div class="stat"><span>待处理验证</span><b id="s-ch">—</b></div>
  </div>
  <div class="card"><h3>让 AI 连接这个浏览器</h3>
    <div class="copy"><code id="c-mcp">${mcp}</code><button class="btn" data-copy="c-mcp">复制</button></div>
    <div class="small">Claude Code 一行添加</div>
    <div class="copy"><code id="c-claude">claude mcp add --transport http waymark ${mcp}</code><button class="btn" data-copy="c-claude">复制</button></div>
    <div class="small">Codex：写入 ~/.codex/config.toml</div>
    <div class="copy"><code id="c-codex">[mcp_servers.waymark] url = "${mcp}"</code><button class="btn" data-copy="c-codex" data-text="[mcp_servers.waymark]&#10;url = &quot;${mcp}&quot;">复制</button></div>
  </div>
  <div class="card wide"><h3>AI 最近在做什么</h3><ul class="recent" id="recent"><li class="muted">读取中…</li></ul></div>
</section>
</main>
<script src="/assets/labels.js"></script>
<script>
(function(){
  var L = window.AgentLabels;
  var ctx = { home: location.origin + '/home', api: location.origin };
  document.getElementById('search').addEventListener('submit', function(event){
    event.preventDefault();
    var value = document.getElementById('q').value.trim();
    if (!value) return;
    var url;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) url = value;
    else if (/^(localhost|\\d{1,3}(\\.\\d{1,3}){3})(:\\d+)?(\\/|$)/.test(value)) url = 'http://' + value;
    else if (!/\\s/.test(value) && /^[^\\s/]+\\.[a-z]{2,}(:\\d+)?(\\/.*)?$/i.test(value)) url = 'https://' + value;
    else url = 'https://www.bing.com/search?q=' + encodeURIComponent(value);
    location.href = url;
  });
  document.querySelectorAll('[data-copy]').forEach(function(button){
    button.addEventListener('click', function(){
      var text = button.dataset.text || document.getElementById(button.dataset.copy).textContent;
      navigator.clipboard.writeText(text).then(function(){ button.textContent = '已复制'; setTimeout(function(){ button.textContent = '复制'; }, 1500); });
    });
  });
  function load(){
    fetch('/api/status').then(function(r){ return r.json(); }).then(function(s){
      var pending = (s.challenges || []).filter(function(j){ return ['human_required','ai_recovery_required','detected'].indexOf(j.status) >= 0; }).length;
      document.getElementById('s-ai').innerHTML = s.paused ? '<span class="dot warn"></span>已暂停（由你控制）' : s.busy ? '<span class="dot ok"></span>正在操作' : '<span class="dot ok"></span>就绪';
      document.getElementById('s-clip').textContent = String(s.clipboardProvider).indexOf('virtual') >= 0 ? '隔离（默认）' : '系统全局';
      document.getElementById('s-mouse').textContent = s.ambientMouse && s.ambientMouse.enabled ? '开启 · 只悬停不点击' : '关闭';
      document.getElementById('s-today').textContent = s.todayActions + ' 次';
      document.getElementById('s-ch').innerHTML = pending ? '<span class="status warn">' + pending + ' 个需要处理</span>' : '<span class="status ok">无</span>';
    }).catch(function(){ document.getElementById('s-ai').innerHTML = '<span class="dot bad"></span>内核未连接'; });
    fetch('/api/audit/events?limit=60&ambient=0').then(function(r){ return r.json(); }).then(function(events){
      var rows = L.collapseStarted(events).filter(function(e){ return L.ACT_ACTIONS.indexOf(e.action) >= 0; }).slice(0, 6);
      document.getElementById('recent').innerHTML = rows.length ? rows.map(function(e){
        var d = L.describe(e, ctx), where = L.place(e, ctx);
        return '<li><span class="ico">' + L.icon(d.icon) + '</span><span class="t">' + L.esc(d.what) + (where ? ' <span class="muted">· ' + L.esc(where) + '</span>' : '') + '</span>' + (e.status === 'failure' ? '<span class="status failure">失败</span>' : '') + '<span class="w">' + L.esc(L.when(e.timestamp)) + '</span></li>';
      }).join('') : '<li class="muted">还没有 AI 操作。把上面的 MCP 地址交给 AI，它打开的每个页面、每次点击都会记在这里。</li>';
    }).catch(function(){});
  }
  load(); setInterval(load, 5000);
})();
</script></body></html>`;
}
