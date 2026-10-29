'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeProgressEvent, summarizePlanChange } = require('../server/c-progress');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-progress-test-'));
process.env.ACCOUNTS_FILE = path.join(tempDir, 'accounts.json');
process.env.AUDIT_FILE = path.join(tempDir, 'audit.jsonl');
process.on('exit', () => fs.rmSync(tempDir, { recursive: true, force: true }));

test('ProgressEvent 归一化为 B 的 UserEvent，并保留 C 事件类型', () => {
  const arrive = normalizeProgressEvent({
    event_type: 'ARRIVE', event_id: 'p1', target_id: 'museum', node_id: 'museum',
    remaining_time_min: 120, fatigue: 0.3,
  });
  assert.equal(arrive.progress.event_type, 'ARRIVE');
  assert.equal(arrive.event.event_type, 'PROGRESS_UPDATE');
  assert.equal(arrive.event.current_node_id, 'museum');
  assert.equal(arrive.event.target_id, 'museum');
  assert.equal(arrive.eventId, 'p1');

  const skip = normalizeProgressEvent({ event_type: 'SKIP', event_id: 'p2', target_id: 'market' });
  assert.equal(skip.progress.event_type, 'SKIP');
  assert.equal(skip.event.event_type, 'SKIP_TARGET');
  assert.equal(skip.event.target_id, 'market');

  const delay = normalizeProgressEvent({ event_type: 'DELAY', event_id: 'p3', node_id: 'gate', remaining_time_min: 90 });
  assert.equal(delay.event.event_type, 'PROGRESS_UPDATE');
  assert.equal(delay.event.target_id, undefined);
  assert.equal(delay.event.remaining_time_min, 90);

  const deviate = normalizeProgressEvent({ event_type: 'DEVIATE', event_id: 'p4', node_id: 'lake' });
  assert.equal(deviate.event.event_type, 'PROGRESS_UPDATE');
  assert.equal(deviate.event.current_node_id, 'lake');
  assert.equal(deviate.event.target_id, undefined);

  const exit = normalizeProgressEvent({ event_type: 'EXIT_CHANGE', event_id: 'p5', node_id: 'southgate' });
  assert.equal(exit.event.event_type, 'REQUEST_REPLAN');
  assert.equal(exit.exitNodeId, 'southgate');

  const arriveExit = normalizeProgressEvent({ event_type: 'ARRIVE', event_id: 'p6', target_id: 'exit_gate', target_type: 'EXIT', node_id: 'gate' });
  assert.equal(arriveExit.progress.event_type, 'ARRIVE');
  assert.equal(arriveExit.progress.target_type, 'EXIT');
  assert.equal(arriveExit.event.event_type, 'PROGRESS_UPDATE');
  assert.equal(arriveExit.event.target_id, undefined);

  assert.throws(() => normalizeProgressEvent({ event_type: 'ARRIVE', event_id: 'bad' }), /target_id/);
  assert.throws(() => normalizeProgressEvent({ event_type: 'SKIP', event_id: 'bad' }), /target_id/);
  assert.throws(() => normalizeProgressEvent({ event_type: 'DELAY', event_id: 'bad' }), /node_id/);
});

test('change summary 能说明移除、新增和顺序变化', () => {
  const previous = {
    plan_id: 'p_old',
    based_on_state_version: 'state_1',
    itinerary: [
      { action_type: 'VISIT_POI', target_id: 'museum' },
      { action_type: 'VISIT_POI', target_id: 'market' },
      { action_type: 'EXIT', target_id: 'southgate' },
    ],
  };
  const next = {
    plan_id: 'p_new',
    based_on_state_version: 'state_2',
    itinerary: [
      { action_type: 'EXIT', target_id: 'southgate' },
      { action_type: 'VISIT_POI', target_id: 'temple' },
      { action_type: 'VISIT_POI', target_id: 'market' },
    ],
    reason: '排队变化后调整路线',
  };
  const summary = summarizePlanChange(previous, next, { event_type: 'ARRIVE', node_id: 'museum' });
  assert.equal(summary.trigger, 'ARRIVE');
  assert.ok(summary.removed.includes('VISIT_POI:museum'));
  assert.ok(summary.added.includes('VISIT_POI:temple'));
  assert.equal(summary.reordered, true);
  assert.equal(summary.changed, true);
  assert.match(summary.reason, /排队/);
});

test('HTTP ProgressEvent 到达、变更摘要和 event_id 幂等', async () => {
  for (const modulePath of [
    '../server/state/stateProvider',
    '../server/state/scenarioEngine',
    '../server/state/forecastSimulator',
    '../server/state/forecastQuery',
    '../server/index',
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
  const { server } = require('../server/index');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async response => ({ status: response.status, body: await response.json() }));

  try {
    const planResponse = await post('/api/replan', {});
    assert.equal(planResponse.status, 200);
    const plan = planResponse.body.planResult;
    assert.ok(plan?.itinerary?.length, '需要一个可执行的当前方案');
    const item = plan.itinerary.find(step => step.target_id && step.target_node_id && ['VISIT_POI', 'ATTEND_EVENT', 'REST'].includes(step.action_type));
    assert.ok(item, '当前方案需要一个可回报的停靠点');

    const event = {
      event_type: 'ARRIVE',
      event_id: 'progress-http-1',
      target_id: item.target_id,
      node_id: item.target_node_id,
      remaining_time_min: 180,
      fatigue: 0.25,
    };
    const first = await post('/api/b/demo-event', { event });
    assert.equal(first.status, 200);
    assert.equal(first.body.progress_event.event_type, 'ARRIVE');
    assert.equal(first.body.progress_event.plan_id, first.body.planResult.plan_id);
    assert.ok(first.body.change_summary);
    assert.equal(first.body.idempotent, undefined);

    const duplicate = await post('/api/b/demo-event', { event });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.idempotent, true);
    assert.equal(duplicate.body.planResult.plan_id, first.body.planResult.plan_id);
    assert.equal(duplicate.body.progress_event.event_id, 'progress-http-1');

    const skip = await post('/api/b/demo-event', {
      event: { event_type: 'SKIP', event_id: 'progress-http-2', target_id: item.target_id },
    });
    assert.equal(skip.status, 200);
    assert.equal(skip.body.progress_event.event_type, 'SKIP');
    assert.ok(skip.body.change_summary);

    const invalid = await post('/api/b/demo-event', {
      event: { event_type: 'ARRIVE', event_id: 'progress-http-3', target_id: 'not_a_poi', node_id: 'gate' },
    });
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
