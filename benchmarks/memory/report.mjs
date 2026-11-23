// Turn .research/memory/*.json into report.md: medians per configuration, ablations, browsers, speed and soak.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.research/memory';
const results = Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.json')).map(f => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dir, f), 'utf8'))]));
const median = values => { const v = values.filter(x => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : undefined; };
const group = prefix => Object.entries(results).filter(([k]) => k === prefix || new RegExp(`^${prefix}-\\d+$`).test(k)).map(([, v]) => v);
const mem = (rs, scenario) => median(rs.map(r => r.scenarios?.[scenario]?.privateMB));
const ws = (rs, scenario) => median(rs.map(r => r.scenarios?.[scenario]?.wsMB));
const speed = (rs, key, sub) => median(rs.map(r => sub ? r.speed?.[key]?.[sub] : r.speed?.[key]));
const fmt = v => v === undefined ? '—' : typeof v === 'number' ? (Math.round(v * 10) / 10).toString() : String(v);
const pct = (a, b) => a === undefined || b === undefined ? '—' : `${b < a ? '−' : '+'}${Math.abs(Math.round((b - a) / a * 1000) / 10)}%`;
const scenarios = ['idle', 'tab1', 'tab5', 'agentTask', 'afterCaptcha', 'idleAfterWork'];
const lines = ['# Memory and speed report', '', `Generated ${new Date().toISOString()} from ${Object.keys(results).length} runs. Memory is the private working set (Windows Task Manager "Memory"; PSS on Linux) of the whole process tree, median of runs.`, ''];
const base = group('baseline'), cur = group('new'), chrome = group('chrome'), edge = group('edge');
lines.push('## Memory (MB)', '', '| Scenario | v0.5.0 | this branch | change | Chrome | Edge |', '|---|---|---|---|---|---|');
for (const s of scenarios) lines.push(`| ${s} | ${fmt(mem(base, s))} | ${fmt(mem(cur, s))} | ${pct(mem(base, s), mem(cur, s))} | ${fmt(mem(chrome, s))} | ${fmt(mem(edge, s))} |`);
lines.push(`| peak | ${fmt(median(base.map(r => r.peak?.privateMB)))} | ${fmt(median(cur.map(r => r.peak?.privateMB)))} | ${pct(median(base.map(r => r.peak?.privateMB)), median(cur.map(r => r.peak?.privateMB)))} | ${fmt(median(chrome.map(r => r.peak?.privateMB)))} | ${fmt(median(edge.map(r => r.peak?.privateMB)))} |`);
lines.push('', 'Working set (includes shared pages) for reference:', '', '| Scenario | v0.5.0 | this branch | Chrome | Edge |', '|---|---|---|---|---|');
for (const s of ['idle', 'tab5']) lines.push(`| ${s} | ${fmt(ws(base, s))} | ${fmt(ws(cur, s))} | ${fmt(ws(chrome, s))} | ${fmt(ws(edge, s))} |`);
lines.push('', '## Speed', '', '| Metric | v0.5.0 | this branch | Chrome | Edge |', '|---|---|---|---|---|');
const rows = [['Cold start to ready (ms)', 'coldStartMs'], ['Page open, median (ms)', 'pageOpenMedianMs'], ['Snapshot median (ms)', 'snapshotMs', 'median'], ['Snapshot p95 (ms)', 'snapshotMs', 'p95'],
  ['click median (ms)', 'act_click_ms', 'median'], ['select median (ms)', 'act_select_ms', 'median'], ['fill median (ms, human typing)', 'act_fill_ms', 'median'], ['type median (ms, human typing)', 'act_type_ms', 'median'],
  ['First CAPTCHA, navigate→solved (ms)', 'captchaFirstMs'], ['Second CAPTCHA (ms)', 'captchaSecondMs'], ['Background tab restore + snapshot (ms)', 'tabRestoreMs']];
for (const [label, key, sub] of rows) lines.push(`| ${label} | ${fmt(speed(base, key, sub))} | ${fmt(speed(cur, key, sub))} | ${fmt(speed(chrome, key, sub))} | ${fmt(speed(edge, key, sub))} |`);
const pointer = rs => rs.map(r => r.speed?.pointer).filter(Boolean);
lines.push(`| Pointer: moves per path | ${fmt(median(pointer(base).map(p => p.eventsPerPath)))} | ${fmt(median(pointer(cur).map(p => p.eventsPerPath)))} | | |`);
lines.push(`| Pointer: gap p50 / p95 / max (ms) | ${fmt(median(pointer(base).map(p => p.gapP50)))} / ${fmt(median(pointer(base).map(p => p.gapP95)))} / ${fmt(median(pointer(base).map(p => p.gapMax)))} | ${fmt(median(pointer(cur).map(p => p.gapP50)))} / ${fmt(median(pointer(cur).map(p => p.gapP95)))} / ${fmt(median(pointer(cur).map(p => p.gapMax)))} | | |`);
lines.push(`| CAPTCHA status (first / second) | ${base.map(r => `${r.speed?.captchaFirstStatus}/${r.speed?.captchaSecondStatus}`)[0] ?? '—'} | ${cur.map(r => `${r.speed?.captchaFirstStatus}/${r.speed?.captchaSecondStatus}`)[0] ?? '—'} | | |`);
lines.push('', '## What each change is worth (one change turned back, single run, vs this branch median)', '', '| Turned back | idle | tab5 | after work | peak | notes |', '|---|---|---|---|---|---|');
const ablations = [['ablate-legacy-driver', 'Runtime in a separate Node process'], ['ablate-network-process', 'Network service in its own process'], ['ablate-semi-space-32', 'Runtime young generation 32 MB'], ['ablate-eager-cv2', 'OCR imports OpenCV eagerly'], ['ablate-no-screenshots', 'Trace screenshots off (speed check)']];
for (const [key, label] of ablations) {
  const r = results[key];
  if (!r) continue;
  lines.push(`| ${label} | ${fmt(r.scenarios?.idle?.privateMB)} (${pct(mem(cur, 'idle'), r.scenarios?.idle?.privateMB)}) | ${fmt(r.scenarios?.tab5?.privateMB)} | ${fmt(r.scenarios?.idleAfterWork?.privateMB)} | ${fmt(r.peak?.privateMB)} | click ${fmt(r.speed?.act_click_ms?.median)} ms, snapshot ${fmt(r.speed?.snapshotMs?.median)} ms, cold ${fmt(r.speed?.coldStartMs)} ms |`);
}
if (results['trim-on'] && results['trim-off']) {
  lines.push('', '## Background tab trimming (5 tabs, 60 s in the background)', '', '| | tab5 right after opening | tab5 after 60 s | restore + snapshot (ms) |', '|---|---|---|---|');
  for (const key of ['trim-off', 'trim-on', 'baseline-later']) if (results[key]) lines.push(`| ${key} | ${fmt(results[key].scenarios?.tab5?.privateMB)} | ${fmt(results[key].scenarios?.tab5Later?.privateMB)} | ${fmt(results[key].speed?.tabRestoreMs)} |`);
}
const cold = name => { const rs = Object.entries(results).filter(([k]) => k.startsWith(`cold-captcha-${name}-`)).map(([, v]) => v); return rs.length ? { ms: median(rs.map(r => r.speed?.coldCaptchaMs)), status: rs.map(r => r.speed?.coldCaptchaStatus).join('/'), mb: median(rs.map(r => r.scenarios?.afterColdCaptcha?.privateMB)) } : undefined; };
if (cold('agent')) {
  lines.push('', '## OCR warm-up: first agent action opens a CAPTCHA page (navigate → solved)', '', '| Policy | median ms | status | memory after (MB) |', '|---|---|---|---|');
  for (const [name, label] of [['baseline', 'v0.5.0 (load on first CAPTCHA)'], ['off', 'off (load on first CAPTCHA)'], ['agent', 'agent (default: load when an agent connects)'], ['startup', 'startup (load at launch)']]) {
    const c = cold(name);
    if (c) lines.push(`| ${label} | ${fmt(c.ms)} | ${c.status} | ${fmt(c.mb)} |`);
  }
  if (results['idle-startup-prewarm']) lines.push('', `Idle memory with the model loaded at launch: ${fmt(results['idle-startup-prewarm'].scenarios?.idle?.privateMB)} MB (default policy: ${fmt(mem(cur, 'idle'))} MB).`);
}
const web = ['web-baseline', 'web-new', 'web-chrome', 'web-edge'].filter(k => results[k]);
if (web.length) {
  lines.push('', '## Real websites (bing, wikipedia, github, baidu, MDN)', '', '| | idle | 1 tab | 5 tabs | page open median (ms) |', '|---|---|---|---|---|');
  for (const key of web) lines.push(`| ${key} | ${fmt(results[key].scenarios?.idle?.privateMB)} | ${fmt(results[key].scenarios?.tab1?.privateMB)} | ${fmt(results[key].scenarios?.tab5?.privateMB)} | ${fmt(results[key].speed?.pageOpenMedianMs)} |`);
}
for (const key of ['soak-new', 'soak-baseline']) {
  const soak = results[key]?.soak;
  if (soak) lines.push('', `## Soak ${key}: ${soak.minutes} min, ${soak.rounds} agent rounds`, '', `Second-half slope ${soak.slopeMBPerHourSecondHalf} MB/h; runtime heap ${soak.runtimeHeapFirstMB ?? '—'} → ${soak.runtimeHeapLastMB ?? '—'} MB.`, '', '| minute | ' + soak.perMinute.map(p => p.minute).join(' | ') + ' |', '|---|' + soak.perMinute.map(() => '---').join('|') + '|', '| MB | ' + soak.perMinute.map(p => p.privateMB).join(' | ') + ' |');
}
const roles = rs => { const r = rs[0]?.scenarios?.idle?.roles; return r ? r.map(x => `${x.role} ${x.privateMB}`).join(', ') : '—'; };
lines.push('', '## Where the memory is (idle, first run)', '', `- v0.5.0: ${roles(base)}`, `- this branch: ${roles(cur)}`, `- Chrome: ${roles(chrome)}`, `- Edge: ${roles(edge)}`);
writeFileSync(join(dir, 'report.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
