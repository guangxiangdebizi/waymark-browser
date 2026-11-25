import { themeCss } from './theme.js';

/**
 * Shared look of the agent manager and the insights dashboard: quiet surfaces, generous spacing, rounded cards and a
 * validated categorical palette (8 hues in fixed order, selected separately for dark mode) plus one sequential blue.
 */
export const vizCss = `${themeCss}
:root{--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a;--series-4:#eda100;--series-5:#e87ba4;--series-6:#008300;--series-7:#6250d6;--series-8:#e34948;
--seq-0:#f1f3f8;--seq-1:#cde2fb;--seq-2:#9ec5f4;--seq-3:#5598e7;--seq-4:#256abf;--seq-5:#104281;--page:#f5f5f7;--card:#ffffff;--radius-lg:18px}
@media(prefers-color-scheme:dark){:root{--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-4:#c98500;--series-5:#d55181;--series-6:#0ca30c;--series-7:#9085e9;--series-8:#e66767;
--seq-0:#26272f;--seq-1:#184f95;--seq-2:#1c5cab;--seq-3:#2a78d6;--seq-4:#5598e7;--seq-5:#9ec5f4;--page:#17181d;--card:#22232b}}
body{background:var(--page);-webkit-font-smoothing:antialiased}
.top{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:14px;padding:14px 28px;background:color-mix(in srgb,var(--page) 82%,transparent);backdrop-filter:saturate(1.6) blur(18px);border-bottom:1px solid color-mix(in srgb,var(--line) 70%,transparent);flex-wrap:wrap}
.top .logo{width:32px;height:32px;border-radius:10px;font-size:15px}
.top h1{margin:0;font-size:19px;font-weight:650;letter-spacing:-.2px}
.top .sub{color:var(--text-3);font-size:12.5px}
.top .spacer{flex:1}
.seg{display:inline-flex;padding:3px;border-radius:10px;background:color-mix(in srgb,var(--line) 60%,transparent)}
.seg button{border:0;background:transparent;padding:5px 12px;border-radius:8px;font-size:13px;color:var(--text-2);cursor:pointer}
.seg button.on{background:var(--card);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.12);font-weight:600}
select,input[type=search]{height:34px;border-radius:10px;border:1px solid var(--line);background:var(--card);padding:0 12px;outline:0}
input[type=search]:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
a{color:var(--accent-text);text-decoration:none}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 10px;border-radius:999px;background:var(--card);border:1px solid var(--line);color:var(--text-2)}
.card{background:var(--card);border:0;border-radius:var(--radius-lg);box-shadow:0 1px 2px rgba(0,0,0,.04),0 4px 18px rgba(0,0,0,.04)}
.est{display:inline-block;font-size:10.5px;font-weight:600;letter-spacing:.2px;padding:1px 7px;border-radius:6px;background:var(--warn-soft);color:var(--warn);vertical-align:middle;margin-left:6px}
.tag{display:inline-block;font-size:11px;padding:1px 8px;border-radius:6px;background:var(--surface-2);color:var(--text-2);margin-right:4px;white-space:nowrap}
.tag.declared,.tag.mcp-client{background:var(--ok-soft);color:var(--ok)}
.tag.env,.tag.user-agent,.tag.tty,.tag.local-ui{background:var(--accent-soft);color:var(--accent-text)}
.tag.unknown,.tag.legacy{background:var(--surface-2);color:var(--text-3)}
.swatch{display:inline-block;width:10px;height:10px;border-radius:3px;flex:none}
.viz{display:block;overflow:visible;width:auto;height:auto;stroke:none;fill:none}
.viz text{stroke:none}
svg.ring{width:64px;height:64px;stroke:none}
.viz .grid{stroke:var(--line);stroke-width:1;stroke-dasharray:2 4}
.viz .axis{stroke:var(--line-2);stroke-width:1}
.viz .tick{fill:var(--text-3);font-size:11px}
.viz .hit{fill:transparent;cursor:default}
.viz .hit:hover{fill:color-mix(in srgb,var(--text) 5%,transparent)}
.viz-empty{color:var(--text-3);text-align:center;margin-top:-120px;height:120px}
.viz-tip{position:fixed;left:0;top:0;z-index:100;pointer-events:none;min-width:150px;max-width:320px;padding:10px 12px;border-radius:12px;background:var(--card);color:var(--text);box-shadow:0 8px 30px rgba(0,0,0,.16);border:1px solid var(--line);font-size:12.5px}
.viz-tip .row{display:flex;align-items:center;gap:8px;margin-top:4px}
.viz-tip .row i{width:9px;height:9px;border-radius:3px}
.viz-tip .row span{flex:1;color:var(--text-2)}
.viz-tip .row.total{border-top:1px solid var(--line);padding-top:4px}
.heat{display:grid;grid-template-columns:34px repeat(24,minmax(0,1fr));gap:3px;font-size:10.5px;color:var(--text-3)}
.heat .hc{aspect-ratio:1/1;border-radius:4px;min-height:10px}
.heat .hx{text-align:left}
.heat .hy{align-self:center}
.hbar{display:grid;grid-template-columns:minmax(90px,38%) 1fr 56px;align-items:center;gap:10px;padding:5px 0;font-size:13px}
.hbar .hl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-2)}
.hbar .ht{height:8px;border-radius:4px;background:var(--surface-2);overflow:hidden}
.hbar .ht i{display:block;height:100%;border-radius:4px}
.hbar b{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.ring .ring-bg{fill:none;stroke:var(--surface-2);stroke-width:6}
.ring .ring-fg{fill:none;stroke-width:6;stroke-linecap:round}
table.t{width:100%;border-collapse:collapse;font-size:13px}
table.t th{font-weight:500;color:var(--text-3);text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
table.t td{padding:9px 10px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
table.t tr:last-child td{border-bottom:0}
table.t td.num,table.t th.num{text-align:right}
.empty{padding:40px 20px;text-align:center;color:var(--text-3)}
`;
