const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

  const examplePath = path.join(__dirname, '../examples/http_integration.json');
  const graphFile = require('../data/scenic_graph.json');
  const stateFile = require('../data/current_state.json');
  const normalStateExample = require('../examples/normal_state.json');
  const normalForecastExample = require('../examples/normal_forecast.json');
  const invalidEventExample = require('../examples/invalid_event.json');

  async function withServer(run) {
    // Requiring the server does not start its demonstration timer. Reloading these
    // modules gives each real HTTP listener a fresh, isolated in-memory state.
    for (const modulePath of ['../state/stateProvider', '../state/scenarioEngine', '../state/forecastSimulator', '../state/forecastQuery', '../index']) {
      delete require.cache[require.resolve(modulePath)];
    }
    const { server } = require('../index');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    try {
      return await run(`http://127.0.0.1:${server.address().port}`);
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }

  async function request(base, method, route, payload) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json() };
  }

  const get = (base, route) => request(base, 'GET', route);
  const post = (base, route, payload) => request(base, 'POST', route, payload);
  const at = (timestamp, offset) => new Date(Date.parse(timestamp.replace(' ', 'T') + 'Z') + offset * 60000).toISOString();
  const queue = (base, id, timestamp, offset, horizon = 60) =>
    get(base, `/api/v1/query-queue?poi_id=${id}&arrival_time=${encodeURIComponent(at(timestamp, offset))}&horizon=${horizon}`);
  const road = (base, id, timestamp, offset, horizon = 100) =>
    get(base, `/api/v1/query-travel-time?edge_id=${id}&enter_time=${encodeURIComponent(at(timestamp, offset))}&horizon=${horizon}`);
  const queueFields = response => ({ status: response.status, queue_min: response.body.queue_min, crowd_ratio: response.body.crowd_ratio, crowd_level: response.body.crowd_level, open: response.body.open });
  const roadFields = response => ({ status: response.status, travel_time_min: response.body.travel_time_min, available: response.body.available });
  const routeFields = response => ({ status: response.status, path: response.body.path, totalMinutes: response.body.totalMinutes, edge_ids: response.body.segments?.map(segment => segment.edge_id) });
  const efficiency = response => {
    const route = response.body.routes.find(item => item.id === 'efficiency');
    return { status: response.status, queue: route.queue, utility: route.utility, minutes: route.minutes };
  };

  test('隔离服务的真实 HTTP 联调与交付样例', async t => {
    const baseline = await withServer(async base => {
      const graph = await get(base, '/api/v1/scenic-graph');
      const state = await get(base, '/api/v1/state');
      const forecast = await get(base, '/api/v1/environment-forecast');
      const repeated = await get(base, '/api/v1/environment-forecast');
      const invalidHorizon = await get(base, '/api/v1/environment-forecast?horizon=-1');
      const invalidStep = await get(base, '/api/v1/environment-forecast?step=abc');
      const invalidEvent = await post(base, '/api/v1/scenario-event', invalidEventExample);
      const snapshot = await get(base, '/api/snapshot');
      const navigation = await get(base, '/api/navigation?from=gate&to=southgate');
      const timestamp = state.body.timestamp;
      const market = Object.fromEntries(await Promise.all([0, 5, 20, 50].map(async offset => [offset, queueFields(await queue(base, 'market', timestamp, offset))])));
      const museum = queueFields(await queue(base, 'museum', timestamp, 5));
      const edge001 = Object.fromEntries(await Promise.all([0, 20, 30, 60, 90].map(async offset => [offset, roadFields(await road(base, 'edge_001', timestamp, offset))])));
      const replan = await post(base, '/api/replan', {});
      return { graph, state, forecast, repeated, invalidHorizon, invalidStep, invalidEvent, snapshot, navigation, market, museum, edge001, replan };
    });

    await t.test('静态图、当前状态、预测与错误响应', () => {
      assert.equal(baseline.graph.status, 200);
      assert.deepEqual(baseline.graph.body, graphFile);
      assert.equal(baseline.graph.body.nodes.length, 13);
      assert.equal(baseline.graph.body.edges.length, 20);
      const nodes = new Set(baseline.graph.body.nodes.map(node => node.node_id));
      assert.ok(baseline.graph.body.edges.every(edge => nodes.has(edge.from_node_id) && nodes.has(edge.to_node_id)));
      for (const [id, area] of [['market', 'water_margin'], ['juxianzhuang', 'xianxia'], ['summit', 'jianghu_art']]) {
        const node = baseline.graph.body.nodes.find(item => item.node_id === id);
        assert.equal(node.area_id, area);
        assert.deepEqual(node.access_roles, ['AREA_ENTRANCE']);
      }
      for (const id of ['gate', 'southgate']) {
        const roles = baseline.graph.body.nodes.find(node => node.node_id === id).access_roles;
        assert.ok(roles.includes('PARK_ENTRANCE') && roles.includes('PARK_EXIT'));
      }
      assert.equal(baseline.state.status, 200);
      assert.deepEqual(baseline.state.body, stateFile);
      assert.deepEqual(baseline.state.body, normalStateExample);
      assert.equal(Object.keys(baseline.state.body.poi_states).length, 11);
      assert.equal(Object.keys(baseline.state.body.road_states).length, 20);
      assert.deepEqual(Object.keys(baseline.state.body.poi_states).sort(), baseline.graph.body.nodes.filter(node => node.poi_id).map(node => node.poi_id).sort());
      assert.deepEqual(Object.keys(baseline.state.body.road_states).sort(), baseline.graph.body.edges.map(edge => edge.edge_id).sort());
      assert.ok(baseline.state.body.visitor && baseline.state.body.event_states && baseline.state.body.timestamp && baseline.state.body.state_version);
      assert.equal(baseline.forecast.status, 200);
      assert.deepEqual(baseline.forecast.body, baseline.repeated.body);
      assert.deepEqual(baseline.forecast.body, normalForecastExample);
      assert.equal(baseline.forecast.body.horizon_min, 60);
      assert.equal(baseline.forecast.body.step_min, 10);
      assert.equal(Object.keys(baseline.forecast.body.poi_predictions).length, 11);
      assert.equal(Object.keys(baseline.forecast.body.road_predictions).length, 20);
      assert.deepEqual(Object.keys(baseline.forecast.body.poi_predictions).sort(), Object.keys(baseline.state.body.poi_states).sort());
      assert.deepEqual(Object.keys(baseline.forecast.body.road_predictions).sort(), Object.keys(baseline.state.body.road_states).sort());
      assert.deepEqual(baseline.forecast.body.poi_predictions.market.map(point => point.offset_min), [0, 10, 20, 30, 40, 50, 60]);
      assert.equal(baseline.snapshot.status, 200);
      assert.ok(Array.isArray(baseline.snapshot.body.routes));
      assert.equal(baseline.invalidHorizon.status, 400);
      assert.deepEqual(baseline.invalidHorizon.body, { error: 'Invalid horizon' });
      assert.equal(baseline.invalidStep.status, 400);
      assert.deepEqual(baseline.invalidStep.body, { error: 'Invalid step' });
      assert.equal(baseline.invalidEvent.status, 404);
      assert.deepEqual(baseline.invalidEvent.body, { error: 'Unknown edge_id: edge_missing' });
    });

    const spike = await withServer(async base => {
      const state = await get(base, '/api/v1/state');
      const timestamp = state.body.timestamp;
      const payload = { event_type: 'QUEUE_SPIKE', target_id: 'market', timestamp: at(timestamp, 5), duration_min: 45 };
      const submitted = await post(base, '/api/v1/scenario-event', payload);
      const points = Object.fromEntries(await Promise.all([0, 5, 20, 50].map(async offset => [offset, queueFields(await queue(base, 'market', timestamp, offset))])));
      const nonTarget = queueFields(await queue(base, 'museum', timestamp, 5));
      const replan = await post(base, '/api/replan', {});
      return { payload, submitted, points, nonTarget, replan };
    });
    await t.test('排队突增的前、中、后及未来排队评分', () => {
      assert.equal(spike.submitted.status, 200);
      assert.ok(Object.values(spike.points).every(point => point.status === 200));
      assert.equal(spike.submitted.body.state.poi_states.market.queue_min, baseline.state.body.poi_states.market.queue_min);
      assert.deepEqual(spike.points[0], baseline.market[0]);
      for (const offset of [5, 20]) {
        assert.ok(spike.points[offset].queue_min > baseline.market[offset].queue_min);
        assert.ok(spike.points[offset].crowd_ratio > baseline.market[offset].crowd_ratio);
        assert.equal(spike.points[offset].crowd_level, 'HIGH');
      }
      assert.deepEqual(spike.points[50], baseline.market[50]);
      assert.deepEqual(spike.nonTarget, baseline.museum);
      assert.equal(spike.replan.status, 200);
      assert.ok(efficiency(spike.replan).queue > efficiency(baseline.replan).queue);
      assert.ok(efficiency(spike.replan).utility < efficiency(baseline.replan).utility);
    });

    const closure = await withServer(async base => {
      const state = await get(base, '/api/v1/state');
      const submitted = await post(base, '/api/v1/scenario-event', { event_type: 'ROAD_CLOSE', target_id: 'edge_001' });
      const timestamp = state.body.timestamp;
      const points = Object.fromEntries(await Promise.all([29, 30, 89, 90].map(async offset => [offset, roadFields(await road(base, 'edge_001', timestamp, offset))])));
      return { submitted, points };
    });
    await t.test('道路关闭区间 [开始, 结束)', () => {
      assert.equal(closure.submitted.status, 200);
      assert.ok(Object.values(closure.points).every(point => point.status === 200));
      assert.deepEqual([29, 30, 89, 90].map(offset => closure.points[offset].available), [true, false, false, true]);
      assert.ok(Number.isFinite(closure.points[30].travel_time_min));
    });

    const closedRoute = await withServer(async base => {
      const state = await get(base, '/api/v1/state');
      const payload = { event_type: 'ROAD_CLOSE', target_id: 'edge_001', timestamp: state.body.timestamp, duration_min: 60 };
      const submitted = await post(base, '/api/v1/scenario-event', payload);
      const navigation = await get(base, '/api/navigation?from=gate&to=southgate');
      const blocked = await post(base, '/api/v1/scenario-event', { ...payload, target_id: 'edge_002' });
      const noRoute = await get(base, '/api/navigation?from=gate&to=southgate');
      return { payload, submitted, navigation, blocked, noRoute };
    });
    await t.test('关闭道路绕行及无可行路径', () => {
      assert.equal(closedRoute.submitted.status, 200);
      assert.equal(closedRoute.navigation.status, 200);
      assert.ok(closedRoute.navigation.body.segments.every(segment => segment.edge_id !== 'edge_001'));
      assert.notDeepEqual(closedRoute.navigation.body.path, baseline.navigation.body.path);
      assert.equal(closedRoute.blocked.status, 200);
      assert.equal(closedRoute.noRoute.status, 409);
      assert.deepEqual(closedRoute.noRoute.body, { error: 'No feasible route', from: 'gate', to: 'southgate' });
    });

    const slowdown = await withServer(async base => {
      const state = await get(base, '/api/v1/state');
      const payload = { event_type: 'ROAD_SLOWDOWN', target_id: 'edge_001' };
      const submitted = await post(base, '/api/v1/scenario-event', payload);
      const points = Object.fromEntries(await Promise.all([0, 20, 60].map(async offset => [offset, roadFields(await road(base, 'edge_001', state.body.timestamp, offset))])));
      const navigation = await get(base, '/api/navigation?from=gate&to=southgate');
      return { payload, submitted, points, navigation };
    });
    await t.test('道路减速影响预测及导航时间', () => {
      assert.equal(baseline.navigation.status, 200);
      assert.equal(slowdown.submitted.status, 200);
      assert.ok(slowdown.points[0].travel_time_min > baseline.edge001[0].travel_time_min);
      assert.ok(slowdown.points[20].travel_time_min > baseline.edge001[20].travel_time_min);
      assert.deepEqual(slowdown.points[60], baseline.edge001[60]);
      assert.equal(slowdown.navigation.status, 200);
      assert.ok(slowdown.navigation.body.totalMinutes !== baseline.navigation.body.totalMinutes ||
        JSON.stringify(slowdown.navigation.body.path) !== JSON.stringify(baseline.navigation.body.path));
    });

    const futureSlowdown = await withServer(async base => {
      const state = await get(base, '/api/v1/state');
      const close = await post(base, '/api/v1/scenario-event', { event_type: 'ROAD_CLOSE', target_id: 'edge_001', timestamp: state.body.timestamp, duration_min: 20 });
      const slowdownEvent = await post(base, '/api/v1/scenario-event', { event_type: 'ROAD_SLOWDOWN', target_id: 'edge_020', timestamp: at(state.body.timestamp, 5), duration_min: 20 });
      const before = await road(base, 'edge_020', state.body.timestamp, 0);
      const start = await road(base, 'edge_020', state.body.timestamp, 5);
      const navigation = await get(base, '/api/navigation?from=gate&to=southgate');
      return { close, slowdownEvent, before, start, navigation };
    });
    await t.test('预计进入时刻遇到未来减速', () => {
      assert.equal(futureSlowdown.close.status, 200);
      assert.equal(futureSlowdown.slowdownEvent.status, 200);
      assert.ok(futureSlowdown.start.body.travel_time_min > futureSlowdown.before.body.travel_time_min);
      assert.equal(futureSlowdown.navigation.status, 200);
      assert.ok(closedRoute.navigation.body.segments.some(segment => segment.edge_id === 'edge_020'));
      assert.ok(futureSlowdown.navigation.body.segments.every(segment => segment.edge_id !== 'edge_020'));
      assert.ok(futureSlowdown.navigation.body.totalMinutes !== closedRoute.navigation.body.totalMinutes ||
        JSON.stringify(futureSlowdown.navigation.body.path) !== JSON.stringify(closedRoute.navigation.body.path));
    });

    const sample = {
      queue_spike: {
        request: { method: 'POST', path: '/api/v1/scenario-event', body: spike.payload },
        target_id: 'market', non_target_id: 'museum',
        points: [0, 5, 20, 50].map(offset_min => ({ offset_min, baseline: baseline.market[offset_min], event: spike.points[offset_min] })),
        non_target_at_5: { baseline: baseline.museum, event: spike.nonTarget },
        replan: { method: 'POST', path: '/api/replan', baseline: efficiency(baseline.replan), event: efficiency(spike.replan) }
      },
      road_close: {
        request: { method: 'POST', path: '/api/v1/scenario-event', body: { event_type: 'ROAD_CLOSE', target_id: 'edge_001' } },
        points: [29, 30, 89, 90].map(offset_min => ({ offset_min, result: closure.points[offset_min] })),
        immediate_close_navigation: { request: closedRoute.payload, baseline: routeFields(baseline.navigation), event: routeFields(closedRoute.navigation), blocked_status: closedRoute.noRoute.status, blocked_response: closedRoute.noRoute.body }
      },
      road_slowdown: {
        request: { method: 'POST', path: '/api/v1/scenario-event', body: slowdown.payload },
        points: [0, 20, 60].map(offset_min => ({ offset_min, baseline: baseline.edge001[offset_min], event: slowdown.points[offset_min] })),
        navigation: { baseline: routeFields(baseline.navigation), event: routeFields(slowdown.navigation) },
        future_entry: { target_id: 'edge_020', start_offset_min: 5, before: roadFields(futureSlowdown.before), at_start: roadFields(futureSlowdown.start), navigation: routeFields(futureSlowdown.navigation) }
      },
      errors: [
        { method: 'GET', path: '/api/v1/environment-forecast?horizon=-1', status: baseline.invalidHorizon.status, response: baseline.invalidHorizon.body },
        { method: 'GET', path: '/api/v1/environment-forecast?step=abc', status: baseline.invalidStep.status, response: baseline.invalidStep.body },
        { method: 'POST', path: '/api/v1/scenario-event', body: invalidEventExample, status: baseline.invalidEvent.status, response: baseline.invalidEvent.body }
      ]
    };
    await t.test('精简交付样例与真实 HTTP 响应一致', () => {
      assert.deepEqual(sample, JSON.parse(fs.readFileSync(examplePath, 'utf8')));
    });
  });
