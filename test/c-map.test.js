'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const readJson = name => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8'));
const graph = readJson('c-demo-graph.json');
const state = readJson('c-demo-state.json');
const plan = readJson('c-demo-plan.json');

function assertValidLegs(planResult) {
  const nodes = new Set(graph.nodes.map(node => node.node_id));
  const edges = new Map(graph.edges.map(edge => [edge.edge_id, edge]));
  for (const item of planResult.itinerary || []) {
    const route = item.route;
    if (!route) continue;
    assert.equal(route.node_sequence.length, route.edge_sequence.length + 1, `${item.target_id}: route sequence lengths`);
    for (const nodeId of route.node_sequence) assert.ok(nodes.has(nodeId), `${item.target_id}: unknown node ${nodeId}`);
    route.edge_sequence.forEach((edgeId, index) => {
      const edge = edges.get(edgeId);
      assert.ok(edge, `${item.target_id}: unknown edge ${edgeId}`);
      const from = route.node_sequence[index], to = route.node_sequence[index + 1];
      assert.ok((edge.from_node_id === from && edge.to_node_id === to) || (edge.from_node_id === to && edge.to_node_id === from), `${item.target_id}: ${edgeId} does not connect ${from} to ${to}`);
    });
  }
}

test('C 2.5D demo uses A graph IDs and matching current state keys', () => {
  const nodeIds = new Set(graph.nodes.map(node => node.node_id));
  const poiIds = new Set(graph.nodes.map(node => node.poi_id).filter(Boolean));
  const edgeIds = new Set(graph.edges.map(edge => edge.edge_id));
  assert.equal(graph.nodes.length, 45, 'Map 2 retains the 45 numbered Map 1 locations');
  for (const gateId of ['gate', 'southgate', 'westgate', 'eastgate']) assert.ok(nodeIds.has(gateId), `Map 2 retains the ${gateId} park entrance`);
  assert.equal(new Set(nodeIds).size, graph.nodes.length, 'node IDs are unique');
  assert.equal(new Set(edgeIds).size, graph.edges.length, 'edge IDs are unique');
  assert.deepEqual(Object.keys(state.poi_states).sort(), [...poiIds].sort());
  assert.deepEqual(Object.keys(state.road_states).sort(), [...edgeIds].sort());
  for (const edge of graph.edges) {
    assert.ok(nodeIds.has(edge.from_node_id));
    assert.ok(nodeIds.has(edge.to_node_id));
  }
});

test('A pedestrian network reaches every scenic node from the main gate', () => {
  const scenicGraph = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'data', 'scenic_graph.json'), 'utf8'));
  const adjacency = new Map(scenicGraph.nodes.map(node => [node.node_id, []]));
  for (const edge of scenicGraph.edges) {
    adjacency.get(edge.from_node_id)?.push(edge.to_node_id);
    if (edge.direction === 'BIDIRECTIONAL') adjacency.get(edge.to_node_id)?.push(edge.from_node_id);
  }
  const reached = new Set(), pending = ['gate'];
  while (pending.length) {
    const current = pending.shift();
    if (reached.has(current)) continue;
    reached.add(current);
    pending.push(...(adjacency.get(current) || []));
  }
  assert.equal(reached.size, scenicGraph.nodes.length, `unreachable from gate: ${scenicGraph.nodes.filter(node => !reached.has(node.node_id)).map(node => node.node_id).join(', ')}`);
});

test('C renders B main and alternative routes from valid connected node/edge sequences', () => {
  assertValidLegs(plan);
  for (const alternative of plan.alternative_plans || []) assertValidLegs(alternative);
  assert.ok(plan.itinerary.length >= 2, 'main itinerary should show multiple stops');
  assert.ok(plan.alternative_plans.length >= 1, 'at least one alternative should be available');
});

