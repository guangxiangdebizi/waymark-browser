// Run the whole comparison in one go and write a Markdown report:
//   node benchmarks/memory/run-all.mjs --baseline ../waymark-baseline [--quick] [--skip-web] [--soak 20]
// Every run is a separate process start; results land in .research/memory/<label>.json, the report in
// .research/memory/report.md. Re-running skips results that already exist (delete them to measure again).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : 'true']);
  return pairs;
}, []));
const out = resolve('.research/memory');
mkdirSync(out, { recursive: true });
const baseline = args.baseline ? resolve(args.baseline) : undefined;
const repeat = args.quick ? 1 : 3;
const settle = args.quick ? '5000' : '8000';
const runs = [];
const plan = (label, extra, env = {}) => runs.push({ label, extra, env });
for (let i = 1; i <= repeat; i++) {
  if (baseline) plan(`baseline-${i}`, ['--app-dir', baseline]);
  plan(`new-${i}`, []);
}
// Ablations: one change turned back at a time, to see what each is worth.
plan('ablate-legacy-driver', ['--legacy']);
plan('ablate-network-process', ['--config', JSON.stringify({ browser: { memory: { networkServiceInProcess: false } } })]);
plan('ablate-semi-space-32', [], { WAYMARK_SEMI_SPACE_MB: '32' });
plan('ablate-eager-cv2', [], { WAYMARK_OCR_LAZY_CV2: '0' });
plan('ablate-no-screenshots', ['--config', JSON.stringify({ audit: { captureScreenshots: false } })]);
plan('trim-on', ['--later', '60000', '--config', JSON.stringify({ browser: { memory: { trimBackgroundTabsAfterSec: 20 } } })]);
plan('trim-off', ['--later', '60000', '--config', JSON.stringify({ browser: { memory: { trimBackgroundTabsAfterSec: 0 } } })]);
if (baseline) plan('baseline-later', ['--app-dir', baseline, '--later', '60000']);
// OCR warm-up policies: the very first agent action opens a CAPTCHA page.
for (let i = 1; i <= repeat; i++) {
  if (baseline) plan(`cold-captcha-baseline-${i}`, ['--app-dir', baseline, '--cold-captcha']);
  plan(`cold-captcha-agent-${i}`, ['--cold-captcha']);
  plan(`cold-captcha-startup-${i}`, ['--cold-captcha', '--config', JSON.stringify({ challenge: { ocrPrewarm: 'startup' } })]);
  plan(`cold-captcha-off-${i}`, ['--cold-captcha', '--config', JSON.stringify({ challenge: { ocrPrewarm: 'off' } })]);
}
plan('idle-startup-prewarm', ['--config', JSON.stringify({ challenge: { ocrPrewarm: 'startup' } })]);
for (const browser of ['chrome', 'edge']) for (let i = 1; i <= Math.min(2, repeat); i++) plan(`${browser}-${i}`, ['--target', browser]);
if (!args['skip-web']) {
  if (baseline) plan('web-baseline', ['--app-dir', baseline, '--sites', 'web']);
  plan('web-new', ['--sites', 'web']);
  plan('web-chrome', ['--target', 'chrome', '--sites', 'web']);
  plan('web-edge', ['--target', 'edge', '--sites', 'web']);
}
if (Number(args.soak)) {
  plan('soak-new', ['--soak', args.soak]);
  if (baseline) plan('soak-baseline', ['--app-dir', baseline, '--soak', args.soak]);
}

for (const run of runs) {
  const file = join(out, `${run.label}.json`);
  if (existsSync(file)) { console.log(`skip ${run.label} (exists)`); continue; }
  console.log(`run ${run.label} ...`);
  const started = Date.now();
  const result = spawnSync(process.execPath, ['benchmarks/memory/bench.mjs', '--label', run.label, '--settle', settle, '--out', file, ...run.extra], { stdio: 'inherit', env: { ...process.env, ...run.env }, timeout: 3600000 });
  console.log(`  ${run.label}: exit ${result.status} in ${Math.round((Date.now() - started) / 1000)} s`);
}
spawnSync(process.execPath, ['benchmarks/memory/report.mjs', out], { stdio: 'inherit' });
