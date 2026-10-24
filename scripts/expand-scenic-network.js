'use strict';

// Idempotent data migration for the first integrated A/B/C scenic network.
// Verified scenic names/relative positions come from the supplied official-style
// hand map; exact metric geometry remains demonstrative until surveyed GIS data
// is available. Decorative buildings stay in C and are not added here.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const graphPath = path.join(root, 'server/data/scenic_graph.json');
const statePath = path.join(root, 'server/data/current_state.json');
const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

// The supplied current park guide identifies this western entrance as 西大门;
// the previous integration invented 北大门 at the same point. Migrate the ID
// and all graph references so A, B, and C cannot keep presenting the false gate.
for (const node of graph.nodes) {
  if (node.node_id !== 'northgate') continue;
  node.node_id = 'westgate'; node.id = 'westgate'; node.name = '西大门';
  node.algorithm_x = 9.38; node.algorithm_y = 14.4;
  node.tags = ['入口', '检票', '服务'];
}
for (const edge of graph.edges) {
  if (edge.from_node_id === 'northgate') edge.from_node_id = 'westgate';
  if (edge.to_node_id === 'northgate') edge.to_node_id = 'westgate';
}

const additions = [
  { node_id:'westgate', id:'westgate', name:'西大门', type:'gate', area_id:'wuxia_film', access_roles:['PARK_ENTRANCE','PARK_EXIT'], algorithm_x:9.38, algorithm_y:14.4, capacity:999, shade:.68, tags:['入口','检票','服务'], location_source:'hand_map_reference' },
  { node_id:'eastgate', id:'eastgate', name:'东大门', type:'gate', area_id:'jianghu_art', access_roles:['PARK_ENTRANCE','PARK_EXIT'], algorithm_x:97, algorithm_y:33, capacity:999, shade:.42, tags:['入口','游客中心','服务'], location_source:'hand_map_reference' },
  { node_id:'fortress', id:'fortress', poi_id:'fortress', name:'城寨沙场', type:'show', area_id:'wuxia_film', algorithm_x:8, algorithm_y:37, capacity:420, shade:.28, tags:['演艺','实景剧','水浒'], location_source:'hand_map_reference' },
  { node_id:'hero_square', id:'hero_square', poi_id:'hero_square', name:'好汉广场', type:'culture', area_id:'wuxia_film', algorithm_x:9, algorithm_y:26, capacity:260, shade:.46, tags:['广场','互动','武侠'], location_source:'hand_map_reference' },
  { node_id:'feiyunpu', id:'feiyunpu', poi_id:'feiyunpu', name:'飞云浦', type:'show', area_id:'shili_foreign', algorithm_x:27, algorithm_y:39, capacity:180, shade:.55, tags:['演艺','武侠','互动'], location_source:'hand_map_reference' },
  { node_id:'shenboat', id:'shenboat', poi_id:'shenboat', name:'神舟传奇', type:'show', area_id:'shili_foreign', algorithm_x:30, algorithm_y:20, capacity:240, shade:.82, tags:['演艺','室内','科技'], location_source:'hand_map_reference' },
  { node_id:'wangpo_island', id:'wangpo_island', poi_id:'wangpo_island', name:'王婆岛', type:'show', area_id:'water_margin', algorithm_x:37, algorithm_y:42, capacity:220, shade:.34, tags:['演艺','互动','水浒'], location_source:'hand_map_reference' },
  { node_id:'water_street', id:'water_street', poi_id:'water_street', name:'水浒街', type:'culture', area_id:'water_margin', algorithm_x:43, algorithm_y:35, capacity:360, shade:.58, tags:['街区','美食','水浒'], location_source:'hand_map_reference' },
  { node_id:'wanfo_tower', id:'wanfo_tower', poi_id:'wanfo_tower', name:'万佛塔', type:'culture', area_id:'pastoral', algorithm_x:54, algorithm_y:12, capacity:100, shade:.76, tags:['古建','文化','祈福'], location_source:'hand_map_reference' },
  { node_id:'xianxia_square', id:'xianxia_square', poi_id:'xianxia_square', name:'仙侠广场', type:'culture', area_id:'xianxia', access_roles:['AREA_ENTRANCE'], algorithm_x:66, algorithm_y:25, capacity:300, shade:.36, tags:['广场','仙侠','拍照'], location_source:'hand_map_reference' },
  { node_id:'xianxia_stage', id:'xianxia_stage', poi_id:'xianxia_stage', name:'仙侠奇境舞台', type:'show', area_id:'xianxia', algorithm_x:69, algorithm_y:33, capacity:280, shade:.61, tags:['演艺','仙侠','夜游'], location_source:'hand_map_reference' },
  { node_id:'film_studio', id:'film_studio', poi_id:'film_studio', name:'武侠影视城', type:'culture', area_id:'xianxia', algorithm_x:77, algorithm_y:34, capacity:260, shade:.67, tags:['影视','街区','拍照'], location_source:'hand_map_reference' },
  { node_id:'art_square', id:'art_square', poi_id:'art_square', name:'江湖艺术广场', type:'culture', area_id:'jianghu_art', access_roles:['AREA_ENTRANCE'], algorithm_x:85, algorithm_y:41, capacity:340, shade:.3, tags:['艺术','市集','演艺'], location_source:'hand_map_reference' },
  { node_id:'children_park', id:'children_park', poi_id:'children_park', name:'儿童游乐场', type:'scenery', area_id:'jianghu_art', algorithm_x:91, algorithm_y:38, capacity:240, shade:.5, tags:['亲子','游乐','休闲'], location_source:'hand_map_reference' },
  { node_id:'circus', id:'circus', poi_id:'circus', name:'国际大马戏', type:'show', area_id:'wuxia_film', algorithm_x:1.68, algorithm_y:18.4, capacity:520, shade:.24, tags:['演艺','马戏','亲子'], location_source:'hand_map_reference' },
  { node_id:'tiger_hall', id:'tiger_hall', poi_id:'tiger_hall', name:'猛虎馆', type:'scenery', area_id:'wuxia_film', algorithm_x:4.06, algorithm_y:23.2, capacity:220, shade:.4, tags:['展馆','动物','亲子'], location_source:'hand_map_reference' },
  { node_id:'qianqiu_lake', id:'qianqiu_lake', poi_id:'qianqiu_lake', name:'千秋湖', type:'scenery', area_id:'water_margin', algorithm_x:14.06, algorithm_y:45, capacity:160, shade:.18, tags:['水景','休憩','拍照'], location_source:'hand_map_reference' },
  { node_id:'wanshou_lake', id:'wanshou_lake', poi_id:'wanshou_lake', name:'万寿湖', type:'scenery', area_id:'xianxia', algorithm_x:56.05, algorithm_y:30.8, capacity:180, shade:.22, tags:['水景','休憩','拍照'], location_source:'hand_map_reference' },
  { node_id:'retro_block', id:'retro_block', poi_id:'retro_block', name:'70–80街区', type:'culture', area_id:'jianghu_art', algorithm_x:75, algorithm_y:23.2, capacity:300, shade:.46, tags:['街区','怀旧','拍照'], location_source:'hand_map_reference' },
  { node_id:'puyi_wharf', id:'puyi_wharf', poi_id:'puyi_wharf', name:'普济码头', type:'culture', area_id:'jianghu_art', algorithm_x:80.08, algorithm_y:20.6, capacity:240, shade:.31, tags:['码头','街区','拍照'], location_source:'hand_map_reference' },
  { node_id:'dyehouse', id:'dyehouse', poi_id:'dyehouse', name:'染坊', type:'culture', area_id:'water_margin', algorithm_x:35.23, algorithm_y:36.8, capacity:180, shade:.5, tags:['文化','手作','拍照'], location_source:'hand_map_reference' },
  { node_id:'wulin_square', id:'wulin_square', poi_id:'wulin_square', name:'武林广场', type:'culture', area_id:'water_margin', algorithm_x:47.58, algorithm_y:26.4, capacity:320, shade:.35, tags:['广场','演艺','集散'], location_source:'hand_map_reference' },
  { node_id:'bailemen', id:'bailemen', poi_id:'bailemen', name:'百乐门', type:'culture', area_id:'wuxia_film', capacity:180, shade:.6, tags:['街区','建筑','拍照'], location_source:'hand_map_reference' },
  { node_id:'shili_yangchang', id:'shili_yangchang', poi_id:'shili_yangchang', name:'十里洋场', type:'culture', area_id:'shili_foreign', capacity:300, shade:.48, tags:['街区','建筑','拍照'], location_source:'hand_map_reference' },
  { node_id:'kuaipolin', id:'kuaipolin', poi_id:'kuaipolin', name:'快活林', type:'culture', area_id:'water_margin', capacity:180, shade:.72, tags:['水浒','林地','休憩'], location_source:'hand_map_reference' },
  { node_id:'chaguan', id:'chaguan', poi_id:'chaguan', name:'茶馆', type:'service', area_id:'water_margin', capacity:120, shade:.74, tags:['茶饮','休憩','街区'], location_source:'hand_map_reference' },
  { node_id:'zhu_family_fort', id:'zhu_family_fort', poi_id:'zhu_family_fort', name:'三打祝家庄', type:'show', area_id:'water_margin', capacity:460, shade:.28, tags:['演艺','实景剧','水浒'], location_source:'hand_map_reference' },
  { node_id:'magic_square', id:'magic_square', poi_id:'magic_square', name:'魔力广场', type:'culture', area_id:'xianxia', capacity:260, shade:.36, tags:['广场','互动','仙侠'], location_source:'hand_map_reference' },
  { node_id:'shuihu_li', id:'shuihu_li', poi_id:'shuihu_li', name:'水浒里', type:'culture', area_id:'water_margin', capacity:220, shade:.52, tags:['街区','水浒','文化'], location_source:'hand_map_reference' },
  { node_id:'flower_camp', id:'flower_camp', poi_id:'flower_camp', name:'空中花海营地', type:'scenery', area_id:'jianghu_art', capacity:140, shade:.28, tags:['花海','休憩','拍照'], location_source:'hand_map_reference' },
  { node_id:'creative_market', id:'creative_market', poi_id:'creative_market', name:'文创集市', type:'culture', area_id:'jianghu_art', capacity:240, shade:.42, tags:['文创','市集','购物'], location_source:'hand_map_reference' },
  { node_id:'forest_boardwalk', id:'forest_boardwalk', poi_id:'forest_boardwalk', name:'林下栈道', type:'scenery', area_id:'jianghu_art', capacity:110, shade:.74, tags:['林地','步道','休憩'], location_source:'hand_map_reference' }
];

