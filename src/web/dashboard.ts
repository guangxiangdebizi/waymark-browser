import { themeCss } from './theme.js';
import { normalizeLanguage } from '../i18n.js';

export function dashboardHtml(locale = 'en'): string {
  return `<!doctype html><html lang="${normalizeLanguage(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waymark · 溯源记录</title><style>${themeCss}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:12px 24px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
header .logo{width:30px;height:30px;border-radius:9px;font-size:14px}
header .title{display:flex;flex-direction:column;line-height:1.25}
header .title b{font-size:15px}
header .title span{font-size:12px;color:var(--text-3)}
header .spacer{flex:1}
header{flex-wrap:wrap}header label{flex-shrink:0}
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
@media(max-width:480px){header{padding:12px;gap:10px}main{padding:14px 12px}.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.tile{min-width:0}.row{grid-template-columns:42px 24px minmax(0,1fr);padding:9px 10px;gap:8px}.row .right{grid-column:3;justify-content:flex-start;flex-wrap:wrap}.side{min-width:0}.filters input[type=search]{min-width:0;flex-basis:100%}.filters select{max-width:100%}.ambient{padding-left:12px}.kv{grid-template-columns:65px minmax(0,1fr)}}
</style></head><body>
<header><div class="logo">W</div><div class="title"><b>溯源记录</b><span>AI 在什么时候、基于哪个页面、做了什么</span></div><div class="spacer"></div>
<label>剪贴板 <select id="clipboard"><option value="action.clipboard.virtual">隔离（默认）</option><option value="action.clipboard.system">系统全局</option></select></label>
<label><input type="checkbox" id="ambient"> 自动鼠标游走（不点击）</label>
<button class="btn" id="pause">暂停 AI</button>
<label>语言 <select id="language" data-language-select></select></label>
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
<script src="/assets/translations.cjs"></script>
<script src="/assets/i18n.cjs"></script>
<script src="/assets/labels.js"></script>
<script src="/assets/dashboard.js"></script></body></html>`;
}
