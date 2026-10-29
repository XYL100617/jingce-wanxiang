/* C module: presentational 2.5D map. It consumes A graph/state/forecast and
 * B PlanResult; it never chooses a route or predicts crowd itself. */
(() => {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const layout = window.ScenicMapLayout || { width: 2560, detailHeight: 1500, nodes: {}, edges: {}, mainEdges: [], detailPoint: p => p };
  // Map 2 projects the SVG Map 1 coordinates used by scenic-overview.js.
  const WIDTH = 2560, HEIGHT = 1600;
  const layerNames = ['terrain', 'buildings', 'roads', 'referencePaths', 'service', 'heat', 'events', 'poi', 'route', 'navigation', 'visitor'];
  const visible = Object.fromEntries(layerNames.map(name => [name, name !== 'referencePaths']));
  const roadRenderType = edge => edge.road_class || ((layout.mainEdges || []).includes(edge.edge_id) ? 'main_walkway' : 'footpath');
  const app = { root: null, graph: null, state: null, forecast: null, crowdDistribution: null, roadNames: {}, crowdHorizon: 0, plan: null, selectedPoi: null, selectedNode: null, previewNode: null, previewDestination: null, zoom: 1, pan: { x: 0, y: 0 }, bearing: 0, northUp: false, immersive: false, followNavigation: true, theme: 'base', origin: { x: 0, y: 0 }, onPoiClick: null, onNavigationProgress: null, navigationProgress: 0, scene: null };
  // Follow the next turn at street scale; keep the full overview before guidance.
  const CAMERA_VIEW = { width: 1800, height: 1220, anchorX: 900, anchorY: 885, scale: 3.35, depth: .58 };
  const el = (name, attrs = {}, content = '') => {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    if (content) node.textContent = content;
    return node;
  };
  const esc = value => String(value ?? '');
  const map1Point = point => {
    const [x,y] = layout.overviewPoint ? layout.overviewPoint(point) : point;
    // Use the actual Map 1 drawing coordinates. The follow camera supplies
    // the navigation zoom and pitch without bending or relocating its roads.
    return {x:Number(x),y:Number(y)};
  };
  function alignedMap1Layers(graph){
    const source=el('svg',{viewBox:`-55 -40 ${layout.width+110} 591`,width:layout.width+110,height:591});
    window.ScenicOverviewMap?.draw?.(source,graph);
    const cloned=new Map(),prefix=`m2src${Date.now().toString(36)}-`;
    const cloneLayer=selector=>{
      const original=source.querySelector(selector);if(!original)return el('g');
      const copy=original.cloneNode(true);cloned.set(selector,copy);return copy;
    };
    const background=el('g',{class:'m2-map1-background'});
    for(const selector of ['.overview-ground','.overview-board','.overview-board-inset','.overview-terrain','.overview-decoration']){
      const item=source.querySelector(selector);if(item)background.append(item.cloneNode(true));
    }
    const defs=source.querySelector('defs')?.cloneNode(true);
    if(defs){
      const ids=new Map();for(const item of [defs,...defs.querySelectorAll('[id]')])if(item.id){ids.set(item.id,prefix+item.id);item.id=prefix+item.id;}
      for(const item of [defs,...defs.querySelectorAll('*')])for(const attr of [...item.attributes]){
        let value=attr.value;
        value=value.replace(/url\(#([^)]+)\)/g,(_,id)=>`url(#${ids.get(id)||prefix+id})`);
        if((attr.name==='href'||attr.name==='xlink:href')&&value.startsWith('#'))value=`#${ids.get(value.slice(1))||prefix+value.slice(1)}`;
        if(value!==attr.value)item.setAttribute(attr.name,value);
      }
      background.prepend(defs);
    }
    const roads=cloneLayer('.overview-roads');
    const routeEdges=new Set(app.navigationRoute?.edgeSequence||[]);
    for(const path of roads.querySelectorAll('[data-overview-edge]')){
      const id=path.dataset.overviewEdge;path.dataset.edgeId=id;path.classList.add('m2-road');path.setAttribute('tabindex','0');path.setAttribute('role','button');
      const casing=path.previousElementSibling;
      for(const line of [path,casing])if(line){line.classList.add(routeEdges.has(id)?'is-route-road':'is-context-road');line.setAttribute('data-map2-edge-id',id);}
      const edge=edgeMap().get(id);if(edge){const d=svgPathForEdge(edge,edge.from_node_id,edge.to_node_id);if(d)path.setAttribute('d',d);const from=nodeMap().get(edge.from_node_id),to=nodeMap().get(edge.to_node_id),a=from?.poi_id?crowdForPoi(from.poi_id).ratio:0,b=to?.poi_id?crowdForPoi(to.poi_id).ratio:0,score=comfortScore(edge.shade,(a+b)/2);path.classList.add(`m2-comfort-${comfortClass(score)}`);path.dataset.comfortScore=score.toFixed(3);path.dataset.crowdRatio=((a+b)/2).toFixed(3);path.append(el('title',{},`${id} · ${edge.distance_m||edge.distance||'--'}米 · 模拟舒适度参考 ${Math.round(score*100)}分（遮阴+模拟拥挤度） · 地图1示意步道`));}
      else path.append(el('title',{},`${id} · 地图1示意步道`));
      path.addEventListener('click',()=>emitEvent('ROAD_CLICK',id,'edge_id'));
    }
    const landmarksSource=cloneLayer('.overview-landmarks'),landmarks=el('g',{class:'overview-landmarks m2-source-landmarks'});
    for(const item of [...landmarksSource.children]){
      const id=item.getAttribute('data-overview-artwork');
      if(!id){if(!item.classList.contains('overview-node-label'))landmarks.append(item);continue;}
      const point=map1Point(layout.nodes[id]||[0,0]),offset=window.ScenicOverviewMap?.visualOffset?.(id)||[0,0];
      const node=graph.nodes.find(entry=>(entry.node_id||entry.id)===id);
      const status=node?statusForNode(node):{};
      const artworkSize=window.ScenicOverviewMap?.visualSize?.(node||{id})||64;
      const landmarkScale=Math.max(.68,Math.min(.98,54/artworkSize));
      const wrapper=el('g',{class:`m2-building m2-source-landmark ${app.selectedNode===id?'is-selected':''}`,'data-context-node':id,'data-node-id':node?id:undefined,'data-poi-id':status.poiId||undefined,'data-anchor-x':point.x+offset[0],'data-anchor-y':point.y+offset[1],'data-center-x':0,'data-size':landmarkScale,'data-map1-artwork-kind':window.ScenicOverviewMap?.artworkKind?.(node||{id})||'hall',tabindex:node?'0':undefined,role:node?'button':undefined,'aria-label':node?`${node.name}，点击查看景点并可设为导航起点或终点`:undefined});
      wrapper.append(item);landmarks.append(wrapper);
      if(node){
        const hitSize=window.ScenicOverviewMap?.visualSize?.(node)||64;
        wrapper.append(el('rect',{x:point.x+offset[0]-hitSize*.72,y:point.y+offset[1]-hitSize*.96,width:hitSize*1.44,height:hitSize*1.2,fill:'transparent',class:'m2-building-hitarea','pointer-events':'all'}));
        wrapper.append(el('title',{},`${node.name} · 地图1景点建筑示意`));
        let pointerActivation=false;
        const selectLandmark=event=>{
          if(event?.type==='click')event.stopPropagation();app.selectedNode=id;
          app.root?.querySelectorAll('.m2-building[data-node-id],.m2-poi[data-node-id]').forEach(entry=>entry.classList.toggle('is-selected',entry.dataset.nodeId===id));
          if(status.poiId)emitEvent('POI_CLICK',status.poiId,'target_id');
          if(app.onPoiClick)app.onPoiClick(node,{...(status.status||{}),forecast:status.forecast});
        };
        wrapper.addEventListener('pointerup',event=>{if(event.button!==0)return;pointerActivation=true;selectLandmark(event);setTimeout(()=>{pointerActivation=false;},0);});
        wrapper.addEventListener('click',event=>{if(pointerActivation){pointerActivation=false;return;}selectLandmark(event);});
        wrapper.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectLandmark(event);}});
      }
    }
    return {background,roads,landmarks};
  }
  const map1EdgeCache = new Map();
  const map1EdgePoints = edgeId => {
    if(map1EdgeCache.has(edgeId))return map1EdgeCache.get(edgeId);
    const source=layout.edges[edgeId]||[],points=source.map(map1Point),sampled=[];
    if(points.length)sampled.push(points[0]);
    for(let index=0;index<points.length-1;index++){
      const p0=points[index-1]||points[index],p1=points[index],p2=points[index+1],p3=points[index+2]||p2;
      const c1={x:p1.x+(p2.x-p0.x)/6,y:p1.y+(p2.y-p0.y)/6},c2={x:p2.x-(p3.x-p1.x)/6,y:p2.y-(p3.y-p1.y)/6};
      for(let step=1;step<=8;step++){
        const t=step/8,u=1-t;
        sampled.push({x:u*u*u*p1.x+3*u*u*t*c1.x+3*u*t*t*c2.x+t*t*t*p2.x,y:u*u*u*p1.y+3*u*u*t*c1.y+3*u*t*t*c2.y+t*t*t*p2.y});
      }
    }
    map1EdgeCache.set(edgeId,sampled);return sampled;
  };
  const project = node => {
    const id = node.node_id || node.id;
    const source = layout.nodes[id];
    if (!source) return null;
    return map1Point(source);
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
  function crowdForPoi(poiId) {
    const item=app.crowdDistribution?.distribution?.find(entry=>entry.poi_id===poiId);
    if(app.crowdHorizon>0){const prediction=item?.horizons?.[String(app.crowdHorizon)];if(prediction)return {ratio:Number(prediction.predicted_crowd_ratio)||0,trend:Number(prediction.upward_trend_probability)||0};}
    return {ratio:Number(item?.current_crowd_ratio ?? statePoi(poiId).crowd_ratio)||0,trend:null};
  }
  const comfortScore = (shade,crowdRatio) => Math.max(0,Math.min(1,.55*(Number(shade)||0)+.45*(1-(Number(crowdRatio)||0))));
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
    let points = map1EdgePoints(edge.edge_id);
    if (points?.length && edge.from_node_id === toId && edge.to_node_id === fromId) points = [...points].reverse();
    if (!points?.length) {
      if (edge) console.warn(`地图2缺少地图1边几何: ${edge.edge_id}`);
      return '';
    }
    return points.length < 2 ? '' : `M${points.map(point=>`${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' L')}`;
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
    const defs = el('defs');
    const grass = el('linearGradient', { id:'c-grass-shade', x1:'0', y1:'0', x2:'1', y2:'1' });
    grass.append(el('stop',{offset:'0%','stop-color':'#a9bd83'}),el('stop',{offset:'48%','stop-color':'#829d68'}),el('stop',{offset:'100%','stop-color':'#69885c'}));
    defs.append(grass);
    const texture = el('pattern',{id:'c-grass-texture',width:38,height:34,patternUnits:'userSpaceOnUse'});
    texture.append(el('path',{d:'M5 20l3-7m2 9 3-5m14 6 2-8m-1 11 3-4',stroke:'#e2e6b7',opacity:'.23','stroke-width':1.3,'stroke-linecap':'round'}));
    texture.append(el('circle',{cx:22,cy:10,r:1.4,fill:'#546f4f',opacity:'.2'}),el('circle',{cx:4,cy:5,r:1,fill:'#edf0c9',opacity:'.23'}));
    defs.append(texture); terrain.append(defs);
    polygon(terrain, [{x:0,y:40},{x:2560,y:40},{x:2560,y:1135},{x:0,y:1135}], 'c-park-ground');
    polygon(terrain, [{x:0,y:40},{x:2560,y:40},{x:2560,y:1135},{x:0,y:1135}], 'c-ground-grain');
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
    // Small simulated grove clearings supply local 2.5D context without adding
    // any walkways or routable geometry to the shared graph.
    for (const [x,y,rx,ry,count] of [[155,980,90,34,7],[650,1010,105,37,8],[1020,985,90,34,7],[1450,1025,92,36,7],[1940,980,120,42,9],[2280,960,85,34,6],[980,760,66,24,5]]) {
      terrain.append(el('ellipse',{cx:x,cy:y,rx,ry,class:'c-grove-bed'}));
      for(let i=0;i<count;i++)drawTree(terrain,x-rx*.72+i*(rx*1.44/Math.max(1,count-1)),y+(i%2?7:-7),.7+(i%3)*.12);
    }
    for(const node of allNodes().filter(item=>item.type==='scenery'&&!['qianqiu_lake','wanshou_lake'].includes(item.node_id||item.id))){
      const source=layout.nodes[node.node_id||node.id];if(!source)continue;const [x,y]=layout.detailPoint(source);
      [[-68,-22,.8],[-42,30,.72],[54,-28,.88],[78,23,.74]].forEach(([dx,dy,s])=>drawTree(terrain,x+dx,y+dy,s));
    }
    drawRouteSideEnvironment(terrain);
    root.append(terrain,service);
  }

  function drawTree(parent,x,y,scale=1){
    const tree=el('g',{class:'c-tree-3d',transform:`translate(${x} ${y}) scale(${scale*.72})`});
    tree.append(el('ellipse',{cx:3,cy:7,rx:12,ry:6,class:'c-tree-shadow'}));
    tree.append(el('path',{d:'M0 4 L1 -12 L5 -22 L4 3Z',class:'c-tree-trunk'}));
    tree.append(el('circle',{cx:-4,cy:-18,r:10,class:'c-tree-crown crown-back'}),el('circle',{cx:5,cy:-25,r:12,class:'c-tree-crown'}),el('circle',{cx:13,cy:-16,r:9,class:'c-tree-crown crown-light'}));
    parent.append(tree);return tree;
  }

  function drawRouteSideEnvironment(parent){
    const route=app.navigationRoute,edges=edgeMap();
    if(!route?.edgeSequence?.length)return;
    route.edgeSequence.forEach((edgeId,index)=>{
      let source=layout.edges[edgeId];if(!source?.length)return;
      const edge=edges.get(edgeId),path=route.path||[];
      if(edge&&edge.from_node_id===path[index+1]&&edge.to_node_id===path[index])source=[...source].reverse();
      const points=source.map(point=>{const [x,y]=layout.detailPoint(point);return{x,y};});
      const middle=interpolateLine(points,.5),before=interpolateLine(points,.45),after=interpolateLine(points,.55);
      const mdx=after.x-before.x,mdy=after.y-before.y,mlen=Math.max(1,Math.hypot(mdx,mdy)),mnx=-mdy/mlen,mny=mdx/mlen;
      for(const side of [-1,1]){
        const asset=drawScenicBuilding(parent,middle.x+mnx*90*side,middle.y+mny*90*side,{w:43,d:23,h:31},index%2?'market':'hall',null,'沿途环境模拟',index);
        if(asset){asset.dataset.simulatedContext=edgeId;asset.classList.add('is-simulated-context');}
      }
      for(const fraction of [.28,.7]){
        const point=interpolateLine(points,fraction),near=interpolateLine(points,Math.max(0,fraction-.035)),far=interpolateLine(points,Math.min(1,fraction+.035));
        const dx=far.x-near.x,dy=far.y-near.y,length=Math.max(1,Math.hypot(dx,dy)),nx=-dy/length,ny=dx/length;
        drawTree(parent,point.x+nx*42,point.y+ny*42,.76);drawTree(parent,point.x-nx*42,point.y-ny*42,.8);
      }
    });
  }

  function drawBuildings(root) {
    const buildings = group('buildings');
    const nodes = allNodes();
    const placements = {
      lake:[-30,-108], market:[-20,105], museum:[-30,-100], longtan:[20,105], forest:[-35,112],
      theater:[25,-110], shizipo:[20,-108], summit:[-28,108], rest:[28,112], temple:[-25,-105], juxianzhuang:[25,105]
    };
    const templates = [
      { w:65,d:32,h:42 }, { w:74,d:37,h:46 }, { w:60,d:30,h:39 }, { w:78,d:39,h:50 }
    ];
    [...nodes].filter(node=>project(node)).sort((a,b)=>project(a).y-project(b).y).forEach((node,index) => {
      const id=node.node_id||node.id;
      if(node.type==='gate'||node.type==='scenery'||id==='qianqiu_lake'||id==='wanshou_lake')return;
      const p=project(node),offset=placements[id]||[(index%2?66:-72),index%3===0?75:-70],t=templates[index%templates.length];
      const kind=id==='market'||id==='creative_market'?'market':node.type==='show'?'stage':node.type==='service'?'service':id==='temple'||id==='wanfo_tower'?'temple':node.type==='view'?'pavilion':'hall';
      drawScenicBuilding(buildings,p.x+offset[0],p.y+offset[1],t,kind,id,node.name,index);
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

  function drawMap2Building(parent,x,y,kind,id,name,visualOnly=false,scaleOverride=null){
    const width=visualOnly?45:kind==='gate'?112:kind==='stage'?96:kind==='market'?76:kind==='temple'?86:kind==='service'||kind==='pavilion'?58:kind==='martial-hall'?112:kind==='cabaret'?96:82;
    const depth=visualOnly?22:kind==='gate'?42:kind==='stage'?38:kind==='market'?32:kind==='temple'?40:kind==='service'||kind==='pavilion'?28:kind==='martial-hall'?46:36;
    const wall=visualOnly?27:kind==='gate'?58:kind==='temple'?66:kind==='market'?43:kind==='service'||kind==='pavilion'?38:kind==='martial-hall'?58:kind==='stage'?58:52,shift=depth*.65,drop=depth*.34;
    const traditional=!visualOnly;
    const size=scaleOverride??(visualOnly?.43:kind==='stage'||kind==='pavilion'?1:kind==='gate'?.92:kind==='market'?.88:kind==='temple'?.9:.84);
    const centerX=(width+shift)/2;
    const g=el('g',{class:`m2-building m2-building-${kind} ${traditional?'m2-building-traditional':''} ${visualOnly?'m2-building-visual-only':''}`,'data-context-node':id||undefined,'data-map1-artwork-kind':kind,'data-visual-only':visualOnly?'true':undefined,'data-anchor-x':x,'data-anchor-y':y,'data-center-x':centerX,'data-size':size,transform:`translate(${x} ${y}) scale(${size}) translate(${-centerX} 0)`});
    if(kind==='gate'){
      g.append(el('ellipse',{cx:centerX,cy:10,rx:width*.56,ry:depth*.42,class:'m2-building-shadow'}));
      g.append(el('polygon',{points:`${width*.06} 0 ${width*.94} 0 ${width+shift} ${drop} ${shift} ${drop}`,class:'m2-building-plinth'}));
      g.append(el('polygon',{points:`${width*.12} ${-wall*.62} ${width*.27} ${-wall*.62} ${width*.27} 0 ${width*.12} 0`,class:'m2-building-gate-pillar'}));
      g.append(el('polygon',{points:`${width*.73} ${-wall*.62} ${width*.88} ${-wall*.62} ${width*.88} 0 ${width*.73} 0`,class:'m2-building-gate-pillar'}));
      g.append(el('polygon',{points:`${width*.12} ${-wall*.62} ${width*.88} ${-wall*.62} ${width*.88} ${-wall*.82} ${width*.12} ${-wall*.82}`,class:'m2-building-gate-beam'}));
      g.append(el('polygon',{points:`${width*.04} ${-wall*.82} ${width*.18} ${-wall} ${width*.82} ${-wall} ${width*.96} ${-wall*.82} ${width+shift*.45} ${-wall*.82+drop*.35} ${width+shift*.25} ${-wall*.68+drop*.35} ${width*.81} ${-wall*.84} ${width*.19} ${-wall*.84} ${shift*.7} ${-wall*.68} ${shift*.5} ${-wall*.82}`,class:'m2-building-gate-roof'}));
      g.append(el('rect',{x:width*.4,y:-wall*.72,width:width*.2,height:wall*.13,rx:2,class:'m2-building-gate-plaque'}));
      g.append(el('title',{},`${name} · 地图1同点位入口门楼模拟`));parent.append(g);return g;
    }
    // Draw 2.5D map geometry in the same vector system as the streets.  The
    // Song-style roofs mark landmark types; smaller context volumes stay pale.
    g.append(el('polygon',{points:`-6 5 ${width+shift+10} ${drop+8} ${width+shift+5} ${drop+20} -9 16`,class:'m2-building-shadow'}));
    g.append(el('polygon',{points:`0 0 ${width} 0 ${width+shift} ${drop} ${shift} ${drop}`,class:'m2-building-plinth'}));
    g.append(el('polygon',{points:`0 ${-wall} ${width} ${-wall} ${width} 0 0 0`,class:'m2-building-front'}));
    g.append(el('polygon',{points:`${width} ${-wall} ${width+shift} ${-wall+drop} ${width+shift} ${drop} ${width} 0`,class:'m2-building-side'}));
    // Roof, eaves and side wall make the scenic landmarks legible at street scale.
    // These are visual context around Map 1 nodes, never extra routable POIs.
    g.append(el('polygon',{points:`-2 ${-wall} ${shift-2} ${-wall+drop} ${width+shift+2} ${-wall+drop} ${width+2} ${-wall}`,class:'m2-building-roof'}));
    if(traditional)g.append(el('path',{d:`M${width*.22} ${-wall-10} L${width*.76} ${-wall-10} M${width*.22} ${-wall-10} L${shift-2} ${-wall+drop} M${width*.76} ${-wall-10} L${width+shift+2} ${-wall+drop}`,class:'m2-building-ridge'}));
    g.append(el('path',{d:`M3 ${-wall+5} H${width-3} M${width+3} ${-wall+5} L${width+shift-3} ${-wall+drop+5}`,class:'m2-building-parapet'}));
    if(traditional){
      g.append(el('rect',{x:-6,y:-wall+2,width:width+12,height:7,class:'m2-building-eave'}));
      g.append(el('polygon',{points:`${width+6} ${-wall+2} ${width+shift+7} ${-wall+drop+2} ${width+shift+7} ${-wall+drop+9} ${width+6} ${-wall+9}`,class:'m2-building-eave-side'}));
      const bayCount=kind==='stage'||kind==='gate'?5:kind==='market'?3:kind==='service'||kind==='pavilion'?2:kind==='martial-hall'?6:4;
      for(let i=0;i<=bayCount;i++){const col=3+i*(width-6)/bayCount;g.append(el('path',{d:`M${col} ${-wall+10} V0`,class:'m2-building-timber'}));}
      g.append(el('path',{d:`M3 ${-wall+25} H${width-3}`,class:'m2-building-timber'}));
      for(let i=0;i<bayCount;i++)g.append(el('rect',{x:9+i*(width-18)/bayCount,y:-wall+13,width:Math.max(5,(width-18)/bayCount-8),height:8,rx:1,class:'m2-building-window'}));
    }else for(let i=0;i<2;i++)g.append(el('rect',{x:7+i*15,y:-wall+10,width:9,height:9,rx:1,class:'m2-building-window'}));
    if(kind==='pavilion'||kind==='service'){
      g.append(el('rect',{x:8,y:-wall+7,width:5,height:wall-7,class:'m2-building-column'}),el('rect',{x:width-13,y:-wall+7,width:5,height:wall-7,class:'m2-building-column'}));
      g.append(el('path',{d:`M${width*.25} ${-wall+8}V0 M${width*.5} ${-wall+8}V0 M${width*.75} ${-wall+8}V0`,class:'m2-building-column-line'}));
    }else if(kind==='gate'){
      g.append(el('path',{d:`M${width*.39} 0V${-wall*.55}Q${width*.5} ${-wall*.88} ${width*.61} ${-wall*.55}V0Z`,class:'m2-building-gate-arch'}));
      g.append(el('rect',{x:width*.46,y:-wall-16,width:width*.08,height:12,rx:2,class:'m2-building-gate-plaque'}));
    }else g.append(el('rect',{x:width-14,y:-20,width:9,height:20,rx:1,class:'m2-building-door'}));
    if(kind==='stage')g.append(el('rect',{x:width*.18,y:-wall+24,width:width*.64,height:12,rx:2,class:'m2-building-stage-front'}));
    if(kind==='market')g.append(el('path',{d:`M5 ${-wall+23} H${width-5}`,class:'m2-building-market-awning'}));
    if(kind==='temple')g.append(el('path',{d:`M10 ${-wall+2} H${width-10} M${width*.5} ${-wall-17} v-10`,class:'m2-building-temple-detail'}));
    if(kind==='temple'||kind==='martial-hall'){
      g.append(el('polygon',{points:`${width*.22} ${-wall-8} ${width*.34} ${-wall-27} ${width*.7} ${-wall-27} ${width*.82} ${-wall-8}`,class:'m2-building-upper-roof'}));
      g.append(el('path',{d:`M${width*.34} ${-wall-27}L${width*.52} ${-wall-42}L${width*.7} ${-wall-27}`,class:'m2-building-upper-ridge'}));
    }
    if(kind==='cabaret')g.append(el('rect',{x:width*.16,y:-wall+22,width:width*.68,height:13,rx:2,class:'m2-building-marquee'}));
    if(kind==='martial-hall'){
      g.append(el('polygon',{points:`-26 ${-wall*.68} ${-8} ${-wall-16} ${width*.2} ${-wall-16} ${width*.28} ${-wall*.68}`,class:'m2-building-wing-roof'}));
      g.append(el('polygon',{points:`${width*.72} ${-wall*.68} ${width*.78} ${-wall-16} ${width+22} ${-wall-16} ${width+34} ${-wall*.68}`,class:'m2-building-wing-roof'}));
    }
    g.append(el('title',{},`${name} · ${visualOnly?'模拟沿街建筑，未核实现场位置':'立体示意建筑，非测绘资产'}，不参与导航规划`));parent.append(g);return g;
  }
  function drawMap2OpenLandmark(parent,node,x,y,size){
    const id=node.node_id||node.id,s=Math.max(20,size*.5),kind=window.ScenicOverviewMap?.artworkKind?.(node);
    const g=el('g',{class:'m2-open-landmark','data-context-node':id,'data-map1-artwork-kind':kind,'data-anchor-x':x,'data-anchor-y':y,'data-size':1,transform:`translate(${x} ${y})`});
    const shape=(name,attrs)=>g.append(el(name,attrs));
    if(['hero_square','xianxia_square','art_square','wulin_square','magic_square'].includes(id)){
      shape('ellipse',{cx:0,cy:7,rx:s*.75,ry:s*.33,fill:'#e7e4d8',stroke:'#bbc7c3','stroke-width':2});
      shape('ellipse',{cx:0,cy:5,rx:s*.47,ry:s*.2,fill:'#f4f1e7',stroke:'#d0d3c8','stroke-width':1});
      shape('path',{d:`M0 ${-s*.36} l${s*.12} ${s*.25} h${-s*.24}Z`,fill:'#a7b6b4',stroke:'#758e90','stroke-width':1});
    }else if(id==='circus'){
      shape('ellipse',{cx:0,cy:13,rx:s*.77,ry:s*.27,fill:'#c7cfca'});
      shape('path',{d:`M${-s*.65} 9 L0 ${-s*.75} L${s*.65} 9 Z`,fill:'#d9aa8c',stroke:'#9e665a','stroke-width':2});
      shape('path',{d:`M${-s*.24} 9 L0 ${-s*.75} L${s*.24} 9Z`,fill:'#f6ead5',stroke:'#bb8b70','stroke-width':1});
    }else if(id==='shenboat'){
      shape('path',{d:`M${-s*.8} 0 Q0 ${s*.28} ${s*.8} 0 L${s*.58} ${s*.35} Q0 ${s*.55} ${-s*.58} ${s*.35}Z`,fill:'#92684e',stroke:'#5b534b','stroke-width':2});
      shape('path',{d:`M${-s*.35} 0 V${-s*.38} H${s*.35} V0Z`,fill:'#e8d9bd',stroke:'#7d6855','stroke-width':2});
      shape('path',{d:`M${-s*.49} ${-s*.38} L0 ${-s*.7} L${s*.49} ${-s*.38}Z`,fill:'#344b4a',stroke:'#263b3a','stroke-width':2});
    }else if(id==='wanfo_tower'){
      for(let tier=0;tier<3;tier++){const w=s*(.65-tier*.13),top=s*.28-tier*s*.35;
        shape('rect',{x:-w*.4,y:top-s*.22,width:w*.8,height:s*.28,fill:'#e6d8bf',stroke:'#9e8970','stroke-width':1});
        shape('path',{d:`M${-w*.75} ${top-s*.24} Q0 ${top-s*.58} ${w*.75} ${top-s*.24} L${w*.5} ${top-s*.16} H${-w*.5}Z`,fill:'#334b49',stroke:'#263d3a','stroke-width':1.5});
      }
    }else if(kind==='fortress'){
      shape('ellipse',{cx:0,cy:13,rx:s*.9,ry:s*.38,fill:'#d9c9a5',stroke:'#aa9772','stroke-width':2});
      shape('path',{d:`M${s*.72} ${-s*.24}L${s*.88} ${-s*.4}V${s*.03}L${s*.72} 10Z`,fill:'#896b55',stroke:'#765d49','stroke-width':2});
      shape('path',{d:`M${-s*.72} 10V${-s*.24} H${-s*.48}V${-s*.38} H${-s*.27}V${-s*.24}H${s*.27}V${-s*.38}H${s*.48}V${-s*.24}H${s*.72}V10Z`,fill:'#b28b68',stroke:'#765d49','stroke-width':2});
      shape('path',{d:`M${-s*.18} 10V${-s*.12}Q0 ${-s*.3} ${s*.18} ${-s*.12}V10`,fill:'#594d40'});
      for(const dx of [-s*.55,s*.55])shape('path',{d:`M${dx} ${-s*.25}V${-s*.73}l${s*.23} ${s*.12}l${-s*.23} ${s*.1}`,fill:'#a74839',stroke:'#755b44','stroke-width':2});
    }else if(kind==='street'){
      shape('path',{d:`M${-s*1.1} 15Q0 34 ${s*1.1} 15`,fill:'none',stroke:'#dbc6a3','stroke-width':15});
      for(const dx of [-s*.65,0,s*.65]){
        shape('path',{d:`M${dx+s*.3} ${-s*.18}L${dx+s*.42} ${-s*.32}V${s*.13}L${dx+s*.3} 15Z`,fill:'#b79a76',stroke:'#8c725b','stroke-width':1.5});
        shape('path',{d:`M${dx-s*.3} 15V${-s*.18}H${dx+s*.3}V15Z`,fill:'#e9d5b4',stroke:'#a28769','stroke-width':1.5});
        shape('path',{d:`M${dx-s*.36} ${-s*.18}L${dx} ${-s*.55}L${dx+s*.36} ${-s*.18}L${dx+s*.42} ${-s*.32}L${dx+s*.06} ${-s*.69}Z`,fill:'#5c5a50',stroke:'#38423c','stroke-width':2});
        shape('path',{d:`M${dx-s*.3} ${-s*.14}H${dx+s*.3}M${dx-s*.25} ${-s*.12}V${s*.13}M${dx+s*.25} ${-s*.12}V${s*.13}`,fill:'none',stroke:'#8a694f','stroke-width':2});
        shape('rect',{x:dx-s*.08,y:s*.02,width:s*.16,height:s*.13,fill:'#66828a',stroke:'#f1e4c8','stroke-width':1});
        shape('path',{d:`M${dx-s*.38} ${-s*.17}L${dx} ${-s*.56}L${dx+s*.38} ${-s*.17}`,fill:'none',stroke:'#cba56c','stroke-width':2});
        shape('rect',{x:dx-s*.11,y:-s*.03,width:s*.22,height:s*.18,fill:'#865d45'});
      }
    }else if(kind==='camp'){
      shape('ellipse',{cx:0,cy:12,rx:s*.78,ry:s*.24,fill:'#d6dfc2'});
      shape('path',{d:`M${-s*.66} 12L0 ${-s*.63}L${s*.66} 12Z`,fill:'#d99d73',stroke:'#a66b54','stroke-width':2});
      shape('path',{d:`M0 ${-s*.63}L${s*.2} 12H${-s*.2}Z`,fill:'#f4dfb6'});
      shape('path',{d:`M${-s*.12} 12V${-s*.04}Q0 ${-s*.2} ${s*.12} ${-s*.04}V12`,fill:'#705846'});
    }else if(kind==='boardwalk'){
      shape('path',{d:`M${-s*.75} 16L${-s*.5} ${-s*.22}L${s*.5} ${-s*.22}L${s*.75} 16Z`,fill:'#ba9470',stroke:'#765c47','stroke-width':2});
      for(const dx of [-.38,-.15,.08,.31])shape('path',{d:`M${s*dx} 10L${s*dx*.6} ${-s*.18}`,stroke:'#ead9b9','stroke-width':2});
      shape('path',{d:`M${-s*.7} ${-s*.29}H${s*.7}M${-s*.55} ${-s*.29}V0M${s*.55} ${-s*.29}V0`,fill:'none',stroke:'#765c47','stroke-width':3});
    }else if(kind==='playground'){
      shape('ellipse',{cx:0,cy:13,rx:s*.78,ry:s*.28,fill:'#e6d7bc'});
      shape('path',{d:`M${-s*.53} 12V${-s*.55}H${s*.22}V12M${-s*.4} ${-s*.48}V${-s*.02}M${-s*.12} ${-s*.48}V${-s*.02}`,fill:'none',stroke:'#759da3','stroke-width':4});
      shape('path',{d:`M${-s*.46} ${-s*.02}Q${-s*.26} ${s*.12} ${-s*.06} ${-s*.02}M${s*.2} ${-s*.25}L${s*.62} 12H${s*.36}`,fill:'none',stroke:'#d88962','stroke-width':5});
    }else if(kind==='water'){
      if(id==='lake'){
        shape('path',{d:`M${-s*.54} ${-s*.45}Q0 ${-s*.68} ${s*.5} ${-s*.44}L${s*.34} ${s*.21}H${-s*.42}Z`,fill:'#aaa99c',stroke:'#788c88','stroke-width':2});
        shape('path',{d:`M${-s*.3} ${-s*.36}Q0 ${-s*.5} ${s*.25} ${-s*.34}V${s*.18}Q0 ${s*.42} ${-s*.24} ${s*.17}Z`,fill:'#92d4e4',stroke:'#eaf9f9','stroke-width':2});
      }else shape('ellipse',{cx:0,cy:3,rx:s*.68,ry:s*.29,fill:'#9dd4dd',stroke:'#fff','stroke-width':3});
    }else if(kind==='grove'){
      if(['lake','qianqiu_lake','wanshou_lake'].includes(id))shape('ellipse',{cx:0,cy:3,rx:s*.68,ry:s*.29,fill:'#9dd4dd',stroke:'#fff','stroke-width':3});
      else for(const [dx,dy,r] of [[-s*.35,0,s*.27],[0,-s*.14,s*.32],[s*.35,0,s*.25]]){
        shape('ellipse',{cx:dx,cy:dy+s*.28,rx:r*.65,ry:r*.22,fill:'#a7c7ae'});
        shape('circle',{cx:dx,cy:dy,r,fill:'#7faf8b',stroke:'#5f9979','stroke-width':2});
      }
    }else if(kind==='lookout'){
      shape('path',{d:`M${-s*.65} ${s*.22} V${-s*.22} H${-s*.33} V${-s*.38} H${-s*.12} V${-s*.22} H${s*.12} V${-s*.38} H${s*.33} V${-s*.22} H${s*.65} V${s*.22}Z`,fill:'#d8ded9',stroke:'#839a98','stroke-width':2});
    }else return false;
    g.append(el('title',{},`${node.name} · 地图1同点位示意地标`));parent.append(g);return true;
  }
  function drawMap2Tree(parent,x,y,size=1){
    const g=el('g',{class:'m2-tree-3d','data-anchor-x':x,'data-anchor-y':y,'data-size':size,transform:`translate(${x} ${y}) scale(${size})`});
    g.append(el('ellipse',{cx:5,cy:6,rx:15,ry:6,class:'m2-tree-shadow'}));
    g.append(el('path',{d:'M-2 4 L-1 -17 L4 -17 L5 4Z',class:'m2-tree-trunk'}));
    g.append(el('circle',{cx:-6,cy:-19,r:10,class:'m2-tree-crown-back'}),el('circle',{cx:5,cy:-25,r:12,class:'m2-tree-crown'}),el('circle',{cx:13,cy:-18,r:9,class:'m2-tree-crown-light'}));
    parent.append(g);
  }
  function drawScenicBuilding(parent,x,y,size,kind,id,name,index){
    const {w,d,h}=size,dx=d*.72,dy=d*.42,base=y,top=base-h;
    const building=el('g',{class:`c-building c-building-${kind}`,'data-node-id':id,transform:`translate(${x} ${y})`});
    // Raised stone plinth and cast shadow give the buildings a grounded axonometric footprint.
    building.append(el('polygon',{points:`-10 8 ${w+dx+12} ${dy+12} ${w+dx} ${dy+31} -18 25`,class:'c-building-shadow'}));
    building.append(el('polygon',{points:`0 0 ${w} 0 ${w+dx} ${dy} ${dx} ${dy}`,class:'c-building-plinth'}));
    building.append(el('polygon',{points:`0 ${-h} ${w} ${-h} ${w} 0 0 0`,class:'c-building-front'}));
    building.append(el('polygon',{points:`${w} ${-h} ${w+dx} ${-h+dy} ${w+dx} ${dy} ${w} 0`,class:'c-building-side'}));
    building.append(el('polygon',{points:`0 ${-h} ${dx} ${-h+dy} ${w+dx} ${-h+dy} ${w} ${-h}`,class:'c-roof-deck'}));
    // Long ridge, deep eaves, roof tile seams and brackets make this read as
    // a Song-themed scenic compound rather than a row of campus blocks.
    const roofTone=kind==='stage'?'#8d4036':kind==='temple'?'#575b57':kind==='market'?'#a4563e':kind==='service'?'#777f75':'#765044';
    building.append(el('polygon',{points:`-12 ${-h-10} ${w*.18} ${-h-28} ${w*.78} ${-h-28} ${w+12} ${-h-10} ${w+dx+9} ${-h+dy-3} ${w+dx-3} ${-h+dy+7} ${w*.77} ${-h-13} ${w*.18} ${-h-13} ${dx+3} ${-h+dy+7} ${dx-9} ${-h+dy-3}`,class:'c-roof-eaves',fill:roofTone}));
    building.append(el('path',{d:`M${w*.18} ${-h-28} L${w*.5} ${-h-39} L${w*.78} ${-h-28}`,class:'c-roof-ridge'}));
    building.append(el('path',{d:`M${dx-6} ${-h+dy-5} L${w*.18} ${-h-28} M${w+dx+5} ${-h+dy-5} L${w*.78} ${-h-28}`,class:'c-roof-hip'}));
    for(let i=1;i<6;i++){const tx=w*i/6;building.append(el('path',{d:`M${tx} ${-h-25} L${tx+dx*.35} ${-h+dy-6}`,class:'c-roof-tile'}));}
    if(kind==='temple'){
      building.append(el('polygon',{points:`${w*.28} ${-h-12} ${w*.39} ${-h-30} ${w*.7} ${-h-30} ${w*.82} ${-h-12}`,class:'c-roof-upper'}));
      building.append(el('path',{d:`M${w*.39} ${-h-30} L${w*.55} ${-h-39} L${w*.7} ${-h-30}`,class:'c-roof-ridge'}));
    } else if(kind==='market'){
      for(let i=0;i<3;i++)building.append(el('path',{d:`M${22+i*42} ${-h+7} v${h-7}`,class:'c-market-pillar'}));
      building.append(el('path',{d:`M10 ${-h+15} H${w-10}`,class:'c-market-counter'}));
    } else if(kind==='stage'){
      building.append(el('rect',{x:w*.3,y:-h+14,width:w*.4,height:23,rx:3,class:'c-stage-opening'}));
      building.append(el('path',{d:`M${w*.2} ${-h+43} H${w*.8}`,class:'c-stage-proscenium'}));
      building.append(el('path',{d:`M${w*.5} ${-h-38} v-19 m-8 8 8-8 8 8`,class:'c-stage-banner'}));
    } else if(kind==='pavilion'){
      building.append(el('path',{d:`M${w*.27} 0 V${-h+13} M${w*.73} 0 V${-h+13}`,class:'c-pavilion-post'}));
    } else {
      const rows=Math.max(1,Math.floor((h-24)/21));
      for(let row=0;row<rows;row++)for(let col=0;col<4;col++)building.append(el('rect',{x:12+col*(w-26)/4,y:-h+15+row*20,width:8,height:11,rx:2,class:'c-building-window'}));
      building.append(el('rect',{x:w*.43,y:-27,width:w*.15,height:27,class:'c-building-door'}));
      building.append(el('path',{d:`M${w*.37} 1 L${w*.5} -19 L${w*.63} 1Z`,class:'c-building-stair'}));
    }
    if(kind==='service')building.append(el('rect',{x:w*.38,y:-h+16,width:42,height:24,rx:5,class:'c-building-sign'}),el('text',{x:w*.38+21,y:-h+33,'text-anchor':'middle',class:'c-building-sign-text'},'服务'));
    building.append(el('title',{},`${name} · 宋风景区建筑模拟体块`));
    parent.append(building);return building;
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
      const type=roadRenderType(edge), main=type==='main_walkway', cls=main?'main':'walk';
      const fromNode=nodeMap().get(edge.from_node_id),toNode=nodeMap().get(edge.to_node_id);
      const fromCrowd=fromNode?.poi_id?crowdForPoi(fromNode.poi_id).ratio:0,toCrowd=toNode?.poi_id?crowdForPoi(toNode.poi_id).ratio:0;
      const comfort=comfortClass(comfortScore(edge.shade,(fromCrowd+toCrowd)/2));
      const under=el('path',{d:path,class:`c-road-casing ${cls}`});
      const roadName=app.roadNames?.[edge.edge_id]?.name||(main?'主游览步道':'普通步道');
      const line=el('path',{d:path,class:`c-road-line ${cls} c-comfort-${comfort}`,'data-edge-id':edge.edge_id,'data-road-type':type,'data-shade':edge.shade,tabindex:'0',role:'button','aria-label':roadName});
      line.append(el('title',{},`${roadName} · ${edge.distance_m}米 · 模拟舒适度参考：遮阴 ${(Number(edge.shade)||0)*100|0}%、端点模拟拥挤度 ${Math.round((fromCrowd+toCrowd)*50)}% · ${edge.location_source==='field_survey'?'实测步行路':'地图参考步行路'}`));
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
    const heatDefs=el('defs');
    const navigationNodes=app.navigationRoute?.path||[],nextNode=navigationPose()?.to,destinationNode=navigationNodes.at(-1);
    for(const node of allNodes()) {
      const id=node.node_id||node.id, p=project(node), {poiId,status,forecast,event:nodeEvent}=statusForNode(node);
      if(!p) continue;
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
        const crowd=crowdForPoi(poiId),ratio=crowd.ratio,cls=crowdClass(ratio),comfort=comfortScore(node.shade,ratio);
        const marker=el('g',{class:`c-poi c-crowd-${cls} c-comfort-${comfortClass(comfort)} ${status.open===false?'is-closed':''} ${id===nextNode?'is-navigation-next':''} ${id===destinationNode?'is-navigation-target':''}`,'data-node-id':id,'data-poi-id':poiId,'data-area-id':node.area_id||'','data-crowd-ratio':ratio.toFixed(3),'data-comfort-score':comfort.toFixed(3),tabindex:'0',role:'button','aria-label':`${node.name}，模拟拥挤度 ${Math.round(ratio*100)}%，舒适度参考 ${Math.round(comfort*100)} 分`});
        marker.append(el('ellipse',{cx:p.x,cy:p.y+3,rx:30,ry:13,class:'c-poi-shadow'}));
        marker.append(el('circle',{cx:p.x,cy:p.y-12,r:22,class:'c-poi-pin'}));
        marker.append(el('text',{x:p.x,y:p.y-5,class:'c-poi-glyph','text-anchor':'middle'},node.type==='show'?'★':node.type==='service'?'休':node.type==='view'?'景':'景'));
        marker.append(el('rect',{x:p.x+21,y:p.y-39,width:app.theme==='crowd'?90:68,height:27,rx:11,class:'c-queue-pill'}));
        marker.append(el('text',{x:p.x+(app.theme==='crowd'?66:55),y:p.y-20,class:'c-queue-text','text-anchor':'middle'},status.open===false?'暂停':app.theme==='crowd'?`模拟 ${Math.round(ratio*100)}%`:`${Math.round(Number(status.queue_min||0))}分`));
        const name=el('g',{class:'c-poi-name','data-poi-label':poiId});name.append(el('rect',{x:p.x-84,y:p.y+18,width:168,height:34,rx:7}));name.append(el('text',{x:p.x,y:p.y+41,'text-anchor':'middle'},node.name));marker.append(name);
        if(node.type==='service') marker.dataset.facilityId=node.facility_id||node.poi_id||node.node_id||id;
        marker.append(el('title',{},`${node.name} · ${app.crowdHorizon?`${app.crowdHorizon}分钟后`: '当前状态'}模拟拥挤度 ${Math.round(ratio*100)}%（模拟客流） · 模拟舒适度参考 ${Math.round(comfort*100)}分（遮阴与拥挤度估算） · 当前排队参考 ${Math.round(Number(status.queue_min||0))}分钟 · 预计排队 ${forecast?Math.round(Number(forecast.queue_min||0)):'--'}分钟${crowd.trend===null?'':` · 上升趋势风险 ${Math.round(crowd.trend*100)}%`}${nodeEvent?` · ${nodeEvent.title} ${nodeEvent.start_time||''}`:''}`));
        marker.addEventListener('click',event=>{event.stopPropagation();app.selectedPoi=poiId;emitEvent('POI_CLICK',poiId,'target_id');if(app.onPoiClick)app.onPoiClick(node,{...status,forecast,event:nodeEvent});});
        marker.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();marker.dispatchEvent(new MouseEvent('click',{bubbles:true}));}});
        pois.append(marker);
        const gradientId=`crowd-${String(poiId).replace(/[^a-zA-Z0-9_-]/g,'-')}`;
        const gradient=el('radialGradient',{id:gradientId});
        gradient.append(el('stop',{offset:'0%','stop-color':ratio>=.67?'#d83e32':ratio>=.4?'#e8992c':'#31a873','stop-opacity':ratio>=.67?'.72':ratio>=.4?'.58':'.42'}),el('stop',{offset:'48%','stop-color':ratio>=.67?'#ed6b39':ratio>=.4?'#f2c04c':'#74c990','stop-opacity':'.34'}),el('stop',{offset:'100%','stop-color':'#ffffff','stop-opacity':'0'}));heatDefs.append(gradient);
        const radius=42+ratio*66;
        heat.append(el('circle',{cx:p.x,cy:p.y-6,r:radius,fill:`url(#${gradientId})`,class:`c-heat-glow ${cls}`,'data-poi-id':poiId,'data-crowd-ratio':ratio.toFixed(3)}));
        heat.append(el('circle',{cx:p.x,cy:p.y-6,r:Math.max(14,radius*.34),class:`c-heat-ring ${cls}`}));
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
    heat.prepend(heatDefs);root.append(heat,events,pois);
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
      const d=svgPathForEdge(edge,from,to); if(!d)return;
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
    const layer=group('navigation'),geometry=routeGeometry(),nodes=route.path||[],at=app.navigationProgress*geometry.total;
    const continuous=route.continuous===true,toTurn=navigationPose()?.distanceToNext||0,highlightUntil=continuous?geometry.total:at+toTurn,visibleUntil=continuous?geometry.total:highlightUntil+45;
    geometry.segments.forEach(segment=>{
      if(segment.distance<=0)return;
      const from=Math.max(0,(at-segment.startDistance)/segment.distance),previewTo=1;
      if(previewTo<=from)return;
      const previewPoints=clipPolyline(segment.points,from,previewTo);if(previewPoints.length<2)return;
      const fullD=`M${previewPoints.map(point=>`${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' L')}`;
      layer.append(el('path',{d:fullD,class:'c-navigation-context','data-navigation-edge':segment.edgeId}));
      const roadName=app.roadNames[segment.edgeId]?.name;
      if(segment.startDistance<=visibleUntil){
        layer.append(el('path',{d:fullD,class:'c-navigation-roadbed-casing','data-navigation-edge':segment.edgeId}));
        layer.append(el('path',{d:fullD,class:'c-navigation-roadbed','data-navigation-edge':segment.edgeId}));
        layer.append(el('path',{d:fullD,class:'c-navigation-base','data-navigation-edge':segment.edgeId}));
      }
      const to=continuous?1:Math.min(1,(highlightUntil-segment.startDistance)/segment.distance);
      if(to<=from)return;
      const points=clipPolyline(segment.points,from,to);if(points.length<2)return;
      const d=`M${points.map(point=>`${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' L')}`;
      layer.append(el('path',{d,class:'c-navigation-halo','data-navigation-edge':segment.edgeId}));layer.append(el('path',{d,class:'c-navigation-line','data-navigation-edge':segment.edgeId}));
      // Keep the street name above the route casing and blue guidance stroke.
      if(roadName&&segment.startDistance<=visibleUntil){const labelPoint=interpolateLine(segment.points,.54);if(labelPoint){const label=el('text',{x:labelPoint.x,y:labelPoint.y-14,class:'m2-road-label','data-anchor-x':labelPoint.x,'data-anchor-y':labelPoint.y,'data-road-label':segment.edgeId,'text-anchor':'middle'},roadName);layer.append(label);}}
      for(const fraction of (continuous?[.62]:[.38,.78])){
        const before=interpolateLine(points,Math.max(0,fraction-.035)),position=interpolateLine(points,fraction),after=interpolateLine(points,Math.min(1,fraction+.035));
        if(!before||!position||!after||Math.hypot(after.x-before.x,after.y-before.y)<2)continue;
        const angle=Math.atan2(after.y-before.y,after.x-before.x)*180/Math.PI;
        layer.append(el('path',{d:'M-7 -5 L0 0 L-7 5',transform:`translate(${position.x} ${position.y}) rotate(${angle})`,class:'c-navigation-arrow'}));
      }
    });
    geometry.segments.slice(0,-1).forEach(segment=>{
      const junction=segment.points.at(-1);
      if(!junction)return;
      layer.append(el('circle',{cx:junction.x,cy:junction.y,r:10,class:'c-navigation-junction-halo'}));
      layer.append(el('circle',{cx:junction.x,cy:junction.y,r:4,class:'c-navigation-junction-dot'}));
    });
    const destination=nodeMap().get(nodes.at(-1));
    if(destination&&geometry.total-at<=120){const p=project(destination),flag=el('g',{class:'c-navigation-destination',transform:`translate(${p.x} ${p.y-18})`});flag.append(el('circle',{r:27}));flag.append(el('path',{d:'M-7 -14 H13 L7 -4 L13 6 H-7Z'}));flag.append(el('text',{x:0,y:49,'text-anchor':'middle'},'目的地'));layer.append(flag);}
    root.append(layer);
  }
  function drawVisitor(root) {
    const visitor=group('visitor'); const pose=navigationPose(); const id=app.state?.visitor?.current_node_id; const node=nodeMap().get(id); const p=pose?.point||(node?project(node):null);
    if(p){const pin=el('g',{class:'c-visitor-pin',transform:`translate(${p.x} ${p.y-12}) scale(.62)`});pin.append(el('circle',{r:25,class:'c-visitor-pulse'}));pin.append(el('circle',{r:11,class:'c-visitor-dot'}));pin.append(el('path',{d:'M-7 0 L0 -13 L7 0Z',class:'c-visitor-arrow'}));pin.append(el('text',{x:0,y:42,'text-anchor':'middle'},pose?'演示位置':'你在这里'));visitor.append(pin);}
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
    const scene=group('scene'); app.scene=scene;
    const terrain=group('terrain'),roads=group('roads'),buildings=group('buildings');
    const aligned=alignedMap1Layers(app.graph);
    terrain.append(aligned.background);
    roads.append(...aligned.roads.childNodes);
    buildings.append(...aligned.landmarks.childNodes);
    const tracedPaths=group('tracedPaths');
    const activeEdgeIds=new Set(app.navigationRoute?.edgeSequence||[]);
    const activeNodeIds=new Set(app.navigationRoute?.path||[]),recommendationStopIds=new Set(app.navigationRoute?.stopNodes||[]);
    const cameraPose=navigationPose();
    const previewCenter=project(nodeMap().get(app.previewNode||app.state?.visitor?.current_node_id))||{x:1200,y:250};
    const focusPoint=cameraPose?.point||previewCenter;
    for(const edge of app.graph.edges||[]){
      if((layout.overviewBaseEdges||[]).includes(edge.edge_id)||!activeEdgeIds.has(edge.edge_id))continue;
      const d=svgPathForEdge(edge,edge.from_node_id,edge.to_node_id);if(!d)continue;
      const main=(layout.mainEdges||[]).includes(edge.edge_id);
      const roadName=app.roadNames?.[edge.edge_id]?.name||'景区步道';
      const line=el('path',{d,class:`overview-road m2-road ${main?'is-main':''} is-detail-only`,'data-edge-id':edge.edge_id,tabindex:'0',role:'button','aria-label':roadName});
      line.append(el('title',{},`${roadName} · ${edge.distance_m||edge.distance||'--'}米 · 地图一示意路网`));
      line.addEventListener('click',()=>emitEvent('ROAD_CLICK',edge.edge_id,'edge_id'));roads.append(line);
    }
    const pois=group('poi'),crowdHeat=group('heat'),crowdDefs=el('defs');
    for(const node of allNodes()){
      const id=node.node_id||node.id,p=project(node);if(!p)continue;
      // During guidance the moving position pin replaces the static start icon.
      if(cameraPose&&id===app.navigationRoute?.path?.[0])continue;
      const isGate=node.type==='gate',status=statusForNode(node),crowd=status.poiId?crowdForPoi(status.poiId):{ratio:0,trend:null},comfort=comfortScore(node.shade,crowd.ratio),crowdLevel=crowdClass(crowd.ratio),isTarget=id===(app.navigationRoute?.path?.at(-1)||app.previewDestination),isOrigin=id===(app.navigationRoute?.path?.[0]||app.previewNode),isNext=id===cameraPose?.to,isMajor=['temple','market','museum','theater','longtan','forest','summit','wanfo_tower','southgate','gate'].includes(id);
      const nearby=cameraPose&&Math.hypot(p.x-focusPoint.x,p.y-focusPoint.y)<300;
      const routeNode=activeNodeIds.has(id);
      if(status.poiId){const gradientId=`map2-crowd-${String(status.poiId).replace(/[^a-zA-Z0-9_-]/g,'-')}`,gradient=el('radialGradient',{id:gradientId});gradient.append(el('stop',{offset:'0%','stop-color':crowdLevel==='high'?'#d83e32':crowdLevel==='mid'?'#e8992c':'#31a873','stop-opacity':crowdLevel==='high'?'.74':crowdLevel==='mid'?'.58':'.42'}),el('stop',{offset:'55%','stop-color':crowdLevel==='high'?'#ed6b39':crowdLevel==='mid'?'#f2c04c':'#74c990','stop-opacity':'.3'}),el('stop',{offset:'100%','stop-color':'#fff','stop-opacity':'0'}));crowdDefs.append(gradient);crowdHeat.append(el('circle',{cx:p.x,cy:p.y,r:35+crowd.ratio*58,fill:`url(#${gradientId})`,class:`m2-crowd-glow ${crowdLevel}`,'data-poi-id':status.poiId,'data-crowd-ratio':crowd.ratio.toFixed(3)}),el('circle',{cx:p.x,cy:p.y,r:24+crowd.ratio*45,class:`m2-crowd-contour ${crowdLevel}`,'data-poi-id':status.poiId}));}
      const marker=el('g',{class:`m2-poi m2-crowd-${crowdLevel} m2-comfort-${comfortClass(comfort)} ${isGate?'is-gate':''} ${isMajor?'is-major':''} ${nearby?'is-nearby':''} ${routeNode?'is-route-node':''} ${recommendationStopIds.has(id)?'is-recommendation-stop':''} ${status.status?.open===false?'is-closed':''} ${isTarget?'is-target':''} ${isOrigin?'is-origin':''} ${isNext?'is-next':''} ${app.selectedNode===id?'is-selected':''}`,'data-node-id':id,'data-poi-id':status.poiId||'','data-crowd-ratio':crowd.ratio.toFixed(3),'data-comfort-score':comfort.toFixed(3),'data-anchor-x':p.x,'data-anchor-y':p.y,tabindex:'0',role:'button','aria-label':`${node.name}，模拟拥挤度${Math.round(crowd.ratio*100)}%，舒适度参考${Math.round(comfort*100)}分，点击选择为导航终点`});
      marker.append(el('circle',{cx:p.x,cy:p.y,r:22,class:'m2-selection-halo'}),el('circle',{cx:p.x,cy:p.y,r:17,class:'m2-poi-hit'}),el('circle',{cx:p.x,cy:p.y,r:isGate?13:isMajor?10:6,class:'m2-pin'}),el('circle',{cx:p.x,cy:p.y,r:isMajor||isGate?3:2,class:'m2-pin-core'}));
      const name=(layout.displayNames?.[id]||node.name||'景点').replace(/^(大宋|万岁山)/,''),showMapLabel=nearby||routeNode||isMajor||isTarget||isNext||app.selectedNode===id||app.zoom>=1.35;
      marker.append(el('rect',{x:p.x+9,y:p.y-26,width:Math.max(44,name.length*15+15),height:21,rx:7,class:'m2-label-backdrop'}));
      marker.append(el('text',{x:p.x+15,y:p.y-11,class:`m2-label ${isOrigin?'is-route-origin':''} ${isTarget?'is-route-target':''}`},name));
      if(app.theme==='crowd'&&status.poiId&&showMapLabel){marker.append(el('rect',{x:p.x+9,y:p.y+3,width:72,height:19,rx:7,class:'m2-data-label-backdrop crowd'}),el('text',{x:p.x+15,y:p.y+17,class:'m2-crowd-label'},`人流 ${Math.round(crowd.ratio*100)}%`));}
      if(app.theme==='comfort'&&status.poiId&&showMapLabel){marker.append(el('rect',{x:p.x+9,y:p.y+3,width:83,height:19,rx:7,class:'m2-data-label-backdrop comfort'}),el('text',{x:p.x+15,y:p.y+17,class:'m2-comfort-label'},`舒适 ${Math.round(comfort*100)}`));}
      marker.append(el('title',{},`${node.name}${status.status?.open===false?' · 暂停开放':''} · ${app.crowdHorizon?`${app.crowdHorizon}分钟后`: '当前'}模拟拥挤度 ${Math.round(crowd.ratio*100)}% · 模拟舒适度参考 ${Math.round(comfort*100)}分（按遮阴与模拟拥挤度估算）`));
      marker.addEventListener('click',event=>{event.stopPropagation();app.selectedNode=id;app.root.querySelectorAll('.m2-poi').forEach(item=>item.classList.toggle('is-selected',item.dataset.nodeId===id));if(status.poiId)emitEvent('POI_CLICK',status.poiId,'target_id');if(app.onPoiClick)app.onPoiClick(node,{...status.status,forecast:status.forecast});});
      marker.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();marker.dispatchEvent(new MouseEvent('click',{bubbles:true}));}});pois.append(marker);
    }
    const visitor=group('visitor'),pose=navigationPose(),currentNode=nodeMap().get(app.state?.visitor?.current_node_id),current=pose?.point||(currentNode&&project(currentNode));
    if(current){const pin=el('g',{class:'m2-current','data-anchor-x':current.x,'data-anchor-y':current.y,transform:`translate(${current.x} ${current.y})`});pin.append(el('circle',{r:21,class:'m2-current-pulse'}),el('circle',{r:9,class:'m2-current-dot'}),el('path',{d:'M0 -5 L5 5 L0 3 L-5 5Z',class:'m2-current-arrow'}));visitor.append(pin);}
    crowdHeat.prepend(crowdDefs);scene.append(terrain,crowdHeat,tracedPaths,roads);
    // The personalized itinerary can differ from a visitor's independently
    // selected point-to-point route. Do not draw both lines over one another.
    if(!app.navigationRoute?.edgeSequence?.length)drawRoute(scene);
    drawNavigation(scene);scene.append(buildings,pois,visitor);
    app.root.append(scene); applyVisibility(); applyCamera();
  }
  function emitEvent(type,targetId,targetField='target_id') {
    const detail={schema_version:app.state?.schema_version||app.graph?.schema_version||'0.1',scenario_id:app.state?.scenario_id||app.graph?.scenario_id||'demo_001',event_type:type,[targetField]:targetId,timestamp:app.state?.timestamp||new Date().toISOString()};
    window.lastScenicUserEvent=detail;window.dispatchEvent(new CustomEvent('scenic-user-event',{detail}));return detail;
  }
  function routeGeometry(route=app.navigationRoute){
    const edges=edgeMap(),nodes=route?.path||[],segments=[];let total=0;
    (route?.edgeSequence||[]).forEach((edgeId,index)=>{
      const edge=edges.get(edgeId);let line=map1EdgePoints(edgeId);
      if(!edge||!line?.length){if(edge)console.warn(`地图2导航缺少地图1边几何: ${edgeId}`);return;}
      if(edge.from_node_id===nodes[index+1]&&edge.to_node_id===nodes[index])line=[...line].reverse();
      const projected=line;
      const geometryLength=projected.slice(1).reduce((sum,p,i)=>sum+Math.hypot(p.x-projected[i].x,p.y-projected[i].y),0);
      const distance=Math.max(0,Number(edge.distance_m||edge.distance||geometryLength));
      segments.push({edgeId,from:nodes[index],to:nodes[index+1],points:projected,geometryLength,distance,startDistance:total});total+=distance;
    });
    return {segments,total};
  }
  function interpolateLine(points,fraction){
    if(!points?.length)return null;if(points.length===1)return {...points[0]};
    const lengths=[];let total=0;for(let i=1;i<points.length;i++){const len=Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y);lengths.push(len);total+=len;}
    if(!total)return {...points[0]};let remaining=Math.max(0,Math.min(1,fraction))*total;
    for(let i=0;i<lengths.length;i++){if(remaining<=lengths[i]||i===lengths.length-1){const t=lengths[i]?remaining/lengths[i]:0;return{x:points[i].x+(points[i+1].x-points[i].x)*t,y:points[i].y+(points[i+1].y-points[i].y)*t};}remaining-=lengths[i];}
    return {...points.at(-1)};
  }
  function clipPolyline(points,startFraction,endFraction){
    if(!points?.length||endFraction<=startFraction)return[];
    const start=interpolateLine(points,startFraction),end=interpolateLine(points,endFraction),interior=[];
    const lengths=[];let total=0;for(let i=1;i<points.length;i++){const length=Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y);lengths.push(length);total+=length;}
    let walked=0;for(let i=1;i<points.length;i++){walked+=lengths[i-1];const fraction=total?walked/total:1;if(fraction>startFraction&&fraction<endFraction)interior.push(points[i]);}
    return[start,...interior,end].filter((point,index,list)=>index===0||Math.hypot(point.x-list[index-1].x,point.y-list[index-1].y)>.2);
  }
  function navigationPose(progress=app.navigationProgress){
    const geometry=routeGeometry();if(!geometry.segments.length||!geometry.total)return null;
    const at=Math.max(0,Math.min(1,Number(progress)||0))*geometry.total;
    let segment=geometry.segments.find(item=>at<item.startDistance+item.distance)||geometry.segments.at(-1);
    const local=segment.distance?Math.max(0,Math.min(1,(at-segment.startDistance)/segment.distance)):0;
    const point=interpolateLine(segment.points,local);
    // Aim along the road immediately ahead of the simulated location. Looking
    // a third of the way down a curved Map 1 edge can point backward before
    // its first bend (notably the south gate approach).
    const segmentIndex=geometry.segments.indexOf(segment),headingFrom=interpolateLine(segment.points,local);
    let headingTo=interpolateLine(segment.points,Math.min(1,local+.04));
    if(Math.hypot(headingTo.x-headingFrom.x,headingTo.y-headingFrom.y)<1)headingTo=interpolateLine(segment.points,Math.min(1,local+.12));
    if(Math.hypot(headingTo.x-headingFrom.x,headingTo.y-headingFrom.y)<1&&segmentIndex<geometry.segments.length-1){const next=geometry.segments[segmentIndex+1];headingTo=interpolateLine(next.points,.08);}
    if(Math.hypot(headingTo.x-headingFrom.x,headingTo.y-headingFrom.y)<1&&segment.points.length>1){const tail=segment.points.at(-1),prior=segment.points.at(-2);headingTo={x:headingFrom.x+tail.x-prior.x,y:headingFrom.y+tail.y-prior.y};}
    const heading=Math.atan2(headingTo.y-headingFrom.y,headingTo.x-headingFrom.x)*180/Math.PI;
    const remaining=Math.max(0,geometry.total-at);
    const nextTurn=geometry.segments.slice(geometry.segments.indexOf(segment)+1).find(item=>item.distance>0);
    let maneuver='沿当前步道前行';
    if(nextTurn&&segment.points.length>1&&nextTurn.points.length>1){const incoming=segment.points.at(-1),outgoing=nextTurn.points[1];const inAngle=Math.atan2(incoming.y-segment.points.at(-2).y,incoming.x-segment.points.at(-2).x);const outAngle=Math.atan2(outgoing.y-nextTurn.points[0].y,outgoing.x-nextTurn.points[0].x);let delta=(outAngle-inAngle)*180/Math.PI;while(delta>180)delta-=360;while(delta< -180)delta+=360;maneuver=Math.abs(delta)<28?'沿当前步道前行':Math.abs(delta)>150?'前方折返':delta>0?'前方右转':'前方左转';}
    if(remaining<1)maneuver='已到达目的地';
    return {point,heading,edgeId:segment.edgeId,from:segment.from,to:segment.to,remaining,distanceToNext:Math.max(0,segment.distance-(at-segment.startDistance)),progress:geometry.total?at/geometry.total:0,maneuver};
  }
  function keepLandmarksUpright(rotation,depth,scale=1){
    if(!app.scene)return;
    for(const item of app.scene.querySelectorAll('.m2-building,.m2-open-landmark,.m2-tree-3d,.m2-poi,.m2-current,.m2-road-label')){
      const x=Number(item.dataset.anchorX),y=Number(item.dataset.anchorY),size=Number(item.dataset.size||1);
      if(item.classList.contains('m2-source-landmark')){
        const pose=app.immersive&&navigationPose(),angle=pose?pose.heading*Math.PI/180:0;
        const forward=pose?(x-pose.point.x)*Math.cos(angle)+(y-pose.point.y)*Math.sin(angle):0;
        const perspective=pose?Math.max(.82,Math.min(1.26,1.12-forward*.00016)):1;
        item.setAttribute('transform',`translate(${x} ${y}) rotate(${-rotation}) scale(1 ${1/depth}) scale(${size*(app.immersive?1.14*perspective:1)}) translate(${-x} ${-y})`);
      }
      else if(item.classList.contains('m2-poi'))item.setAttribute('transform',`translate(${x} ${y}) rotate(${-rotation}) scale(1 ${1/depth}) scale(${1.35/scale}) translate(${-x} ${-y})`);
      else if(item.classList.contains('m2-current'))item.setAttribute('transform',`translate(${x} ${y}) rotate(${-rotation}) scale(1 ${1/depth}) scale(${1.35/scale})`);
      else if(item.classList.contains('m2-road-label'))item.setAttribute('transform',`translate(${x} ${y}) rotate(${-rotation}) scale(1 ${1/depth}) scale(${1/scale}) translate(${-x} ${-y})`);
      else item.setAttribute('transform',`translate(${x} ${y}) rotate(${-rotation}) scale(1 ${1/depth}) scale(${app.immersive?.66:1}) scale(${size}) translate(${-Number(item.dataset.centerX||0)} 0)`);
    }
  }
  function updateCompass(rotation){
    const control=document.querySelector('#mapNorth');if(!control)return;
    const needle=control.querySelector('.map-north-needle');if(needle)needle.style.transform=`rotate(${rotation}deg)`;
    control.setAttribute('aria-pressed',String(app.northUp));
    control.setAttribute('aria-label',app.northUp?'切换到行进方向朝上':'切换到北向朝上');
  }
  function applyCamera(){
    if(!app.root)return;
    app.root.setAttribute('data-immersive',String(app.immersive));
    const pose=navigationPose();
    if(pose&&app.scene&&app.navigationRoute?.continuous&&!app.followNavigation){
      const geometry=routeGeometry(),points=geometry.segments.flatMap(segment=>segment.points);
      if(points.length){const xs=points.map(point=>point.x),ys=points.map(point=>point.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),padding=170,viewHeight=Math.max(420,(maxY-minY+padding*2)/app.zoom),viewWidth=Math.max(760,(maxX-minX+padding*2)/app.zoom,viewHeight*app.root.clientWidth/Math.max(1,app.root.clientHeight)),centerX=(minX+maxX)/2-app.pan.x,centerY=(minY+maxY)/2-app.pan.y;app.scene.removeAttribute('transform');keepLandmarksUpright(0,1,1);app.root.setAttribute('viewBox',`${centerX-viewWidth/2} ${centerY-viewHeight/2} ${viewWidth} ${viewHeight}`);app.root.setAttribute('preserveAspectRatio','xMidYMid meet');app.root.setAttribute('data-navigation-focus','route-overview');app.root.removeAttribute('data-follow-edge');if(app.onNavigationProgress)app.onNavigationProgress(pose);return;}
    }
    if(pose&&app.scene){
      const rotation=(app.immersive?-90-pose.heading:app.northUp?0:-90-pose.heading)+app.bearing;
      const depth=app.immersive?.46:CAMERA_VIEW.depth,scale=(app.immersive?3.45:CAMERA_VIEW.scale)*app.zoom;
      // North-up still needs forward space: a southbound traveler belongs near
      // the top of the viewport, while a northbound traveler belongs below.
      const direction=pose.heading*Math.PI/180;
      const to=project(nodeMap().get(pose.to)),lookAhead=to?{x:to.x-pose.point.x,y:to.y-pose.point.y}:{x:0,y:0};
      const radians=rotation*Math.PI/180;
      const lateral=(lookAhead.x*Math.cos(radians)-lookAhead.y*Math.sin(radians))*scale;
      const anchorX=!app.immersive&&app.northUp?CAMERA_VIEW.anchorX-300*Math.cos(direction):CAMERA_VIEW.anchorX-Math.max(-220,Math.min(220,lateral*.3));
      const anchorY=app.immersive?760:!app.immersive&&app.northUp?610-280*Math.sin(direction):CAMERA_VIEW.anchorY;
      app.scene.setAttribute('transform',`translate(${anchorX+app.pan.x} ${anchorY+app.pan.y}) scale(${scale}) scale(1 ${depth}) rotate(${rotation}) translate(${-pose.point.x} ${-pose.point.y})`);
      keepLandmarksUpright(rotation,depth,scale);updateCompass(rotation);
      app.root.setAttribute('viewBox',`0 0 ${CAMERA_VIEW.width} ${CAMERA_VIEW.height}`);app.root.setAttribute('preserveAspectRatio','xMidYMid slice');app.root.setAttribute('data-navigation-focus','true');
      app.root.setAttribute('data-follow-edge',pose.edgeId);app.root.setAttribute('data-progress',pose.progress.toFixed(3));
      if(app.onNavigationProgress)app.onNavigationProgress(pose);
      return;
    }
    const preview=nodeMap().get(app.previewNode||app.state?.visitor?.current_node_id),previewPoint=preview&&project(preview);
    if(previewPoint&&app.scene){
      const destinationNode=nodeMap().get(app.previewDestination),destination=destinationNode&&project(destinationNode),heading=destination&&Math.hypot(destination.x-previewPoint.x,destination.y-previewPoint.y)>10?Math.atan2(destination.y-previewPoint.y,destination.x-previewPoint.x)*180/Math.PI:null;
      const rotation=(app.immersive?(heading===null?-90:-90-heading):app.northUp?0:heading===null?-16:-90-heading)+app.bearing,depth=app.immersive?.5:.7;
      const center=destination?{x:(previewPoint.x+destination.x)/2,y:(previewPoint.y+destination.y)/2}:previewPoint;
      const span=destination?Math.hypot(destination.x-previewPoint.x,destination.y-previewPoint.y):900;
      const previewScale=Math.min(app.immersive?2.5:1.8,Math.max(.65,CAMERA_VIEW.width*(app.immersive?.9:.72)/Math.max(span,1)));
      app.scene.setAttribute('transform',`translate(${CAMERA_VIEW.anchorX+app.pan.x} ${CAMERA_VIEW.height*(app.immersive?.68:.52)+app.pan.y}) scale(${previewScale*app.zoom}) scale(1 ${depth}) rotate(${rotation}) translate(${-center.x} ${-center.y})`);
      keepLandmarksUpright(rotation,depth,previewScale*app.zoom);updateCompass(rotation);
      app.root.setAttribute('viewBox',`0 0 ${CAMERA_VIEW.width} ${CAMERA_VIEW.height}`);
      app.root.setAttribute('preserveAspectRatio','xMidYMid slice');app.root.setAttribute('data-navigation-focus','preview');app.root.removeAttribute('data-follow-edge');
      return;
    }
    if(app.scene)app.scene.removeAttribute('transform');updateCompass(0);
    const w=WIDTH/app.zoom,h=HEIGHT/app.zoom,x=(WIDTH-w)/2,y=(HEIGHT-h)/2;
    app.root.setAttribute('viewBox',`${x} ${y} ${w} ${h}`);app.root.setAttribute('preserveAspectRatio','xMidYMid meet');app.root.removeAttribute('data-navigation-focus');app.root.removeAttribute('data-follow-edge');
  }
  function focusNavigation(){if(!app.root)return;app.zoom=1;applyCamera();}
  function setZoom(value,update=true){app.zoom=Math.max(.5,Math.min(2.8,value));if(!app.root)return;applyCamera();if(update)app.root.setAttribute('data-zoom',app.zoom.toFixed(2));}
  function setTheme(theme='base'){app.theme=['base','crowd','comfort'].includes(theme)?theme:'base';if(app.root)app.root.setAttribute('data-theme',app.theme);if(app.graph)drawLayers();}
  function mount(selector,options={}) {
    app.root=typeof selector==='string'?document.querySelector(selector):selector;app.onPoiClick=options.onPoiClick||null;app.onNavigationProgress=options.onNavigationProgress||null;
    if(!app.root)return false;
    app.root.setAttribute('viewBox',`0 0 ${WIDTH} ${HEIGHT}`);app.root.setAttribute('preserveAspectRatio','xMidYMid meet');app.root.setAttribute('data-theme',app.theme);
    let drag=null,suppressMapClick=false;
    app.root.addEventListener('click',event=>{if(!suppressMapClick)return;event.preventDefault();event.stopImmediatePropagation();suppressMapClick=false;},true);
    app.root.addEventListener('pointerdown',event=>{if(event.button!==0)return;const box=app.root.getBoundingClientRect();const vb=app.root.viewBox.baseVal;drag={id:event.pointerId,x:event.clientX,y:event.clientY,panX:app.pan.x,panY:app.pan.y,unitX:vb.width/Math.max(1,box.width),unitY:vb.height/Math.max(1,box.height),moved:false};});
    app.root.addEventListener('pointermove',event=>{if(!drag||event.pointerId!==drag.id)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(!drag.moved&&Math.hypot(dx,dy)>3){drag.moved=true;app.root.setPointerCapture(event.pointerId);}if(drag.moved){app.pan.x=drag.panX+dx*drag.unitX;app.pan.y=drag.panY+dy*drag.unitY;app.root.classList.add('is-panning');applyCamera();event.preventDefault();}});
    const finishDrag=event=>{if(!drag||event.pointerId!==drag.id)return;if(drag.moved){suppressMapClick=true;setTimeout(()=>{suppressMapClick=false;},350);}app.root.classList.remove('is-panning');drag=null;};
    app.root.addEventListener('pointerup',finishDrag);app.root.addEventListener('pointercancel',finishDrag);
    app.root.addEventListener('wheel',event=>{event.preventDefault();setZoom(app.zoom*(event.deltaY<0?1.18:1/1.18));},{passive:false});
    return true;
  }
  function update(data={}) {
    if(data.graph)app.graph=data.graph;if(data.state)app.state=data.state;if(data.forecast)app.forecast=data.forecast;if(data.crowdDistribution)app.crowdDistribution=data.crowdDistribution;if(data.roadNames)app.roadNames=data.roadNames;if(data.plan!==undefined)app.plan=data.plan;
    drawLayers();
  }
  function loadScenicGraph(graph){app.graph=graph;drawLayers();}
  function updateState(state,forecast=app.forecast){app.state=state;app.forecast=forecast;drawLayers();}
  function updateCrowdDistribution(distribution){app.crowdDistribution=distribution||null;drawLayers();}
  function setCrowdHorizon(minutes=0){const value=Number(minutes);app.crowdHorizon=[0,5,15,30,60].includes(value)?value:0;drawLayers();return app.crowdHorizon;}
  function updatePoiStatus(poiId,status){if(!app.state)return;app.state.poi_states[poiId]={...(app.state.poi_states[poiId]||{}),...status};updateState(app.state);}
  function updateRoadStatus(edgeId,status){if(!app.state)return;app.state.road_states[edgeId]={...(app.state.road_states[edgeId]||{}),...status};applyVisibility();}
  function updateVisitorPosition(visitor){if(!app.state)return;app.state.visitor={...app.state.visitor,...visitor};const position=app.state.visitor.current_node_id;const path=app.navigationRoute?.path||[],index=path.indexOf(position);if(index>=0){const {segments,total}=routeGeometry();if(total){const edgeDistance=segments.slice(0,index).reduce((sum,item)=>sum+item.distance,0);app.navigationProgress=edgeDistance/total;}}updateState(app.state);}
  function updateForecastSummary(forecast){app.forecast=forecast;updateState(app.state,forecast);}
  function updatePlan(plan){app.plan=plan;drawLayers();}
  function updateNavigation(result={}){
    const path=result.path||result.node_sequence||result.nodeSequence||[],edgeSequence=result.edgeSequence||result.edge_sequence||[];
    if(path.length>1&&edgeSequence.length!==path.length-1)throw new Error('导航路线节点和道路数量不一致');
    const edges=edgeMap();
    edgeSequence.forEach((id,index)=>{
      const edge=edges.get(id),from=path[index],to=path[index+1];
      if(!edge||!layout.edges[id]?.length||!((edge.from_node_id===from&&edge.to_node_id===to)||(edge.from_node_id===to&&edge.to_node_id===from)))throw new Error(`导航路段 ${id} 与地图1路网不一致`);
    });
    app.navigationRoute={...result,path,edgeSequence};app.navigationProgress=0;app.followNavigation=result.continuous!==true;app.pan={x:0,y:0};app.bearing=0;app.northUp=result.continuous===true;app.selectedNode=null;
    if(!app.root||!app.graph)return;drawLayers();focusNavigation();
  }
  function setNavigationProgress(progress){app.navigationProgress=Math.max(0,Math.min(1,Number(progress)||0));drawLayers();}
  function setFollowNavigation(follow=true){app.followNavigation=Boolean(follow);applyCamera();return app.followNavigation;}
  function toggleLayer(name,on){if(!(name in visible))return;visible[name]=on===undefined?!visible[name]:Boolean(on);applyVisibility();}
  function selectPoi(poiId){app.selectedPoi=poiId;const node=allNodes().find(item=>item.poi_id===poiId);if(node){const status=statePoi(poiId);if(app.onPoiClick)app.onPoiClick(node,{...status,forecast:queueForecast(poiId)});}}
  function zoomIn(){setZoom(app.zoom*1.25);}function zoomOut(){setZoom(app.zoom/1.25);}function locate(){app.zoom=1;app.pan={x:0,y:0};app.bearing=0;app.northUp=true;app.followNavigation=true;applyCamera();}
  function toggleNorthUp(){app.followNavigation=true;app.northUp=!app.northUp;app.bearing=0;applyCamera();return app.northUp;}
  function rotate(delta){app.followNavigation=true;app.bearing=((app.bearing+Number(delta))%360+360)%360;app.northUp=false;applyCamera();return app.bearing;}
  function toggleImmersive(){app.followNavigation=true;app.immersive=!app.immersive;app.northUp=false;applyCamera();const control=document.querySelector('#mapImmersiveToggle');if(control){control.setAttribute('aria-pressed',String(app.immersive));control.textContent=app.immersive?'返回平面视角':'沿途立体视角';}return app.immersive;}
  function focusNode(nodeId){if(!nodeMap().has(nodeId))return;app.previewNode=nodeId;if(!app.navigationRoute?.edgeSequence?.length){app.pan={x:0,y:0};drawLayers();}}
  function setPreviewEndpoints(from,to){app.previewNode=nodeMap().has(from)?from:null;app.previewDestination=nodeMap().has(to)?to:null;if(app.root&&!app.navigationRoute?.edgeSequence?.length)drawLayers();}
  window.CScenicMap={mount,update,loadScenicGraph,updateState,updateCrowdDistribution,setCrowdHorizon,updatePoiStatus,updateRoadStatus,updateVisitorPosition,updateForecastSummary,updatePlan,showPlan:updatePlan,replaceRoute:updatePlan,updateNavigation,setNavigationProgress,setFollowNavigation,toggleLayer,setTheme,selectPoi,emitEvent,zoomIn,zoomOut,locate,rotate,toggleNorthUp,toggleImmersive,focusNode,setPreviewEndpoints,getData:()=>({graph:app.graph,state:app.state,forecast:app.forecast,crowdDistribution:app.crowdDistribution,crowdHorizon:app.crowdHorizon,plan:app.plan,theme:app.theme,zoom:app.zoom,bearing:app.bearing,northUp:app.northUp,immersive:app.immersive,navigationProgress:app.navigationProgress,followNavigation:app.followNavigation,continuousRoute:app.navigationRoute?.continuous===true}),getNavigationPose:navigationPose,getLayout:()=>layout,getMap1EdgePoints:edgeId=>map1EdgePoints(edgeId).map(point=>[point.x,point.y])};
})();