const areas = {
  gate:'water_margin', southgate:'wuxia_film', museum:'wuxia_film', lake:'pastoral',
  longtan:'shili_foreign', market:'water_margin', forest:'pastoral', theater:'water_margin',
  shizipo:'xianxia', summit:'jianghu_art', rest:'xianxia', temple:'pastoral', juxianzhuang:'xianxia'
};

// One shared spatial frame for A state, B proximity scoring and both C maps.
// Values are normalized from the 2560 x 500 hand-map reference used by
// public/scenic-layout.js. They express relative topology, not surveyed GPS.
const handMapPositions = {
  gate:[838,58], southgate:[350,365], temple:[1425,102], lake:[520,205],
  market:[1040,225], museum:[430,143], longtan:[790,180], forest:[1155,286],
  theater:[1265,178], shizipo:[1580,198], summit:[2380,306], rest:[1340,292],
  juxianzhuang:[1815,226], westgate:[240,65], eastgate:[2490,164],
  fortress:[205,183], hero_square:[240,128], feiyunpu:[689,197], shenboat:[760,102],
  wangpo_island:[947,210], water_street:[1100,174], wanfo_tower:[1395,59],
  xianxia_square:[1690,126], xianxia_stage:[1772,165], film_studio:[1965,169],
  art_square:[2180,206], children_park:[2320,190],
  circus:[43,92], tiger_hall:[104,116], qianqiu_lake:[365,250],
  wanshou_lake:[1435,154], retro_block:[1920,116], puyi_wharf:[2050,103],
  dyehouse:[902,184], wulin_square:[1218,132],
  bailemen:[282,83], shili_yangchang:[486,90], kuaipolin:[887,151],
  chaguan:[980,157], zhu_family_fort:[1204,102], magic_square:[1515,102],
  shuihu_li:[796,69], flower_camp:[2136,270], creative_market:[2290,225], forest_boardwalk:[2350,265]
};
for (const node of graph.nodes) {
  node.area_id ||= areas[node.node_id];
  node.location_source ||= 'hand_map_reference';
  if (node.node_id === 'gate') node.name = '中门';
}
const nodeIds = new Set(graph.nodes.map(node => node.node_id));
for (const node of additions) if (!nodeIds.has(node.node_id)) graph.nodes.push(node);
for (const node of graph.nodes) {
  const source = handMapPositions[node.node_id];
  if (!source) throw new Error(`Missing shared hand-map position: ${node.node_id}`);
  node.algorithm_x = Math.round(source[0] / 25.6 * 100) / 100;
  node.algorithm_y = Math.round(source[1] / 5 * 100) / 100;
}

