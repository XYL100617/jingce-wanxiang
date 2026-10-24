const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { createMockScenario, buildLivePlannerScenario, planItinerary, replan, promoteAlternative } = require('./planner');
const { inferPreference: inferPreferenceV2 } = require('./preference-engine');
const accounts = require('./accounts');

const PORT = Number(process.env.PORT || 4173);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const AUDIT_FILE = process.env.AUDIT_FILE || path.join(__dirname, 'data', 'audit.local.jsonl');
function audit(req, action, target, outcome = 'success', details = {}) {
  const entry = { timestamp: new Date().toISOString(), requestId: req.requestId,
    actorId: req.account?.id || null, actorRole: req.account?.role || 'guest', action, target,
    outcome, details };
  fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
  fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`);
  return entry;
}
function requireAccount(req, res) {
  if (req.account) return true;
  json(res, 401, { error: '请先登录账号' });
  return false;
}
function requireManager(req, res) {
  if (!requireAccount(req, res)) return false;
  if (req.account.role === 'manager') return true;
  audit(req, 'permission.denied', req.url, 'denied');
  json(res, 403, { error: '此操作仅限景区管理员' });
  return false;
}

const provider = require('./state/stateProvider');
const { predictEnvironment } = require('./state/forecastSimulator');
const { applyScenarioEvent, parseTime } = require('./state/scenarioEngine');
const { queryQueue, queryTravelTime } = require('./state/forecastQuery');
const graph = provider.getLegacyGraph();
const scenicGraph = provider.getScenicGraph();
const routeEdges = scenicGraph.edges;
const routePoiIds = new Map(scenicGraph.nodes.filter(n => n.poi_id).map(n => [n.node_id, n.poi_id]));
const ROUTE_FORECAST_HORIZON_MIN = 600;
let state = provider.getLegacyState();
let preferenceProfile = null;
let currentPlanNextTarget = null;
let currentPlanId = null;
let currentPlanResult = null;
const cInteractionEvents = [];
const refresh = () => {
  state = provider.getLegacyState();
  state.user.preferenceProfile = preferenceProfile;
  if (preferenceProfile?.planner_rules?.preferred_exit_node_id) state.user.preferredExitNodeId = preferenceProfile.planner_rules.preferred_exit_node_id;
  state.user.currentPlanNextTarget = currentPlanNextTarget;
  state.user.currentPlanId = currentPlanId;
};
const commit = () => { provider.setLegacyState(state); refresh(); };

function livePlannerScenario() {
  const current = provider.getState();
  return buildLivePlannerScenario(provider.getScenicGraph(), current, state.user, predictEnvironment(current, ROUTE_FORECAST_HORIZON_MIN, 10));
}

function setActivePlan(planResult) {
  currentPlanResult = planResult || null;
  currentPlanNextTarget = planResult?.next_action?.target_id || null;
  currentPlanId = planResult?.plan_id || null;
  refresh();
}

const routeSeeds = [
  { id: '8A3F', title: '亲子避晒 · 文化慢游', author: '小河的周末', tags: ['室内优先', '休息点多', '亲子'], minutes: 178, likes: 286, stops: ['museum', 'theater', 'rest', 'market'], cover: 'museum' },
  { id: '2C71', title: '一小时高效打卡', author: '今天不排队', tags: ['时间紧', '高价值', '少绕行'], minutes: 72, likes: 194, stops: ['market', 'museum', 'theater'], cover: 'theater' },
  { id: 'F902', title: '湖畔林间自由行', author: '风从湖面来', tags: ['自然探索', '低密度', '拍照'], minutes: 146, likes: 341, stops: ['lake', 'forest', 'summit', 'rest'], cover: 'lake' }
];

const companionFacts = {
  museum: { name: '大宋武馆', title: '从一处展陈读懂景区文化', fact: '大宋武馆以武术展陈和互动体验为主，室内遮阴条件较好，适合在高温或人流波动时作为稳定节点。', prompt: '这里适合停留多久？' },
  lake: { name: '九龙瀑', title: '把自然留给慢一点的脚步', fact: '九龙瀑周边有连续绿荫和拍照点，适合把它作为自然体验节点；系统会根据当前人流提示更舒适的到达时段。', prompt: '这里适合停留多久？' },
  theater: { name: '武林会场', title: '让演艺节点成为旅程高光', fact: '武林会场属于事件驱动节点，活动开始前会出现集中到达，系统会将预约时间、人流波和步行缓冲一并纳入规划。', prompt: '什么时候到达更合适？' },
  rest: { name: '松风驿站', title: '给行程留一处恢复空间', fact: '松风驿站提供休息、补给与卫生间服务，模型会结合累计步行和舒适负荷判断是否建议在此停留。', prompt: '为什么需要安排休息？' }
};

const defaultPreference = { time: .18, interest: .16, comfort: .16, freedom: .12, culture: .11, nature: .1, performance: .09, food: .08 };
function legacyRoutePreference(weights = defaultPreference) {
  return {
    time: Number(weights.time || 0),
    interest: Number(weights.interest || 0) + Number(weights.performance || 0) + Number(weights.food || 0),
    comfort: Number(weights.comfort || 0),
    freedom: Number(weights.freedom || 0) + Number(weights.nature || 0),
    culture: Number(weights.culture || 0)
  };
}

// 第一版规则模拟世界模型兼容层。未来可替换 forecastSimulator 内部为 GNN+GRU / RSSM，
// 对外 EnvironmentForecast 接口保持不变。
function lightWorldModel(horizon = 60) {
  const current = provider.getState();
  const forecastData = predictEnvironment(current, Math.max(60, horizon), 5);
  const ids = Object.keys(current.poi_states);
  const mean = values => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  const meanCrowd = mean(ids.map(id => current.poi_states[id].crowd_ratio));
  const meanQueue = mean(ids.map(id => current.poi_states[id].queue_min));
  const points = [15, 30, 60].map(offset => {
    const predictions = ids.map(id => forecastData.poi_predictions[id].find(x => x.offset_min === offset));
    const crowd = mean(predictions.map(x => x.crowd_ratio));
    const queue = mean(predictions.map(x => x.queue_min));
    return { offset, label: `+${offset} min`, crowd: Math.round(crowd * 100), queue: Math.round(queue * 10) / 10, load: Math.round(Math.min(.98, current.visitor.fatigue + offset / 300) * 100), confidence: Math.round((.95 - offset / 420) * 100) };
  });
  return { model: 'Light Scenic Graph World Model', version: 'LSGWM-0.4', latent: { env: [meanCrowd, meanQueue / 25, current.weather.rain], user: [current.visitor.fatigue] }, state: { environment: meanCrowd > .68 ? '多点拥挤' : meanCrowd > .42 ? '局部繁忙' : '人流稳定', user: current.visitor.fatigue > .7 ? '负荷偏高' : current.visitor.fatigue > .42 ? '建议安排休息' : '舒适' }, horizon: points, uncertainty: 19, updatedAt: current.timestamp };
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let oversized = false;
    req.on('data', chunk => {
      if (oversized) return;
      raw += chunk;
      if (raw.length > 1e6) {
        oversized = true;
        const error = new Error('请求体超过 1 MB'); error.statusCode = 413; reject(error);
      }
    });
    req.on('end', () => {
      if (oversized) return;
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (_) { const error = new Error('请求体不是有效 JSON'); error.statusCode = 400; reject(error); }
    });
    req.on('error', reject);
  });
}

function resolveBScenario(body) {
  const supplied = ['graph', 'state', 'forecast'].filter(key => body[key] !== undefined);
  if (supplied.length && supplied.length !== 3) throw new Error('graph、state、forecast 必须同时提供');
  if (supplied.length === 3) return body;
  if (body.source === 'live') return livePlannerScenario();
  const variant = body.variant || 'normal';
  if (!['normal', 'queue_surge', 'road_closure'].includes(variant)) throw new Error(`不支持的场景 ${variant}`);
  return createMockScenario(variant);
}

function node(id) { return graph.nodes.find(n => n.id === id); }

function neighbours(id) {
  return routeEdges.flatMap(road => {
    const next = { edge_id: road.edge_id, distance: road.distance_m, shade: road.shade };
    if (road.from_node_id === id) return [{ ...next, id: road.to_node_id }];
    if (road.to_node_id === id && road.direction === 'BIDIRECTIONAL') return [{ ...next, id: road.from_node_id }];
    return [];
  });
}

function planningForecast() { return predictEnvironment(provider.getState(), ROUTE_FORECAST_HORIZON_MIN, 10); }
function predictedTime(forecastData, offsetMin) {
  if (offsetMin < 0 || offsetMin > forecastData.horizon_min) return null;
  return new Date(parseTime(forecastData.base_timestamp, 'base timestamp') + Math.round(offsetMin * 60000)).toISOString();
}

function pathBetween(start, goal, forecastData, departOffsetMin = 0) {
  if (!node(start) || !node(goal)) return null;
  const best = { [start]: { cost: 0, path: [start], steps: [], distance: 0, minutes: 0 } };
  const open = [start];
  while (open.length) {
    open.sort((a, b) => best[a].cost - best[b].cost);
    const current = open.shift();
    if (current === goal) return best[current];
    const enterTime = predictedTime(forecastData, departOffsetMin + best[current].minutes);
    if (!enterTime) continue;
    for (const next of neighbours(current)) {
      const road = queryTravelTime(forecastData, next.edge_id, enterTime);
      if (!road.available) continue;
      const crowdPenalty = (state.crowd[next.id] || 0) * 2.2;
      const cost = best[current].cost + road.travel_time_min + crowdPenalty;
      if (!best[next.id] || cost < best[next.id].cost) {
        best[next.id] = { cost, path: [...best[current].path, next.id], steps: [...best[current].steps, { from: current, to: next.id, edge_id: next.edge_id, distance: next.distance, minutes: road.travel_time_min, shade: next.shade }], distance: best[current].distance + next.distance, minutes: best[current].minutes + road.travel_time_min };
        open.push(next.id);
      }
    }
  }
  return null;
}

function scoreRoute(route, preference, poiSamples) {
  const poiNodes = route.stops.map(id => node(id));
  const interest = poiNodes.reduce((sum, n) => sum + (n.type === 'show' ? 0.95 : n.type === 'culture' ? 0.78 : n.type === 'view' ? 0.82 : 0.67), 0) / Math.max(1, poiNodes.length);
  const comfort = poiNodes.reduce((sum, n) => sum + n.shade, 0) / Math.max(1, poiNodes.length);
  const freedom = route.stops.filter(id => ['lake', 'forest', 'summit'].includes(id)).length / Math.max(1, poiNodes.length);
  const culture = poiNodes.filter(n => n.type === 'culture' || n.type === 'show').length / Math.max(1, poiNodes.length);
  const timeScore = Math.max(0, 1 - route.minutes / Math.max(1, state.user.remainingMinutes));
  const queue = poiSamples.reduce((sum, sample) => sum + sample.queue_min, 0);
  const crowd = poiSamples.reduce((sum, sample) => sum + sample.crowd_ratio, 0) / Math.max(1, poiSamples.length);
  const utility = preference.time * timeScore + preference.interest * interest + preference.comfort * comfort + preference.freedom * freedom + preference.culture * culture - queue / 150 - crowd * 0.08;
  return { ...route, utility: Math.round(utility * 1000) / 10, queue: Math.round(queue * 100) / 100, crowd: Math.round(crowd * 100), interest: Math.round(interest * 100), comfort: Math.round(comfort * 100) };
}

function makeRoutes(preference = state.user.preference || defaultPreference) {
  const routePreference = legacyRoutePreference(preference);
  const forecastData = planningForecast();
  const templates = [
    { id: 'efficiency', label: '效率偏', tone: 'cyan', stops: ['market', 'museum', 'theater'], reason: '优先锁定高价值项目，减少绕行和无效等待' },
    { id: 'balance', label: '均衡偏', tone: 'violet', stops: ['lake', 'museum', 'forest', 'theater'], reason: '在兴趣、舒适和项目完成之间取得平衡' },
    { id: 'experience', label: '体验偏', tone: 'amber', stops: ['lake', 'market', 'rest', 'forest', 'summit'], reason: '保留自由探索与自然体验，允许途中弹性调整' }
  ];
  return templates.map((t) => {
    let prev = state.user.location;
    let minutes = 0, distance = 0, elapsed = 0;
    const legs = [], poiSamples = [];
    for (const stop of t.stops) {
      const p = pathBetween(prev, stop, forecastData, elapsed);
      if (!p) return null;
      minutes += p.minutes;
      distance += p.distance;
      elapsed += p.minutes;
      const arrivalTime = predictedTime(forecastData, elapsed);
      if (!arrivalTime) return null;
      const poiId = routePoiIds.get(stop);
      if (!poiId) return null;
      const sample = queryQueue(forecastData, poiId, arrivalTime);
      if (!sample.open) return null;
      poiSamples.push(sample);
      legs.push({ from: p.path[0], to: stop, path: p.path, minutes: p.minutes, distance: p.distance });
      elapsed += sample.queue_min;
      prev = stop;
    }
    return scoreRoute({ ...t, minutes, distance, legs, eta: predictedTime(forecastData, elapsed) }, routePreference, poiSamples);
  }).filter(Boolean);
}

function makeLivePlan(rules = state.user.preferenceProfile?.planner_rules || {}) {
  const scenario = livePlannerScenario();
  return planItinerary({ ...scenario, rules });
}

function forecast(horizon = 90) {
  const result = predictEnvironment(provider.getState(), horizon, 15);
  return result.poi_predictions.market.map(p => ({ offset: p.offset_min, label: p.offset_min === 0 ? '现在' : `+${p.offset_min}m`, crowd: Math.round(p.crowd_ratio * 100), queue: p.queue_min, confidence: Math.round((.94 - p.offset_min / 800) * 100) }));
}

function snapshot() {
  const routes = makeRoutes();
  const closedRoads = Object.entries(provider.getState().road_states).filter(([, road]) => !road.available).map(([id]) => id);
  return {
    project: { name: '景策万象', tagline: '轻量化世界模型驱动的景区全程自适应游览决策系统', version: 'demo v3.0' },
    time: { minute: state.minute, display: `${String(Math.floor(state.minute / 60)).padStart(2, '0')}:${String(state.minute % 60).padStart(2, '0')}` },
    weather: state.weather, graph, crowd: state.crowd, queues: state.queues, events: state.events, user: state.user, routes, forecast: forecast(), worldModel: lightWorldModel(), routeSeeds, planResult: currentPlanResult,
    companion: companionFacts[state.user.location] || companionFacts.museum,
    emergency: { rain: state.weather.rain, safe: closedRoads.length === 0, closed: closedRoads, sos: false },
    metrics: { nodes: graph.nodes.length, edges: graph.edges.length, confidence: 91, responseMs: 84, coverage: 87 }
  };
}

let simulationAnchor = null;
let simulatedMinutes = 0;
let lastUpdateVersion = null;
function updateEnvironment() {
  const current = provider.getState();
  // Keep a stable baseline between external state changes so small drifts are not lost to repeated rounding.
  if (!simulationAnchor || current.state_version !== lastUpdateVersion || simulatedMinutes >= 1440) {
    simulationAnchor = current;
    simulatedMinutes = 0;
  }
  const nextMinute = simulatedMinutes + 1;
  const prediction = predictEnvironment(simulationAnchor, nextMinute, nextMinute);
  const next = provider.cloneState(current);
  next.timestamp = new Date(Date.parse(current.timestamp.replace(' ', 'T') + 'Z') + 60000).toISOString().slice(0, 19).replace('T', ' ');
  for (const [id, points] of Object.entries(prediction.poi_predictions)) {
    const p = points.at(-1);
    Object.assign(next.poi_states[id], { queue_min: p.queue_min, crowd_ratio: p.crowd_ratio, crowd_level: p.crowd_level, open: p.open });
  }
  for (const [id, points] of Object.entries(prediction.road_predictions)) {
    const p = points.at(-1);
    Object.assign(next.road_states[id], { travel_time_min: p.travel_time_min, available: p.available });
  }
  const updated = provider.setState(next);
  simulatedMinutes = nextMinute;
  lastUpdateVersion = updated.state_version;
  refresh();
}

if (require.main === module) setInterval(updateEnvironment, 12000);

async function api(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/account/register') {
    const body = await readBody(req);
    const user = accounts.createUser(body.username, body.password, body.displayName);
    audit(req, 'account.register', user.id);
    const session = accounts.login(body.username, body.password);
    res.setHeader('Set-Cookie', accounts.cookie(session.token, req));
    return json(res, 201, { user: accounts.publicUser(user), profile: accounts.profile(user) });
  }
  if (req.method === 'POST' && url.pathname === '/api/account/login') {
    const body = await readBody(req);
    const session = accounts.login(body.username, body.password);
    req.account = session.user;
    audit(req, 'account.login', session.user.id);
    res.setHeader('Set-Cookie', accounts.cookie(session.token, req));
    return json(res, 200, { user: accounts.publicUser(session.user), profile: accounts.profile(session.user) });
  }
  if (req.method === 'POST' && url.pathname === '/api/account/logout') {
    if (req.account) audit(req, 'account.logout', req.account.id);
    accounts.logout(req);
    res.setHeader('Set-Cookie', accounts.clearCookie());
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/account/me')
    return json(res, 200, { user: accounts.publicUser(req.account), profile: req.account ? accounts.profile(req.account) : null });
  if (req.method === 'PATCH' && url.pathname === '/api/account/profile') {
    if (!requireAccount(req, res)) return;
    const profile = accounts.updateProfile(req.account, await readBody(req));
    audit(req, 'profile.update', req.account.id, 'success', { fields: ['displayName', 'consent'] });
    return json(res, 200, { profile });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/users') {
    if (!requireManager(req, res)) return;
    return json(res, 200, { users: accounts.listUsers() });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/audit') {
    if (!requireManager(req, res)) return;
    const lines = fs.existsSync(AUDIT_FILE) ? fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean) : [];
    return json(res, 200, { entries: lines.slice(-100).reverse().map(line => JSON.parse(line)) });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/scenario-event' && !requireManager(req, res)) return;
  if (req.method === 'POST' && ['/api/simulate-event', '/api/simulate-road-closure'].includes(url.pathname) && !requireManager(req, res)) return;
  if (req.method === 'POST' && url.pathname === '/api/b/demo-event') {
    const body = await readBody(req);
    req.demoEventBody = body;
    if (['POI_CLOSED', 'QUEUE_UPDATE', 'ROAD_CLOSED', 'ROAD_OPENED', 'EVENT_CANCELLED'].includes(body.event?.event_type) && !requireManager(req, res)) return;
  }
  if (req.method === 'POST' && url.pathname === '/api/c/user-event') {
    const body = await readBody(req); const event = body.event;
    if (!event || !['POI_CLICK', 'ROAD_CLICK', 'MAP_REPLAN_REQUEST'].includes(event.event_type)) return json(res, 400, { error: '不支持的 C 模块交互事件' });
    const current = provider.getState();
    if (event.schema_version !== current.schema_version || event.scenario_id !== current.scenario_id) return json(res, 409, { error: 'C 模块事件与当前数据版本或场景不匹配' });
    if (event.event_type === 'POI_CLICK' && !scenicGraph.nodes.some(node => node.poi_id === event.target_id)) return json(res, 404, { error: '未知 POI ID' });
    if (event.event_type === 'ROAD_CLICK' && !scenicGraph.edges.some(edge => edge.edge_id === event.edge_id)) return json(res, 404, { error: '未知 edge_id' });
    if (event.event_type === 'MAP_REPLAN_REQUEST' && !scenicGraph.nodes.some(node => node.node_id === event.node_id)) return json(res, 404, { error: '未知 node_id' });
    const accepted = { ...event, received_at: current.timestamp };
    cInteractionEvents.push(accepted);
    if (cInteractionEvents.length > 100) cInteractionEvents.shift();
    return json(res, 202, { ok: true, event: accepted, event_count: cInteractionEvents.length });
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/scenic-graph') return json(res, 200, provider.getScenicGraph());
  if (req.method === 'GET' && url.pathname === '/api/v1/state') return json(res, 200, provider.getState(url.searchParams.get('timestamp') || undefined, url.searchParams.get('visitor_id') || undefined));
  if (req.method === 'GET' && url.pathname === '/api/v1/environment-forecast') return json(res, 200, predictEnvironment(provider.getState(), Number(url.searchParams.get('horizon') || 60), Number(url.searchParams.get('step') || 10)));
  if (req.method === 'GET' && url.pathname === '/api/v1/query-queue') {
    const forecastData = predictEnvironment(provider.getState(), Number(url.searchParams.get('horizon') || 60), Number(url.searchParams.get('step') || 10));
    return json(res, 200, queryQueue(forecastData, url.searchParams.get('poi_id'), url.searchParams.get('arrival_time')));
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/query-travel-time') {
    const forecastData = predictEnvironment(provider.getState(), Number(url.searchParams.get('horizon') || 60), Number(url.searchParams.get('step') || 10));
    return json(res, 200, queryTravelTime(forecastData, url.searchParams.get('edge_id'), url.searchParams.get('enter_time')));
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/scenario-event') {
    const event = await readBody(req);
    const updated = provider.setState(applyScenarioEvent(provider.getState(), event));
    refresh();
    audit(req, 'scenic.scenario_event', event.target_id || event.edge_id || null, 'success', { eventType: event.event_type });
    return json(res, 200, { state: updated, forecast: predictEnvironment(updated) });
  }
  if (req.method === 'GET' && url.pathname === '/api/b/mock-scenario') {
    const variant = url.searchParams.get('variant') || 'normal';
    if (!['normal', 'queue_surge', 'road_closure'].includes(variant)) return json(res, 400, { error: 'variant 仅支持 normal、queue_surge、road_closure' });
    return json(res, 200, createMockScenario(variant));
  }
  if (req.method === 'POST' && url.pathname === '/api/b/plan') {
    const body = await readBody(req);
    const scenario = resolveBScenario(body);
    return json(res, 200, planItinerary({ graph: scenario.graph, state: scenario.state, forecast: scenario.forecast, rules: body.rules || scenario.rules || {} }));
  }
  if (req.method === 'POST' && url.pathname === '/api/b/replan') {
    const body = await readBody(req);
    const scenario = resolveBScenario(body);
    return json(res, 200, replan({ graph: scenario.graph, state: scenario.state, forecast: scenario.forecast, event: body.event, rules: body.rules || scenario.rules || {} }));
  }
  if (req.method === 'POST' && url.pathname === '/api/b/replan-live') {
    const body = await readBody(req);
    const scenario = livePlannerScenario();
    const planResult = replan({ ...scenario, event: body.event, rules: body.rules || state.user.preferenceProfile?.planner_rules || {} });
    setActivePlan(planResult);
    return json(res, 200, planResult);
  }
  if (req.method === 'POST' && url.pathname === '/api/b/select-plan') {
    const body = await readBody(req);
    if (typeof body.plan_id !== 'string' || !body.plan_id) return json(res, 400, { error: 'plan_id 为必填字符串' });
    const scenario = livePlannerScenario();
    const current = planItinerary({ ...scenario, rules: state.user.preferenceProfile?.planner_rules || {} });
    let planResult;
    try {
      let selectedPlanId = body.plan_id;
      if (![current.plan_id, ...(current.alternative_plans || []).map(item => item.plan_id)].includes(selectedPlanId) && (Array.isArray(body.action_sequence) || Array.isArray(body.target_sequence))) {
        const matching = Array.isArray(body.action_sequence)
          ? [current, ...(current.alternative_plans || [])].find(item => JSON.stringify((item.itinerary || []).map(step => ({ action_type: step.action_type, target_id: step.target_id }))) === JSON.stringify(body.action_sequence))
          : null;
        const requested = Array.isArray(body.target_sequence) ? body.target_sequence.join('|') : null;
        const byTargets = matching || (requested && [current, ...(current.alternative_plans || [])].find(item => (item.itinerary || []).map(step => step.target_node_id || step.target_id).join('|') === requested));
        if (byTargets) selectedPlanId = byTargets.plan_id;
      }
      planResult = promoteAlternative(current, selectedPlanId);
    }
    catch (error) { return json(res, 409, { error: error.message }); }
    setActivePlan(planResult);
    return json(res, 200, planResult);
  }
  if (req.method === 'POST' && url.pathname === '/api/b/demo-event') {
    const body = req.demoEventBody;
    const event = body.event;
    if (!event || typeof event.event_type !== 'string') return json(res, 400, { error: 'event.event_type 为必填项' });
    const initial = livePlannerScenario();
    const type = event.event_type;
    const target = event.target_id;
    let legacyChanged = false;
    let canonicalChanged = false;
    let canonical = provider.getState();
    if (type === 'POI_CLOSED') {
      if (!initial.graph.pois.some(poi => poi.poi_id === target)) return json(res, 400, { error: `未知景点 ${target}` });
      canonical.poi_states[target].open = false;
      canonicalChanged = true;
    } else if (type === 'QUEUE_UPDATE') {
      if (!initial.graph.pois.some(poi => poi.poi_id === target)) return json(res, 400, { error: `未知景点 ${target}` });
      if (!Number.isFinite(Number(event.queue_min)) || Number(event.queue_min) < 0) return json(res, 400, { error: 'queue_min 必须是非负数字' });
      state.queues[target] = Number(event.queue_min);
      legacyChanged = true;
    } else if (type === 'POSITION_UPDATE' || type === 'PROGRESS_UPDATE') {
      if (!node(event.current_node_id)) return json(res, 400, { error: `未知位置 ${event.current_node_id}` });
      if (event.remaining_time_min !== undefined && (!Number.isFinite(Number(event.remaining_time_min)) || Number(event.remaining_time_min) < 0)) return json(res, 400, { error: 'remaining_time_min 必须是非负数字' });
      if (event.fatigue !== undefined && (!Number.isFinite(Number(event.fatigue)) || Number(event.fatigue) < 0 || Number(event.fatigue) > 1)) return json(res, 400, { error: 'fatigue 必须是 0 至 1 之间的数字' });
      if (type === 'PROGRESS_UPDATE' && event.target_id) {
        const target = initial.graph.pois.find(item => item.poi_id === event.target_id)
          || initial.graph.events.find(item => item.event_id === event.target_id)
          || initial.graph.facilities.find(item => item.facility_id === event.target_id);
        if (!target || target.node_id !== event.current_node_id) return json(res, 400, { error: '进度目标必须是当前位置对应的已知景点、活动或服务点' });
      }
      state.user.location = event.current_node_id;
      if (event.remaining_time_min !== undefined) state.user.remainingMinutes = Math.max(0, Number(event.remaining_time_min));
      if (event.fatigue !== undefined) state.user.load = Math.min(1, Math.max(0, Number(event.fatigue)));
      legacyChanged = true;
    } else if (type === 'ROAD_CLOSED' || type === 'ROAD_OPENED') {
      if (!initial.graph.edges.some(item => item.edge_id === event.edge_id)) return json(res, 400, { error: `未知道路 ${event.edge_id}` });
      canonical.road_states[event.edge_id].available = type === 'ROAD_OPENED';
      canonicalChanged = true;
    } else if (type === 'EVENT_CANCELLED' || type === 'EVENT_MISSED') {
      if (!initial.graph.events.some(item => item.event_id === target)) return json(res, 400, { error: `未知活动 ${target}` });
      canonical.event_states[target].cancelled = true;
      canonicalChanged = true;
    } else if (type !== 'SKIP_TARGET' && type !== 'REQUEST_REPLAN') {
      return json(res, 400, { error: `不支持的事件类型 ${type}` });
    }
    if (legacyChanged) {
      commit();
      canonical = provider.getState();
    }
    if (type === 'PROGRESS_UPDATE' && event.target_id) {
      if (initial.graph.pois.some(item => item.poi_id === event.target_id)) canonical.visitor.visited_poi_ids = [...new Set([...(canonical.visitor.visited_poi_ids || []), event.target_id])];
      else if (initial.graph.events.some(item => item.event_id === event.target_id)) canonical.visitor.attended_event_ids = [...new Set([...(canonical.visitor.attended_event_ids || []), event.target_id])];
      else canonical.visitor.visited_facility_ids = [...new Set([...(canonical.visitor.visited_facility_ids || []), event.target_id])];
      canonicalChanged = true;
    }
    if (canonicalChanged) provider.setState(canonical);
    refresh();
    const updated = livePlannerScenario();
    const normalizedEvent = { ...event, schema_version: updated.state.schema_version, scenario_id: updated.state.scenario_id, timestamp: event.timestamp || updated.state.timestamp };
    const planResult = replan({ ...updated, event: normalizedEvent, rules: state.user.preferenceProfile?.planner_rules || {} });
    setActivePlan(planResult);
    audit(req, type === 'PROGRESS_UPDATE' ? 'route.progress' : 'scenic.demo_event', event.edge_id || target || event.current_node_id || null, 'success', { eventType: type });
    return json(res, 200, { ok: true, ...snapshot(), planResult });
  }
  if (req.method === 'GET' && url.pathname === '/api/snapshot') return json(res, 200, snapshot());
  if (req.method === 'GET' && url.pathname === '/api/pois') return json(res, 200, { nodes: graph.nodes, edges: graph.edges });
  if (req.method === 'GET' && url.pathname === '/api/forecast') return json(res, 200, { forecast: forecast(Number(url.searchParams.get('horizon') || 90)) });
  if (req.method === 'GET' && url.pathname === '/api/world-model') return json(res, 200, lightWorldModel(Number(url.searchParams.get('horizon') || 60)));
  if (req.method === 'GET' && url.pathname === '/api/navigation') {
    const from = url.searchParams.get('from') || state.user.location;
    const to = url.searchParams.get('to') || 'museum';
    if (!node(from) || !node(to)) return json(res, 404, { error: 'Unknown node_id', from, to });
    const p = pathBetween(from, to, planningForecast());
    if (!p) return json(res, 409, { error: 'No feasible route', from, to });
    const segments = p.steps.map(step => {
      const id = step.from, next = step.to, e = step, n = node(next);
      const crowd = state.crowd[next] || .2;
      const slope = Math.round(Math.abs(node(id).y - n.y) / 9);
      const chairs = e.shade > .7 ? Math.round(4 + e.shade * 5) : e.shade > .45 ? 2 : 1;
      return { from: node(id).name, to: n.name, edge_id: e.edge_id, distance: e.distance, minutes: e.minutes, shade: Math.round(e.shade * 100), chairs, slope, crowd: Math.round(crowd * 100), event: state.events.some(x => x.node === next && (x.status === 'live' || x.status === 'upcoming')), warning: crowd > .67 ? '人流较高' : e.shade < .35 ? '部分暴晒' : slope >= 5 ? '坡度变化' : '通行顺畅' };
    });
    return json(res, 200, { from, to, path: p.path, edgeSequence: p.steps.map(step => step.edge_id), totalMinutes: p.minutes, totalDistance: p.distance, segments, model: lightWorldModel() });
  }
  if (req.method === 'GET' && url.pathname === '/api/route-dna') return json(res, 200, { seeds: routeSeeds });
  if (req.method === 'GET' && url.pathname === '/api/companion') return json(res, 200, { companion: companionFacts[state.user.location] || companionFacts.museum });
  if (req.method === 'POST' && url.pathname === '/api/preferences') {
    const body = await readBody(req);
    const exitNodeId = body.exit_node_id == null || body.exit_node_id === '' ? null : body.exit_node_id;
    if (exitNodeId !== null && (typeof exitNodeId !== 'string' || !scenicGraph.nodes.some(node => (node.node_id || node.id) === exitNodeId && (node.access_roles || []).includes('PARK_EXIT')))) return json(res, 400, { error: 'exit_node_id 必须是已知的离园出口' });
    preferenceProfile = inferPreferenceV2(body.answers || {});
    if (exitNodeId) preferenceProfile.planner_rules.preferred_exit_node_id = exitNodeId;
    const weights = preferenceProfile.weights;
    const preference = legacyRoutePreference(weights);
    state.user.preference = weights;
    state.user.preferenceProfile = preferenceProfile;
    if (body.current_node_id !== undefined) {
      if (typeof body.current_node_id !== 'string' || !node(body.current_node_id)) return json(res, 400, { error: 'current_node_id 必须是已知景区位置' });
      state.user.location = body.current_node_id;
    }
    if (body.leaveAt && /^\d{2}:\d{2}$/.test(body.leaveAt)) { const [h, m] = body.leaveAt.split(':').map(Number); const leave = h * 60 + m; const now = state.minute % (24 * 60); state.user.remainingMinutes = Math.max(30, leave >= now ? leave - now : leave + 24 * 60 - now); }
    commit();
    const planResult = makeLivePlan(preferenceProfile.planner_rules);
    setActivePlan(planResult);
    accounts.saveRoute(req.account, planResult, preferenceProfile);
    return json(res, 200, { preference: weights, legacyPreference: preference, preferenceProfile, routes: makeRoutes(weights), planResult, model: lightWorldModel(), user: state.user });
  }
  if (req.method === 'POST' && url.pathname === '/api/replan') {
    const body = await readBody(req);
    if (body.location && node(body.location)) state.user.location = body.location;
    if (body.load !== undefined) state.user.load = Math.min(1, Math.max(0, Number(body.load)));
    commit();
    updateEnvironment();
    const planResult = makeLivePlan();
    setActivePlan(planResult);
    return json(res, 200, { routes: makeRoutes(state.user.preference || defaultPreference), planResult, forecast: forecast(), model: lightWorldModel(), user: state.user, crowd: state.crowd, queues: state.queues, updatedAt: new Date().toISOString() });
  }
  if (req.method === 'POST' && url.pathname === '/api/companion') {
    const body = await readBody(req); const fact = companionFacts[body.location || state.user.location] || companionFacts.museum;
    const answer = body.question ? `结合你现在的位置和行程，我建议先关注“${fact.name}”的核心体验。${fact.fact}` : fact.fact;
    return json(res, 200, { answer, source: '景区知识库 · 已定位到当前景点', companion: fact });
  }
  if (req.method === 'POST' && url.pathname === '/api/dna/clone') {
    const body = await readBody(req); const source = routeSeeds.find(x => x.id === body.id) || routeSeeds[0]; const preference = state.user.preference || defaultPreference;
    const routes = makeRoutes(preference);
    const cloned = routes[preference.freedom > preference.time ? 2 : 1] || routes[0];
    if (!cloned) return json(res, 409, { error: 'No feasible route' });
    return json(res, 200, { source, route: { ...cloned, title: `${source.title} · 个性化变异`, dna: `#${source.id}-M${Math.floor(Math.random() * 900 + 100)}` } });
  }
  if (req.method === 'POST' && url.pathname === '/api/emergency') {
    const body = await readBody(req); const type = body.type || 'rain';
    return json(res, 200, { ok: true, emergency: type === 'sos' ? { sos: true, message: 'SOS 已发送至景区服务中心，系统正在共享你的授权位置' } : { rain: true, safe: false, message: '已切换至应急规划：优先推荐最近的室内与避雨节点' } });
  }
  if (req.method === 'POST' && url.pathname === '/api/feedback') {
    const body = await readBody(req); state.feedback.push({ ...body, at: new Date().toISOString() });
    if (body.load !== undefined) state.user.load = Math.min(1, Math.max(0, Number(body.load)));
    commit();
    return json(res, 200, { ok: true, feedbackCount: state.feedback.length, user: state.user });
  }
  if (req.method === 'POST' && url.pathname === '/api/simulate-event') {
    const body = await readBody(req); const id = body.node || 'market';
    const next = applyScenarioEvent(provider.getState(), { event_type: 'QUEUE_SPIKE', target_id: id, timestamp: provider.getState().timestamp });
    const eventId = `event-${next.scenario_events.length}`;
    next.event_states[eventId] = { event_id: eventId, node_id: id, status: 'live', start_time: next.timestamp, latest_entry_time: next.timestamp, capacity: node(id)?.capacity || 100, title: body.title || '现场事件：人流快速聚集' };
    provider.setState(next);
    refresh();
    audit(req, 'scenic.queue_spike', id);
    const planResult = makeLivePlan();
    setActivePlan(planResult);
    return json(res, 200, { ok: true, ...snapshot(), planResult });
  }
  if (req.method === 'POST' && url.pathname === '/api/simulate-road-closure') {
    const body = await readBody(req);
    const requested = body.edge_id || 'edge_002';
    const scenario = livePlannerScenario();
    if (!scenario.graph.edges.some(item => item.edge_id === requested)) return json(res, 400, { error: `未知道路 ${requested}` });
    const next = provider.getState();
    next.road_states[requested].available = false;
    provider.setState(next);
    refresh();
    audit(req, 'scenic.road_close', requested);
    const updatedScenario = livePlannerScenario();
    const event = { schema_version: updatedScenario.state.schema_version, scenario_id: updatedScenario.state.scenario_id, event_type: 'ROAD_CLOSED', edge_id: requested, timestamp: updatedScenario.state.timestamp };
    const planResult = replan({ ...updatedScenario, event, rules: state.user.preferenceProfile?.planner_rules || {} });
    setActivePlan(planResult);
    return json(res, 200, { ok: true, ...snapshot(), planResult, closed_edge_id: requested });
  }
  return json(res, 404, { error: 'Not found' });
}

