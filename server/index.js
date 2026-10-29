const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { createMockScenario, buildLivePlannerScenario, planItinerary, replan, promoteAlternative } = require('./planner');
const { inferPreference: inferPreferenceV2 } = require('./preference-engine');
const accounts = require('./accounts');
const { createCommunity, ROUTE_TAGS } = require('./community');
const { routeSeeds } = require('./dna-seeds');
const { normalizeProgressEvent, summarizePlanChange } = require('./c-progress');
const { createCompanionService } = require('./companion/service');
const { createOperations } = require('./companion/operations');
const { createCloudEngine } = require('./companion/cloud/engine');
const { createVoiceGateway } = require('./companion/voice-gateway');
const { createQianfanTts } = require('./companion/qianfan-tts');
const syntheticWorldModel = require('./world-model/synthetic-baseline');
const graphTemporalWorldModel = require('./world-model/graph-temporal');
const crowdTrendWorldModel = require('./world-model/crowd-trend');
const applicationCrowd = require('./world-model/application-crowd');

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
function requireVisitor(req, res) {
  if (!requireAccount(req, res)) return false;
  if (req.account.role === 'visitor') return true;
  audit(req, 'permission.denied', req.url, 'denied');
  json(res, 403, { error: '此功能仅供普通游客账号使用；管理者请使用管理工作台' });
  return false;
}

const provider = require('./state/stateProvider');
const { predictEnvironment } = require('./state/forecastSimulator');
const { applyScenarioEvent, parseTime } = require('./state/scenarioEngine');
const { queryQueue, queryTravelTime } = require('./state/forecastQuery');
const scenarioSettings = require('./data/scenarios.json');
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
const cProgressEventCache = new Map();
const C_PROGRESS_CACHE_LIMIT = 200;
const companionOperations = createOperations({ readIncidents: () => {
  const current = provider.getState();
  const events = Object.values(current.event_states || {}).filter(item => ['live', 'upcoming', 'active'].includes(item.status) && !item.cancelled).map(item => ({
    incident_id: item.event_id, incident_type: 'SCENIC_EVENT', severity: 'medium', scope: item.node_id,
    status: 'active', source: '共享演示事件状态', started_at: item.start_time, title: item.title || '景区活动事件'
  }));
  const closedRoads = scenicGraph.edges.filter(edge => current.road_states[edge.edge_id]?.available === false).map(edge => ({
    incident_id: `closure:${edge.edge_id}`, incident_type: 'ROAD_CLOSED', severity: 'high', scope: edge.edge_id,
    status: 'active', source: '共享演示路网状态', started_at: current.timestamp, title: `演示封闭：${edge.name || edge.edge_id}`
  }));
  return [...events, ...closedRoads];
} });
const community = createCommunity();
const publicCommunityRoutes = viewerId => community.listRoutes(viewerId, username => Boolean(accounts.findShareableProfile(username)));
const companionCloud = createCloudEngine({
  ledgerPath: process.env.COMPANION_USAGE_FILE || (process.env.ACCOUNTS_FILE
    ? path.join(path.dirname(process.env.ACCOUNTS_FILE), 'companion-usage.local.json')
    : path.join(__dirname, 'data', 'companion-usage.local.json'))
});
const companionVoice = createVoiceGateway();
const qianfanTts = createQianfanTts();
const companionService = createCompanionService({
  cloudEngine: companionCloud,
  graph: scenicGraph,
  readState: () => {
    const current = { ...provider.getState(), data_mode: 'demo' };
    delete current.visitor;
    return current;
  },
  readOperations: () => companionOperations.read(),
  // Companion route context is reconstructed from the authenticated account's
  // own saved route only; the shared demo planner state is never exposed.
  readPlan: ({ owner } = {}) => {
    const match = /^account:(.+)$/.exec(String(owner || ''));
    const user = match && accounts.getUserById(match[1]);
    const saved = user?.routeHistory?.[0];
    if (!saved?.stops?.length) return null;
    const itinerary = saved.stops.map(nodeId => {
      const item = scenicGraph.nodes.find(value => value.node_id === nodeId);
      if (!item?.poi_id) return null;
      return { target_id: item.poi_id, target_node_id: item.node_id, action_type: item.type === 'show' ? 'ATTEND_EVENT' : 'VISIT_POI' };
    }).filter(Boolean);
    const next = itinerary[0];
    return next ? { plan_id: saved.planId || `saved-${saved.createdAt}`, next_action: { target_id: next.target_id }, itinerary, reason: '来自该账号最近一次保存的路线；路线说明不改变规划结果。', generated_at: saved.createdAt } : null;
  },
  readPreferences: ({ owner } = {}) => {
    const match = /^account:(.+)$/.exec(String(owner || ''));
    return match ? accounts.getUserById(match[1])?.preferences || null : null;
  },
});
const companionGuests = new Map();
function companionOwner(req, res) {
  if (req.account) return `account:${req.account.id}`;
  const token = /(?:^|;\s*)jc_companion=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const now = Date.now();
  for (const [key, expires] of companionGuests) if (expires <= now) companionGuests.delete(key);
  if (token && companionGuests.has(token)) {
    companionGuests.set(token, now + 30 * 60 * 1000);
    return `guest:${token}`;
  }
  const created = require('node:crypto').randomBytes(32).toString('hex');
  if (companionGuests.size >= 1000) companionGuests.delete(companionGuests.keys().next().value);
  companionGuests.set(created, now + 30 * 60 * 1000);
  res.setHeader('Set-Cookie', `jc_companion=${created}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=1800${req.socket?.encrypted ? '; Secure' : ''}`);
  return `guest:${created}`;
}
function companionSessionCookie(req) {
  return /(?:^|;\s*)jc_companion_session=([A-Za-z0-9_-]{8,80})(?:;|$)/.exec(req.headers.cookie || '')?.[1] || null;
}
function setCompanionSessionCookie(req, res, sessionId) {
  const existing = res.getHeader('Set-Cookie');
  const cookies = existing == null ? [] : Array.isArray(existing) ? existing : [existing];
  cookies.push(`jc_companion_session=${sessionId}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=1800${req.socket?.encrypted ? '; Secure' : ''}`);
  res.setHeader('Set-Cookie', cookies);
}
function companionConsent(req, body) {
  const permissions = body.permissions || {};
  return {
    location: permissions.location === true && (!req.account || req.account.consent?.location === true),
    route: permissions.route === true,
    preferences: permissions.preferences === true,
  };
}
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
  const graph = provider.getScenicGraph();
  const baseForecast = predictEnvironment(current, ROUTE_FORECAST_HORIZON_MIN, 10);
  const crowd = applicationCrowd.predictApplicationCrowd(graph, current,
    predictEnvironment(current, 60, 5));
  const forecast = applicationCrowd.blendCrowdIntoForecast(baseForecast, crowd.distribution);
  return buildLivePlannerScenario(graph, current, state.user, forecast);
}

