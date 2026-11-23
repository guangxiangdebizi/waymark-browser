import { vizCss } from './viz.js';
import { normalizeLanguage } from '../i18n.js';

/** Agent manager: every agent, each of its sessions, the tabs a session used and every step, with screenshots. */
export function agentsHtml(locale = 'en'): string {
  const lang = normalizeLanguage(locale);
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waymark · Agents</title><style>${vizCss}
html,body{height:100%}
body{display:flex;flex-direction:column;overflow:hidden}
.live{display:flex;gap:6px;flex-wrap:wrap}
.live .pill .dot{width:7px;height:7px}
.cols{flex:1;display:grid;grid-template-columns:260px 340px minmax(0,1fr);gap:14px;padding:14px 18px 18px;min-height:0}
.col{display:flex;flex-direction:column;min-height:0}
.col>.card{flex:1;overflow:auto;min-height:0}
.col h3{margin:0 0 8px 6px;font-size:12px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px}
.item{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-bottom:1px solid var(--line);cursor:pointer}
.item:hover{background:var(--surface-2)}
.item.sel{background:var(--accent-soft)}
.item .av{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;color:#fff;font-weight:700;font-size:13px;flex:none}
.item .body{min-width:0;flex:1}
.item .name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.item .meta{color:var(--text-3);font-size:12px;margin-top:2px}
.item .hosts{color:var(--text-2);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
.bad-n{color:var(--bad)}
.detail{padding:20px 22px}
.dh{display:flex;align-items:flex-start;gap:14px;margin-bottom:14px}
.dh h2{margin:0;font-size:20px;letter-spacing:-.3px}
.facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:12px 0 18px}
.fact{background:var(--surface-2);border-radius:12px;padding:10px 12px}
.fact span{display:block;color:var(--text-3);font-size:11.5px}
.fact b{font-size:16px;font-variant-numeric:tabular-nums}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.tabc{border:1px solid var(--line);border-radius:12px;padding:8px 12px;font-size:12.5px;max-width:300px;cursor:pointer;background:var(--card)}
.tabc.on{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.tabc b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tabc span{color:var(--text-3)}
.tools{display:flex;gap:10px;align-items:center;margin-bottom:8px;font-size:13px;color:var(--text-2);flex-wrap:wrap}
.step{display:grid;grid-template-columns:62px 28px minmax(0,1fr) auto;gap:10px;padding:10px 4px;border-bottom:1px solid var(--line);align-items:start;cursor:pointer}
.step:hover{background:var(--surface-2)}
.step .t{font:12px "Cascadia Mono",Consolas,monospace;color:var(--text-3);padding-top:6px}
.step .ic{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;background:var(--surface-2);color:var(--text-2)}
.step.failure .ic{background:var(--bad-soft);color:var(--bad)}
.step.idle{opacity:.6}
.step .w b{font-weight:600}
.step .w .u{color:var(--text-3);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.step .w .e{color:var(--bad);font-size:12px}
.step .r{display:flex;align-items:center;gap:8px;color:var(--text-3);font-size:12px}
.step img.thumb{width:96px;height:60px;object-fit:cover;object-position:top;border-radius:8px;border:1px solid var(--line)}
.more{grid-column:3/5;background:var(--surface-2);border-radius:12px;padding:12px;font-size:12.5px;cursor:default}
.more pre{white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto;margin:8px 0 0;font:12px/1.5 "Cascadia Mono",Consolas,monospace}
.more img{max-width:100%;border-radius:10px;border:1px solid var(--line);margin-top:8px}
.kv{display:grid;grid-template-columns:110px 1fr;gap:4px 10px}
.kv dt{color:var(--text-3)}.kv dd{margin:0;word-break:break-all}
@media(max-width:1100px){.cols{grid-template-columns:220px minmax(0,1fr)}.cols .col:last-child{grid-column:1/3}body{overflow:auto;height:auto}.facts{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<header class="top"><div class="logo">W</div><div><h1 data-i="title"></h1><div class="sub" data-i="subtitle"></div></div>
<div class="live" id="live"></div><div class="spacer"></div>
<input type="search" id="q" data-ph="search">
<div class="seg" id="range"><button data-days="1">24h</button><button data-days="7" class="on">7d</button><button data-days="30">30d</button><button data-days="365">1y</button></div>
<a class="pill" href="/insights" data-i="openInsights"></a></header>
<section class="cols">
  <div class="col"><h3 data-i="agents"></h3><div class="card" id="agents"></div></div>
  <div class="col"><h3 data-i="sessions"></h3><div class="card" id="sessions"></div></div>
  <div class="col"><h3 data-i="trace"></h3><div class="card detail" id="detail"></div></div>
</section>
<script src="/assets/charts.js"></script>
<script src="/assets/agents.js"></script></body></html>`;
}