function serve(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  const safe = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC, safe));
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'File not found' });
    const ext = path.extname(file); const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' }); res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  req.requestId = require('node:crypto').randomUUID();
  req.account = accounts.sessionUser(req);
  if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method) && req.headers.origin &&
    new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: '跨站请求被拒绝' });
  if (url.pathname.startsWith('/api/')) api(req, res, url).catch(err => {
    const code = err.statusCode || (/^Unknown /.test(err.message) ? 404 : err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError || url.pathname.startsWith('/api/b/') ? 400 : 500);
    json(res, code, { error: err.message });
  });
  else if (req.method === 'GET') serve(req, res);
  else json(res, 405, { error: 'Method not allowed' });
});

function startServer(port) {
  let settled = false;
  const onError = (err) => {
    if (settled) return;
    settled = true;
    server.removeListener('error', onError);
    const hint = err.code === 'EADDRINUSE'
      ? `端口 ${port} 已被其他程序占用。请先关闭旧的 Node 进程，或明确设置 PORT 后再启动。`
      : err.message;
    console.error(`无法启动景策万象服务（端口 ${port}）：${hint}`);
    process.exitCode = 1;
  };
  server.once('error', onError);
  server.listen(port, '0.0.0.0', () => {
    if (settled) return;
    settled = true;
    server.removeListener('error', onError);
    console.log(`景策万象 running at http://localhost:${port}`);
  });
}

if (require.main === module) startServer(PORT);
module.exports = { server, startServer, updateEnvironment };
