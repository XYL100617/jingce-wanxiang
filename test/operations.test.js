'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOperations } = require('../server/companion/operations');

test('运营公告可持久保存、审核、生效、过期并读取共享事件', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingce-operations-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'operations.json');
  let clock = Date.parse('2026-10-29T02:00:00.000Z');
  const incidents = [{ incident_id: 'road-1', incident_type: 'ROAD_CLOSED', severity: 'high', scope: 'edge_1', status: 'active', source: 'demo' }];
  const create = () => createOperations({ file, now: () => clock, readIncidents: () => incidents });
  const operations = create();
  const announcement = operations.publish({ title: '演示道路提醒', content: '请留意演示状态', source: 'scenario-1', effective_from: '2026-10-29T01:00:00.000Z', effective_until: '2026-10-29T03:00:00.000Z', review_status: 'pending' });
  assert.equal(operations.read().announcements.length, 0, '待审核内容不对外展示');
  assert.equal(operations.read().incidents[0].incident_id, 'road-1');
  const reloaded = create();
  assert.equal(reloaded.list().length, 1, '进程重启后本地公告仍在');
  reloaded.setReviewStatus(announcement.id, 'approved');
  assert.equal(reloaded.read().announcements[0].id, announcement.id);
  clock = Date.parse('2026-10-29T03:00:00.000Z');
  assert.equal(reloaded.read().announcements.length, 0, '到失效时间立即停止展示');
  assert.equal(reloaded.remove(announcement.id), true);
  assert.equal(create().list().length, 0);
});
