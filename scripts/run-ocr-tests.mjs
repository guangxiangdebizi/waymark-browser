// Cross-platform runner for the OCR tests: picks the project venv's Python on Windows or POSIX.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const python = process.env.WAYMARK_PYTHON
  ?? ['.venv/Scripts/python.exe', '.venv/bin/python'].find(existsSync)
  ?? (process.platform === 'win32' ? 'python' : 'python3');
const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' && command === 'npx', env });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(python, ['python/generate_ocr_fixture.py']);
const env = { ...process.env, WAYMARK_PYTHON: python };
run('npx', ['tsx', 'tests/ocr_smoke.ts'], env);
run('npx', ['tsx', 'tests/ocr_e2e.ts'], env);
