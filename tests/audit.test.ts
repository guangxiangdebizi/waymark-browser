import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog } from '../src/audit/AuditLog.js';

test('audit ledger links an action to its immutable snapshot and redacts fill values', () => {
  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  const root = mkdtempSync(join(process.cwd(), 'data', 'audit-test-'));
  try {
    const audit = new AuditLog(root);
    const snapshot = audit.saveSnapshot({ id: 's1', pageId: 1, url: 'http://local.test', title: 'fixture', text: '[ref=e1] input', refs: {} });
    const event = audit.record({ pageId: 1, action: 'fill', target: { fields: [{ ref: 'e1', valueLength: 9 }] }, basisSnapshotId: snapshot.id, basisSnapshotHash: snapshot.hash, status: 'success' });
    const loaded = audit.get(event.id);
    assert.equal(loaded?.snapshot?.text, '[ref=e1] input');
    assert.equal(loaded?.event.basisSnapshotHash, snapshot.hash);
    assert.equal(JSON.stringify(loaded).includes('secret12'), false);
    audit.setSession('trace-test');
    assert.equal(audit.record({ action: 'session.test', status: 'info' }).session, 'trace-test');
    audit.record({ pageId: 1, action: 'mouse.ambient', status: 'info' });
    const reopened = new AuditLog(root);
    assert.equal(reopened.list(10)[0].action, 'mouse.ambient');
    assert.equal(reopened.list(10, item => item.action !== 'mouse.ambient')[0].action, 'session.test');
    assert.equal(reopened.get(event.id)?.snapshot?.id, 's1');
    assert.equal(reopened.record({ action: 'after.reopen', status: 'info' }).sequence, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
