const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const accountTestDir = fs.mkdtempSync(path.join(__dirname, '../data/.http-test-'));
process.env.ACCOUNTS_FILE = path.join(accountTestDir, 'accounts.json');
process.env.AUDIT_FILE = path.join(accountTestDir, 'audit.jsonl');
process.env.ADMIN_USERNAME = 'http_test_manager';
process.env.ADMIN_PASSWORD = 'http-test-manager-pass-2026';
process.on('exit', () => fs.rmSync(accountTestDir, { recursive: true, force: true }));
let adminCookie = '';

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
      const base = `http://127.0.0.1:${server.address().port}`;
      const login = await fetch(`${base}/api/account/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) });
      assert.equal(login.status, 200);
      adminCookie = login.headers.get('set-cookie').split(';')[0];
      return await run(base);
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }

  async function request(base, method, route, payload) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), Cookie: adminCookie },
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

  test('登录注册是平台外的独立入口，未登录首页先跳转', async () => {
    await withServer(async base => {
      const entry = await fetch(`${base}/`, { redirect: 'manual' });
      assert.equal(entry.status, 302);
      assert.equal(entry.headers.get('location'), '/login.html');
      const directIndex = await fetch(`${base}/index.html`, { redirect: 'manual' });
      assert.equal(directIndex.status, 302);
      assert.equal(directIndex.headers.get('location'), '/login.html');
      const loginPage = await fetch(`${base}/login.html`);
      assert.equal(loginPage.status, 200);
      assert.match(await loginPage.text(), /id="loginForm"/);
      const guestPreview = await fetch(`${base}/?guest=1`, { redirect: 'manual' });
      assert.equal(guestPreview.status, 200);
      const registration = await fetch(`${base}/api/account/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'entry_test_user', password: 'entry-test-password-2026', displayName: '入口测试游客' })
      });
      assert.equal(registration.status, 201);
      const registered = await registration.json();
      assert.equal(registered.user.role, 'visitor');
      const cookie = registration.headers.get('set-cookie').split(';')[0];
      const signedInHome = await fetch(`${base}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
      assert.equal(signedInHome.status, 200);
      const signedInLogin = await fetch(`${base}/login.html`, { headers: { Cookie: cookie }, redirect: 'manual' });
      assert.equal(signedInLogin.status, 302);
      assert.equal(signedInLogin.headers.get('location'), '/');
    });
  });

  test('隔离服务的真实 HTTP 联调与交付样例', async t => {
    const baseline = await withServer(async base => {
      const graph = await get(base, '/api/v1/scenic-graph');
      const state = await get(base, '/api/v1/state');
      const forecast = await get(base, '/api/v1/environment-forecast');
      const repeated = await get(base, '/api/v1/environment-forecast');
      const worldModelStatus = await get(base, '/api/v1/world-model/experimental');
      const worldModelPrediction = await post(base, '/api/v1/world-model/experimental', { observation: {
        synthetic: true, source_tier: 'T4', timestamp: state.body.timestamp,
        pois: { lake: { queue_count: 1 }, market: { queue_count: 2 } }
      } });
      const worldModelRealRejected = await post(base, '/api/v1/world-model/experimental', { observation: {
        synthetic: false, source_tier: 'REAL', pois: { lake: { queue_count: 1 } }
      } });
      const graphTemporalStatus = await get(base, '/api/v1/world-model/graph-temporal');
      const graphTemporalObservation = { synthetic: true, source_tier: 'T4', timestamp: state.body.timestamp,
        pois: Object.fromEntries(graphFile.nodes.filter(node => node.poi_id).map(node => [node.poi_id, { queue_count: 2 }])),
        roads: Object.fromEntries(graphFile.edges.map(edge => [edge.edge_id, { travel_time_min: edge.base_travel_time_min, is_open: true }])),
        events: {}, weather: { category: 'CLEAR' } };
      const graphTemporalPrediction = await post(base, '/api/v1/world-model/graph-temporal', { observation: graphTemporalObservation });
      const crowdTrendStatus = await get(base, '/api/v1/world-model/crowd-trend');
      const crowdTrendObservation = { synthetic: true, source_tier: 'T4', simulator_version: 'sim-dr-p1.1', timestamp: state.body.timestamp,
        weather: { category: 'CLEAR' },
        pois: Object.fromEntries(graphFile.nodes.filter(node => node.poi_id).map(node => [node.poi_id,
          { is_open: true, queue_count: 2, crowd_ratio: 0.42 }])),
        roads: Object.fromEntries(graphFile.edges.map(edge => [edge.edge_id,
          { travel_time_min: edge.base_travel_time_min, is_open: true }])), events: {} };
      const crowdTrendPrediction = await post(base, '/api/v1/world-model/crowd-trend', {
        horizon_min: 30, observation: crowdTrendObservation,
        routes: [{ route_id: 'sample-map1-route', node_ids: [graphFile.edges[0].from_node_id, graphFile.edges[0].to_node_id] }]
      });
      const crowdTrendRealRejected = await post(base, '/api/v1/world-model/crowd-trend', {
        observation: { ...crowdTrendObservation, synthetic: false, source_tier: 'REAL' }
      });
      const invalidHorizon = await get(base, '/api/v1/environment-forecast?horizon=-1');
      const invalidStep = await get(base, '/api/v1/environment-forecast?step=abc');
      const invalidEvent = await post(base, '/api/v1/scenario-event', invalidEventExample);
      const snapshot = await get(base, '/api/snapshot');
      const routeDna = await get(base, '/api/route-dna');
      const familyRouteDna = await get(base, `/api/route-dna?tags=${encodeURIComponent('亲子')}`);
      const navigation = await get(base, '/api/navigation?from=gate&to=southgate');
      const navigationByTime = await get(base, '/api/navigation?from=gate&to=southgate&objective=time');
      const navigationByDistance = await get(base, '/api/navigation?from=gate&to=southgate&objective=distance');
      const timestamp = state.body.timestamp;
      const market = Object.fromEntries(await Promise.all([0, 5, 20, 50].map(async offset => [offset, queueFields(await queue(base, 'market', timestamp, offset))])));
      const museum = queueFields(await queue(base, 'museum', timestamp, 5));
      const edge001 = Object.fromEntries(await Promise.all([0, 20, 30, 60, 90].map(async offset => [offset, roadFields(await road(base, 'edge_001', timestamp, offset))])));
      const replan = await post(base, '/api/replan', {});
      const preferences = await post(base, '/api/preferences', { answers: { type: 'free', group: 'friends', mobility: 'normal', interests: ['nature', 'food', 'photo'], queue_tolerance: 2, walking_tolerance: 4, schedule_preference: 2, depth_preference: 4, crowd_sensitivity: 4, novelty_preference: 5, rest_need: 3, photo_preference: 5 }, leaveAt: '15:30', current_node_id: 'southgate' });
      const stateAfterPreference = await get(base, '/api/v1/state');
      const snapshotAfterPreference = await get(base, '/api/snapshot');
      const cPoiClick = await post(base, '/api/c/user-event', { event: { schema_version: state.body.schema_version, scenario_id: state.body.scenario_id, event_type: 'POI_CLICK', target_id: 'market', timestamp } });
      const cRoadClick = await post(base, '/api/c/user-event', { event: { schema_version: state.body.schema_version, scenario_id: state.body.scenario_id, event_type: 'ROAD_CLICK', edge_id: 'edge_001', timestamp } });
      const cInvalidClick = await post(base, '/api/c/user-event', { event: { schema_version: state.body.schema_version, scenario_id: state.body.scenario_id, event_type: 'POI_CLICK', target_id: 'private_poi', timestamp } });
      return { graph, state, forecast, repeated, worldModelStatus, worldModelPrediction, worldModelRealRejected, graphTemporalStatus, graphTemporalPrediction, crowdTrendStatus, crowdTrendPrediction, crowdTrendRealRejected, invalidHorizon, invalidStep, invalidEvent, snapshot, routeDna, familyRouteDna, navigation, navigationByTime, navigationByDistance, market, museum, edge001, replan, preferences, stateAfterPreference, snapshotAfterPreference, cPoiClick, cRoadClick, cInvalidClick };
    });

    await t.test('DNA 路线接口返回扩充后的模板，并按特点真实筛选', () => {
      assert.equal(baseline.routeDna.status, 200);
      assert.ok(baseline.routeDna.body.seeds.length >= 8);
      assert.equal(baseline.familyRouteDna.status, 200);
      assert.ok(baseline.familyRouteDna.body.seeds.length > 0);
      assert.ok(baseline.familyRouteDna.body.seeds.every(route => route.tags.includes('亲子')));
      assert.ok(baseline.familyRouteDna.body.seeds.length < baseline.routeDna.body.seeds.length);
    });

    await t.test('自由点到点导航按距离选最短可行路，时间目标可显式切换', () => {
      assert.equal(baseline.navigation.status, 200);
      assert.equal(baseline.navigation.body.objective, 'time');
      assert.equal(baseline.navigationByTime.status, 200);
      assert.equal(baseline.navigationByTime.body.objective, 'time');
      assert.equal(baseline.navigationByDistance.status, 200);
      assert.equal(baseline.navigationByDistance.body.objective, 'distance');
      assert.ok(baseline.navigationByDistance.body.totalDistance <= baseline.navigationByTime.body.totalDistance);
      assert.equal(baseline.navigationByDistance.body.edgeSequence.length, baseline.navigationByDistance.body.path.length - 1);
    });

    await t.test('C地图点击使用统一ID回传且拒绝未知对象', () => {
      assert.equal(baseline.cPoiClick.status, 202);
      assert.equal(baseline.cPoiClick.body.event.target_id, 'market');
      assert.equal(baseline.cPoiClick.body.event_count, 1);
      assert.equal(baseline.cRoadClick.status, 202);
      assert.equal(baseline.cRoadClick.body.event.edge_id, 'edge_001');
      assert.equal(baseline.cInvalidClick.status, 404);
    });

    await t.test('世界模型实验接口只接受T4合成输入且不进入规划链路', () => {
      assert.equal(baseline.worldModelStatus.status, 200);
      assert.equal(baseline.worldModelStatus.body.mode, 'experimental_shadow');
      assert.equal(baseline.worldModelStatus.body.affects_planning, false);
      assert.equal(baseline.worldModelPrediction.status, 200);
      assert.equal(baseline.worldModelPrediction.body.synthetic, true);
      assert.equal(baseline.worldModelPrediction.body.horizons.target_5.poi_predictions.lake.available, true);
      assert.equal(baseline.worldModelPrediction.body.horizons.target_5.poi_predictions.market.available, true);
      assert.equal(baseline.worldModelRealRejected.status, 400);
    });

    await t.test('图时序模型HTTP影子接口返回多步POI和道路预测', () => {
      assert.equal(baseline.graphTemporalStatus.status, 200);
      assert.equal(baseline.graphTemporalStatus.body.model_version, 'synthetic-world-model-v0.3');
      assert.equal(baseline.graphTemporalStatus.body.affects_planning, false);
      assert.equal(baseline.graphTemporalPrediction.status, 200);
      assert.equal(baseline.graphTemporalPrediction.body.horizons['30'].poi_predictions.fortress.available, true);
      assert.ok(baseline.graphTemporalPrediction.body.horizons['30'].poi_predictions.fortress.nonzero_probability >= 0);
      assert.ok(baseline.graphTemporalPrediction.body.horizons['30'].poi_predictions.fortress.nonzero_probability <= 1);
      assert.equal(baseline.graphTemporalPrediction.body.horizons['30'].road_predictions.edge_001.is_open, true);
    });

    await t.test('拥挤趋势HTTP接口仅接受T4模拟状态并返回地图1路线候选分数', () => {
      assert.equal(baseline.crowdTrendStatus.status, 200);
      assert.equal(baseline.crowdTrendStatus.body.affects_planning, false);
      assert.equal(baseline.crowdTrendPrediction.status, 200);
      assert.equal(baseline.crowdTrendPrediction.body.source_tier, 'T4');
      assert.equal(baseline.crowdTrendPrediction.body.route_scores[0].route_id, 'sample-map1-route');
      assert.equal(baseline.crowdTrendPrediction.body.route_scores_are_comparative_only, true);
      assert.equal(baseline.crowdTrendRealRejected.status, 400);
    });

    await t.test('B完整八维偏好写入后端状态且当前方案可从快照恢复', () => {
      const factors = ['time', 'interest', 'comfort', 'freedom', 'culture', 'nature', 'performance', 'food'];
      assert.equal(baseline.preferences.status, 200);
      assert.deepEqual(Object.keys(baseline.preferences.body.preference).sort(), [...factors].sort());
      assert.deepEqual(Object.keys(baseline.preferences.body.user.preference).sort(), [...factors].sort());
      assert.deepEqual(Object.keys(baseline.stateAfterPreference.body.visitor.preference).sort(), [...factors].sort());
      assert.ok(Math.abs(Object.values(baseline.stateAfterPreference.body.visitor.preference).reduce((sum, value) => sum + value, 0) - 1) < .001);
      assert.equal(baseline.snapshotAfterPreference.body.planResult.plan_id, baseline.preferences.body.planResult.plan_id);
      assert.equal(baseline.snapshotAfterPreference.body.user.currentPlanId, baseline.preferences.body.planResult.plan_id);
      assert.equal(baseline.stateAfterPreference.body.visitor.current_node_id, 'southgate');
    });

    await t.test('个性化路线可选指定离园出口，留空继续自动推荐', async () => {
      await withServer(async base => {
        const answers = { type: 'normal', interests: ['culture', 'nature'] };
        const invalid = await post(base, '/api/preferences', { answers, exit_node_id: 'lake' });
        assert.equal(invalid.status, 400);
        const chosen = await post(base, '/api/preferences', { answers, leaveAt: '18:30', current_node_id: 'gate', exit_node_id: 'westgate' });
        assert.equal(chosen.status, 200);
        assert.equal(chosen.body.user.preferredExitNodeId, 'westgate');
        assert.equal(chosen.body.preferenceProfile.planner_rules.preferred_exit_node_id, 'westgate');
        assert.equal(chosen.body.planResult.itinerary.at(-1)?.target_node_id, 'westgate');
        assert.ok(chosen.body.planResult.alternative_plans.every(plan => plan.itinerary.at(-1)?.target_node_id === 'westgate'));
        const replanned = await post(base, '/api/replan', {});
        assert.equal(replanned.status, 200);
        assert.equal(replanned.body.planResult.itinerary.at(-1)?.target_node_id, 'westgate');
        const automatic = await post(base, '/api/preferences', { answers, leaveAt: '18:30', current_node_id: 'gate', exit_node_id: null });
        assert.equal(automatic.status, 200);
        assert.equal(automatic.body.preferenceProfile.planner_rules.preferred_exit_node_id, undefined);
        assert.equal(automatic.body.user.preferredExitNodeId, undefined);
      });
    });

    await t.test('静态图、当前状态、预测与错误响应', () => {
      assert.equal(baseline.graph.status, 200);
      assert.deepEqual(baseline.graph.body, graphFile);
      assert.equal(baseline.graph.body.nodes.length, graphFile.nodes.length);
      assert.equal(baseline.graph.body.edges.length, graphFile.edges.length);
      const nodes = new Set(baseline.graph.body.nodes.map(node => node.node_id));
      assert.ok(baseline.graph.body.edges.every(edge => nodes.has(edge.from_node_id) && nodes.has(edge.to_node_id)));
      for (const [id, area] of [['market', 'water_margin'], ['juxianzhuang', 'xianxia'], ['summit', 'jianghu_art']]) {
        const node = baseline.graph.body.nodes.find(item => item.node_id === id);
        assert.equal(node.area_id, area);
        assert.deepEqual(node.access_roles, ['AREA_ENTRANCE']);
      }
      for (const id of ['gate', 'southgate', 'westgate', 'eastgate']) {
        const roles = baseline.graph.body.nodes.find(node => node.node_id === id).access_roles;
        assert.ok(roles.includes('PARK_ENTRANCE') && roles.includes('PARK_EXIT'));
      }
      assert.equal(baseline.state.status, 200);
      assert.deepEqual(baseline.state.body, stateFile);
      assert.deepEqual(baseline.state.body, normalStateExample);
      assert.equal(Object.keys(baseline.state.body.poi_states).length, graphFile.nodes.filter(node => node.poi_id).length);
      assert.equal(Object.keys(baseline.state.body.road_states).length, graphFile.edges.length);
      assert.deepEqual(Object.keys(baseline.state.body.poi_states).sort(), baseline.graph.body.nodes.filter(node => node.poi_id).map(node => node.poi_id).sort());
      assert.deepEqual(Object.keys(baseline.state.body.road_states).sort(), baseline.graph.body.edges.map(edge => edge.edge_id).sort());
      assert.ok(baseline.state.body.visitor && baseline.state.body.event_states && baseline.state.body.timestamp && baseline.state.body.state_version);
      assert.equal(baseline.forecast.status, 200);
      assert.deepEqual(baseline.forecast.body, baseline.repeated.body);
      assert.deepEqual(baseline.forecast.body, normalForecastExample);
      assert.equal(baseline.forecast.body.horizon_min, 60);
      assert.equal(baseline.forecast.body.step_min, 10);
      assert.equal(Object.keys(baseline.forecast.body.poi_predictions).length, graphFile.nodes.filter(node => node.poi_id).length);
      assert.equal(Object.keys(baseline.forecast.body.road_predictions).length, graphFile.edges.length);
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
      // The expanded A graph gives the middle gate five valid connections. Close
      // every incident edge so this remains a genuine no-route contract test.
      const incidentGateEdges = graphFile.edges
        .filter(edge => edge.from_node_id === 'gate' || edge.to_node_id === 'gate')
        .map(edge => edge.edge_id);
      const blocked = [];
      for (const edgeId of incidentGateEdges.filter(edgeId => edgeId !== payload.target_id)) {
        blocked.push(await post(base, '/api/v1/scenario-event', { ...payload, target_id: edgeId }));
      }
      const noRoute = await get(base, '/api/navigation?from=gate&to=southgate');
      return { payload, submitted, navigation, blocked, noRoute, incidentGateEdges };
    });
    await t.test('关闭道路绕行及无可行路径', () => {
      assert.equal(closedRoute.submitted.status, 200);
      assert.equal(closedRoute.navigation.status, 200);
      assert.ok(closedRoute.navigation.body.segments.every(segment => segment.edge_id !== 'edge_001'));
      assert.notDeepEqual(closedRoute.navigation.body.path, baseline.navigation.body.path);
      assert.ok(closedRoute.blocked.every(response => response.status === 200));
      assert.ok(closedRoute.incidentGateEdges.length >= 2);
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
      const futureEdge = futureSlowdown.navigation.body.segments.find(segment => segment.edge_id === 'edge_020');
      const baselineEdge = closedRoute.navigation.body.segments.find(segment => segment.edge_id === 'edge_020');
      // A slowdown may either trigger a detour or remain the least-cost route
      // while carrying the increased predicted traversal time.
      assert.ok(!futureEdge || futureEdge.minutes > baselineEdge.minutes);
      assert.ok(futureSlowdown.navigation.body.totalMinutes > closedRoute.navigation.body.totalMinutes ||
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
      if (process.env.UPDATE_HTTP_EXAMPLE === '1') {
        fs.writeFileSync(examplePath, `${JSON.stringify(sample, null, 2)}\n`, 'utf8');
      }
      assert.deepEqual(sample, JSON.parse(fs.readFileSync(examplePath, 'utf8')));
    });
  });
