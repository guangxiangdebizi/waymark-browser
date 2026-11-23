import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog } from '../src/audit/AuditLog.js';
import { DdddOcrWorker } from '../src/challenge/DdddOcrWorker.js';

test('ledger keeps only a bounded tail in memory, counts today without scanning, and reads windows from disk', async () => {
  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  const root = mkdtempSync(join(process.cwd(), 'data', 'mem-test-'));
  try {
    const old = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ id: `old-${i}`, sequence: i + 1, timestamp: `2020-01-0${1 + (i % 9)}T00:00:00.000Z`, session: 'default', action: 'click', status: 'success' })).join('\n');
    writeFileSync(join(root, 'events.jsonl'), old + '\n');
    const audit = new AuditLog(root);
    assert.equal(audit.list(5000).length, 1000, 'only the newest 1000 entries stay resident');
    assert.equal(audit.todayActions(), 0);
    audit.record({ action: 'click', status: 'success' });
    audit.record({ action: 'read', status: 'info' });
    audit.record({ action: 'fill', status: 'failure' });
    assert.equal(audit.todayActions(), 2);
    assert.equal(new AuditLog(root).todayActions(), 2, 'today count survives a restart');
    assert.equal(audit.record({ action: 'x', status: 'info' }).sequence, 3004);
    const since = new Date(Date.now() - 86400000).toISOString();
    const recent = await audit.read(since);
    assert.equal(recent.length, 4, 'old lines are skipped by timestamp');
    assert.equal(audit.all(since).length, 4);
    assert.equal((await audit.read()).length, 3004);
    assert.equal(audit.get('old-5')?.event.id, 'old-5', 'entries outside the resident tail are found on disk');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OCR worker warms in the background and unloads after idle; warm() is cheap when loaded', async () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const worker = new DdddOcrWorker({ pythonCommand: python, pythonFallback: python, timeoutMs: 20000, maxImageBytes: 1000000, ocrIdleUnloadMinutes: 0.01 });
  try {
    assert.equal(worker.isLoaded(), false);
    await worker.warm();
    assert.equal(worker.isLoaded(), true, 'warm() starts the worker (and loads the model when ddddocr is installed)');
    const again = Date.now();
    await worker.warm();
    assert.ok(Date.now() - again < 50, 'warming a warm worker is a no-op');
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(worker.isLoaded(), false, 'idle worker exits and frees its memory');
  } finally { await worker.close(); }
});
