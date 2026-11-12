import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DdddOcrWorker } from '../src/challenge/DdddOcrWorker.js';

const worker = new DdddOcrWorker({ pythonCommand: process.env.WAYMARK_PYTHON ?? './.venv/Scripts/python.exe', pythonFallback: process.platform === 'win32' ? 'python' : 'python3', timeoutMs: 30000, maxImageBytes: 5 * 1024 * 1024 });
const started = Date.now();
const result = await worker.invoke(readFileSync('data/ocr-smoke.png'));
assert.equal(result.text.replace(/\s/g, '').toUpperCase(), 'A7B2');
const warmStarted = Date.now();
const warm = await worker.invoke(readFileSync('data/ocr-smoke.png'));
assert.equal(warm.text.replace(/\s/g, '').toUpperCase(), 'A7B2');
console.log(JSON.stringify({ ok: true, answerLength: result.text.trim().length, coldDurationMs: warmStarted - started, warmDurationMs: Date.now() - warmStarted, provider: worker.manifest.id }));
await worker.close();
