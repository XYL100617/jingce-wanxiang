/* Shared presentation geometry reconstructed from the supplied long-form
 * Wansui Mountain hand map and cross-checked against a public park guide map.
 * Source space is 2560 x 500. Only `nodes` and `edges` are routable A IDs;
 * reference landmarks and secondary paths are C-only cartographic detail. */
(() => {
  'use strict';

  const nodes = {
    // The central entrance is 中门. The western entrance is 西大门; no 北大门
    // appears on the supplied detailed visitor map.
    gate: [838, 58], southgate: [350, 395], temple: [1425, 102],
    lake: [520, 205], market: [1040, 225], museum: [430, 143],
    longtan: [820, 215], forest: [1155, 286], theater: [1265, 178],
    shizipo: [1580, 198], summit: [2380, 306], rest: [1340, 292],
    juxianzhuang: [1815, 226],
    westgate: [240,40], eastgate: [2490,164], fortress: [160,180],
    hero_square: [336,155], feiyunpu: [689,197], shenboat: [760,102],
    wangpo_island: [947,210], water_street: [1100,174], wanfo_tower: [1350,47],
    xianxia_square: [1690,126], xianxia_stage: [1772,165],
    film_studio: [1965,169], art_square: [2180,206], children_park: [2320,190],
    circus:[45,110], tiger_hall:[170,80], qianqiu_lake:[365,250],
    wanshou_lake:[1435,154], retro_block:[1920,116], puyi_wharf:[2050,103],
    dyehouse:[902,184], wulin_square:[1273,102],
    bailemen:[235,135], shili_yangchang:[600,60], kuaipolin:[930,88],
    chaguan:[1030,102], zhu_family_fort:[1160,102], magic_square:[1515,102],
    shuihu_li:[860,115], flower_camp:[2136,270], creative_market:[2290,225], forest_boardwalk:[2350,265]
  };

  const displayNames = { gate: '中门', southgate: '南门入口', westgate: '西大门' };
  // Numbering follows the supplied C style study, while coordinates continue
  // to follow the long-form hand map. Numbers are presentation-only.
  const nodeNumbers = {
    southgate:1, summit:2, theater:3, market:4, longtan:5, museum:6,
    lake:7, shizipo:8, temple:9, gate:10, rest:11, juxianzhuang:12, forest:13,
    westgate:14, fortress:15, hero_square:16, feiyunpu:17, shenboat:18,
    wangpo_island:19, water_street:20, wanfo_tower:21, xianxia_square:22,
    xianxia_stage:23, film_studio:24, art_square:25, children_park:26, eastgate:27,
    circus:28, tiger_hall:29, qianqiu_lake:30, wanshou_lake:31, retro_block:32, puyi_wharf:33,
    dyehouse:34, wulin_square:35, bailemen:36, shili_yangchang:37,
    kuaipolin:38, chaguan:39, zhu_family_fort:40, magic_square:41,
    shuihu_li:42, flower_camp:43, creative_market:44, forest_boardwalk:45
  };

  // A's 20 canonical links. Curves follow visible promenades and junctions;
  // endpoint identity is kept exact and is checked by test/c-map.test.js.
  const edges = {
    edge_001: [[838,58],[760,52],[640,45],[500,42],[360,46],[240,40],[170,55],[105,85],[70,130],[55,180],[80,245],[150,300],[240,340],[350,395]],
    edge_002: [[838,58],[880,48],[930,48],[980,55],[1025,72],[1060,102],[1084,148],[1080,190],[1040,225]],
    edge_003: [[350,395],[500,339],[680,310],[885,267],[1120,214],[1280,157],[1425,102]],
    edge_004: [[1425,102],[1245,112],[1055,125],[870,151],[690,182],[520,205]],
    edge_005: [[520,205],[600,210],[675,215],[750,215],[820,215]],
    edge_006: [[520,205],[650,226],[780,239],[905,237],[1040,225]],
    edge_007: [[820,215],[780,194],[730,175],[670,158],[610,150],[520,143],[430,143]],
    edge_008: [[1040,225],[1125,245],[1215,271],[1340,292]],
    edge_009: [[430,143],[620,161],[820,191],[1020,235],[1190,270],[1340,292]],
    edge_010: [[430,143],[610,116],[800,111],[985,126],[1140,150],[1265,178]],
    edge_011: [[1340,292],[1290,299],[1240,298],[1195,288],[1155,286]],
    edge_012: [[1340,292],[1388,300],[1440,292],[1495,275],[1555,270],[1610,256],[1660,247],[1735,236],[1815,226]],
    edge_013: [[1815,226],[1760,229],[1695,216],[1635,207],[1580,198]],
    edge_014: [[1580,198],[1750,179],[1945,191],[2165,248],[2380,306]],
    edge_015: [[1040,225],[1210,300],[1430,338],[1680,347],[1930,340],[2180,321],[2380,306]],
    edge_016: [[1340,292],[1515,310],[1710,321],[1935,320],[2185,315],[2380,306]],
    edge_017: [[1155,286],[1172,250],[1198,223],[1230,198],[1265,178]],
    edge_018: [[1155,286],[1260,261],[1365,235],[1475,213],[1580,198]],
    edge_019: [[1155,286],[1375,344],[1620,370],[1880,361],[2140,335],[2380,306]],
    edge_020: [[1425,102],[1380,108],[1340,125],[1290,139],[1238,158],[1182,171],[1130,196],[1085,214],[1040,225]],
    edge_021: [[240,40],[220,65],[205,105],[185,140],[160,180]],
    edge_022: [[160,180],[190,145],[240,120],[300,115],[360,122],[400,135],[430,143]],
    edge_023: [[160,180],[205,203],[250,210],[290,210],[330,210],[380,210],[450,205],[520,205]],
    edge_024: [[336,155],[342,139],[380,132],[430,143]],
    edge_025: [[336,155],[385,165],[405,195],[380,220],[330,225],[260,225],[205,205],[160,180]],
    edge_026: [[838,58],[820,40],[790,38],[760,42],[730,60],[700,95],[680,140],[689,197]],
    edge_027: [[689,197],[730,200],[775,210],[820,215]],
    edge_028: [[689,197],[676,159],[666,120],[670,85],[700,64],[735,54],[760,58],[760,102]],
    edge_029: [[760,102],[785,82],[812,65],[838,58]],
    edge_030: [[820,215],[860,230],[900,226],[947,210]],
    edge_031: [[947,210],[980,218],[1010,222],[1040,225]],
    edge_032: [[1040,225],[1055,207],[1075,188],[1100,174]],
    edge_033: [[1100,174],[1155,160],[1210,160],[1265,178]],
    edge_034: [[1265,178],[1300,136],[1334,88],[1350,47]],
    edge_035: [[1350,47],[1338,62],[1333,84],[1363,108],[1390,121],[1425,102]],
    edge_036: [[1425,102],[1510,105],[1602,112],[1690,126]],
    edge_037: [[1690,126],[1718,136],[1747,151],[1772,165]],
    edge_038: [[1772,165],[1788,185],[1800,207],[1815,226]],
    edge_039: [[1815,226],[1860,205],[1910,185],[1965,169]],
    edge_040: [[1965,169],[2030,170],[2105,186],[2180,206]],
    edge_041: [[2180,206],[2245,224],[2310,270],[2380,306]],
    edge_042: [[2180,206],[2248,195],[2320,190]],
    edge_043: [[2320,190],[2385,190],[2440,174],[2490,164]],
    edge_044: [[2380,306],[2420,260],[2460,210],[2490,164]],
    edge_045: [[240,40],[360,46],[500,42],[640,45],[760,52],[838,58]],
    edge_046: [[240,40],[190,61],[143,70],[102,84],[78,95],[45,110]],
    edge_047: [[45,110],[78,90],[118,74],[150,74],[170,80]],
    edge_048: [[160,180],[190,205],[210,212],[335,212],[370,212],[378,230],[365,250]],
    edge_049: [[365,250],[390,231],[418,219],[450,212],[480,210],[503,207],[520,205]],
    edge_050: [[1580,198],[1548,205],[1514,206],[1470,207],[1432,202],[1417,186],[1419,167],[1435,154]],
    edge_051: [[1435,154],[1426,132],[1465,112],[1525,108],[1590,112],[1645,121],[1690,126]],
    edge_052: [[1965,169],[1950,150],[1935,132],[1920,116]],
    edge_053: [[1920,116],[1960,108],[2005,104],[2050,103]],
    edge_054: [[820,215],[840,205],[865,192],[885,186],[902,184]],
    edge_055: [[902,184],[935,180],[948,192],[947,210]],
    edge_056: [[1100,174],[1132,160],[1175,143],[1224,116],[1273,102]],
    edge_057: [[1273,102],[1282,124],[1277,151],[1265,178]],
    edge_058: [[240,40],[243,64],[237,94],[235,135]],
    edge_059: [[430,143],[462,110],[500,75],[540,48],[580,45],[600,60]],
    edge_060: [[902,184],[880,168],[872,145],[882,118],[902,98],[930,88]],
    edge_061: [[947,210],[958,179],[976,149],[999,121],[1030,102]],
    edge_062: [[1273,102],[1248,106],[1200,108],[1160,102]],
    edge_063: [[1425,102],[1451,95],[1483,95],[1515,102]],
    edge_064: [[838,58],[848,72],[854,93],[860,115]],
    edge_065: [[2180,206],[2160,226],[2147,248],[2136,270]],
    edge_066: [[2320,190],[2314,203],[2301,216],[2290,225]],
    edge_067: [[2290,225],[2310,236],[2331,251],[2350,265]],
    edge_068: [[2350,265],[2361,280],[2370,294],[2380,306]]
  };

  // Named places legible in the supplied map. They improve orientation but do
  // not become routing targets until A publishes IDs and verified paths.
  const referenceLandmarks = [
    {id:'wuxia_road',name:'武侠路',x:650,y:112,kind:'street'},
    {id:'beixian_street',name:'北仙街',x:1655,y:111,kind:'street'},
    {id:'east_service',name:'万岁山东门游客服务中心',x:2460,y:210,kind:'service'},
    // The hand-map explicitly labels these three internal zone entrances.
    // They are orientation landmarks, not park-exit gates or routing nodes.
    {id:'water_margin_entrance',name:'水浒区入口',x:900,y:345,kind:'gate'},
    {id:'xianxia_entrance',name:'仙侠区入口',x:1770,y:320,kind:'gate'},
    {id:'jianghu_stage_entrance',name:'江湖艺术区演艺场入口',x:2450,y:330,kind:'junction_gate'}
  ];

  // Lines traced from the illustrated visitor map are source evidence only.
  // None has field-verified walkability; they are not drawn or routed.
  const secondaryPaths = [
    {id:'s01',points:[[68,51],[120,88],[205,130],[306,150],[430,143]],sourceTraced:true,verified:false},
    {id:'s02',points:[[205,183],[290,174],[380,180],[520,205]],sourceTraced:true,verified:false},
    {id:'s04',points:[[430,143],[490,110],[570,105],[650,125],[706,112]],sourceTraced:true,verified:false},
    {id:'s05',points:[[689,197],[706,150],[760,102],[838,58]],sourceTraced:true,verified:false},
    {id:'s06',points:[[790,180],[845,196],[902,184],[947,210],[1040,225]],sourceTraced:true,verified:false},
    {id:'s07',points:[[947,210],[1010,170],[1100,174],[1218,132]],sourceTraced:true,verified:false},
    {id:'s08',points:[[1100,174],[1155,212],[1155,286]],sourceTraced:true,verified:false},
    {id:'s09',points:[[1218,132],[1265,178],[1340,160],[1425,102]],sourceTraced:true,verified:false},
    {id:'s12',points:[[1815,226],[1880,170],[1965,169],[2050,103]],sourceTraced:true,verified:false},
    {id:'s13',points:[[1965,169],[2055,205],[2180,206],[2320,190],[2490,164]],sourceTraced:true,verified:false},
    {id:'s14',points:[[2050,103],[2160,95],[2280,116],[2490,164]],sourceTraced:true,verified:false},
    {id:'s19',points:[[900,345],[904,318],[920,284],[937,244],[947,210]],sourceTraced:true,verified:false},
    {id:'s15',points:[[520,205],[560,272],[680,300],[790,270]],verified:false},
    {id:'s16',points:[[1040,225],[1100,305],[1230,350],[1340,292]],verified:false},
    {id:'s17',points:[[1580,198],[1640,270],[1735,300],[1815,226]],verified:false},
    {id:'s18',points:[[2180,206],[2240,270],[2380,306],[2490,240]],verified:false}
  ];

  const facilities = [
    {id:'f_info_mid',name:'游客服务',x:815,y:75,icon:'i',verified:true},
    {id:'f_wc_west',name:'卫生间',x:365,y:114,icon:'WC',verified:true},
    {id:'f_firstaid',name:'医疗点',x:1470,y:235,icon:'+',verified:false},
    {id:'f_rest_east',name:'休息点',x:2140,y:255,icon:'椅',verified:false},
    {id:'f_wc_east',name:'卫生间',x:2415,y:215,icon:'WC',verified:true},
    {id:'f_food',name:'餐饮补给',x:1115,y:203,icon:'餐',verified:true}
  ];

  // Trace only blue-painted water in the supplied long visitor map: 千秋湖,
  // the long lower watercourse and 万寿湖. No decorative southern "lake".
  const waterBodies = [
    // 千秋湖: slightly fuller natural shoreline, still confined to the blue
    // lake shown in the source map; the eastern cove opens toward the stream.
    [[216,246],[228,228],[252,219],[276,220],[298,226],[318,220],[338,225],[355,239],[362,255],[358,270],[344,282],[324,286],[303,280],[284,290],[260,286],[240,276],[224,264]],
    [[390,302],[446,308],[507,309],[556,311],[629,317],[705,322],[774,323],[846,313],[917,315],[995,317],[1074,314],[1154,309],[1234,302],[1310,293],[1385,287],[1468,289],[1542,288],[1619,281],[1685,282],[1682,298],[1609,301],[1535,305],[1458,307],[1383,305],[1318,312],[1240,320],[1157,328],[1075,335],[995,338],[917,336],[844,337],[773,347],[694,347],[620,339],[551,332],[490,329],[431,323]],
    [[1438,161],[1465,148],[1500,146],[1534,152],[1565,148],[1600,150],[1635,159],[1668,166],[1690,175],[1680,187],[1648,190],[1612,184],[1574,188],[1535,183],[1497,190],[1465,183],[1443,174]]
  ];

  // Keep the source map's original y coordinates. Compressing them made the
  // landmarks drift away from the drawn roads and crushed the whole park into
  // a narrow strip. The SVG is already a landscape 2560x500 board.
  // Give the tightly packed northern courts a little more vertical room.
  // Every overview feature (buildings, A roads, secondary lanes and water)
  // uses this same projection; the independent detailed map is unchanged.
  const project = point => {
    const x = Number(point[0]), y = Number(point[1]);
    return [x, y - Math.max(0, (220 - y) / 220) * 18];
  };
  // Canvas Map 01 uses the source renderer's 2400x1600 board. These thirteen
  // anchors are the labelled landmarks from the supplied hand-drawn study;
  // the remaining shared A nodes are projected from the same source space.
  const overviewCanvasNodes = {
    southgate:[1200,1425], summit:[1740,1335], theater:[1542,1065], market:[1200,1182],
    longtan:[1200,957], museum:[930,1011], lake:[615,876], shizipo:[984,705],
    temple:[840,475], gate:[1200,309], rest:[1610,741], juxianzhuang:[1728,507], forest:[606,1216],
    westgate:[570,282], eastgate:[1965,608], fortress:[669,496], hero_square:[754,395],
    feiyunpu:[815,691], shenboat:[1045,388], wangpo_island:[1299,568], water_street:[1416,593],
    wanfo_tower:[1510,395], xianxia_square:[1619,493], xianxia_stage:[1722,615],
    film_studio:[1839,709], art_square:[1589,1252], children_park:[1402,1259],
    circus:[330,417], tiger_hall:[373,482], qianqiu_lake:[557,849],
    wanshou_lake:[1309,586], retro_block:[1650,482], puyi_wharf:[1742,447],
    dyehouse:[934,668], wulin_square:[1156,526],
    bailemen:[598,296], shili_yangchang:[925,365], kuaipolin:[1180,560],
    chaguan:[1270,565], zhu_family_fort:[1430,405], magic_square:[1580,440],
    shuihu_li:[1245,471], flower_camp:[1650,1260], creative_market:[1500,1210], forest_boardwalk:[1765,1300]
  };
  // Map 01 has two different kinds of anchors: a label/building anchor and a
  // walkable forecourt anchor.  Keeping them separate prevents route badges
  // from landing on a roof while the POI label remains attached to the
  // illustrated building.  Coordinates are in the Canvas map's 1000×740
  // world space and are projected with the same transform as the renderer.
  const routeWorldNodes = {
    gate:[500,108], southgate:[500,665], temple:[300,225], lake:[202,425],
    market:[500,535], museum:[350,428], longtan:[500,405], forest:[205,565],
    theater:[660,500], shizipo:[388,330], summit:[770,620], rest:[700,350],
    juxianzhuang:[760,235], westgate:[190,110], eastgate:[890,246],
    fortress:[230,205], hero_square:[270,150], feiyunpu:[300,300],
    shenboat:[410,150], wangpo_island:[560,250], water_street:[610,272],
    wanfo_tower:[670,158], xianxia_square:[720,208], xianxia_stage:[790,278],
    film_studio:[845,330], art_square:[700,585], children_park:[620,600],
    circus:[17,140], tiger_hall:[41,176], qianqiu_lake:[143,380],
    wanshou_lake:[561,234], retro_block:[750,176], puyi_wharf:[801,156],
    dyehouse:[523,365], wulin_square:[635,350],
    bailemen:[215,128], shili_yangchang:[360,165], kuaipolin:[535,310],
    chaguan:[575,315], zhu_family_fort:[650,200], magic_square:[704,215],
    shuihu_li:[525,170], flower_camp:[725,580], creative_market:[685,565], forest_boardwalk:[755,605]
  };
  const canvasWorldPoint = ([x, z]) => [300 + Number(x) * 1.8, 165 + Number(z) * 1.8];
  const routeWorld = (points) => points.map(canvasWorldPoint);
  const overviewCanvasRouteNodes = Object.fromEntries(Object.entries(routeWorldNodes).map(([id, point]) => [id, canvasWorldPoint(point)]));
  // Curved pedestrian corridors reconstructed from the supplied hand map and
  // the known Canvas roads.  These are presentation polylines only; A still
  // owns the routable topology and edge IDs.
  const overviewCanvasEdges = {
    // These first links follow the same gently bending promenades drawn by C
    // (rather than a straight chord between two POIs).  The final point of
    // every polyline is still the separate forecourt anchor above.
    edge_001: routeWorld([[500,108],[500,160],[502,220],[492,280],[500,330],[505,370],[495,400],[472,420],[462,440],[470,462],[486,478],[496,505],[490,550],[500,600],[510,650],[500,665]]),
    edge_002: routeWorld([[500,108],[500,160],[502,220],[492,280],[500,330],[505,370],[495,400],[500,450],[496,505],[486,535],[500,535]]),
    edge_003: routeWorld([[500,665],[510,630],[500,600],[486,552],[455,528],[410,505],[370,485],[390,450],[380,400],[380,350],[380,300],[360,265],[334,228],[300,225]]),
    edge_004: routeWorld([[300,225],[334,228],[345,240],[360,265],[380,300],[350,315],[310,345],[270,390],[240,425],[202,425]]),
    edge_005: routeWorld([[202,425],[240,425],[300,430],[350,470],[375,465],[400,452],[430,442],[462,440],[472,420],[495,400],[500,405]]),
    edge_006: routeWorld([[202,425],[240,425],[270,445],[305,458],[350,470],[370,485],[410,505],[455,528],[486,535],[500,535]]),
    edge_007: routeWorld([[500,405],[472,420],[462,440],[430,442],[400,452],[375,465],[350,470],[350,428]]),
    edge_008: routeWorld([[500,535],[520,500],[560,470],[600,430],[632,360],[675,330],[700,350]]),
    edge_009: routeWorld([[350,428],[390,420],[440,410],[500,405],[542,416],[588,390],[632,360],[675,330],[700,350]]),
    edge_010: routeWorld([[350,428],[400,430],[450,420],[500,405],[540,435],[588,470],[632,483],[660,500]]),
    edge_011: routeWorld([[700,350],[625,380],[535,430],[440,485],[330,545],[205,565]]),
    edge_012: routeWorld([[700,350],[720,315],[745,270],[760,235]]),
    edge_013: routeWorld([[760,235],[680,245],[590,265],[490,290],[388,330]]),
    edge_014: routeWorld([[388,330],[445,370],[515,430],[590,505],[680,575],[770,620]]),
    edge_015: routeWorld([[500,535],[570,565],[650,595],[710,615],[770,620]]),
    edge_016: routeWorld([[700,350],[720,415],[735,490],[750,560],[770,620]]),
    edge_017: routeWorld([[205,565],[275,545],[360,520],[470,505],[660,500]]),
    edge_018: routeWorld([[205,565],[235,510],[275,445],[330,380],[388,330]]),
    edge_019: routeWorld([[205,565],[300,590],[420,615],[560,630],[670,630],[770,620]]),
    edge_020: routeWorld([[300,225],[350,280],[405,345],[455,415],[500,535]]),
    edge_021: routeWorld([[190,110],[205,140],[218,170],[230,205]]),
    edge_022: routeWorld([[230,205],[260,245],[285,290],[315,350],[340,395],[350,428]]),
    edge_023: routeWorld([[230,205],[260,235],[285,275],[320,315],[330,365],[300,410],[202,425]]),
    edge_024: routeWorld([[270,150],[300,195],[320,255],[335,325],[350,428]]),
    edge_025: routeWorld([[270,150],[250,170],[230,205]]),
    edge_026: routeWorld([[500,108],[455,150],[405,210],[350,260],[300,300]]),
    edge_027: routeWorld([[300,300],[350,315],[410,345],[460,375],[500,405]]),
    edge_028: routeWorld([[300,300],[325,245],[360,195],[410,150]]),
    edge_029: routeWorld([[410,150],[440,125],[470,110],[500,108]]),
    edge_030: routeWorld([[500,405],[520,350],[540,300],[560,250]]),
    edge_031: routeWorld([[560,250],[555,310],[540,380],[520,455],[500,535]]),
    edge_032: routeWorld([[500,535],[545,475],[575,390],[600,325],[610,272]]),
    edge_033: routeWorld([[610,272],[630,320],[645,385],[660,500]]),
    edge_034: routeWorld([[660,500],[675,410],[675,300],[670,158]]),
    edge_035: routeWorld([[670,158],[610,150],[540,145],[460,165],[380,195],[300,225]]),
    edge_036: routeWorld([[300,225],[390,205],[490,195],[600,195],[720,208]]),
    edge_037: routeWorld([[720,208],[750,225],[775,250],[790,278]]),
    edge_038: routeWorld([[790,278],[815,260],[805,240],[785,235],[760,235]]),
    edge_039: routeWorld([[760,235],[790,250],[820,285],[845,330]]),
    edge_040: routeWorld([[845,330],[820,385],[790,455],[750,525],[700,585]]),
    edge_041: routeWorld([[700,585],[730,595],[750,610],[770,620]]),
    edge_042: routeWorld([[700,585],[675,595],[650,600],[620,600]]),
    edge_043: routeWorld([[620,600],[690,590],[760,535],[825,430],[870,330],[890,246]]),
    edge_044: routeWorld([[770,620],[815,565],[850,480],[875,380],[890,300],[890,246]]),
    edge_045: routeWorld([[190,110],[260,100],[330,95],[390,100],[450,104],[500,108]]),
    edge_046: routeWorld([[190,110],[160,112],[130,120],[100,132],[75,138],[45,140],[17,140]]),
    edge_047: routeWorld([[17,140],[25,151],[33,162],[41,176]]),
    edge_048: routeWorld([[230,205],[205,250],[185,290],[160,325],[145,355],[143,380]]),
    edge_049: routeWorld([[143,380],[160,390],[178,400],[190,415],[202,425]]),
    edge_050: routeWorld([[388,330],[420,315],[455,300],[490,280],[525,255],[561,234]]),
    edge_051: routeWorld([[561,234],[555,215],[565,195],[590,185],[625,182],[660,187],[695,196],[720,208]]),
    edge_052: routeWorld([[845,330],[830,300],[810,270],[780,230],[750,176]]),
    edge_053: routeWorld([[750,176],[770,168],[785,162],[801,156]]),
    edge_054: routeWorld([[500,405],[505,390],[510,380],[516,372],[523,365]]),
    edge_055: routeWorld([[523,365],[535,345],[545,320],[555,285],[560,250]]),
    edge_056: routeWorld([[610,272],[618,290],[625,310],[631,330],[635,350]]),
    edge_057: routeWorld([[635,350],[646,380],[652,420],[660,460],[660,500]]),
    edge_058: routeWorld([[190,110],[198,114],[207,121],[215,128]]),
    edge_059: routeWorld([[350,428],[347,350],[350,270],[360,165]]),
    edge_060: routeWorld([[523,365],[528,340],[532,325],[535,310]]),
    edge_061: routeWorld([[560,250],[562,270],[568,295],[575,315]]),
    edge_062: routeWorld([[635,350],[640,300],[647,250],[650,200]]),
    edge_063: routeWorld([[300,225],[420,190],[560,180],[704,215]]),
    edge_064: routeWorld([[500,108],[511,125],[518,148],[525,170]]),
    edge_065: routeWorld([[700,585],[710,577],[720,575],[725,580]]),
    edge_066: routeWorld([[620,600],[640,586],[663,573],[685,565]]),
    edge_067: routeWorld([[685,565],[710,575],[736,589],[755,605]]),
    edge_068: routeWorld([[755,605],[761,610],[766,615],[770,620]])
  };
  const overviewCanvasPoint = (point) => [300 + (Number(point[0]) / 2560) * 1800, 165 + (Number(point[1]) / 500) * 1368];
  window.ScenicMapLayout = Object.freeze({
    width:2560, overviewHeight:500, detailHeight:1220,
    nodes:Object.freeze(nodes), displayNames:Object.freeze(displayNames), nodeNumbers:Object.freeze(nodeNumbers), edges:Object.freeze(edges),
    referenceLandmarks:Object.freeze(referenceLandmarks), secondaryPaths:Object.freeze(secondaryPaths),
    facilities:Object.freeze(facilities), waterBodies:Object.freeze(waterBodies),
    overviewCanvasNodes:Object.freeze(overviewCanvasNodes), overviewCanvasRouteNodes:Object.freeze(overviewCanvasRouteNodes), overviewCanvasEdges:Object.freeze(overviewCanvasEdges), overviewCanvasPoint,
    mainEdges:Object.freeze(['edge_002','edge_003','edge_004','edge_006','edge_008','edge_010','edge_012','edge_014','edge_015','edge_020','edge_021','edge_022','edge_026','edge_029','edge_031','edge_032','edge_033','edge_036','edge_037','edge_038','edge_039','edge_040','edge_041','edge_043','edge_045']),
    // Only the broad, legible circulation spines are painted on the overview.
    // The full edge graph remains available to A/B and to the detailed map.
    // Draw the curved core streets and selected local branches only; omit
    // broad A/B shortcuts that cross open terrain or duplicate nearby lanes.
    overviewBaseEdges:Object.freeze(['edge_001','edge_002','edge_008','edge_010','edge_011','edge_012','edge_013','edge_021','edge_022','edge_024','edge_027','edge_028','edge_029','edge_032','edge_034','edge_035','edge_036','edge_037','edge_038','edge_039','edge_040','edge_041','edge_042','edge_043','edge_044','edge_045','edge_046','edge_047','edge_048','edge_049','edge_050','edge_051','edge_052','edge_053','edge_054','edge_055','edge_056','edge_057','edge_058','edge_059','edge_060','edge_061','edge_062','edge_063','edge_064','edge_065','edge_066','edge_067','edge_068']),
    // These are canonical A edges too, but the visitor overview hides their
    // redundant loops until the local-path button is opened.
    overviewOptionalEdges:Object.freeze(['edge_033']),
    overviewPoint(point){return project(point);},
    detailPoint(point){return [Number(point[0]), 70 + Number(point[1]) * 2.12];}
  });
})();
