import { vizCss } from './viz.js';
import { normalizeLanguage } from '../i18n.js';

/** The statistics dashboard for people: what the agents did, what Waymark did for them, and what to improve. */
export function insightsHtml(locale = 'en'): string {
  const lang = normalizeLanguage(locale);
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waymark · Insights</title><style>${vizCss}
main{max-width:1320px;margin:0 auto;padding:26px 28px 60px}
.hero{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:26px}
.hero .card{padding:20px 22px;display:flex;flex-direction:column;gap:4px;min-height:128px}
.hero .k{color:var(--text-3);font-size:13px}
.hero .v{font-size:34px;font-weight:650;letter-spacing:-.8px;line-height:1.15;font-variant-numeric:tabular-nums}
.hero .n{color:var(--text-3);font-size:12.5px;margin-top:auto}
.hero .with-ring{flex-direction:row;align-items:center;gap:16px}
h2{font-size:17px;font-weight:650;margin:34px 0 4px;letter-spacing:-.2px}
.lead{color:var(--text-3);font-size:13px;margin:0 0 14px}
.grid2{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:16px}
.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.box{padding:20px 22px}
.box h3{margin:0 0 12px;font-size:14px;font-weight:600}
.legend{display:flex;flex-wrap:wrap;gap:14px;margin:0 0 10px;font-size:12.5px;color:var(--text-2)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.autos{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.auto{padding:16px 18px;border-radius:16px;background:var(--card);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.auto .ic{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;margin-bottom:10px;background:var(--accent-soft);color:var(--accent-text)}
.auto .ic svg{width:18px;height:18px}
.auto .v{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.4px}
.auto .k{color:var(--text-2);font-size:13px}
.auto .n{color:var(--text-3);font-size:12px;margin-top:2px}
.save{display:grid;grid-template-columns:1fr auto;gap:2px 12px;padding:12px 0;border-bottom:1px solid var(--line)}
.save:last-child{border-bottom:0}
.save b{font-size:18px;font-variant-numeric:tabular-nums;text-align:right}
.save small{grid-column:1/3;color:var(--text-3);font-size:12px}
.recs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.rec{padding:18px 20px;border-left:4px solid var(--line-2)}
.rec.high{border-left-color:var(--bad)}
.rec.medium{border-left-color:var(--warn)}
.rec.info{border-left-color:var(--accent)}
.rec .sev{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--text-3)}
.rec h4{margin:4px 0 6px;font-size:14.5px}
.rec p{margin:0;color:var(--text-2);font-size:13px}
.rec .ev{margin-top:8px;font-size:12px}
.assume{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px 20px;font-size:12.5px;color:var(--text-2)}
.assume b{color:var(--text);font-variant-numeric:tabular-nums}
.foot{margin-top:30px;color:var(--text-3);font-size:12px;text-align:center}
.mono{font-family:"Cascadia Mono",Consolas,monospace;font-size:12px}
.seq{font-family:"Cascadia Mono",Consolas,monospace;font-size:11.5px;color:var(--text-2);word-break:break-word}
@media(max-width:1100px){.hero,.autos{grid-template-columns:repeat(2,minmax(0,1fr))}.grid2,.grid3,.recs{grid-template-columns:1fr}.assume{grid-template-columns:1fr 1fr}}
</style></head><body>
<header class="top"><div class="logo">W</div><div><h1 data-i="title"></h1><div class="sub" data-i="subtitle"></div></div><div class="spacer"></div>
<div class="seg" id="range"><button data-days="1">24h</button><button data-days="7" class="on">7d</button><button data-days="30">30d</button><button data-days="90">90d</button></div>
<select id="agent"></select>
<a class="pill" href="/agents" id="to-agents" data-i="openManager"></a>
</header>
<main id="main"><div class="empty" data-i="loading"></div></main>
<script src="/assets/charts.js"></script>
<script src="/assets/insights.js"></script></body></html>`;
}
