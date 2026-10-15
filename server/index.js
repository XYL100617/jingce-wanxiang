const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 4173);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const graph = {
  nodes: [
    { id: 'gate', name: '北门入口', type: 'gate', x: 8, y: 78, capacity: 999, shade: 0.75, tags: ['入口', '检票', '服务'] },
    { id: 'southgate', name: '南门入口', type: 'gate', x: 10, y: 46, capacity: 999, shade: 0.62, tags: ['入口', '停车', '服务'] },
    { id: 'lake', name: '九龙瀑', type: 'scenery', x: 28, y: 39, capacity: 160, shade: 0.72, tags: ['自然', '瀑布', '拍照'] },
    { id: 'market', name: '非遗市集', type: 'culture', x: 43, y: 78, capacity: 220, shade: 0.42, tags: ['美食', '市集', '自由探索'] },
    { id: 'museum', name: '大宋武馆', type: 'culture', x: 52, y: 24, capacity: 120, shade: 0.96, tags: ['展陈', '武术', '讲解'] },
    { id: 'longtan', name: '龙坛', type: 'culture', x: 41, y: 27, capacity: 110, shade: 0.78, tags: ['宋文化', '祈福', '拍照'] },
    { id: 'forest', name: '森林绿地', type: 'scenery', x: 68, y: 49, capacity: 90, shade: 0.88, tags: ['自然', '安静', '探索'] },
    { id: 'theater', name: '武林会场', type: 'show', x: 82, y: 28, capacity: 180, shade: 0.94, tags: ['演艺', '预约', '高价值'] },
    { id: 'shizipo', name: '十字坡', type: 'show', x: 76, y: 63, capacity: 145, shade: 0.47, tags: ['演艺', '互动', '人流事件'] },
    { id: 'summit', name: '明清城墙观景点', type: 'view', x: 85, y: 78, capacity: 80, shade: 0.18, tags: ['城墙', '视野', '拍照'] },
    { id: 'rest', name: '松风驿站', type: 'service', x: 55, y: 61, capacity: 40, shade: 0.9, tags: ['休息', '补给', '厕所'] },
    { id: 'temple', name: '万岁寺', type: 'culture', x: 26, y: 65, capacity: 100, shade: 0.82, tags: ['古寺', '文化', '安静'] },
    { id: 'juxianzhuang', name: '聚贤庄', type: 'culture', x: 61, y: 77, capacity: 130, shade: 0.52, tags: ['街巷', '互动', '美食'] }
  ],
  edges: [
    ['gate', 'southgate', 520, 6, 0.62], ['gate', 'market', 410, 5, 0.4], ['southgate', 'temple', 360, 5, 0.72],
    ['temple', 'lake', 420, 6, 0.78], ['lake', 'longtan', 350, 5, 0.8], ['lake', 'market', 330, 5, 0.48],
    ['longtan', 'museum', 290, 4, 0.82], ['market', 'rest', 300, 4, 0.56], ['museum', 'rest', 380, 5, 0.84],
    ['museum', 'theater', 440, 6, 0.9], ['rest', 'forest', 520, 8, 0.76], ['rest', 'juxianzhuang', 310, 5, 0.58],
    ['juxianzhuang', 'shizipo', 360, 5, 0.45], ['shizipo', 'summit', 420, 7, 0.28], ['market', 'summit', 640, 10, 0.22],
    ['rest', 'summit', 480, 8, 0.32], ['forest', 'theater', 300, 5, 0.92], ['forest', 'shizipo', 300, 5, 0.64],
    ['forest', 'summit', 360, 6, 0.38], ['temple', 'market', 430, 7, 0.5]
  ]
};

let state = {
  minute: 10 * 60 + 18,
  weather: { label: '晴间多云', temp: 27, uv: 6, rain: 0.08 },
  crowd: { gate: 0.24, southgate: 0.18, lake: 0.41, market: 0.62, museum: 0.35, longtan: 0.29, forest: 0.28, theater: 0.76, shizipo: 0.64, summit: 0.58, rest: 0.32, temple: 0.25, juxianzhuang: 0.48 },
  queues: { lake: 4, market: 6, museum: 12, forest: 3, theater: 22, summit: 8, rest: 0, longtan: 4, shizipo: 15, temple: 2, juxianzhuang: 8, southgate: 0 },
  events: [
    { id: 'show-1', title: '沉浸剧场 · 第二场', at: '11:20', node: 'theater', status: 'upcoming', capacity: 180 },
    { id: 'market-peak', title: '非遗市集客流高峰', at: '11:35', node: 'market', status: 'forecast', capacity: 220 }
  ],
  user: { location: 'gate', remainingMinutes: 272, visited: [], walked: 0, load: 0.12, preference: null },
  feedback: []
};

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

