/** Design tokens shared by the local cockpit pages; kept in step with src/app/shell/shell.css. */
export const themeCss = `
:root{--bg:#f5f6fa;--surface:#fff;--surface-2:#f5f6fa;--line:#e3e5ec;--line-2:#d5d8e2;--text:#1f2130;--text-2:#5b5f73;--text-3:#8b8fa3;
--accent:#5b5bd6;--accent-soft:#ecebff;--accent-text:#4a48c4;--ok:#1f9d55;--ok-soft:#e3f6ea;--warn:#c27803;--warn-soft:#fdf3dc;--bad:#d14343;--bad-soft:#fde8e8;
--shadow:0 1px 2px rgba(20,22,40,.06),0 2px 8px rgba(20,22,40,.05);--radius:12px;color-scheme:light}
@media(prefers-color-scheme:dark){:root{--bg:#1b1c22;--surface:#2a2b35;--surface-2:#22232b;--line:#353642;--line-2:#42434f;--text:#e6e7ee;--text-2:#a9abba;--text-3:#7d7f8f;
--accent:#8b8bff;--accent-soft:#34345a;--accent-text:#b4b4ff;--ok:#4cc38a;--ok-soft:#1f3a2d;--warn:#f0b429;--warn-soft:#3d321a;--bad:#f87171;--bad-soft:#452628;--shadow:0 1px 2px rgba(0,0,0,.3);color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","PingFang SC",system-ui,sans-serif}
svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex:none}
button,input,select{font:inherit;color:inherit}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
.btn{height:32px;padding:0 14px;border-radius:8px;border:1px solid var(--line-2);background:var(--surface);color:var(--text);font-weight:500;cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--surface-2)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.muted{color:var(--text-3)}
.logo{display:grid;place-items:center;color:#fff;font-weight:700;background:linear-gradient(135deg,#7c6cf0,#4f8df5);box-shadow:0 2px 6px rgba(80,90,200,.35)}
.status{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:var(--line);color:var(--text-2);white-space:nowrap}
.status.ok,.status.success{background:var(--ok-soft);color:var(--ok)}
.status.warn,.status.started{background:var(--warn-soft);color:var(--warn)}
.status.bad,.status.failure{background:var(--bad-soft);color:var(--bad)}
.status.info{background:var(--accent-soft);color:var(--accent-text)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--text-3);display:inline-block;flex:none}
.dot.ok{background:var(--ok);box-shadow:0 0 0 3px var(--ok-soft)}
.dot.warn{background:var(--warn);box-shadow:0 0 0 3px var(--warn-soft)}
.dot.bad{background:var(--bad);box-shadow:0 0 0 3px var(--bad-soft)}
code,.mono{font-family:"Cascadia Mono",Consolas,monospace;font-size:12.5px}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:var(--line-2);border-radius:5px;border:3px solid var(--bg)}
`;
