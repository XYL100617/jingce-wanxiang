const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { getScenicGraph, getState } = require('../state/stateProvider');
const { predictEnvironment } = require('../state/forecastSimulator');
const { applyScenarioEvent, parseTime, stamp } = require('../state/scenarioEngine');
const { queryQueue, queryTravelTime } = require('../state/forecastQuery');
const scenarios = require('../data/scenarios.json');

const graph = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/scenic_graph.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/current_state.json'), 'utf8'));
const freshState = () => JSON.parse(JSON.stringify(state));
const results = [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const arrayDifferences = (expected, actual) => Array.from({ length: Math.max(expected.length, actual.length) }, (_, index) => ({ index, expected: expected[index], actual: actual[index] })).filter(row => row.expected !== row.actual);
function isolatedRuntime(prepare) {
  for (const modulePath of ['../state/stateProvider', '../state/scenarioEngine', '../state/forecastSimulator', '../index']) delete require.cache[require.resolve(modulePath)];
  const provider = require('../state/stateProvider');
  const simulator = require('../state/forecastSimulator');
  const scenario = require('../state/scenarioEngine');
  if (prepare) prepare({ provider, simulator, scenario });
  const { server, updateEnvironment } = require('../index');
  return { provider, simulator, scenario, server, updateEnvironment };
}
function readJsonThroughGet(server, url) {
  let status, body;
  server.emit('request', { method: 'GET', url, headers: { host: 'localhost' } }, {
    writeHead(code) { status = code; },
    end(value) { body = JSON.parse(value); }
  });
  if (body === undefined) throw new Error(`GET ${url} did not return a response`);
  return { status, body };
}
function readJsonThroughGetAsync(server, url) {
  return new Promise(resolve => {
    let status;
    server.emit('request', { method: 'GET', url, headers: { host: 'localhost' } }, {
      writeHead(code) { status = code; },
      end(value) { resolve({ status, body: JSON.parse(value) }); }
    });
  });
}
function readJsonThroughPostAsync(server, url, body) {
  return new Promise(resolve => {
    let status;
    const request = new EventEmitter();
    Object.assign(request, { method: 'POST', url, headers: { host: 'localhost' } });
    server.emit('request', request, {
      writeHead(code) { status = code; },
      end(value) { resolve({ status, body: JSON.parse(value) }); }
    });
    request.emit('data', Buffer.from(JSON.stringify(body)));
    request.emit('end');
  });
}
const readStateThroughGet = server => readJsonThroughGet(server, '/api/v1/state');
function runOneMinuteUpdate() {
  const { provider, simulator, server, updateEnvironment } = isolatedRuntime();
  const prepared = provider.getState();
  prepared.poi_states.market.crowd_ratio = 0.6999;
  prepared.poi_states.market.crowd_level = 'MEDIUM';
  provider.setState(prepared);
  const before = provider.getState();
  const forecast = simulator.predictEnvironment(before, 1, 1);
  updateEnvironment();
  return { before, forecast, after: provider.getState(), reread: provider.getState(), api: readStateThroughGet(server) };
}
function runRoadLifecycle() {
  const { provider, simulator, scenario, updateEnvironment } = isolatedRuntime();
  const initial = provider.getState();
  const afterEvent = provider.setState(scenario.applyScenarioEvent(initial, { event_type: 'ROAD_CLOSE', target_id: 'edge_001' }));
  const event = afterEvent.scenario_events.at(-1);
  const startOffset = (parseTime(event.timestamp, 'event timestamp') - parseTime(afterEvent.timestamp, 'state timestamp')) / 60000;
  const endOffset = (parseTime(event.end_time, 'event end time') - parseTime(afterEvent.timestamp, 'state timestamp')) / 60000;
  const forecast = simulator.predictEnvironment(afterEvent, endOffset + 10, 10);
  const sampleMinutes = [...new Set([0, startOffset - 1, startOffset, startOffset + Math.floor((endOffset - startOffset) / 2), endOffset - 1, endOffset])];
  const samples = [];
  for (let minute = 0; minute <= endOffset; minute++) {
    if (minute > 0) updateEnvironment();
    if (sampleMinutes.includes(minute)) {
      const current = provider.getState();
      samples.push({ minute, timestamp: current.timestamp, state_version: current.state_version, available: current.road_states.edge_001.available, travel_time_min: current.road_states.edge_001.travel_time_min });
    }
  }
  return { config: scenarios.ROAD_CLOSE, initial, afterEvent, event, startOffset, endOffset, forecast: forecast.road_predictions.edge_001.map(point => ({ offset_min: point.offset_min, available: point.available })), samples, final: provider.getState() };
}
function runLongTermConsistency() {
  const { provider, simulator, scenario, updateEnvironment } = isolatedRuntime();
  const initial = provider.getState();
  const direct = simulator.predictEnvironment(initial, 60, 10);
  for (let minute = 0; minute < 60; minute++) updateEnvironment();
  const stepped = provider.getState();
  const afterEvent = provider.setState(scenario.applyScenarioEvent(stepped, { event_type: 'QUEUE_SPIKE', target_id: 'market', timestamp: stepped.timestamp }));
  const afterEventDirect = simulator.predictEnvironment(afterEvent, 1, 1);
  updateEnvironment();
  return { initial, direct, stepped, afterEvent, afterEventDirect, afterEventStepped: provider.getState() };
}

function printSummary() {
  const passed = results.filter(item => item.status === 'PASS').length;
  const failed = results.filter(item => item.status === 'FAIL').length;
  const status = name => results.find(item => item.name === name)?.status || '未执行';
  console.log('\n【契约测试汇总】');
  console.log(JSON.stringify({
    executed: results.length, passed, failed, tests: results,
    normal_sampling: status('NORMAL 预测结构与常规采样点'),
    road_close_boundary: status('道路关闭时间边界'),
    closed_road_fields: status('关闭道路的通行时间字段'),
    off_grid_boundary: status('非整十分钟事件边界'),
    repeatability: status('预测可重复性'),
    new_issues: failed ? '存在失败项，详见数据对比和断言错误' : '本次断言未发现新问题'
  }, null, 2));
  if (failed) console.log(`本次已执行 ${results.length} 项，通过 ${passed} 项、失败 ${failed} 项；后续项目未执行。`);
  else console.log(`本次 A 模块契约测试共执行 ${results.length} 项，通过 ${passed} 项、失败 0 项；各项均符合当前接口约定。`);
}

function runTest(name, collect, verify) {
  const result = { name, status: 'FAIL' };
  results.push(result);
  console.log(`\n【${name}】`);
  try {
    const data = collect();
    console.log(JSON.stringify(data, null, 2));
    verify();
    result.status = 'PASS';
    console.log('结论: PASS（本项全部断言通过）');
  } catch (error) {
    console.error(`结论: FAIL（${name}）`);
    console.error(error.stack || error);
    printSummary();
    process.exitCode = 1;
    throw error;
  }
}
async function runAsyncTest(name, collect, verify) {
  const result = { name, status: 'FAIL' };
  results.push(result);
  console.log(`\n【${name}】`);
  try {
    const data = await collect();
    console.log(JSON.stringify(data, null, 2));
    await verify();
    result.status = 'PASS';
    console.log('结论: PASS（本项全部断言通过）');
  } catch (error) {
    console.error(`结论: FAIL（${name}）`);
    console.error(error.stack || error);
    printSummary();
    process.exitCode = 1;
    throw error;
  }
}

const nodes = new Set(graph.nodes.map(node => node.node_id));
const pois = new Set(graph.nodes.map(node => node.poi_id).filter(Boolean));
const edges = new Set(graph.edges.map(edge => edge.edge_id));
const expectedNodeIds = ['gate', 'southgate', 'lake', 'market', 'museum', 'longtan', 'forest', 'theater', 'shizipo', 'summit', 'rest', 'temple', 'juxianzhuang'].sort();
const expectedEdgeIds = Array.from({ length: 20 }, (_, index) => `edge_${String(index + 1).padStart(3, '0')}`);
let providerGraph, providerState;
let stateShape;
runTest('图与初始状态契约', () => {
  providerGraph = getScenicGraph();
  providerState = getState();
  const visitorFields = ['current_node_id', 'remaining_time_min', 'fatigue', 'visited_poi_ids', 'preference'];
  const poiFields = ['open', 'queue_min', 'crowd_level', 'crowd_ratio'];
  const roadFields = ['available', 'travel_time_min'];
  const eventFields = ['status', 'start_time', 'latest_entry_time'];
  stateShape = {
    timestamp_valid: Number.isFinite(parseTime(state.timestamp, 'state timestamp')),
    poi_ids_match: same(Object.keys(state.poi_states).sort(), [...pois].sort()),
    road_ids_match: same(Object.keys(state.road_states).sort(), [...edges].sort()),
    missing_visitor_fields: visitorFields.filter(field => !(field in state.visitor)),
    missing_poi_fields: Object.entries(state.poi_states).flatMap(([id, poi]) => poiFields.filter(field => !(field in poi)).map(field => `${id}.${field}`)),
    missing_road_fields: Object.entries(state.road_states).flatMap(([id, road]) => roadFields.filter(field => !(field in road)).map(field => `${id}.${field}`)),
    missing_event_fields: Object.entries(state.event_states).flatMap(([id, event]) => eventFields.filter(field => !(field in event)).map(field => `${id}.${field}`)),
    poi_type_issues: Object.entries(state.poi_states).flatMap(([id, poi]) => [typeof poi.open === 'boolean', Number.isFinite(poi.queue_min) && poi.queue_min >= 0, Number.isFinite(poi.crowd_ratio) && poi.crowd_ratio >= 0 && poi.crowd_ratio <= 1, ['LOW', 'MEDIUM', 'HIGH'].includes(poi.crowd_level)].every(Boolean) ? [] : [id]),
    road_type_issues: Object.entries(state.road_states).flatMap(([id, road]) => typeof road.available === 'boolean' && Number.isFinite(road.travel_time_min) && road.travel_time_min > 0 ? [] : [id]),
    visitor_values_valid: nodes.has(state.visitor.current_node_id) && Number.isFinite(state.visitor.remaining_time_min) && state.visitor.remaining_time_min >= 0 && Number.isFinite(state.visitor.fatigue) && state.visitor.fatigue >= 0 && state.visitor.fatigue <= 1 && Array.isArray(state.visitor.visited_poi_ids) && state.visitor.visited_poi_ids.every(id => pois.has(id)) && (state.visitor.preference === null || typeof state.visitor.preference === 'object'),
    event_values_valid: Object.values(state.event_states).every(event => typeof event.status === 'string' && Number.isFinite(parseTime(event.start_time, 'event start time')) && Number.isFinite(parseTime(event.latest_entry_time, 'latest entry time')))
  };
  return {
    expected: { graph_matches_file: true, state_matches_file: true, node_count: 13, edge_count: 20, node_ids: expectedNodeIds, edge_ids: expectedEdgeIds, invalid_references: [], poi_ids_match: true, road_ids_match: true, state_field_issues: [] },
    actual: {
      graph_matches_file: same(providerGraph, graph), state_matches_file: same(providerState, state),
      node_count: graph.nodes.length, edge_count: graph.edges.length, unique_node_count: nodes.size, unique_edge_count: edges.size,
      node_ids: [...nodes].sort(), edge_ids: [...edges].sort(),
      state_fields: Object.fromEntries(['schema_version', 'scenario_id', 'state_version'].map(field => [field, state[field]])),
      state_shape: stateShape,
      invalid_edge_ids: graph.edges.filter(edge => !nodes.has(edge.from_node_id) || !nodes.has(edge.to_node_id)).map(edge => edge.edge_id),
      invalid_poi_ids: Object.keys(state.poi_states).filter(id => !pois.has(id)),
      invalid_road_ids: Object.keys(state.road_states).filter(id => !edges.has(id)),
      invalid_event_node_ids: Object.values(state.event_states).filter(event => !nodes.has(event.node_id)).map(event => event.node_id)
    }
  };
}, () => {
  assert.deepEqual(providerGraph, graph);
  assert.deepEqual(providerState, state);
  for (const field of ['schema_version', 'scenario_id', 'state_version']) assert.ok(state[field], field);
  assert.equal(graph.nodes.length, 13);
  assert.equal(graph.edges.length, 20);
  assert.deepEqual([...nodes].sort(), expectedNodeIds);
  assert.deepEqual([...edges].sort(), expectedEdgeIds);
  assert.equal(nodes.size, graph.nodes.length);
  assert.equal(edges.size, graph.edges.length);
  for (const edge of graph.edges) { assert.ok(nodes.has(edge.from_node_id)); assert.ok(nodes.has(edge.to_node_id)); }
  for (const id of Object.keys(state.poi_states)) assert.ok(pois.has(id));
  for (const id of Object.keys(state.road_states)) assert.ok(edges.has(id));
  for (const event of Object.values(state.event_states)) assert.ok(nodes.has(event.node_id));
  assert.equal(stateShape.timestamp_valid, true);
  assert.equal(stateShape.poi_ids_match, true);
  assert.equal(stateShape.road_ids_match, true);
  for (const field of ['missing_visitor_fields', 'missing_poi_fields', 'missing_road_fields', 'missing_event_fields', 'poi_type_issues', 'road_type_issues']) assert.deepEqual(stateShape[field], [], field);
  assert.equal(stateShape.visitor_values_valid, true);
  assert.equal(stateShape.event_values_valid, true);
});

const originalTargetNodes = {
  gate: { node_id: 'gate', id: 'gate', name: '北门入口', type: 'gate', algorithm_x: 8, algorithm_y: 78, capacity: 999, shade: 0.75, tags: ['入口', '检票', '服务'] },
  southgate: { node_id: 'southgate', id: 'southgate', name: '南门入口', type: 'gate', algorithm_x: 10, algorithm_y: 46, capacity: 999, shade: 0.62, tags: ['入口', '停车', '服务'] },
  market: { node_id: 'market', id: 'market', poi_id: 'market', name: '非遗市集', type: 'culture', algorithm_x: 43, algorithm_y: 78, capacity: 220, shade: 0.42, tags: ['美食', '市集', '自由探索'] },
  juxianzhuang: { node_id: 'juxianzhuang', id: 'juxianzhuang', poi_id: 'juxianzhuang', name: '聚贤庄', type: 'culture', algorithm_x: 61, algorithm_y: 77, capacity: 130, shade: 0.52, tags: ['街巷', '互动', '美食'] },
  summit: { node_id: 'summit', id: 'summit', poi_id: 'summit', name: '明清城墙观景点', type: 'view', algorithm_x: 85, algorithm_y: 78, capacity: 80, shade: 0.18, tags: ['城墙', '视野', '拍照'] }
};
const targetRoles = {
  gate: { access_roles: ['PARK_ENTRANCE', 'PARK_EXIT'] },
  southgate: { access_roles: ['PARK_ENTRANCE', 'PARK_EXIT'] },
  market: { area_id: 'water_margin', access_roles: ['AREA_ENTRANCE'] },
  juxianzhuang: { area_id: 'xianxia', access_roles: ['AREA_ENTRANCE'] },
  summit: { area_id: 'jianghu_art', access_roles: ['AREA_ENTRANCE'] }
};
let staticGraphApi, legacyGraph, staticProviderState, originalAttributeMismatches;
runTest('静态图区域入口与园门角色', () => {
  const { provider, server } = isolatedRuntime();
  staticGraphApi = readJsonThroughGet(server, '/api/v1/scenic-graph');
  legacyGraph = provider.getLegacyGraph();
  staticProviderState = provider.getState();
  originalAttributeMismatches = Object.keys(originalTargetNodes).filter(id => {
    const { area_id, access_roles, ...original } = graph.nodes.find(node => node.node_id === id) || {};
    return !isDeepStrictEqual(original, originalTargetNodes[id]);
  });
  const roles = source => Object.fromEntries(Object.keys(targetRoles).map(id => {
    const node = source.nodes.find(item => item.node_id === id);
    return [id, { area_id: node?.area_id ?? null, access_roles: node?.access_roles ?? null }];
  }));
  return {
    expected: { roles: Object.fromEntries(Object.entries(targetRoles).map(([id, value]) => [id, { area_id: value.area_id ?? null, access_roles: value.access_roles }])), original_attribute_mismatches: [], api_status: 200, legacy_nodes: 13, legacy_edges: 20, poi_states: pois.size },
    actual: { roles: roles(graph), original_attribute_mismatches: originalAttributeMismatches, api_status: staticGraphApi.status, api_roles: roles(staticGraphApi.body), api_graph_matches_file: isDeepStrictEqual(staticGraphApi.body, graph), legacy_nodes: legacyGraph.nodes.length, legacy_edges: legacyGraph.edges.length, legacy_node_ids: legacyGraph.nodes.map(node => node.id).sort(), poi_states: Object.keys(staticProviderState.poi_states).length }
  };
}, () => {
  for (const [id, expected] of Object.entries(targetRoles)) {
    const node = graph.nodes.find(item => item.node_id === id);
    assert.ok(node, id);
    const { area_id, access_roles, ...original } = node;
    assert.deepEqual(original, originalTargetNodes[id], `${id} original attributes`);
    assert.equal(area_id, expected.area_id, `${id} area_id`);
    assert.deepEqual(access_roles, expected.access_roles, `${id} access_roles`);
  }
  assert.deepEqual(originalAttributeMismatches, []);
  assert.equal(staticGraphApi.status, 200);
  assert.deepEqual(staticGraphApi.body, graph);
  assert.deepEqual(legacyGraph.nodes.map(node => node.id).sort(), expectedNodeIds);
  assert.deepEqual(legacyGraph.edges, graph.edges.map(edge => [edge.from_node_id, edge.to_node_id, edge.distance_m, edge.base_travel_time_min, edge.shade]));
  for (const [id, original] of Object.entries(originalTargetNodes)) {
    const legacy = legacyGraph.nodes.find(node => node.id === id);
    assert.equal(legacy.type, original.type);
    assert.equal(legacy.x, original.algorithm_x);
    assert.equal(legacy.y, original.algorithm_y);
  }
  assert.deepEqual(Object.keys(staticProviderState.poi_states).sort(), [...pois].sort());
  assert.deepEqual(getState(), state);
});

let normal, normalAgain;
runTest('NORMAL 预测结构与常规采样点', () => {
  normal = predictEnvironment(state, 60, 10);
  normalAgain = predictEnvironment(state, 60, 10);
  const expected = [0, 10, 20, 30, 40, 50, 60];
  const actual = normal.road_predictions.edge_001.map(point => point.offset_min);
  const missingPoiFields = Object.entries(normal.poi_predictions).flatMap(([id, points]) => points.flatMap((point, index) => ['queue_min', 'crowd_ratio', 'crowd_level', 'open'].filter(key => !(key in point)).map(key => `${id}[${index}].${key}`)));
  const missingRoadFields = Object.entries(normal.road_predictions).flatMap(([id, points]) => points.flatMap((point, index) => ['travel_time_min', 'available'].filter(key => !(key in point)).map(key => `${id}[${index}].${key}`)));
  return {
    expected: { schema_version: '0.1', horizon_min: 60, step_min: 10, offset_min: expected, point_count: 7, poi_ids: [...pois].sort(), road_ids: [...edges].sort(), missing_fields: [] },
    actual: { schema_version: normal.schema_version, horizon_min: normal.horizon_min, step_min: normal.step_min, offset_min: actual, point_count: actual.length, poi_ids: Object.keys(normal.poi_predictions).sort(), road_ids: Object.keys(normal.road_predictions).sort(), poi_point_counts: Object.fromEntries(Object.entries(normal.poi_predictions).map(([id, points]) => [id, points.length])), missing_poi_fields: missingPoiFields, missing_road_fields: missingRoadFields, forecast_version: normal.forecast_version },
    comparison: { sampling_matches: same(expected, actual), mismatches: arrayDifferences(expected, actual), point_count_matches: actual.length === 7, full_forecast_repeats: same(normal, normalAgain) }
  };
}, () => {
  assert.equal(normal.schema_version, '0.1');
  assert.equal(normal.horizon_min, 60);
  assert.equal(normal.step_min, 10);
  assert.deepEqual(normal.road_predictions.edge_001.map(point => point.offset_min), [0, 10, 20, 30, 40, 50, 60]);
  assert.ok(normal.forecast_version);
  assert.deepEqual(normal, normalAgain);
  assert.deepEqual(Object.keys(normal.poi_predictions).sort(), [...pois].sort());
  assert.deepEqual(Object.keys(normal.road_predictions).sort(), [...edges].sort());
  for (const points of Object.values(normal.poi_predictions)) { assert.equal(points.length, 7); for (const point of points) for (const key of ['queue_min', 'crowd_ratio', 'crowd_level', 'open']) assert.ok(key in point); }
  for (const points of Object.values(normal.road_predictions)) for (const point of points) for (const key of ['travel_time_min', 'available']) assert.ok(key in point);
});

let spike, spikeAt20, normalAt20, spikeQuery, normalQuery;
runTest('排队突增预测与查询', () => {
  spike = predictEnvironment(applyScenarioEvent(state, { event_type: 'QUEUE_SPIKE', target_id: 'theater' }), 60, 10);
  spikeAt20 = spike.poi_predictions.theater.find(point => point.offset_min === 20).queue_min;
  normalAt20 = normal.poi_predictions.theater.find(point => point.offset_min === 20).queue_min;
  spikeQuery = queryQueue(spike, 'theater', '2026-10-20 10:43:00').queue_min;
  normalQuery = queryQueue(normal, 'theater', '2026-10-20 10:43:00').queue_min;
  return { expected: { queue_at_20: `> ${normalAt20 + 20}`, queried_queue: `> ${normalQuery}` }, actual: { normal_queue_at_20: normalAt20, spike_queue_at_20: spikeAt20, normal_queried_queue: normalQuery, spike_queried_queue: spikeQuery }, comparison: { increase_exceeds_20: spikeAt20 > normalAt20 + 20, query_increased: spikeQuery > normalQuery } };
}, () => {
  assert.ok(spikeAt20 > normalAt20 + 20);
  assert.ok(spikeQuery > normalQuery);
});

let closed, defaultClosedState, defaultClosedForecast, defaultRoadPoints, boundaryRows;
runTest('道路关闭时间边界', () => {
  const config = scenarios.ROAD_CLOSE;
  closed = predictEnvironment(applyScenarioEvent(state, { event_type: 'ROAD_CLOSE', target_id: 'edge_001' }), 60, 10);
  defaultClosedState = applyScenarioEvent(freshState(), { event_type: 'ROAD_CLOSE', target_id: 'edge_001' });
  defaultClosedForecast = predictEnvironment(defaultClosedState, 100, 10);
  defaultRoadPoints = defaultClosedForecast.road_predictions.edge_001;
  const record = defaultClosedState.scenario_events.at(-1);
  const start = parseTime(state.timestamp, 'state timestamp') + config.start_offset_min * 60000;
  const end = start + config.duration_min * 60000;
  boundaryRows = [
    { label: '关闭前', time: stamp(start - 1000), expected_available: true },
    { label: '关闭开始时', time: stamp(start), expected_available: false },
    { label: '关闭期间', time: stamp(start + 12 * 60000), expected_available: false },
    { label: '关闭结束前', time: stamp(end - 1000), expected_available: false },
    { label: '关闭结束时', time: stamp(end), expected_available: true }
  ].map(row => ({ ...row, actual_available: queryTravelTime(defaultClosedForecast, 'edge_001', row.time).available })).map(row => ({ ...row, matches: row.expected_available === row.actual_available }));
  return {
    config: { start_offset_min: config.start_offset_min, duration_min: config.duration_min, base_timestamp: state.timestamp },
    expected: { start_time: stamp(start), end_time: stamp(end), interval: '[start, end)', offsets: Array.from({ length: 11 }, (_, index) => index * 10), current_state_available: true },
    actual: { recorded_start_time: record.timestamp, recorded_end_time: record.end_time, offsets: defaultRoadPoints.map(point => point.offset_min), current_state_available: defaultClosedState.road_states.edge_001.available, boundary_queries: boundaryRows, samples: [20, 30, 80, 90].map(offset => ({ offset_min: offset, available: defaultRoadPoints.find(point => point.offset_min === offset).available })) },
    comparison: { offset_mismatches: arrayDifferences(Array.from({ length: 11 }, (_, index) => index * 10), defaultRoadPoints.map(point => point.offset_min)) }
  };
}, () => {
  assert.equal(queryTravelTime(closed, 'edge_001', '2026-10-20 10:47:00').available, true);
  assert.equal(queryTravelTime(closed, 'edge_001', '2026-10-20 10:48:00').available, false);
  assert.equal(queryTravelTime(closed, 'edge_001', '2026-10-20 11:00:00').available, false);
  assert.equal(scenarios.ROAD_CLOSE.start_offset_min, 30);
  assert.equal(scenarios.ROAD_CLOSE.duration_min, 60);
  assert.equal(defaultClosedState.scenario_events.at(-1).timestamp, '2026-10-20 10:48:00');
  assert.equal(defaultClosedState.scenario_events.at(-1).end_time, '2026-10-20 11:48:00');
  assert.equal(defaultClosedState.road_states.edge_001.available, true);
  assert.deepEqual(defaultRoadPoints.map(point => point.offset_min), Array.from({ length: 11 }, (_, index) => index * 10));
  for (const row of boundaryRows) assert.equal(row.actual_available, row.expected_available, row.time);
  assert.equal(defaultRoadPoints.find(point => point.offset_min === 20).available, true);
  assert.equal(defaultRoadPoints.find(point => point.offset_min === 30).available, false);
  assert.equal(defaultRoadPoints.find(point => point.offset_min === 80).available, false);
  assert.equal(defaultRoadPoints.find(point => point.offset_min === 90).available, true);
});

let normalExtended, closedQuery;
runTest('关闭道路的通行时间字段', () => {
  normalExtended = predictEnvironment(freshState(), 100, 10);
  const closedPoints = defaultRoadPoints.filter(point => !point.available);
  closedQuery = queryTravelTime(defaultClosedForecast, 'edge_001', '2026-10-20 10:48:00');
  return {
    expected: { available: false, travel_time_type: 'number', finite_positive: true, matches_normal_reference: true },
    actual: {
      closed_samples: closedPoints.map(point => ({ offset_min: point.offset_min, available: point.available, travel_time_min: point.travel_time_min, type: typeof point.travel_time_min, finite_positive: Number.isFinite(point.travel_time_min) && point.travel_time_min > 0, normal_reference_min: normalExtended.road_predictions.edge_001.find(candidate => candidate.offset_min === point.offset_min).travel_time_min })),
      queryTravelTime: closedQuery, query_travel_time_type: typeof closedQuery.travel_time_min,
      query_matches_start_sample: closedQuery.travel_time_min === defaultRoadPoints.find(point => point.offset_min === 30).travel_time_min
    }
  };
}, () => {
  for (const point of defaultRoadPoints.filter(point => !point.available)) {
    assert.equal(typeof point.travel_time_min, 'number');
    assert.ok(Number.isFinite(point.travel_time_min) && point.travel_time_min > 0);
    assert.equal(point.travel_time_min, normalExtended.road_predictions.edge_001.find(candidate => candidate.offset_min === point.offset_min).travel_time_min);
  }
  assert.equal(closedQuery.available, false);
  assert.equal(typeof closedQuery.travel_time_min, 'number');
  assert.equal(closedQuery.travel_time_min, defaultRoadPoints.find(point => point.offset_min === 30).travel_time_min);
});

const offGridEvent = { event_type: 'ROAD_CLOSE', target_id: 'edge_001', timestamp: '2026-10-20 10:35:00', duration_min: 25 };
const untouchedState = freshState();
let offGridFirst, offGridPoints, baseTime, offGridRows;
runTest('非整十分钟事件边界', () => {
  const eventState = applyScenarioEvent(freshState(), offGridEvent);
  offGridFirst = predictEnvironment(eventState, 60, 10);
  offGridPoints = offGridFirst.road_predictions.edge_001;
  baseTime = parseTime(offGridFirst.base_timestamp, 'base timestamp');
  const record = eventState.scenario_events.at(-1);
  const start = parseTime(record.timestamp, 'event timestamp');
  const end = parseTime(record.end_time, 'event end_time');
  const baseGrid = Array.from({ length: 7 }, (_, index) => index * offGridFirst.step_min);
  const offsets = offGridPoints.map(point => point.offset_min);
  offGridRows = [
    { label: '开始前', time: stamp(start - 1000), expected_available: true },
    { label: '开始时', time: stamp(start), expected_available: false },
    { label: '结束前', time: stamp(end - 1000), expected_available: false },
    { label: '结束时', time: stamp(end), expected_available: true }
  ].map(row => ({ ...row, query_result: queryTravelTime(offGridFirst, 'edge_001', row.time) }));
  return {
    event: { recorded_start_time: record.timestamp, recorded_end_time: record.end_time, start_offset_min: (start - baseTime) / 60000, end_offset_min: (end - baseTime) / 60000 },
    expected: { step_min: 10, horizon_min: 60, base_grid: baseGrid, extra_event_boundaries: [(start - baseTime) / 60000, (end - baseTime) / 60000], offsets: [0, 10, 17, 20, 30, 40, 42, 50, 60] },
    actual: { offsets, poi_offsets: offGridFirst.poi_predictions.theater.map(point => point.offset_min), boundary_queries: offGridRows.map(row => ({ label: row.label, time: row.time, expected_available: row.expected_available, actual_available: row.query_result.available, actual_type: typeof row.query_result.available, matches: row.query_result.available === row.expected_available })), timestamp_offsets_match: offGridPoints.every(point => parseTime(point.timestamp, 'prediction timestamp') - baseTime === point.offset_min * 60000) },
    comparison: { offset_mismatches: arrayDifferences([0, 10, 17, 20, 30, 40, 42, 50, 60], offsets), base_grid_present: baseGrid.every(offset => offsets.includes(offset)), event_boundaries_present: [start, end].every(time => offsets.includes((time - baseTime) / 60000)), strictly_increasing: offsets.every((offset, index) => index === 0 || offset > offsets[index - 1]) }
  };
}, () => {
  assert.equal(offGridFirst.step_min, 10);
  assert.equal(offGridFirst.horizon_min, 60);
  assert.deepEqual(offGridPoints.map(point => point.offset_min), [0, 10, 17, 20, 30, 40, 42, 50, 60]);
  assert.deepEqual(offGridFirst.poi_predictions.theater.map(point => point.offset_min), offGridPoints.map(point => point.offset_min));
  for (const point of offGridPoints) assert.equal(parseTime(point.timestamp, 'prediction timestamp') - baseTime, point.offset_min * 60000);
  for (const row of offGridRows) {
    assert.equal(row.query_result.available, row.expected_available, row.time);
    assert.equal(typeof row.query_result.available, 'boolean');
  }
});

let inputA, inputB, forecastA, offGridSecond;
runTest('预测可重复性', () => {
  inputA = freshState();
  inputB = freshState();
  forecastA = predictEnvironment(applyScenarioEvent(inputA, offGridEvent), 60, 10);
  offGridSecond = predictEnvironment(applyScenarioEvent(inputB, offGridEvent), 60, 10);
  const select = forecast => [17, 42].map(offset => ({
    offset_min: offset,
    available: forecast.road_predictions.edge_001.find(point => point.offset_min === offset).available,
    travel_time_min: forecast.road_predictions.edge_001.find(point => point.offset_min === offset).travel_time_min,
    theater_queue_min: forecast.poi_predictions.theater.find(point => point.offset_min === offset).queue_min
  }));
  return {
    inputs: { independent_copies: inputA !== inputB, same_initial_values: same(inputA, inputB), base_timestamp_A: inputA.timestamp, base_timestamp_B: inputB.timestamp, event: offGridEvent, horizon_min: 60, step_min: 10 },
    expected: { full_forecasts_equal: true, original_state_unchanged: true },
    actual: { forecast_A: { version: forecastA.forecast_version, offsets: forecastA.road_predictions.edge_001.map(point => point.offset_min), selected_points: select(forecastA) }, forecast_B: { version: offGridSecond.forecast_version, offsets: offGridSecond.road_predictions.edge_001.map(point => point.offset_min), selected_points: select(offGridSecond) }, full_forecasts_equal: same(forecastA, offGridSecond), original_state_unchanged: same(state, untouchedState) }
  };
}, () => {
  assert.notStrictEqual(inputA, inputB);
  assert.deepEqual(inputA, inputB);
  assert.deepEqual(forecastA, offGridSecond);
  assert.deepEqual(offGridFirst, offGridSecond);
  assert.deepEqual(state, untouchedState);
});

let slowed;
runTest('道路减速预测', () => {
  slowed = predictEnvironment(applyScenarioEvent(state, { event_type: 'ROAD_SLOWDOWN', target_id: 'edge_001' }), 60, 10);
  const normalTime = normal.road_predictions.edge_001[0].travel_time_min;
  const slowedTime = slowed.road_predictions.edge_001[0].travel_time_min;
  return { expected: { slowed_travel_time_min: `> ${normalTime}` }, actual: { normal_travel_time_min: normalTime, slowed_travel_time_min: slowedTime, increased: slowedTime > normalTime } };
}, () => assert.ok(slowed.road_predictions.edge_001[0].travel_time_min > normal.road_predictions.edge_001[0].travel_time_min));

let immediateSpike, expiredSpikeQueue;
runTest('即时排队突增结束', () => {
  immediateSpike = applyScenarioEvent(state, { event_type: 'QUEUE_SPIKE', target_id: 'theater', timestamp: state.timestamp, duration_min: 10 });
  expiredSpikeQueue = predictEnvironment(immediateSpike, 20, 10).poi_predictions.theater.at(-1).queue_min;
  return { expected: { queue_at_20: `< ${immediateSpike.poi_states.theater.queue_min}` }, actual: { current_queue_min: immediateSpike.poi_states.theater.queue_min, queue_at_20: expiredSpikeQueue, decreased_after_expiry: expiredSpikeQueue < immediateSpike.poi_states.theater.queue_min } };
}, () => assert.ok(expiredSpikeQueue < immediateSpike.poi_states.theater.queue_min));

let halfway, travelQuery;
runTest('时间查询插值与错误处理', () => {
  halfway = queryQueue(normal, 'market', '2026-10-20 10:23:00');
  travelQuery = queryTravelTime(normal, 'edge_001', '2026-10-20 10:23:00');
  const invalidCases = [
    { label: '未知 POI', expected_error: 'Unknown poi_id', call: () => queryQueue(normal, 'missing', state.timestamp) },
    { label: '未知道路', expected_error: 'Unknown edge_id', call: () => queryTravelTime(normal, 'missing', state.timestamp) },
    { label: '非法时间', expected_error: 'Invalid timestamp', call: () => queryQueue(normal, 'market', 'bad time') },
    { label: '无效日期', expected_error: 'Invalid timestamp', call: () => queryQueue(normal, 'market', '2026-02-30 10:20:00') },
    { label: '超出范围', expected_error: 'horizon', call: () => queryQueue(normal, 'market', '2026-10-20 12:00:00') }
  ];
  const errors = invalidCases.map(item => {
    try { item.call(); return { label: item.label, expected_error: item.expected_error, actual_error: null, matches: false }; }
    catch (error) { return { label: item.label, expected_error: item.expected_error, actual_error: error.message, matches: error.message.includes(item.expected_error) }; }
  });
  return { expected: { halfway_queue_min: (normal.poi_predictions.market[0].queue_min + normal.poi_predictions.market[1].queue_min) / 2, travel_time_positive: true, error_patterns: invalidCases.map(item => item.expected_error) }, actual: { halfway_queue_min: halfway.queue_min, travel_time_min: travelQuery.travel_time_min, travel_time_positive: travelQuery.travel_time_min > 0, errors } };
}, () => {
  assert.equal(halfway.queue_min, (normal.poi_predictions.market[0].queue_min + normal.poi_predictions.market[1].queue_min) / 2);
  assert.ok(travelQuery.travel_time_min > 0);
  assert.throws(() => queryQueue(normal, 'missing', state.timestamp), /Unknown poi_id/);
  assert.throws(() => queryTravelTime(normal, 'missing', state.timestamp), /Unknown edge_id/);
  assert.throws(() => queryQueue(normal, 'market', 'bad time'), /Invalid timestamp/);
  assert.throws(() => queryQueue(normal, 'market', '2026-02-30 10:20:00'), /Invalid timestamp/);
  assert.throws(() => queryQueue(normal, 'market', '2026-10-20 12:00:00'), /horizon/);
});

let copy;
runTest('状态读取返回副本', () => {
  copy = getState();
  copy.poi_states.market.queue_min = 999;
  const reread = getState();
  return { expected: { reread_differs_from_modified_copy: true }, actual: { modified_copy_queue_min: copy.poi_states.market.queue_min, reread_queue_min: reread.poi_states.market.queue_min, differs: reread.poi_states.market.queue_min !== 999 } };
}, () => assert.notEqual(getState().poi_states.market.queue_min, 999));

let oneMinute, poiWritebackMismatches, roadWritebackMismatches;
runTest('模拟时间推进与当前状态写回', () => {
  oneMinute = runOneMinuteUpdate();
  const { before, forecast, after, reread, api: stateApi } = oneMinute;
  poiWritebackMismatches = Object.entries(forecast.poi_predictions).filter(([id, points]) => {
    const predicted = points.at(-1), actual = after.poi_states[id];
    return ['queue_min', 'crowd_ratio', 'crowd_level', 'open'].some(field => actual[field] !== predicted[field]);
  }).map(([id]) => id);
  roadWritebackMismatches = Object.entries(forecast.road_predictions).filter(([id, points]) => {
    const predicted = points.at(-1), actual = after.road_states[id];
    return ['travel_time_min', 'available'].some(field => actual[field] !== predicted[field]);
  }).map(([id]) => id);
  const expectedTime = stamp(parseTime(before.timestamp, 'state timestamp') + 60000);
  const expectedVersion = `state_${String(Number(before.state_version.split('_').at(-1)) + 1).padStart(4, '0')}`;
  return {
    input: { timestamp: before.timestamp, state_version: before.state_version, market_crowd_ratio: before.poi_states.market.crowd_ratio, market_crowd_level: before.poi_states.market.crowd_level },
    expected: { timestamp: expectedTime, state_version: expectedVersion, market: forecast.poi_predictions.market.at(-1), edge_015: forecast.road_predictions.edge_015.at(-1), poi_writeback_mismatches: [], road_writeback_mismatches: [], api_status: 200 },
    actual: { timestamp: after.timestamp, state_version: after.state_version, market: after.poi_states.market, edge_015: after.road_states.edge_015, poi_writeback_mismatches: poiWritebackMismatches, road_writeback_mismatches: roadWritebackMismatches, state_reread_matches: same(after, reread), api_status: stateApi.status, api_matches_current_state: same(after, stateApi.body), visitor_unchanged: same(before.visitor, after.visitor), events_unchanged: same(before.event_states, after.event_states) }
  };
}, () => {
  const { before, forecast, after, reread, api: stateApi } = oneMinute;
  assert.equal(after.timestamp, stamp(parseTime(before.timestamp, 'state timestamp') + 60000));
  assert.equal(after.state_version, `state_${String(Number(before.state_version.split('_').at(-1)) + 1).padStart(4, '0')}`);
  assert.deepEqual(poiWritebackMismatches, []);
  assert.deepEqual(roadWritebackMismatches, []);
  assert.equal(after.poi_states.market.crowd_level, 'HIGH');
  assert.equal(after.poi_states.market.crowd_ratio, forecast.poi_predictions.market.at(-1).crowd_ratio);
  assert.ok(after.poi_states.market.queue_min > before.poi_states.market.queue_min);
  assert.ok(after.road_states.edge_015.travel_time_min > before.road_states.edge_015.travel_time_min);
  assert.deepEqual(after.visitor, before.visitor);
  assert.deepEqual(after.event_states, before.event_states);
  assert.deepEqual(after, reread);
  assert.equal(stateApi.status, 200);
  assert.deepEqual(stateApi.body, after);
  assert.deepEqual(getState(), state);
});

let roadLifecycle;
runTest('道路关闭事件写回当前状态的开始与结束边界', () => {
  roadLifecycle = runRoadLifecycle();
  const { afterEvent, startOffset, endOffset, samples, forecast } = roadLifecycle;
  return {
    input: { timestamp: afterEvent.timestamp, state_version: afterEvent.state_version, event: roadLifecycle.event, configured_start_offset_min: roadLifecycle.config.start_offset_min, configured_duration_min: roadLifecycle.config.duration_min },
    expected: { start_offset_min: roadLifecycle.config.start_offset_min, end_offset_min: roadLifecycle.config.start_offset_min + roadLifecycle.config.duration_min, current_before_start_available: true, forecast_at_start_available: false, interval: '[start, end)', samples: samples.map(({ minute }) => ({ minute, available: minute < startOffset || minute >= endOffset })) },
    actual: { start_offset_min: startOffset, end_offset_min: endOffset, current_after_event_available: afterEvent.road_states.edge_001.available, forecast_at_start_available: forecast.find(point => point.offset_min === startOffset)?.available, forecast_at_end_available: forecast.find(point => point.offset_min === endOffset)?.available, samples, final_matches_last_sample: roadLifecycle.final.road_states.edge_001.available === samples.at(-1).available }
  };
}, () => {
  const { initial, afterEvent, event, startOffset, endOffset, forecast, samples, final } = roadLifecycle;
  assert.equal(initial.road_states.edge_001.available, true);
  assert.equal(startOffset, roadLifecycle.config.start_offset_min);
  assert.equal(endOffset, startOffset + roadLifecycle.config.duration_min);
  assert.equal(parseTime(event.timestamp, 'event timestamp'), parseTime(afterEvent.timestamp, 'state timestamp') + startOffset * 60000);
  assert.equal(afterEvent.road_states.edge_001.available, true);
  assert.equal(forecast.find(point => point.offset_min === startOffset).available, false);
  assert.equal(forecast.find(point => point.offset_min === endOffset).available, true);
  assert.deepEqual(samples.map(point => point.minute), [0, startOffset - 1, startOffset, startOffset + Math.floor((endOffset - startOffset) / 2), endOffset - 1, endOffset]);
  for (const point of samples) {
    assert.equal(point.available, point.minute < startOffset || point.minute >= endOffset, `minute ${point.minute}`);
    assert.equal(point.timestamp, stamp(parseTime(afterEvent.timestamp, 'state timestamp') + point.minute * 60000));
    assert.equal(point.state_version, `state_${String(Number(afterEvent.state_version.split('_').at(-1)) + point.minute).padStart(4, '0')}`);
    assert.ok(Number.isFinite(point.travel_time_min) && point.travel_time_min > 0);
  }
  assert.equal(final.road_states.edge_001.available, true);
  assert.deepEqual(getState(), state);
});

let longTerm, longTermPoiMismatches, longTermRoadMismatches;
runTest('60 分钟预测与逐分钟状态一致性', () => {
  longTerm = runLongTermConsistency();
  const { initial, direct, stepped, afterEvent, afterEventDirect, afterEventStepped } = longTerm;
  longTermPoiMismatches = Object.entries(direct.poi_predictions).filter(([id, points]) => {
    const predicted = points.at(-1), actual = stepped.poi_states[id];
    return ['queue_min', 'crowd_ratio', 'crowd_level', 'open'].some(field => predicted[field] !== actual[field]);
  }).map(([id]) => id);
  longTermRoadMismatches = Object.entries(direct.road_predictions).filter(([id, points]) => {
    const predicted = points.at(-1), actual = stepped.road_states[id];
    return ['travel_time_min', 'available'].some(field => predicted[field] !== actual[field]);
  }).map(([id]) => id);
  return {
    input: { base_timestamp: initial.timestamp, horizon_min: 60, step_min: 10, incremental_updates: 60, external_event: afterEvent.scenario_events.at(-1) },
    expected: { timestamp: direct.poi_predictions.market.at(-1).timestamp, market: direct.poi_predictions.market.at(-1), edge_001: direct.road_predictions.edge_001.at(-1), poi_mismatches: [], road_mismatches: [], after_external_event_market: afterEventDirect.poi_predictions.market.at(-1) },
    actual: { timestamp: stepped.timestamp, market: stepped.poi_states.market, edge_001: stepped.road_states.edge_001, poi_mismatches: longTermPoiMismatches, road_mismatches: longTermRoadMismatches, after_external_event_market: afterEventStepped.poi_states.market, original_initial_state_unchanged: same(getState(), state) }
  };
}, () => {
  const { direct, stepped, afterEvent, afterEventDirect, afterEventStepped } = longTerm;
  assert.equal(stepped.timestamp, direct.poi_predictions.market.at(-1).timestamp);
  assert.deepEqual(longTermPoiMismatches, []);
  assert.deepEqual(longTermRoadMismatches, []);
  assert.equal(stepped.poi_states.market.crowd_ratio, direct.poi_predictions.market.at(-1).crowd_ratio);
  assert.equal(stepped.road_states.edge_001.travel_time_min, direct.road_predictions.edge_001.at(-1).travel_time_min);
  assert.ok(afterEvent.poi_states.market.queue_min > stepped.poi_states.market.queue_min);
  for (const field of ['queue_min', 'crowd_ratio', 'crowd_level', 'open']) assert.equal(afterEventStepped.poi_states.market[field], afterEventDirect.poi_predictions.market.at(-1)[field], field);
  assert.equal(afterEventStepped.timestamp, afterEventDirect.poi_predictions.market.at(-1).timestamp);
  assert.deepEqual(getState(), state);
});

const baselineForEvents = predictEnvironment(freshState(), 100, 1);
const pointAt = (forecast, kind, id, offset) => {
  const point = forecast[kind][id].find(item => item.offset_min === offset);
  assert.ok(point, `${kind}.${id} missing offset ${offset}`);
  return point;
};
const unrelatedDifferences = (forecast, targetId) => ['poi_predictions', 'road_predictions'].flatMap(kind =>
  Object.entries(forecast[kind]).flatMap(([id, points]) => id === targetId ? [] : points
    .filter(point => !same(point, pointAt(baselineForEvents, kind, id, point.offset_min)))
    .map(point => `${kind}.${id}@${point.offset_min}`)));

let scenarioComparisons;
runTest('三种场景前中后与非目标预测对照', () => {
  const spike = predictEnvironment(applyScenarioEvent(freshState(), { event_type: 'QUEUE_SPIKE', target_id: scenarios.QUEUE_SPIKE.target_id }), 100, 10);
  const close = predictEnvironment(applyScenarioEvent(freshState(), { event_type: 'ROAD_CLOSE', target_id: scenarios.ROAD_CLOSE.target_id }), 100, 10);
  const slowdownEvent = { event_type: 'ROAD_SLOWDOWN', target_id: 'edge_001', timestamp: stamp(parseTime(state.timestamp, 'state timestamp') + 20 * 60000), duration_min: 20 };
  const slowdown = predictEnvironment(applyScenarioEvent(freshState(), slowdownEvent), 100, 10);
  const rows = (forecast, kind, id, offsets, fields) => offsets.map(offset_min => {
    const baseline = pointAt(baselineForEvents, kind, id, offset_min);
    const actual = pointAt(forecast, kind, id, offset_min);
    const pick = point => Object.fromEntries(fields.map(field => [field, point[field]]));
    return { offset_min, baseline: pick(baseline), event: pick(actual) };
  });
  scenarioComparisons = {
    normal: {
      market: rows(baselineForEvents, 'poi_predictions', 'market', [0, 60], ['queue_min', 'crowd_ratio']),
      edge_001: rows(baselineForEvents, 'road_predictions', 'edge_001', [0, 60], ['travel_time_min', 'available'])
    },
    spike: { start_min: scenarios.QUEUE_SPIKE.start_offset_min, end_min: scenarios.QUEUE_SPIKE.start_offset_min + scenarios.QUEUE_SPIKE.duration_min, rows: rows(spike, 'poi_predictions', 'theater', [10, 20, 60, 65, 70], ['queue_min', 'crowd_ratio']), unrelated_mismatches: unrelatedDifferences(spike, 'theater') },
    close: { start_min: scenarios.ROAD_CLOSE.start_offset_min, end_min: scenarios.ROAD_CLOSE.start_offset_min + scenarios.ROAD_CLOSE.duration_min, rows: rows(close, 'road_predictions', 'edge_001', [20, 30, 80, 90], ['available', 'travel_time_min']), unrelated_mismatches: unrelatedDifferences(close, 'edge_001') },
    slowdown: { event: slowdownEvent, rows: rows(slowdown, 'road_predictions', 'edge_001', [10, 20, 30, 40, 50], ['available', 'travel_time_min']), unrelated_mismatches: unrelatedDifferences(slowdown, 'edge_001') }
  };
  return { input: { base_timestamp: state.timestamp, horizon_min: 100, step_min: 10, configured_events: scenarios, slowdown_event_override: slowdownEvent }, actual: scenarioComparisons };
}, () => {
  const { normal, spike, close, slowdown } = scenarioComparisons;
  assert.equal(normal.market[1].event.queue_min, normal.market[0].event.queue_min + scenarios.NORMAL.queue_drift_per_hour);
  assert.equal(normal.market[1].event.crowd_ratio, normal.market[0].event.crowd_ratio + scenarios.NORMAL.crowd_drift_per_hour);
  assert.equal(normal.edge_001[1].event.travel_time_min, Number((normal.edge_001[0].event.travel_time_min * (1 + scenarios.NORMAL.road_delay_per_hour)).toFixed(2)));
  assert.deepEqual(spike.rows[0].event, spike.rows[0].baseline);
  for (const row of spike.rows.slice(1, 3)) {
    assert.equal(row.event.queue_min, row.baseline.queue_min + scenarios.QUEUE_SPIKE.queue_increase_min);
    assert.equal(row.event.crowd_ratio, Math.min(.98, Number((row.baseline.crowd_ratio + scenarios.QUEUE_SPIKE.crowd_increase).toFixed(3))));
  }
  for (const row of spike.rows.slice(3)) assert.deepEqual(row.event, row.baseline);
  assert.deepEqual(close.rows.map(row => row.event.available), [true, false, false, true]);
  for (const row of close.rows) assert.equal(row.event.travel_time_min, row.baseline.travel_time_min);
  assert.deepEqual(slowdown.rows[0].event, slowdown.rows[0].baseline);
  for (const row of slowdown.rows.slice(1, 3)) {
    assert.equal(row.event.available, true);
    assert.ok(row.event.travel_time_min > row.baseline.travel_time_min);
  }
  for (const row of slowdown.rows.slice(3)) assert.deepEqual(row.event, row.baseline);
  for (const result of [spike, close, slowdown]) assert.deepEqual(result.unrelated_mismatches, []);
});

function isolatedEventRuntime(event) {
  return isolatedRuntime(({ provider, scenario }) => {
    const initial = provider.getState();
    provider.setState(scenario.applyScenarioEvent(initial, typeof event === 'function' ? event(initial) : event));
  });
}

let closedNavigation;
runTest('关闭道路后的导航绕行与无可行路线', () => {
  const normalRuntime = isolatedRuntime();
  const normalNav = readJsonThroughGet(normalRuntime.server, '/api/navigation?from=gate&to=southgate');
  const closedRuntime = isolatedEventRuntime(initial => ({ event_type: 'ROAD_CLOSE', target_id: 'edge_001', timestamp: initial.timestamp, duration_min: 20 }));
  const closedForecast = closedRuntime.simulator.predictEnvironment(closedRuntime.provider.getState(), 240, 10);
  const closedNav = readJsonThroughGet(closedRuntime.server, '/api/navigation?from=gate&to=southgate');
  const blockedRuntime = isolatedRuntime(({ provider }) => {
    const current = provider.getState();
    for (const road of graph.edges.filter(edge => edge.from_node_id === 'gate' || edge.to_node_id === 'gate')) current.road_states[road.edge_id].available = false;
    provider.setState(current);
  });
  const blockedNav = readJsonThroughGet(blockedRuntime.server, '/api/navigation?from=gate&to=southgate');
  const segmentQueries = [];
  let elapsed = 0;
  for (const segment of closedNav.body.segments) {
    const enterTime = new Date(parseTime(closedForecast.base_timestamp, 'base timestamp') + Math.round(elapsed * 60000)).toISOString();
    const query = queryTravelTime(closedForecast, segment.edge_id, enterTime);
    segmentQueries.push({ edge_id: segment.edge_id, enter_time: enterTime, available: query.available, predicted_minutes: query.travel_time_min, navigation_minutes: segment.minutes });
    elapsed += segment.minutes;
  }
  closedNavigation = { normalNav, closedNav, blockedNav, closedForecast, segmentQueries };
  return { input: { closed_edge_id: 'edge_001', closed_start: closedRuntime.provider.getState().timestamp, closed_duration_min: 20, blocked_gate_edges: graph.edges.filter(edge => edge.from_node_id === 'gate' || edge.to_node_id === 'gate').map(edge => edge.edge_id) }, expected: { normal_path: ['gate', 'southgate'], closed_edge_at_0_available: false, closed_path_uses_edge_001: false, blocked_status: 409 }, actual: { normal_status: normalNav.status, normal_path: normalNav.body.path, closed_forecast_edge_at_0: closedForecast.road_predictions.edge_001[0], closed_status: closedNav.status, closed_path: closedNav.body.path, closed_minutes: closedNav.body.totalMinutes, segment_queries: segmentQueries, blocked_status: blockedNav.status, blocked_body: blockedNav.body } };
}, () => {
  const { normalNav, closedNav, blockedNav, closedForecast, segmentQueries } = closedNavigation;
  assert.equal(normalNav.status, 200);
  assert.deepEqual(normalNav.body.path, ['gate', 'southgate']);
  assert.equal(closedForecast.road_predictions.edge_001[0].available, false);
  assert.equal(closedNav.status, 200);
  assert.equal(closedNav.body.path[0], 'gate');
  assert.equal(closedNav.body.path.at(-1), 'southgate');
  assert.ok(closedNav.body.path.length > 2);
  assert.ok(closedNav.body.segments.every(segment => segment.edge_id !== 'edge_001'));
  assert.ok(segmentQueries.every(segment => segment.available && segment.navigation_minutes === segment.predicted_minutes));
  assert.ok(Math.abs(segmentQueries.reduce((sum, segment) => sum + segment.navigation_minutes, 0) - closedNav.body.totalMinutes) < 1e-9);
  assert.equal(blockedNav.status, 409);
  assert.match(blockedNav.body.error, /No feasible route/);
});

let slowedNavigation;
runTest('道路减速改变导航时间', () => {
  const normalRuntime = isolatedRuntime();
  const normalNav = readJsonThroughGet(normalRuntime.server, '/api/navigation?from=gate&to=southgate');
  const slowedRuntime = isolatedEventRuntime({ event_type: 'ROAD_SLOWDOWN', target_id: 'edge_001' });
  const slowedForecast = slowedRuntime.simulator.predictEnvironment(slowedRuntime.provider.getState(), 240, 10);
  const slowedNav = readJsonThroughGet(slowedRuntime.server, '/api/navigation?from=gate&to=southgate');
  const roadAtEntry = queryTravelTime(slowedForecast, 'edge_001', slowedForecast.base_timestamp);
  const closedRuntime = isolatedEventRuntime(initial => ({ event_type: 'ROAD_CLOSE', target_id: 'edge_001', timestamp: initial.timestamp, duration_min: 20 }));
  const closedNav = readJsonThroughGet(closedRuntime.server, '/api/navigation?from=gate&to=southgate');
  const futureRuntime = isolatedRuntime(({ provider, scenario }) => {
    const initial = provider.getState();
    const closed = scenario.applyScenarioEvent(initial, { event_type: 'ROAD_CLOSE', target_id: 'edge_001', timestamp: initial.timestamp, duration_min: 20 });
    const slowed = scenario.applyScenarioEvent(closed, { event_type: 'ROAD_SLOWDOWN', target_id: 'edge_020', timestamp: stamp(parseTime(initial.timestamp, 'state timestamp') + 5 * 60000), duration_min: 20 });
    provider.setState(slowed);
  });
  const futureForecast = futureRuntime.simulator.predictEnvironment(futureRuntime.provider.getState(), 240, 10);
  const futureNav = readJsonThroughGet(futureRuntime.server, '/api/navigation?from=gate&to=southgate');
  const futureStart = stamp(parseTime(futureForecast.base_timestamp, 'base timestamp') + 5 * 60000);
  slowedNavigation = { normalNav, slowedNav, roadAtEntry, closedNav, futureNav, futureForecast, futureStart };
  return { input: { event_type: 'ROAD_SLOWDOWN', target_id: 'edge_001', configured_multiplier: scenarios.ROAD_SLOWDOWN.travel_time_multiplier, future_case: { closed_edge_id: 'edge_001', slowed_edge_id: 'edge_020', slowdown_start_min: 5 } }, expected: { normal_minutes: normalNav.body.totalMinutes, slowed_road_minutes: roadAtEntry.travel_time_min, navigation_reflects_slowdown: true, future_road_at_start_slower: true }, actual: { normal_path: normalNav.body.path, normal_minutes: normalNav.body.totalMinutes, slowed_path: slowedNav.body.path, slowed_minutes: slowedNav.body.totalMinutes, slowed_segments: slowedNav.body.segments.map(segment => ({ edge_id: segment.edge_id, minutes: segment.minutes })), predicted_road_at_entry: roadAtEntry, future_case: { closed_path: closedNav.body.path, closed_minutes: closedNav.body.totalMinutes, road_before_start: queryTravelTime(futureForecast, 'edge_020', futureForecast.base_timestamp), road_at_start: queryTravelTime(futureForecast, 'edge_020', futureStart), slowed_path: futureNav.body.path, slowed_minutes: futureNav.body.totalMinutes } } };
}, () => {
  const { normalNav, slowedNav, roadAtEntry, closedNav, futureNav, futureForecast, futureStart } = slowedNavigation;
  assert.equal(normalNav.status, 200);
  assert.equal(slowedNav.status, 200);
  assert.ok(roadAtEntry.available);
  assert.ok(roadAtEntry.travel_time_min > normalNav.body.totalMinutes);
  assert.ok(slowedNav.body.totalMinutes !== normalNav.body.totalMinutes || !same(slowedNav.body.path, normalNav.body.path));
  if (slowedNav.body.segments[0].edge_id === 'edge_001') assert.equal(slowedNav.body.segments[0].minutes, roadAtEntry.travel_time_min);
  assert.equal(closedNav.status, 200);
  assert.ok(closedNav.body.segments.some(segment => segment.edge_id === 'edge_020'));
  assert.ok(queryTravelTime(futureForecast, 'edge_020', futureStart).travel_time_min > queryTravelTime(futureForecast, 'edge_020', futureForecast.base_timestamp).travel_time_min);
  assert.equal(futureNav.status, 200);
  assert.ok(futureNav.body.totalMinutes !== closedNav.body.totalMinutes || !same(futureNav.body.path, closedNav.body.path));
});

let queueScoring;
runTest('未来排队改变候选路线评分', () => {
  const normalRuntime = isolatedRuntime();
  const normalState = normalRuntime.provider.getState();
  const normalRoutes = readJsonThroughGet(normalRuntime.server, '/api/snapshot').body.routes;
  const spikeRuntime = isolatedEventRuntime(initial => ({ event_type: 'QUEUE_SPIKE', target_id: 'theater', timestamp: stamp(parseTime(initial.timestamp, 'state timestamp') + 10 * 60000), duration_min: 45 }));
  const spikeState = spikeRuntime.provider.getState();
  const spikeRoutes = readJsonThroughGet(spikeRuntime.server, '/api/snapshot').body.routes;
  const normalRoute = normalRoutes.find(route => route.id === 'efficiency');
  const spikeRoute = spikeRoutes.find(route => route.id === 'efficiency');
  queueScoring = { normalState, spikeState, normalRoute, spikeRoute };
  return { input: { event_type: 'QUEUE_SPIKE', target_id: 'theater', start_offset_min: 10, current_theater_queue_normal: normalState.poi_states.theater.queue_min, current_theater_queue_after_event: spikeState.poi_states.theater.queue_min }, expected: { current_queue_unchanged: true, route_queue_increases: true, route_utility_decreases: true }, actual: { normal_route: { minutes: normalRoute.minutes, queue: normalRoute.queue, utility: normalRoute.utility }, spike_route: { minutes: spikeRoute.minutes, queue: spikeRoute.queue, utility: spikeRoute.utility }, route_ids_normal: normalRoutes.map(route => route.id), route_ids_after_event: spikeRoutes.map(route => route.id) } };
}, () => {
  const { normalState, spikeState, normalRoute, spikeRoute } = queueScoring;
  assert.equal(spikeState.poi_states.theater.queue_min, normalState.poi_states.theater.queue_min);
  assert.equal(spikeRoute.minutes, normalRoute.minutes);
  assert.ok(spikeRoute.queue > normalRoute.queue);
  assert.ok(spikeRoute.utility < normalRoute.utility);
});

let reopenedNavigation;
runTest('道路关闭结束后导航恢复', () => {
  const runtime = isolatedEventRuntime(initial => ({ event_type: 'ROAD_CLOSE', target_id: 'edge_001', timestamp: initial.timestamp, duration_min: 2 }));
  const during = readJsonThroughGet(runtime.server, '/api/navigation?from=gate&to=southgate');
  runtime.updateEnvironment();
  runtime.updateEnvironment();
  const afterState = runtime.provider.getState();
  const afterForecast = runtime.simulator.predictEnvironment(afterState, 60, 10);
  const after = readJsonThroughGet(runtime.server, '/api/navigation?from=gate&to=southgate');
  reopenedNavigation = { during, after, afterState, afterForecast };
  return { input: { event_type: 'ROAD_CLOSE', target_id: 'edge_001', duration_min: 2, simulated_updates: 2 }, expected: { during_uses_closed_road: false, after_available: true, after_path: ['gate', 'southgate'] }, actual: { during_path: during.body.path, after_timestamp: afterState.timestamp, after_current_available: afterState.road_states.edge_001.available, after_forecast_available: afterForecast.road_predictions.edge_001[0].available, after_path: after.body.path, after_minutes: after.body.totalMinutes } };
}, () => {
  const { during, after, afterState, afterForecast } = reopenedNavigation;
  assert.equal(during.status, 200);
  assert.ok(during.body.segments.every(segment => segment.edge_id !== 'edge_001'));
  assert.equal(afterState.road_states.edge_001.available, true);
  assert.equal(afterForecast.road_predictions.edge_001[0].available, true);
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.path, ['gate', 'southgate']);
  assert.equal(after.body.segments[0].edge_id, 'edge_001');
});