test('C renderer exposes independent visual layers and consumes route sequences without an in-map pathfinder', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'c-map.js'), 'utf8');
  for (const layer of ['terrain', 'buildings', 'roads', 'service', 'heat', 'events', 'poi', 'route', 'navigation', 'visitor']) {
    assert.ok(source.includes(`'${layer}'`), `missing C layer ${layer}`);
  }
  assert.match(source, /route\.edge_sequence/);
  assert.match(source, /route\.node_sequence/);
  assert.match(source, /main_walkway/);
  assert.match(source, /node\.facility_id\|\|node\.poi_id\|\|node\.node_id\|\|id/);
  assert.doesNotMatch(source, /polygon\(building,(?:front|side|top),/, 'precomputed SVG polygon strings must not be treated as point arrays');
  assert.doesNotMatch(source, /function\s+(?:astar|dijkstra|findPath)\b/i, 'C must not calculate routes');
});

test('Map 2 edge geometry projects the SVG Map 1 source for every graph edge', () => {
  const context = {window: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'scenic-layout.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'c-map.js'), 'utf8'), context);
  const layout = context.window.ScenicMapLayout;
  for (const edge of graph.edges) {
    const source = layout.edges[edge.edge_id], projected = context.window.CScenicMap.getMap1EdgePoints(edge.edge_id);
    assert.ok(projected.length >= source.length, `${edge.edge_id}: missing projected points`);
    for (const [actual, original] of [[projected[0], source[0]], [projected.at(-1), source.at(-1)]]) {
      const [x,y] = layout.overviewPoint(original);
      assert.ok(Math.abs(actual[0]-x)<.001 && Math.abs(actual[1]-y)<.001, `${edge.edge_id}: diverges from Map 1 anchor`);
    }
    assert.ok(projected.every(point=>point.every(Number.isFinite)), `${edge.edge_id}: non-finite projected point`);
  }
});

test('both map styles share hand-map anchors and every A road polyline meets its graph endpoints', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'scenic-layout.js'), 'utf8'), context);
  const layout = context.window.ScenicMapLayout;
  assert.equal(layout.width, 2560);
  assert.equal(layout.overviewHeight, 500);
  assert.equal(layout.detailHeight, 1220);
  assert.ok(layout.width / layout.detailHeight > 1.8 && layout.width / layout.detailHeight < 2.5, 'detail map should preserve east-west ordering while providing usable vertical navigation space');
  assert.ok(Math.abs(layout.width / layout.overviewHeight - 5.12) < 0.001, 'overview map should preserve its landscape source coordinate frame');
  assert.ok(layout.overviewBaseEdges.length <= 50, 'overview should use a compact set of main streets and local connectors');
  for (const edgeId of ['edge_010','edge_034','edge_044','edge_048','edge_056','edge_057','edge_068']) {
    assert.ok(layout.overviewBaseEdges.includes(edgeId), `${edgeId} should be visible as an access connector on Map 01`);
  }
  assert.equal(layout.overviewBaseEdges.length, 49, 'the default overview should visibly connect 三打祝家庄 with 武侠广场 and 水浒街');
  const visibleAdjacency = new Map(graph.nodes.map(node => [node.node_id, []]));
  const graphEdges = new Map(graph.edges.map(edge => [edge.edge_id, edge]));
  for (const edgeId of layout.overviewBaseEdges) {
    const edge = graphEdges.get(edgeId);
    assert.ok(edge, `overview has unknown edge ${edgeId}`);
    visibleAdjacency.get(edge.from_node_id).push(edge.to_node_id);
    if (edge.direction === 'BIDIRECTIONAL') visibleAdjacency.get(edge.to_node_id).push(edge.from_node_id);
  }
  const visibleReached = new Set(), visiblePending = ['gate'];
  while (visiblePending.length) {
    const current = visiblePending.shift();
    if (visibleReached.has(current)) continue;
    visibleReached.add(current);
    visiblePending.push(...visibleAdjacency.get(current));
  }
  assert.equal(visibleReached.size, graph.nodes.length, 'every mapped attraction needs a visible route from the main gate');
  for (const edgeId of layout.overviewOptionalEdges) {
    assert.ok(graphEdges.has(edgeId), `optional overview road ${edgeId} must exist in the planner graph`);
    assert.ok(!layout.overviewBaseEdges.includes(edgeId), `optional road ${edgeId} must not duplicate the default map`);
  }
  assert.deepEqual([...layout.overviewOptionalEdges], ['edge_033'], 'optional paths crossing lake artwork should stay off Map 01');
  let curvedStreets = 0;
  for (const edgeId of layout.overviewBaseEdges) {
    const line = layout.edges[edgeId], first = line[0], last = line.at(-1);
    const maxOffset = Math.max(...line.slice(1,-1).map(point => Math.abs((last[0]-first[0])*(first[1]-point[1])-(first[0]-point[0])*(last[1]-first[1])) / Math.hypot(last[0]-first[0],last[1]-first[1])));
    if (maxOffset > 5) curvedStreets++;
  }
  assert.ok(curvedStreets >= layout.overviewBaseEdges.length * .6, 'most displayed streets should have visible bends; short access paths may be straighter');
  assert.ok(layout.referenceLandmarks.length + graph.nodes.length >= 35, 'promoted A nodes plus reference landmarks should retain hand-map detail');
  assert.equal(layout.waterBodies.length, 3, 'the three mapped water features, including the elongated eastern lake, should be drawn');
  const longLake = layout.waterBodies.at(-1);
  assert.ok(Math.max(...longLake.map(point => point[0])) - Math.min(...longLake.map(point => point[0])) > 220, '万寿湖 should render as a long water body rather than a small pond');
  const insidePolygon = ([x,y], polygon) => {
    let inside = false;
    for (let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
      const [xi,yi]=polygon[i],[xj,yj]=polygon[j];
      if (((yi>y)!==(yj>y)) && x<(xj-xi)*(y-yi)/(yj-yi)+xi) inside=!inside;
    }
    return inside;
  };
  for (const edgeId of ['edge_048','edge_049','edge_050','edge_051']) {
    const line=layout.edges[edgeId];
    for (let i=1;i<line.length;i++) for(let step=1;step<20;step++) {
      const t=step/20,point=[line[i-1][0]+(line[i][0]-line[i-1][0])*t,line[i-1][1]+(line[i][1]-line[i-1][1])*t];
      assert.ok(!layout.waterBodies.some(water=>insidePolygon(point,water)), `${edgeId} must follow the shore instead of crossing a lake`);
    }
  }
  for (const id of ['circus','tiger_hall','qianqiu_lake','wanshou_lake','retro_block','puyi_wharf','dyehouse','wulin_square','bailemen','shili_yangchang','kuaipolin','chaguan','zhu_family_fort','magic_square','shuihu_li','flower_camp','creative_market','forest_boardwalk']) {
    assert.ok(graph.nodes.some(node=>node.node_id===id), `${id} must be available to A/B as a shared scenic node`);
    assert.ok(layout.nodeNumbers[id], `${id} must have a visible shared map number`);
  }
  assert.ok(layout.secondaryPaths.length >= 15, 'secondary walking paths should be represented');
  assert.ok(layout.secondaryPaths.every(path => path.verified === false), 'illustrated reference strokes must not claim field-verified walkability');
  assert.ok(layout.facilities.some(item => item.verified === false), 'simulated facilities must be explicitly distinguishable');
  assert.equal(Object.keys(layout.nodes).length, graph.nodes.length);
  assert.equal(Object.keys(layout.nodeNumbers).length, graph.nodes.length, 'every routable landmark should have a visible map number');
  assert.equal(Object.keys(layout.edges).length, graph.edges.length);
  assert.equal(Object.keys(layout.overviewCanvasEdges || {}).length, graph.edges.length, 'Map 01 needs a curved presentation path for every A edge');
  assert.equal(Object.keys(layout.overviewCanvasRouteNodes || {}).length, graph.nodes.length, 'Map 01 needs a walkable forecourt anchor for every A node');
  assert.ok(graph.nodes.some(node => node.node_id === 'westgate' && node.name === '西大门'), 'the west entrance replaces the invented north gate');
  assert.ok(!graph.nodes.some(node => node.node_id === 'northgate' || node.name === '北大门'), 'do not publish a north gate absent from the supplied map');
  const overviewStyle = fs.readFileSync(path.join(__dirname, '..', 'public', 'scenic-overview.js'), 'utf8');
  const overviewCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'route-experience.css'), 'utf8');
  assert.match(overviewStyle, /preserveAspectRatio', 'none'/, 'overview artwork should stretch with the taller landscape viewport');
  assert.match(overviewStyle, /viewBox', `\$\{-sideMargin\} -40 \$\{layout\.width \+ sideMargin\*2\} 591`/, 'overview needs balanced north and side margins without changing shared map coordinates');
  assert.doesNotMatch(overviewStyle, /overview-south-lake/, 'do not draw water across the south edge where the source map shows land');
  assert.match(overviewCss, /\.trip-map-frame\{height:700px;min-height:700px/, 'hand-drawn map display height should be increased');
  assert.match(overviewStyle, /overview-roof-gable/, 'landmark buildings should use the front-facing illustrated timber-hall treatment');
  assert.match(overviewStyle, /overview-tiger-stripe/, '猛虎馆 needs a recognizable tiger facade rather than a generic hall');
  assert.match(overviewStyle, /overview-fortress-arena/, '城寨沙场 needs an arena and crenellated fortress silhouette instead of a generic hall');
  assert.match(overviewCss, /\.overview-fortress-yard\{/, '城寨沙场 needs a visible sand practice yard');
  assert.match(overviewStyle, /overview-bailemen-sign/, '百乐门 needs a recognizable entertainment-hall marquee');
  assert.match(overviewStyle, /const visualOffsets = \{/, 'overview buildings need presentation offsets separate from route arrival nodes');
  assert.doesNotMatch(overviewStyle, /overview-poi-approach/, 'detached leader strokes must not look like stray road fragments');
  assert.match(overviewStyle, /top<=footprint\.bottom\+40/, 'fallback labels must stay close to the landmark they identify');
  assert.match(overviewStyle, /besideBuilding\?34:76/, 'labels may move beside or above a landmark only after preferring a position below it');
  assert.match(overviewStyle, /const labelWidth = \(name, numbered = false\)/, 'map labels must reserve enough width for the rendered Chinese font and number badge');
  assert.match(overviewCss, /\.overview-label\{font-size:12px\}/, 'map label font and computed card widths must use the verified readable size');
  assert.match(overviewStyle, /const captionGaps=\[0,2,4,6,8,10,12,16,20\]/, 'labels should try close rows below artwork before falling back above or beside it');
  assert.match(overviewStyle, /!part\.classList\.contains\('overview-building-shadow'\)/, 'caption spacing must use the painted building instead of its cast shadow');
  assert.match(overviewStyle, /edgeGap \* 2\.4/, 'label placement should prioritize proximity to its own landmark');
  assert.match(overviewStyle, /layout\.referenceLandmarks \|\| \[\]\)\.forEach/, 'legible hand-map orientation landmarks should remain visible');
  assert.match(overviewStyle, /findOpenLabelPosition\(spec\.node/, 'dense clusters should search for a clear full-name label position');
  assert.ok(overviewStyle.indexOf('root.append(landmarks)') < overviewStyle.indexOf('root.append(districtTitles)'), 'district labels must sit above roads and buildings');
  for (const id of ['water_margin_entrance','xianxia_entrance','jianghu_stage_entrance']) assert.ok(layout.referenceLandmarks.some(item=>item.id===id), `missing labeled area entrance ${id}`);
  const artsEntrance=layout.referenceLandmarks.find(item=>item.id==='jianghu_stage_entrance');
  assert.ok(artsEntrance.x>2400 && artsEntrance.y>300, '江湖艺术区演艺场入口 should sit at the district lower-right edge');
  for (const point of Object.values(layout.nodes)) assert.ok(point[1] >= 40 && point[1] <= 420, 'shared graph anchors must fit the source map and its southern entrance band');
  for (const node of graph.nodes) assert.ok(layout.nodes[node.node_id], `missing hand-map position for ${node.node_id}`);
  for (const edge of graph.edges) {
    const line = layout.edges[edge.edge_id];
    assert.ok(line?.length >= 2, `missing detailed path for ${edge.edge_id}`);
    assert.deepEqual(line[0], layout.nodes[edge.from_node_id], `${edge.edge_id}: starts at A from_node`);
    assert.deepEqual(line.at(-1), layout.nodes[edge.to_node_id], `${edge.edge_id}: ends at A to_node`);
    const curved = layout.overviewCanvasEdges[edge.edge_id];
    assert.deepEqual(curved[0], layout.overviewCanvasRouteNodes[edge.from_node_id], `${edge.edge_id}: Map 01 path starts at its forecourt`);
    assert.deepEqual(curved.at(-1), layout.overviewCanvasRouteNodes[edge.to_node_id], `${edge.edge_id}: Map 01 path ends at its forecourt`);
  }
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /tripEdgePoints\(edgeId, ids\[index\], ids\[index \+ 1\]\)/);
  assert.match(app, /function validateTripLeg\(item\)/, 'a planner leg must pass graph sequence and map geometry checks before it is drawn');
  assert.match(app, /节点与道路段数量不匹配/);
  assert.match(app, /路线终点与计划景点不一致/);
  assert.match(app, /道路 .* 的地图线条没有接到对应节点/);
  assert.match(app, /if \(!legValidation\[legIndex\]\?\.valid\) \{\s*leg\.classList\.add\('is-invalid'\)/);
  assert.match(app, /const totalLength = drawnEdges\.reduce/, 'direction cue placement must use the whole itinerary leg, not only its last road edge');
  assert.match(app, /data-edge-id': arrowEdge\.edgeId, 'data-leg-index': legIndex/, 'each leg direction cue must identify its actual planner edge and itinerary leg');
  assert.match(app, /class: 'trip-leg-arrow', 'data-edge-id': arrowEdge\.edgeId, 'data-leg-index': legIndex/, 'each route leg should use a small edge-linked direction arrow');
  assert.doesNotMatch(app, /trip-leg-order-badge|cueLabel|numberedStop/, 'the route line should not add text number badges');
  assert.match(app, /const displayStops = itinerary\.flatMap/, 'map numbers must come from planned actions in itinerary order');
  assert.match(app, /'data-stop-index': index \+ 1/, 'map markers must expose the same order as the stop cards');
  assert.match(app, /routeLegs\.forEach\(\(leg, index\)/, 'selected segment must follow the original ordered itinerary');
  assert.match(app, /leg\.classList\.toggle\('is-active', index === legIndex\)/, 'the chosen leg should be emphasized without hiding later red segments');
  assert.match(app, /pathNodes\.slice\(1, -1\)\.map\(routeNodeName\)/, 'each stop card must explain its actual graph path');
  assert.doesNotMatch(app, /pointToRoutePolyline/, 'nearby artwork must not become a numbered stop');
  assert.match(app, /overviewCanvasEdges/);
  assert.match(app, /overviewRoutePointForNode/);
  assert.match(app, /ScenicMapLayout/);
  assert.match(app, /Math\.hypot\(x - state\.startX, y - state\.startY\) < 4/, 'map pan should start only after an intentional drag');
  assert.match(app, /window\.addEventListener\('pointermove'/, 'map should keep dragging when the pointer leaves its viewport');
  assert.match(app, /state\.suppressClick = true/, 'dragging must not trigger the next POI click');
  assert.match(app, /const worldX = \(focusX - state\.x\) \/ oldScale/, 'wheel zoom should remain anchored under the pointer');
  assert.match(app, /mapSurface\.append\(mapGraphic, overlay\)/, 'artwork and route overlay should pan and zoom together');
  assert.match(app, /mapSurface\.offsetWidth/, 'pan bounds must use measurable HTML dimensions rather than SVG offsetWidth');
  assert.match(app, /tools\.append\(controls\)/, 'map controls should sit outside the clipped artwork');
  assert.match(overviewCss, /\.trip-map-tools \.trip-map-controls\{[^}]*flex-direction:column/, 'map controls should stack vertically in the side rail');
  assert.match(app, /-55 -40 \$\{overviewWidth \+ 110\} 591/, 'route overlay must share the map art viewBox');
  const overview = fs.readFileSync(path.join(__dirname, '..', 'public', 'scenic-overview.js'), 'utf8');
  assert.match(overview, /layout\.overviewPoint/);
  assert.match(overview, /data-overview-edge/);
  assert.match(overview, /overviewBaseEdges/);
  assert.doesNotMatch(overview, /overview-minor-roads/, 'the overview no longer draws a redundant optional road layer');
  assert.doesNotMatch(app, /data-overview-action="toggle-reference"/, 'the overview no longer offers a redundant small-road toggle');
  assert.match(overview, /chooseNodeLabel/);
  assert.match(overview, /data-overview-node-label/);
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'public', 'c-map.js'), 'utf8');
  assert.match(renderer, /\['qianqiu_lake','wanshou_lake'\]\.includes/, 'water POIs must not receive fictional buildings');
  assert.match(renderer, /layout\.edges\[edgeId\]/);
  assert.match(renderer, /return map1Point\(source\)/, 'Map 2 nodes must project the same source anchors used by the SVG overview');
  assert.match(renderer, /crowdHeat\.prepend\(crowdDefs\);scene\.append\(terrain,crowdHeat,tracedPaths,roads\)/, 'crowd heat should remain below roads and the building occlusion layer');
  assert.match(renderer, /if\(!app\.navigationRoute\?\.edgeSequence\?\.length\)drawRoute\(scene\)/, 'a separate recommended itinerary must not overlap active point-to-point navigation');
  assert.match(renderer, /drawNavigation\(scene\);scene\.append\(buildings,pois,visitor\)/, 'navigation should pass behind buildings while POIs and the current position stay legible');
  assert.match(renderer, /const source=layout\.edges\[edgeId\]/, 'Map 2 should use the same road geometry as the SVG Map 1 overview');
  assert.match(renderer, /layout\.overviewPoint \? layout\.overviewPoint\(point\)/, 'Map 2 must project Map 1 artwork coordinates');
  assert.match(renderer, /app\.root\.append\(scene\)/, 'the shared scene should be mounted as one camera-controlled SVG group');
  assert.match(renderer, /scene\.setAttribute\('transform'/, 'navigation should follow the current interpolated route position with a 2.5D camera');
  assert.match(renderer, /function navigationPose\(/, 'navigation position and heading should derive from the returned edge sequence');
  assert.match(renderer, /interpolateLine\(segment\.points,Math\.min\(1,local\+\.04\)\)/, 'the follow camera heading must use the road tangent at the current position, including before a sharp first bend');
  assert.match(renderer, /function toggleImmersive\(/, 'the map should expose an explicit immersive follow view');
  assert.match(renderer, /function rotate\(delta\)/, 'the camera can be rotated in controlled 15-degree steps');
  assert.match(renderer, /app\.bearing=0;app\.northUp=true;app\.followNavigation=true;applyCamera\(\)/, 'the recenter control restores Map 1 north-up orientation');
  assert.match(renderer, /class:'m2-road-label'/, 'active navigation segments display their scenic road names');
  assert.match(renderer, /app\.immersive\?3\.45:CAMERA_VIEW\.scale/, 'immersive guidance should zoom and pitch into the route ahead');
  assert.match(renderer, /if\(cameraPose&&id===app\.navigationRoute\?\.path\?\.\[0\]\)continue/, 'the moving visitor marker should replace the static origin marker');
  assert.match(renderer, /delta>0\?'前方右转':'前方左转'/, 'turn prompts should account for the SVG map coordinate system where positive angles turn right');
  assert.match(renderer, /ScenicOverviewMap\?\.draw\?\.\(source,graph\)/, 'Map 2 must render from the canonical Map 1 artwork');
  assert.match(renderer, /cloneLayer\('\.overview-roads'\)/, 'Map 2 must reuse Map 1 roads rather than redraw another network');
  assert.match(renderer, /cloneLayer\('\.overview-landmarks'\)/, 'Map 2 must reuse Map 1 landmark positions and types');
  assert.match(renderer, /class:`m2-building m2-source-landmark \$\{app\.selectedNode===id\?'is-selected':''\}`/, 'source landmark illustrations should receive the navigation camera treatment and retain selection state');
  assert.match(renderer, /const landmarkScale=Math\.max\(\.68,Math\.min\(\.98,54\/artworkSize\)\)/, 'small Map 1 landmarks should gain legibility without allowing large artwork to dominate navigation');
  assert.match(renderer, /wrapper\.addEventListener\('pointerup',event=>\{if\(event\.button!==0\)return;pointerActivation=true;selectLandmark\(event\)/, 'a physical pointer release on each Map 1 landmark should open its matching POI card');
  assert.match(renderer, /wrapper\.addEventListener\('click',event=>\{if\(pointerActivation\)/, 'keyboard and click activation should not double trigger the pointer handler');
  assert.match(renderer, /class:'m2-building-hitarea'/, 'each building should have an adequate transparent hit area');
  assert.match(renderer, /'aria-label':node\?`\$\{node\.name\}，点击查看景点并可设为导航起点或终点`/, 'landmark selection should be keyboard accessible and clearly labeled');
  assert.match(renderer, /const activeEdgeIds=new Set\(app\.navigationRoute\?\.edgeSequence\|\|\[\]\)/, 'the active route should expose only its canonical Map 1 road edges');
  assert.match(renderer, /includes\(edge\.edge_id\)\|\|!activeEdgeIds\.has\(edge\.edge_id\)/, 'only active planner links absent from Map 1 should be revealed');
  assert.match(renderer, /northUp: false/, 'the default navigation camera should face the direction of travel');
  assert.match(renderer, /keepLandmarksUpright\(rotation,depth,scale=1\)/, 'buildings and POIs should stay upright while the follow camera turns and retain readable screen sizing');
  assert.match(renderer, /else if\(item\.classList\.contains\('m2-current'\)\)item\.setAttribute\('transform',`translate\(\$\{x\} \$\{y\}\) rotate\(\$\{-rotation\}\) scale\(1 \$\{1\/depth\}\) scale\(\$\{1\.35\/scale\}\)`/, 'the moving position pin stays anchored at its interpolated route location and keeps its screen size during camera rotation');
  assert.match(renderer, /const anchorY=app\.immersive\?760:/, 'the active location remains clear of the bottom navigation sheet while leaving forward map visible');
  assert.match(renderer, /1\.12-forward\*\.00016/, 'the forward navigation view adds restrained near/far scale to the shared Map 1 building anchors');
  assert.match(renderer, /app\.navigationRoute=\{\.\.\.result,path,edgeSequence\};app\.navigationProgress=0;app\.followNavigation=result\.continuous!==true;app\.pan=\{x:0,y:0\};app\.bearing=0;app\.northUp=result\.continuous===true;app\.selectedNode=null;/, 'starting navigation clears an unrelated selected scenic spot, faces north for the full route, and follows regular point-to-point routes');
  assert.match(renderer, /app\.scene\.removeAttribute\('transform'\);keepLandmarksUpright\(0,1,1\)/, 'returning to whole-route overview resets buildings and labels after route-follow camera rotation');
  assert.match(renderer, /setPointerCapture\(event\.pointerId\)/, 'the map canvas should support pointer drag panning');
  const camera = renderer.match(/CAMERA_VIEW = \{[^}]*scale: ([\d.]+), depth: ([\d.]+) \}/);
  assert.ok(camera && Number(camera[1]) >= 2 && Number(camera[2]) > 0 && Number(camera[2]) < 1, 'following mode should focus an oblique street scene around the traveler');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'c-map.css'), 'utf8');
  assert.match(css, /\.c-route-line\{[^}]*stroke-dasharray:/, 'recommended route should remain a distinct slim dashed layer');
});

test('both map styles are embedded in the main platform and use live A/B context', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const navigationCss = fs.readFileSync(path.join(publicDir, 'map2-navigation.css'), 'utf8');
  assert.match(app, /const poiDetail=\$\('#cPoiDetail'\);if\(poiDetail\)poiDetail\.hidden=true;/, 'starting a route hides the stale POI card');
  assert.match(navigationCss, /#cMapSurface \.overview-landmarks\{opacity:1\}/, 'navigation buildings should retain their Map 1 placement while gaining full facade contrast');
  assert.match(navigationCss, /#cMapSurface \.overview-road-casing\.is-main\{stroke:#958d7c;stroke-width:9\.2\}/, 'navigation uses a distinct, readable pedestrian-road hierarchy');

  for (const script of ['/scenic-layout.js', '/scenic-overview.js', '/c-map.js']) {
    assert.match(html, new RegExp(`<script src=["']${script.replace('/', '\\/')}(?:\\?[^"']*)?["']`));
  }
  for (const id of ['tripMap', 'tripMapOverlay', 'guidedDetail', 'navMap']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(app, /id="mapImmersiveToggle" class="map-immersive-toggle"/, 'Map 2 should offer the separate along-route immersive navigation view');
  for (const integrationHook of ['mountCMap', 'startGuidedTrip', 'loadScenicContext']) {
    assert.match(app, new RegExp(`function ${integrationHook}\\b`));
  }
  assert.doesNotMatch(app, /loadCExample|\/c-demo-/);
});

test('Map 2 renders the synthetic crowd horizon and an explicitly estimated comfort layer', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const renderer = fs.readFileSync(path.join(publicDir, 'c-map.js'), 'utf8');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(renderer, /function crowdForPoi\(/);
  assert.match(renderer, /function setCrowdHorizon\(/);
  assert.match(renderer, /m2-crowd-glow/);
  assert.match(renderer, /m2-crowd-contour/);
  assert.match(renderer, /m2-data-label-backdrop crowd/);
  assert.match(renderer, /m2-data-label-backdrop comfort/);
  assert.match(renderer, /m2-comfort-\$\{comfortClass\(comfort\)\}/);
  assert.match(renderer, /updateCrowdDistribution/);
  assert.match(app, /景区人流动态/);
  assert.match(app, /非现场实时/);
  assert.match(app, /遮阴与模拟拥挤度估算/);
  assert.match(app, /crowdDistribution: crowd/);
  assert.match(app, /requestNav\(\{ mode: 'recommended' \}\)/);
  assert.match(app, /自由点到点导航 · 当前路网内最短可行路线/);
  assert.match(html, /map2-crowd\.css/);
});

test('Map 1 recommendation enters Map 2 as one continuous route before per-stop guidance', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'public', 'c-map.js'), 'utf8');
  assert.match(app, /function composeRecommendedNavigation\(/);
  assert.match(app, /连续路线经过 \$\{route\.stopCount\} 个推荐景点/);
  assert.match(app, /go\('navigation', \{ skipNavigationLoad: true \}\)/);
  assert.match(renderer, /route\.continuous===true/);
  assert.match(renderer, /recommendationStopIds=new Set\(app\.navigationRoute\?\.stopNodes\|\|\[\]\)/);
  const styles=fs.readFileSync(path.join(__dirname, '..', 'public', 'map2-navigation.css'), 'utf8');
  assert.match(styles, /data-navigation-focus="route-overview".*is-recommendation-stop/s, 'the whole-route overview should label planned stops without piling up unrelated POI names');
  assert.match(renderer, /function setFollowNavigation\(follow=true\)/);
});