const defaultPreference = { time: 0.27, interest: 0.24, comfort: 0.2, freedom: 0.15, culture: 0.14 };

// 轻量化图世界模型：不直接替代规划器，而是把景区图、环境状态和游客状态
// 压缩成低维 latent state，再滚动预测未来的通行、排队与舒适负荷。
// 真实部署时可将这里的确定性更新替换为 GNN + GRU / RSSM 推理服务。
function lightWorldModel(horizon = 60) {
  const ids = Object.keys(state.crowd);
  const meanCrowd = ids.reduce((sum, id) => sum + state.crowd[id], 0) / Math.max(1, ids.length);
  const meanQueue = ids.reduce((sum, id) => sum + (state.queues[id] || 0), 0) / Math.max(1, ids.length);
  const eventNodes = state.events.filter(e => e.status === 'live' || e.status === 'upcoming').map(e => e.node);
  const eventPressure = eventNodes.reduce((sum, id) => sum + (state.crowd[id] || 0), 0) / Math.max(1, eventNodes.length);
  const envLatent = [meanCrowd, Math.min(1, meanQueue / 25), state.weather.rain, eventPressure, state.weather.uv / 10].map(v => Math.round(v * 100) / 100);
  const userLatent = [state.user.load, Math.min(1, state.user.walked / 5000), Math.min(1, state.user.remainingMinutes / 360), state.user.visited.length / Math.max(1, graph.nodes.length - 2)].map(v => Math.round(v * 100) / 100);
  const points = [15, 30, 60].map(offset => {
    const wave = Math.sin((state.minute + offset) / 28) * 0.025;
    const event = offset > 30 ? eventPressure * 0.08 : eventPressure * 0.03;
    const crowd = Math.min(0.98, Math.max(0.05, meanCrowd + wave + event));
    const queue = Math.max(0, Math.round((meanQueue + crowd * offset / 90) * 10) / 10);
    const load = Math.min(0.98, Math.max(0.04, state.user.load + offset / 360 * 0.12 + meanCrowd * 0.04));
    const confidence = Math.max(0.62, 0.95 - offset / 420 - Math.abs(eventPressure - meanCrowd) * 0.2);
    return { offset, label: `+${offset} min`, crowd: Math.round(crowd * 100), queue, load: Math.round(load * 100), confidence: Math.round(confidence * 100) };
  });
  const crowdLabel = meanCrowd > .68 ? '多点拥挤' : meanCrowd > .42 ? '局部繁忙' : '人流稳定';
  const loadLabel = state.user.load > .7 ? '负荷偏高' : state.user.load > .42 ? '建议安排休息' : '舒适';
  return {
    model: 'Light Scenic Graph World Model',
    version: 'LSGWM-0.3',
    latent: { env: envLatent, user: userLatent },
    state: { environment: crowdLabel, user: loadLabel },
    horizon: points,
    uncertainty: Math.round((1 - points[2].confidence / 100) * 100),
    updatedAt: new Date().toISOString()
  };
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function node(id) { return graph.nodes.find(n => n.id === id); }

function neighbours(id) {
  return graph.edges.flatMap(([a, b, distance, minutes, shade]) => {
    if (a === id) return [{ id: b, distance, minutes, shade }];
    if (b === id) return [{ id: a, distance, minutes, shade }];
    return [];
  });
}

function edge(a, b) {
  const hit = graph.edges.find(e => (e[0] === a && e[1] === b) || (e[0] === b && e[1] === a));
  return hit ? { distance: hit[2], minutes: hit[3], shade: hit[4] } : { distance: 0, minutes: 0, shade: 0.5 };
}

function pathBetween(start, goal) {
  const best = { [start]: { cost: 0, path: [start], distance: 0, minutes: 0 } };
  const open = [start];
  while (open.length) {
    open.sort((a, b) => best[a].cost - best[b].cost);
    const current = open.shift();
    if (current === goal) return best[current];
    for (const next of neighbours(current)) {
      const crowdPenalty = state.crowd[next.id] * 2.2;
      const cost = best[current].cost + next.minutes + crowdPenalty;
      if (!best[next.id] || cost < best[next.id].cost) {
        best[next.id] = { cost, path: [...best[current].path, next.id], distance: best[current].distance + next.distance, minutes: best[current].minutes + next.minutes };
        open.push(next.id);
      }
    }
  }
  return { cost: 99, path: [start], distance: 0, minutes: 0 };
}

function inferPreference(answers = {}) {
  const p = { ...defaultPreference };
  const bump = (key, amount) => { p[key] += amount; };
  if (answers.time === 'urgent') { bump('time', 0.2); bump('comfort', -0.04); }
  if (answers.time === 'normal') { bump('interest', 0.06); bump('comfort', 0.04); }
  if (answers.time === 'free') { bump('freedom', 0.2); bump('interest', 0.09); }
  if (answers.crowd === 'avoid') { bump('comfort', 0.17); bump('time', 0.04); }
  if (answers.crowd === 'accept') { bump('interest', 0.08); bump('freedom', 0.05); }
  if (answers.sun === 'shade') bump('comfort', 0.15);
  if (answers.sun === 'sun-ok') bump('interest', 0.08);
  if (answers.content === 'culture') bump('culture', 0.2);
  if (answers.content === 'nature') { bump('interest', 0.12); bump('freedom', 0.08); }
  if (answers.rest === 'often') bump('comfort', 0.12);
  if (answers.rest === 'rarely') bump('time', 0.06);
  const sum = Object.values(p).reduce((a, b) => a + Math.max(0.02, b), 0);
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Math.round(Math.max(0.02, v) / sum * 100) / 100]));
}

