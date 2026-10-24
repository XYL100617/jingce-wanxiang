const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const app = { data: null, scenicGraph: null, scenicState: null, forecast: null, answers: { interests: [], group: 'solo', mobility: 'normal' }, selectedSeed: null, selectedCompanion: null, map: null, mapLayers: [], routeLayer: null, mapMode: 'base', planResult: null, activePlan: null, tripMode: 'overview', tripStopIndex: 0, cMapMode: '2.5d' };
const SCENIC_CENTER = [34.82065, 114.34426];
const surveyTypes = [['fast', '时间紧迫型', '优先完成高价值项目，减少等待和绕行'], ['normal', '从容均衡型', '兼顾文化、自然、舒适与项目完成度'], ['free', '自由探索型', '保留临场选择，愿意为独特体验绕行']];
const surveyGroups = [['solo', '独自游览'], ['friends', '朋友同行'], ['family', '亲子家庭'], ['elderly', '与长者同行']];
const mobilityOptions = [['normal', '步行正常'], ['light', '希望少走'], ['minimal', '尽量少走']];
const interestOptions = [['culture', '历史文化'], ['nature', '自然景观'], ['performance', '演艺活动'], ['food', '美食市集'], ['photo', '摄影打卡'], ['interactive', '互动体验']];
const scaleQuestions = [
  ['queue_tolerance', '排队取舍', '尽量不排队', '可为好项目等待'],
  ['walking_tolerance', '步行取舍', '少走更重要', '愿意为体验多走'],
  ['schedule_preference', '行程结构', '随走随看', '按时间表执行'],
  ['depth_preference', '体验深度', '多看几个点', '少而深入'],
  ['crowd_sensitivity', '人流敏感', '热闹也可以', '更喜欢清静'],
  ['novelty_preference', '探索倾向', '经典必看', '小众新鲜'],
  ['rest_need', '休息需求', '连续游览', '需要频繁休息'],
  ['photo_preference', '拍照需求', '记录即可', '专门寻找机位']
];
const companions = [['小明', '专业导游', '讲清景点脉络与历史背景', 'p1'], ['小红', '美食达人', '沿路线发现本地美食与市集', 'p2'], ['小李', '摄影大师', '根据光照、人流和构图推荐机位', 'p3'], ['小王', '户外探险家', '探索低密度道路与自然节点', 'p4'], ['小五', '故事讲述者', '用故事串联景区中的细节', 'p5']];
async function api(url, opt = {}) { const r = await fetch(url, opt); let body; try { body = await r.json(); } catch (_) { body = {}; } if (!r.ok) throw new Error(body.error || `请求失败（${r.status}）`); return body; }
let accountRegisterMode = false;
function renderAccount(response) {
  app.account = response.user;
  app.accountProfile = response.profile;
  const user = response.user;
  document.body.dataset.accountRole = user.role;
  $('#accountName').textContent = user.displayName;
  $('#accountAvatar').textContent = user.displayName.slice(0, 1);
  $('#profileAvatar').textContent = user.displayName.slice(0, 1);
  $('#profileName').textContent = user.displayName;
  $('#profileRole').textContent = user.role === 'manager' ? '景区管理员 · 可管理景区状态' : user.role === 'visitor' ? `游客账号 · ${user.username}` : '未登录 · 仅临时体验';
  $('#profileRoleShort').textContent = user.role === 'manager' ? '管理者' : user.role === 'visitor' ? '游客' : '访客';
  $('#profileRouteCount').textContent = response.profile?.routeHistory?.length || 0;
  $('#profileConsentCount').textContent = Object.values(response.profile?.consent || {}).filter(Boolean).length;
  $('#accountForm').hidden = user.role !== 'guest';
  $('#profileSettings').hidden = user.role === 'guest';
  $('#accountLogout').hidden = user.role === 'guest';
  $('#managerPanel').hidden = user.role !== 'manager';
  if (response.profile) {
    $('#profileDisplayName').value = response.profile.displayName;
    $('#consentLocation').checked = response.profile.consent.location;
    $('#consentFeedback').checked = response.profile.consent.feedback;
    $('#consentSharing').checked = response.profile.consent.sharing;
  }
  const routes = response.profile?.routeHistory || [];
  $('#accountRoutes').innerHTML = '';
  if (!routes.length) $('#accountRoutes').textContent = user.role === 'guest' ? '登录后显示已保存的路线。' : '还没有保存的路线；生成个性化路线后会自动记录。';
  else routes.forEach(route => {
    const row = document.createElement('div'); row.className = 'account-history-row';
    const title = document.createElement('b'); title.textContent = new Date(route.createdAt).toLocaleString('zh-CN');
    const stops = document.createElement('small'); stops.textContent = route.stops.join(' → ') || '当前条件下无可行路线';
    row.append(title, stops); $('#accountRoutes').append(row);
  });
}
async function refreshAccount() { renderAccount(await api('/api/account/me')); }
async function submitAccount(event) {
  event.preventDefault();
  try {
    const payload = { username: $('#accountUsername').value, password: $('#accountPassword').value };
    if (accountRegisterMode) payload.displayName = $('#accountDisplayName').value;
    renderAccount(await api(accountRegisterMode ? '/api/account/register' : '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
    $('#accountPassword').value = '';
    toast(accountRegisterMode ? '账号已创建并登录' : '已登录');
  } catch (error) { toast(error.message); }
}
async function saveAccountProfile() {
  try {
    const result = await api('/api/account/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: $('#profileDisplayName').value, consent: { location: $('#consentLocation').checked, feedback: $('#consentFeedback').checked, sharing: $('#consentSharing').checked } }) });
    renderAccount({ user: result.profile, profile: result.profile });
    toast('个人资料与授权已保存');
  } catch (error) { toast(error.message); }
}
function toast(msg) { const t = $('#toast'); if (!t) return; $('.toast span', t).textContent = msg; t.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2600); }
function go(view) { $$('.view').forEach(x => x.classList.toggle('active', x.id === `view-${view}`)); $$('.nav').forEach(x => x.classList.toggle('active', x.dataset.view === view)); if (view === 'navigation') { $('#view-navigation')?.classList.toggle('is-guiding', app.tripMode === 'guiding'); loadNav().then(() => { if (app.tripMode === 'guiding' && app.activePlan) focusTripStop(app.tripStopIndex); }); } if (view === 'dna') renderDna(); if (view === 'companion') renderCompanions(); }
function nodeLatLng(n) { return [SCENIC_CENTER[0] + (50 - n.y) * 0.00034, SCENIC_CENTER[1] + (n.x - 50) * 0.00043]; }
function initLeafletMap() { const el = $('#navMap'); if (!el || app.map) return; if (!window.L) { el.innerHTML = '<div class="map-fallback">真实地图图层正在加载，请检查网络连接<br/><small>当前中心：景区步行图适配区</small></div>'; return; } app.map = L.map(el, { zoomControl: false, attributionControl: false }).setView(SCENIC_CENTER, 16); app.map.baseLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, attribution: '© OpenStreetMap contributors' }).addTo(app.map); $('#mapZoomIn').onclick = () => app.map.zoomIn(); $('#mapZoomOut').onclick = () => app.map.zoomOut(); $('#mapLocate').onclick = () => { app.map.setView(SCENIC_CENTER, 17); toast('已回到景区核心区域'); }; setTimeout(() => app.map.invalidateSize(), 160); }
function mountCMap() {
  const container = $('#navMap')?.parentElement; if (!container || !window.CScenicMap || $('#cMapSurface')) return;
  container.insertAdjacentHTML('afterbegin', '<svg id="cMapSurface" aria-label="景区2.5D分层步行导航地图"></svg><div class="walking-nav-hud" id="walkingNavHud"><div class="walking-turn">↱</div><div><small>步行导航 · 下一步</small><b id="walkingInstruction">沿主游览步道前行</b><span id="walkingDistance">正在计算路线</span></div></div><div class="walking-nav-sheet"><div><small>剩余路程</small><b id="walkingRemain">-- m · -- min</b></div><div><small>目的地</small><b id="walkingDestination">请选择景点</b></div><button id="walkingRecenter" aria-label="重新聚焦当前路线">◎</button></div><div class="c-poi-detail" id="cPoiDetail" hidden></div>');
  const accuracyNote = $('.map-attribution');
  if (accuracyNote) accuracyNote.textContent = '示意路网 · 道路位置与距离未实地测绘，不能用于精准现场导航';
  $('.map-toolbar')?.insertAdjacentElement('afterend', $('#walkingNavHud'));
  $('.map-toolbar')?.insertAdjacentHTML('afterend', '<div class="c-layerbar"><button class="active" data-c-layer="terrain">地形与分区</button><button class="active" data-c-layer="buildings">模拟建筑</button><button class="active" data-c-layer="roads">规划路网</button><button data-c-layer="referencePaths" title="来源图中的补充小路，仅供辨认，不参与路线规划">参考小路</button><button class="active" data-c-layer="service">服务车行路</button><button class="active" data-c-layer="poi">景点标签</button><button class="active" data-c-layer="heat">排队热度</button><button class="active" data-c-layer="events">演出演示</button><button class="active" data-c-layer="route">推荐路线</button><button class="active" data-c-layer="navigation">当前路段</button><button class="active" data-c-layer="visitor">游客位置</button><button class="c-map-mode" id="cMapMode">切换至 OSM 参考底图</button></div>');
  $('.planner-event-controls')?.insertAdjacentHTML('afterbegin', '<span class="planner-event-selection" id="plannerEventSelection">先点选地图上的景点或道路，再执行对应事件</span>');
  container.insertAdjacentHTML('afterend', '<div class="c-map-legend"><span><i></i>主游览步道</span><span><i class="legend-walk"></i>普通步道</span><span><i class="legend-service"></i>园区服务路（模拟）</span><span><i class="legend-route"></i>当前推荐路线</span><span><i class="legend-heat"></i>排队热度</span></div>');
  window.CScenicMap.mount('#cMapSurface', { onPoiClick: (node, status) => {
    const detail = $('#cPoiDetail'); if (!detail) return;
    detail.hidden = false; detail.innerHTML = `<b>${node.name}</b><span>当前排队 ${Math.round(Number(status.queue_min || 0))} 分钟 · 预计 ${status.forecast?.timestamp ? `${status.forecast.timestamp.slice(11,16)} ` : ''}排队 ${Math.round(Number(status.forecast?.queue_min ?? status.queue_min ?? 0))} 分钟</span><span>${status.open === false ? '当前暂停开放' : '当前开放'} · 区域 ${node.area_id || '园区主区'}</span>${status.event ? `<span>${status.event.title} · ${status.event.start_time || ''} · 最晚入场 ${status.event.latest_entry_time || '未提供'}</span>` : ''}<button id="cPoiNavigate">导航到这里</button>`;
    if ($('#navTo')?.querySelector(`option[value="${node.node_id}"]`)) $('#navTo').value = node.node_id;
    $('#cPoiNavigate').onclick = async () => { try { window.CScenicMap.emitEvent('MAP_REPLAN_REQUEST', node.node_id, 'node_id'); const planned = await api('/api/b/demo-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: { event_type: 'REQUEST_REPLAN' } }) }); app.data = planned; if (planned.planResult) renderItinerary(planned.planResult); if ($('#navTo')?.querySelector(`option[value="${node.node_id}"]`)) $('#navTo').value = node.node_id; await requestNav(); toast(`已记录地图选择，并由 B 模块从当前位置滚动重规划：${node.name}`); } catch (error) { toast(error.message); } };
  }});
  $$('[data-c-layer]').forEach(button => button.onclick = () => { const on = button.classList.toggle('active'); window.CScenicMap.toggleLayer(button.dataset.cLayer, on); });
  $('#cMapMode').onclick = () => { const mapBox = $('.map-container'), svg = $('#cMapSurface'), leaflet = $('#navMap'); const osm = mapBox.classList.toggle('is-osm'); app.cMapMode = osm ? 'osm' : '2.5d'; svg.classList.toggle('is-osm', osm); leaflet.classList.toggle('is-hidden', !osm); $('#cMapMode').textContent = osm ? '切换至 2.5D 分层图' : '切换至 OSM 参考底图'; if (osm && app.map) setTimeout(() => app.map.invalidateSize(), 80); };
  if ($('#mapZoomIn')) $('#mapZoomIn').onclick = () => app.cMapMode === '2.5d' ? window.CScenicMap.zoomIn() : app.map?.zoomIn();
  if ($('#mapZoomOut')) $('#mapZoomOut').onclick = () => app.cMapMode === '2.5d' ? window.CScenicMap.zoomOut() : app.map?.zoomOut();
  if ($('#mapLocate')) $('#mapLocate').onclick = () => app.cMapMode === '2.5d' ? window.CScenicMap.locate() : app.map?.setView(SCENIC_CENTER, 17);
  if ($('#walkingRecenter')) $('#walkingRecenter').onclick = () => app.cMapMode === '2.5d' ? window.CScenicMap.updateNavigation(app.lastNavigation) : app.map?.setView(SCENIC_CENTER, 17);
  window.addEventListener('scenic-user-event', async event => { window.lastScenicUserEvent = event.detail; const selected = $('#plannerEventSelection'); if (selected && event.detail.event_type === 'ROAD_CLICK') selected.textContent = `已选道路 ${event.detail.edge_id} · 可封闭或恢复`; if (selected && event.detail.event_type === 'POI_CLICK') selected.textContent = `已选景点 ${event.detail.target_id} · 可关闭或模拟排队`; try { await api('/api/c/user-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: event.detail }) }); if (event.detail.event_type === 'POI_CLICK' || event.detail.event_type === 'ROAD_CLICK') toast(`已选择地图目标 ${event.detail.target_id || event.detail.edge_id}`); } catch (error) { toast(`地图事件未送达：${error.message}`); } });
}
async function loadScenicContext() {
  const [graph, state, forecast] = await Promise.all([
    api('/api/v1/scenic-graph'), api('/api/v1/state'), api('/api/v1/environment-forecast?horizon=60&step=10')
  ]);
  const graphWasLoaded = Boolean(app.scenicGraph);
  app.scenicGraph = graph; app.scenicState = state; app.forecast = forecast;
  if ($('#tripMap')?.tagName !== 'CANVAS') window.ScenicOverviewMap?.draw('#tripMap', graph);
  if (window.CScenicMap) {
    if (graphWasLoaded) window.CScenicMap.updateState(state, forecast);
    else window.CScenicMap.update({ graph, state, forecast, plan: app.activePlan });
    if (app.activePlan) window.CScenicMap.updatePlan(app.activePlan);
  }
}
function clearMapLayers() { app.mapLayers.forEach(x => x.remove()); app.mapLayers = []; if (app.routeLayer) { app.routeLayer.remove(); app.routeLayer = null; } }
function drawMap(mode = app.mapMode) { if (!app.data) return; initLeafletMap(); if (!app.map) return; app.mapMode = mode; clearMapLayers(); const pos = Object.fromEntries(app.data.graph.nodes.map(n => [n.id, n])); app.data.graph.edges.forEach(([a, b]) => { const e = app.data.graph.edges.find(x => (x[0] === a && x[1] === b) || (x[0] === b && x[1] === a)); const color = mode === 'comfort' ? (e[4] > .72 ? '#39aa87' : e[4] > .45 ? '#e2a54b' : '#d86d5e') : '#538f92'; const line = L.polyline([nodeLatLng(pos[a]), nodeLatLng(pos[b])], { color, weight: mode === 'base' ? 4 : 6, opacity: .72, dashArray: mode === 'base' ? '6 6' : null }).addTo(app.map); app.mapLayers.push(line); }); app.data.graph.nodes.forEach(n => { const crowd = app.data.crowd[n.id] || .2; const event = app.data.events.some(x => x.node === n.id && (x.status === 'live' || x.status === 'upcoming')); const color = mode === 'comfort' ? (n.shade > .72 ? '#36a970' : n.shade > .45 ? '#e1a03e' : '#ce574d') : (crowd < .38 ? '#36a970' : crowd < .65 ? '#e1a03e' : '#ce574d'); const marker = L.circleMarker(nodeLatLng(n), { radius: n.type === 'gate' ? 8 : 10, color: '#fff', weight: 2, fillColor: color, fillOpacity: .95 }).bindPopup(`<b>${n.name}</b><br/>实时人流 ${Math.round(crowd * 100)}%<br/>遮阴 ${Math.round(n.shade * 100)}%<br/>${n.tags.join(' · ')}`).addTo(app.map); app.mapLayers.push(marker); if (mode === 'crowd' && crowd > .58) { const heat = L.circle(nodeLatLng(n), { radius: 80 + crowd * 140, color: '#e47b5c', weight: 1, fillColor: '#e47b5c', fillOpacity: .14 }).addTo(app.map); app.mapLayers.push(heat); } if (event) { const eventMarker = L.circleMarker(nodeLatLng(n), { radius: 15, color: '#9b68e7', weight: 2, fill: false, dashArray: '3 3' }).bindTooltip('事件节点').addTo(app.map); app.mapLayers.push(eventMarker); } }); $('#mapLayerState').textContent = mode === 'crowd' ? '人流热力' : mode === 'comfort' ? '舒适度' : '综合态势'; $('#mapUpdatedAt').textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); app.map.invalidateSize(); }
function setMapTheme(mode = 'base') { app.mapMode = mode; window.CScenicMap?.setTheme(mode); drawMap(mode); if ($('#mapLayerState')) $('#mapLayerState').textContent = mode === 'crowd' ? '人流热力图' : mode === 'comfort' ? '遮阴舒适度图' : '综合导航底图'; if ($('#mapUpdatedAt')) $('#mapUpdatedAt').textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function drawChart() { const s = $('#homeChart'); if (!s || !app.data) return; const points = Object.values(app.data.crowd).map((v, i) => `${i / 12 * 100},${28 - v * 22}`).join(' '); s.innerHTML = `<polyline points="${points}"/>`; }
function renderModel(model = app.data?.worldModel) { if (!model) return; if ($('#modelEnvState')) $('#modelEnvState').textContent = model.state.environment; if ($('#modelUserState')) $('#modelUserState').textContent = model.state.user; if ($('#modelConfidence')) $('#modelConfidence').textContent = `${model.horizon?.[0]?.confidence || 91}%`; if ($('#homeForecast')) $('#homeForecast').innerHTML = (model.horizon || []).map(x => `<span><b>${x.label}</b><small>人流 ${x.crowd}% · 置信 ${x.confidence}%</small></span>`).join(''); }
function renderVector(p) { const weights = p && typeof p === 'object' ? p : { time: .18, interest: .16, comfort: .16, freedom: .12, culture: .11, nature: .1, performance: .09, food: .08 }; const names = { time: '时间效率', interest: '综合兴趣', comfort: '舒适负荷', freedom: '自由探索', culture: '历史文化', nature: '自然景观', performance: '演艺活动', food: '美食市集' }; const el = $('#preferenceVector'); if (!el) return; el.innerHTML = Object.entries(names).sort((a, b) => (weights[b[0]] || 0) - (weights[a[0]] || 0)).map(([k, v]) => `<div class="vector-row"><div class="vector-head"><span>${v}</span><b>${Math.round((weights[k] || 0) * 100)}%</b></div><div class="vector-track"><i style="width:${Math.round((weights[k] || 0) * 100)}%"></i></div></div>`).join(''); }
function renderPreferenceProfile(profile) { if (!profile) return; if ($('#weightState')) $('#weightState').textContent = `可信度 ${profile.profile.confidence}%`; if ($('#preferenceSummary')) $('#preferenceSummary').innerHTML = `<b>主要倾向：${profile.profile.top_factors.map(key => profile.labels[key]).join('、')}</b><span>单段步行 ≤ ${profile.constraints.max_walk_per_leg_min} 分钟 · 排队 ≤ ${profile.constraints.max_queue_min} 分钟${profile.constraints.require_rest ? ' · 建议安排休息' : ''}</span><small>权重已直接进入每个候选动作的效用评分，不只是展示标签。</small>`; }
function surveyCompletion() { const scales = scaleQuestions.filter(([key]) => app.answers[key] !== undefined).length; const score = (app.answers.type ? 15 : 0) + (app.answers.group ? 5 : 0) + (app.answers.mobility ? 5 : 0) + (app.answers.interests.length ? 10 : 0) + Math.round(scales / scaleQuestions.length * 65); return Math.min(100, score); }
function updateSurveyProgress() { const value = surveyCompletion(); if ($('#surveyProgressText')) $('#surveyProgressText').textContent = `已完成 ${value}%`; if ($('#surveyProgressBar')) $('#surveyProgressBar').style.width = `${value}%`; }
function renderSurvey() {
  const t = $('#surveyType');
  t.innerHTML = surveyTypes.map(x => `<article class="type-option ${app.answers.type === x[0] ? 'selected' : ''}"><div class="type-mark">${x[0] === 'fast' ? '⚡' : x[0] === 'normal' ? '◐' : '✦'}</div><h4>${x[1]}</h4><p>${x[2]}</p><button data-type="${x[0]}">${app.answers.type === x[0] ? '已选择' : '选择'}</button></article>`).join('');
  $$('[data-type]').forEach(b => b.onclick = () => { app.answers.type = b.dataset.type; renderSurvey(); });
  $('#surveyContext').innerHTML = `<div><b>同行人群</b>${surveyGroups.map(x => `<button class="choice-chip ${app.answers.group === x[0] ? 'selected' : ''}" data-group="${x[0]}">${x[1]}</button>`).join('')}</div><div><b>步行能力</b>${mobilityOptions.map(x => `<button class="choice-chip ${app.answers.mobility === x[0] ? 'selected' : ''}" data-mobility="${x[0]}">${x[1]}</button>`).join('')}</div>`;
  $$('[data-group]').forEach(b => b.onclick = () => { app.answers.group = b.dataset.group; renderSurvey(); });
  $$('[data-mobility]').forEach(b => b.onclick = () => { app.answers.mobility = b.dataset.mobility; renderSurvey(); });
  $('#surveyInterests').innerHTML = interestOptions.map(x => `<button class="choice-chip ${app.answers.interests.includes(x[0]) ? 'selected' : ''}" data-interest="${x[0]}">${x[1]}</button>`).join('');
  $$('[data-interest]').forEach(b => b.onclick = () => { const key = b.dataset.interest; app.answers.interests = app.answers.interests.includes(key) ? app.answers.interests.filter(x => x !== key) : [...app.answers.interests, key]; renderSurvey(); });
  $('#surveyScales').innerHTML = scaleQuestions.map(([key, title, left, right]) => { const value = Number(app.answers[key] || 3); return `<label><span><b>${title}</b><em>${value}/5</em></span><div><small>${left}</small><input type="range" min="1" max="5" step="1" value="${value}" data-scale="${key}"/><small>${right}</small></div></label>`; }).join('');
  $$('[data-scale]').forEach(input => input.oninput = () => { app.answers[input.dataset.scale] = Number(input.value); input.closest('label').querySelector('em').textContent = `${input.value}/5`; updateSurveyProgress(); });
  const bottom = $('.survey-bottom');
  if (bottom && app.data?.graph?.nodes?.length && !$('#currentLocationSelect')) {
    bottom.insertAdjacentHTML('afterbegin', `<label class="current-location-field">当前所在位置<select id="currentLocationSelect">${app.data.graph.nodes.map(item => `<option value="${item.id}" ${item.id === app.data.user.location ? 'selected' : ''}>${item.name}</option>`).join('')}</select></label>`);
  }
  if (bottom && app.data?.graph?.nodes?.length && !$('#exitNodeSelect')) {
    const exits = app.data.graph.nodes.filter(item => item.type === 'gate');
    bottom.querySelector('.current-location-field')?.insertAdjacentHTML('afterend', `<label class="exit-location-field">离园出口 <small>选填</small><select id="exitNodeSelect"><option value="">由系统推荐</option>${exits.map(item => `<option value="${item.id}" ${item.id === app.data.user.preferredExitNodeId ? 'selected' : ''}>${item.name}</option>`).join('')}</select></label>`);
  }
  updateSurveyProgress();
}
function routeNodeName(id) { return app.data?.graph.nodes.find(n => n.id === id)?.name || id; }
function planTargetName(item) { return routeNodeName(item?.target_node_id || item?.target_id); }
function readablePlanReason(reason) { return String(reason || '').replace(/首选 ([a-z][a-z_0-9]*)/i, (_, id) => `首选 ${routeNodeName(id)}`); }
function overviewCanvasMode() { return $('#tripMap')?.tagName === 'CANVAS'; }
function setupOverviewMapInteractions() {
  const frame = document.querySelector('.trip-map-frame');
  if (!frame || frame.dataset.interactive === 'true') return;
  const mapGraphic = $('#tripMap'), overlay = $('#tripMapOverlay');
  if (!mapGraphic || !overlay) return;
  // SVG elements do not expose reliable offsetWidth/offsetLeft measurements.
  // A single HTML surface gives pan/zoom real dimensions and keeps the route
  // overlay locked to the illustration through the same transform.
  const mapSurface = document.createElement('div');
  mapSurface.className = 'trip-map-content';
  frame.insertBefore(mapSurface, mapGraphic);
  mapSurface.append(mapGraphic, overlay);
  frame.dataset.interactive = 'true';
  if (!frame.querySelector('.trip-map-compass')) {
    const compass = document.createElement('div');
    compass.className = 'trip-map-compass';
    compass.setAttribute('aria-label', '北方');
    compass.innerHTML = '<span aria-hidden="true">N</span><svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><circle class="trip-map-compass-ring" cx="24" cy="24" r="19"></circle><path class="trip-map-compass-needle trip-map-compass-north" d="M24 7 29 24 24 21 19 24Z"></path><path class="trip-map-compass-needle trip-map-compass-south" d="M24 41 19 24 24 27 29 24Z"></path><circle class="trip-map-compass-pivot" cx="24" cy="24" r="2.2"></circle></svg>';
    frame.append(compass);
  }
  const state = { scale: 1, x: 0, y: 0, dragging: false, pointerId: null, startX: 0, startY: 0, originX: 0, originY: 0, suppressClick: false };
  const tools = document.createElement('div');
  tools.className = 'trip-map-tools';
  tools.setAttribute('aria-label', '地图方向与缩放');
  const controls = document.createElement('div');
  controls.className = 'trip-map-controls';
  controls.setAttribute('aria-label', '手绘地图缩放控制');
  controls.innerHTML = '<button type="button" data-overview-action="reset" aria-label="回到全图" title="回到全图">◎</button><button type="button" data-overview-action="zoom-in" aria-label="放大地图" title="放大">＋</button><button type="button" data-overview-action="zoom-out" aria-label="缩小地图" title="缩小">－</button><button type="button" data-overview-action="toggle-reference" aria-pressed="false" aria-label="显示来源图参考小路" title="显示/隐藏参考小路">≋</button>';
  // Give the map a dedicated side rail: controls stay outside the clipped
  // artwork, with the compass above and zoom controls below.
  const compass = frame.querySelector('.trip-map-compass');
  const shell = document.createElement('div');
  shell.className = 'trip-map-shell';
  frame.before(shell);
  shell.append(frame, tools);
  if (compass) tools.append(compass);
  tools.append(controls);
  const clampPan = () => {
    const frameWidth = frame.clientWidth, frameHeight = frame.clientHeight;
    const scaledWidth = mapSurface.offsetWidth * state.scale, scaledHeight = mapSurface.offsetHeight * state.scale;
    const minX = Math.min(0, frameWidth - scaledWidth);
    const minY = Math.min(0, frameHeight - scaledHeight);
    const maxX = scaledWidth < frameWidth ? (frameWidth - scaledWidth) / 2 : 0;
    const maxY = scaledHeight < frameHeight ? (frameHeight - scaledHeight) / 2 : 0;
    state.x = Math.max(minX, Math.min(maxX, state.x));
    state.y = Math.max(minY, Math.min(maxY, state.y));
  };
  const minimumScale = () => Math.max(.1, Math.min(1,
    Math.max(1, frame.clientWidth) / Math.max(1, mapSurface.offsetWidth),
    Math.max(1, frame.clientHeight) / Math.max(1, mapSurface.offsetHeight)));
  const apply = () => {
    clampPan();
    const transform = `translate(${state.x}px,${state.y}px) scale(${state.scale})`;
    mapSurface.style.transform = transform;
    frame.classList.toggle('is-zoomed', state.scale > 1.01);
  };
  const zoom = (delta, clientX, clientY) => {
    const oldScale = state.scale;
    const minScale = minimumScale();
    const nextScale = Math.max(minScale, Math.min(2.8, Number((oldScale + delta).toFixed(2))));
    if (Math.abs(nextScale - oldScale) < .001) return;
    const rect = frame.getBoundingClientRect();
    const focusX = clientX == null ? rect.width / 2 : clientX - rect.left;
    const focusY = clientY == null ? rect.height / 2 : clientY - rect.top;
    const worldX = (focusX - state.x) / oldScale, worldY = (focusY - state.y) / oldScale;
    state.scale = nextScale;
    state.x = focusX - worldX * nextScale;
    state.y = focusY - worldY * nextScale;
    apply();
  };
  const runControlAction = (action, event) => {
    if (!action) return;
    event.preventDefault(); event.stopPropagation();
    if (action === 'zoom-in') zoom(.25);
    if (action === 'zoom-out') zoom(-.25);
    if (action === 'reset') { state.scale = minimumScale(); state.x = 0; state.y = 0; apply(); }
    if (action === 'toggle-reference') {
      const visible = frame.classList.toggle('show-reference-paths');
      const button = controls.querySelector('[data-overview-action="toggle-reference"]');
      button?.setAttribute('aria-pressed', String(visible));
      button?.setAttribute('title', visible ? '隐藏来源图参考小路' : '显示来源图参考小路');
      button?.classList.toggle('active', visible);
    }
  };
  controls.addEventListener('click', event => runControlAction(event.target.closest?.('[data-overview-action]')?.dataset.overviewAction, event), true);
  frame.addEventListener('wheel', event => { event.preventDefault(); zoom(event.deltaY < 0 ? .18 : -.18, event.clientX, event.clientY); }, { passive: false });
  const beginPan = (id, x, y) => {
    if (state.pointerId !== null) return;
    state.pointerId = id; state.dragging = false;
    state.startX = x; state.startY = y; state.originX = state.x; state.originY = state.y;
  };
  const movePan = (id, x, y, event) => {
    if (state.pointerId !== id) return;
    if (!state.dragging && Math.hypot(x - state.startX, y - state.startY) < 4) return;
    state.dragging = true; frame.classList.add('is-panning');
    if (event?.cancelable) event.preventDefault();
    state.x = state.originX + x - state.startX; state.y = state.originY + y - state.startY; apply();
  };
  const endPan = id => {
    if (state.pointerId !== id) return;
    if (state.dragging) {
      state.suppressClick = true;
      setTimeout(() => { state.suppressClick = false; }, 350);
    }
    state.pointerId = null; state.dragging = false; frame.classList.remove('is-panning');
  };
  // Mouse and touch listeners are intentionally used here instead of pointer
  // capture: the artwork is layered SVG with pointer-events disabled, and
  // window-level movement remains reliable when dragging beyond the frame.
  document.addEventListener('mousedown', event => {
    const targetFrame = event.target.closest?.('.trip-map-frame');
    if (targetFrame !== frame || event.target.closest?.('.trip-map-controls') || event.button !== 0) return;
    event.preventDefault(); beginPan('mouse', event.clientX, event.clientY);
  }, true);
  document.addEventListener('pointerdown', event => {
    const targetFrame = event.target.closest?.('.trip-map-frame');
    if (targetFrame !== frame || event.target.closest?.('.trip-map-controls') || (event.pointerType === 'mouse' && event.button !== 0)) return;
    beginPan(`pointer-${event.pointerId}`, event.clientX, event.clientY);
  }, true);
  window.addEventListener('pointermove', event => movePan(`pointer-${event.pointerId}`, event.clientX, event.clientY, event), { passive: false });
  window.addEventListener('pointerup', event => endPan(`pointer-${event.pointerId}`));
  window.addEventListener('pointercancel', event => endPan(`pointer-${event.pointerId}`));
  window.addEventListener('mousemove', event => movePan('mouse', event.clientX, event.clientY, event), { passive: false });
  window.addEventListener('mouseup', () => endPan('mouse'));
  document.addEventListener('touchstart', event => {
    if (event.target.closest?.('.trip-map-frame') !== frame) return;
    const touch = event.changedTouches[0];
    if (touch) { event.preventDefault(); beginPan(`touch-${touch.identifier}`, touch.clientX, touch.clientY); }
  }, { capture: true, passive: false });
  window.addEventListener('touchmove', event => {
    const touch = [...event.changedTouches].find(item => `touch-${item.identifier}` === state.pointerId);
    if (touch) movePan(state.pointerId, touch.clientX, touch.clientY, event);
  }, { passive: false });
  const endTouches = event => [...event.changedTouches].forEach(touch => endPan(`touch-${touch.identifier}`));
  window.addEventListener('touchend', endTouches); window.addEventListener('touchcancel', endTouches);
  window.addEventListener('blur', () => { state.pointerId = null; state.dragging = false; frame.classList.remove('is-panning'); });
  window.addEventListener('click', event => {
    if (!state.suppressClick || !event.target.closest?.('.trip-map-frame')) return;
    event.preventDefault(); event.stopPropagation(); state.suppressClick = false;
  }, true);
  window.addEventListener('resize', apply, { passive: true });
  let positioned = false;
  const positionWhenVisible = () => {
    if (positioned || frame.clientWidth <= 0 || frame.clientHeight <= 0) return;
    // Start slightly inside the long sheet so a drag in either direction moves it.
    state.x = Math.min(0, (frame.clientWidth - mapSurface.offsetWidth) * .18);
    positioned = true;
    apply();
  };
  if (window.ResizeObserver) new ResizeObserver(positionWhenVisible).observe(frame);
  // The overview is often initialized while its navigation tab is hidden.
  // Defer initial positioning until it gets real dimensions.
  positionWhenVisible();
  state.scale = 1;
  apply();
}
function overviewPointForNode(nodeId, sourcePoint) {
  const layout = window.ScenicMapLayout;
  if (overviewCanvasMode()) return layout.overviewCanvasNodes?.[nodeId] || layout.overviewCanvasPoint(sourcePoint);
  return layout.overviewPoint(sourcePoint);
}
// C's illustrated buildings and B's routable walking graph deliberately use
// different anchors.  A landmark anchor is centred on the illustrated roof,
// while a route anchor sits on its forecourt/entrance.  Keeping the two apart
// prevents stop badges and route segments from being painted through a roof.
function overviewRoutePointForNode(nodeId, sourcePoint) {
  const layout = window.ScenicMapLayout;
  if (overviewCanvasMode()) {
    return layout.overviewCanvasRouteNodes?.[nodeId]
      || layout.overviewCanvasNodes?.[nodeId]
      || layout.overviewCanvasPoint(sourcePoint);
  }
  return overviewPointForNode(nodeId, sourcePoint);
}
function overviewEdgePoints(points, fromId, toId) {
  const layout = window.ScenicMapLayout;
  if (!overviewCanvasMode()) return points.map(point => layout.overviewPoint(point));
  const start = overviewRoutePointForNode(fromId, layout.nodes[fromId]);
  const end = overviewRoutePointForNode(toId, layout.nodes[toId]);
  // Keep the actual hand-map bend points. The old implementation replaced
  // every edge with a straight interpolation between its endpoints, which
  // made a multi-stop plan look like a bundle of crossing ruler lines. We
  // preserve each source polyline's local bends, but scale those bends down
  // before placing the edge between the C anchors. This avoids importing the
  // long-map coordinate distortion into the rectangular hand-drawn map.
  const projectedSource = points.map(point => layout.overviewCanvasPoint(point));
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const total = lengths[lengths.length - 1] || 1;
  const rawStart = projectedSource[0] || start;
  const rawEnd = projectedSource[projectedSource.length - 1] || end;
  const sourceSpan = Math.hypot(rawEnd[0] - rawStart[0], rawEnd[1] - rawStart[1]) || 1;
  const targetSpan = Math.hypot(end[0] - start[0], end[1] - start[1]) || 1;
  const bendScale = Math.min(0.62, Math.max(0.18, (targetSpan / sourceSpan) * 0.42));
  return points.map((point, index) => {
    const t = lengths[index] / total;
    const raw = projectedSource[index] || rawStart;
    const straightRaw = [rawStart[0] + (rawEnd[0] - rawStart[0]) * t, rawStart[1] + (rawEnd[1] - rawStart[1]) * t];
    const bend = [raw[0] - straightRaw[0], raw[1] - straightRaw[1]];
    return [
      start[0] + (end[0] - start[0]) * t + bend[0] * bendScale,
      start[1] + (end[1] - start[1]) * t + bend[1] * bendScale,
    ];
  });
}
function smoothProjectedPath(projected) {
  if (!projected || projected.length < 2) return '';
  let d = `M${projected[0][0].toFixed(1)},${projected[0][1].toFixed(1)}`;
  for (let index = 0; index < projected.length - 1; index++) {
    const p0 = projected[index - 1] || projected[index];
    const p1 = projected[index], p2 = projected[index + 1], p3 = projected[index + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}
function tripEdgePath(edgeId, fromId, toId) {
  const layout = window.ScenicMapLayout, edge = app.scenicGraph?.edges?.find(item => item.edge_id === edgeId);
  if (!layout || !edge || !fromId || !toId) return '';
  // The rectangular C map has its own hand-tuned curved road network.  Use it
  // directly instead of projecting the long reference map into a straight
  // endpoint-to-endpoint line.  Reverse the path for a bidirectional edge.
  const canvasPath = layout.overviewCanvasEdges?.[edgeId];
  if (overviewCanvasMode() && canvasPath?.length >= 2) {
    const projected = edge.from_node_id === toId && edge.to_node_id === fromId
      ? [...canvasPath].reverse() : canvasPath;
    return smoothProjectedPath(projected);
  }
  let points = layout?.edges?.[edgeId];
  if (!points) return '';
  if (edge.from_node_id === toId && edge.to_node_id === fromId) points = [...points].reverse();
  const projected = overviewEdgePoints(points, fromId, toId);
  return smoothProjectedPath(projected);
}
function renderTripOverview(plan = app.activePlan || app.planResult) {
  const overlay = $('#tripMapOverlay'), layout = window.ScenicMapLayout;
  if (!overlay || !plan || !layout) return;
  const canvasMode = overviewCanvasMode();
  const overviewWidth = canvasMode ? 2400 : layout.width;
  const overviewHeight = canvasMode ? 1600 : layout.overviewHeight;
  overlay.setAttribute('viewBox', canvasMode ? `0 0 ${overviewWidth} ${overviewHeight}` : `0 -40 ${overviewWidth} 591`);
  overlay.setAttribute('preserveAspectRatio', 'none');
  const make = (name, attrs = {}, text = '') => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    if (text) element.textContent = text;
    return element;
  };
  overlay.replaceChildren();
  // Keep the high-contrast route visible without drawing through buildings.
  // The numbered stop markers are added after this masked layer, so each route
  // visually arrives at a landmark but never paints over its footprint.
  const defs = make('defs');
  const landmarkMask = make('mask', { id: 'tripLandmarkClearance', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: overviewWidth, height: overviewHeight });
  landmarkMask.append(make('rect', { x: 0, y: 0, width: overviewWidth, height: overviewHeight, fill: 'white' }));
  for (const [nodeId, point] of Object.entries(layout.nodes || {})) {
    const projected = overviewPointForNode(nodeId, point);
    // Clear the entire illustration footprint, not only the graph's point.
    // The SVG buildings sit slightly north of their walkable node anchors.
    landmarkMask.append(make('circle', { cx: projected[0], cy: canvasMode ? projected[1] : projected[1] - 25, r: canvasMode ? 88 : 52, fill: 'black' }));
  }
  // The overview renderer places each name in a collision-avoiding callout.
  // Cut those rectangles out of the route mask too, so a recommendation can
  // never draw across text even when the callout was moved away from its POI.
  if (!canvasMode) for (const label of $('#tripMap')?.querySelectorAll('[data-overview-node-label],[data-overview-label-box]') || []) {
    const x = Number(label.dataset.labelX), y = Number(label.dataset.labelY);
    const width = Number(label.dataset.labelWidth), height = Number(label.dataset.labelHeight);
    if ([x,y,width,height].every(Number.isFinite)) landmarkMask.append(make('rect', { x:x-4, y:y-3, width:width+8, height:height+6, rx:8, fill:'black' }));
  }
  // The Canvas illustration contains additional C-only halls, gates and
  // pavilions which are not present in A's routable graph.  Clear those
  // footprints too; otherwise a live B route can visibly cut through an
  // illustrated roof even though it is correctly routed between graph nodes.
  for (const spot of (canvasMode ? window.WandashanMap2D?.spots || [] : [])) {
    if (!Number.isFinite(Number(spot.x)) || !Number.isFinite(Number(spot.z))) continue;
    const [cx, cy] = window.WandashanMap2D.worldPoint(Number(spot.x), Number(spot.z));
    landmarkMask.append(make('circle', { cx, cy: cy - Math.min(42, Number(spot.h || 0) * 0.7), r: spot.compact ? 58 : 82, fill: 'black' }));
  }
  defs.append(landmarkMask); overlay.append(defs);
  // The illustrated base map already has one numbered name card per POI.
  // Repeating every name as a red dot here obscured the cards and buildings.
  const routeLayer = make('g', { class: 'trip-route-layer', mask: 'url(#tripLandmarkClearance)' });
  const renderedEdges = new Set();
  for (const item of plan.itinerary || []) {
    const route = item.route || {}, ids = route.node_sequence || [], edges = route.edge_sequence || [];
    edges.forEach((edgeId, index) => {
      // A live plan can revisit a junction while rolling from one stop to the
      // next.  Draw each physical edge only once, regardless of travel
      // direction; this removes the red double-lines that made the overview
      // look like a bundle of conflicting routes.
      const routeKey = String(edgeId);
      if (renderedEdges.has(routeKey)) return;
      renderedEdges.add(routeKey);
      const d = tripEdgePath(edgeId, ids[index], ids[index + 1]);
      if (!d) return;
      routeLayer.append(make('path', { d, class: 'trip-route-halo', 'data-edge-id': edgeId }));
      routeLayer.append(make('path', { d, class: 'trip-route-line', 'data-edge-id': edgeId }));
    });
  }
  overlay.append(routeLayer);
  const firstRoute = plan.itinerary?.find(item => item.route?.node_sequence?.length)?.route;
  const originId = firstRoute?.node_sequence?.[0];
  const origin = layout.nodes[originId] && overviewRoutePointForNode(originId, layout.nodes[originId]);
  if (origin) {
    const pin = make('g', { class: 'trip-current-pin', transform: `translate(${origin[0]} ${origin[1]})` });
    pin.append(make('circle', { r: 31 }), make('text', { y: 6 }, '出发'));
    overlay.append(pin);
  }
  const stops = (plan.itinerary || []).filter(item => !['EXIT', 'WAIT'].includes(item.action_type));
  stops.forEach((item, index) => {
    const nodeId = item.target_node_id;
    const point = layout.nodes[nodeId] && overviewRoutePointForNode(nodeId, layout.nodes[nodeId]); if (!point) return;
    const buildingPoint = layout.nodes[nodeId] && overviewPointForNode(nodeId, layout.nodes[nodeId]);
    const [x, y] = point, group = make('g', { class: 'trip-route-stop', 'data-node-id': nodeId });
    // A fine leader links the route badge to the actual illustrated landmark.
    // It keeps the badge on a walkable entrance while preserving a clear
    // visual relationship with the building label.
    // Numbered stops sit on the walkable route. Avoid extra leader strokes in
    // the already busy upper courts; the stop cards below identify each POI.
    // Keep only numbered markers on the map; the ordered stop cards directly
    // below already show the names, so repeating them here caused pile-ups.
    group.append(make('circle', { cx: x, cy: y, r: 21 }), make('text', { x, y: y + 1 }, String(index + 1)));
    overlay.append(group);
  });
  const exitStep = [...(plan.itinerary || [])].reverse().find(item => item.action_type === 'EXIT');
  $('#tripPlanCaption').textContent = `${plan.label || '为你推荐'} · ${stops.length} 个游览停靠点${exitStep ? ` · 从${planTargetName(exitStep)}离园` : ''} · ${readablePlanReason(plan.reason) || '综合偏好、预计排队与道路状态生成'}`;
  $('#tripStops').innerHTML = stops.length ? stops.map((item, index) => `<article class="trip-stop"><span>STOP ${String(index + 1).padStart(2, '0')}</span><b>${planTargetName(item)}</b><small>预计 ${item.arrival_time?.slice(11, 16) || '--:--'} 到达 · ${Math.round(Number(item.travel_time_min || 0))} 分钟步行</small><em>${item.predicted_queue_min ? `预计排队 ${Math.round(item.predicted_queue_min)} 分钟` : item.action_type === 'ATTEND_EVENT' ? '演出时间窗已校验' : '开放与通行已校验'}</em></article>`).join('') : '<div class="trip-empty">当前方案没有普通游览停靠点，可返回问卷调整约束。</div>';
  app.tripStops = stops;
  if (app.tripStopIndex >= stops.length) app.tripStopIndex = 0;
  if (window.CScenicMap) window.CScenicMap.updatePlan(plan);
}
function focusTripStop(index = 0) {
  const stops = app.tripStops || app.activePlan?.itinerary?.filter(item => !['EXIT', 'WAIT'].includes(item.action_type)) || [];
  if (!stops.length) return toast('请先生成可执行游玩路线');
  app.tripStopIndex = Math.max(0, Math.min(index, stops.length - 1));
  const item = stops[app.tripStopIndex]; const target = item.target_node_id;
  if (target && $('#navTo')?.querySelector(`option[value="${target}"]`)) $('#navTo').value = target;
  $('#guidedTitle').textContent = `${app.tripStopIndex + 1}/${stops.length} · ${planTargetName(item)}`;
  $('#guidedDescription').textContent = `${item.arrival_time?.slice(11, 16) || '预计到达时间待定'} 到达 · ${item.predicted_queue_min ? `预计排队 ${Math.round(item.predicted_queue_min)} 分钟` : '已校验开放状态'} · 详细路段来自当前步行路网`;
  $('#guideNextStop').textContent = app.tripStopIndex < stops.length - 1 ? '查看下一站' : '已是最后一站';
  $('#guideNextStop').disabled = app.tripStopIndex >= stops.length - 1;
  if ($('#navFrom')?.value && target) requestNav().catch(error => toast(error.message));
}
function showTripOverview() {
  app.tripMode = 'overview';
  $('#view-navigation')?.classList.remove('is-guiding');
  if (app.activePlan?.itinerary?.length) renderTripOverview(app.activePlan);
  go('navigation');
  requestAnimationFrame(() => $('#tripOverview')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}
function startGuidedTrip() { app.tripMode = 'guiding'; app.tripStopIndex = 0; go('navigation'); if (!app.activePlan?.itinerary?.length) toast('还没有个性化游程，已打开点到点导航，可先选择起点和目标'); setTimeout(() => $('#guidedDetail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120); }
async function markTripArrival() {
  const item = app.tripStops?.[app.tripStopIndex]; const nodeId = item?.target_node_id;
  if (!nodeId) return toast('当前站点没有可回报的位置节点');
  try {
    const result = await api('/api/b/demo-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: { event_type: 'PROGRESS_UPDATE', current_node_id: nodeId, target_id: item.target_id, remaining_time_min: Math.max(0, Number(app.data.user.remainingMinutes || 0) - Number(item.travel_time_min || 0) - Number(item.predicted_queue_min || 0) - Number(item.visit_duration_min || 0)), fatigue: Math.min(.95, Number(app.data.user.load || 0) + .08) } }) });
    app.data = result; if (result.planResult) renderItinerary(result.planResult); fillNav(); app.tripMode = 'guiding'; $('#view-navigation').classList.add('is-guiding'); await loadNav(); focusTripStop(0); toast(`已记录到达「${routeNodeName(nodeId)}」，该景点已完成并从后续路线移除`);
  } catch (error) { toast(error.message); }
}
async function selectPlanCandidate(candidate, button = null) { if (button && candidate.plan_id && candidate.plan_id !== app.planResult?.plan_id) { try { const promoted = await api('/api/b/select-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan_id: candidate.plan_id, action_sequence: (candidate.itinerary || []).map(item => ({ action_type: item.action_type, target_id: item.target_id })), target_sequence: (candidate.itinerary || []).map(item => item.target_node_id || item.target_id) }) }); app.data.planResult = promoted; renderItinerary(promoted); toast('已切换方案，并同步更新当前规划状态'); return; } catch (error) { toast(error.message); return; } } app.activePlan = candidate; if (button) { $$('.route-candidate').forEach(x => x.classList.remove('selected')); button.classList.add('selected'); } $('#routePlan').innerHTML = routePlanHtml(candidate); const skip = $('#skipPlanTarget'); if (skip) skip.onclick = skipPlanTarget; const overview = $('#showTripOverview'); if (overview) overview.onclick = showTripOverview; renderTripOverview(candidate); const nextNode = candidate.itinerary?.[0]?.target_node_id; if (nextNode && $('#navTo')?.querySelector(`option[value="${nextNode}"]`)) $('#navTo').value = nextNode; }
function renderItinerary(planResult = null) { if (!planResult) { $('#routeHint').textContent = '等待生成个性化游程'; $('#itinerary').innerHTML = '<div class="empty-itinerary">完成游玩节奏和至少一项情境取舍后，系统将根据预计到达时刻、道路状态和时间窗生成可执行游程。</div>'; return; } app.planResult = planResult; if (!planResult.feasible || !planResult.itinerary?.length) { $('#routeHint').textContent = '当前没有可执行方案'; $('#itinerary').innerHTML = `<div class="empty-itinerary"><b>暂时无法生成可行游程</b><p>${planResult.alternative_message || planResult.reason || '当前时间、开放状态或通行约束下没有满足条件的路线。'}</p><small>可尝试调整离园时间、偏好限制，或在现场变化后重新规划。</small></div>`; return; } const candidates = [{ label: '主方案', plan_id: planResult.plan_id, score: planResult.score, next_action: planResult.next_action, itinerary: planResult.itinerary, current_route: planResult.current_route, reason: planResult.reason }, ...(planResult.alternative_plans || []).map((item, index) => ({ ...item, label: `备选 ${index + 1}` }))]; $('#routeHint').textContent = `已生成 ${candidates.length} 个可执行方案`; $('#itinerary').innerHTML = `<div class="plan-contract"><span>状态 ${planResult.based_on_state_version}</span><span>预测 ${planResult.based_on_forecast_version}</span><b>硬约束已校验</b></div><div class="route-candidates">${candidates.map((candidate, index) => { const queue = (candidate.itinerary || []).reduce((sum, item) => sum + Number(item.predicted_queue_min || 0), 0); const minutes = (candidate.itinerary || []).reduce((sum, item) => sum + Number(item.travel_time_min || 0) + Number(item.wait_time_min || 0) + Number(item.predicted_queue_min || 0), 0); return `<button class="route-candidate ${index === 0 ? 'selected' : ''}" data-plan-index="${index}"><span>${candidate.label}</span><b>${Number(candidate.score || 0).toFixed(1)}</b><small>规则效用分</small><em>${Math.round(minutes)} min · 预测排队 ${Math.round(queue)} min</em></button>`; }).join('')}</div>${candidates.length === 1 ? `<p class="alternative-note">${planResult.alternative_message || '当前约束下没有其他不同的可执行方案'}</p>` : ''}<div class="route-plan" id="routePlan"></div>`; $$('.route-candidate').forEach(button => button.onclick = () => selectPlanCandidate(candidates[Number(button.dataset.planIndex)], button)); selectPlanCandidate(candidates[0]); }
function routePlanHtml(plan) { const items = plan.itinerary || []; const routeNodes = plan.current_route?.node_sequence || []; const factorNames = { time: '时间', interest: '兴趣', comfort: '舒适', freedom: '探索', culture: '文化', nature: '自然', performance: '演艺', food: '美食' }; const canSkip = plan.next_action?.target_id && !['EXIT', 'WAIT'].includes(plan.next_action.action_type); return `<div class="route-summary"><div><b>${plan.label || '规划方案'} · ${items[0] ? planTargetName(items[0]) : '无目标'}</b><small>${plan.reason || '根据当前状态与未来预测生成'}</small></div><span>${routeNodes.length > 1 ? `当前路线 ${routeNodes.length - 1} 段` : '当前位置无需移动'}</span></div><div class="plan-route">${routeNodes.map((id, index) => `${index ? '<i>→</i>' : ''}<b>${routeNodeName(id)}</b>`).join('')}</div><div class="itinerary">${items.map((item, i) => `<div class="itin-item"><i>${i + 1}</i><strong>${planTargetName(item)}</strong><small>到达 ${item.arrival_time.slice(11, 16)} · 完成 ${item.completion_time.slice(11, 16)} · 动作得分 ${Number(item.action_score || 0).toFixed(1)}</small><p>${item.predicted_queue_min ? `预计到达时排队 ${item.predicted_queue_min} 分钟` : item.action_type === 'ATTEND_EVENT' ? '已校验最晚入场时间' : item.action_type === 'EXIT' ? '保留安全离园余量' : '道路和开放状态已校验'}${item.preference_dominant_factor ? ` · 主要匹配${factorNames[item.preference_dominant_factor] || item.preference_dominant_factor}` : ''}</p></div>`).join('')}</div><button class="teal-btn route-start" id="showTripOverview">查看地图 1 · 推荐路线 →</button>${canSkip ? '<button class="outline-btn route-replan" id="skipPlanTarget">跳过当前目标并重新规划</button>' : ''}`; }
async function skipPlanTarget() { const target = app.activePlan?.next_action?.target_id; if (!target || !app.planResult) return; const r = await api('/api/b/replan-live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: { schema_version: '0.1', scenario_id: app.planResult.scenario_id, event_type: 'SKIP_TARGET', target_id: target, timestamp: app.planResult.generated_at } }) }); renderItinerary(r); toast('已从当前位置跳过当前目标并重新规划'); }
async function generate() {
  if (!app.answers.type) return toast('请先选择游览节奏');
  if (!app.answers.interests.length) return toast('请至少选择一项最想获得的体验');
  const leaveAt = $('#leaveTime')?.value;
  const current_node_id = $('#currentLocationSelect')?.value || app.data.user.location;
  const exit_node_id = $('#exitNodeSelect')?.value || null;
  const r = await api('/api/preferences', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers: app.answers, leaveAt, current_node_id, exit_node_id })
  });
  app.data.routes = r.routes; app.data.user.preference = r.preference; app.data.user.preferenceProfile = r.preferenceProfile;
  app.data.user.location = r.user?.location || current_node_id;
  app.data.user.preferredExitNodeId = r.user?.preferredExitNodeId || null;
  app.data.user.remainingMinutes = r.user?.remainingMinutes || app.data.user.remainingMinutes;
  app.data.worldModel = r.model || app.data.worldModel; app.data.planResult = r.planResult;
  renderVector(r.preferenceProfile?.weights || r.preference); renderPreferenceProfile(r.preferenceProfile);
  renderModel(app.data.worldModel); fillNav(); renderItinerary(r.planResult);
  if (app.account?.role !== 'guest') refreshAccount().catch(error => console.error('刷新路线记录失败', error));
  // Let visitors review the candidate and explicitly open map 1. Rendering
  // its route data above does not itself change the active page.
  toast(`已从${routeNodeName(current_node_id)}生成路线，点击“查看地图 1”查看推荐路线`);
}
function fillNav() { const nodes = app.data.graph.nodes; $('#navFrom').innerHTML = nodes.map(n => `<option value="${n.id}" ${n.id === app.data.user.location ? 'selected' : ''}>${n.name}</option>`).join(''); $('#navTo').innerHTML = nodes.filter(n => n.id !== app.data.user.location).map(n => `<option value="${n.id}" ${n.id === 'museum' ? 'selected' : ''}>${n.name}</option>`).join(''); }
async function loadNav() { fillNav(); await requestNav(); }
async function requestNav() {
  const from = $('#navFrom').value, to = $('#navTo').value;
  const r = await api(`/api/navigation?${new URLSearchParams({ from, to })}`);
  app.lastNavigation = r;
  const firstSegment = r.segments?.[0], destination = routeNodeName(to);
  if ($('#walkingInstruction')) $('#walkingInstruction').textContent = firstSegment ? `沿${firstSegment.from}至${firstSegment.to}方向前行` : '已到达目的地附近';
  if ($('#walkingDistance')) $('#walkingDistance').textContent = firstSegment ? `${Math.round(firstSegment.distance)} 米后进入下一路段 · ${firstSegment.warning}` : '请留意现场入口标识';
  if ($('#walkingRemain')) $('#walkingRemain').textContent = `${Math.round(r.totalDistance)} m · ${Math.round(r.totalMinutes)} min`;
  if ($('#walkingDestination')) $('#walkingDestination').textContent = destination;
  $('#navSummary').innerHTML = `<div class="nav-summary"><div><b>${r.totalDistance}m</b><span>总距离</span></div><div><b>${r.totalMinutes}min</b><span>预计时间</span></div><div><b>${Math.round(r.segments.reduce((sum, x) => sum + x.shade, 0) / Math.max(1, r.segments.length))}%</b><span>遮阴覆盖</span></div></div><div class="nav-model-note">模型置信度 ${r.model?.horizon?.[0]?.confidence || 91}% · ${r.model?.state.environment || '状态稳定'}</div>`;
  $('#segmentList').innerHTML = r.segments.map(x => `<div class="segment ${x.warning !== '通行顺畅' ? 'warn' : ''}"><i></i><div><b>${x.from} → ${x.to}</b><small>${x.distance}m · ${x.warning} · 遮阴 ${x.shade}% · 座椅约 ${x.chairs}处 · 坡度 ${x.slope}</small></div><em>${x.minutes}min<br/>人流 ${x.crowd}%${x.event ? '<br/>事件节点' : ''}</em></div>`).join('');
  if (window.CScenicMap) window.CScenicMap.updateNavigation(r);
  drawMap();
  if (app.map && window.L) { const pos = Object.fromEntries(app.data.graph.nodes.map(n => [n.id, n])); if (app.routeLayer) app.routeLayer.remove(); app.routeLayer = L.polyline(r.path.map(id => nodeLatLng(pos[id])), { color: '#10aeb1', weight: 7, opacity: .92 }).addTo(app.map); if (app.routeLayer.getBounds().isValid()) app.map.fitBounds(app.routeLayer.getBounds(), { padding: [28, 28] }); }
  return r;
}
function renderCompanions() { if (!$('#companionCards') || $('#companionCards').children.length) return; $('#companionCards').innerHTML = companions.map((x, i) => `<div class="companion-card ${i === 0 ? 'selected' : ''}" data-companion="${x[0]}" data-index="${i}"><div class="portrait ${x[3]}">${x[0][1]}</div><b>${x[0]} · ${x[1]}</b><small>${x[2]}</small></div>`).join(''); app.selectedCompanion = companions[0][0]; $$('.companion-card').forEach(c => c.onclick = () => { $$('.companion-card').forEach(x => x.classList.remove('selected')); c.classList.add('selected'); app.selectedCompanion = c.dataset.companion; const x = companions[Number(c.dataset.index)]; $('#companionName').textContent = `${x[0]} · ${x[1]}`; toast(`已选择${x[0]}作为虚拟伴侣`); }); $$('.quick-prompts button').forEach(b => b.onclick = () => { $('#companionQuestion').value = b.dataset.prompt; askCompanion(); }); if (app.data) { $('#companionLocation').textContent = routeNodeName(app.data.user.location); $('#companionRemaining').textContent = `${app.data.user.remainingMinutes} min`; const next = app.data.routes?.[0]?.stops?.[0]; if (next) $('#companionNext').textContent = routeNodeName(next); } }
async function askCompanion() { const q = $('#companionQuestion').value.trim(); if (!q) return toast('请输入想问旅伴的问题'); const r = await api('/api/companion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, location: app.data.user.location, companion: app.selectedCompanion }) }); $('#chatMessages').insertAdjacentHTML('beforeend', `<div class="message user">${q}</div><div class="message bot">${r.answer}</div>`); $('#companionQuestion').value = ''; const box = $('#chatMessages'); box.scrollTop = box.scrollHeight; }
function renderCrowd() { const names = { gate: '中门', market: '非遗市集', lake: '九龙瀑', museum: '大宋武馆', theater: '武林会场', summit: '城墙观景点' }; $('#crowdBars').innerHTML = Object.entries(names).map(([id, n]) => { const val = app.data.crowd[id] || 0; const poi = app.data.graph.nodes.find(x => x.id === id); return `<div class="crowd-row"><span>${n}</span><i><b style="width:${Math.round(val * 100)}%;background:${val < .5 ? '#75a88d' : val < .7 ? '#d39b54' : '#c95248'}"></b></i><em>${Math.round(val * (poi?.capacity || 100))}人</em></div>`; }).join(''); }
function renderDna() { if (!app.data?.routeSeeds || $('#dnaList').children.length) return; $('#dnaList').innerHTML = app.data.routeSeeds.map(s => `<div class="dna-route" data-seed="${s.id}"><div class="route-cover"></div><div><h3>${s.title}</h3><p>${s.author} · ${s.likes}+人评价</p><div class="dna-meta"><span>评分 ${s.id === 'F902' ? '4.7' : '4.5'}</span><span>${(s.minutes / 60).toFixed(1)}小时</span><span>${(s.minutes / 60 * .8).toFixed(1)}km</span></div></div><div class="dna-star">☆</div></div>`).join(''); $$('.dna-route').forEach(x => x.onclick = () => { app.selectedSeed = app.data.routeSeeds.find(s => s.id === x.dataset.seed); $('#selectedDnaTitle').textContent = app.selectedSeed.title; $('#dnaCode').textContent = `#${app.selectedSeed.id}`; toast('已加载路线DNA'); }); }
async function cloneDna(mutate = false) { if (!app.selectedSeed) return toast('请先选择一条路线'); const r = await api('/api/dna/clone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: app.selectedSeed.id, mutate }) }); $('#dnaCode').textContent = r.route.dna; $('#dnaMessage').textContent = `${mutate ? '已根据你的偏好完成路线变异' : '已复制路线结构'}：${r.route.title}`; toast(mutate ? '路线已完成个性化变异' : '已复制路线DNA'); }
async function emergency(type) { const r = await api('/api/emergency', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }) }); toast(r.emergency.message); }
async function dispatchPlannerEvent(eventType) {
  const requestedTarget = $('#navTo')?.value;
  const lastMapEvent = window.lastScenicUserEvent || {};
  const targetId = (lastMapEvent.event_type === 'POI_CLICK' && lastMapEvent.target_id)
    || app.scenicGraph?.nodes.find(node => node.node_id === requestedTarget && node.poi_id)?.poi_id
    || app.scenicGraph?.nodes.find(node => node.poi_id)?.poi_id;
  const event = { event_type: eventType };
  if (eventType === 'POI_CLOSED' || eventType === 'QUEUE_UPDATE') Object.assign(event, { target_id: targetId, ...(eventType === 'QUEUE_UPDATE' ? { queue_min: 40 } : {}) });
  if (eventType === 'POSITION_UPDATE' || eventType === 'PROGRESS_UPDATE') {
    const item = app.tripStops?.[app.tripStopIndex];
    if (eventType === 'PROGRESS_UPDATE') {
      if (!item?.target_node_id || !item?.target_id) return toast('请先生成路线并选择要回报到达的下一站');
      Object.assign(event, { current_node_id: item.target_node_id, target_id: item.target_id, remaining_time_min: Math.max(0, Number(app.data.user.remainingMinutes || 0) - Number(item.travel_time_min || 0) - Number(item.predicted_queue_min || 0) - Number(item.visit_duration_min || 0)), fatigue: Math.min(.95, Number(app.data.user.load || 0) + .08) });
    } else Object.assign(event, { current_node_id: app.data.user.location, remaining_time_min: Math.max(0, app.data.user.remainingMinutes - 25), fatigue: Math.min(0.95, app.data.user.load + 0.2) });
  }
  if (eventType === 'ROAD_CLOSED' || eventType === 'ROAD_OPENED') {
    const clicked = lastMapEvent.event_type === 'ROAD_CLICK' ? lastMapEvent.edge_id : null;
    const isAvailable = id => app.scenicState?.road_states?.[id]?.available !== false;
    const selected = clicked && (eventType === 'ROAD_CLOSED' ? isAvailable(clicked) : !isAvailable(clicked))
      ? clicked
      : null;
    if (!selected) return toast(eventType === 'ROAD_OPENED' ? '请先点击地图上一段已封闭道路，再执行恢复' : '请先点击地图上要封闭的道路，再执行道路封闭');
    event.edge_id = selected;
  }
  if (eventType === 'EVENT_CANCELLED' || eventType === 'EVENT_MISSED') {
    const events = Object.values(app.scenicState?.event_states || {});
    const selected = events.find(item => item.event_id === lastMapEvent.target_id && item.status !== 'cancelled')
      || events.find(item => !['cancelled','completed'].includes(item.status));
    if (!selected) return toast('当前没有可取消的演出活动');
    event.target_id = selected.event_id;
  }
  try {
    const r = await api('/api/b/demo-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event }) });
    app.data = r;
    renderModel(r.worldModel || r.model);
    drawMap(app.mapMode);
    renderCrowd();
    fillNav();
    if (r.planResult) renderItinerary(r.planResult);
    await loadScenicContext();
    if ($('#view-navigation')?.classList.contains('active')) await requestNav();
    if (eventType === 'PROGRESS_UPDATE') {
      app.tripMode = 'guiding';
      $('#view-navigation')?.classList.add('is-guiding');
      await loadNav();
      focusTripStop(0);
      toast(`已记录到达「${routeNodeName(event.current_node_id)}」，已按剩余行程重规划`);
    } else toast(`已将 ${event.edge_id || event.target_id || event.current_node_id || targetId || '现场'}设为${eventType}，并已重规划`);
  } catch (error) { toast(error.message); }
}
async function simulateEvent() { await dispatchPlannerEvent('QUEUE_UPDATE'); }
async function simulateRoadClosure() { await dispatchPlannerEvent('ROAD_CLOSED'); }
function labelMapStages() {
  const intro = $('#view-navigation .page-intro');
  if (intro && !intro.querySelector('.map-stage-guide')) intro.insertAdjacentHTML('beforeend', '<div class="map-stage-guide"><span class="active"><b>地图 1</b> 全程路线推荐</span><i>→ 切换动画 →</i><span><b>地图 2</b> 精细步行导航</span></div>');
  const enter = $('#enterGuidance');
  if (enter) enter.innerHTML = '切换至地图 2 · 精细导航 <span>↗</span>';
  const back = $('#backToOverview');
  if (back) back.textContent = '返回地图 1 · 路线总览';
  const overviewKicker = $('#tripOverview .trip-kicker');
  if (overviewKicker) overviewKicker.textContent = 'MAP 01 · WANDASHAN STORY MAP';
  const detailKicker = $('#guidedDetail .trip-kicker');
  if (detailKicker) detailKicker.textContent = 'MAP 02 · TURN-BY-TURN NAVIGATION';
  const detailTitle = $('#guidedTitle');
  if (detailTitle) detailTitle.textContent = '下一站精细导航';
  const toolbarTitle = $('#guidedDetail .map-toolbar b');
  if (toolbarTitle) toolbarTitle.textContent = '地图 2 · 景区动态 2.5D 精细导航';
}
async function init() {
  let stage = '读取主平台快照';
  if (location.protocol === 'file:') {
    const message = '当前页面是从磁盘直接打开的，无法连接后端。请访问 http://localhost:4173/，不要双击 public/index.html。';
    document.documentElement.dataset.initError = message;
    console.error('景策万象初始化失败', message);
    toast(message);
    return;
  }
  try {
    // Wire the overview before any backend request. A slow/failed snapshot or
    // map-data refresh must never leave a visible SVG without its controls.
    setupOverviewMapInteractions();
    stage = '读取账号状态'; await refreshAccount();
    app.data = await api('/api/snapshot');
    stage = '挂载精细导航地图'; mountCMap();
    stage = '读取 A 模块路网、状态与预测'; await loadScenicContext();
    stage = '渲染主平台数据';
    $('#homeCrowd').textContent = `${Math.round(Object.values(app.data.crowd).reduce((a, b) => a + b, 0) / Object.keys(app.data.crowd).length * 100)}%`;
    $('#homeQueue').textContent = `${Math.round(Object.values(app.data.queues).reduce((a, b) => a + b, 0) / Object.keys(app.data.queues).length)}min`;
    $('#homeLoad').textContent = `${Math.round(app.data.user.load * 100)}%`;
    renderModel(app.data.worldModel); renderVector(app.data.user.preferenceProfile?.weights || app.data.user.preference);
    renderPreferenceProfile(app.data.user.preferenceProfile); renderSurvey(); renderItinerary(app.data.planResult || null);
    drawChart(); drawMap(); fillNav(); requestNav().catch(error => console.error('初始化点到点导航失败', error));
    renderCrowd(); renderDna(); renderCompanions();
  } catch (error) {
    const reason = error?.message || String(error);
    const networkFailure = error instanceof TypeError && /fetch|network|failed/i.test(reason);
    const message = networkFailure ? `无法连接当前页面的后端：${reason}` : `${stage}失败：${reason}`;
    console.error('景策万象初始化失败', { stage, error });
    document.documentElement.dataset.initError = message;
    toast(message);
  }
}
$$('[data-planner-event]').forEach(button => button.onclick = () => dispatchPlannerEvent(button.dataset.plannerEvent));
$('#accountEntry').onclick = () => go('profile');
$('#accountForm').onsubmit = submitAccount;
$('#accountMode').onclick = () => { accountRegisterMode = !accountRegisterMode; $('#accountDisplayNameRow').hidden = !accountRegisterMode; $('#accountSubmit').textContent = accountRegisterMode ? '注册并登录' : '登录'; $('#accountMode').textContent = accountRegisterMode ? '返回登录' : '注册新账号'; };
$('#accountLogout').onclick = async () => { try { await api('/api/account/logout', { method: 'POST' }); await refreshAccount(); toast('已退出登录'); } catch (error) { toast(error.message); } };
$('#saveProfile').onclick = saveAccountProfile;
$('#loadManagerAudit').onclick = async () => { try { const result = await api('/api/admin/audit'); $('#managerOutput').textContent = JSON.stringify(result.entries, null, 2); } catch (error) { toast(error.message); } };
$('#loadManagerUsers').onclick = async () => { try { const result = await api('/api/admin/users'); $('#managerOutput').textContent = JSON.stringify(result.users, null, 2); } catch (error) { toast(error.message); } };
$$('.nav').forEach(b => b.onclick = () => go(b.dataset.view));
$$('[data-view-target]').forEach(b => b.onclick = () => go(b.dataset.viewTarget));
$$('.map-tabs i').forEach(b => b.onclick = () => { $$('.map-tabs i').forEach(x => x.classList.remove('active')); b.classList.add('active'); setMapTheme(b.dataset.layer); });
$$('.filter-grid button').forEach(b => b.onclick = () => b.classList.toggle('selected'));
if ($('#simulateEvent') && !$('#simulateRoadClosure')) $('#simulateEvent').insertAdjacentHTML('afterend', '<button class="outline-btn" id="simulateRoadClosure">模拟道路封闭</button>');
$$('.contact-grid button').forEach(b => b.onclick = () => toast(`正在拨打${b.parentElement.querySelector('span').firstChild.textContent}服务电话`));
if ($('#generateRoute')) $('#generateRoute').onclick = generate; if ($('#navPlan')) $('#navPlan').onclick = requestNav; if ($('#sendCompanion')) $('#sendCompanion').onclick = askCompanion; if ($('#companionQuestion')) $('#companionQuestion').onkeydown = e => { if (e.key === 'Enter') askCompanion(); }; if ($('#copyDna')) $('#copyDna').onclick = () => cloneDna(false); if ($('#mutateDna')) $('#mutateDna').onclick = () => cloneDna(true); if ($('#rainAction')) $('#rainAction').onclick = () => emergency('rain'); if ($('#sosAction')) $('#sosAction').onclick = () => emergency('sos'); if ($('#simulateEvent')) $('#simulateEvent').onclick = simulateEvent; if ($('#simulateRoadClosure')) $('#simulateRoadClosure').onclick = simulateRoadClosure;
if ($('#enterGuidance')) $('#enterGuidance').onclick = startGuidedTrip;
if ($('#backToOverview')) $('#backToOverview').onclick = showTripOverview;
if ($('#guideNextStop')) $('#guideNextStop').onclick = () => focusTripStop(app.tripStopIndex + 1);
if ($('#backToOverview')) { $('#backToOverview').insertAdjacentHTML('beforebegin', '<button class="outline-btn" id="markTripArrival">完成此站并更新进度</button>'); $('#markTripArrival').onclick = markTripArrival; }
labelMapStages();
init();
if (location.hash) setTimeout(() => go(location.hash.slice(1)), 80);
setInterval(async () => { try { const d = await api('/api/snapshot'); app.data.crowd = d.crowd; app.data.queues = d.queues; app.data.events = d.events; app.data.worldModel = d.worldModel; $('#homeCrowd').textContent = `${Math.round(Object.values(d.crowd).reduce((a, b) => a + b, 0) / Object.keys(d.crowd).length * 100)}%`; renderModel(d.worldModel); drawMap(app.mapMode); drawChart(); renderCrowd(); await loadScenicContext(); } catch (_) {} }, 15000);
