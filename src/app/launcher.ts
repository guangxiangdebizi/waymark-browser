import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import electronPath from 'electron';
import { env } from '../config.js';

// `npm run app` / `node dist/app/launcher.js`: start Electron with the runtime inside its main process (one process
// tree). WAYMARK_LEGACY_DRIVER=1 keeps the older layout, Playwright driving Electron from this Node process.
if (process.env.WAYMARK_LEGACY_DRIVER === '1') {
  const { startWaymark } = await import('./start.js');
  const { runtime, closed } = await startWaymark();
  process.on('SIGINT', () => { void runtime.close(); });
  process.on('SIGTERM', () => { void runtime.close(); });
  await closed;
} else {
  const args = [...(env('ELECTRON_ARGS')?.split(/\s+/).filter(Boolean) ?? []), resolve('dist/app/electron-main.js')];
  const child = spawn(electronPath as unknown as string, args, { stdio: 'inherit', env: { ...process.env, WAYMARK_INPROCESS: '1' } });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  child.on('exit', code => process.exit(code ?? 0));
}