function setActivePlan(planResult) {
  currentPlanResult = planResult || null;
  currentPlanNextTarget = planResult?.next_action?.target_id || null;
  currentPlanId = planResult?.plan_id || null;
  refresh();
}

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
  return {
    model: 'Light Scenic Graph World Model',
    version: 'LSGWM-0.4-rule-simulation',
    source_mode: 'synthetic_rule_simulation',
    source_tier: 'synthetic',
    trained: false,
    fallback: 'rule_planner',
    latent: { env: [meanCrowd, meanQueue / 25, current.weather.rain], user: [current.visitor.fatigue] },
    state: { environment: meanCrowd > .68 ? '多点拥挤' : meanCrowd > .42 ? '局部繁忙' : '人流稳定', user: current.visitor.fatigue > .7 ? '负荷偏高' : current.visitor.fatigue > .42 ? '建议安排休息' : '舒适' },
    horizon: points,
    uncertainty: 19,
    updatedAt: current.timestamp,
    limitations: ['当前为可重复规则模拟', '未使用本地真实客流训练', '预测结果尚未使用真实客流校准']
  };
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

function pathBetween(start, goal, forecastData, departOffsetMin = 0, objective = 'time') {
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
      const cost = best[current].cost + (objective === 'distance' ? Number(next.distance) || 0 : road.travel_time_min + crowdPenalty);
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
    metrics: { nodes: graph.nodes.length, edges: graph.edges.length, source_mode: 'synthetic_rule_simulation', measured: false }
  };
}