function scoreRoute(route, preference) {
  const poiNodes = route.stops.map(id => node(id));
  const interest = poiNodes.reduce((sum, n) => sum + (n.type === 'show' ? 0.95 : n.type === 'culture' ? 0.78 : n.type === 'view' ? 0.82 : 0.67), 0) / Math.max(1, poiNodes.length);
  const comfort = poiNodes.reduce((sum, n) => sum + n.shade, 0) / Math.max(1, poiNodes.length);
  const freedom = route.stops.filter(id => ['lake', 'forest', 'summit'].includes(id)).length / Math.max(1, poiNodes.length);
  const culture = poiNodes.filter(n => n.type === 'culture' || n.type === 'show').length / Math.max(1, poiNodes.length);
  const timeScore = Math.max(0, 1 - route.minutes / Math.max(1, state.user.remainingMinutes));
  const queue = route.stops.reduce((s, id) => s + (state.queues[id] || 0), 0);
  const crowd = route.stops.reduce((s, id) => s + (state.crowd[id] || 0), 0) / Math.max(1, route.stops.length);
  const utility = preference.time * timeScore + preference.interest * interest + preference.comfort * comfort + preference.freedom * freedom + preference.culture * culture - queue / 150 - crowd * 0.08;
  return { ...route, utility: Math.round(utility * 1000) / 10, queue, crowd: Math.round(crowd * 100), interest: Math.round(interest * 100), comfort: Math.round(comfort * 100) };
}

function makeRoutes(preference = state.user.preference || defaultPreference) {
  const templates = [
    { id: 'efficiency', label: '效率偏', tone: 'cyan', stops: ['market', 'museum', 'theater'], reason: '优先锁定高价值项目，减少绕行和无效等待' },
    { id: 'balance', label: '均衡偏', tone: 'violet', stops: ['lake', 'museum', 'forest', 'theater'], reason: '在兴趣、舒适和项目完成之间取得平衡' },
    { id: 'experience', label: '体验偏', tone: 'amber', stops: ['lake', 'market', 'rest', 'forest', 'summit'], reason: '保留自由探索与自然体验，允许途中弹性调整' }
  ];
  return templates.map((t) => {
    let prev = state.user.location;
    let minutes = 0, distance = 0;
    const legs = t.stops.map(stop => { const p = pathBetween(prev, stop); prev = stop; minutes += p.minutes; distance += p.distance; return { from: p.path[0], to: stop, path: p.path, minutes: p.minutes, distance: p.distance }; });
    return scoreRoute({ ...t, minutes, distance, legs, eta: new Date(Date.now() + minutes * 60000).toISOString() }, preference);
  });
}

