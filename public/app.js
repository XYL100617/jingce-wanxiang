const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const app = { data: null, scenicGraph: null, scenicState: null, forecast: null, poiBriefings: {}, poiGps: null, roadNames: {}, answers: { interests: [], group: 'solo', mobility: 'normal' }, touchedScales: new Set(), selectedSeed: null, selectedCompanion: null, map: null, mapLayers: [], routeLayer: null, mapMode: 'base', planResult: null, activePlan: null, tripMode: 'overview', navigationMode: 'free', tripStopIndex: 0, cMapMode: '2.5d', dnaTags: [], dnaRequestId: 0 };
let companionGpsWatchId = null;
const companionGpsArrivals = new Map();
let companionGpsGeneration = 0;
let map2WalkTimer = null;
function stopMap2Walk() { if (map2WalkTimer) clearInterval(map2WalkTimer); map2WalkTimer = null; const button = $('#walkingPlay'); if (button) button.textContent = app.lastNavigation?.continuous ? '▶ 重播整条推荐路线' : '▶ 模拟步行'; }
const SCENIC_CENTER = [34.82065, 114.34426];
const surveyTypes = [['fast', '时间紧迫型', '优先完成高价值项目，减少等待和绕行'], ['normal', '从容均衡型', '兼顾文化、自然、舒适与项目完成度'], ['free', '自由探索型', '保留临场选择，愿意为独特体验绕行']];
const surveyGroups = [['solo', '独自游览'], ['friends', '朋友同行'], ['family', '亲子家庭'], ['elderly', '与长者同行']];
const mobilityOptions = [['normal', '步行正常'], ['light', '希望少走'], ['minimal', '尽量少走']];
const interestOptions = [['culture', '历史文化'], ['nature', '自然景观'], ['performance', '演艺活动'], ['food', '美食市集'], ['photo', '摄影打卡'], ['interactive', '互动体验']];
const ROUTE_TAGS_CLIENT = ['亲子', '文化', '演艺', '美食', '拍照', '轻松', '深度游', '短时', '自然', '亲水', '街巷', '长线', '多景点', '水岸风光', '街区漫游'];
function dnaPhoto(tags = [], title = '') {
  const pairs = [['亲子', 'family-park.jpg', '亲子路线氛围'], ['演艺', 'short-route-performance.png', '演艺路线氛围'], ['美食', 'night-market.jpg', '市集美食氛围'], ['自然', 'lake-trail.jpg', '湖畔自然氛围'], ['拍照', 'lake-trail.jpg', '自然摄影氛围']];
  const match = /高效打卡|短时|效率/.test(title) ? pairs[1] : pairs.find(([tag]) => tags.includes(tag)) || ['文化', 'chinese-lantern-street.jpg', '宋风街区氛围'];
  return `<figure class="route-photo-card"><img src="/assets/dna-routes/${match[1]}" alt="${match[2]}" loading="lazy"><figcaption>${match[2]}</figcaption></figure>`;
}
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
const companions = [['guide', '小明', '专业导游', '讲清景点脉络与历史背景', 'p1'], ['food', '小红', '美食达人', '优先查找已核实的美食与市集资料', 'p2'], ['photo', '小李', '摄影大师', '介绍已核实的摄影点，不编造光照信息', 'p3'], ['outdoor', '小王', '户外探险家', '关注自然节点与已核实的通行信息', 'p4'], ['story', '小五', '故事讲述者', '用已审核的事实串联景区细节', 'p5']];
async function api(url, opt = {}) { let r; try { r = await fetch(url, opt); } catch (_) { throw new Error('网络连接失败，请检查服务状态后重试'); } let body; try { body = await r.json(); } catch (_) { body = {}; } if (!r.ok) { const error = new Error(body.error || `请求失败（${r.status}）`); error.status = r.status; throw error; } return body; }
function renderAccount(response) {
  const previousAccountId = app.account?.id || null;
  app.account = response.user;
  app.accountProfile = response.profile;
  if (previousAccountId !== (response.user?.id || null)) app.communityPersonal = null;
  const user = response.user;
  document.body.dataset.accountRole = user.role;
  $('#accountName').textContent = user.displayName;
  $('#accountAvatar').textContent = user.displayName.slice(0, 1);
  renderAccountMenu(user);
  $('#profileAvatar').textContent = user.displayName.slice(0, 1);
  $('#profileName').textContent = user.displayName;
  $('#profileRole').textContent = user.role === 'manager' ? '景区管理员 · 可管理景区状态' : user.role === 'visitor' ? `游客账号 · ${user.username}` : '未登录 · 仅临时体验';
  $('#profileRoleShort').textContent = user.role === 'manager' ? '管理者' : user.role === 'visitor' ? '游客' : '访客';
  $('#profileRouteCount').textContent = response.profile?.routeHistory?.length || 0;
  $('#profileConsentCount').textContent = Object.values(response.profile?.consent || {}).filter(Boolean).length;
  if ($('#companionRoutePermission')) { $('#companionRoutePermission').disabled = user.role === 'guest'; if (user.role === 'guest') $('#companionRoutePermission').checked = false; }
  if ($('#profileGuestAccess')) $('#profileGuestAccess').hidden = user.role !== 'guest';
  $('#profileSettings').hidden = user.role === 'guest';
  $('#accountLogout').hidden = user.role === 'guest';
  $('#managerPanel').hidden = user.role !== 'manager';
  if ($('#managerOperationsPanel')) $('#managerOperationsPanel').hidden = user.role !== 'manager';
  if ($('#deleteAccount')) $('#deleteAccount').hidden = user.role !== 'visitor';
  if (response.profile) {
    $('#profileDisplayName').value = response.profile.displayName;
    $('#consentLocation').checked = response.profile.consent.location;
    $('#consentFeedback').checked = response.profile.consent.feedback;
    $('#consentSharing').checked = response.profile.consent.sharing;
  }
  renderAccountRouteHistory();
  updateCommunityAccess();
  if (user.role === 'manager' && $('#managerOperationsPanel')) loadOperations().catch(() => {});
}
function renderAccountRouteHistory() {
  const target = $('#accountRoutes'); if (!target) return;
  const routes = app.accountProfile?.routeHistory || [];
  target.replaceChildren();
  if (!routes.length) { target.textContent = app.account?.role === 'guest' ? '登录后显示已保存的路线。' : '还没有保存的路线；生成个性化路线后会自动记录。'; return; }
  routes.forEach(route => {
    const row = document.createElement('div'); row.className = 'account-history-row';
    const title = document.createElement('b'); title.textContent = new Date(route.createdAt).toLocaleString('zh-CN');
    const stops = document.createElement('small'); stops.textContent = [...new Set(route.stops || [])].map(routeNodeName).join(' → ') || '当前条件下无可行路线';
    row.append(title, stops); target.append(row);
  });
}
function renderAccountMenu(user) {
  const menu = $('#accountMenu'); if (!menu) return;
  const signedIn = user?.role === 'visitor' || user?.role === 'manager';
  const items = user?.role === 'visitor'
    ? [['profile', '个人主页'], ['profileFavorites', '我的收藏'], ['profileSavedRoutes', '收藏路线'], ['profilePublishedRoutes', '我的路线分享'], ['profileCheckins', '我的打卡'], ['profileRecentViews', '最近浏览'], ['profileSettings', '账号与资料']]
    : user?.role === 'manager'
      ? [['profile', '管理者资料'], ['managerPanel', '管理工作台']]
      : [['profile', '个人主页']];
  menu.innerHTML = `${items.map(([target, label]) => `<button type="button" role="menuitem" data-account-target="${target}">${label}</button>`).join('')}<div class="account-menu-separator"></div>${signedIn ? '<button type="button" role="menuitem" data-account-target="logout" class="account-menu-logout">退出登录</button>' : '<button type="button" role="menuitem" data-account-target="login" class="account-menu-login">登录 / 注册</button>'}`;
}
function updateCommunityAccess() {
  const signedIn = app.account?.role === 'visitor';
  const sharing = Boolean(app.accountProfile?.consent?.sharing);
  if ($('#companionRoutePermission')) { $('#companionRoutePermission').disabled = !signedIn; if (!signedIn) $('#companionRoutePermission').checked = false; }
  for (const id of ['communityRouteTitle', 'communityRouteDescription', 'publishCommunityRoute']) if ($(`#${id}`)) $(`#${id}`).disabled = false;
  if ($('#shareProfile')) $('#shareProfile').disabled = !signedIn;
  if ($('#communityRouteSource')) $('#communityRouteSource').disabled = false;
  $$('#communityRouteTags input').forEach(input => { input.disabled = false; });
  for (const id of ['favoritePoi', 'likePoi', 'checkinPoi']) if ($(`#${id}`)) $(`#${id}`).disabled = !signedIn;
  const communityPoiForm = $('#communityPoiSelect')?.closest('.community-form');
  if (communityPoiForm) communityPoiForm.hidden = app.account?.role === 'manager';
  if ($('#communitySharingConsent')) { $('#communitySharingConsent').checked = sharing; $('#communitySharingConsent').disabled = !signedIn; }
  if ($('#communitySharingStatus')) $('#communitySharingStatus').textContent = !signedIn ? '可以先填写路线草稿；登录后保存公开分享授权即可发布。' : sharing ? '公开分享已开启，可以直接在本页发布路线。' : '勾选公开分享并保存授权后即可发布。';
  if ($('#consentSharingRow')) $('#consentSharingRow').hidden = app.account?.role !== 'visitor';
  if ($('#communityPublish')) $('#communityPublish').hidden = false;
  if ($('#communityPersonal')) $('#communityPersonal').hidden = false;
}
async function refreshAccount() { renderAccount(await api('/api/account/me')); if ($('#communityPersonal') && app.account?.role === 'visitor') loadCommunityPersonal().catch(() => {}); }
async function saveAccountProfile() {
  try {
    const result = await api('/api/account/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: $('#profileDisplayName').value, consent: { location: $('#consentLocation').checked, feedback: $('#consentFeedback').checked, sharing: $('#consentSharing').checked } }) });
    renderAccount({ user: result.profile, profile: result.profile });
    toast('个人资料与授权已保存');
  } catch (error) { toast(error.message); }
}
async function exportAccountData() {
  try {
    const data = await api('/api/account/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `jingce-account-${new Date().toISOString().slice(0, 10)}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); toast('个人数据导出已开始');
  } catch (error) { toast(error.message); }
}
async function deleteVisitorAccount() {
  if (app.account?.role !== 'visitor') return toast('仅普通游客账号可自助删除');
  if (!window.confirm('确定永久删除账号及个人中心数据吗？本人发布的路线也会移除，此操作不可撤销。')) return;
  const password = window.prompt('请输入当前密码以确认删除'); if (!password) return;
  try {
    await api('/api/account/me', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    await refreshAccount(); await loadCommunityPersonal(); toast('账号及个人中心数据已删除');
  } catch (error) { toast(error.message); }
}
function toast(msg) { const t = $('#toast'); if (!t) return; $('.toast span', t).textContent = msg; t.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2600); }
function go(view, options = {}) { $$('.view').forEach(x => x.classList.toggle('active', x.id === `view-${view}`)); $$('.nav').forEach(x => x.classList.toggle('active', x.dataset.view === view)); if (view === 'navigation') { $('#view-navigation')?.classList.toggle('is-guiding', app.tripMode === 'guiding'); if (options.confirmDestination) { $('#view-navigation')?.classList.remove('is-guiding'); app.tripMode = 'overview'; app.navigationMode = 'free'; fillNav(); $('#navSummary').innerHTML = '<p>目的景点已选定，请确认起点与终点后开始规划。</p>'; $('#segmentList').replaceChildren(); window.CScenicMap?.updateNavigation({ path: [], edgeSequence: [] }); } else if (!options.skipNavigationLoad) loadNav().catch(showNavigationError); } if (view === 'dna') renderDna(); if (view === 'companion') renderCompanions(); if (view === 'emergency') loadOperations().catch(error => toast(error.message)); }
function nodeLatLng(n) { return [SCENIC_CENTER[0] + (50 - n.y) * 0.00034, SCENIC_CENTER[1] + (n.x - 50) * 0.00043]; }
function initLeafletMap() { const el = $('#navMap'); if (!el || app.map) return; if (!window.L) { el.innerHTML = '<div class="map-fallback">参考底图正在加载，请检查网络连接</div>'; return; } app.map = L.map(el, { zoomControl: false, attributionControl: false }).setView(SCENIC_CENTER, 16); app.map.baseLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, attribution: '© 开放街图贡献者' }).addTo(app.map); if (!$('#cMapSurface')) { $('#mapZoomIn').onclick = () => app.map.zoomIn(); $('#mapZoomOut').onclick = () => app.map.zoomOut(); $('#mapLocate').onclick = () => app.map.setView(SCENIC_CENTER, 17); } setTimeout(() => app.map.invalidateSize(), 160); }
function mountCMap() {
  const container = $('#navMap')?.parentElement; if (!container || !window.CScenicMap || $('#cMapSurface')) return;
  container.insertAdjacentHTML('afterbegin', '<svg id="cMapSurface" aria-label="景区立体跟随导航地图"></svg><div class="walking-nav-hud" id="walkingNavHud"><div class="walking-turn">↑</div><div><small>步行导航 · 模拟位置</small><b id="walkingInstruction">选择起点与终点，开始导航</b><span id="walkingDistance">地图将跟随路线显示沿途近景</span></div></div><div class="walking-nav-sheet"><div><small>剩余路程</small><b id="walkingRemain">剩余 -- 米 · -- 分钟</b></div><div><small>目的地</small><b id="walkingDestination">请选择景点</b></div><button type="button" id="walkingPlay" disabled>▶ 模拟步行</button><label class="walking-speed">模拟速度<select id="walkingSpeed" aria-label="模拟步行速度"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><label class="walking-progress"><span>演示位置</span><input id="walkingProgress" type="range" min="0" max="100" value="0" aria-label="沿路线预览演示位置" disabled><b id="walkingProgressValue">0%</b></label><button type="button" id="walkingRecenter" aria-label="回到地图1方向并定位">◎</button></div><div class="c-poi-detail" id="cPoiDetail" hidden></div>');
  const accuracyNote = $('.map-attribution');
  if (accuracyNote) accuracyNote.textContent = '地图2按地图1坐标绘制；细虚线为参考小路，不参与规划。园内道路和位置采用示意数据。';
  const mapControls=$('.map-controls');
  if(mapControls&&!$('#mapRotateLeft'))mapControls.insertAdjacentHTML('beforeend','<button type="button" id="mapRotateLeft" aria-label="地图逆时针旋转15度" title="逆时针旋转">↶</button><button type="button" id="mapRotateRight" aria-label="地图顺时针旋转15度" title="顺时针旋转">↷</button>');
  if($('#mapLocate')){ $('#mapLocate').setAttribute('aria-label','回正到地图1方向并定位'); $('#mapLocate').title='恢复地图1朝向并回到当前位置'; }
  $('.map-toolbar')?.insertAdjacentHTML('beforeend', '<div class="c-map-tools"><details class="c-map-layer-menu"><summary>图层</summary><div class="c-layerbar"><button class="active" data-c-layer="terrain">地形</button><button class="active" data-c-layer="buildings">建筑</button><button class="active" data-c-layer="roads">步道</button><button data-c-layer="referencePaths" title="仅供辨认，不参与规划">参考小路</button><button class="active" data-c-layer="service">模拟车行路</button><button class="active" data-c-layer="poi">景点</button><button class="active" data-c-layer="heat">排队热度</button><button class="active" data-c-layer="events">演出</button><button class="active" data-c-layer="route">推荐路线</button><button class="active" data-c-layer="navigation">导航路线</button><button class="active" data-c-layer="visitor">游客位置</button></div></details><button class="c-map-mode" id="cMapMode">参考底图</button></div>');
  $('.map-toolbar')?.insertAdjacentHTML('afterend', '<section class="map-crowd-panel" id="mapCrowdPanel" aria-label="景区模拟人流与舒适度"><div class="map-crowd-heading"><div><b>景区人流动态</b><small>按景点展示模拟拥挤趋势与舒适度参考 · 非现场实时</small></div><label>查看时点<select id="mapCrowdHorizon"><option value="0">当前模拟状态</option><option value="5">5 分钟后</option><option value="15">15 分钟后</option><option value="30">30 分钟后</option><option value="60">60 分钟后</option></select></label><span class="map-crowd-badge">模拟推演 · 客流参考</span></div><div class="map-crowd-metrics"><div><small>景点平均拥挤指数</small><b id="mapCrowdAverage">--</b></div><div><small>舒适度参考</small><b id="mapComfortAverage">--</b></div><div><small>较拥挤景点</small><b id="mapCrowdHotCount">--</b></div><div class="map-crowd-hotspots"><small>较高拥挤点</small><b id="mapCrowdHotspots">载入中</b></div></div><div class="map-crowd-footer"><span><i class="low"></i>较舒缓</span><span><i class="mid"></i>适中</span><span><i class="high"></i>较拥挤</span><small>颜色表示模拟拥挤度；舒适度按遮阴与模拟拥挤度估算。</small></div></section>');
  const crowdPanel=$('#mapCrowdPanel');
  if(crowdPanel){
    const details=document.createElement('details');details.className='map-crowd-details';
    const summary=document.createElement('summary');summary.textContent='展开人流与舒适度分析';details.append(summary);
    for(const item of ['.map-crowd-metrics','.map-crowd-footer']){const content=crowdPanel.querySelector(item);if(content)details.append(content);}
    crowdPanel.append(details);
  }
  if($('.map-toolbar b'))$('.map-toolbar b').textContent='景区精细导航';
  if($('.map-toolbar small'))$('.map-toolbar small').textContent='景点与道路沿用地图1 · 沿街建筑和绿地为模拟';
  if($('#cMapMode'))$('#cMapMode').textContent='街道参考图';
  $('.planner-event-controls')?.insertAdjacentHTML('afterbegin', '<span class="planner-event-selection" id="plannerEventSelection">先点选地图上的景点或道路，再执行对应事件</span>');
  if (accuracyNote) container.insertAdjacentElement('afterend', accuracyNote);
  container.insertAdjacentHTML('beforeend', '<button type="button" id="mapImmersiveToggle" class="map-immersive-toggle" aria-pressed="false" title="切换为朝前跟随、沿途景物变化的导航视角">沿途立体视角</button>');
  const selectedPlace=$('#cPoiDetail');if(selectedPlace&&$('#navPlan'))$('#navPlan').insertAdjacentElement('afterend',selectedPlace);
  window.CScenicMap.mount('#cMapSurface', { onPoiClick: (node, status) => {
    const detail = $('#cPoiDetail'); if (!detail) return;
    const gate=node.type==='gate',closed=status.open===false;
    const areaName={water_margin:'水浒文化区',wuxia_film:'武侠影视区',pastoral:'田园区',shili_foreign:'十里洋场区',xianxia:'仙侠区',jianghu_art:'江湖艺术区'}[node.area_id]||'园区主区';
    detail.hidden=false;detail.innerHTML=`<small>已选景区节点</small><b>${node.name}</b><span>${gate?'园区出入口':closed?'当前暂停开放':`当前排队 ${Math.round(Number(status.queue_min||0))} 分钟`} · ${areaName}</span><div class="c-poi-actions"><button type="button" id="cPoiFrom">设为起点</button><button type="button" id="cPoiNavigate">导航到这里</button></div>`;
    $('#cPoiFrom').onclick=()=>{const from=$('#navFrom');if(!from?.querySelector(`option[value="${node.node_id}"]`))return;app.navigationMode='free';from.value=node.node_id;fillNav();window.CScenicMap.focusNode(node.node_id);};
    $('#cPoiNavigate').onclick=async()=>{try{if($('#navFrom').value===node.node_id)throw new Error('起点和终点需要不同');if($('#navTo')?.querySelector(`option[value="${node.node_id}"]`))$('#navTo').value=node.node_id;await requestNav({mode:'free'});}catch(error){showNavigationError(error);}};
  }, onNavigationProgress: pose => {
    const slider = $('#walkingProgress');
    if (slider) slider.value = String(Math.round(pose.progress * 100));
    if (slider) slider.disabled = false;
    if ($('#walkingProgressValue')) $('#walkingProgressValue').textContent = `${Math.round(pose.progress * 100)}%`;
    if ($('#walkingInstruction')) $('#walkingInstruction').textContent = pose.maneuver;
    const turn=$('#walkingNavHud .walking-turn');
    if(turn)turn.textContent=pose.maneuver.includes('左转')?'↰':pose.maneuver.includes('右转')?'↱':pose.maneuver.includes('折返')?'↶':'↑';
    if ($('#walkingDistance')) $('#walkingDistance').textContent = pose.remaining<1 ? `已到达 ${routeNodeName(pose.to)}` : `${routeEdgeName(pose.edgeId)} · ${Math.round(pose.distanceToNext)} 米后到达 ${routeNodeName(pose.to)}`;
    if ($('#walkingRemain')) {
      const minutes = Number(app.lastNavigation?.totalMinutes || 0) * (1 - pose.progress);
      $('#walkingRemain').textContent = `剩余 ${Math.round(pose.remaining)} 米 · ${Math.round(minutes)} 分钟`;
    }
  }});
  $('#walkingProgress')?.addEventListener('input', event => window.CScenicMap.setNavigationProgress(Number(event.target.value) / 100));
  $('#walkingPlay')?.addEventListener('click', () => {
    if (map2WalkTimer) { stopMap2Walk(); return; }
    if (!app.lastNavigation?.totalDistance) return;
    if (app.lastNavigation.continuous) window.CScenicMap.setFollowNavigation(true);
    $('#walkingPlay').textContent = 'Ⅱ 暂停演示';
    if (window.CScenicMap.getData().navigationProgress>=1) window.CScenicMap.setNavigationProgress(0);
    map2WalkTimer = setInterval(() => {
      const speed=Number($('#walkingSpeed')?.value||1);
      const next=Math.min(1,window.CScenicMap.getData().navigationProgress+(5*speed)/Number(app.lastNavigation.totalDistance));
      window.CScenicMap.setNavigationProgress(next);
      if(next>=1)stopMap2Walk();
    },500);
  });
  $$('[data-c-layer]').forEach(button => button.onclick = () => { const on = button.classList.toggle('active'); window.CScenicMap.toggleLayer(button.dataset.cLayer, on); });
  $('#mapCrowdHorizon')?.addEventListener('change', event => { window.CScenicMap.setCrowdHorizon(Number(event.target.value)); renderMap2CrowdPanel(); });
  $('#cMapMode').onclick = () => { const mapBox = $('.map-container'), svg = $('#cMapSurface'), leaflet = $('#navMap'); const osm = mapBox.classList.toggle('is-osm'); app.cMapMode = osm ? 'osm' : '2.5d'; svg.classList.toggle('is-osm', osm); leaflet.classList.toggle('is-hidden', !osm); $('#cMapMode').textContent = osm ? '返回景区导航图' : '街道参考底图'; if (osm && app.map) setTimeout(() => app.map.invalidateSize(), 80); };
  if ($('#mapZoomIn')) $('#mapZoomIn').onclick = () => app.cMapMode === '2.5d' ? window.CScenicMap.zoomIn() : app.map?.zoomIn();
  if ($('#mapZoomOut')) $('#mapZoomOut').onclick = () => app.cMapMode === '2.5d' ? window.CScenicMap.zoomOut() : app.map?.zoomOut();
  if ($('#mapLocate')) $('#mapLocate').onclick = () => app.cMapMode === '2.5d' ? window.CScenicMap.locate() : app.map?.setView(SCENIC_CENTER, 17);
  if ($('#mapNorth')) $('#mapNorth').onclick = () => app.cMapMode === '2.5d' && window.CScenicMap.toggleNorthUp();
  if ($('#mapRotateLeft')) $('#mapRotateLeft').onclick = () => app.cMapMode === '2.5d' && window.CScenicMap.rotate(-15);
  if ($('#mapRotateRight')) $('#mapRotateRight').onclick = () => app.cMapMode === '2.5d' && window.CScenicMap.rotate(15);
  if ($('#mapImmersiveToggle')) $('#mapImmersiveToggle').onclick = () => { if (app.cMapMode === '2.5d') window.CScenicMap.toggleImmersive(); };
  if ($('#walkingRecenter')) $('#walkingRecenter').onclick = () => app.cMapMode === '2.5d' ? window.CScenicMap.locate() : app.map?.setView(SCENIC_CENTER, 17);
  window.addEventListener('scenic-user-event', async event => { window.lastScenicUserEvent = event.detail; const selected = $('#plannerEventSelection'); if (selected && event.detail.event_type === 'ROAD_CLICK') selected.textContent = `已选道路：${routeEdgeName(event.detail.edge_id)} · 可封闭或恢复`; if (selected && event.detail.event_type === 'POI_CLICK') selected.textContent = `已选景点：${routeNodeName(event.detail.target_id)} · 可关闭或模拟排队`; try { await api('/api/c/user-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: event.detail }) }); if (event.detail.event_type === 'ROAD_CLICK') toast(`已选择${routeEdgeName(event.detail.edge_id)}`); } catch (error) { toast(`地图事件未送达：${error.message}`); } });
}
async function loadScenicContext() {
  const [graph, state, forecast, crowd, roadNames] = await Promise.all([
    api('/api/v1/scenic-graph'), api('/api/v1/state'), api('/api/v1/environment-forecast?horizon=60&step=10'),
    api('/api/v1/crowd-distribution').catch(() => null),
    fetch('/road-names.json').then(response => response.ok ? response.json() : null).catch(() => null)
  ]);
  const graphWasLoaded = Boolean(app.scenicGraph);
  app.scenicGraph = graph; app.scenicState = state; app.forecast = forecast; app.crowdDistribution = crowd; app.roadNames = roadNames?.names || {};
  window.CScenicMap?.setCrowdHorizon(Number($('#mapCrowdHorizon')?.value || 0));
  if ($('#tripMap')?.tagName !== 'CANVAS') { window.ScenicOverviewMap?.draw('#tripMap', graph); labelMap1Roads(); }
  if (window.CScenicMap) {
    if (graphWasLoaded) { window.CScenicMap.updateState(state, forecast); window.CScenicMap.updateCrowdDistribution(crowd); }
    else window.CScenicMap.update({ graph, state, forecast, crowdDistribution: crowd, roadNames: app.roadNames, plan: app.activePlan });
    window.CScenicMap.update({roadNames:app.roadNames});
    if (app.activePlan) window.CScenicMap.updatePlan(app.activePlan);
  }
  renderMap2CrowdPanel();
  renderEmergencyStatus();
}
function renderMap2CrowdPanel() {
  const panel=$('#mapCrowdPanel');if(!panel)return;
  const entries=app.crowdDistribution?.distribution||[],horizon=Number($('#mapCrowdHorizon')?.value||0);
  const model=app.crowdDistribution?.model;
  if(!entries.length){$('#mapCrowdAverage').textContent='暂不可用';$('#mapComfortAverage').textContent='暂不可用';$('#mapCrowdHotCount').textContent='--';$('#mapCrowdHotspots').textContent='预测数据未载入';return;}
  const byId=new Map((app.scenicGraph?.nodes||[]).map(node=>[node.poi_id,node]));
  const rows=entries.map(item=>{const prediction=item.horizons?.[String(horizon)];const ratio=horizon?Number(prediction?.predicted_crowd_ratio):Number(item.current_crowd_ratio);const node=byId.get(item.poi_id);const shade=Number(node?.shade)||0;return {...item,ratio:Number.isFinite(ratio)?ratio:0,comfort:Math.max(0,Math.min(1,.55*shade+.45*(1-(Number.isFinite(ratio)?ratio:0)))),trend:Number(prediction?.upward_trend_probability)||0};});
  const avg=rows.reduce((sum,row)=>sum+row.ratio,0)/rows.length,comfort=rows.reduce((sum,row)=>sum+row.comfort,0)/rows.length,ranked=[...rows].sort((a,b)=>b.ratio-a.ratio),hot=ranked.filter(row=>row.ratio>=.67);
  $('#mapCrowdAverage').textContent=`${Math.round(avg*100)} / 100`;
  $('#mapComfortAverage').textContent=`${Math.round(comfort*100)} / 100`;
  $('#mapCrowdHotCount').textContent=`${hot.length} 处`;
  $('#mapCrowdHotspots').textContent=(hot.length?hot:ranked.slice(0,3)).slice(0,3).map(row=>`${row.name} ${Math.round(row.ratio*100)}%${horizon&&row.trend>=.6?` · 上升风险 ${Math.round(row.trend*100)}%`:''}`).join(' · ')||'暂无景点数据';
  panel.dataset.sourceTier=model?.source_tier||'unknown';
  panel.title=model?.limitation||'客流趋势根据模拟数据生成，供趋势参考。';
}
function clearMapLayers() { app.mapLayers.forEach(x => x.remove()); app.mapLayers = []; if (app.routeLayer) { app.routeLayer.remove(); app.routeLayer = null; } }
function drawMap(mode = app.mapMode) { if (!app.data) return; initLeafletMap(); if (!app.map) return; app.mapMode = mode; clearMapLayers(); const pos = Object.fromEntries(app.data.graph.nodes.map(n => [n.id, n])); app.data.graph.edges.forEach(([a, b]) => { const e = app.data.graph.edges.find(x => (x[0] === a && x[1] === b) || (x[0] === b && x[1] === a)); const color = mode === 'comfort' ? (e[4] > .72 ? '#39aa87' : e[4] > .45 ? '#e2a54b' : '#d86d5e') : '#538f92'; const line = L.polyline([nodeLatLng(pos[a]), nodeLatLng(pos[b])], { color, weight: mode === 'base' ? 4 : 6, opacity: .72, dashArray: mode === 'base' ? '6 6' : null }).addTo(app.map); app.mapLayers.push(line); }); app.data.graph.nodes.forEach(n => { const crowd = app.data.crowd[n.id] || .2; const event = app.data.events.some(x => x.node === n.id && (x.status === 'live' || x.status === 'upcoming')); const color = mode === 'comfort' ? (n.shade > .72 ? '#36a970' : n.shade > .45 ? '#e1a03e' : '#ce574d') : (crowd < .38 ? '#36a970' : crowd < .65 ? '#e1a03e' : '#ce574d'); const marker = L.circleMarker(nodeLatLng(n), { radius: n.type === 'gate' ? 8 : 10, color: '#fff', weight: 2, fillColor: color, fillOpacity: .95 }).bindPopup(`<b>${n.name}</b><br/>模拟拥挤度 ${Math.round(crowd * 100)}%（模拟客流）<br/>遮阴 ${Math.round(n.shade * 100)}%<br/>${n.tags.join(' · ')}`).addTo(app.map); app.mapLayers.push(marker); if (mode === 'crowd' && crowd > .58) { const heat = L.circle(nodeLatLng(n), { radius: 80 + crowd * 140, color: '#e47b5c', weight: 1, fillColor: '#e47b5c', fillOpacity: .14 }).addTo(app.map); app.mapLayers.push(heat); } if (event) { const eventMarker = L.circleMarker(nodeLatLng(n), { radius: 15, color: '#9b68e7', weight: 2, fill: false, dashArray: '3 3' }).bindTooltip('事件节点').addTo(app.map); app.mapLayers.push(eventMarker); } }); $('#mapLayerState').textContent = mode === 'crowd' ? '模拟人流趋势' : mode === 'comfort' ? '舒适度' : '综合态势'; $('#mapUpdatedAt').textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); app.map.invalidateSize(); }
function setMapTheme(mode = 'base') { app.mapMode = mode; window.CScenicMap?.setTheme(mode); drawMap(mode); if ($('#mapLayerState')) $('#mapLayerState').textContent = mode === 'crowd' ? '人流热力图' : mode === 'comfort' ? '遮阴舒适度图' : '综合导航底图'; if ($('#mapUpdatedAt')) $('#mapUpdatedAt').textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function drawChart() { const s = $('#homeChart'); if (!s || !app.data) return; const points = Object.values(app.data.crowd).map((v, i) => `${i / 12 * 100},${28 - v * 22}`).join(' '); s.innerHTML = `<polyline points="${points}"/>`; }
function renderModel(model = app.data?.worldModel) { if (!model) return; if ($('#modelEnvState')) $('#modelEnvState').textContent = model.state.environment; if ($('#modelUserState')) $('#modelUserState').textContent = model.state.user; if ($('#modelConfidence')) $('#modelConfidence').textContent = model.source_mode === 'synthetic_rule_simulation' ? '模拟估计' : `${model.horizon?.[0]?.confidence || '待评估'}%`; if ($('#homeForecast')) $('#homeForecast').innerHTML = (model.horizon || []).map(x => `<span><b>${x.label}</b><small>人流 ${x.crowd}% · ${model.source_mode === 'synthetic_rule_simulation' ? '模拟' : `置信 ${x.confidence}%`}</small></span>`).join(''); }
function renderVector(p) { const weights = p && typeof p === 'object' ? p : { time: .18, interest: .16, comfort: .16, freedom: .12, culture: .11, nature: .1, performance: .09, food: .08 }; const names = { time: '时间效率', interest: '综合兴趣', comfort: '舒适负荷', freedom: '自由探索', culture: '历史文化', nature: '自然景观', performance: '演艺活动', food: '美食市集' }; const el = $('#preferenceVector'); if (!el) return; el.innerHTML = Object.entries(names).sort((a, b) => (weights[b[0]] || 0) - (weights[a[0]] || 0)).map(([k, v]) => `<div class="vector-row"><div class="vector-head"><span>${v}</span><b>${Math.round((weights[k] || 0) * 100)}%</b></div><div class="vector-track"><i style="width:${Math.round((weights[k] || 0) * 100)}%"></i></div></div>`).join(''); }
function renderPreferenceProfile(profile) { if (!profile) return; if ($('#weightState')) $('#weightState').textContent = `可信度 ${profile.profile.confidence}%`; if ($('#preferenceSummary')) $('#preferenceSummary').innerHTML = `<b>主要倾向：${profile.profile.top_factors.map(key => profile.labels[key]).join('、')}</b><span>单段步行 ≤ ${profile.constraints.max_walk_per_leg_min} 分钟 · 排队 ≤ ${profile.constraints.max_queue_min} 分钟${profile.constraints.require_rest ? ' · 建议安排休息' : ''}</span><small>权重已直接进入每个候选动作的效用评分，不只是展示标签。</small>`; }
function surveyCompletion() { const scales = scaleQuestions.filter(([key]) => app.answers[key] !== undefined).length; const score = (app.answers.type ? 15 : 0) + (app.answers.group ? 5 : 0) + (app.answers.mobility ? 5 : 0) + (app.answers.interests.length ? 10 : 0) + Math.round(scales / scaleQuestions.length * 65); return Math.min(100, score); }
function updateSurveyProgress() { const value = surveyCompletion(); if ($('#surveyProgressText')) $('#surveyProgressText').textContent = `已完成 ${value}%`; if ($('#surveyProgressBar')) $('#surveyProgressBar').style.width = `${value}%`; }
function renderSurvey() {
  // A neutral midpoint is a real, visible default answer; visitors can leave it
  // as-is or adjust it. This keeps completion and planning payloads consistent.
  scaleQuestions.forEach(([key]) => { if (app.answers[key] === undefined) app.answers[key] = 3; });
  const t = $('#surveyType');
  t.innerHTML = surveyTypes.map(x => `<article class="type-option ${app.answers.type === x[0] ? 'selected' : ''}"><div class="type-mark">${x[0] === 'fast' ? '⚡' : x[0] === 'normal' ? '◐' : '✦'}</div><h4>${x[1]}</h4><p>${x[2]}</p><button data-type="${x[0]}">${app.answers.type === x[0] ? '已选择' : '选择'}</button></article>`).join('');
  $$('[data-type]').forEach(b => b.onclick = () => { app.answers.type = b.dataset.type; renderSurvey(); });
  $('#surveyContext').innerHTML = `<div><b>同行人群</b>${surveyGroups.map(x => `<button class="choice-chip ${app.answers.group === x[0] ? 'selected' : ''}" data-group="${x[0]}">${x[1]}</button>`).join('')}</div><div><b>步行能力</b>${mobilityOptions.map(x => `<button class="choice-chip ${app.answers.mobility === x[0] ? 'selected' : ''}" data-mobility="${x[0]}">${x[1]}</button>`).join('')}</div>`;
  $$('[data-group]').forEach(b => b.onclick = () => { app.answers.group = b.dataset.group; renderSurvey(); });
  $$('[data-mobility]').forEach(b => b.onclick = () => { app.answers.mobility = b.dataset.mobility; renderSurvey(); });
  $('#surveyInterests').innerHTML = interestOptions.map(x => `<button class="choice-chip ${app.answers.interests.includes(x[0]) ? 'selected' : ''}" data-interest="${x[0]}">${x[1]}</button>`).join('');
  $$('[data-interest]').forEach(b => b.onclick = () => { const key = b.dataset.interest; app.answers.interests = app.answers.interests.includes(key) ? app.answers.interests.filter(x => x !== key) : [...app.answers.interests, key]; renderSurvey(); });
  $('#surveyScales').innerHTML = `<div class="scale-progress-state"><span id="scaleProgressText">偏好已就绪 ${scaleQuestions.length}/${scaleQuestions.length} 项</span><small>默认中间值 3/5，可按需调整</small><i><b id="scaleProgressBar" style="width:100%"></b></i></div>` + scaleQuestions.map(([key, title, left, right]) => { const value = Number(app.answers[key] ?? 3); return `<label><span><b>${title}</b><em>${value}/5${app.touchedScales.has(key) ? ' · 已调整' : ' · 默认值'}</em></span><div><small>${left}</small><input type="range" min="1" max="5" step="1" value="${value}" style="--range-fill:${(value - 1) * 25}%" data-scale="${key}"/><small>${right}</small></div></label>`; }).join('');
  $$('[data-scale]').forEach(input => input.oninput = () => { const key = input.dataset.scale; app.answers[key] = Number(input.value); input.style.setProperty('--range-fill', `${(Number(input.value) - 1) * 25}%`); app.touchedScales.add(key); input.closest('label').querySelector('em').textContent = `${input.value}/5 · 已调整`; updateScaleProgress(); updateSurveyProgress(); });
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
function updateScaleProgress() {
  if ($('#scaleProgressText')) $('#scaleProgressText').textContent = `偏好已就绪 ${scaleQuestions.length}/${scaleQuestions.length} 项 · 已主动调整 ${app.touchedScales.size} 项`;
  if ($('#scaleProgressBar')) $('#scaleProgressBar').style.width = '100%';
}
function routeNodeName(id) {
  if (id === undefined || id === null || id === '') return '未指定地点';
  const key = String(id);
  // Route actions may carry either a Map 1 node_id or a poi_id. Resolve both
  // against the canonical graph so itinerary, navigation, and event labels
  // always use the same Map 1 display name.
  const canonical = app.scenicGraph?.nodes?.find(node =>
    node.node_id === key || node.id === key || node.poi_id === key
  );
  const legacy = app.data?.graph?.nodes?.find(node => node.id === key);
  return canonical?.name || legacy?.name || key;
}
function routeEdgeName(edgeId) {
  return app.roadNames?.[edgeId]?.name || '景区步道（名称待补）';
}
function labelMap1Roads() {
  const map = $('#tripMap');
  if (!map) return;
  for (const path of map.querySelectorAll('[data-overview-edge]')) {
    const entry = app.roadNames?.[path.getAttribute('data-overview-edge')];
    if (!entry) continue;
    const basis = entry.basis === 'public_name_segment_inferred' ? '公开资料中的道路名称参考，具体分段为项目推定' : '项目拟名';
    let title = path.querySelector('title');
    if (!title) { title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); path.append(title); }
    title.textContent = `${entry.name} · ${basis} · 示意路名，非官方逐段命名`;
    path.setAttribute('aria-label', title.textContent);
  }
}
function poiBriefingHtml(nodeId) {
  const source = app.poiBriefings?.source;
  const entry = app.poiBriefings?.briefings?.[nodeId];
  const text = entry?.text || '沿着景点名字，为这段行程留下一句故事。';
  const attribution = entry?.mode === 'creative_story'
    ? '<small>主题故事 · 文学化导览，不代表历史事实或当日活动安排</small>'
    : entry && source?.url
      ? `<small>参考：<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title || '公开景区介绍')}</a> · 非当日运营信息；地图落位未核实</small>`
      : '<small>暂无已核对的景点介绍来源</small>';
  return `<div class="poi-briefing"><b>景点简说</b><p>${escapeHtml(text)}</p>${attribution}</div>`;
}
function planTargetName(item) { return routeNodeName(item?.target_node_id || item?.target_id); }
function planActionLabel(item) { const target = planTargetName(item); if (item?.action_type === 'EXIT') return `前往${target}（离园）`; if (item?.action_type === 'WAIT') return Number(item.visit_duration_min || 0) > 20 ? '等待景点开放' : '短暂等待'; if (item?.action_type === 'REST') return `休息 · ${target}`; return target; }
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
  controls.innerHTML = '<button type="button" data-overview-action="reset" aria-label="回到全图" title="回到全图">◎</button><button type="button" data-overview-action="zoom-in" aria-label="放大地图" title="放大">＋</button><button type="button" data-overview-action="zoom-out" aria-label="缩小地图" title="缩小">－</button>';
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
function tripEdgePoints(edgeId, fromId, toId) {
  const layout = window.ScenicMapLayout, edge = app.scenicGraph?.edges?.find(item => item.edge_id === edgeId);
  if (!layout || !edge || !fromId || !toId) return [];
  // The rectangular C map has its own hand-tuned curved road network.  Use it
  // directly instead of projecting the long reference map into a straight
  // endpoint-to-endpoint line.  Reverse the path for a bidirectional edge.
  const canvasPath = layout.overviewCanvasEdges?.[edgeId];
  if (overviewCanvasMode() && canvasPath?.length >= 2) {
    return edge.from_node_id === toId && edge.to_node_id === fromId
      ? [...canvasPath].reverse() : canvasPath;
  }
  let points = layout?.edges?.[edgeId];
  if (!points) return [];
  if (edge.from_node_id === toId && edge.to_node_id === fromId) points = [...points].reverse();
  return overviewEdgePoints(points, fromId, toId);
}
function tripEdgePath(edgeId, fromId, toId) {
  return smoothProjectedPath(tripEdgePoints(edgeId, fromId, toId));
}
function validateTripLeg(item) {
  const route = item?.route || {}, nodes = route.node_sequence, edges = route.edge_sequence;
  if (item?.action_type === 'WAIT' && (!Array.isArray(nodes) || nodes.length === 0) && (!Array.isArray(edges) || edges.length === 0)) return { valid: true };
  if (!Array.isArray(nodes) || !Array.isArray(edges) || nodes.length !== edges.length + 1) return { valid: false, reason: '节点与道路段数量不匹配' };
  if (item?.target_node_id && nodes.at(-1) !== item.target_node_id) return { valid: false, reason: '路线终点与计划景点不一致' };
  const graphEdges = new Map((app.scenicGraph?.edges || []).map(edge => [edge.edge_id, edge]));
  const layout = window.ScenicMapLayout;
  for (let index = 0; index < edges.length; index++) {
    const edge = graphEdges.get(edges[index]), fromId = nodes[index], toId = nodes[index + 1];
    if (!layout?.nodes?.[fromId] || !layout?.nodes?.[toId] || !edge) return { valid: false, reason: `路网缺少节点或道路 ${edges[index]}` };
    const forward = edge.from_node_id === fromId && edge.to_node_id === toId;
    const reverse = edge.bidirectional !== false && edge.from_node_id === toId && edge.to_node_id === fromId;
    if (!forward && !reverse) return { valid: false, reason: `道路 ${edges[index]} 与规划节点顺序不一致` };
    const points = tripEdgePoints(edges[index], fromId, toId);
    const start = overviewRoutePointForNode(fromId, layout.nodes[fromId]);
    const end = overviewRoutePointForNode(toId, layout.nodes[toId]);
    if (points.length < 2 || Math.hypot(points[0][0] - start[0], points[0][1] - start[1]) > 1.25 || Math.hypot(points.at(-1)[0] - end[0], points.at(-1)[1] - end[1]) > 1.25) {
      return { valid: false, reason: `道路 ${edges[index]} 的地图线条没有接到对应节点` };
    }
  }
  return { valid: true };
}
function renderTripOverview(plan = app.activePlan || app.planResult) {
  const overlay = $('#tripMapOverlay'), layout = window.ScenicMapLayout;
  if (!overlay || !plan || !layout) return;
  const canvasMode = overviewCanvasMode();
  const overviewWidth = canvasMode ? 2400 : layout.width;
  const overviewHeight = canvasMode ? 1600 : layout.overviewHeight;
  overlay.setAttribute('viewBox', canvasMode ? `0 0 ${overviewWidth} ${overviewHeight}` : `-55 -40 ${overviewWidth + 110} 591`);
  overlay.setAttribute('preserveAspectRatio', 'none');
  const make = (name, attrs = {}, text = '') => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    if (text) element.textContent = text;
    return element;
  };
  overlay.replaceChildren();
  const firstRoute = plan.itinerary?.find(item => item.route?.node_sequence?.length)?.route;
  const originId = firstRoute?.node_sequence?.[0];
  // Render every itinerary leg in order. A route can legally return along the
  // same road; hiding that repeat made the full red line look disconnected.
  const routeLayer = make('g', { class: 'trip-route-layer' });
  const itinerary = plan.itinerary || [];
  const legValidation = itinerary.map(validateTripLeg);
  const invalidLegs = legValidation.flatMap((result, index) => result.valid ? [] : [{ index, reason: result.reason }]);
  const stops = itinerary.filter(item => !['EXIT', 'WAIT'].includes(item.action_type));
  const routeLegs = [];
  for (const [legIndex, item] of itinerary.entries()) {
    const route = item.route || {}, ids = route.node_sequence || [], edges = route.edge_sequence || [];
    const leg = make('g', { class: 'trip-route-leg', 'data-leg-index': legIndex });
    if (!legValidation[legIndex]?.valid) {
      leg.classList.add('is-invalid');
      routeLayer.append(leg);
      routeLegs.push(leg);
      continue;
    }
    const drawnEdges = [];
    edges.forEach((edgeId, index) => {
      const projected = tripEdgePoints(edgeId, ids[index], ids[index + 1]);
      const d = smoothProjectedPath(projected);
      if (!d) return;
      // A leg may traverse the same road again. Keep its directed edge list
      // intact so selecting 2 after 1 shows the actual return through a gate.
      leg.append(make('path', { d, class: 'trip-route-halo', 'data-edge-id': edgeId }));
      leg.append(make('path', { d, class: 'trip-route-line', 'data-edge-id': edgeId }));
      if (projected.length >= 2) {
        const length = projected.slice(1).reduce((sum, point, pointIndex) => sum + Math.hypot(point[0] - projected[pointIndex][0], point[1] - projected[pointIndex][1]), 0);
        drawnEdges.push({ edgeId, points: projected, length });
      }
    });
    // Use one small direction arrow per itinerary leg. Place it near the
    // leg's midpoint (distance weighted), and tag its actual graph edge.
    const totalLength = drawnEdges.reduce((sum, edge) => sum + edge.length, 0);
    let remaining = totalLength * .52;
    const arrowEdge = drawnEdges.find(edge => {
      if (remaining <= edge.length) return true;
      remaining -= edge.length;
      return false;
    });
    if (arrowEdge) {
      let walked = 0;
      for (let index = 1; index < arrowEdge.points.length; index++) {
        const from = arrowEdge.points[index - 1], to = arrowEdge.points[index];
        const segmentLength = Math.hypot(to[0] - from[0], to[1] - from[1]);
        if (walked + segmentLength < remaining) { walked += segmentLength; continue; }
        const t = segmentLength ? Math.max(0, Math.min(1, (remaining - walked) / segmentLength)) : 0;
        const point = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
        const angle = Math.atan2(to[1] - from[1], to[0] - from[0]) * 180 / Math.PI;
        leg.append(make('path', { d: 'M-9,-6 L0,0 L-9,6', transform: `translate(${point[0].toFixed(1)} ${point[1].toFixed(1)}) rotate(${angle.toFixed(1)})`, class: 'trip-leg-arrow', 'data-edge-id': arrowEdge.edgeId, 'data-leg-index': legIndex }));
        break;
      }
    }
    routeLayer.append(leg);
    routeLegs.push(leg);
  }
  overlay.append(routeLayer);
  const origin = layout.nodes[originId] && overviewRoutePointForNode(originId, layout.nodes[originId]);
  if (origin) {
    const pin = make('g', { class: 'trip-current-pin', transform: `translate(${origin[0]} ${origin[1]})` });
    pin.append(make('circle', { r: 31 }), make('text', { y: 6 }, '出发'));
    overlay.append(pin);
  }
  // Only a planned action gets a number. A road running near a landmark does
  // not mean that the visitor entered it or stopped there.
  const displayStops = itinerary.flatMap((item, legIndex) => ['EXIT', 'WAIT'].includes(item.action_type) ? [] : [{ nodeId: item.target_node_id || item.target_id, item, legIndex }]);
  const markerOccurrences = new Map();
  displayStops.forEach(({ nodeId, legIndex }, index) => {
    const point = layout.nodes[nodeId] && overviewRoutePointForNode(nodeId, layout.nodes[nodeId]); if (!point) return;
    const occurrence = markerOccurrences.get(nodeId) || 0;
    markerOccurrences.set(nodeId, occurrence + 1);
    const [x, y] = [point[0] + occurrence * 26, point[1]], group = make('g', { class: 'trip-route-stop', 'data-node-id': nodeId, 'data-stop-index': index + 1, 'data-leg-index': legIndex });
    group.append(make('title', {}, `第 ${index + 1} 站：${routeNodeName(nodeId)}`));
    group.append(make('circle', { cx: x, cy: y, r: 21 }), make('text', { x, y: y + 1 }, String(index + 1)));
    overlay.append(group);
  });
  const exitStep = [...(plan.itinerary || [])].reverse().find(item => item.action_type === 'EXIT');
  $('#tripPlanCaption').textContent = `${plan.label || '为你推荐'} · ${stops.length} 个计划停留 · 红线为规划路线，箭头表示行进方向；点击下方站点高亮对应路段${exitStep ? ` · 从${planTargetName(exitStep)}离园` : ''}${invalidLegs.length ? ` · ${invalidLegs.length} 段未通过地图核验，已隐藏` : ''}`;
  const stopCards = displayStops.map(({ nodeId, item, legIndex }, index) => {
    const pathNodes = item.route?.node_sequence || [];
    const fromName = routeNodeName(pathNodes[0] || (index ? displayStops[index - 1].nodeId : originId));
    const viaNames = pathNodes.slice(1, -1).map(routeNodeName);
    const viaText = viaNames.length ? ` · 途经 ${viaNames.join('、')}` : '';
    const routeIssue = legValidation[legIndex]?.valid ? '' : `<small class="trip-route-integrity-warning">路线未通过地图核验：${escapeHtml(legValidation[legIndex]?.reason || '数据不完整')}</small>`;
    return `<article class="trip-stop" data-leg-index="${legIndex}"><span>第 ${index + 1} 站 · 计划停留</span><b>${escapeHtml(planTargetName(item))}</b><small class="trip-leg-path">从 ${escapeHtml(fromName)} → ${escapeHtml(routeNodeName(nodeId))}${escapeHtml(viaText)}</small><small>预计 ${item.arrival_time?.slice(11, 16) || '--:--'} 到达 · ${Math.round(Number(item.travel_time_min || 0))} 分钟步行</small>${routeIssue}<button type="button" class="trip-leg-select" data-route-leg="${legIndex}" ${routeIssue ? 'disabled' : ''}>在地图上查看这一段</button><em>${item.predicted_queue_min ? `预计排队 ${item.predicted_queue_min} 分钟` : item.action_type === 'ATTEND_EVENT' ? '演出时间窗已校验' : '开放与通行已校验'}</em>${poiBriefingHtml(nodeId)}</article>`;
  }).join('');
  const exitIndex = itinerary.lastIndexOf(exitStep);
  const exitPath = exitStep?.route?.node_sequence || [];
  const exitVia = exitPath.slice(1, -1).map(routeNodeName).join('、');
  const exitIssue = exitStep && !legValidation[exitIndex]?.valid ? `<small class="trip-route-integrity-warning">路线未通过地图核验：${escapeHtml(legValidation[exitIndex]?.reason || '数据不完整')}</small>` : '';
  const exitCard = exitStep ? `<article class="trip-stop trip-stop-exit" data-leg-index="${exitIndex}"><span>离园终点</span><b>${escapeHtml(planTargetName(exitStep))}</b><small class="trip-leg-path">从 ${escapeHtml(routeNodeName(exitPath[0]))} → ${escapeHtml(planTargetName(exitStep))}${exitVia ? ` · 途经 ${escapeHtml(exitVia)}` : ''}</small>${exitIssue}<button type="button" class="trip-leg-select" data-route-leg="${exitIndex}" ${exitIssue ? 'disabled' : ''}>在地图上查看离园路段</button></article>` : '';
  $('#tripStops').innerHTML = stopCards + exitCard || '<div class="trip-empty">当前没有可执行的游览或离园路线。</div>';
  $$('[data-route-leg]', $('#tripStops')).forEach(button => button.onclick = () => selectTripRouteLeg(Number(button.dataset.routeLeg)));
  function selectTripRouteLeg(legIndex) {
    routeLegs.forEach((leg, index) => leg.classList.toggle('is-active', index === legIndex));
    if (routeLegs[legIndex]) routeLayer.append(routeLegs[legIndex]);
    $$('#tripStops .trip-stop').forEach(card => card.classList.toggle('is-active', Number(card.dataset.legIndex) === legIndex));
    $$('#tripMapOverlay .trip-route-stop').forEach(marker => marker.classList.toggle('is-active', Number(marker.dataset.legIndex) === legIndex));
  }
  selectTripRouteLeg(displayStops[0]?.legIndex ?? exitIndex);
  app.tripStops = stops;
  if (app.tripStopIndex >= stops.length) app.tripStopIndex = 0;
  if (window.CScenicMap) window.CScenicMap.updatePlan(plan);
}
function composeRecommendedNavigation(plan = app.activePlan) {
  const itinerary = plan?.itinerary || [], graphNodes = new Map((app.scenicGraph?.nodes || []).map(node => [node.node_id || node.id, node]));
  const graphEdges = new Map((app.scenicGraph?.edges || []).map(edge => [edge.edge_id, edge]));
  const routes = itinerary.filter(item => item.action_type !== 'WAIT' && item.route?.edge_sequence?.length);
  if (!routes.length) throw new Error('推荐路线没有可模拟的步道路段');
  const path = [], edgeSequence = [];
  for (const item of routes) {
    const validation = validateTripLeg(item), nodes = item.route.node_sequence || [], edges = item.route.edge_sequence || [];
    if (!validation.valid) throw new Error(`推荐路线「${planTargetName(item)}」未通过地图1路网核验：${validation.reason}`);
    if (path.length && nodes[0] !== path.at(-1)) throw new Error(`推荐路线在「${planTargetName(item)}」前没有接上上一段，不能拼成连续路线`);
    if (!path.length) path.push(...nodes); else path.push(...nodes.slice(1));
    edgeSequence.push(...edges);
  }
  if (path.length !== edgeSequence.length + 1 || edgeSequence.some((id, index) => {
    const edge = graphEdges.get(id), from = path[index], to = path[index + 1];
    return !edge || !((edge.from_node_id === from && edge.to_node_id === to) || (edge.bidirectional !== false && edge.from_node_id === to && edge.to_node_id === from));
  })) throw new Error('推荐路线与地图1道路顺序不一致，已停止模拟');
  const segments = edgeSequence.map((edgeId, index) => {
    const edge = graphEdges.get(edgeId), from = graphNodes.get(path[index]), to = graphNodes.get(path[index + 1]);
    const road = app.scenicState?.road_states?.[edgeId] || {}, poiState = app.scenicState?.poi_states?.[to?.poi_id] || {};
    if (road.available === false) throw new Error(`推荐路线经过已关闭道路「${routeEdgeName(edgeId)}」，请先重规划`);
    const distance = Math.max(0, Number(edge.distance_m || edge.distance || 0));
    const shade = Number(edge.shade || 0), crowd = Number(poiState.crowd_ratio || 0);
    const fromY = Number(from?.algorithm_y || 0), toY = Number(to?.algorithm_y || 0), slope = Math.round(Math.abs(fromY - toY) / 9);
    return { edge_id: edgeId, from: from?.name || path[index], to: to?.name || path[index + 1], distance, minutes: Number(road.travel_time_min || edge.base_travel_time_min || 0), shade: Math.round(shade * 100), chairs: shade > .7 ? Math.round(4 + shade * 5) : shade > .45 ? 2 : 1, slope, crowd: Math.round(crowd * 100), event: false, warning: crowd > .67 ? '人流较高' : shade < .35 ? '部分暴晒' : slope >= 5 ? '坡度变化' : '通行顺畅' };
  });
  const visitStops = itinerary.filter(item => ['VISIT_POI', 'ATTEND_EVENT'].includes(item.action_type));
  return { from: path[0], to: path.at(-1), path, edgeSequence, totalDistance: segments.reduce((sum, segment) => sum + segment.distance, 0), totalMinutes: segments.reduce((sum, segment) => sum + segment.minutes, 0), segments, objective: 'recommended', continuous: true, stopCount: visitStops.length, stopNodes: visitStops.map(item => item.target_node_id) };
}
function showRecommendedWalk() {
  const route = composeRecommendedNavigation();
  app.navigationMode = 'recommended'; app.tripStopIndex = 0; app.lastNavigation = route;
  if ($('#navFrom')?.querySelector(`option[value="${route.from}"]`)) $('#navFrom').value = route.from;
  if ($('#navTo')?.querySelector(`option[value="${route.to}"]`)) $('#navTo').value = route.to;
  $('#guidedTitle').textContent = '推荐路线全程模拟导航';
  $('#guidedDescription').textContent = `连续路线经过 ${route.stopCount} 个推荐景点，按地图1道路顺序模拟步行；抵达后可继续逐站导航。`;
  $('#guideNextStop').textContent = route.stopCount > 1 ? '切换逐站导航' : '查看路线站点';
  $('#guideNextStop').disabled = false;
  if ($('#walkingInstruction')) $('#walkingInstruction').textContent = '沿推荐路线前行';
  if ($('#walkingDistance')) $('#walkingDistance').textContent = `整条路线 · ${route.stopCount} 个推荐景点 · ${route.edgeSequence.length} 段步道`;
  if ($('#walkingRemain')) $('#walkingRemain').textContent = `剩余 ${Math.round(route.totalDistance)} 米 · ${Math.round(route.totalMinutes)} 分钟`;
  if ($('#walkingDestination')) $('#walkingDestination').textContent = routeNodeName(route.to);
  if ($('#walkingPlay')) $('#walkingPlay').disabled = false;
  if ($('#walkingProgress')) { $('#walkingProgress').disabled = false; $('#walkingProgress').value = '0'; }
  if ($('#walkingProgressValue')) $('#walkingProgressValue').textContent = '0%';
  $('#navSummary').innerHTML = `<div class="nav-summary"><div><b>${Math.round(route.totalDistance)} 米</b><span>推荐路线全程</span></div><div><b>${Math.round(route.totalMinutes)} 分钟</b><span>预计步行</span></div><div><b>${route.stopCount} 个</b><span>计划景点</span></div></div><div class="nav-model-note">整条推荐路线连续模拟 · 按计划顺序经过景点 · 基于地图1示意路网 · ${route.edgeSequence.length} 段步道</div>`;
  $('#segmentList').innerHTML = route.segments.map(segment => `<div class="segment ${segment.warning !== '通行顺畅' ? 'warn' : ''}"><i></i><div><b>${routeEdgeName(segment.edge_id)}</b><small>${segment.from} → ${segment.to} · ${Math.round(segment.distance)} 米 · ${segment.warning}</small></div><em>${Math.round(segment.minutes)} 分钟<br/>人流 ${segment.crowd}%</em></div>`).join('');
  if (window.CScenicMap) window.CScenicMap.updateNavigation(route);
  $('.map-container')?.setAttribute('data-nav-state', 'active');
}
function focusTripStop(index = 0) {
  const stops = app.tripStops || app.activePlan?.itinerary?.filter(item => !['EXIT', 'WAIT'].includes(item.action_type)) || [];
  if (!stops.length) return toast('请先生成可执行游玩路线');
  app.tripStopIndex = Math.max(0, Math.min(index, stops.length - 1));
  const item = stops[app.tripStopIndex]; const target = item.target_node_id;
  if(app.tripStopIndex>0){const previous=stops[app.tripStopIndex-1]?.target_node_id;if(previous&&$('#navFrom')?.querySelector(`option[value="${previous}"]`))$('#navFrom').value=previous;}
  if (target && $('#navTo')?.querySelector(`option[value="${target}"]`)) $('#navTo').value = target;
  $('#guidedTitle').textContent = `${app.tripStopIndex + 1}/${stops.length} · ${planTargetName(item)}`;
  $('#guidedDescription').textContent = `${item.arrival_time?.slice(11, 16) || '预计到达时间待定'} 到达 · ${item.predicted_queue_min ? `预计排队 ${Math.round(item.predicted_queue_min)} 分钟` : '已校验开放状态'} · 详细路段来自当前步行路网`;
  $('#guideNextStop').textContent = app.tripStopIndex < stops.length - 1 ? '查看下一站' : '已是最后一站';
  $('#guideNextStop').disabled = app.tripStopIndex >= stops.length - 1;
  if ($('#navFrom')?.value && target) requestNav({ mode: 'recommended' }).catch(error => toast(error.message));
}
function showTripOverview() {
  app.tripMode = 'overview';
  app.navigationMode = 'free';
  $('#view-navigation')?.classList.remove('is-guiding');
  if (app.activePlan?.itinerary?.length) renderTripOverview(app.activePlan);
  go('navigation');
  requestAnimationFrame(() => $('#tripOverview')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}
function startGuidedTrip() { app.tripMode = 'guiding'; app.navigationMode = app.activePlan?.itinerary?.length ? 'recommended' : 'free'; app.tripStopIndex = 0; if (app.activePlan?.itinerary?.length) { go('navigation', { skipNavigationLoad: true }); try { showRecommendedWalk(); } catch (error) { toast(error.message); focusTripStop(0); } } else { go('navigation'); toast('还没有个性化游程，已打开点到点导航，可先选择起点和目标'); } setTimeout(() => $('#guidedDetail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120); }
async function markTripArrival() {
  const item = app.tripStops?.[app.tripStopIndex]; const nodeId = item?.target_node_id;
  if (!nodeId) return toast('当前站点没有可回报的位置节点');
  try {
    const result = await api('/api/b/demo-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: { event_type: 'PROGRESS_UPDATE', current_node_id: nodeId, target_id: item.target_id, remaining_time_min: Math.max(0, Number(app.data.user.remainingMinutes || 0) - Number(item.travel_time_min || 0) - Number(item.predicted_queue_min || 0) - Number(item.visit_duration_min || 0)), fatigue: Math.min(.95, Number(app.data.user.load || 0) + .08) } }) });
    app.data = result; if (result.planResult) renderItinerary(result.planResult); let checkinNote = ''; if (app.account?.role !== 'guest' && app.data.graph.nodes.some(node => node.id === nodeId && node.poi_id)) { try { await api('/api/community/checkins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node_id: nodeId }) }); loadCommunityPersonal().catch(() => {}); } catch (_) { checkinNote = '；打卡记录未保存'; } } fillNav(); app.tripMode = 'guiding'; $('#view-navigation').classList.add('is-guiding'); await loadNav(); focusTripStop(0); toast(`已记录到达「${routeNodeName(nodeId)}」，路线进度已更新${checkinNote}`);
  } catch (error) { toast(error.message); }
}
async function selectPlanCandidate(candidate, button = null) {
  const switching = Boolean(button && candidate.plan_id && candidate.plan_id !== app.planResult?.plan_id);
  if (switching) {
    $$('.route-candidate').forEach(item => { item.disabled = true; item.classList.toggle('selected', item === button); });
    app.activePlan = candidate;
    $('#routeHint').textContent = '正在切换主方案…';
    renderSelectedPlan(candidate, '正在保存方案选择，已先显示这条路线…');
    try {
      const promoted = await api('/api/b/select-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan_id: candidate.plan_id, action_sequence: (candidate.itinerary || []).map(item => ({ action_type: item.action_type, target_id: item.target_id })), target_sequence: (candidate.itinerary || []).map(item => item.target_node_id || item.target_id) }) });
      app.data.planResult = promoted;
      renderItinerary(promoted);
      setPlanSwitchNote('主方案已切换，路线点位、步道路段和后续导航已同步。');
      toast('主方案已切换，后续导航将按新路线继续');
      return;
    } catch (error) {
      renderItinerary(app.planResult);
      setPlanSwitchNote(`切换没有保存成功，仍保留原主方案。${error.message}`);
      toast(`方案切换失败：${error.message}`);
      return;
    }
  }
  app.activePlan = candidate;
  if (button) { $$('.route-candidate').forEach(x => x.classList.remove('selected')); button.classList.add('selected'); }
  renderSelectedPlan(candidate);
}
function renderSelectedPlan(candidate, status = '') {
  $('#routePlan').innerHTML = routePlanHtml(candidate, status);
  const skip = $('#skipPlanTarget'); if (skip) skip.onclick = skipPlanTarget;
  const overview = $('#showTripOverview'); if (overview) overview.onclick = showTripOverview;
  renderTripOverview(candidate);
  const nextNode = candidate.itinerary?.[0]?.target_node_id;
  if (nextNode && $('#navTo')?.querySelector(`option[value="${nextNode}"]`)) $('#navTo').value = nextNode;
}
function setPlanSwitchNote(message) {
  const summary = $('#routePlan .route-summary');
  if (!summary) return;
  let note = $('#routePlan .plan-switch-note');
  if (!note) { note = document.createElement('p'); note.className = 'plan-switch-note'; note.setAttribute('role', 'status'); summary.insertAdjacentElement('afterend', note); }
  note.textContent = message;
}
function renderItinerary(planResult = null) { if (!planResult) { $('#routeHint').textContent = '等待生成个性化游程'; $('#itinerary').innerHTML = '<div class="empty-itinerary">完成游玩节奏和至少一项情境取舍后，系统将根据预计到达时刻、道路状态和时间窗生成可执行游程。</div>'; return; } app.planResult = planResult; if (!planResult.feasible || !planResult.itinerary?.length) { $('#routeHint').textContent = '当前没有可执行方案'; $('#itinerary').innerHTML = `<div class="empty-itinerary"><b>暂时无法生成可行游程</b><p>${planResult.alternative_message || planResult.reason || '当前时间、开放状态或通行约束下没有满足条件的路线。'}</p><small>可尝试调整离园时间、偏好限制，或在现场变化后重新规划。</small></div>`; return; } const candidates = [{ label: planResult.diagnostics?.useful_action_count ? '推荐路线' : planResult.next_action?.action_type === 'EXIT' ? '离园建议' : '等待后重规划', plan_id: planResult.plan_id, score: planResult.score, next_action: planResult.next_action, itinerary: planResult.itinerary, current_route: planResult.current_route, reason: planResult.reason }, ...(planResult.alternative_plans || []).map((item, index) => ({ ...item, label: `备选 ${index + 1}` }))]; const hasVisitPlan = candidates.some(candidate => (candidate.itinerary || []).some(item => ["VISIT_POI", "ATTEND_EVENT"].includes(item.action_type))); $('#routeHint').textContent = hasVisitPlan ? `已生成 ${candidates.length} 条可执行游览方案` : "当前暂无可安排景点，已提供离园建议"; $('#itinerary').innerHTML = `<div class="plan-contract">${hasVisitPlan ? `<span>从${escapeHtml(routeNodeName(planResult.current_route?.node_sequence?.[0] || app.data?.user?.location))}起步 · 首站优先就近</span>` : `<span>当前暂无可安排景点 · 优先前往${escapeHtml(routeNodeName(planResult.itinerary?.find(item => item.action_type === 'EXIT')?.target_node_id || app.data?.user?.preferredExitNodeId))}</span>`}<span>已参考未来人流趋势（模拟）</span><b>开放、通行和返程约束已校验</b></div><div class="route-candidates">${candidates.map((candidate, index) => { const visitCount = (candidate.itinerary || []).filter(item => ["VISIT_POI", "ATTEND_EVENT"].includes(item.action_type)).length; const directExit = visitCount === 0 && candidate.next_action?.action_type === "EXIT"; const queue = (candidate.itinerary || []).reduce((sum, item) => sum + Number(item.predicted_queue_min || 0), 0); const minutes = (candidate.itinerary || []).reduce((sum, item) => sum + Number(item.travel_time_min || 0) + Number(item.wait_time_min || 0) + Number(item.predicted_queue_min || 0) + Number(item.visit_duration_min || 0), 0); return `<button class="route-candidate ${index === 0 ? 'selected' : ''}" data-plan-index="${index}"><span>${candidate.label}</span><b>${directExit ? "直接离园" : `${visitCount} 个游览点`}</b><small>${directExit ? "当前时间不足以安排游览并按时抵达所选出口" : "已结合你的偏好与预测排序"}</small><em>预计行程 ${Math.round(minutes)} 分钟 · 排队 ${Math.round(queue)} 分钟</em></button>`; }).join('')}</div>${candidates.length === 1 ? `<p class="alternative-note">${hasVisitPlan ? (planResult.alternative_message || '当前约束下没有其他不同的可执行方案') : (planResult.reason || '当前时间不足以安排景点并前往出口')}</p>` : ''}<div class="route-plan" id="routePlan"></div>`; $$('.route-candidate').forEach(button => button.onclick = () => selectPlanCandidate(candidates[Number(button.dataset.planIndex)], button)); selectPlanCandidate(candidates[0]); }
function routePlanHtml(plan, status = '') { const items = plan.itinerary || []; const routeNodes = plan.current_route?.node_sequence || []; const factorNames = { time: '时间', interest: '兴趣', comfort: '舒适', freedom: '探索', culture: '历史文化', nature: '自然景观', performance: '演艺活动', food: '美食市集' }; const canSkip = plan.next_action?.target_id && !['EXIT', 'WAIT'].includes(plan.next_action.action_type); return `<div class="route-summary"><div><b>${plan.label || '规划方案'} · ${items[0] ? planActionLabel(items[0]) : '无目标'}</b><small>${plan.reason || '根据当前状态与未来预测生成'}</small></div><span>${routeNodes.length > 1 ? `当前路线 ${routeNodes.length - 1} 段` : items[0]?.action_type === 'EXIT' ? '当前位置在出口附近，可直接离园' : '当前位置无需移动'}</span></div>${status ? `<p class="plan-switch-note" role="status">${escapeHtml(status)}</p>` : ''}<div class="plan-route">${routeNodes.map((id, index) => `${index ? '<i>→</i>' : ''}<b>${routeNodeName(id)}</b>`).join('')}</div><div class="itinerary">${items.map((item, i) => `<div class="itin-item"><i>${i + 1}</i><strong>${planActionLabel(item)}</strong><small>到达 ${item.arrival_time.slice(11, 16)} · 完成 ${item.completion_time.slice(11, 16)}</small><p>${item.predicted_queue_min ? `预计到达时排队 ${item.predicted_queue_min} 分钟` : item.action_type === 'ATTEND_EVENT' ? '已校验最晚入场时间' : item.action_type === 'EXIT' ? '保留安全离园余量' : item.action_type === 'WAIT' ? '等待至开放时段后继续游览' : '道路和开放状态已校验'}${Number.isFinite(item.predicted_crowd_ratio) ? ` · 模拟拥挤度 ${Math.round(item.predicted_crowd_ratio * 100)}% · 趋势风险 ${Math.round((item.upward_trend_probability || 0) * 100)}%` : ''}${item.preference_dominant_factor ? ` · 主要匹配${factorNames[item.preference_dominant_factor] || item.preference_dominant_factor}` : ''}</p>${['VISIT_POI', 'ATTEND_EVENT'].includes(item.action_type) ? poiBriefingHtml(item.target_node_id || item.target_id) : ''}</div>`).join('')}</div><button class="teal-btn route-start" id="showTripOverview">查看地图 1 · 查看路线 →</button>${canSkip ? '<button class="outline-btn route-replan" id="skipPlanTarget">跳过当前目标并重新规划</button>' : ''}`; }
async function skipPlanTarget() { const target = app.activePlan?.next_action?.target_id; if (!target || !app.planResult) return; const r = await api('/api/b/replan-live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: { schema_version: '0.1', scenario_id: app.planResult.scenario_id, event_type: 'SKIP_TARGET', target_id: target, timestamp: app.planResult.generated_at } }) }); renderItinerary(r); toast('已从当前位置跳过当前目标并重新规划'); }
async function generate() {
  if (!app.answers.type) return toast('请先选择游览节奏');
  if (!app.answers.interests.length) return toast('请至少选择一项最想获得的体验');
  const button = $('#generateRoute');
  if (button?.disabled) return;
  const leaveAt = $('#leaveTime')?.value;
  const current_node_id = $('#currentLocationSelect')?.value || app.data.user.location;
  const exit_node_id = $('#exitNodeSelect')?.value || null;
  const originalLabel = button?.textContent || '生成个性化路线';
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = '正在生成推荐方案…'; }
  $('#routeHint').textContent = '正在核对偏好、步道与时间约束…';
  $('#itinerary').innerHTML = '<div class="planner-loading" role="status"><span class="planner-spinner" aria-hidden="true"></span><div><b>正在生成推荐方案</b><small>正在综合你的偏好，核对景点开放、步行路段、人流模拟和离园时间，请稍候。</small></div></div>';
  try {
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
    toast(`已从${routeNodeName(current_node_id)}生成路线，点击“查看地图 1”查看推荐路线`);
  } catch (error) {
    $('#routeHint').textContent = '路线生成未完成';
    $('#itinerary').innerHTML = `<div class="empty-itinerary"><b>暂时没有收到推荐结果</b><p>${escapeHtml(error.message || '请求失败，请稍后重试。')}</p></div>`;
    toast(`路线生成失败：${error.message}`);
  } finally {
    if (button) { button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = originalLabel; }
  }
}
function fillNav() {
  const nodes=app.data.graph.nodes,fromSelect=$('#navFrom'),toSelect=$('#navTo'),current=app.data.user.location;
  const keptFrom=app.navOrigin===current&&nodes.some(node=>node.id===fromSelect.value)?fromSelect.value:current;
  const keptTo=toSelect.value;
  const target=nodes.some(node=>node.id===keptTo&&node.id!==keptFrom)?keptTo:(app.tripStops?.[app.tripStopIndex]?.target_node_id||'museum');
  fromSelect.innerHTML=nodes.map(node=>`<option value="${node.id}">${node.name}</option>`).join('');
  toSelect.innerHTML=nodes.filter(node=>node.id!==keptFrom).map(node=>`<option value="${node.id}">${node.name}</option>`).join('');
  fromSelect.value=keptFrom;toSelect.value=target===keptFrom?toSelect.options[0]?.value:target;
  if(!toSelect.value&&toSelect.options.length)toSelect.selectedIndex=0;
  app.navOrigin=current;
}
async function loadNav() { fillNav(); await requestNav(); }
function showNavigationError(error) {
  stopMap2Walk();
  const raw=error?.message||'无法生成路线';
  const closed=Object.values(app.scenicState?.road_states||{}).filter(road=>road.available===false).length;
  const badTimes=(app.scenicGraph?.edges||[]).filter(edge=>Number(app.scenicState?.road_states?.[edge.edge_id]?.travel_time_min)>Number(edge.base_travel_time_min)*10).length;
  const message=/no feasible route/i.test(raw)?(badTimes?`演示道路通行时间异常（${badTimes} 段）；请重启本地服务后重试。`:closed?`当前路线不可通行，已有 ${closed} 段演示道路关闭；可更换终点或由管理员恢复道路。`:'当前路网未找到可通行路线；请更换起点或终点。'):raw;
  app.lastNavigation=null;
  if(app.routeLayer){app.routeLayer.remove();app.routeLayer=null;}
  window.CScenicMap?.updateNavigation({path:[],edgeSequence:[]});
  if($('#walkingInstruction'))$('#walkingInstruction').textContent='暂时无法导航';
  if($('#walkingDistance'))$('#walkingDistance').textContent=message;
  if($('#walkingProgress'))$('#walkingProgress').disabled=true;
  if($('#walkingPlay'))$('#walkingPlay').disabled=true;
  if($('#walkingRemain'))$('#walkingRemain').textContent='剩余 -- 米 · -- 分钟';
  if($('#segmentList'))$('#segmentList').replaceChildren();
  if($('#navSummary'))$('#navSummary').innerHTML=`<p class="nav-error">${message.replace(/[<>&"']/g,'')}</p>`;
  $('.map-container')?.setAttribute('data-nav-state','error');
  toast(`导航未开始：${message}`);
}
async function requestNav({ mode = app.navigationMode || 'free' } = {}) {
  app.navigationMode = mode === 'recommended' ? 'recommended' : 'free';
  const from = $('#navFrom').value, to = $('#navTo').value;
  stopMap2Walk();
  if(!from||!to||from===to)throw new Error('请选择不同的起点和终点');
  window.CScenicMap?.setPreviewEndpoints(from,to);
  const r = await api(`/api/navigation?${new URLSearchParams({ from, to, objective: 'distance' })}`);
  const graphEdges=new Map((app.scenicGraph?.edges||[]).map(edge=>[edge.edge_id,edge]));
  if(!Array.isArray(r.path)||!Array.isArray(r.edgeSequence)||r.path.length<2||r.edgeSequence.length!==r.path.length-1||r.edgeSequence.some((id,index)=>{const edge=graphEdges.get(id),a=r.path[index],b=r.path[index+1];return !edge||!((edge.from_node_id===a&&edge.to_node_id===b)||(edge.from_node_id===b&&edge.to_node_id===a));}))throw new Error('返回路线与地图1道路数据不一致');
  app.lastNavigation = r;
  const firstSegment = r.segments?.[0], destination = routeNodeName(to);
  if ($('#walkingInstruction')) $('#walkingInstruction').textContent = firstSegment ? `沿${firstSegment.from}至${firstSegment.to}方向前行` : '已到达目的地附近';
  if ($('#walkingDistance')) $('#walkingDistance').textContent = firstSegment ? `${Math.round(firstSegment.distance)} 米后进入下一路段 · ${firstSegment.warning}` : '请留意现场入口标识';
  if ($('#walkingRemain')) $('#walkingRemain').textContent = `剩余 ${Math.round(r.totalDistance)} 米 · ${Math.round(r.totalMinutes)} 分钟`;
  if ($('#walkingDestination')) $('#walkingDestination').textContent = destination;
  if ($('#walkingPlay')) { $('#walkingPlay').disabled = false; $('#walkingPlay').textContent = '▶ 模拟整条推荐路线'; }
  const routeMode=app.navigationMode==='recommended'?'推荐游程分段导航 · 按计划顺序到达各景点':'自由点到点导航 · 当前路网内最短可行路线';
  $('#navSummary').innerHTML = `<div class="nav-summary"><div><b>${Math.round(r.totalDistance)} 米</b><span>示意距离</span></div><div><b>${Math.round(r.totalMinutes)} 分钟</b><span>预计时间</span></div><div><b>${Math.round(r.segments.reduce((sum, x) => sum + x.shade, 0) / Math.max(1, r.segments.length))}%</b><span>遮阴覆盖</span></div></div><div class="nav-model-note">${routeMode} · 基于地图1示意路网 · ${r.edgeSequence.length} 段步道 · 路名为识别参考（非官方命名）</div>`;
  $('#segmentList').innerHTML = r.segments.map(x => `<div class="segment ${x.warning !== '通行顺畅' ? 'warn' : ''}"><i></i><div><b>${routeEdgeName(x.edge_id)}</b><small>${x.from} → ${x.to} · ${x.distance} 米 · ${x.warning} · 遮阴 ${x.shade}% · 座椅约 ${x.chairs}处 · 坡度 ${x.slope}</small></div><em>${x.minutes} 分钟<br/>人流 ${x.crowd}%${x.event ? '<br/>事件节点' : ''}</em></div>`).join('');
  if (window.CScenicMap) window.CScenicMap.updateNavigation(r);
  const poiDetail=$('#cPoiDetail');if(poiDetail)poiDetail.hidden=true;
  $('.map-container')?.setAttribute('data-nav-state','active');
  drawMap();
  if (app.map && window.L) { const pos = Object.fromEntries(app.data.graph.nodes.map(n => [n.id, n])); if (app.routeLayer) app.routeLayer.remove(); app.routeLayer = L.polyline(r.path.map(id => nodeLatLng(pos[id])), { color: '#10aeb1', weight: 7, opacity: .92 }).addTo(app.map); if (app.routeLayer.getBounds().isValid()) app.map.fitBounds(app.routeLayer.getBounds(), { padding: [28, 28] }); }
  return r;
}
function renderCompanions() {
  if (!$('#companionCards')) return;
  if (!$('#companionCards').children.length) $('#companionCards').innerHTML = companions.map((x, i) => `<div class="companion-card ${i === 0 ? 'selected' : ''}" data-companion="${x[0]}" data-index="${i}"><div class="portrait ${x[4]}">${x[1][1]}</div><b>${x[1]} · ${x[2]}</b><small>${x[3]}</small></div>`).join('');
  if (!app.selectedCompanion) app.selectedCompanion = companions[0][0];
  const select = id => { const x = companions.find(item => item[0] === id) || companions[0]; app.selectedCompanion = x[0]; $$('.companion-card').forEach(card => card.classList.toggle('selected', card.dataset.companion === x[0])); $('#companionName').textContent = `${x[1]} · ${x[2]}`; const avatar = $('.chat-avatar'); if (avatar) { avatar.textContent = x[1][1]; avatar.className = `chat-avatar ${x[4]}`; } if ($('#companionContext')) $('#companionContext').textContent = `当前表达风格：${x[2]}；回答仍以可核实资料为准`; };
  $$('.companion-card').forEach(card => card.onclick = () => { select(card.dataset.companion); toast(`已选择${companions.find(item => item[0] === app.selectedCompanion)[1]}作为虚拟伴侣`); });
  select(app.selectedCompanion);
  $$('.quick-prompts button').forEach(button => button.onclick = () => { $('#companionQuestion').value = button.dataset.prompt; askCompanion(); });
  const visitor = app.account?.role === 'visitor';
  const routePermission = $('#companionRoutePermission'); if (routePermission) { routePermission.disabled = !visitor; if (!visitor) routePermission.checked = false; }
  const toggleButton = (toggleId, buttonId) => { const toggle = $(`#${toggleId}`), button = $(`#${buttonId}`); if (!toggle || !button) return; button.disabled = !toggle.checked; toggle.onchange = () => { button.disabled = !toggle.checked; }; };
  const arrivalToggle = $('#companionArrivalEnabled');
  if (arrivalToggle) arrivalToggle.onchange = () => {
    if (arrivalToggle.checked) startCompanionGps(); else { stopCompanionGps(); stopCompanionAudio(); }
  };
  toggleButton('companionRestEnabled', 'askRestAdvice');
  toggleButton('companionEmergencyEnabled', 'openCompanionEmergency');
  const explain = $('#explainNextStop'); if (explain) { explain.disabled = false; explain.onclick = () => { const next = $('#companionNext')?.textContent || '下一站'; $('#companionQuestion').value = `请为我的下一站“${next}”做简短讲解，只介绍景区资料能够支持的内容。`; askCompanion(); }; }
  const rest = $('#askRestAdvice'); if (rest) rest.onclick = () => { $('#companionQuestion').value = '请结合当前游览进度给我一个休息建议；不要编造休息设施的位置或开放状态。'; askCompanion(); };
  const emergency = $('#openCompanionEmergency'); if (emergency) emergency.onclick = () => go('emergency');
  if (app.data) { $('#companionLocation').textContent = routeNodeName(app.data.user.location); $('#companionRemaining').textContent = `${app.data.user.remainingMinutes} 分钟`; const next = app.tripStops?.[app.tripStopIndex]?.target_node_id || app.data.routes?.[0]?.stops?.[0]; if (next) $('#companionNext').textContent = routeNodeName(next); }
}
function stopCompanionGps() {
  companionGpsGeneration++;
  if (companionGpsWatchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(companionGpsWatchId);
  companionGpsWatchId = null;
  companionGpsArrivals.clear();
  if ($('#companionArrivalEnabled')?.checked !== true) setCompanionGpsStatus('到点讲解已关闭；本页面不再读取位置。', 'idle');
}
function setCompanionGpsStatus(message, state = 'waiting') {
  const status = $('#companionGpsStatus');
  if (!status) return;
  status.textContent = message;
  status.dataset.state = state;
}
function gpsDistanceMeters(lat1, lon1, lat2, lon2) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function verifiedCompanionGpsPois() {
  const graphNodeIds = new Set((app.data?.graph?.nodes || []).map(item => item.id));
  return (app.poiGps?.pois || []).filter(item => item.verification_status === 'verified'
    && typeof item.source === 'string' && item.source.trim()
    && typeof item.node_id === 'string' && graphNodeIds.has(item.node_id)
    && Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude))
    && Number(item.latitude) >= -90 && Number(item.latitude) <= 90
    && Number(item.longitude) >= -180 && Number(item.longitude) <= 180);
}
function companionGpsRadius(point) { return Math.max(20, Math.min(100, Number(point.radius_m) || 35)); }
function onCompanionGpsPosition(position) {
  const coords = position?.coords;
  if (!coords) { setCompanionGpsStatus('定位结果不完整，正在等待下一次定位。', 'waiting'); return; }
  const accuracy = Number(coords.accuracy);
  if (!Number.isFinite(accuracy) || accuracy > 50) {
    const accuracyText = Number.isFinite(accuracy) ? `约 ${Math.round(accuracy)} 米` : '暂不可用';
    setCompanionGpsStatus(`定位精度${accuracyText}，暂不触发讲解；请在室外等待定位稳定。`, 'waiting');
    return;
  }
  const latitude = Number(coords.latitude), longitude = Number(coords.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    setCompanionGpsStatus('本次定位坐标无效，正在等待下一次定位。', 'waiting');
    return;
  }
  const points = verifiedCompanionGpsPois();
  if (!points.length) {
    setCompanionGpsStatus('景区尚无与地图1节点对应的核实坐标，已停止定位，不会误触发讲解。', 'unavailable');
    stopCompanionGps();
    if ($('#companionArrivalEnabled')) $('#companionArrivalEnabled').checked = false;
    return;
  }
  const now = Date.now();
  const nearest = points.map(point => ({ point, distance: gpsDistanceMeters(latitude, longitude, Number(point.latitude), Number(point.longitude)) }))
    .sort((a, b) => a.distance - b.distance);
  const candidate = nearest.find(({ point, distance }) => distance <= companionGpsRadius(point));
  for (const [nodeId, state] of companionGpsArrivals) {
    const point = points.find(item => item.node_id === nodeId);
    const current = nearest.find(item => item.point.node_id === nodeId);
    const exitRadius = point ? companionGpsRadius(point) + Math.max(25, Math.min(50, accuracy)) : 0;
    if (!current || current.distance > exitRadius || (!state.announced && candidate?.point.node_id !== nodeId)) companionGpsArrivals.delete(nodeId);
  }
  const announced = [...companionGpsArrivals.entries()].find(([, state]) => state.announced);
  if (announced && candidate?.point.node_id !== announced[0]) {
    const name = (app.data?.graph?.nodes || []).find(item => item.id === announced[0])?.name || announced[0];
    setCompanionGpsStatus(`已确认到达${name}；请离开该景点定位范围后，再触发其他景点讲解。`, 'active');
    return;
  }
  if (!candidate) {
    const closest = nearest[0];
    const distanceText = closest ? `，最近的已核实景点约 ${Math.round(closest.distance)} 米` : '';
    setCompanionGpsStatus(`定位正常，精度约 ${Math.round(accuracy)} 米${distanceText}；进入范围并稳定停留后自动讲解。`, 'active');
    return;
  }
  const point = candidate.point;
  let arrival = companionGpsArrivals.get(point.node_id);
  if (!arrival || now - arrival.lastSeen > 12000) {
    arrival = { since: now, lastSeen: now, samples: 1, announced: false };
    companionGpsArrivals.set(point.node_id, arrival);
  } else {
    arrival.lastSeen = now;
    arrival.samples++;
  }
  const node = (app.data?.graph?.nodes || []).find(item => item.id === point.node_id);
  const briefing = app.poiBriefings?.briefings?.[point.node_id];
  if (arrival.announced) {
    setCompanionGpsStatus(`已到达${node?.name || point.node_id}；本次到访讲解已触发。`, 'active');
    return;
  }
  if (arrival.samples < 3 || now - arrival.since < 5000) {
    setCompanionGpsStatus(`已进入${node?.name || '景点'}定位范围，正在确认位置稳定性。`, 'waiting');
    return;
  }
  arrival.announced = true;
  if (node && briefing?.mode === 'public_reference' && briefing.text) {
    const generation = companionGpsGeneration;
    const stillEnabled = () => generation === companionGpsGeneration
      && $('#companionArrivalEnabled')?.checked === true
      && $('#companionVoiceConsent')?.checked === true;
    const text = `已到达${node.name}。${briefing.text}`;
    setCompanionGpsStatus(`已确认到达${node.name}，正在准备语音讲解。`, 'active');
    speakCompanionReply(text, stillEnabled).then(started => {
      if (generation !== companionGpsGeneration) return;
      setCompanionGpsStatus(started ? `已到达${node.name}，景点讲解已开始播放。` : `已确认到达${node.name}，但设备未能开始播放语音；可点击“讲解下一站”继续查看文字讲解。`, started ? 'active' : 'error');
    });
  } else setCompanionGpsStatus(`已到达${node?.name || point.node_id}；该景点暂无已审核的自动播报讲解资料。`, 'unavailable');
}
function startCompanionGps() {
  if (!$('#companionVoiceConsent')?.checked) {
    $('#companionArrivalEnabled').checked = false;
    setCompanionGpsStatus('请先同意将讲解文字发送给语音合成服务，再开启到点讲解。', 'error');
    return toast('请先同意语音合成播报');
  }
  if (!navigator.geolocation) {
    $('#companionArrivalEnabled').checked = false;
    setCompanionGpsStatus('此设备或浏览器不支持定位。', 'error');
    return toast('当前浏览器不支持定位');
  }
  const points = verifiedCompanionGpsPois();
  if (!points.length) {
    $('#companionArrivalEnabled').checked = false;
    setCompanionGpsStatus('自动到点讲解暂不可用：还没有与地图1节点对应的核实坐标。本次不会申请或读取手机位置。', 'unavailable');
    return;
  }
  if (companionGpsWatchId !== null) return;
  setCompanionGpsStatus('正在请求定位权限；请允许本页面访问位置，并保持页面打开。', 'waiting');
  const watchGeneration = ++companionGpsGeneration;
  try {
    companionGpsWatchId = navigator.geolocation.watchPosition(position => {
      if (watchGeneration === companionGpsGeneration && $('#companionArrivalEnabled')?.checked === true) onCompanionGpsPosition(position);
    }, error => {
      if (watchGeneration !== companionGpsGeneration) return;
      companionGpsGeneration++;
      const failedWatchId = companionGpsWatchId;
      companionGpsWatchId = null;
      if (failedWatchId !== null) navigator.geolocation.clearWatch(failedWatchId);
      companionGpsArrivals.clear();
      $('#companionArrivalEnabled').checked = false;
      const messages = { 1: '定位权限未允许；请在浏览器设置中允许本页访问位置后重试。', 2: '暂时无法取得位置，请检查手机定位服务后重试。', 3: '定位超时；请确认系统定位已开启并重试。' };
      setCompanionGpsStatus(messages[error.code] || '定位暂不可用，请关闭后重新开启到点讲解。', 'error');
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  } catch (_) {
    companionGpsWatchId = null;
    $('#companionArrivalEnabled').checked = false;
    setCompanionGpsStatus('无法启动定位；请确认当前页面使用 HTTPS 或 localhost 后重试。', 'error');
  }
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
async function askCompanion() { const q = $('#companionQuestion').value.trim(); if (!q) return toast('请输入想问旅伴的问题'); try { const includeRoute = $('#companionRoutePermission')?.checked === true; const r = await api('/api/companion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, companion_id: app.selectedCompanion || 'guide', permissions: { route: includeRoute, preferences: includeRoute } }) }); const sources = [...new Set((r.sources || []).map(source => String(source.title || '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 2); const attribution = sources.length ? ` · 资料：${sources.join('、')}` : ''; $('#chatMessages').insertAdjacentHTML('beforeend', `<div class="message user">${escapeHtml(q)}</div><div class="message bot">${escapeHtml(r.answer)}<small class="message-meta">${escapeHtml('陪伴已回复' + attribution)}</small></div>`); $('#companionQuestion').value = ''; if ($('#companionRoutePermission')) $('#companionRoutePermission').checked = false; const box = $('#chatMessages'); box.scrollTop = box.scrollHeight; if ($('#companionSpeakReplies')?.checked) speakCompanionReply(r.answer); } catch (error) { toast(error.message); } }
let companionVoiceConfig = null, companionAudio = null, companionAudioUrl = null;
function stopCompanionAudio() {
  companionAudio?.pause(); companionAudio = null;
  if (companionAudioUrl) URL.revokeObjectURL(companionAudioUrl);
  companionAudioUrl = null;
  window.speechSynthesis?.cancel();
  const stop = $('#stopCompanionSpeech'); if (stop) stop.disabled = true;
}
function speakWithBrowser(text) {
  if (!('speechSynthesis' in window)) { toast('当前浏览器不支持语音朗读'); return false; }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(String(text || ''));
  utterance.lang = 'zh-CN'; utterance.rate = 1;
  const stop = $('#stopCompanionSpeech'); if (stop) stop.disabled = false;
  utterance.onend = utterance.onerror = () => { if (stop) stop.disabled = true; };
  window.speechSynthesis.speak(utterance);
  return true;
}
async function speakCompanionReply(text, isAllowed = () => true) {
  if (!$('#companionVoiceConsent')?.checked) { toast('请先同意将讲解文字发送给语音合成服务播报'); return false; }
  if (!isAllowed()) return false;
  if (companionVoiceConfig?.tts_ready) {
    try {
      const result = await api('/api/companion/voice/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: String(text || '').slice(0, 800), voice: app.selectedCompanion || 'guide' }) });
      if (!isAllowed()) return false;
      const bytes = Uint8Array.from(atob(result.audio_base64), char => char.charCodeAt(0));
      stopCompanionAudio();
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mime_type }));
      companionAudioUrl = url; companionAudio = new Audio(url);
      const stop = $('#stopCompanionSpeech'); if (stop) stop.disabled = false;
      companionAudio.onended = companionAudio.onerror = stopCompanionAudio;
      await companionAudio.play(); return true;
    } catch (_) { stopCompanionAudio(); companionVoiceConfig = null; }
  }
  if (!isAllowed()) return false;
  return speakWithBrowser(text);
}
async function setupCompanionVoiceControls() {
  const stop = $('#stopCompanionSpeech'); if (stop) stop.onclick = stopCompanionAudio;
  const consent = $('#companionVoiceConsent');
  if (consent) consent.onchange = () => {
    if (!consent.checked) {
      stopCompanionAudio(); stopCompanionGps();
      if ($('#companionArrivalEnabled')) $('#companionArrivalEnabled').checked = false;
      setCompanionGpsStatus('已撤回语音播报授权，定位与自动讲解已关闭。', 'idle');
    }
  };
  companionVoiceConfig = await api('/api/companion/voice').catch(() => null);
  const status = $('#companionVoiceStatus');
  const speechAvailable = Boolean(companionVoiceConfig?.tts_ready || ('speechSynthesis' in window));
  if (status) status.textContent = speechAvailable ? '语音合成已准备好，可朗读文字回复；不会采集或识别你的语音。' : '当前设备暂不支持语音合成。';
  const source = $('#view-companion .companion-source small');
  if (source) source.textContent = '系统只将文字回复发送给语音合成服务播报，不采集或识别游客语音。自动到点讲解需要授权定位，并且只对已核实坐标的景点生效。';
}
function renderCrowd() {
  const predicted = app.crowdDistribution?.distribution;
  if (Array.isArray(predicted) && predicted.length) {
    const rows = [...predicted].sort((a, b) => (b.horizons?.[15]?.predicted_crowd_ratio || 0) - (a.horizons?.[15]?.predicted_crowd_ratio || 0)).slice(0, 8);
    const target = $('#crowdBars');
    if (target) target.innerHTML = `<p class="crowd-model-source">场景校准拥挤度 + 模型上升风险 · 15分钟客流趋势预测</p>${rows.map(item => {
      const ratio = item.horizons?.[15]?.predicted_crowd_ratio ?? item.current_crowd_ratio ?? 0;
      const risk = item.horizons?.[15]?.upward_trend_probability ?? 0;
      const color = ratio < .5 ? '#75a88d' : ratio < .7 ? '#d39b54' : '#c95248';
      return `<div class="crowd-row"><span>${escapeHtml(item.name)}</span><i aria-label="15分钟模拟拥挤度 ${Math.round(ratio * 100)}%"><b style="width:${Math.round(ratio * 100)}%;background:${color}"></b></i><em>${Math.round(ratio * 100)}% · 上升风险 ${Math.round(risk * 100)}%</em></div>`;
    }).join('')}`;
    renderEmergencyStatus();
    return;
  }
  const rows = (app.data?.graph?.nodes || []).filter(item => item.poi_id && Number.isFinite(Number(app.data.crowd?.[item.id])))
    .map(item => ({ id: item.id, name: item.name, capacity: Number(item.capacity || 100), ratio: Math.max(0, Math.min(1, Number(app.data.crowd[item.id]))) }))
    .sort((a, b) => b.ratio - a.ratio).slice(0, 8);
  const target = $('#crowdBars');
  if (target) target.innerHTML = rows.length ? rows.map(item => `<div class="crowd-row"><span>${escapeHtml(item.name)}</span><i aria-label="模拟拥挤度 ${Math.round(item.ratio * 100)}%"><b style="width:${Math.round(item.ratio * 100)}%;background:${item.ratio < .5 ? '#75a88d' : item.ratio < .7 ? '#d39b54' : '#c95248'}"></b></i><em>${Math.round(item.ratio * 100)}%</em></div>`).join('') : '<p>暂无可用的区域状态。</p>';
  renderEmergencyStatus();
}
function renderEmergencyStatus() {
  const target = $('#emergencyStatus'); if (!target || !app.data) return;
  const graph = app.scenicGraph || { edges: [], nodes: [] };
  const closed = (app.data.emergency?.closed || []).map(id => routeEdgeName(id));
  const active = Object.values(app.scenicState?.event_states || {}).filter(event => ['live','upcoming','active'].includes(event.status) && !event.cancelled)
    .map(event => `${event.title || event.event_id}（${routeNodeName(event.node_id)}）`);
  target.innerHTML = `<div class="emergency-state-line"><b>路段</b><span>${closed.length ? `演示封闭：${closed.map(escapeHtml).join('、')}` : '当前演示状态未标记封闭路段'}</span></div><div class="emergency-state-line"><b>事件</b><span>${active.length ? active.map(escapeHtml).join('；') : '当前没有活动事件记录'}</span></div><small>状态来自本地演示数据，可能与现场不一致；请以景区公告和工作人员指引为准。</small>`;
  const notice = $('#emergencyNotice');
  if (notice) notice.textContent = closed.length ? `演示路网标记 ${closed.length} 段封闭；规划器会避开不可用路段。现场通行情况请向工作人员核实。` : '演示路网当前未标记封闭路段。';
  const distribution = app.crowdDistribution?.distribution || [];
  if (distribution.length) {
    let panel = $('#crowdModelDetails');
    if (!panel) { $('.emergency-grid')?.insertAdjacentHTML('afterend', '<details class="card crowd-model-details" id="crowdModelDetails"><summary><span><b>地图1景点人流动态</b><small>模拟推演 · 客流参考人数 · 展开查看拥挤趋势</small></span><i>查看数据</i></summary><p class="crowd-model-source"></p><div class="crowd-model-horizons"></div></details>'); panel = $('#crowdModelDetails'); }
    panel.querySelector('.crowd-model-source').textContent = `模型 ${app.crowdDistribution.model?.model_version || ''} · 输入与训练均为模拟数据`;
    const rows = [...distribution].sort((a, b) => (b.horizons?.[15]?.predicted_crowd_ratio || 0) - (a.horizons?.[15]?.predicted_crowd_ratio || 0)).slice(0, 8);
    panel.querySelector('.crowd-model-horizons').innerHTML = rows.map(item => {
      const h = item.horizons || {};
      return `<article class="crowd-model-row"><b>${escapeHtml(item.name)}</b><span><small>当前</small>${Math.round((item.current_crowd_ratio || 0) * 100)}%</span><span><small>15 分钟</small>${Math.round((h[15]?.predicted_crowd_ratio || 0) * 100)}%</span><span><small>30 分钟</small>${Math.round((h[30]?.predicted_crowd_ratio || 0) * 100)}%</span><span><small>60 分钟</small>${Math.round((h[60]?.predicted_crowd_ratio || 0) * 100)}%</span><span><small>上升风险</small>${Math.round((h[15]?.upward_trend_probability || 0) * 100)}%</span>${app.account?.role === 'manager' && ((h[15]?.predicted_crowd_ratio || 0) >= .7 || (h[15]?.upward_trend_probability || 0) >= .8) ? `<button type="button" data-crowd-announcement="${escapeHtml(item.poi_id)}" data-crowd-name="${escapeHtml(item.name)}">起草提醒</button>` : ''}</article>`;
    }).join('') + `<small class="crowd-model-limitation">${escapeHtml(app.crowdDistribution.model?.limitation || '模拟预测用于趋势参考，实时客流请查看景区公告。')}</small>`;
    $$('[data-crowd-announcement]', panel).forEach(button => button.onclick = () => {
      const title = `拥堵提醒：${button.dataset.crowdName}`;
      $('#operationsTitle').value = title;
      $('#operationsContent').value = `模型提示${button.dataset.crowdName}区域可能出现较高拥挤，请先核实现场情况；确认后再发布分流提醒。相关数值为模拟预测，发布前请核实现场情况。`;
      $('#operationsSource').value = `轻量化世界模型模拟预测 ${app.crowdDistribution.timestamp}`;
      $('#operationsAnnouncementForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('#operationsContent')?.focus();
    });
  }
}
function mountOperationsAdmin() {
  if ($('#managerOperationsPanel')) return;
  $('.emergency-grid')?.insertAdjacentHTML('afterend', '<section id="managerOperationsPanel" class="card manager-panel operations-manager" hidden><h3>管理者公告工作台</h3><p>仅用于本地演示：录入公告、设置有效期，再由管理者标记审核状态。此处发布不会同步到景区官方渠道。</p><form id="operationsAnnouncementForm" class="operations-form"><input id="operationsTitle" maxlength="160" placeholder="公告标题" required><textarea id="operationsContent" maxlength="1000" placeholder="公告内容（不超过 1000 字）" required></textarea><input id="operationsSource" maxlength="160" placeholder="来源或记录编号" required><label>生效时间<input id="operationsFrom" type="datetime-local" required></label><label>失效时间<input id="operationsUntil" type="datetime-local" required></label><button type="submit" class="teal-btn">保存为待审核</button></form><div id="managerAnnouncements"></div></section>');
  const panel = $('#managerOperationsPanel');
  if (panel) panel.hidden = app.account?.role !== 'manager';
  const toLocal = date => { const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return local.toISOString().slice(0, 16); };
  const now = new Date(); $('#operationsFrom').value = toLocal(now); $('#operationsUntil').value = toLocal(new Date(now.getTime() + 60 * 60 * 1000));
  $('#operationsAnnouncementForm').onsubmit = async event => {
    event.preventDefault();
    try {
      await api('/api/admin/announcements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: $('#operationsTitle').value, content: $('#operationsContent').value, source: $('#operationsSource').value, effective_from: new Date($('#operationsFrom').value).toISOString(), effective_until: new Date($('#operationsUntil').value).toISOString(), review_status: 'pending' }) });
      $('#operationsTitle').value = ''; $('#operationsContent').value = ''; $('#operationsSource').value = '';
      await loadOperations(); toast('公告已保存为待审核演示记录');
    } catch (error) { toast(error.message); }
  };
  loadOperations().catch(() => {});
}
async function loadOperations() {
  const operations = await api('/api/operations');
  const announcementTitle = title => String(title || '').replace(/^\[演示\]\s*/, '');
  const announcementDate = value => {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? String(value || '') : date.toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const target = $('#emergencyAnnouncements');
  if (target) target.innerHTML = operations.announcements?.length
    ? operations.announcements.map(item => `<article class="announcement-card"><div class="announcement-card-heading"><div class="announcement-card-title"><b>${escapeHtml(announcementTitle(item.title))}</b><span class="announcement-demo-badge">演示信息</span></div></div><p>${escapeHtml(item.content)}</p><div class="announcement-card-meta"><span>来源 · ${escapeHtml(item.source)}</span><span>有效期 · ${escapeHtml(announcementDate(item.effective_from))} 至 ${escapeHtml(announcementDate(item.effective_until))}</span></div></article>`).join('')
    : '<div class="announcement-empty"><span aria-hidden="true">告</span><div><b>暂无生效公告</b><small>审核通过并到达生效时间后，将在这里显示。</small></div></div>';
  const managerList = $('#managerAnnouncements');
  if (managerList && app.account?.role === 'manager') {
    const all = await api('/api/admin/announcements');
    managerList.innerHTML = all.announcements.map(item => `<article class="moderation-route announcement-admin-item"><div><div class="announcement-admin-title"><b>${escapeHtml(announcementTitle(item.title))}</b><span class="announcement-review-badge ${item.review_status === 'approved' ? 'is-approved' : 'is-pending'}">${escapeHtml(item.review_status === 'approved' ? '已审核' : '待审核')}</span></div><small>${escapeHtml(item.source)} · ${escapeHtml(announcementDate(item.effective_from))} — ${escapeHtml(announcementDate(item.effective_until))} · 演示公告</small><small>${escapeHtml(item.content)}</small></div><div class="community-route-actions">${item.review_status === 'pending' ? `<button type="button" data-announcement-review="${escapeHtml(item.id)}">标记已审核</button>` : ''}<button type="button" data-announcement-delete="${escapeHtml(item.id)}">删除</button></div></article>`).join('') || '<div class="announcement-empty"><span aria-hidden="true">告</span><div><b>还没有公告记录</b><small>新建的公告会显示在这里，审核后按有效期生效。</small></div></div>';
    $$('[data-announcement-review]', managerList).forEach(button => button.onclick = async () => { try { await api(`/api/admin/announcements/${encodeURIComponent(button.dataset.announcementReview)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review_status: 'approved' }) }); await loadOperations(); } catch (error) { toast(error.message); } });
    $$('[data-announcement-delete]', managerList).forEach(button => button.onclick = async () => { try { await api(`/api/admin/announcements/${encodeURIComponent(button.dataset.announcementDelete)}`, { method: 'DELETE' }); await loadOperations(); } catch (error) { toast(error.message); } });
  }
}
function mountCommunityControls() {
    if (!$('#communityPublish')) $('.dna-layout')?.insertAdjacentHTML('afterend', '<section class="card community-publish" id="communityPublish"><h3>分享一条游览路线</h3><p>选择规划路线、打卡顺序或 路线模板，填写名称并选 1–5 个特点。发布时会检查路线节点和连通性。</p><div class="community-sharing-control"><label><input type="checkbox" id="communitySharingConsent"> 我同意公开展示昵称和路线</label><button type="button" class="outline-btn" id="saveCommunitySharingConsent">保存授权</button><small id="communitySharingStatus"></small></div><div class="community-form"><select id="communityRouteSource" aria-label="选择要分享的路线"></select><input id="communityRouteTitle" maxlength="60" placeholder="路线名称（必填）"><input id="communityRouteDescription" maxlength="300" placeholder="适合人群或游览体验（选填）"><div class="route-tag-picker-wrap"><b>路线特点 <small>选择 1–5 项</small></b><div class="route-tag-picker" id="communityRouteTags" aria-label="选择路线特点"></div><small id="communityRouteTagCount" aria-live="polite">已选 0/5</small></div><button type="button" class="teal-btn" id="publishCommunityRoute">发布路线</button></div></section>');
  const routeSource = $('#communityRouteSource');
  if (routeSource && !routeSource.options.length) routeSource.innerHTML = `<option value="plan">当前规划路线</option>${(app.data?.routeSeeds || []).map(seed => `<option value="dna:${escapeHtml(seed.id)}">路线模板：${escapeHtml(seed.title)} · ${Math.round(seed.minutes)} 分钟</option>`).join('')}`;
  if (routeSource) routeSource.onchange = () => {
    if (!routeSource.value.startsWith('dna:')) return;
    const seed = (app.data?.routeSeeds || []).find(item => item.id === routeSource.value.slice(4));
    if (!seed) return;
    if ($('#communityRouteTitle')) $('#communityRouteTitle').value = seed.title;
    $$('#communityRouteTags input').forEach(input => { input.checked = seed.tags.includes(input.value); });
    if ($('#communityRouteTagCount')) $('#communityRouteTagCount').textContent = `已选 ${seed.tags.length}/5`;
  };
  if (!$('#communityPersonal')) $('.account-history')?.insertAdjacentHTML('afterend', '<section class="card community-personal" id="communityPersonal"><h2>我的游览足迹与互动</h2><p>景点收藏/点赞、路线点赞/收藏、路线投稿、打卡和浏览记录均按游客账号保存。</p><div class="community-form"><select id="communityPoiSelect" aria-label="选择景点"></select><button type="button" id="favoritePoi" class="outline-btn">收藏景点</button><button type="button" id="likePoi" class="outline-btn">点赞景点</button><button type="button" id="checkinPoi" class="outline-btn">景点打卡</button></div><div id="communityPersonalLists">登录普通游客账号后，可管理个人互动记录。</div></section>');
  const select = $('#communityPoiSelect');
  if (select && !select.options.length) {
    const nodes = app.scenicGraph?.nodes || app.data?.graph?.nodes || [];
    const options = nodes.filter(node => node.poi_id).map(node => ({ id: node.node_id || node.id || node.poi_id, name: node.name || node.poi_name || node.poi_id }));
    select.innerHTML = `<option value="">${options.length ? '请选择景点' : '暂未加载可选景点'}</option>${options.map(node => `<option value="${escapeHtml(node.id)}">${escapeHtml(node.name)}</option>`).join('')}`;
    select.disabled = options.length === 0;
  }
  if ($('#publishCommunityRoute')) $('#publishCommunityRoute').onclick = publishCurrentRoute;
  if ($('#saveCommunitySharingConsent')) $('#saveCommunitySharingConsent').onclick = async () => {
    if (app.account?.role === 'guest') return location.assign('/login.html');
    try {
      const result = await api('/api/account/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consent: { sharing: $('#communitySharingConsent').checked } }) });
      app.accountProfile = result.profile; updateCommunityAccess();
      toast(result.profile.consent.sharing ? '已开启分享授权，可在路线DNA页面发布路线' : '已关闭路线分享授权');
    } catch (error) { toast(error.message); }
  };
  if ($('#favoritePoi')) $('#favoritePoi').onclick = () => communityPoiAction('favorite');
  if ($('#likePoi')) $('#likePoi').onclick = () => communityPoiAction('like');
  if ($('#checkinPoi')) $('#checkinPoi').onclick = () => communityPoiAction('checkin');
  if (select) select.onchange = async () => {
    if (!select.value) return;
    if (app.account?.role === 'visitor') { try { await api('/api/community/views', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node_id: select.value }) }); } catch (_) {} }
    loadCommunityPersonal().catch(() => {});
  };
  if ($('#shareProfile')) $('#shareProfile').onclick = shareProfile;
  if ($('#communityRouteTags') && !$('#communityRouteTags').children.length) $('#communityRouteTags').innerHTML = ROUTE_TAGS_CLIENT.map(tag => `<label><input type="checkbox" value="${escapeHtml(tag)}">${escapeHtml(tag)}</label>`).join('');
  if ($('#communityRouteTags') && !$('#communityRouteTags').dataset.bound) {
    $('#communityRouteTags').dataset.bound = 'true';
    $('#communityRouteTags').addEventListener('change', event => {
      if (!event.target.matches('input[type="checkbox"]')) return;
      const selected = $$('#communityRouteTags input:checked');
      if (selected.length > 5) { event.target.checked = false; toast('路线特点最多选择 5 项'); }
      const count = $$('#communityRouteTags input:checked').length;
      if ($('#communityRouteTagCount')) $('#communityRouteTagCount').textContent = `已选 ${count}/5`;
    });
  }
  updateCommunityAccess();
}
async function loadCommunityPersonal() {
  const target = $('#communityPersonalLists'); if (!target) return;
  if (app.account?.role !== 'visitor') {
    app.communityPersonal = null;
    target.innerHTML = app.account?.role === 'manager'
      ? '<div class="profile-login-note"><b>管理者视图</b><p>管理者账号用于审核投稿和管理景区，不展示或修改游客个人收藏、点赞、打卡与游览记录。请使用普通游客账号体验这些功能。</p></div>'
      : '<div class="profile-stat-grid"><div><b>—</b><span>收藏景点</span></div><div><b>—</b><span>点赞景点</span></div><div><b>—</b><span>分享路线</span></div><div><b>—</b><span>路线获赞</span></div></div><div class="profile-login-note"><b>登录普通游客账号后可使用</b><p>选择景点后收藏、点赞或打卡；在路线DNA页面筛选、点赞和收藏其他游客路线，并发布自己的路线。数据会显示在这里。</p><button type="button" class="teal-btn" id="profileLoginPrompt">去登录 / 注册</button></div>';
    if ($('#profileLoginPrompt')) $('#profileLoginPrompt').onclick = () => location.assign('/login.html');
    return;
  }
  const ownerId = app.account.id;
  const data = await api('/api/community/me');
  if (app.account?.id !== ownerId) return;
  app.communityPersonal = data;
  if ($('#favoritePoi')) $('#favoritePoi').textContent = (data.favorite_pois || []).includes($('#communityPoiSelect')?.value) ? '取消收藏景点' : '收藏景点';
  if ($('#likePoi')) $('#likePoi').textContent = (data.liked_pois || []).includes($('#communityPoiSelect')?.value) ? '取消景点点赞' : '点赞景点';
  const source = $('#communityRouteSource');
  if (source) {
    const previousSource = source.value;
    const dates = [...new Set((data.checkins || []).filter(item => data.checkins.filter(dayItem => dayItem.date === item.date).length >= 2).map(item => item.date))];
    source.innerHTML = `<option value="plan">当前规划路线</option>${(app.data?.routeSeeds || []).map(seed => `<option value="dna:${escapeHtml(seed.id)}">路线示例：${escapeHtml(seed.title)} · ${Math.round(seed.minutes)} 分钟</option>`).join('')}` + dates.map(date => `<option value="checkins:${escapeHtml(date)}">${escapeHtml(date)} 的打卡游玩顺序</option>`).join('');
    if ([...source.options].some(option => option.value === previousSource)) source.value = previousSource;
  }
  const publicData = await api('/api/route-dna');
  if (app.account?.id !== ownerId) return;
  const names = new Map((app.data?.graph?.nodes || []).map(node => [node.id, node.name]));
  const routes = data.published_routes || [];
  $('#profileRouteCount').textContent = (app.accountProfile?.routeHistory?.length || 0) + routes.length;
  const routeCatalog = [...(publicData.seeds || []), ...(publicData.community || [])];
  const favoriteRoutes = data.favorite_routes.map(id => routeCatalog.find(route => route.id === id)).filter(Boolean);
  const likedRoutes = data.liked_routes.map(id => routeCatalog.find(route => route.id === id)).filter(Boolean);
  const routeRows = items => items.map(route => `<article><b>${escapeHtml(route.title)}</b><small>${(route.tags || []).map(escapeHtml).join(' · ')} · ${route.stops.map(id => escapeHtml(names.get(id) || id)).join(' → ')}</small></article>`).join('');
  target.innerHTML = `<div class="profile-stat-grid"><div><b>${data.stats?.favorite_pois || 0}</b><span>收藏景点</span></div><div><b>${data.stats?.liked_pois || 0}</b><span>点赞景点</span></div><div><b>${data.stats?.favorite_routes || 0}</b><span>收藏路线</span></div><div><b>${data.stats?.liked_routes || 0}</b><span>点赞路线</span></div><div><b>${data.stats?.published_routes || 0}</b><span>分享路线</span></div><div><b>${data.stats?.likes_received || 0}</b><span>路线获赞</span></div></div><div class="profile-content-grid"><section class="profile-community-section" id="profileFavorites"><h4>我的景点收藏</h4>${(data.favorite_pois || []).map(id => `<article><b>${escapeHtml(names.get(id) || id)}</b><small>景点收藏</small></article>`).join('') || '<p>还没有收藏景点。可在上方选择景点后点击“收藏景点”。</p>'}</section><section class="profile-community-section"><h4>我点赞的景点</h4>${(data.liked_pois || []).map(id => `<article><b>${escapeHtml(names.get(id) || id)}</b><small>景点点赞</small></article>`).join('') || '<p>还没有点赞景点。可在上方选择景点后点赞，也可在路线DNA页的热门景点区点赞。</p>'}</section><section class="profile-community-section" id="profileSavedRoutes"><h4>我收藏的路线</h4>${routeRows(favoriteRoutes) || '<p>还没有收藏路线，可到路线DNA浏览并收藏路线。</p>'}</section><section class="profile-community-section"><h4>我点赞的路线</h4>${routeRows(likedRoutes) || '<p>还没有点赞路线，可在路线DNA给喜欢的路线点赞。</p>'}</section><section class="profile-community-section" id="profilePublishedRoutes"><h4>我发布的路线</h4>${routes.map(route => `<article><b>${escapeHtml(route.title)} · ${route.status === 'hidden' ? '管理员已下架' : '公开中'}</b><small>${(route.tags || []).map(escapeHtml).join(' · ')} · 获赞 ${route.likes} · 收藏 ${route.favorites}</small><small>${route.stops.map(id => escapeHtml(names.get(id) || id)).join(' → ')}</small></article>`).join('') || '<p>还没有发布路线。规划至少两个景点后，可在路线DNA页提交推荐。</p>'}</section><section class="profile-community-section" id="profileCheckins"><h4>我的打卡</h4>${data.checkins.map(item => `<article><b>${escapeHtml(item.node_name)}</b><small>${escapeHtml(item.date)} · 游客自报</small></article>`).join('') || '<p>还没有打卡记录。</p>'}</section><section class="profile-community-section" id="profileRecentViews"><h4>最近浏览</h4>${(data.recent_views || []).map(item => `<article><b>${escapeHtml(item.node_name)}</b><small>${escapeHtml(item.viewed_at)} · 选择景点时记录</small></article>`).join('') || '<p>在景点选择器中浏览景点后，这里会记录最近浏览。</p>'}</section></div>`;
}
async function loadManagerCommunityRoutes() {
  if (app.account?.role !== 'manager') return toast('仅管理者可审核游客路线');
  const target = $('#managerOutput'); if (!target) return;
  try {
    const result = await api('/api/admin/community/routes');
    setManagerResult('路线投稿审核', `共 ${result.routes?.length || 0} 条投稿 · 路线按当前示意路网校验`, (result.routes || []).length
      ? `<div class="manager-route-list">${result.routes.map(route => `<article class="moderation-route"><div><b>${escapeHtml(route.title)}</b><small>${escapeHtml(route.author || '游客')} · ${(route.tags || []).map(escapeHtml).join('、')}</small><small>${route.stops.map(id => escapeHtml((app.data?.graph?.nodes || []).find(node => node.id === id)?.name || id)).join(' → ')}</small></div><span class="moderation-status">${route.status === 'published' ? '公开中' : '已下架'}</span><button type="button" class="outline-btn" data-moderate-route="${escapeHtml(route.id)}" data-status="${route.status === 'published' ? 'hidden' : 'published'}">${route.status === 'published' ? '下架' : '恢复公开'}</button></article>`).join('')}</div>`
      : '<div class="manager-empty">目前还没有游客路线投稿。</div>');
    $$('[data-moderate-route]', target).forEach(button => button.onclick = async () => {
      try { await api(`/api/admin/community/routes/${encodeURIComponent(button.dataset.moderateRoute)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: button.dataset.status }) }); await loadManagerCommunityRoutes(); await renderDna(); toast(button.dataset.status === 'hidden' ? '路线已下架' : '路线已恢复公开'); }
      catch (error) { toast(error.message); }
    });
  } catch (error) { setManagerResult('路线投稿审核', '读取失败', `<div class="manager-empty">${escapeHtml(error.message)}</div>`); }
}
function setManagerResult(title, hint, markup) {
  $('#managerOutputTitle').textContent = title;
  $('#managerOutputHint').textContent = hint;
  $('#managerOutput').innerHTML = markup;
  const activeId = title === '用户账号' ? 'loadManagerUsers' : title === '最近操作记录' ? 'loadManagerAudit' : 'loadManagerCommunityRoutes';
  $$('.manager-action').forEach(button => button.setAttribute('aria-pressed', String(button.id === activeId)));
}
function formatManagerDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}
function managerActionLabel(action) {
  const labels = {
    'account.register': '注册账号', 'account.login': '登录账号', 'account.logout': '退出登录',
    'account.data.export': '导出个人数据', 'account.delete': '删除游客账号', 'profile.update': '修改个人资料',
    'community.route.publish': '发布路线', 'community.route.like': '点赞路线', 'community.route.favorite': '收藏路线',
    'community.route.moderate': '审核路线投稿', 'community.poi.checkin': '景点打卡',
    'operations.announcement.create': '创建公告', 'operations.announcement.review': '审核公告',
    'operations.announcement.delete': '删除公告', 'permission.denied': '权限校验未通过',
    'scenic.queue_spike': '更新模拟排队状态', 'scenic.road_close': '模拟道路封闭',
    'scenic.scenario_event': '更新模拟景区事件'
  };
  if (labels[action]) return labels[action];
  if (action?.startsWith('community.dna_seed.')) return `处理 路线模板（${action.slice('community.dna_seed.'.length)}）`;
  return action || '其他操作';
}
function renderManagerUsers(users) {
  if (!users.length) return '<div class="manager-empty">暂无账号记录。</div>';
  return `<div class="manager-table-wrap"><table class="manager-table"><thead><tr><th>用户名</th><th>昵称</th><th>账号身份</th><th>注册时间</th></tr></thead><tbody>${users.map(user => `<tr><td><b>${escapeHtml(user.username)}</b></td><td>${escapeHtml(user.displayName)}</td><td><span class="manager-user-role ${user.role === 'manager' ? 'is-manager' : ''}">${user.role === 'manager' ? '管理者' : user.role === 'visitor' ? '游客' : '访客'}</span></td><td>${escapeHtml(formatManagerDate(user.createdAt))}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderManagerAudit(entries) {
  if (!entries.length) return '<div class="manager-empty">暂无操作记录。</div>';
  return `<div class="manager-table-wrap"><table class="manager-table"><thead><tr><th>时间</th><th>操作</th><th>处理对象</th><th>结果</th></tr></thead><tbody>${entries.map(entry => `<tr><td>${escapeHtml(formatManagerDate(entry.timestamp))}</td><td><b>${escapeHtml(managerActionLabel(entry.action))}</b><small>${escapeHtml(entry.actorRole === 'manager' ? '管理者' : entry.actorRole === 'visitor' ? '游客' : '访客')}</small></td><td>${escapeHtml(entry.target || '—')}</td><td><span class="manager-user-role ${entry.outcome === 'success' ? 'is-manager' : ''}">${escapeHtml(entry.outcome === 'success' ? '已完成' : entry.outcome === 'denied' ? '已拒绝' : entry.outcome || '—')}</span></td></tr>`).join('')}</tbody></table></div>`;
}
async function communityPoiAction(action) {
  const node_id = $('#communityPoiSelect')?.value;
  if (!node_id) return toast('请先选择景点');
  try {
    const saved = !(app.communityPersonal?.favorite_pois || []).includes(node_id);
    const liked = !(app.communityPersonal?.liked_pois || []).includes(node_id);
    await api(action === 'favorite' ? '/api/community/poi-favorites' : action === 'like' ? '/api/community/poi-likes' : '/api/community/checkins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action === 'favorite' ? { node_id, saved } : action === 'like' ? { node_id, liked } : { node_id }) });
    await loadCommunityPersonal();
    toast(action === 'favorite' ? (saved ? '已收藏景点' : '已取消景点收藏') : action === 'like' ? (liked ? '已点赞景点' : '已取消景点点赞') : '已记录打卡（游客自报）');
  } catch (error) { toast(error.message); }
}
async function publishCurrentRoute() {
  if (!['visitor', 'manager'].includes(app.account?.role)) return toast('请先登录账号后发布路线');
  if (!app.accountProfile?.consent?.sharing) return toast('请先在个人中心开启路线公开分享授权');
  const source = $('#communityRouteSource')?.value || 'plan';
  let stops;
  let seed = null;
  if (source.startsWith('dna:')) {
    seed = (app.data?.routeSeeds || []).find(item => item.id === source.slice(4));
    if (!seed) return toast('路线示例数据版本已更新，请刷新页面后重新选择');
    stops = seed.stops;
  } else if (source.startsWith('checkins:')) {
    const date = source.slice('checkins:'.length);
    stops = (app.communityPersonal?.checkins || []).filter(item => item.date === date).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(item => item.node_id);
  } else {
    const plan = app.activePlan || app.planResult || app.data?.planResult;
    stops = (plan?.itinerary || []).filter(item => ['VISIT_POI', 'ATTEND_EVENT'].includes(item.action_type)).map(item => item.target_node_id || item.target_id);
  }
  stops = [...new Set(stops || [])];
  if (stops.length < 2) return toast(source.startsWith('checkins:') ? '所选日期至少需要两条景点打卡记录' : '请先生成至少包含两个景点的规划路线');
  let tags = $$('#communityRouteTags input:checked').map(input => input.value);
  if (!tags.length && seed) { tags = seed.tags.slice(0, 5); $$('#communityRouteTags input').forEach(input => { input.checked = tags.includes(input.value); }); }
  if (tags.length < 1 || tags.length > 5) return toast('请为路线选择 1–5 个特点标签');
  try {
    const result = await api('/api/community/routes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: $('#communityRouteTitle').value, description: $('#communityRouteDescription').value, stops, tags }) });
    $('#communityRouteTitle').value = ''; $('#communityRouteDescription').value = '';
    $$('#communityRouteTags input').forEach(input => { input.checked = false; });
    if (app.account?.role === 'visitor') await loadCommunityPersonal();
    await renderDna();
    toast(`已发布「${result.route.title}」推荐`);
  } catch (error) { toast(error.message); }
}
function selectDnaRoute(route) {
  if (!route) return toast('没有找到这条路线，请刷新后重试');
  app.selectedSeed = route;
  const panel = $('#dnaClonePanel'); if (panel) panel.hidden = false;
  $('#selectedDnaTitle').textContent = route.title;
  $('#dnaMessage').textContent = '选择下方操作：按路线特点生成，或结合当前问卷偏好生成。系统会按当前状态和剩余时间规划可行景点。';
  for (const button of [$('#copyDna'), $('#mutateDna')]) if (button) { button.hidden = false; button.disabled = false; }
}
async function shareProfile() {
  if (!app.account || app.account.role === 'guest') return toast('请先登录账号并开启主页分享授权');
  if (!app.accountProfile?.consent?.sharing) {
    go('profile'); $('#profileSettings')?.removeAttribute('hidden');
    $('#consentSharingRow')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('请先勾选并保存“路线公开分享”授权，再生成主页链接'); return;
  }
  const sharedUrl = new URL(location.pathname, location.origin);
  sharedUrl.searchParams.set('profile', app.account.username);
  const link = sharedUrl.href;
  if (navigator.share) {
    try { await navigator.share({ title: `${app.account.displayName}的景区游览主页`, text: '看看我分享的景区游览路线', url: link }); toast('主页分享面板已打开'); return; }
    catch (error) { if (error?.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(link); toast('主页链接已复制，可粘贴发送给朋友'); }
  catch (_) {
    const field = document.createElement('textarea'); field.value = link; field.setAttribute('readonly', ''); field.className = 'share-link-fallback'; document.body.append(field); field.select();
    const copied = document.execCommand('copy'); field.remove();
    if (copied) toast('主页链接已复制，可粘贴发送给朋友'); else window.prompt('复制主页分享链接', link);
  }
}
async function loadSharedProfile() {
  const username = new URLSearchParams(location.search).get('profile');
  if (!username) return;
  document.documentElement.dataset.sharedProfileMode = 'true';
  $('#view-profile .profile-grid')?.setAttribute('hidden', '');
  $('#view-profile .account-history')?.setAttribute('hidden', '');
  $('#view-profile .community-personal')?.setAttribute('hidden', '');
  $('#view-profile .manager-panel')?.setAttribute('hidden', '');
  try {
    const profile = await api(`/api/community/profiles/${encodeURIComponent(username)}`);
    const card = document.createElement('section'); card.className = 'card shared-profile';
    const nodeNames = new Map((app.data?.graph?.nodes || []).map(node => [node.node_id || node.id, node.name]));
    const stats = profile.stats || { published_routes: profile.routes.length, likes_received: profile.routes.reduce((sum, route) => sum + route.likes, 0), favorites_received: profile.routes.reduce((sum, route) => sum + route.favorites, 0) };
    card.innerHTML = `<div class="shared-profile-head"><span class="shared-profile-avatar">${escapeHtml((profile.display_name || '游').slice(0, 1))}</span><div><small>景策万象 · 游客公开主页</small><h2>${escapeHtml(profile.display_name)} 的游览主页</h2><p>仅展示本人已公开的路线推荐；路线节点沿用地图一统一景点编号，底图为演示路网。</p></div></div><div class="shared-profile-stats"><div><b>${stats.published_routes}</b><span>公开路线</span></div><div><b>${stats.likes_received}</b><span>收到点赞</span></div><div><b>${stats.favorites_received}</b><span>收到收藏</span></div></div><h3>公开路线推荐</h3><div class="shared-profile-routes">${profile.routes.map(route => `<article><div class="shared-route-title"><b>${escapeHtml(route.title)}</b><span>${route.stops.length} 个景点</span></div><p>${escapeHtml(route.description || '作者暂未填写路线说明')}</p><p class="shared-route-tags">${(route.tags || []).map(tag => `<span class="route-tag">${escapeHtml(tag)}</span>`).join('')}</p><p class="shared-route-stops">${route.stops.map(id => escapeHtml(nodeNames.get(id) || id)).join(' → ')}</p><small>获赞 ${route.likes} · 收藏 ${route.favorites} · 由地图1统一路网校验</small></article>`).join('') || '<div class="shared-profile-empty"><b>还没有公开路线</b><p>作者开启了主页分享，但还没有发布路线推荐。发布后，路线特点、景点顺序和互动数会显示在这里。</p></div>'}</div><button type="button" class="outline-btn" id="sharedProfileDnaLink">浏览路线DNA</button>`;
    $('.page-intro', $('#view-profile'))?.insertAdjacentElement('afterend', card);
    $('#sharedProfileDnaLink').onclick = () => { history.replaceState(null, '', `${location.pathname}#dna`); go('dna'); };
    go('profile');
  } catch (error) {
    const card = document.createElement('section'); card.className = 'card shared-profile shared-profile-error';
    card.innerHTML = `<h2>无法打开这个公开主页</h2><p>${escapeHtml(error.message || '主页不存在、已取消分享或暂时无法连接。')}</p><button type="button" class="outline-btn" id="sharedProfileBack">返回我的个人中心</button>`;
    $('.page-intro', $('#view-profile'))?.insertAdjacentElement('afterend', card);
    $('#sharedProfileBack').onclick = () => { history.replaceState(null, '', location.pathname); document.documentElement.dataset.sharedProfileMode = ''; card.remove(); $('#view-profile .profile-grid, #view-profile .account-history, #view-profile .community-personal, #view-profile .manager-panel')?.removeAttribute('hidden'); go('profile'); };
    go('profile');
  }
}
async function renderDna() {
  if (!$('#dnaList')) return;
  const requestId = ++app.dnaRequestId;
  try {
    const data = await api(`/api/route-dna${app.dnaTags.length ? `?tags=${encodeURIComponent(app.dnaTags.join(','))}` : ''}`);
    if (requestId !== app.dnaRequestId) return;
    const bundledSeeds = app.data?.routeSeeds || [];
    const apiSeedsById = new Map((data.seeds || []).map(seed => [seed.id, seed]));
    const seedsById = new Map([...(data.seeds || []), ...bundledSeeds].map(seed => [seed.id, { ...seed, ...(apiSeedsById.get(seed.id) || {}) }]));
    const selected = app.dnaTags;
    const matchesTags = tags => selected.every(tag => (tags || []).includes(tag));
    const seeds = [...seedsById.values()].filter(seed => matchesTags(seed.tags));
    const shared = (data.community || []).filter(route => matchesTags(route.tags));
    const popularPois = data.popular_pois || [];
    const canInteract = app.account?.role === 'visitor';
    const nodeNames = new Map((app.data?.graph?.nodes || []).map(node => [node.id, node.name]));
    const filters = $('#dnaTagFilters');
    if (filters && filters.dataset.tags !== (data.tags || ROUTE_TAGS_CLIENT).join('|')) {
      filters.dataset.tags = (data.tags || ROUTE_TAGS_CLIENT).join('|');
      filters.innerHTML = (data.tags || ROUTE_TAGS_CLIENT).map(tag => `<label class="dna-tag-option"><input type="checkbox" value="${escapeHtml(tag)}"><span>${escapeHtml(tag)}</span></label>`).join('');
      filters.dataset.bound = '';
    }
    if (filters && !filters.dataset.bound) {
      filters.dataset.bound = 'true';
      filters.addEventListener('change', event => {
        if (!event.target.matches('input[type="checkbox"]')) return;
        app.dnaTags = [...filters.querySelectorAll('input:checked')].map(item => item.value);
        renderDna();
      });
      $('#clearDnaFilters').onclick = () => { app.dnaTags = []; filters.querySelectorAll('input').forEach(item => { item.checked = false; }); renderDna(); };
    } else if (filters) filters.querySelectorAll('input').forEach(input => { input.checked = app.dnaTags.includes(input.value); });
    const routeCards = [
      ...seeds.map(seed => `<article class="dna-route community-route-card">${dnaPhoto(seed.tags, seed.title)}<div class="community-route-copy"><h3>${escapeHtml(seed.title)}</h3><p>平台路线模板 · 游客点赞 ${seed.likes || 0} · 收藏 ${seed.favorites || 0}</p><p>${seed.stops.map(id => escapeHtml(nodeNames.get(id) || id)).join(' → ')}</p><div class="dna-meta">${(seed.tags || []).map(tag => `<span class="route-tag">${escapeHtml(tag)}</span>`).join('')}<span>${(seed.minutes / 60).toFixed(1)} 小时 · 按当前路况重算</span></div></div><div class="community-route-actions"><button type="button" class="dna-select" data-id="${escapeHtml(seed.id)}">选择并规划</button><button type="button" data-community-action="seed-like" data-id="${escapeHtml(seed.id)}" ${canInteract ? '' : 'disabled'}>${seed.liked ? '取消点赞' : '点赞'} ${seed.likes || 0}</button><button type="button" data-community-action="seed-favorite" data-id="${escapeHtml(seed.id)}" ${canInteract ? '' : 'disabled'}>${seed.saved ? '已收藏' : '收藏路线'} · ${seed.favorites || 0}</button></div></article>`),
      ...shared.map(route => `<article class="dna-route community-route-card">${dnaPhoto(route.tags)}<div class="community-route-copy"><h3>${escapeHtml(route.title)}</h3><p>${escapeHtml(route.author)} · 获赞 ${route.likes} · 收藏 ${route.favorites}</p><p>${route.stops.map(id => escapeHtml(nodeNames.get(id) || id)).join(' → ')}</p><div class="dna-meta">${(route.tags || []).map(tag => `<span class="route-tag">${escapeHtml(tag)}</span>`).join('')}<span>使用时按当前情况重新规划</span></div></div><div class="community-route-actions"><button type="button" data-community-action="clone" data-id="${escapeHtml(route.id)}">选择并规划</button><button type="button" data-community-action="like" data-id="${escapeHtml(route.id)}" ${canInteract ? '' : 'disabled'}>${route.liked ? '取消点赞' : '点赞'} ${route.likes}</button><button type="button" data-community-action="favorite" data-id="${escapeHtml(route.id)}" ${canInteract ? '' : 'disabled'}>${route.saved ? '已收藏' : '收藏路线'} · ${route.favorites}</button></div></article>`)
    ];
    const rankingCard = `<section class="community-poi-ranking"><h3>游客收藏较多的景点</h3><p>统计来自游客的实际收藏和点赞；登录游客账号后可在此点赞。</p><div>${popularPois.map(item => `<span class="popular-poi"><b>${escapeHtml(item.name)}</b><small>收藏 ${item.favorites} · 点赞 ${item.likes}</small><button type="button" data-community-action="poi-like" data-id="${escapeHtml(item.node_id)}" ${canInteract ? '' : 'disabled'}>${item.liked ? '取消点赞' : '点赞景点'}</button></span>`).join('') || '<span>暂无游客互动数据</span>'}</div></section>`;
    const noResults = '<div class="dna-empty-results"><b>没有符合条件的路线</b><p>试着减少已选特点，或清除筛选查看全部路线。</p><button type="button" class="outline-btn" id="dnaEmptyClear">清除筛选</button></div>';
    $('#dnaList').innerHTML = `<div class="dna-results-caption">${app.dnaTags.length ? `已选 ${app.dnaTags.length} 项 · 同时符合：${app.dnaTags.map(escapeHtml).join('、')}` : '全部路线'} · 找到 ${seeds.length + shared.length} 条（示例 ${seeds.length} · 游客分享 ${shared.length}）${canInteract ? '' : ' · 登录普通游客账号后可点赞或收藏'}</div>${rankingCard}${routeCards.length ? routeCards.join('') : noResults}`;
    $('#dnaEmptyClear')?.addEventListener('click', () => $('#clearDnaFilters')?.click());
    $$('.dna-select').forEach(button => button.onclick = () => { selectDnaRoute(seeds.find(item => item.id === button.dataset.id)); toast('已选择路线，请在下方选择生成方式'); });
    $$('[data-community-action]').forEach(button => button.onclick = async () => {
      const { id } = button.dataset; const action = button.dataset.communityAction;
      try {
        if (action === 'poi-like') {
          const poi = popularPois.find(item => item.node_id === id);
          await api('/api/community/poi-likes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node_id: id, liked: !poi?.liked }) });
          await renderDna(); if (app.account?.role === 'visitor') await loadCommunityPersonal();
          return;
        }
        if (action === 'seed-like' || action === 'seed-favorite') {
          const seed = seeds.find(item => item.id === id);
          const kind = action === 'seed-like' ? 'like' : 'favorite';
          await api(`/api/community/dna-seeds/${encodeURIComponent(id)}/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(kind === 'like' ? { liked: !seed?.liked } : { saved: !seed?.saved }) });
          await renderDna(); if (app.account?.role === 'visitor') await loadCommunityPersonal();
          return;
        }
        if (action === 'clone') { selectDnaRoute(shared.find(route => route.id === id)); return await cloneDna(false); }
        const selectedRoute = shared.find(route => route.id === id);
        await api(`/api/community/routes/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action === 'favorite' ? { saved: !selectedRoute?.saved } : {}) });
        await renderDna(); if (app.account?.role === 'visitor') await loadCommunityPersonal();
      } catch (error) { toast(error.status === 404 ? '当前服务未找到 路线模板互动接口，请重启本地服务或部署包含最新代码的版本后重试。' : error.message); }
    });
  } catch (error) { $('#dnaList').innerHTML = `<p>${escapeHtml(error.message)}</p>`; }
}
async function cloneDna(mutate = false) {
  if (!app.selectedSeed) return toast('请先选择一条 路线模板');
  const buttons = [$('#copyDna'), $('#mutateDna')].filter(Boolean);
  const labels = buttons.map(button => button.textContent);
  buttons.forEach(button => { button.disabled = true; });
  const activeButton = mutate ? $('#mutateDna') : $('#copyDna');
  if (activeButton) activeButton.textContent = '正在生成行程…';
  $('#dnaMessage').textContent = '正在按所选路线调用统一规划器，并检查当前演示状态与剩余时间…';
  try {
    const r = await api('/api/dna/clone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: app.selectedSeed.id, mutate }) });
    if (r.planResult) { app.planResult = r.planResult; app.activePlan = r.planResult; renderItinerary(r.planResult); if (app.account?.role !== 'guest') refreshAccount().catch(() => {}); }
    const total = r.source?.requested_stops?.length || r.source?.stops?.length || 0;
    const applied = r.source?.stops?.length || 0;
    const fitNote = total && applied < total ? `当前可安排 ${applied}/${total} 个景点，其余已省略。` : `已安排 ${applied} 个路线景点。`;
    $('#dnaMessage').textContent = `${mutate ? '已结合个人偏好调整路线' : '已按原路线顺序规划'}：${fitNote}可继续查看下方生成的个性化游览方案。`;
    toast(total && applied < total ? `当前行程安排 ${applied}/${total} 个路线景点` : '已生成路线行程');
  } catch (error) {
    $('#dnaMessage').textContent = `暂时无法按这条路线生成行程：${error.message}。可选择较短路线，或调整游览时间后重试。`;
    toast(`路线生成失败：${error.message}`);
  } finally {
    buttons.forEach((button, index) => { button.disabled = false; button.textContent = labels[index]; });
  }
}
async function emergency(type) {
  let result;
  try { result = await api('/api/emergency', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }) }); }
  catch (error) { toast(`应急指引暂时无法读取：${error.message}`); return; }
  const old = $('#emergencyGuide'); old?.remove();
  const content = type === 'sos'
    ? `<h3>紧急求助指引</h3><p>此演示不会联系景区值班台，也不会自动共享位置或派遣救援。若有人身危险，请直接拨打紧急电话，并告知接线员景区名称、所在区域和明显地标。</p><div class="emergency-guide-actions"><a href="tel:120">拨打 120 医疗急救</a><a href="tel:110">拨打 110 报警求助</a><a href="tel:119">拨打 119 火警救援</a></div><button type="button" class="outline-btn" data-emergency-close>关闭</button>`
    : `<h3>恶劣天气安全提示</h3><p>${escapeHtml(result.emergency.message)}。当前项目没有核验避雨点、实时天气或景区现场指挥信息；不要根据示意地图判断安全路线。</p><ol><li>立即听从景区广播和工作人员指引，远离积水、临水边缘及临时封闭区域。</li><li>需要紧急救助时直接拨打 120 或 110。</li><li>可按演示路网重新计算游览路线；紧急疏散请听从现场指挥。</li></ol><button type="button" class="teal-btn" id="emergencyReplan">按当前路网重算游览路线</button> <button type="button" class="outline-btn" data-emergency-close>关闭</button>`;
  document.querySelector('#view-emergency .emergency-actions')?.insertAdjacentHTML('beforeend', `<div id="emergencyGuide" class="emergency-guide" role="dialog" aria-live="polite">${content}</div>`);
  $('[data-emergency-close]')?.addEventListener('click', () => $('#emergencyGuide')?.remove());
  $('#emergencyReplan')?.addEventListener('click', async event => {
    const button = event.currentTarget; const originalText = button.textContent; button.disabled = true; button.textContent = '正在重算路线…';
    try {
      const data = await api('/api/b/demo-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: { event_type: 'REQUEST_REPLAN' } }) });
      app.data = data; if (data.planResult) { app.planResult = data.planResult; app.activePlan = data.planResult; renderItinerary(data.planResult); }
      renderCrowd(); await loadScenicContext(); $('#emergencyGuide')?.remove(); toast('已按当前演示状态重算路线；请核实现场安全指引');
    } catch (error) { button.disabled = false; button.textContent = originalText; toast(`路线重算失败：${error.message}`); }
  });
}
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
    } else toast(`已将 ${event.edge_id ? routeEdgeName(event.edge_id) : event.target_id || event.current_node_id || targetId || '现场'}设为${eventType}，并已重规划`);
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
  if (overviewKicker) overviewKicker.textContent = '地图1 · 游览路线总览';
  const detailKicker = $('#guidedDetail .trip-kicker');
  if (detailKicker) detailKicker.textContent = '地图2 · 逐段导航';
  const detailTitle = $('#guidedTitle');
  if (detailTitle) detailTitle.textContent = '下一站精细导航';
  const toolbarTitle = $('#guidedDetail .map-toolbar b');
  if (toolbarTitle) toolbarTitle.textContent = '地图 2 · 景区动态精细导航';
}
function labelSimulationBoundaries() {
  const algorithm = $('.algorithm-card');
  if (algorithm) {
    const small = algorithm.querySelector('.card-heading small'); if (small) small.textContent = '趋势预测 · 基础模型';
    const status = algorithm.querySelector('.engine-status'); if (status) status.textContent = '● 规则模拟';
    const lead = algorithm.querySelector('.algorithm-lead'); if (lead) lead.textContent = '共享景区图结构，用可重复规则模拟未来环境与游客负荷，再交给规划器做决策；尚未使用本地真实客流训练。';
    const model = algorithm.querySelector('.algorithm-main'); if (model) model.innerHTML = '<b>图状态模拟基线</b><small>环境趋势预测 · 合成数据</small>';
    const readout = $('#modelConfidence'); if (readout) { const label = readout.parentElement; if (label) label.firstChild.textContent = '预测来源 '; readout.textContent = '模拟估计'; }
    algorithm.querySelectorAll('.algorithm-tags span')[0]?.replaceChildren('15/30/60 分钟模拟推演');
    algorithm.querySelectorAll('.algorithm-tags span')[1]?.replaceChildren('不确定性提示');
    algorithm.querySelectorAll('.algorithm-tags span')[2]?.replaceChildren('规则回退');
  }
  const pulse = $('.pulse-card'); if (pulse) { const small = pulse.querySelector('.card-heading small'); if (small) small.textContent = '景区动态 · 演示状态'; const title = pulse.querySelector('.card-heading h3'); if (title) title.textContent = '景区状态演示'; const live = pulse.querySelector('.live'); if (live) live.textContent = '● 模拟更新'; }
  const companionIntro = $('#view-companion .page-intro p'); if (companionIntro) companionIntro.textContent = '可选不同讲解风格并通过文字提问；回复可使用语音合成播报。路线仅在单次授权后参考，位置、客流及运营状态以页面标注的数据为准。';
  const companionBadge = $('#view-companion .knowledge-badge'); if (companionBadge) companionBadge.textContent = '景区资料辅助讲解 · 状态信息为演示数据';
  const companionSource = $('#view-companion .companion-source b'); if (companionSource) companionSource.textContent = '景区整理资料 · 按次授权的路线偏好 · 模拟运营状态';
  const navigationCard = $('.module-card[data-view-target="navigation"] p'); if (navigationCard) navigationCard.textContent = '基于当前示意路网、模拟状态和路段信息，规划点到点路径。';
  const companionCard = $('.module-card[data-view-target="companion"] p'); if (companionCard) companionCard.textContent = '结合静态景区资料和当前游程提供问答，不替代规划器。';
  const dnaCard = $('.module-card[data-view-target="dna"] p'); if (dnaCard) dnaCard.textContent = '复制路线种子后，仍由统一图、状态和规划器重新校验。';
  const sosHint = $('#sosAction small'); if (sosHint) sosHint.textContent = '演示模式：未接入景区值班系统';
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
    labelSimulationBoundaries();
    stage = '读取账号状态'; await refreshAccount();
    app.data = await api('/api/snapshot');
    stage = '挂载精细导航地图'; mountCMap();
    stage = '读取 A 模块路网、状态与预测'; await loadScenicContext();
    renderAccountRouteHistory();
    stage = '读取景点简短解说'; app.poiBriefings = await api('/poi-briefings.json').catch(() => ({ briefings: {} }));
    app.poiGps = await api('/poi-gps.json').catch(() => ({ pois: [] }));
    mountCommunityControls();
    mountOperationsAdmin();
    if (app.account?.role === 'manager') loadManagerCommunityRoutes().catch(() => {});
    loadCommunityPersonal().catch(error => console.error('读取个人收藏失败', error));
    stage = '渲染主平台数据';
    $('#homeCrowd').textContent = `${Math.round(Object.values(app.data.crowd).reduce((a, b) => a + b, 0) / Object.keys(app.data.crowd).length * 100)}%`;
    $('#homeQueue').textContent = `${Math.round(Object.values(app.data.queues).reduce((a, b) => a + b, 0) / Object.keys(app.data.queues).length)} 分钟`;
    $('#homeLoad').textContent = `${Math.round(app.data.user.load * 100)}%`;
    renderModel(app.data.worldModel); renderVector(app.data.user.preferenceProfile?.weights || app.data.user.preference);
    renderPreferenceProfile(app.data.user.preferenceProfile); renderSurvey(); renderItinerary(app.data.planResult || null);
    drawChart(); drawMap(); fillNav(); requestNav().catch(error => console.error('初始化点到点导航失败', error));
    renderCrowd(); renderDna(); renderCompanions(); setupCompanionVoiceControls(); await loadSharedProfile();
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
$('#accountMenu').addEventListener('click', async event => {
  const item = event.target.closest('[data-account-target]'); if (!item) return;
  const target = item.dataset.accountTarget;
  $('#accountDropdown').open = false;
  if (target === 'login') return location.assign('/login.html');
  if (target === 'logout') { try { await api('/api/account/logout', { method: 'POST' }); location.assign('/login.html'); } catch (error) { toast(error.message); } return; }
  go('profile');
  if (app.account?.role === 'visitor') await loadCommunityPersonal().catch(() => {});
  if (target !== 'profile') setTimeout(() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
  if (target === 'profileSettings') setTimeout(() => { $('#profileSettings')?.removeAttribute('hidden'); $('#profileDisplayName')?.focus(); }, 80);
});
$('#accountDropdown').addEventListener('toggle', () => $('#accountEntry').setAttribute('aria-expanded', String($('#accountDropdown').open)));
document.addEventListener('click', event => { if (!event.target.closest('.account-wrap')) $('#accountDropdown').open = false; });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('#accountDropdown').open) { $('#accountDropdown').open = false; $('#accountEntry').focus(); } });
$('#profileOpenAuth').onclick = () => location.assign('/login.html');
function homeSearchNodes() {
  return (app.scenicGraph?.nodes || []).filter(node => node.poi_id);
}
function normalizeHomeSearchText(value) {
  return String(value || '').toLocaleLowerCase().normalize('NFKC').replace(/[\s·•,，。;；:：、_\-]/g, '');
}
function editDistance(left, right) {
  const a = Array.from(left), b = Array.from(right);
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length];
}
function fuzzyNameDistance(query, name) {
  const q = Array.from(query), n = Array.from(name);
  if (q.length < 2 || n.length < 2) return Infinity;
  let best = Infinity;
  for (let start = 0; start < n.length; start++) {
    for (let size = Math.max(1, q.length - 1); size <= Math.min(n.length - start, q.length + 1); size++) {
      best = Math.min(best, editDistance(q.join(''), n.slice(start, start + size).join('')));
    }
  }
  return best;
}
function findHomeSearchMatches(query) {
  const key = normalizeHomeSearchText(query);
  if (!key) return [];
  const nodes = homeSearchNodes();
  const scored = [];
  for (const node of nodes) {
    const name = normalizeHomeSearchText(node.name);
    const tags = (node.tags || []).map(normalizeHomeSearchText);
    let score = Infinity, matchType = '';
    if (name === key) { score = 0; matchType = '名称完全匹配'; }
    else if (name.startsWith(key)) { score = 10; matchType = '名称前缀匹配'; }
    else if (name.includes(key)) { score = 20; matchType = '名称包含关键词'; }
    else if (tags.some(tag => tag === key)) { score = 24; matchType = '类别匹配'; }
    else if (tags.some(tag => tag.includes(key) || key.includes(tag))) { score = 25; matchType = '类别相关'; }
    else {
      const distance = fuzzyNameDistance(key, name);
      const allowance = key.length < 5 ? 1 : Math.max(1, Math.floor(key.length * 0.25));
      if (distance <= allowance) { score = 30 + distance; matchType = '名称相近'; }
    }
    if (Number.isFinite(score)) scored.push({ node, score, matchType });
  }
  return scored.sort((a, b) => a.score - b.score || String(a.node.name).localeCompare(String(b.node.name), 'zh-CN'));
}
function renderHomeSearchResults(query = $('#homeSearchQuery')?.value || '') {
  const panel = $('#homeSearchResults'), hint = $('#homeSearchHint');
  if (!panel) return [];
  const matches = findHomeSearchMatches(query);
  if (!query.trim()) { panel.hidden = true; panel.replaceChildren(); if (hint) hint.textContent = '支持景点全名、部分名称和类别关键词。'; return matches; }
  if (!matches.length) {
    panel.innerHTML = '<div class="home-search-empty">没有找到匹配景点，请检查名称或尝试更短的关键词。</div>';
    panel.hidden = false;
    if (hint) hint.textContent = '可尝试输入景点全名、名称片段或类别词。';
    return matches;
  }
  panel.innerHTML = matches.slice(0, 7).map(({ node, matchType }) => `<button type="button" class="home-search-result" role="option" data-home-search-id="${escapeHtml(node.node_id || node.id)}"><span><b>${escapeHtml(node.name)}</b><small>${escapeHtml((node.tags || []).slice(0, 3).join(' · ') || '景点')}</small></span><em>${matchType}</em></button>`).join('');
  panel.hidden = false;
  if (hint) hint.textContent = `匹配到 ${matches.length} 个景点，点击结果即可选择。`;
  return matches;
}
function selectHomeSearchResult(node) {
  const targetId = node?.node_id || node?.id;
  if (!targetId || !$('#navTo')?.querySelector(`option[value="${CSS.escape(targetId)}"]`)) return toast('该景点暂不可作为导航终点');
  if ($('#navFrom')?.value === targetId) return toast('该景点已是当前起点，请选择其他目的地');
  $('#navTo').value = targetId;
  $('#homeSearchQuery').value = node.name;
  $('#homeSearchResults').hidden = true;
  $('#homeSearchHint').textContent = `已选择「${node.name}」。请确认路线起点与终点后，再开始导航。`;
  go('navigation', { confirmDestination: true });
  window.CScenicMap?.setPreviewEndpoints($('#navFrom')?.value, targetId);
  window.CScenicMap?.focusNode(targetId);
  if ($('#tripPlanCaption')) $('#tripPlanCaption').textContent = `已选择「${node.name}」为目的景点；请确认路线后再开始导航。`;
  toast(`已选择「${node.name}」，请确认路线后开始导航`);
}
$('#homeSearchQuery')?.addEventListener('input', event => renderHomeSearchResults(event.target.value));
$('#homeSearchQuery')?.addEventListener('focus', event => { if (event.target.value.trim()) renderHomeSearchResults(event.target.value); });
$('#homeSearchResults')?.addEventListener('click', event => {
  const result = event.target.closest('[data-home-search-id]');
  if (!result) return;
  const node = homeSearchNodes().find(item => (item.node_id || item.id) === result.dataset.homeSearchId);
  if (node) selectHomeSearchResult(node);
});
$('#homeSearchButton')?.addEventListener('click', () => {
  const query = $('#homeSearchQuery')?.value.trim();
  if (!query) { $('#homeSearchQuery')?.focus(); return toast('请先输入景点名称或类别关键词'); }
  const matches = renderHomeSearchResults(query);
  if (!matches.length) return toast('未找到景点，请尝试名称全称、部分名称或类别关键词');
  const exact = matches.find(item => item.score === 0);
  if (exact) return selectHomeSearchResult(exact.node);
  if (matches.length === 1 && matches[0].score < 30) return selectHomeSearchResult(matches[0].node);
  toast(`找到 ${matches.length} 个候选景点，请从搜索结果中选择`);
});
$('#homeSearchQuery')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); $('#homeSearchButton')?.click(); }
  if (event.key === 'Escape') $('#homeSearchResults').hidden = true;
});
$('#editProfileShortcut').onclick = () => { if (app.account?.role === 'guest') location.assign('/login.html'); else { $('#profileSettings')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#profileDisplayName')?.focus(); } };
$('#accountLogout').onclick = async () => { try { await api('/api/account/logout', { method: 'POST' }); location.assign('/login.html'); } catch (error) { toast(error.message); } };
$('#saveProfile').onclick = saveAccountProfile;
$('#exportAccountData').onclick = exportAccountData;
$('#deleteAccount').onclick = deleteVisitorAccount;
$('#loadManagerAudit').onclick = async () => { try { const result = await api('/api/admin/audit'); setManagerResult('最近操作记录', `显示 ${result.entries.length} 条记录，最多读取最近 100 条`, renderManagerAudit(result.entries)); } catch (error) { toast(error.message); } };
$('#loadManagerUsers').onclick = async () => { try { const result = await api('/api/admin/users'); setManagerResult('用户账号', `共 ${result.users.length} 个账号`, renderManagerUsers(result.users)); } catch (error) { toast(error.message); } };
$('#loadManagerCommunityRoutes').onclick = loadManagerCommunityRoutes;
$$('.nav').forEach(b => b.onclick = () => go(b.dataset.view));
$$('[data-view-target]').forEach(b => b.onclick = () => go(b.dataset.viewTarget));
$$('.map-tabs i').forEach(b => b.onclick = () => { $$('.map-tabs i').forEach(x => x.classList.remove('active')); b.classList.add('active'); setMapTheme(b.dataset.layer); });
$$('.filter-grid button').forEach(b => b.onclick = () => b.classList.toggle('selected'));
if ($('#simulateEvent') && !$('#simulateRoadClosure')) $('#simulateEvent').insertAdjacentHTML('afterend', '<button class="outline-btn" id="simulateRoadClosure">模拟道路封闭</button>');
$$('.contact-grid button').forEach(b => b.onclick = () => toast(`正在拨打${b.parentElement.querySelector('span').firstChild.textContent}服务电话`));
if ($('#generateRoute')) $('#generateRoute').onclick = generate; if ($('#navFrom')) $('#navFrom').onchange = () => { app.navigationMode='free'; fillNav();window.CScenicMap?.setPreviewEndpoints($('#navFrom').value,$('#navTo').value);window.CScenicMap?.focusNode($('#navFrom').value); }; if ($('#navTo')) $('#navTo').onchange = () => { app.navigationMode='free'; window.CScenicMap?.setPreviewEndpoints($('#navFrom').value,$('#navTo').value); }; if ($('#navPlan')) $('#navPlan').onclick = () => requestNav({mode:'free'}).catch(showNavigationError); if ($('#sendCompanion')) $('#sendCompanion').onclick = askCompanion; if ($('#companionQuestion')) $('#companionQuestion').onkeydown = e => { if (e.key === 'Enter') askCompanion(); }; if ($('#copyDna')) $('#copyDna').onclick = () => cloneDna(false).catch(error => toast(error.message)); if ($('#mutateDna')) $('#mutateDna').onclick = () => cloneDna(true).catch(error => toast(error.message)); if ($('#rainAction')) $('#rainAction').onclick = () => emergency('rain').catch(error => toast(`天气指引打开失败：${error.message}`)); if ($('#sosAction')) $('#sosAction').onclick = () => emergency('sos').catch(error => toast(`求助指引打开失败：${error.message}`)); if ($('#simulateEvent')) $('#simulateEvent').onclick = simulateEvent; if ($('#simulateRoadClosure')) $('#simulateRoadClosure').onclick = simulateRoadClosure;
if ($('#shareProfile')) $('#shareProfile').onclick = shareProfile;
if ($('#enterGuidance')) $('#enterGuidance').onclick = startGuidedTrip;
if ($('#backToOverview')) $('#backToOverview').onclick = showTripOverview;
if ($('#guideNextStop')) $('#guideNextStop').onclick = () => focusTripStop(app.tripStopIndex + 1);
if ($('#backToOverview')) { $('#backToOverview').insertAdjacentHTML('beforebegin', '<button class="outline-btn" id="markTripArrival">完成此站并更新进度</button>'); $('#markTripArrival').onclick = markTripArrival; }
labelMapStages();
init();
if (location.hash) setTimeout(() => go(location.hash.slice(1)), 80);
setInterval(async () => { try { const d = await api('/api/snapshot'); app.data.crowd = d.crowd; app.data.queues = d.queues; app.data.events = d.events; app.data.worldModel = d.worldModel; $('#homeCrowd').textContent = `${Math.round(Object.values(d.crowd).reduce((a, b) => a + b, 0) / Object.keys(d.crowd).length * 100)}%`; renderModel(d.worldModel); drawMap(app.mapMode); drawChart(); renderCrowd(); await loadScenicContext(); } catch (_) {} }, 15000);