const newEdges = [
  ['edge_021','westgate','fortress',260,4,.52,'main_walkway'],
  ['edge_022','fortress','museum',310,5,.42,'main_walkway'],
  ['edge_023','fortress','lake',290,4,.55,'footpath'],
  ['edge_024','hero_square','museum',190,3,.48,'footpath'],
  ['edge_025','hero_square','fortress',170,3,.38,'footpath'],
  ['edge_026','gate','feiyunpu',240,4,.62,'main_walkway'],
  ['edge_027','feiyunpu','longtan',180,3,.58,'footpath'],
  ['edge_028','feiyunpu','shenboat',210,3,.72,'footpath'],
  ['edge_029','shenboat','gate',230,4,.7,'main_walkway'],
  ['edge_030','longtan','wangpo_island',180,3,.43,'footpath'],
  ['edge_031','wangpo_island','market',210,3,.5,'main_walkway'],
  ['edge_032','market','water_street',190,3,.56,'main_walkway'],
  ['edge_033','water_street','theater',250,4,.68,'main_walkway'],
  ['edge_034','theater','wanfo_tower',240,4,.74,'footpath'],
  ['edge_035','wanfo_tower','temple',150,2,.8,'footpath'],
  ['edge_036','temple','xianxia_square',320,5,.48,'main_walkway'],
  ['edge_037','xianxia_square','xianxia_stage',170,3,.46,'main_walkway'],
  ['edge_038','xianxia_stage','juxianzhuang',190,3,.52,'main_walkway'],
  ['edge_039','juxianzhuang','film_studio',240,4,.55,'main_walkway'],
  ['edge_040','film_studio','art_square',260,4,.36,'main_walkway'],
  ['edge_041','art_square','summit',210,3,.3,'main_walkway'],
  ['edge_042','art_square','children_park',180,3,.32,'footpath'],
  ['edge_043','children_park','eastgate',170,3,.4,'main_walkway'],
  ['edge_044','summit','eastgate',230,4,.24,'footpath'],
  ['edge_045','westgate','gate',540,8,.6,'main_walkway'],
  ['edge_046','westgate','circus',220,4,.3,'footpath'],
  ['edge_047','circus','tiger_hall',110,2,.34,'footpath'],
  ['edge_048','fortress','qianqiu_lake',260,4,.48,'footpath'],
  ['edge_049','qianqiu_lake','lake',140,2,.35,'footpath'],
  ['edge_050','shizipo','wanshou_lake',230,4,.3,'footpath'],
  ['edge_051','wanshou_lake','xianxia_square',310,5,.42,'main_walkway'],
  ['edge_052','film_studio','retro_block',180,3,.48,'footpath'],
  ['edge_053','retro_block','puyi_wharf',140,2,.38,'footpath'],
  ['edge_054','longtan','dyehouse',140,2,.47,'footpath'],
  ['edge_055','dyehouse','wangpo_island',100,2,.44,'footpath'],
  ['edge_056','water_street','wulin_square',190,3,.42,'main_walkway'],
  ['edge_057','wulin_square','theater',120,2,.46,'footpath'],
  ['edge_058','westgate','bailemen',65,1,.56,'footpath'],
  ['edge_059','museum','shili_yangchang',90,2,.49,'footpath'],
  ['edge_060','dyehouse','kuaipolin',60,1,.72,'footpath'],
  ['edge_061','wangpo_island','chaguan',95,2,.65,'footpath'],
  ['edge_062','wulin_square','zhu_family_fort',75,1,.37,'footpath'],
  ['edge_063','temple','magic_square',155,3,.52,'footpath'],
  ['edge_064','gate','shuihu_li',60,1,.5,'footpath'],
  ['edge_065','art_square','flower_camp',90,2,.34,'footpath'],
  ['edge_066','children_park','creative_market',65,1,.42,'footpath'],
  ['edge_067','creative_market','forest_boardwalk',80,2,.57,'footpath'],
  ['edge_068','forest_boardwalk','summit',60,1,.63,'footpath']
].map(([edge_id,from_node_id,to_node_id,distance_m,base_travel_time_min,shade,road_class]) => ({ edge_id,from_node_id,to_node_id,distance_m,base_travel_time_min,shade,direction:'BIDIRECTIONAL',road_class,location_source:'hand_map_reference' }));
const mainOld = new Set(['edge_002','edge_003','edge_004','edge_006','edge_008','edge_010','edge_012','edge_014','edge_015','edge_020']);
for (const edge of graph.edges) {
  edge.road_class ||= mainOld.has(edge.edge_id) ? 'main_walkway' : 'footpath';
  edge.location_source ||= 'hand_map_reference';
}
const edgeIds = new Set(graph.edges.map(edge => edge.edge_id));
for (const edge of newEdges) if (!edgeIds.has(edge.edge_id)) graph.edges.push(edge);