function forecast(horizon = 90) {
  const points = [];
  for (let i = 0; i <= horizon; i += 15) {
    const wave = Math.sin((state.minute + i) / 36) * 0.04;
    const eventBoost = i > 55 ? 0.1 : 0;
    points.push({ offset: i, label: i === 0 ? '现在' : `+${i}m`, crowd: Math.round(Math.min(0.98, Math.max(0.08, state.crowd.market + wave + eventBoost)) * 100), queue: Math.max(2, Math.round(state.queues.market + i / 22 + eventBoost * 15)), confidence: Math.round((0.94 - i / 800) * 100) });
  }
  return points;
}

function snapshot() {
  const routes = makeRoutes();
  return {
    project: { name: '景策万象', tagline: '轻量化世界模型驱动的景区全程自适应游览决策系统', version: 'demo v3.0' },
    time: { minute: state.minute, display: `${String(Math.floor(state.minute / 60)).padStart(2, '0')}:${String(state.minute % 60).padStart(2, '0')}` },
    weather: state.weather, graph, crowd: state.crowd, queues: state.queues, events: state.events, user: state.user, routes, forecast: forecast(), worldModel: lightWorldModel(), routeSeeds,
    companion: companionFacts[state.user.location] || companionFacts.museum,
    emergency: { rain: state.weather.rain, safe: true, closed: [], sos: false },
    metrics: { nodes: graph.nodes.length, edges: graph.edges.length, confidence: 91, responseMs: 84, coverage: 87 }
  };
}

function updateEnvironment() {
  state.minute += 1;
  for (const id of Object.keys(state.crowd)) {
    const drift = (Math.random() - 0.48) * 0.035;
    state.crowd[id] = Math.round(Math.min(0.98, Math.max(0.06, state.crowd[id] + drift)) * 100) / 100;
    if (state.queues[id] !== undefined) state.queues[id] = Math.max(0, Math.round((state.queues[id] + state.crowd[id] * 0.5 - 0.25) * 10) / 10);
  }
}

