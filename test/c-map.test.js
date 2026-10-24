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
  assert.equal(new Set(nodeIds).size, graph.nodes.length, 'node IDs are unique');
  assert.equal(new Set(edgeIds).size, graph.edges.length, 'edge IDs are unique');
  assert.deepEqual(Object.keys(state.poi_states).sort(), [...poiIds].sort());
  assert.deepEqual(Object.keys(state.road_states).sort(), [...edgeIds].sort());
  for (const edge of graph.edges) {
    assert.ok(nodeIds.has(edge.from_node_id));
    assert.ok(nodeIds.has(edge.to_node_id));
  }
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

test('both map styles share hand-map anchors and every A road polyline meets its graph endpoints', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'scenic-layout.js'), 'utf8'), context);
  const layout = context.window.ScenicMapLayout;
  assert.equal(layout.width, 2560);
  assert.equal(layout.overviewHeight, 500);
  assert.equal(layout.detailHeight, 1220);
  assert.ok(layout.width / layout.detailHeight > 1.8 && layout.width / layout.detailHeight < 2.5, 'detail map should preserve east-west ordering while providing usable vertical navigation space');
  assert.ok(Math.abs(layout.width / layout.overviewHeight - 5.12) < 0.001, 'overview map should preserve its landscape source coordinate frame');
  assert.ok(layout.overviewBaseEdges.length <= 32, 'overview should keep a readable selection of main streets and local connectors');
  let curvedStreets = 0;
  for (const edgeId of layout.overviewBaseEdges) {
    const line = layout.edges[edgeId], first = line[0], last = line.at(-1);
    const maxOffset = Math.max(...line.slice(1,-1).map(point => Math.abs((last[0]-first[0])*(first[1]-point[1])-(first[0]-point[0])*(last[1]-first[1])) / Math.hypot(last[0]-first[0],last[1]-first[1])));
    if (maxOffset > 5) curvedStreets++;
  }
  assert.ok(curvedStreets >= layout.overviewBaseEdges.length * .7, 'most displayed streets should have visible bends; short local links may be straighter');
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
  assert.match(overviewStyle, /viewBox', `0 -40 \$\{layout\.width\} 591`/, 'overview needs a balanced north margin and taller landscape viewport without changing shared map coordinates');
  assert.doesNotMatch(overviewStyle, /overview-south-lake/, 'do not draw water across the south edge where the source map shows land');
  assert.match(overviewCss, /\.trip-map-frame\{height:700px;min-height:700px/, 'hand-drawn map display height should be increased');
  assert.match(overviewStyle, /overview-roof-gable/, 'landmark buildings should use the front-facing illustrated timber-hall treatment');
  assert.match(overviewStyle, /layout\.referenceLandmarks \|\| \[\]\)\.forEach/, 'legible hand-map orientation landmarks should remain visible');
  assert.match(overviewStyle, /findOpenLabelPosition\(spec\.node/, 'dense clusters should search for a clear full-name label position');
  assert.ok(overviewStyle.indexOf('root.append(landmarks)') < overviewStyle.indexOf('root.append(districtTitles)'), 'district labels must sit above roads and buildings');
  for (const id of ['water_margin_entrance','xianxia_entrance','jianghu_stage_entrance']) assert.ok(layout.referenceLandmarks.some(item=>item.id===id), `missing labeled area entrance ${id}`);
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
  assert.match(app, /tripEdgePath\(edgeId, ids\[index\], ids\[index \+ 1\]\)/);
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
  assert.match(app, /0 -40 \$\{overviewWidth\} 591/, 'route overlay must share the map art viewBox');
  const overview = fs.readFileSync(path.join(__dirname, '..', 'public', 'scenic-overview.js'), 'utf8');
  assert.match(overview, /layout\.overviewPoint/);
  assert.match(overview, /data-overview-edge/);
  assert.match(overview, /overviewBaseEdges/);
  assert.match(overview, /layout\.secondaryPaths/, 'verified source paths should add restrained detail beneath labels and route overlays');
  assert.match(overview, /chooseNodeLabel/);
  assert.match(overview, /data-overview-node-label/);
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'public', 'c-map.js'), 'utf8');
  assert.match(renderer, /\['qianqiu_lake','wanshou_lake'\]\.includes/, 'water POIs must not receive fictional buildings');
  assert.match(renderer, /layout\.edges\[edge\.edge_id\]/);
  assert.match(renderer, /layout\.detailPoint\(source\)/);
  assert.match(renderer, /drawTerrain\(app\.root\);drawRoads\(app\.root\);drawRoute\(app\.root\);drawNavigation\(app\.root\);drawBuildings\(app\.root\);drawPoiAndState\(app\.root\);drawVisitor\(app\.root\)/, 'roads and routes must render below buildings and POI labels');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'c-map.css'), 'utf8');
  assert.match(css, /\.c-route-line\{[^}]*stroke-dasharray:/, 'recommended route should remain a distinct slim dashed layer');
});

test('both map styles are embedded in the main platform and use live A/B context', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

  for (const script of ['/scenic-layout.js', '/scenic-overview.js', '/c-map.js']) {
    assert.match(html, new RegExp(`<script src=["']${script.replace('/', '\\/')}(?:\\?[^"']*)?["']`));
  }
  for (const id of ['tripMap', 'tripMapOverlay', 'guidedDetail', 'navMap']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  for (const integrationHook of ['mountCMap', 'startGuidedTrip', 'loadScenicContext']) {
    assert.match(app, new RegExp(`function ${integrationHook}\\b`));
  }
  assert.doesNotMatch(app, /loadCExample|\/c-demo-/);
});