// Derive every routing cost from the exact same polyline that C draws. This
// removes the former mismatch where a visually cross-park road still carried
// the short distance from the 13-node prototype. The scale is an explicit
// demonstration estimate (0.82 m/source-pixel at 75 m/min walking speed).
global.window = {};
delete require.cache[require.resolve(path.join(root, 'public/scenic-layout.js'))];
require(path.join(root, 'public/scenic-layout.js'));
const sharedLayout = global.window.ScenicMapLayout;
delete global.window;
for (const edge of graph.edges) {
  const points = sharedLayout.edges[edge.edge_id];
  if (!points?.length) throw new Error(`Missing shared hand-map road geometry: ${edge.edge_id}`);
  const sourceLength = points.slice(1).reduce((sum, point, index) => {
    const previous = points[index];
    return sum + Math.hypot(point[0] - previous[0], point[1] - previous[1]);
  }, 0);
  edge.distance_m = Math.max(40, Math.round(sourceLength * .82 / 5) * 5);
  edge.base_travel_time_min = Math.max(1, Math.round(edge.distance_m / 75 * 100) / 100);
  edge.metric_source = 'schematic_polyline_estimate';
}

const poiDefaults = {
  fortress:[18,.56], hero_square:[2,.3], feiyunpu:[10,.52], shenboat:[8,.43],
  wangpo_island:[25,.72], water_street:[7,.6], wanfo_tower:[1,.2],
  xianxia_square:[5,.48], xianxia_stage:[14,.63], film_studio:[4,.38],
  art_square:[6,.58], children_park:[5,.45], circus:[12,.56], tiger_hall:[3,.32],
  qianqiu_lake:[2,.24], wanshou_lake:[4,.3], retro_block:[5,.42], puyi_wharf:[2,.28],
  dyehouse:[2,.22], wulin_square:[6,.5], bailemen:[3,.31],
  shili_yangchang:[4,.36], kuaipolin:[2,.26], chaguan:[5,.4],
  zhu_family_fort:[16,.64], magic_square:[5,.43], shuihu_li:[5,.48],
  flower_camp:[2,.3], creative_market:[4,.43], forest_boardwalk:[2,.22]
};
for (const [id,[queue_min,crowd_ratio]] of Object.entries(poiDefaults)) {
  state.poi_states[id] ||= { open:true, queue_min, crowd_ratio, crowd_level:crowd_ratio >= .7 ? 'HIGH' : crowd_ratio >= .4 ? 'MEDIUM' : 'LOW' };
}
for (const edge of graph.edges) {
  state.road_states[edge.edge_id] ||= { available:true, travel_time_min:edge.base_travel_time_min };
  state.road_states[edge.edge_id].travel_time_min = edge.base_travel_time_min;
}

