/* C module: presentational 2.5D map. It consumes A graph/state/forecast and
 * B PlanResult; it never chooses a route or predicts crowd itself. */
(() => {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const layout = window.ScenicMapLayout || { width: 2560, detailHeight: 1500, nodes: {}, edges: {}, mainEdges: [], detailPoint: p => p };
  const WIDTH = layout.width, HEIGHT = layout.detailHeight;
  const layerNames = ['terrain', 'buildings', 'roads', 'referencePaths', 'service', 'heat', 'events', 'poi', 'route', 'navigation', 'visitor'];
  const visible = Object.fromEntries(layerNames.map(name => [name, name !== 'referencePaths']));
  const roadRenderType = edge => edge.road_class || ((layout.mainEdges || []).includes(edge.edge_id) ? 'main_walkway' : 'footpath');
  const app = { root: null, graph: null, state: null, forecast: null, plan: null, selectedPoi: null, zoom: 1, theme: 'base', origin: { x: 0, y: 0 }, onPoiClick: null };
  const el = (name, attrs = {}, content = '') => {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    if (content) node.textContent = content;
    return node;
  };
  const esc = value => String(value ?? '');
  const project = node => {
    const id = node.node_id || node.id;
    const source = layout.nodes[id] || [Number(node.algorithm_x ?? node.x ?? 0) * 25, Number(node.algorithm_y ?? node.y ?? 0) * 5];
    const [x, y] = layout.detailPoint(source);
    return { x, y };
  };
  const allNodes = () => app.graph?.nodes || [];
  const nodeMap = () => new Map(allNodes().map(node => [node.node_id || node.id, node]));
  const edgeMap = () => new Map((app.graph?.edges || []).map(edge => [edge.edge_id, edge]));
  const statePoi = id => app.state?.poi_states?.[id] || {};
  const stateRoad = id => app.state?.road_states?.[id] || {};
  const queueForecast = id => {
    const planned = app.plan?.itinerary?.find(item => item.target_node_id === id);
    if(planned) return {queue_min:planned.predicted_queue_min, timestamp:planned.arrival_time};
    return app.forecast?.poi_predictions?.[id]?.[0] || null;
  };
  const crowdClass = ratio => Number(ratio || 0) >= .67 ? 'high' : Number(ratio || 0) >= .4 ? 'mid' : 'low';
  const comfortClass = shade => Number(shade || 0) >= .72 ? 'high' : Number(shade || 0) >= .45 ? 'mid' : 'low';
  const smoothPath = points => {
    const projected = points.map(point => layout.detailPoint(point));
    if(projected.length<2)return '';
    if(projected.length===2)return `M${projected[0][0].toFixed(1)},${projected[0][1].toFixed(1)} L${projected[1][0].toFixed(1)},${projected[1][1].toFixed(1)}`;
    let d=`M${projected[0][0].toFixed(1)},${projected[0][1].toFixed(1)}`;
    for(let index=0;index<projected.length-1;index++){
      const p0=projected[index-1]||projected[index],p1=projected[index],p2=projected[index+1],p3=projected[index+2]||p2;
      const c1=[p1[0]+(p2[0]-p0[0])/6,p1[1]+(p2[1]-p0[1])/6],c2=[p2[0]-(p3[0]-p1[0])/6,p2[1]-(p3[1]-p1[1])/6];
      d+=` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  };
  const svgPathForEdge = (edge, fromId, toId) => {
    let points = layout.edges[edge.edge_id];
    if (points?.length && edge.from_node_id === toId && edge.to_node_id === fromId) points = [...points].reverse();
    if (!points?.length) points = [layout.nodes[fromId], layout.nodes[toId]].filter(Boolean);
    return smoothPath(points);
  };
  const group = (name, attrs = {}) => el('g', { 'data-layer-group': name, ...attrs });
  const label = (parent, x, y, title, subtitle = '') => {
    const g = el('g', { class: 'c-building-label', transform: `translate(${x} ${y})` });
    g.append(el('rect', { x: -84, y: -21, width: 168, height: subtitle ? 44 : 31, rx: 7 }));
    g.append(el('text', { x: 0, y: -1, class: 'c-label-title', 'text-anchor': 'middle' }, title));
    if (subtitle) g.append(el('text', { x: 0, y: 13, class: 'c-label-sub', 'text-anchor': 'middle' }, subtitle));
    parent.append(g);
  };
  const polygon = (parent, points, cls) => parent.append(el('polygon', { points: points.map(point => `${point.x},${point.y}`).join(' '), class: cls }));

  function drawTerrain(root) {
    const terrain = group('terrain'), service = group('service');
    polygon(terrain, [{x:0,y:40},{x:2560,y:40},{x:2560,y:1135},{x:0,y:1135}], 'c-park-ground');
    const zones = [
      ['c-zone-film', '水浒影视区 · 示意分区', [[30,220],[125,145],[465,128],[635,235],[585,510],[450,700],[155,660],[45,470]]],
      ['c-zone-water', '水浒文化区 · 示意分区', [[625,190],[830,118],[1250,142],[1430,260],[1360,530],[1170,665],[825,610],[675,410]]],
      ['c-zone-fantasy', '仙侠演艺区 · 示意分区', [[1415,205],[1630,125],[1985,150],[2135,305],[2050,595],[1810,665],[1550,535],[1435,390]]],
      ['c-zone-jianghu', '江湖艺术区 · 示意分区', [[2000,355],[2210,280],[2515,340],[2530,740],[2390,940],[2130,900],[1995,705]]]
    ];
    for (const [cls,title,points] of zones) {
      polygon(terrain,points.map(([x,y])=>({x,y})),`c-zone ${cls}`);
      const center=points[Math.floor(points.length/2)];
      terrain.append(el('text',{x:center[0],y:center[1],class:'c-zone-title','text-anchor':'middle'},title));
    }
    for(const shape of layout.waterBodies||[]){const points=shape.map(point=>{const [x,y]=layout.detailPoint(point);return{x,y};});polygon(terrain,points,'c-water');const inner=points.filter((_,i)=>i%2===0);terrain.append(el('polyline',{points:inner.map(p=>`${p.x},${p.y}`).join(' '),class:'c-water-ripple'}));}
    // A broad, clearly vehicle-like perimeter road is decorative only; it is
    // not part of A's ScenicGraph and therefore cannot enter a route result.
    service.append(el('path', { d: 'M0 63 Q650 35 1290 61 T2560 83', class: 'c-service-road-under' }));
    service.append(el('path', { d: 'M0 63 Q650 35 1290 61 T2560 83', class: 'c-service-road' }));
    service.append(el('path', { d: 'M0 63 Q650 35 1290 61 T2560 83', class: 'c-service-mark' }));
    service.append(el('text', { x: 1670, y: 38, class: 'c-road-caption' }, '东京大道侧 · 外围道路参考（不参与园内步行规划）'));
    // Small planted islands add the hand-illustrated campus-map feeling while
    // leaving graph corridors legible and independent from buildings.
    for (const [x, y, rx, ry] of [[155,980,90,34],[650,1010,105,37],[1020,985,90,34],[1450,1025,92,36],[1940,980,120,42],[2280,960,85,34],[980,760,66,24]]) {
      terrain.append(el('ellipse', { cx:x, cy:y, rx, ry, class:'c-green-island' }));
      for (let i=0;i<5;i++) terrain.append(el('circle', { cx:x-rx*.65+i*rx*.32, cy:y-4+(i%2)*8, r:6+(i%3), class:`c-tree tree-${i%3}` }));
    }
    root.append(terrain,service);
  }

  function drawBuildings(root) {
    const buildings = group('buildings');
    const nodes = allNodes();
    const placements = {
      lake:[-30,-108], market:[-20,105], museum:[-30,-100], longtan:[20,105], forest:[-35,112],
      theater:[25,-110], shizipo:[20,-108], summit:[-28,108], rest:[28,112], temple:[-25,-105], juxianzhuang:[25,105]
    };
    const templates = [
      { dx:-100,dy:-52,w:94,d:42,h:68 }, { dx:30,dy:-27,w:100,d:46,h:54 },
      { dx:-75,dy:48,w:84,d:38,h:43 }, { dx:54,dy:55,w:78,d:34,h:58 }
    ];
    [...nodes].sort((a,b)=>project(a).y-project(b).y).forEach((node,index) => {
      if (node.type === 'gate' || ['qianqiu_lake','wanshou_lake'].includes(node.node_id || node.id)) return;
      const p = project(node), id = node.node_id || node.id, offset = placements[id] || [0,-100], buildingsAtNode = 1;
      for (let k=0;k<buildingsAtNode;k++) {
        const t=templates[(index+k)%templates.length], x=p.x+offset[0]-t.w*.45, y=p.y+offset[1];
        const w=t.w, d=t.d, h=t.h+(index%3)*4;
        const top = `${x},${y-h} ${x+w*.72},${y-h-d*.42} ${x+w+d*.72},${y-h+d*.58} ${x+d*.72},${y-h+d}`;
        const front = `${x},${y-h} ${x+w},${y-h-d*.42} ${x+w},${y-d*.42} ${x},${y}`;
        const side = `${x+w},${y-h-d*.42} ${x+w+d*.72},${y-h+d*.58} ${x+w+d*.72},${y+d*.58} ${x+w},${y-d*.42}`;
        const building=el('g',{class:`c-building ${node.type==='show'?'c-building-show':''}`,'data-node-id':id});
        building.append(el('path',{d:`M${p.x} ${p.y} L${x+w*.45} ${y}`,class:'c-building-access'}));
        building.append(el('polygon',{points:front,class:'c-building-front'}));
        building.append(el('polygon',{points:side,class:'c-building-side'}));
        building.append(el('polygon',{points:top,class:'c-building-roof'}));
        for(let wx=0;wx<3;wx++) for(let wy=0;wy<2;wy++) building.append(el('rect',{x:x+10+wx*18,y:y-h+9+wy*13,width:6,height:6,rx:1,class:'c-building-window'}));
        building.append(el('title',{},`${layout.displayNames?.[id]||node.name} · ${node.type==='show'?'演艺空间':node.type==='service'?'服务设施':'已知景点'}`));
        buildings.append(building);
      }
    });
    // Smaller context buildings reproduce the visible street/venue density.
    // They are orientation references only and never cover the route layer.
    (layout.referenceLandmarks||[]).filter(item=>!['water','street','square','gate'].includes(item.kind)).forEach((item,index)=>{
      const [px,py]=layout.detailPoint([item.x,item.y]),w=item.kind==='show'?52:42,h=item.kind==='show'?35:27;
      const g=el('g',{class:`c-reference-building c-reference-${item.kind}`,'data-reference-id':item.id});
      polygon(g,[{x:px-w/2,y:py-h},{x:px+w*.25,y:py-h-14},{x:px+w/2,y:py-h},{x:px-w*.25,y:py-h+14}],'c-reference-roof');
      polygon(g,[{x:px-w/2,y:py-h},{x:px-w*.25,y:py-h+14},{x:px-w*.25,y:py+5},{x:px-w/2,y:py-7}],'c-reference-front');
      if(index%2===0)label(g,px,py+31,item.name,'参考地标');
      buildings.append(g);
    });
    root.append(buildings);
  }

  function drawRoads(root) {
    const roads=group('roads');
    const references=group('referencePaths');
    const edges=app.graph?.edges||[];
    (layout.secondaryPaths||[]).forEach(item=>{
      const d=smoothPath(item.points);
      references.append(el('path',{d,class:`c-secondary-path ${item.verified?'':'is-schematic'}`,'data-reference-path':item.id}));
    });
    edges.forEach(edge=>{
      const path=svgPathForEdge(edge,edge.from_node_id,edge.to_node_id);
      const type=roadRenderType(edge), main=type==='main_walkway', cls=main?'main':'walk', comfort=comfortClass(edge.shade);
      const under=el('path',{d:path,class:`c-road-casing ${cls}`});
      const line=el('path',{d:path,class:`c-road-line ${cls} c-comfort-${comfort}`,'data-edge-id':edge.edge_id,'data-road-type':type,'data-shade':edge.shade,tabindex:'0',role:'button','aria-label':`${main?'主游览步道':'普通步道'} ${edge.edge_id}`});
      line.append(el('title',{},`${edge.edge_id} · ${edge.distance_m}米 · ${edge.location_source==='field_survey'?'实测步行路':'示意步行路，未经实测'}`));
      line.addEventListener('click',()=>emitEvent('ROAD_CLICK',edge.edge_id,'edge_id'));
      roads.append(under,line);
    });
    root.append(roads,references);
  }

  function statusForNode(node) {
    const poiId=node.poi_id || node.poiId || null;
    if(!poiId) return {};
    const status=statePoi(poiId), forecast=queueForecast(poiId);
    const event=Object.values(app.state?.event_states||{}).find(item=>item.node_id===(node.node_id||node.id)&&item.status!=='cancelled')||null;
    return {poiId,status,forecast,event};
  }
  function drawPoiAndState(root) {
    const pois=group('poi'); const heat=group('heat'); const events=group('events');
    for(const node of allNodes()) {
      const id=node.node_id||node.id, p=project(node), {poiId,status,forecast,event:nodeEvent}=statusForNode(node);
      if(node.type==='gate') {
        const gate=el('g',{class:'c-gate-pin','data-node-id':id,tabindex:'0',role:'button'});
        gate.append(el('path',{d:`M${p.x-24} ${p.y+8} v-36 l24 -19 24 19 v36Z`}));
        gate.append(el('text',{x:p.x,y:p.y-2,'text-anchor':'middle'},'門'));
        gate.append(el('text',{x:p.x,y:p.y+38,'text-anchor':'middle',class:'c-gate-name'},layout.displayNames?.[id]||node.name));
        gate.append(el('title',{},`${node.name} · 園區出入口`));
        gate.addEventListener('click',()=>emitEvent('MAP_REPLAN_REQUEST',id,'node_id'));
        pois.append(gate);
      }
      if(poiId) {
        const ratio=Number(status.crowd_ratio||0), cls=crowdClass(ratio);
        const marker=el('g',{class:`c-poi c-crowd-${cls} c-comfort-${comfortClass(node.shade)} ${status.open===false?'is-closed':''}`,'data-node-id':id,'data-poi-id':poiId,'data-area-id':node.area_id||'',tabindex:'0',role:'button','aria-label':`${node.name}，排队${Math.round(Number(status.queue_min||0))}分钟`});
        marker.append(el('ellipse',{cx:p.x,cy:p.y+3,rx:30,ry:13,class:'c-poi-shadow'}));
        marker.append(el('circle',{cx:p.x,cy:p.y-12,r:22,class:'c-poi-pin'}));
        marker.append(el('text',{x:p.x,y:p.y-5,class:'c-poi-glyph','text-anchor':'middle'},node.type==='show'?'★':node.type==='service'?'休':node.type==='view'?'景':'景'));
        marker.append(el('rect',{x:p.x+21,y:p.y-39,width:68,height:27,rx:11,class:'c-queue-pill'}));
        marker.append(el('text',{x:p.x+55,y:p.y-20,class:'c-queue-text','text-anchor':'middle'},status.open===false?'暫停':`${Math.round(Number(status.queue_min||0))}分`));
        const name=el('g',{class:'c-poi-name','data-poi-label':poiId});name.append(el('rect',{x:p.x-84,y:p.y+18,width:168,height:34,rx:7}));name.append(el('text',{x:p.x,y:p.y+41,'text-anchor':'middle'},node.name));marker.append(name);
        if(node.type==='service') marker.dataset.facilityId=node.facility_id||node.poi_id||node.node_id||id;
        marker.append(el('title',{},`${node.name} · 當前排隊 ${Math.round(Number(status.queue_min||0))} 分鐘 · 預計排隊 ${forecast?Math.round(Number(forecast.queue_min||0)):'--'} 分鐘${nodeEvent?` · ${nodeEvent.title} ${nodeEvent.start_time||''}`:''}`));
        marker.addEventListener('click',event=>{event.stopPropagation();app.selectedPoi=poiId;emitEvent('POI_CLICK',poiId,'target_id');if(app.onPoiClick)app.onPoiClick(node,{...status,forecast,event:nodeEvent});});
        marker.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();marker.dispatchEvent(new MouseEvent('click',{bubbles:true}));}});
        pois.append(marker);
        heat.append(el('circle',{cx:p.x,cy:p.y-6,r:24+ratio*18,class:`c-heat-ring ${cls}`}));
      }
    }
    for(const [index,item] of (layout.referenceLandmarks||[]).entries()){
      const [x,y]=layout.detailPoint([item.x,item.y]),ref=el('g',{class:`c-reference-pin c-reference-pin-${item.kind}`,'data-reference-id':item.id});
      ref.append(el('circle',{cx:x,cy:y,r:7}));
      if(['gate','show','water','square'].includes(item.kind)||index%3===0)ref.append(el('text',{x,y:y-12,'text-anchor':'middle'},item.name));
      ref.append(el('title',{},`${item.name} · 手绘参考地标，不参与 A 路网规划`));
      pois.append(ref);
    }
    for(const item of layout.facilities||[]){
      const [x,y]=layout.detailPoint([item.x,item.y]),facility=el('g',{class:`c-facility-pin ${item.verified?'':'is-simulated'}`,'data-facility-id':item.id});
      facility.append(el('rect',{x:x-13,y:y-13,width:26,height:26,rx:7}),el('text',{x,y:y+4,'text-anchor':'middle'},item.icon));
      facility.append(el('title',{},`${item.name}${item.verified?'':'（模拟点位）'}`));pois.append(facility);
    }
    for(const event of Object.values(app.state?.event_states||{})) {
      if(event.status==='cancelled') continue;
      const node=nodeMap().get(event.node_id); if(!node) continue;
      const p=project(node), icon=el('g',{class:'c-event-pin','data-event-id':event.event_id});
      icon.append(el('path',{d:`M${p.x+23} ${p.y-55} l12 12 -12 12 -12 -12Z`}));
      icon.append(el('text',{x:p.x+23,y:p.y-39,'text-anchor':'middle'},'演'));
      icon.append(el('title',{},`${event.title||'演出'} · ${event.start_time||''} · 最晚入场 ${event.latest_entry_time||'未提供'}`)); events.append(icon);
    }
    root.append(heat,events,pois);
  }

  function routeEdges(plan) {
    const entries=[];
    for(const item of plan?.itinerary||[]) {
      const route=item.route||{}; const ids=route.edge_sequence||[], nodes=route.node_sequence||[];
      ids.forEach((edgeId,index)=>entries.push({edgeId,from:nodes[index],to:nodes[index+1]}));
    }
    return entries;
  }
  function drawRoute(root) {
    const routes=group('route'); const edgeById=edgeMap();
    const entries=routeEdges(app.plan);
    const unique=[]; const seen=new Set();
    for(const item of entries) { const key=`${item.edgeId}:${item.from}:${item.to}`; if(!seen.has(key)){seen.add(key);unique.push(item);} }
    let activePath='';
    unique.forEach(({edgeId,from,to})=>{
      const edge=edgeById.get(edgeId); if(!edge||!from||!to) return;
      const d=svgPathForEdge(edge,from,to);
      routes.append(el('path',{d,class:'c-route-halo','data-route-edge':edgeId}));
      routes.append(el('path',{d,class:'c-route-line','data-route-edge':edgeId}));
      activePath+=d.replace(/^M/,'L');
    });
    const first=app.plan?.itinerary?.find(item=>item.target_node_id);
    const target=first&&nodeMap().get(first.target_node_id);
    if(target){const p=project(target);routes.append(el('circle',{cx:p.x,cy:p.y-9,r:24,class:'c-next-target-ring'}));routes.append(el('text',{x:p.x,y:p.y-39,'text-anchor':'middle',class:'c-next-target-label'},'下一站'));}
    root.append(routes);
  }
  function drawNavigation(root) {
    const route=app.navigationRoute;if(!route?.edgeSequence?.length)return;
    const layer=group('navigation'),edges=edgeMap(),nodes=route.path||[];
    route.edgeSequence.forEach((edgeId,index)=>{const edge=edges.get(edgeId),from=nodes[index],to=nodes[index+1];if(!edge||!from||!to)return;const d=svgPathForEdge(edge,from,to);layer.append(el('path',{d,class:'c-navigation-halo','data-navigation-edge':edgeId}));layer.append(el('path',{d,class:'c-navigation-line','data-navigation-edge':edgeId}));});
    const destination=nodeMap().get(nodes.at(-1));
    if(destination){const p=project(destination),flag=el('g',{class:'c-navigation-destination',transform:`translate(${p.x} ${p.y-18})`});flag.append(el('circle',{r:27}));flag.append(el('path',{d:'M-7 -14 H13 L7 -4 L13 6 H-7Z'}));flag.append(el('text',{x:0,y:49,'text-anchor':'middle'},'目的地'));layer.append(flag);}
    root.append(layer);
  }
  function drawVisitor(root) {
    const visitor=group('visitor'); const id=app.state?.visitor?.current_node_id; const node=nodeMap().get(id);
    if(node){const p=project(node);const pin=el('g',{class:'c-visitor-pin',transform:`translate(${p.x} ${p.y-12})`});pin.append(el('circle',{r:25,class:'c-visitor-pulse'}));pin.append(el('circle',{r:11,class:'c-visitor-dot'}));pin.append(el('path',{d:'M-7 0 L0 -13 L7 0Z',class:'c-visitor-arrow'}));pin.append(el('text',{x:0,y:42,'text-anchor':'middle'},'你在这里'));visitor.append(pin);}
    root.append(visitor);
  }

  function applyVisibility() {
    if(!app.root)return;
    for(const name of layerNames){const g=app.root.querySelector(`[data-layer-group="${name}"]`);if(g)g.style.display=visible[name]?'':'none';}
    app.root.querySelectorAll('[data-edge-id]').forEach(line=>{
      const status=stateRoad(line.dataset.edgeId);line.classList.toggle('is-road-closed',status.available===false);
      let title=line.querySelector('title');if(!title){title=el('title');line.append(title);}
      title.textContent=`${line.dataset.edgeId} · ${status.available===false?'已关闭':'可通行'} · 当前约 ${Number(status.travel_time_min||0)} 分钟`;
    });
  }
  function drawLayers() {
    if(!app.root||!app.graph)return;
    app.root.replaceChildren();
    // Roads and dynamic polylines sit below architecture and labels, so a
    // route remains legible without cutting through landmark façades.
    drawTerrain(app.root);drawRoads(app.root);drawRoute(app.root);drawNavigation(app.root);drawBuildings(app.root);drawPoiAndState(app.root);drawVisitor(app.root);
    applyVisibility();setZoom(app.zoom,false);
  }
  function emitEvent(type,targetId,targetField='target_id') {
    const detail={schema_version:app.state?.schema_version||app.graph?.schema_version||'0.1',scenario_id:app.state?.scenario_id||app.graph?.scenario_id||'demo_001',event_type:type,[targetField]:targetId,timestamp:app.state?.timestamp||new Date().toISOString()};
    window.lastScenicUserEvent=detail;window.dispatchEvent(new CustomEvent('scenic-user-event',{detail}));return detail;
  }
  function navigationPoints(route=app.navigationRoute){const edges=edgeMap(),nodes=route?.path||[],points=[];(route?.edgeSequence||[]).forEach((edgeId,index)=>{const edge=edges.get(edgeId);let line=layout.edges[edgeId];if(!edge||!line)return;if(edge.from_node_id===nodes[index+1]&&edge.to_node_id===nodes[index])line=[...line].reverse();line.forEach(point=>{const [x,y]=layout.detailPoint(point);points.push({x,y});});});return points;}
  function focusNavigation(){if(!app.root)return;const points=navigationPoints();if(!points.length)return setZoom(1,false);const xs=points.map(p=>p.x),ys=points.map(p=>p.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);let w=Math.max(720,maxX-minX+360),h=Math.max(520,maxY-minY+350);const ratio=WIDTH/HEIGHT;if(w/h<ratio)w=h*ratio;else h=w/ratio;w=Math.min(WIDTH,w);h=Math.min(HEIGHT,h);const x=Math.max(0,Math.min(WIDTH-w,(minX+maxX-w)/2));const y=Math.max(0,Math.min(HEIGHT-h,(minY+maxY-h)/2));app.root.setAttribute('viewBox',`${x} ${y} ${w} ${h}`);app.root.setAttribute('data-navigation-focus','true');}
  function setZoom(value,update=true){app.zoom=Math.max(1,Math.min(2.3,value));if(!app.root)return;const w=WIDTH/app.zoom,h=HEIGHT/app.zoom,x=(WIDTH-w)/2,y=(HEIGHT-h)/2;app.root.setAttribute('viewBox',`${x} ${y} ${w} ${h}`);app.root.removeAttribute('data-navigation-focus');if(update)app.root.setAttribute('data-zoom',app.zoom.toFixed(1));}
  function setTheme(theme='base'){app.theme=['base','crowd','comfort'].includes(theme)?theme:'base';if(app.root)app.root.setAttribute('data-theme',app.theme);}
  function mount(selector,options={}) {
    app.root=typeof selector==='string'?document.querySelector(selector):selector;app.onPoiClick=options.onPoiClick||null;
    if(!app.root)return false;
    app.root.setAttribute('viewBox',`0 0 ${WIDTH} ${HEIGHT}`);app.root.setAttribute('preserveAspectRatio','xMidYMid meet');app.root.setAttribute('data-theme',app.theme);
    return true;
  }
  function update(data={}) {
    if(data.graph)app.graph=data.graph;if(data.state)app.state=data.state;if(data.forecast)app.forecast=data.forecast;if(data.plan!==undefined)app.plan=data.plan;
    drawLayers();
  }
  function loadScenicGraph(graph){app.graph=graph;drawLayers();}
  function updateState(state,forecast=app.forecast){app.state=state;app.forecast=forecast;drawLayers();}
  function updatePoiStatus(poiId,status){if(!app.state)return;app.state.poi_states[poiId]={...(app.state.poi_states[poiId]||{}),...status};updateState(app.state);}
  function updateRoadStatus(edgeId,status){if(!app.state)return;app.state.road_states[edgeId]={...(app.state.road_states[edgeId]||{}),...status};applyVisibility();}
  function updateVisitorPosition(visitor){if(!app.state)return;app.state.visitor={...app.state.visitor,...visitor};updateState(app.state);}
  function updateForecastSummary(forecast){app.forecast=forecast;updateState(app.state,forecast);}
  function updatePlan(plan){app.plan=plan;drawLayers();}
  function updateNavigation(result){app.navigationRoute=result;if(!app.root||!app.graph)return;drawLayers();focusNavigation();}
  function toggleLayer(name,on){if(!(name in visible))return;visible[name]=on===undefined?!visible[name]:Boolean(on);applyVisibility();}
  function selectPoi(poiId){app.selectedPoi=poiId;const node=allNodes().find(item=>item.poi_id===poiId);if(node){const status=statePoi(poiId);if(app.onPoiClick)app.onPoiClick(node,{...status,forecast:queueForecast(poiId)});}}
  function zoomIn(){setZoom(app.zoom*1.18);}function zoomOut(){setZoom(app.zoom/1.18);}function locate(){setZoom(1);}
  window.CScenicMap={mount,update,loadScenicGraph,updateState,updatePoiStatus,updateRoadStatus,updateVisitorPosition,updateForecastSummary,updatePlan,showPlan:updatePlan,replaceRoute:updatePlan,updateNavigation,toggleLayer,setTheme,selectPoi,emitEvent,zoomIn,zoomOut,locate,getData:()=>({graph:app.graph,state:app.state,forecast:app.forecast,plan:app.plan,theme:app.theme}),getLayout:()=>layout};
})();