async function finish() {
  let forecastApi;
  await runAsyncTest('预测 GET 接口字段、类型与错误响应', async () => {
    const { server } = isolatedRuntime();
    const success = await readJsonThroughGetAsync(server, '/api/v1/environment-forecast');
    const repeated = await readJsonThroughGetAsync(server, '/api/v1/environment-forecast');
    const invalid = await Promise.all(['horizon=-1', 'horizon=1441', 'step=0', 'step=abc'].map(query => readJsonThroughGetAsync(server, `/api/v1/environment-forecast?${query}`)));
    const forecast = success.body;
    const required = ['schema_version', 'scenario_id', 'state_version', 'forecast_version', 'base_timestamp', 'horizon_min', 'step_min', 'poi_predictions', 'road_predictions'];
    const series = [...Object.values(forecast.poi_predictions), ...Object.values(forecast.road_predictions)];
    forecastApi = {
      success, repeated, invalid, required,
      missing_fields: required.filter(field => !(field in forecast)),
      poi_ids: Object.keys(forecast.poi_predictions).sort(), road_ids: Object.keys(forecast.road_predictions).sort(),
      offsets_match: series.every(points => same(points.map(point => point.offset_min), [0, 10, 20, 30, 40, 50, 60])),
      timestamp_mismatches: series.flatMap(points => points.filter(point => parseTime(point.timestamp, 'prediction timestamp') - parseTime(forecast.base_timestamp, 'base timestamp') !== point.offset_min * 60000)),
      poi_type_mismatches: Object.entries(forecast.poi_predictions).flatMap(([id, points]) => points.filter(point => !Number.isFinite(point.queue_min) || point.queue_min < 0 || !Number.isFinite(point.crowd_ratio) || point.crowd_ratio < 0 || point.crowd_ratio > 1 || !['LOW', 'MEDIUM', 'HIGH'].includes(point.crowd_level) || typeof point.open !== 'boolean').map(point => `${id}@${point.offset_min}`)),
      road_type_mismatches: Object.entries(forecast.road_predictions).flatMap(([id, points]) => points.filter(point => !Number.isFinite(point.travel_time_min) || point.travel_time_min <= 0 || typeof point.available !== 'boolean').map(point => `${id}@${point.offset_min}`))
    };
    return { expected: { status: 200, required, poi_count: pois.size, road_count: edges.size, horizon_min: 60, step_min: 10, offsets: [0, 10, 20, 30, 40, 50, 60], full_repeat_equal: true, invalid_statuses: [400, 400, 400, 400] }, actual: { status: success.status, fields: Object.keys(forecast), missing_fields: forecastApi.missing_fields, poi_count: forecastApi.poi_ids.length, road_count: forecastApi.road_ids.length, horizon_min: forecast.horizon_min, step_min: forecast.step_min, offsets: forecast.road_predictions.edge_001.map(point => point.offset_min), offsets_match: forecastApi.offsets_match, full_repeat_equal: same(success.body, repeated.body), timestamp_mismatches: forecastApi.timestamp_mismatches, poi_type_mismatches: forecastApi.poi_type_mismatches, road_type_mismatches: forecastApi.road_type_mismatches, invalid_responses: invalid.map(response => ({ status: response.status, error: response.body.error })) } };
  }, () => {
    const { success, repeated, invalid } = forecastApi;
    assert.equal(success.status, 200);
    assert.deepEqual(forecastApi.missing_fields, []);
    assert.deepEqual(forecastApi.poi_ids, [...pois].sort());
    assert.deepEqual(forecastApi.road_ids, [...edges].sort());
    assert.equal(success.body.horizon_min, 60);
    assert.equal(success.body.step_min, 10);
    assert.deepEqual(success.body, repeated.body);
    assert.ok(forecastApi.offsets_match);
    assert.deepEqual(forecastApi.timestamp_mismatches, []);
    assert.deepEqual(forecastApi.poi_type_mismatches, []);
    assert.deepEqual(forecastApi.road_type_mismatches, []);
    assert.deepEqual(invalid.map(response => response.status), [400, 400, 400, 400]);
    for (const response of invalid) assert.equal(typeof response.body.error, 'string');
  });
  let replanComparison;
  await runAsyncTest('隔离重规划使用未来排队预测', async () => {
    const normalRuntime = isolatedRuntime();
    const normal = await readJsonThroughPostAsync(normalRuntime.server, '/api/replan', { location: 'gate' });
    const spikeRuntime = isolatedEventRuntime(initial => ({ event_type: 'QUEUE_SPIKE', target_id: 'theater', timestamp: stamp(parseTime(initial.timestamp, 'state timestamp') + 10 * 60000), duration_min: 45 }));
    const spike = await readJsonThroughPostAsync(spikeRuntime.server, '/api/replan', { location: 'gate' });
    const normalRoute = normal.body.routes?.find(route => route.id === 'efficiency');
    const spikeRoute = spike.body.routes?.find(route => route.id === 'efficiency');
    replanComparison = { normal, spike, normalRoute, spikeRoute };
    return { input: { endpoint: 'POST /api/replan', body: { location: 'gate' }, future_event: { event_type: 'QUEUE_SPIKE', target_id: 'theater', start_offset_min: 10, duration_min: 45 } }, expected: { statuses: [200, 200], route_queue_increases: true, route_utility_decreases: true }, actual: { statuses: [normal.status, spike.status], normal_timestamp: normalRuntime.provider.getState().timestamp, spike_timestamp: spikeRuntime.provider.getState().timestamp, normal_route: normalRoute && { minutes: normalRoute.minutes, queue: normalRoute.queue, utility: normalRoute.utility }, spike_route: spikeRoute && { minutes: spikeRoute.minutes, queue: spikeRoute.queue, utility: spikeRoute.utility } } };
  }, () => {
    const { normal, spike, normalRoute, spikeRoute } = replanComparison;
    assert.equal(normal.status, 200);
    assert.equal(spike.status, 200);
    assert.ok(normalRoute && spikeRoute);
    assert.equal(normalRoute.minutes, spikeRoute.minutes);
    assert.ok(spikeRoute.queue > normalRoute.queue);
    assert.ok(spikeRoute.utility < normalRoute.utility);
  });
  printSummary();
}
finish().catch(() => { process.exitCode = 1; });