const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
writeJson(graphPath, graph);
writeJson(statePath, state);
writeJson(path.join(root, 'server/examples/normal_state.json'), state);
writeJson(path.join(root, 'public/c-demo-graph.json'), graph);
writeJson(path.join(root, 'public/c-demo-state.json'), state);
const planPath = path.join(root, 'public/c-demo-plan.json');
if (fs.existsSync(planPath)) {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const migratePlanIds = value => {
    if (Array.isArray(value)) return value.map(migratePlanIds);
    if (!value || typeof value !== 'object') return value === 'northgate' ? 'westgate' : value === '北大门' ? '西大门' : value;
    for (const key of Object.keys(value)) value[key] = migratePlanIds(value[key]);
    return value;
  };
  writeJson(planPath, migratePlanIds(plan));
}

// Load after the canonical files have been rewritten so the generated example
// necessarily covers every newly published POI and edge.
for (const modulePath of ['./server/state/stateProvider', './server/state/forecastSimulator']) {
  try { delete require.cache[require.resolve(path.join(root, modulePath))]; } catch (_) {}
}
const { predictEnvironment } = require(path.join(root, 'server/state/forecastSimulator'));
writeJson(path.join(root, 'server/examples/normal_forecast.json'), predictEnvironment(state, 60, 10));

console.log(`Expanded scenic network: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${Object.keys(state.poi_states).length} POIs.`);