setInterval(updateEnvironment, 12000);

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/snapshot') return json(res, 200, snapshot());
  if (req.method === 'GET' && url.pathname === '/api/pois') return json(res, 200, { nodes: graph.nodes, edges: graph.edges });
  if (req.method === 'GET' && url.pathname === '/api/forecast') return json(res, 200, { forecast: forecast(Number(url.searchParams.get('horizon') || 90)) });
  if (req.method === 'GET' && url.pathname === '/api/world-model') return json(res, 200, lightWorldModel(Number(url.searchParams.get('horizon') || 60)));
  if (req.method === 'GET' && url.pathname === '/api/navigation') {
    const from = url.searchParams.get('from') || state.user.location;
    const to = url.searchParams.get('to') || 'museum';
    const p = pathBetween(from, to);
    const segments = p.path.slice(0, -1).map((id, i) => {
      const next = p.path[i + 1]; const e = edge(id, next); const n = node(next);
      const crowd = state.crowd[next] || .2;
      const slope = Math.round(Math.abs(node(id).y - n.y) / 9);
      const chairs = e.shade > .7 ? Math.round(4 + e.shade * 5) : e.shade > .45 ? 2 : 1;
      return { from: node(id).name, to: n.name, distance: e.distance, minutes: e.minutes, shade: Math.round(e.shade * 100), chairs, slope, crowd: Math.round(crowd * 100), event: state.events.some(x => x.node === next && (x.status === 'live' || x.status === 'upcoming')), warning: crowd > .67 ? '人流较高' : e.shade < .35 ? '部分暴晒' : slope >= 5 ? '坡度变化' : '通行顺畅' };
    });
    return json(res, 200, { from, to, path: p.path, totalMinutes: p.minutes, totalDistance: p.distance, segments, model: lightWorldModel() });
  }
  if (req.method === 'GET' && url.pathname === '/api/route-dna') return json(res, 200, { seeds: routeSeeds });
  if (req.method === 'GET' && url.pathname === '/api/companion') return json(res, 200, { companion: companionFacts[state.user.location] || companionFacts.museum });
  if (req.method === 'POST' && url.pathname === '/api/preferences') {
    const body = await readBody(req); const preference = inferPreference(body.answers || {}); state.user.preference = preference;
    if (body.leaveAt && /^\d{2}:\d{2}$/.test(body.leaveAt)) { const [h, m] = body.leaveAt.split(':').map(Number); const leave = h * 60 + m; const now = state.minute % (24 * 60); state.user.remainingMinutes = Math.max(30, leave >= now ? leave - now : leave + 24 * 60 - now); }
    return json(res, 200, { preference, routes: makeRoutes(preference), model: lightWorldModel(), user: state.user });
  }
  if (req.method === 'POST' && url.pathname === '/api/replan') {
    const body = await readBody(req);
    if (body.location && node(body.location)) state.user.location = body.location;
    if (body.load !== undefined) state.user.load = Math.min(1, Math.max(0, Number(body.load)));
    updateEnvironment();
    return json(res, 200, { routes: makeRoutes(state.user.preference || defaultPreference), forecast: forecast(), model: lightWorldModel(), user: state.user, crowd: state.crowd, queues: state.queues, updatedAt: new Date().toISOString() });
  }
  if (req.method === 'POST' && url.pathname === '/api/companion') {
    const body = await readBody(req); const fact = companionFacts[body.location || state.user.location] || companionFacts.museum;
    const answer = body.question ? `结合你现在的位置和行程，我建议先关注“${fact.name}”的核心体验。${fact.fact}` : fact.fact;
    return json(res, 200, { answer, source: '景区知识库 · 已定位到当前景点', companion: fact });
  }
  if (req.method === 'POST' && url.pathname === '/api/dna/clone') {
    const body = await readBody(req); const source = routeSeeds.find(x => x.id === body.id) || routeSeeds[0]; const preference = state.user.preference || defaultPreference;
    const cloned = makeRoutes(preference)[preference.freedom > preference.time ? 2 : 1];
    return json(res, 200, { source, route: { ...cloned, title: `${source.title} · 个性化变异`, dna: `#${source.id}-M${Math.floor(Math.random() * 900 + 100)}` } });
  }
  if (req.method === 'POST' && url.pathname === '/api/emergency') {
    const body = await readBody(req); const type = body.type || 'rain';
    return json(res, 200, { ok: true, emergency: type === 'sos' ? { sos: true, message: 'SOS 已发送至景区服务中心，系统正在共享你的授权位置' } : { rain: true, safe: false, message: '已切换至应急规划：优先推荐最近的室内与避雨节点' } });
  }
  if (req.method === 'POST' && url.pathname === '/api/feedback') {
    const body = await readBody(req); state.feedback.push({ ...body, at: new Date().toISOString() });
    if (body.load !== undefined) state.user.load = Math.min(1, Math.max(0, Number(body.load)));
    return json(res, 200, { ok: true, feedbackCount: state.feedback.length, user: state.user });
  }
  if (req.method === 'POST' && url.pathname === '/api/simulate-event') {
    const body = await readBody(req); const id = body.node || 'market'; state.crowd[id] = Math.min(0.98, state.crowd[id] + Number(body.delta || 0.16)); state.queues[id] = Math.round((state.queues[id] + Number(body.queueDelta || 6)) * 10) / 10;
    state.events.unshift({ id: `event-${Date.now()}`, title: body.title || '现场事件：人流快速聚集', at: '刚刚', node: id, status: 'live', capacity: node(id)?.capacity || 100 });
    return json(res, 200, { ok: true, ...snapshot() });
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
  if (url.pathname.startsWith('/api/')) api(req, res, url).catch(err => json(res, 500, { error: err.message }));
  else if (req.method === 'GET') serve(req, res);
  else json(res, 405, { error: 'Method not allowed' });
});

function startServer(port) {
  let settled = false;
  const onError = (err) => {
    if (settled) return;
    settled = true;
    server.removeListener('error', onError);
    if (err.code === 'EADDRINUSE' && !process.env.PORT && port < PORT + 20) {
      console.warn(`端口 ${port} 已被占用，自动尝试 ${port + 1}`);
      try {
        server.close(() => startServer(port + 1));
      } catch (_) {
        startServer(port + 1);
      }
      return;
    }
    console.error(`无法启动景策万象服务（端口 ${port}）：${err.message}`);
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

startServer(PORT);