let simulationAnchor = null;
let simulatedMinutes = 0;
let lastUpdateVersion = null;
function updateEnvironment() {
  const current = provider.getState();
  const runawayRoadTime = scenicGraph.edges.some(edge => Number(current.road_states[edge.edge_id]?.travel_time_min) > Number(edge.base_travel_time_min) * 10);
  // Keep a stable baseline between external state changes so small drifts are not lost to repeated rounding.
  if (!simulationAnchor || current.state_version !== lastUpdateVersion || simulatedMinutes >= 1440 || runawayRoadTime) {
    simulationAnchor = provider.cloneState(current);
    const completedFactor=1+simulatedMinutes/60*scenarioSettings.NORMAL.road_delay_per_hour;
    for(const edge of scenicGraph.edges){
      const road=simulationAnchor.road_states[edge.edge_id];
      if(!road)continue;
      if(runawayRoadTime && road.travel_time_min>edge.base_travel_time_min*10)road.travel_time_min=edge.base_travel_time_min;
      else if(simulatedMinutes>=1440)road.travel_time_min=Math.max(edge.base_travel_time_min,Math.round(road.travel_time_min/completedFactor*100)/100);
    }
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
  if (req.method === 'GET' && url.pathname === '/api/account/export') {
    if (!requireAccount(req, res)) return;
    const payload = { exported_at: new Date().toISOString(), account: accounts.profile(req.account),
      community: req.account.role === 'visitor' ? community.me(req.account) : null,
      scope_note: '此导出包含当前本地账号资料、偏好、路线历史与个人中心记录；不含服务端审计日志、第三方模型处理记录或共享演示运行状态。' };
    audit(req, 'account.data.export', req.account.id);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="jingce-account-export.json"', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(payload, null, 2));
  }
  if (req.method === 'DELETE' && url.pathname === '/api/account/me') {
    if (!requireAccount(req, res)) return;
    const body = await readBody(req);
    if (req.account.role !== 'visitor') return json(res, 403, { error: '管理者账号不能通过游客端自助删除' });
    const removed = accounts.deleteUser(req.account, body.password, () => community.deleteUserData(req.account.id));
    audit(req, 'account.delete', removed.id, 'success', { removedRoutes: true });
    res.setHeader('Set-Cookie', accounts.clearCookie());
    return json(res, 200, { ok: true, message: '账号及本地个人中心数据已删除' });
  }
  if (req.method === 'PATCH' && url.pathname === '/api/account/profile') {
    if (!requireAccount(req, res)) return;
    const profile = accounts.updateProfile(req.account, await readBody(req));
    audit(req, 'profile.update', req.account.id, 'success', { fields: ['displayName', 'consent'] });
    return json(res, 200, { profile });
  }
  if (req.method === 'GET' && url.pathname === '/api/community/routes')
    return json(res, 200, { routes: publicCommunityRoutes(req.account?.role === 'visitor' ? req.account.id : null), popular_pois: community.popularPois(new Map(scenicGraph.nodes.map(item => [item.node_id, item.name])), req.account?.role === 'visitor' ? req.account.id : null) });
  if (req.method === 'GET' && url.pathname === '/api/community/me') {
    if (!requireVisitor(req, res)) return;
    return json(res, 200, community.me(req.account));
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/community/routes') {
    if (!requireManager(req, res)) return;
    return json(res, 200, { routes: community.listForModeration() });
  }
  const moderationRoute = /^\/api\/admin\/community\/routes\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'PATCH' && moderationRoute) {
    if (!requireManager(req, res)) return;
    const body = await readBody(req);
    const route = community.moderateRoute(decodeURIComponent(moderationRoute[1]), body.status);
    audit(req, 'community.route.moderate', route.id, 'success', { status: route.status });
    return json(res, 200, { route });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/announcements') {
    if (!requireManager(req, res)) return;
    return json(res, 200, { announcements: companionOperations.list() });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/announcements') {
    if (!requireManager(req, res)) return;
    const body = await readBody(req);
    const announcement = companionOperations.publish(body);
    audit(req, 'operations.announcement.create', announcement.id, 'success', { reviewStatus: announcement.review_status });
    return json(res, 201, { announcement });
  }
  const announcementAction = /^\/api\/admin\/announcements\/([^/]+)$/.exec(url.pathname);
  if (announcementAction && req.method === 'PATCH') {
    if (!requireManager(req, res)) return;
    const body = await readBody(req);
    const announcement = companionOperations.setReviewStatus(decodeURIComponent(announcementAction[1]), body.review_status);
    audit(req, 'operations.announcement.review', announcement.id, 'success', { reviewStatus: announcement.review_status });
    return json(res, 200, { announcement });
  }
  if (announcementAction && req.method === 'DELETE') {
    if (!requireManager(req, res)) return;
    const id = decodeURIComponent(announcementAction[1]);
    const removed = companionOperations.remove(id);
    if (!removed) return json(res, 404, { error: '没有找到这条公告' });
    audit(req, 'operations.announcement.delete', id);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/community/profiles/')) {
    const username = decodeURIComponent(url.pathname.slice('/api/community/profiles/'.length));
    return json(res, 200, community.publicProfile(username, accounts.findShareableProfile));
  }
  if (req.method === 'POST' && url.pathname === '/api/community/routes') {
    if (!requireAccount(req, res)) return;
    const body = await readBody(req);
    const result = community.publishRoute(req.account, body, scenicGraph.graph_version || scenicGraph.schema_version, stops => {
      const validNodes = stops.map(id => scenicGraph.nodes.find(item => item.node_id === id));
      if (validNodes.some(item => !item || !item.poi_id)) return { valid: false, error: '路线只能包含地图1统一图中可规划的景点节点' };
      const forecastData = planningForecast();
      let elapsed = 0;
      for (let index = 1; index < stops.length; index++) {
        const segment = pathBetween(stops[index - 1], stops[index], forecastData, elapsed);
        if (!segment) return { valid: false, error: `当前模拟状态下无法从${validNodes[index - 1].name}到达${validNodes[index].name}` };
        elapsed += segment.minutes;
      }
      return { valid: true };
    });
    audit(req, 'community.route.publish', result.id, 'success', { stops: result.stops.length });
    return json(res, 201, { route: result });
  }
  const routeAction = /^\/api\/community\/routes\/([^/]+)\/(like|favorite)$/.exec(url.pathname);
  if (req.method === 'POST' && routeAction) {
    if (!requireVisitor(req, res)) return;
    const [, routeId, action] = routeAction;
    const exists = publicCommunityRoutes(req.account.id).some(route => route.id === routeId);
    if (!exists) return json(res, 404, { error: '没有找到这条公开路线' });
    const body = await readBody(req);
    if (action === 'like') {
      const route = community.toggleLike(req.account, routeId);
      audit(req, 'community.route.like', routeId);
      return json(res, 200, { route });
    }
    const favorite_routes = community.setMembership(req.account, 'favorite_routes', routeId, body.saved === true);
    audit(req, 'community.route.favorite', routeId);
    return json(res, 200, { favorite_routes });
  }
  const seedRouteAction = /^\/api\/community\/dna-seeds\/([^/]+)\/(like|favorite)$/.exec(url.pathname);
  if (req.method === 'POST' && seedRouteAction) {
    if (!requireVisitor(req, res)) return;
    const [, seedId, action] = seedRouteAction;
    const body = await readBody(req);
    const listName = action === 'like' ? 'liked_routes' : 'favorite_routes';
    const enabled = action === 'like' ? body.liked === true : body.saved === true;
    const routes = community.setSeedMembership(req.account, listName, seedId, enabled);
    audit(req, `community.dna_seed.${action}`, seedId);
    return json(res, 200, { [listName]: routes });
  }
  if (req.method === 'POST' && ['/api/community/poi-favorites', '/api/community/checkins'].includes(url.pathname)) {
    if (!requireVisitor(req, res)) return;
    const body = await readBody(req);
    const scenicNode = scenicGraph.nodes.find(item => item.node_id === body.node_id && item.poi_id);
    if (!scenicNode) return json(res, 400, { error: '景点必须来自地图1统一图中的可规划节点' });
    if (url.pathname.endsWith('poi-favorites')) {
      const saved = body.saved === true;
      const favorite_pois = community.setMembership(req.account, 'favorite_pois', scenicNode.node_id, saved);
      audit(req, saved ? 'community.poi.favorite' : 'community.poi.unfavorite', scenicNode.node_id);
      return json(res, 200, { favorite_pois });
    }
    const item = community.checkin(req.account, scenicNode.node_id, scenicNode.name);
    audit(req, 'community.poi.checkin', scenicNode.node_id, 'success', { mode: 'visitor_self_reported_demo' });
    return json(res, 201, { checkin: item });
  }
  if (req.method === 'POST' && url.pathname === '/api/community/poi-likes') {
    if (!requireVisitor(req, res)) return;
    const body = await readBody(req);
    const scenicNode = scenicGraph.nodes.find(item => item.node_id === body.node_id && item.poi_id);
    if (!scenicNode) return json(res, 400, { error: '点赞景点必须来自地图1统一图中的可规划节点' });
    const liked_pois = community.setMembership(req.account, 'liked_pois', scenicNode.node_id, body.liked === true);
    audit(req, body.liked === true ? 'community.poi.like' : 'community.poi.unlike', scenicNode.node_id);
    return json(res, 200, { liked_pois });
  }
  if (req.method === 'POST' && url.pathname === '/api/community/views') {
    if (!requireVisitor(req, res)) return;
    const body = await readBody(req);
    const scenicNode = scenicGraph.nodes.find(item => item.node_id === body.node_id && item.poi_id);
    if (!scenicNode) return json(res, 400, { error: '浏览记录必须来自地图1统一图中的景点节点' });
    return json(res, 201, { view: community.recordView(req.account, scenicNode.node_id, scenicNode.name) });
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
  if (req.method === 'GET' && url.pathname === '/api/v1/world-model/experimental') return json(res, 200, syntheticWorldModel.describe());
  if (req.method === 'POST' && url.pathname === '/api/v1/world-model/experimental') {
    const body = await readBody(req);
    try { return json(res, 200, syntheticWorldModel.predict(body.observation)); }
    catch (error) { return json(res, 400, { error: error.message, model_mode: 'experimental_shadow' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/world-model/graph-temporal') return json(res, 200, graphTemporalWorldModel.describe());
  if (req.method === 'POST' && url.pathname === '/api/v1/world-model/graph-temporal') {
    const body = await readBody(req);
    try { return json(res, 200, graphTemporalWorldModel.predict(scenicGraph, body.observation, body.history || [])); }
    catch (error) { return json(res, 400, { error: error.message, model_mode: 'experimental_shadow' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/world-model/crowd-trend') return json(res, 200, crowdTrendWorldModel.describe());
  if (req.method === 'POST' && url.pathname === '/api/v1/world-model/crowd-trend') {
    const body = await readBody(req);
    try { return json(res, 200, crowdTrendWorldModel.predict(scenicGraph, body.observation,
      { horizonMin: body.horizon_min ?? 30, history: body.history || [], routes: body.routes || [] })); }
    catch (error) { return json(res, 400, { error: error.message, model_mode: 'experimental_shadow', affects_planning: false }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/environment-forecast') return json(res, 200, predictEnvironment(provider.getState(), Number(url.searchParams.get('horizon') || 60), Number(url.searchParams.get('step') || 10)));
  if (req.method === 'GET' && url.pathname === '/api/v1/crowd-distribution') {
    try {
      const current = provider.getState();
      const calibration = predictEnvironment(current, 60, 5);
      return json(res, 200, applicationCrowd.predictApplicationCrowd(scenicGraph, current, calibration));
    }
    catch (error) { return json(res, 503, { error: '轻量化世界模型暂不可用', fallback: 'environment-forecast 规则模拟仍可用', detail: error.message }); }
  }
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
    accounts.saveRoute(req.account, planResult, req.account?.preferences || null);
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
    accounts.saveRoute(req.account, planResult, req.account?.preferences || null);
    return json(res, 200, planResult);
  }
  if (req.method === 'POST' && url.pathname === '/api/b/demo-event') {
    const body = req.demoEventBody;
    const rawEvent = body.event;
    let progress;
    try { progress = normalizeProgressEvent(rawEvent); }
    catch (error) { return json(res, 400, { error: error.message }); }
    const event = progress.event;
    if (!event || typeof event.event_type !== 'string') return json(res, 400, { error: 'event.event_type 为必填项' });
    const progressKey = progress.eventId ? `${provider.getState().visitor.visitor_id}:${progress.eventId}` : null;
    if (progressKey && cProgressEventCache.has(progressKey))
      return json(res, 200, { ...cProgressEventCache.get(progressKey), idempotent: true });
    if (progress.exitNodeId) {
      const exitNode = scenicGraph.nodes.find(item => (item.node_id || item.id) === progress.exitNodeId);
      if (!exitNode || !(exitNode.access_roles || []).includes('PARK_EXIT'))
        return json(res, 400, { error: `EXIT_CHANGE.node_id 不是已知离园出口: ${progress.exitNodeId}` });
      const existingRules = preferenceProfile?.planner_rules || {};
      preferenceProfile = {
        ...(preferenceProfile || {}),
        weights: preferenceProfile?.weights || state.user.preference || defaultPreference,
        planner_rules: { ...existingRules, preferred_exit_node_id: progress.exitNodeId },
      };
      state.user.preferenceProfile = preferenceProfile;
    }
    const previousPlan = currentPlanResult;
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
    accounts.saveRoute(req.account, planResult, req.account?.preferences || null);
    const progressRecord = progress.progress ? {
      ...progress.progress,
      applied_at: planResult.generated_at,
      state_version: planResult.based_on_state_version,
      plan_id: planResult.plan_id,
    } : null;
    const changeSummary = progressRecord ? summarizePlanChange(previousPlan, planResult, progressRecord) : null;
    audit(req, progressRecord || type === 'PROGRESS_UPDATE' ? 'route.progress' : 'scenic.demo_event', event.edge_id || target || event.current_node_id || null, 'success', { eventType: progressRecord?.event_type || type });
    const response = { ok: true, ...snapshot(), planResult };
    if (progressRecord) {
      response.progress_event = progressRecord;
      response.change_summary = changeSummary;
    }
    if (progressKey) {
      if (cProgressEventCache.size >= C_PROGRESS_CACHE_LIMIT) cProgressEventCache.delete(cProgressEventCache.keys().next().value);
      cProgressEventCache.set(progressKey, response);
    }
    return json(res, 200, response);
  }
  if (req.method === 'GET' && url.pathname === '/api/snapshot') return json(res, 200, snapshot());
  if (req.method === 'GET' && url.pathname === '/api/pois') return json(res, 200, { nodes: graph.nodes, edges: graph.edges });
  if (req.method === 'GET' && url.pathname === '/api/forecast') return json(res, 200, { forecast: forecast(Number(url.searchParams.get('horizon') || 90)) });
  if (req.method === 'GET' && url.pathname === '/api/world-model') return json(res, 200, lightWorldModel(Number(url.searchParams.get('horizon') || 60)));
  if (req.method === 'GET' && url.pathname === '/api/navigation') {
    const from = url.searchParams.get('from') || state.user.location;
    const to = url.searchParams.get('to') || 'museum';
    if (!node(from) || !node(to)) return json(res, 404, { error: 'Unknown node_id', from, to });
    const objective = url.searchParams.get('objective') === 'distance' ? 'distance' : 'time';
    const p = pathBetween(from, to, planningForecast(), 0, objective);
    if (!p) return json(res, 409, { error: 'No feasible route', from, to });
    const segments = p.steps.map(step => {
      const id = step.from, next = step.to, e = step, n = node(next);
      const crowd = state.crowd[next] || .2;
      const slope = Math.round(Math.abs(node(id).y - n.y) / 9);
      const chairs = e.shade > .7 ? Math.round(4 + e.shade * 5) : e.shade > .45 ? 2 : 1;
      return { from: node(id).name, to: n.name, edge_id: e.edge_id, distance: e.distance, minutes: e.minutes, shade: Math.round(e.shade * 100), chairs, slope, crowd: Math.round(crowd * 100), event: state.events.some(x => x.node === next && (x.status === 'live' || x.status === 'upcoming')), warning: crowd > .67 ? '人流较高' : e.shade < .35 ? '部分暴晒' : slope >= 5 ? '坡度变化' : '通行顺畅' };
    });
    return json(res, 200, { from, to, objective, path: p.path, edgeSequence: p.steps.map(step => step.edge_id), totalMinutes: p.minutes, totalDistance: p.distance, segments, model: lightWorldModel() });
  }
  if (req.method === 'GET' && url.pathname === '/api/route-dna') {
    const selectedTags = [...new Set((url.searchParams.get('tags') || '').split(',').filter(Boolean))];
    if (selectedTags.some(tag => !ROUTE_TAGS.includes(tag))) return json(res, 400, { error: '包含不支持的路线特点标签', available_tags: ROUTE_TAGS });
    const matches = tags => selectedTags.every(tag => (tags || []).includes(tag));
    return json(res, 200, { tags: ROUTE_TAGS, selected_tags: selectedTags,
      seeds: routeSeeds.filter(seed => matches(seed.tags)).map(seed => community.seedSummary(seed, req.account?.role === 'visitor' ? req.account.id : null)),
      community: community.listRoutes(req.account?.role === 'visitor' ? req.account.id : null, username => Boolean(accounts.findShareableProfile(username)), { tags: selectedTags }),
      popular_pois: community.popularPois(new Map(scenicGraph.nodes.map(item => [item.node_id, item.name])), req.account?.role === 'visitor' ? req.account.id : null) });
  }
  if (req.method === 'GET' && url.pathname === '/api/companion/voice') {
    const vivo = companionVoice.status(), qianfan = qianfanTts.status();
    return json(res, 200, { ...vivo, enabled: vivo.enabled || qianfan.qianfan_tts_ready,
      tts_ready: qianfan.qianfan_tts_ready || vivo.tts_ready,
      provider: qianfan.qianfan_tts_ready ? 'qianfan_tts' : vivo.provider,
      tts_provider: qianfan.qianfan_tts_ready ? 'qianfan' : vivo.tts_ready ? 'vivo' : null,
      qianfan_tts_ready: qianfan.qianfan_tts_ready });
  }
  if (req.method === 'POST' && url.pathname === '/api/companion/voice/asr') return json(res, 200, await companionVoice.recognize(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/companion/voice/tts') {
    const payload = await readBody(req);
    return json(res, 200, qianfanTts.status().qianfan_tts_ready
      ? await qianfanTts.synthesize(payload)
      : await companionVoice.synthesize(payload));
  }
  if (req.method === 'GET' && url.pathname === '/api/companion') return json(res, 200, {
    companion: companionFacts[state.user.location] || companionFacts.museum,
    service: companionService.status(),
    mode: companionCloud.config.enabled ? 'cloud_first_with_local_fallback' : 'local',
    cloud: companionCloud.config,
  });
  if (req.method === 'GET' && url.pathname === '/api/companion/costs') {
    if (!requireManager(req, res)) return;
    return json(res, 200, companionCloud.report());
  }
  if (req.method === 'GET' && url.pathname === '/api/operations') return json(res, 200, companionOperations.read());
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
    accounts.saveRoute(req.account, planResult, req.account?.preferences || null);
    return json(res, 200, { routes: makeRoutes(state.user.preference || defaultPreference), planResult, forecast: forecast(), model: lightWorldModel(), user: state.user, crowd: state.crowd, queues: state.queues, updatedAt: new Date().toISOString() });
  }
  if (req.method === 'POST' && url.pathname === '/api/companion') {
    const body = await readBody(req), owner = companionOwner(req, res);
    if (!body.session_id && companionSessionCookie(req)) body.session_id = companionSessionCookie(req);
    const result = await companionService.respondAsync(body, {
      owner, consent: companionConsent(req, body), currentConsent: () => companionConsent(req, body),
    });
    setCompanionSessionCookie(req, res, result.session_id);
    return json(res, 200, result);
  }
  if (req.method === 'DELETE' && url.pathname === '/api/companion/session') {
    const body = await readBody(req), owner = companionOwner(req, res);
    companionService.clear(owner, body.session_id || companionSessionCookie(req));
    const existing = res.getHeader('Set-Cookie');
    const cookies = existing == null ? [] : Array.isArray(existing) ? existing : [existing];
    cookies.push(`jc_companion_session=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${req.socket?.encrypted ? '; Secure' : ''}`);
    res.setHeader('Set-Cookie', cookies);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/dna/clone') {
    const body = await readBody(req);
    const source = routeSeeds.find(item => item.id === body.id)
      || publicCommunityRoutes(req.account?.role === 'visitor' ? req.account.id : null).find(item => item.id === body.id);
    if (!source) return json(res, 404, { error: '没有找到这条路线DNA' });
    const preference = state.user.preference || defaultPreference;
    // DNA provides inspiration and tags only. The same B planner and shared
    // graph/state/forecast generate a fresh itinerary, never copying stale edges.
    const scenario = livePlannerScenario();
    const templateWeights = { time: .08, interest: .12, comfort: .08, freedom: .08, culture: .1, nature: .1, performance: .1, food: .1 };
    const weights = body.mutate === false ? { ...templateWeights } : { ...defaultPreference, ...preference };
    const taggedNodes = (source.stops || []).map(id => scenicGraph.nodes.find(item => item.node_id === id)).filter(Boolean);
    const tagRules = [
      ['culture', /文化|宋|展陈|武术|历史/], ['nature', /自然|瀑布|林|视野|城墙/],
      ['performance', /演艺|演出|预约/], ['food', /美食|市集/], ['comfort', /休息|补给|安静|舒适/]
    ];
    for (const [key, pattern] of tagRules) if (taggedNodes.some(item => (item.tags || []).some(tag => pattern.test(tag)))) weights[key] += .18;
    const featureWeights = { '亲子': { comfort: .12 }, '文化': { culture: .2 }, '演艺': { performance: .2 }, '美食': { food: .2 }, '拍照': { freedom: .12, nature: .06 }, '轻松': { comfort: .2 }, '深度游': { culture: .12, interest: .12 }, '短时': { time: .24 }, '自然': { nature: .2, freedom: .08 } };
    for (const tag of source.tags || []) for (const [key, amount] of Object.entries(featureWeights[tag] || {})) weights[key] += amount;
    const weightTotal = Object.values(weights).reduce((sum, value) => sum + value, 0);
    const preferenceWeights = Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, value / weightTotal]));
    scenario.state = { ...scenario.state, visitor: { ...scenario.state.visitor, preference_weights: preferenceWeights } };
    const userRules = req.account?.preferences?.planner_rules || state.user.preferenceProfile?.planner_rules || {};
    const visited = new Set(scenario.state.visitor.visited_poi_ids || []);
    const remainingStops = (source.stops || []).filter(id => !visited.has(id));
    if (!remainingStops.length) return json(res, 409, { error: '这条路线中的景点都已游览，请选择其他 DNA 路线', source });
    const planResult = planItinerary({ ...scenario, rules: { ...userRules, min_actions: 1, max_actions: remainingStops.length }, target_order: remainingStops, ensure_alternatives: false });
    const plannedStops = (planResult.itinerary || []).filter(item => ['VISIT_POI', 'ATTEND_EVENT'].includes(item.action_type)).map(item => item.target_node_id || item.target_id);
    const matchesTemplatePrefix = plannedStops.length > 0 && plannedStops.every((id, index) => id === remainingStops[index]);
    if (!matchesTemplatePrefix) return json(res, 409, { error: '当前地图1示意路网、游览状态和剩余时间无法执行这条 DNA 路线，请换一条短路线或重新规划时间', source });
    const appliedStops = remainingStops.slice(0, plannedStops.length);
    // The planner may return a legal ordered prefix when the next requested
    // stop is closed or the visit window is exhausted. Report that prefix as
    // the actual feasible plan and expose the omitted stops to the client.
    planResult.feasible = true;
    planResult.diagnostics.minimum_useful_actions = appliedStops.length;
    planResult.diagnostics.satisfies_minimum_actions = true;
    planResult.diagnostics.dna_requested_stop_count = source.stops.length;
    planResult.diagnostics.dna_applied_stop_count = appliedStops.length;
    accounts.saveRoute(req.account, planResult, req.account?.preferences || null);
    const route = makeRoutes(preference).find(item => item.id === (preference.freedom > preference.time ? 'experience' : 'balance')) || makeRoutes(preference)[0];
    return json(res, 200, {
      source: { ...source, requested_stops: source.stops || [], stops: appliedStops, omitted_stops: (source.stops || []).filter(id => !appliedStops.includes(id)), stop_names: appliedStops.map(id => scenicGraph.nodes.find(item => item.node_id === id)?.name || id) },
      route: route ? { ...route, title: `${source.title} · ${body.mutate === false ? '统一规划器重算' : 'DNA偏好变异'}`, dna: `#${String(source.id).slice(0, 8)}-${body.mutate === false ? 'C' : 'M'}${Math.floor(Math.random() * 900 + 100)}`, source_seed_id: source.id, graph_version: scenicGraph.graph_version || scenicGraph.schema_version, state_version: planResult.based_on_state_version, plan_id: planResult.plan_id, planner_validated: true, inspired_by_stops: appliedStops } : null,
      planResult,
      source_mode: 'shared_graph_state_forecast_and_b_planner', dna_preferences: preferenceWeights
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/emergency') {
    const body = await readBody(req); const type = body.type || 'rain';
    if (!['sos', 'rain'].includes(type)) return json(res, 400, { error: 'type 只支持 sos 或 rain' });
    return json(res, 200, { ok: true, emergency: type === 'sos'
      ? { sos: true, delivered: false, mode: 'guidance_only', message: '未发送求助信息，也未联系景区值班系统。请直接拨打 110、120 或 119，并向接线员说明位置。' }
      : { rain: true, mode: 'guidance_only', message: '本演示没有实时天气或经核实的避雨点资料；请听从现场工作人员和广播指引。路线重算仅依据演示路网状态。' } });
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
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = requestUrl.pathname;
  if (pathname === '/login.html' && req.account) {
    res.writeHead(302, { Location: '/' }); res.end(); return;
  }
  if ((pathname === '/' || pathname === '/index.html') && !req.account && requestUrl.searchParams.get('guest') !== '1') {
    res.writeHead(302, { Location: '/login.html' }); res.end(); return;
  }
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
