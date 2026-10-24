/* ============================================================
   万岁山 · 大宋武侠城 — 2.5D 片区图
   A single-frame illustrated map. No route layer, no heat layer:
   just clear roads, simulated architecture and the expanded 27-place map.
   ============================================================ */

(() => {
  "use strict";

  const canvas = document.getElementById("tripMap") || document.getElementById("map");
  if (!canvas || typeof canvas.getContext !== "function") return;
  const ctx = canvas.getContext("2d");
  const W = 2400;
  const H = 1600;
  const PLAIN = canvas?.dataset.plain === "true" || new URLSearchParams(window.location.search).has("plain");
  // Map 01 is a base illustration. The live B route is rendered by the
  // platform's SVG overlay so it can update without repainting the artwork.
  const DRAW_BASE_ROUTE = false;

  const MAP = { x: 300, y: 165, w: 1800, h: 1368, s: 1.8 };
  const X = (x) => MAP.x + x * MAP.s;
  const Z = (z) => MAP.y + z * MAP.s;
  const S = MAP.s;
  const HX = (h) => h * 0.25 * S;
  const HY = (h) => h * 0.74 * S;

  const PAL = {
    ink: "#071a1d",
    ink2: "#0d292b",
    paper: "#e9dcc1",
    paper2: "#dfd0b1",
    paperLight: "#f4e8d1",
    gold: "#cba25f",
    goldLight: "#efd49a",
    red: "#a94332",
    redDark: "#742b22",
    jade: "#426b64",
    jadeLight: "#6f9487",
    forest: "#78926c",
    forestDark: "#5b795d",
    forestLight: "#9db184",
    water: "#5f9698",
    waterLight: "#8fc0b9",
    stone: "#d8c6a4",
    road: "#f1e2c3",
    roadEdge: "#a68d68",
    roadMark: "#b69a70",
    wall: "#d7c4a0",
    text: "#2a2b23",
    muted: "#7c6e55",
  };

  const KAI = '"KaiTi","STKaiti","Kaiti SC","Songti SC","SimSun",serif';
  const SANS = '"Microsoft YaHei","PingFang SC","HarmonyOS Sans SC",sans-serif';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const inForestClearing = (x, z) => ((x - 170) / 58) ** 2 + ((z - 584) / 58) ** 2 < 1.18;

  const TOUR_ROUTE = [
    [500, 690], [510, 655], [500, 600], [490, 550], [496, 505], [486, 478],
    [470, 462], [462, 440], [430, 442], [400, 452], [375, 465], [350, 470],
    [330, 465], [305, 458], [275, 445], [250, 432], [240, 425], [270, 390],
    [310, 345], [350, 315], [380, 300], [360, 265], [345, 240], [334, 228],
    [300, 214],
  ];
  const TOUR_STOPS = [
    [500, 690], [500, 565], [470, 462], [350, 470],
    [240, 425], [380, 300], [300, 214],
  ];

  const SPOTS = [
    { id: "south", no: 1, name: "南门入口", cat: "城门", x: 500, z: 700, h: 24, label: [-175, 52] },
    { id: "wall", no: 2, name: "明清城墙观景点", cat: "城垣", x: 800, z: 650, h: 30, label: [42, 8] },
    { id: "arena", no: 3, name: "武林会场", cat: "演艺", x: 690, z: 500, h: 12, label: [118, -20] },
    { id: "market", no: 4, name: "非遗集市", cat: "街区", x: 500, z: 565, h: 20, label: [-180, 34] },
    { id: "altar", no: 5, name: "龙坛", cat: "祈福", x: 500, z: 440, h: 30, label: [120, -42] },
    { id: "hall", no: 6, name: "大宋武馆", cat: "武学", x: 350, z: 470, h: 18, label: [100, -14] },
    { id: "waterfall", no: 7, name: "九龙瀑", cat: "水景", x: 175, z: 395, h: 44, label: [-170, -20] },
    { id: "cross", no: 8, name: "十字坡", cat: "驿路", x: 380, z: 300, h: 18, label: [-155, -12] },
    { id: "temple", no: 9, name: "万岁寺", cat: "寺观", x: 300, z: 172, h: 38, label: [-170, -25] },
    { id: "north", no: 10, name: "中门", cat: "城门", x: 500, z: 80, h: 24, label: [-150, -52] },
    { id: "post", no: 11, name: "松风驿站", cat: "驿站", x: 710, z: 320, h: 18, label: [96, -8] },
    { id: "manor", no: 12, name: "聚贤庄", cat: "庄园", x: 760, z: 190, h: 24, label: [95, -16] },
    { id: "forest", no: 13, name: "森林绿地", cat: "绿地", x: 170, z: 584, h: 18, label: [-150, 42] },
    // The detailed hand map contains a much richer sequence of gates, courtyards
    // and themed streets.  These entries are deliberately part of the base
    // illustration (rather than an SVG overlay) so the labels, buildings and
    // route anchors stay in the same coordinate system.
    { id: "westgate", no: 14, name: "西大门", cat: "城门", x: 190, z: 118, h: 22, label: [56, -28], compact: true },
    { id: "eastgate", no: 15, name: "东大门", cat: "城门", x: 925, z: 246, h: 22, label: [-118, -26], compact: true },
    { id: "fortress", no: 16, name: "城寨沙场", cat: "演艺", x: 205, z: 184, h: 26, label: [-130, -26], compact: true },
    { id: "hero_square", no: 17, name: "好汉广场", cat: "广场", x: 252, z: 128, h: 16, label: [-122, -22], compact: true },
    { id: "feiyunpu", no: 18, name: "飞云浦", cat: "驿路", x: 286, z: 292, h: 16, label: [-122, -18], compact: true },
    { id: "shenboat", no: 19, name: "神舟传奇", cat: "演艺", x: 414, z: 124, h: 22, label: [-92, -28], compact: true },
    { id: "wangpo_island", no: 20, name: "王婆岛", cat: "街区", x: 555, z: 224, h: 16, label: [60, -20], compact: true },
    { id: "water_street", no: 21, name: "水浒街", cat: "街区", x: 620, z: 238, h: 16, label: [72, 18], compact: true },
    { id: "wanfo_tower", no: 22, name: "万佛塔", cat: "寺观", x: 672, z: 128, h: 46, label: [-104, -26], compact: true },
    { id: "xianxia_square", no: 23, name: "仙侠广场", cat: "广场", x: 733, z: 182, h: 15, label: [-112, -22], compact: true },
    { id: "xianxia_stage", no: 24, name: "仙侠奇境舞台", cat: "演艺", x: 790, z: 250, h: 18, label: [72, -20], compact: true },
    { id: "film_studio", no: 25, name: "武侠影视城", cat: "街区", x: 855, z: 302, h: 18, label: [-128, -24], compact: true },
    { id: "art_square", no: 26, name: "江湖艺术广场", cat: "艺术", x: 716, z: 604, h: 17, label: [82, -22], compact: true },
    { id: "children_park", no: 27, name: "亲子游乐园", cat: "亲子", x: 612, z: 608, h: 16, label: [-122, 30], compact: true },
    // C-only illustrative landmarks from the detailed reference image. They
    // are intentionally not routable until A publishes verified node IDs.
    { id: "c_qianqiu_lake", no: 28, name: "千秋湖", cat: "水景", x: 108, z: 252, h: 12, label: [42, -20], compact: true, visualOnly: true },
    { id: "c_wulin_square", no: 29, name: "武侠路", cat: "主路", x: 620, z: 360, h: 12, label: [56, -16], compact: true, visualOnly: true },
    { id: "c_wanshou_lake", no: 30, name: "万寿湖", cat: "水景", x: 820, z: 155, h: 12, label: [52, -22], compact: true, visualOnly: true },
    { id: "c_beixian_street", no: 31, name: "东京镖局", cat: "街区", x: 820, z: 108, h: 14, label: [-106, -18], compact: true, visualOnly: true },
    { id: "c_dyehouse", no: 32, name: "打铁铺", cat: "街区", x: 870, z: 195, h: 14, label: [54, -18], compact: true, visualOnly: true },
    { id: "c_sand_field", no: 33, name: "城寨沙场", cat: "演艺", x: 620, z: 310, h: 12, label: [-106, 22], compact: true, visualOnly: true },
    { id: "c_visitor_center", no: 34, name: "游客中心", cat: "服务", x: 92, z: 238, h: 14, label: [58, 20], compact: true, visualOnly: true },
    { id: "c_wharf", no: 35, name: "水上码头", cat: "水景", x: 430, z: 662, h: 13, label: [58, 24], compact: true, visualOnly: true },
  ];

  const items = [];
  const templeJobs = [];
  const roadQueue = [];
  const trailQueue = [];
  let deferTemple = false;
  let planningRoads = false;
  const addItem = (z, draw) => {
    if (deferTemple) templeJobs.push({ z, draw });
    else items.push({ z, draw });
  };

  /* ----------------------------- paper / texture ----------------------------- */

  function makeNoisePattern(size = 220, alpha = 0.055) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const img = g.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 90 + Math.random() * 120;
      img.data[i] = v;
      img.data[i + 1] = v * 0.94;
      img.data[i + 2] = v * 0.82;
      img.data[i + 3] = Math.random() * 255 * alpha;
    }
    g.putImageData(img, 0, 0);
    return ctx.createPattern(c, "repeat");
  }

  function roundRect(g, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.closePath();
  }

  function drawBackground() {
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    // Keep the illustrated parchment as the full rectangular canvas.  The
    // original study used a dark presentation frame, but the product map is
    // embedded in a light card and should not show a second black border.
    bg.addColorStop(0, "#d8cbaa");
    bg.addColorStop(0.5, "#d4c5a3");
    bg.addColorStop(1, "#c9b890");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // faint topographic rings
    ctx.save();
    ctx.globalAlpha = 0.11;
    ctx.strokeStyle = "#8c8a69";
    ctx.lineWidth = 1;
    for (let i = 0; i < 14; i++) {
      ctx.beginPath();
      const cx = 1250 + Math.sin(i * 1.7) * 600;
      const cy = 600 + Math.cos(i * 1.2) * 320;
      ctx.ellipse(cx, cy, 280 + i * 65, 130 + i * 34, -0.18, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // warm halo behind the board
    const halo = ctx.createRadialGradient(1200, 800, 200, 1200, 800, 1050);
    halo.addColorStop(0, "rgba(255,248,220,0.16)");
    halo.addColorStop(1, "rgba(255,248,220,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, W, H);
  }

  function drawBoard() {
    // parchment
    ctx.save();
    roundRect(ctx, MAP.x, MAP.y, MAP.w, MAP.h, 10);
    ctx.clip();
    ctx.fillStyle = PAL.paper;
    ctx.fillRect(MAP.x, MAP.y, MAP.w, MAP.h);

    // paper wash
    const wash = ctx.createLinearGradient(MAP.x, MAP.y, MAP.x, MAP.y + MAP.h);
    wash.addColorStop(0, "rgba(255,248,224,0.5)");
    wash.addColorStop(0.55, "rgba(233,216,184,0.15)");
    wash.addColorStop(1, "rgba(187,164,124,0.18)");
    ctx.fillStyle = wash;
    ctx.fillRect(MAP.x, MAP.y, MAP.w, MAP.h);

    ctx.globalAlpha = 0.55;
    ctx.fillStyle = makeNoisePattern(220, 0.06);
    ctx.fillRect(MAP.x, MAP.y, MAP.w, MAP.h);
    ctx.restore();
  }

  function finishBoard() {
    ctx.save();
    roundRect(ctx, MAP.x, MAP.y, MAP.w, MAP.h, 10);
    ctx.strokeStyle = "rgba(92,69,39,0.65)";
    ctx.lineWidth = 2;
    ctx.stroke();
    roundRect(ctx, MAP.x + 8, MAP.y + 8, MAP.w - 16, MAP.h - 16, 7);
    ctx.strokeStyle = "rgba(203,162,95,0.55)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // corner ticks
    ctx.save();
    ctx.strokeStyle = PAL.gold;
    ctx.lineWidth = 2;
    const corners = [
      [MAP.x + 18, MAP.y + 18, 1, 1],
      [MAP.x + MAP.w - 18, MAP.y + 18, -1, 1],
      [MAP.x + 18, MAP.y + MAP.h - 18, 1, -1],
      [MAP.x + MAP.w - 18, MAP.y + MAP.h - 18, -1, -1],
    ];
    for (const [x, y, sx, sy] of corners) {
      ctx.beginPath();
      ctx.moveTo(x + sx * 22, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + sy * 22);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ----------------------------- terrain ----------------------------- */

  function worldPath(points) {
    const P = points.map(([x, z]) => [X(x), Z(z)]);
    ctx.beginPath();
    ctx.moveTo(P[0][0], P[0][1]);
    if (P.length === 2) {
      ctx.lineTo(P[1][0], P[1][1]);
      return;
    }
    // Catmull–Rom to cubic Bézier: every joint now flows instead of kinking
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[i - 1] || P[i];
      const p1 = P[i];
      const p2 = P[i + 1];
      const p3 = P[i + 2] || P[i + 1];
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2[0], p2[1]);
    }
  }

  function fillPoly(points, fill, stroke = null, lineWidth = 2, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    points.forEach(([x, z], i) => {
      if (i === 0) ctx.moveTo(X(x), Z(z));
      else ctx.lineTo(X(x), Z(z));
    });
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Low-contrast district washes keep the hand-painted ground visible while
  // making the larger internal areas legible.  They are intentionally drawn
  // below roads and buildings so navigation and labels remain unobstructed.
  function drawSubareas() {
    const areas = [
      { name: "万岁山寺观区", color: "#b9c99a", points: [[42, 92], [300, 78], [390, 220], [318, 342], [128, 320], [36, 246]] },
      { name: "九龙水景区", color: "#92c4bd", points: [[26, 326], [228, 315], [322, 452], [286, 568], [128, 602], [34, 512]] },
      { name: "水浒区", color: "#9cbfca", points: [[272, 294], [578, 284], [696, 416], [646, 626], [418, 668], [286, 548], [240, 402]] },
      { name: "仙侠区", color: "#b4cba0", points: [[586, 92], [858, 92], [964, 222], [900, 382], [716, 408], [604, 296]] },
      { name: "江湖艺术区", color: "#d4b2a3", points: [[642, 400], [914, 374], [968, 628], [846, 690], [674, 666], [610, 548]] },
      { name: "森林亲子区", color: "#a9c89c", points: [[44, 510], [286, 492], [360, 690], [74, 704], [28, 620]] },
    ];
    for (const area of areas) {
      fillPoly(area.points, area.color, "rgba(73,94,66,0.28)", 1.4, 0.22);
      ctx.save();
      ctx.setLineDash([8, 7]);
      ctx.lineJoin = "round";
      ctx.beginPath();
      area.points.forEach(([x, z], i) => i ? ctx.lineTo(X(x), Z(z)) : ctx.moveTo(X(x), Z(z)));
      ctx.closePath();
      ctx.strokeStyle = "rgba(79,103,75,0.26)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
      const cx = area.points.reduce((sum, p) => sum + p[0], 0) / area.points.length;
      const cz = area.points.reduce((sum, p) => sum + p[1], 0) / area.points.length;
      ctx.save();
      ctx.fillStyle = "rgba(54,76,58,0.52)";
      ctx.font = `600 13px ${KAI}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(area.name, X(cx), Z(cz));
      ctx.restore();
    }
  }

  function drawSmallPond(x, z, rx, ry) {
    ctx.save();
    const g = ctx.createRadialGradient(X(x - rx * 0.2), Z(z - ry * 0.2), 4, X(x), Z(z), rx * S);
    g.addColorStop(0, "#9fcfc5");
    g.addColorStop(0.6, "#6ca5a0");
    g.addColorStop(1, "#4f8182");
    ctx.beginPath();
    ctx.ellipse(X(x), Z(z), rx * S, ry * S, -0.08, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = "rgba(74,102,77,0.5)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = "rgba(218,239,218,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(X(x - 2), Z(z - 1), rx * S * 0.65, ry * S * 0.42, -0.08, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function hill(cx, cz, rx, rz, color, rings = 4) {
    const hx = X(cx);
    const hy = Z(cz);
    const rw = rx * S;
    const rh = rz * S;
    let seed = Math.round(cx * 17 + cz * 31) >>> 0;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const points = [];
    const n = 18;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const wobble = 0.86 + rnd() * 0.18;
      points.push([hx + Math.cos(a) * rw * wobble, hy + Math.sin(a) * rh * wobble]);
    }
    // a low south-facing shoulder gives the hill a little 2.5D lift
    ctx.save();
    ctx.beginPath();
    ctx.moveTo((points[0][0] + points[n - 1][0]) / 2 + 7, (points[0][1] + points[n - 1][1]) / 2 + 13);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const q = points[(i + 1) % n];
      ctx.quadraticCurveTo(p[0] + 7, p[1] + 13, (p[0] + q[0]) / 2 + 7, (p[1] + q[1]) / 2 + 13);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(47,68,45,0.22)";
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.moveTo((points[0][0] + points[n - 1][0]) / 2, (points[0][1] + points[n - 1][1]) / 2);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const q = points[(i + 1) % n];
      ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    }
    ctx.closePath();
    ctx.clip();

    const wash = ctx.createLinearGradient(hx - rw, hy - rh, hx + rw, hy + rh);
    wash.addColorStop(0, shade(color, 0.1));
    wash.addColorStop(0.5, color);
    wash.addColorStop(1, shade(color, -0.13));
    ctx.fillStyle = wash;
    ctx.fillRect(hx - rw, hy - rh, rw * 2, rh * 2);

    // a fine woodland stipple: small trees, not big canopy blobs
    for (let i = 0; i < 240; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = Math.sqrt(rnd()) * 0.96;
      const x = hx + Math.cos(a) * rw * rr;
      const y = hy + Math.sin(a) * rh * rr;
      const s = 1.8 + rnd() * 4.2;
      ctx.globalAlpha = 0.3 + rnd() * 0.32;
      ctx.beginPath();
      ctx.ellipse(x + 1, y + 1.6, s * 1.4, s * 0.55, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(41,65,43,0.4)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y - s * 0.4, s, 0, Math.PI * 2);
      ctx.fillStyle = rnd() > 0.5 ? "#4c7350" : "#5b8557";
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // two quiet contour lines
    ctx.strokeStyle = "rgba(69,94,62,0.22)";
    ctx.lineWidth = 1.2;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath();
      ctx.ellipse(hx, hy, rw * (0.25 + i * 0.2), rh * (0.22 + i * 0.2), -0.14, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // rim
    ctx.save();
    ctx.beginPath();
    ctx.moveTo((points[0][0] + points[n - 1][0]) / 2, (points[0][1] + points[n - 1][1]) / 2);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const q = points[(i + 1) % n];
      ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    }
    ctx.closePath();
    ctx.strokeStyle = "rgba(58,82,55,0.25)";
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  }

  function shade(hex, amount) {
    const c = hex.replace("#", "");
    const n = parseInt(c, 16);
    let r = (n >> 16) & 255;
    let g = (n >> 8) & 255;
    let b = n & 255;
    r = Math.max(0, Math.min(255, Math.round(r + 255 * amount)));
    g = Math.max(0, Math.min(255, Math.round(g + 255 * amount)));
    b = Math.max(0, Math.min(255, Math.round(b + 255 * amount)));
    return `rgb(${r},${g},${b})`;
  }

  function drawTerrain() {
    ctx.save();
    roundRect(ctx, MAP.x, MAP.y, MAP.w, MAP.h, 10);
    ctx.clip();

    // muted sage ground, warm enough to read as painted paper
    const meadow = ctx.createLinearGradient(MAP.x, MAP.y, MAP.x + MAP.w, MAP.y + MAP.h);
    meadow.addColorStop(0, "#b7c49c");
    meadow.addColorStop(0.5, "#adbb8f");
    meadow.addColorStop(1, "#a0b083");
    ctx.fillStyle = meadow;
    ctx.fillRect(MAP.x, MAP.y, MAP.w, MAP.h);

    drawSubareas();
    drawSmallPond(108, 252, 38, 24);
    drawSmallPond(820, 155, 45, 22);

    // a soft green wash across the inhabited centre
    ctx.save();
    ctx.globalAlpha = 0.38;
    ctx.fillStyle = "#c1cc9f";
    ctx.beginPath();
    ctx.moveTo(X(350), Z(220));
    ctx.bezierCurveTo(X(470), Z(150), X(720), Z(210), X(760), Z(340));
    ctx.bezierCurveTo(X(790), Z(470), X(710), Z(650), X(530), Z(690));
    ctx.bezierCurveTo(X(400), Z(710), X(330), Z(580), X(330), Z(440));
    ctx.bezierCurveTo(X(320), Z(340), X(300), Z(280), X(350), Z(220));
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // flower meadows fill the quieter ground with soft colour, not plots
    drawMeadow(742, 596, 116, 54, -0.16, ["#d8b06b", "#c98f9f", "#e7c5c9", "#a9bb83"]);
    drawMeadow(386, 650, 82, 38, 0.08, ["#d9a8b3", "#f0c8ce", "#d8b06b", "#a9bb83"]);
    drawMeadow(676, 118, 78, 34, -0.12, ["#a9bb83", "#d8b06b", "#9cb071"]);

    // large forest floors
    fillPoly([[18, 410], [62, 692], [300, 716], [358, 590], [302, 454], [158, 398]], "#6f8c69", "rgba(75,102,66,0.28)", 2, 0.64);
    fillPoly([[600, 236], [910, 206], [956, 390], [782, 432], [610, 354]], "#668566", "rgba(75,102,66,0.22)", 2, 0.55);
    fillPoly([[62, 520], [302, 504], [324, 674], [78, 704]], "#93aa7a", "rgba(91,116,70,0.22)", 1.5, 0.45);

    // western high ground / temple hill
    hill(300, 172, 158, 120, "#62805b", 4);
    hill(215, 214, 112, 89, "#5d7957", 3);
    hill(142, 354, 110, 87, "#667f5c", 3);
    hill(105, 300, 86, 78, "#6c8160", 2);

    // eastern pine ridge
    hill(858, 258, 162, 104, "#5f7a58", 4);
    hill(900, 348, 108, 85, "#657f5e", 3);

    // terraced fields on the east slope
    ctx.save();
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.ellipse(X(830 + i * 3), Z(320 - i * 10), (150 - i * 12) * S, (28 - i * 2) * S, -0.18, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(122,113,73,${0.22 - i * 0.02})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();

    // tea terraces on the east ridge
    ctx.save();
    ctx.translate(X(858), Z(315));
    ctx.rotate(-0.15);
    for (let i = 0; i < 7; i++) {
      ctx.beginPath();
      ctx.ellipse(0, i * 14 - 35, (120 - i * 8) * S, (18 - i * 1.2) * S, 0, 0, Math.PI * 2);
      ctx.strokeStyle = i % 2 ? "rgba(155,143,91,0.35)" : "rgba(73,101,62,0.35)";
      ctx.lineWidth = 2;
      ctx.stroke();
      for (let k = 0; k < 18; k++) {
        const a = (k / 18) * Math.PI * 2;
        const rx = (120 - i * 8) * S;
        const ry = (18 - i * 1.2) * S;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * rx, i * 14 - 35 + Math.sin(a) * ry, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(64,101,66,0.55)";
        ctx.fill();
      }
    }
    ctx.restore();

    // distant orchard dots on the east hill
    for (let i = 0; i < 22; i++) {
      const x = 770 + Math.random() * 175;
      const z = 230 + Math.random() * 130;
      ctx.beginPath();
      ctx.arc(X(x), Z(z), 3 + Math.random() * 4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(54,87,54,0.35)";
      ctx.fill();
    }

    // south river
    const river = ctx.createLinearGradient(0, Z(710), 0, Z(760));
    river.addColorStop(0, "#5a8f91");
    river.addColorStop(0.55, "#6fa6a4");
    river.addColorStop(1, "#4d7f83");
    ctx.fillStyle = river;
    ctx.fillRect(MAP.x, Z(706), MAP.w, (MAP.y + MAP.h) - Z(706));

    // river ripple lines
    ctx.save();
    ctx.strokeStyle = "rgba(213,238,224,0.18)";
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 9; i++) {
      ctx.beginPath();
      const z = 716 + i * 4.6;
      for (let x = 0; x <= 1000; x += 28) {
        const y = Z(z + Math.sin(x * 0.035 + i) * 1.4);
        if (x === 0) ctx.moveTo(X(x), y);
        else ctx.lineTo(X(x), y);
      }
      ctx.stroke();
    }
    ctx.restore();

    // bank line
    ctx.strokeStyle = "rgba(116,118,82,0.55)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(MAP.x, Z(704));
    for (let x = 0; x <= 1000; x += 30) {
      ctx.lineTo(X(x), Z(704 + Math.sin(x * 0.03) * 2));
    }
    ctx.stroke();

    // reeds along the bank
    ctx.save();
    ctx.strokeStyle = "rgba(80,111,68,0.7)";
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 46; i++) {
      const x = 12 + Math.random() * 976;
      const y = Z(702 + Math.random() * 5);
      const h = 5 + Math.random() * 9;
      ctx.beginPath();
      ctx.moveTo(X(x), y);
      ctx.quadraticCurveTo(X(x) + 3, y - h * 0.55, X(x) + 1, y - h);
      ctx.stroke();
    }
    ctx.restore();

    // west pool and stream
    const poolCx = X(175);
    const poolCy = Z(403);
    const poolRx = 59 * S;
    const poolRy = 47 * S;
    const poolPoints = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const wobble = 0.9 + 0.1 * Math.sin(i * 2.3 + 0.7);
      poolPoints.push([poolCx + Math.cos(a) * poolRx * wobble, poolCy + Math.sin(a) * poolRy * wobble]);
    }
    function poolPath() {
      ctx.beginPath();
      const first = poolPoints[0];
      const last = poolPoints[poolPoints.length - 1];
      ctx.moveTo((first[0] + last[0]) / 2, (first[1] + last[1]) / 2);
      for (let i = 0; i < poolPoints.length; i++) {
        const p = poolPoints[i];
        const q = poolPoints[(i + 1) % poolPoints.length];
        ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      }
      ctx.closePath();
    }
    const pool = ctx.createRadialGradient(X(168), Z(396), 12, X(175), Z(403), 60 * S);
    pool.addColorStop(0, "#8cc7bf");
    pool.addColorStop(0.48, "#619895");
    pool.addColorStop(1, "#3f6c71");
    poolPath();
    ctx.fillStyle = pool;
    ctx.fill();
    // stone rim
    ctx.strokeStyle = "rgba(87,92,69,0.55)";
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.strokeStyle = "rgba(196,214,184,0.25)";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // deep reflection of the cliff on the northern water
    ctx.save();
    poolPath();
    ctx.clip();
    const reflect = ctx.createLinearGradient(poolCx, poolCy - poolRy, poolCx, poolCy + poolRy * 0.3);
    reflect.addColorStop(0, "rgba(27,60,57,0.38)");
    reflect.addColorStop(0.55, "rgba(39,83,76,0.14)");
    reflect.addColorStop(1, "rgba(39,83,76,0)");
    ctx.fillStyle = reflect;
    ctx.fillRect(poolCx - poolRx, poolCy - poolRy, poolRx * 2, poolRy * 1.3);
    ctx.restore();

    // lotus leaves and reed clumps at the pool edge
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.2;
      const px = X(175) + Math.cos(a) * (43 + Math.random() * 12) * S;
      const py = Z(403) + Math.sin(a) * (33 + Math.random() * 8) * S;
      ctx.beginPath();
      ctx.ellipse(px, py, 4.5, 2.2, a, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(79,118,70,0.6)";
      ctx.fill();
    }

    // stream to the river
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(82,130,131,0.85)";
    ctx.lineWidth = 16 * S;
    worldPath([[178, 447], [193, 518], [224, 592], [278, 655], [336, 705], [354, 720]]);
    ctx.stroke();
    ctx.strokeStyle = "rgba(178,221,208,0.35)";
    ctx.lineWidth = 2;
    worldPath([[178, 447], [193, 518], [224, 592], [278, 655], [336, 705], [354, 720]]);
    ctx.stroke();
    ctx.restore();

    // pond foam rings
    ctx.save();
    ctx.strokeStyle = "rgba(215,241,231,0.3)";
    ctx.lineWidth = 1.8;
    for (let i = 0; i < 2; i++) {
      const start = 0.45 + i * 1.05;
      ctx.beginPath();
      ctx.ellipse(X(175), Z(398), (15 + i * 11) * S, (7 + i * 5) * S, -0.1, start, start + 1.2);
      ctx.stroke();
    }
    ctx.restore();

    // meadow flowers and grass tufts
    for (let i = 0; i < 280; i++) {
      const x = Math.random() * 1000;
      const z = Math.random() * 760;
      ctx.fillStyle = `rgba(${70 + Math.random() * 30},${95 + Math.random() * 35},${60 + Math.random() * 25},0.22)`;
      ctx.fillRect(X(x), Z(z), 1.4, 1.4);
    }
    ctx.save();
    ctx.strokeStyle = "rgba(81,113,67,0.28)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 260; i++) {
      const x = Math.random() * 1000;
      const z = Math.random() * 720;
      const h = 3 + Math.random() * 7;
      ctx.beginPath();
      ctx.moveTo(X(x), Z(z));
      ctx.quadraticCurveTo(X(x) + 1, Z(z) - h * 0.5, X(x) + 2.5, Z(z) - h);
      ctx.stroke();
    }
    ctx.restore();

    drawForestStipple();

    // a soft clearing in the woods, with the forest loop road resting in it
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.ellipse(X(170), Z(584), 46 * S, 40 * S, -0.08, 0, Math.PI * 2);
    ctx.fillStyle = "#b9c99b";
    ctx.fill();
    ctx.strokeStyle = "rgba(87,110,69,0.24)";
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();

    // low mist gathering at the feet of the hills
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    for (const [x, z, rx, ry] of [[290, 292, 120, 24], [760, 420, 120, 22], [170, 456, 70, 18], [850, 210, 95, 16]]) {
      const mist = ctx.createRadialGradient(X(x), Z(z), 0, X(x), Z(z), rx * S);
      mist.addColorStop(0, "rgba(238,244,229,0.24)");
      mist.addColorStop(0.6, "rgba(238,244,229,0.1)");
      mist.addColorStop(1, "rgba(235,242,226,0)");
      ctx.fillStyle = mist;
      ctx.beginPath();
      ctx.ellipse(X(x), Z(z), rx * S, ry * S, -0.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.restore();
  }

  function drawMeadow(x, z, rx, rz, angle, colors) {
    ctx.save();
    ctx.translate(X(x), Z(z));
    ctx.rotate(angle);
    const rw = rx * S;
    const rh = rz * S;
    ctx.beginPath();
    ctx.ellipse(0, 0, rw, rh, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(166,185,132,0.55)";
    ctx.fill();
    ctx.strokeStyle = "rgba(84,108,68,0.22)";
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.clip();
    for (let i = 0; i < 170; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random());
      const px = Math.cos(a) * rw * r;
      const py = Math.sin(a) * rh * r;
      ctx.beginPath();
      ctx.arc(px, py, 1.2 + Math.random() * 2.8, 0, Math.PI * 2);
      ctx.fillStyle = colors[i % colors.length];
      ctx.globalAlpha = 0.55 + Math.random() * 0.3;
      ctx.fill();
    }
    ctx.restore();
  }

  function drawForestStipple() {
    let seed = 917;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const zones = [
      { x1: 40, x2: 360, z1: 380, z2: 700, weight: 0.33, pine: false },
      { x1: 150, x2: 430, z1: 75, z2: 300, weight: 0.2, pine: true },
      { x1: 590, x2: 960, z1: 185, z2: 440, weight: 0.35, pine: true },
      { x1: 55, x2: 330, z1: 490, z2: 710, weight: 0.12, pine: false },
    ];
    for (let i = 0; i < 880; i++) {
      let r = rnd();
      let zone = zones[0];
      for (const z of zones) {
        if (r < z.weight) { zone = z; break; }
        r -= z.weight;
      }
      const x = zone.x1 + rnd() * (zone.x2 - zone.x1);
      const z = zone.z1 + rnd() * (zone.z2 - zone.z1);
      const size = 2.2 + rnd() * 5.6;
      ctx.save();
      ctx.globalAlpha = 0.4 + rnd() * 0.35;
      ctx.beginPath();
      ctx.ellipse(X(x) + 1.8, Z(z) + 1.6, size * 1.45, size * 0.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(36,58,38,0.35)";
      ctx.fill();
      if (zone.pine) {
        ctx.beginPath();
        ctx.moveTo(X(x), Z(z) - size * 2.1);
        ctx.lineTo(X(x) - size * 1.1, Z(z) + size * 0.4);
        ctx.lineTo(X(x) + size * 1.1, Z(z) + size * 0.4);
        ctx.closePath();
        ctx.fillStyle = rnd() > 0.5 ? "#345a41" : "#436e4c";
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(X(x), Z(z) - size * 0.55, size * 1.2, 0, Math.PI * 2);
        ctx.fillStyle = rnd() > 0.5 ? "#4c7450" : "#608b59";
        ctx.fill();
        if (rnd() > 0.6) {
          ctx.beginPath();
          ctx.arc(X(x) - size * 0.5, Z(z) - size * 1.1, size * 0.65, 0, Math.PI * 2);
          ctx.fillStyle = "#71985f";
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  /* ----------------------------- roads / plazas ----------------------------- */

  function road(points, width, opts = {}) {
    roadQueue.push({ points, width, opts });
  }

  function roadMetrics(width, opts) {
    let type = opts.type;
    if (!type) type = width <= 8 ? "trail" : width <= 14 ? "path" : width >= 24 ? "promenade" : "path";
    return { type, w: width * S * (opts.wide ? 1.1 : 1) };
  }

  function flushRoads() {
    if (planningRoads) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Pass 1: shoulders and curbs only. No later shoulder can cut a road.
    for (const r of roadQueue) {
      const { type, w } = roadMetrics(r.width, r.opts);
      if (type === "trail") continue;
      if (type === "promenade") {
        worldPath(r.points);
        ctx.strokeStyle = "#ead7b2";
        ctx.lineWidth = w + 10;
        ctx.stroke();
        worldPath(r.points);
        ctx.strokeStyle = "#a57b45";
        ctx.lineWidth = w + 4.5;
        ctx.stroke();
      } else if (type === "service") {
        worldPath(r.points);
        ctx.strokeStyle = "#c9d2d4";
        ctx.lineWidth = w + 9;
        ctx.stroke();
        worldPath(r.points);
        ctx.strokeStyle = "#59676d";
        ctx.lineWidth = w + 4;
        ctx.stroke();
      } else {
        worldPath(r.points);
        ctx.strokeStyle = "#9a8563";
        ctx.lineWidth = w + 2.5;
        ctx.stroke();
      }
    }

    // Pass 2: service roads — narrow grey, no lane markings
    for (const r of roadQueue) {
      const { type, w } = roadMetrics(r.width, r.opts);
      if (type !== "service") continue;
      worldPath(r.points);
      ctx.strokeStyle = r.opts.fill ?? "#8b9ba2";
      ctx.lineWidth = w;
      ctx.stroke();
    }

    // Pass 3: secondary pedestrian paths, above service roads at crossings
    for (const r of roadQueue) {
      const { type, w } = roadMetrics(r.width, r.opts);
      if (type !== "path") continue;
      worldPath(r.points);
      ctx.strokeStyle = "#e0d8c4";
      ctx.lineWidth = w;
      ctx.stroke();
    }

    // Pass 4: main pedestrian promenade — warm stone, no lane marks
    for (const r of roadQueue) {
      const { type, w } = roadMetrics(r.width, r.opts);
      if (type !== "promenade") continue;
      worldPath(r.points);
      ctx.strokeStyle = "#d8b06a";
      ctx.lineWidth = w;
      ctx.stroke();
    }

    // Pass 5: junction discs in the colour of their dominant road type
    const junctionColors = {
      promenade: "#d8b06a",
      path: "#e0d8c4",
      service: "#8b9ba2",
    };
    const junctions = [
      [500, 690, 19, "promenade"], [500, 85, 16, "promenade"], [500, 565, 18, "promenade"],
      [380, 300, 16, "path"], [350, 470, 15, "promenade"], [462, 440, 12, "promenade"],
      [520, 455, 12, "path"], [632, 483, 10, "path"], [505, 405, 12, "path"],
      [690, 500, 20, "path"], [800, 650, 16, "service"], [710, 320, 14, "path"],
      [760, 190, 13, "path"], [240, 425, 10, "path"], [210, 565, 9, "path"],
    ];
    for (const [x, z, r, type] of junctions) {
      ctx.beginPath();
      ctx.ellipse(X(x), Z(z), r * S, r * S * 0.74, 0, 0, Math.PI * 2);
      ctx.fillStyle = junctionColors[type];
      ctx.fill();
      ctx.strokeStyle = "rgba(84,68,44,0.2)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  function roadClearance(x, z) {
    let best = Infinity;
    const all = [
      ...roadQueue.map((r) => ({ points: r.points, half: r.width / 2 })),
      ...trailQueue.map((points) => ({ points, half: 2 })),
    ];
    for (const line of all) {
      const pts = line.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const ax = pts[i][0];
        const az = pts[i][1];
        const bx = pts[i + 1][0];
        const bz = pts[i + 1][1];
        const vx = bx - ax;
        const vz = bz - az;
        const len2 = vx * vx + vz * vz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / len2));
        const dx = x - (ax + vx * t);
        const dz = z - (az + vz * t);
        best = Math.min(best, Math.hypot(dx, dz) - line.half);
      }
    }
    return best;
  }

  function roadName(text, x, z, angle, size = 15) {
    if (planningRoads) return;
    ctx.save();
    ctx.translate(X(x), Z(z));
    ctx.rotate(angle);
    ctx.font = `600 ${size}px ${KAI}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "rgba(248,241,226,0.7)";
    ctx.lineWidth = 3;
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = "rgba(91,72,46,0.78)";
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  function crosswalk(x, z, roadWidth, angle = 0) {
    if (planningRoads) return;
    ctx.save();
    ctx.translate(X(x), Z(z));
    ctx.rotate(angle);
    const w = roadWidth * S;
    ctx.fillStyle = "rgba(242,235,219,0.85)";
    for (let i = -4; i <= 4; i++) {
      ctx.fillRect(-w / 2 + 4, i * 8 - 2.5, w - 8, 4);
    }
    ctx.restore();
  }

  function plaza(x, z, r, opts = {}) {
    if (planningRoads) return;
    const cx = X(x);
    const cz = Z(z);
    const rx = r * S;
    const ry = r * S * 0.74;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx + 5, cz + 7, rx * 1.02, ry * 1.02, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(70,61,43,0.12)";
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx, cz, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = opts.fill ?? PAL.stone;
    ctx.fill();
    ctx.strokeStyle = "rgba(112,92,61,0.55)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = "rgba(135,111,76,0.55)";
    for (const k of [0.3, 0.62, 0.86]) {
      ctx.beginPath();
      ctx.ellipse(cx, cz, rx * k, ry * k, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // radial paving
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * rx * 0.32, cz + Math.sin(a) * ry * 0.32);
      ctx.lineTo(cx + Math.cos(a) * rx * 0.86, cz + Math.sin(a) * ry * 0.86);
      ctx.stroke();
    }
    ctx.restore();
  }

  function roundabout(x, z, r) {
    if (planningRoads) return;
    const cx = X(x);
    const cy = Z(z);
    const rx = r * S;
    const ry = rx * 0.72;
    ctx.save();
    // pedestrian apron
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx + 13, ry + 10, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#ead7b2";
    ctx.fill();
    // warm stone ring, no traffic lane markings
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.strokeStyle = "#d8b06a";
    ctx.lineWidth = 24;
    ctx.stroke();
    ctx.strokeStyle = "rgba(126,98,60,0.3)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx + 12, ry + 9.5, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx - 12, ry - 9.5, 0, 0, Math.PI * 2);
    ctx.stroke();
    // radial paving joints
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (rx - 11), cy + Math.sin(a) * (ry - 8));
      ctx.lineTo(cx + Math.cos(a) * (rx + 11), cy + Math.sin(a) * (ry + 8));
      ctx.strokeStyle = "rgba(126,98,60,0.18)";
      ctx.stroke();
    }
    // island
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx - 23, ry - 16, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#d8c6a4";
    ctx.fill();
    ctx.strokeStyle = "rgba(103,82,53,0.55)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function drawRoads() {
    // plazas first, roads travel through them
    plaza(500, 690, 58, { fill: "#e3d1ac" });
    plaza(500, 85, 42, { fill: "#e3d1ac" });
    plaza(500, 565, 52, { fill: "#dfcdaa" });
    plaza(500, 440, 78, { fill: "#e0cfae" });
    plaza(690, 500, 82, { fill: "#d7bd92" });
    plaza(380, 300, 31, { fill: "#e0cfae" });
    plaza(348, 468, 17, { fill: "#dfcdaa" });
    plaza(800, 650, 33, { fill: "#e0cfae" });
    plaza(710, 320, 26, { fill: "#e0cfae" });
    plaza(760, 190, 27, { fill: "#e0cfae" });
    plaza(320, 221, 27, { fill: "#dfd0ae" });

    // grand pedestrian promenade — gentle bends, narrower than a vehicle road
    road([[500, 700], [510, 655], [500, 600], [490, 550], [496, 505], [486, 478],
      [470, 462], [462, 440], [472, 420], [495, 400], [505, 370], [500, 330],
      [492, 280], [502, 220], [500, 160], [500, 85]], 18, { type: "promenade" });

    // western service road, passing under the temple platform
    road([[380, 300], [340, 285], [310, 260], [300, 230], [300, 190], [300, 150],
      [330, 128], [380, 108], [430, 95], [470, 88], [500, 85]], 12, { type: "service" });

    // market branch, ending at the martial-hall forecourt (not inside the hall)
    road([[486, 552], [455, 528], [410, 505], [370, 485], [355, 470], [350, 470]], 14, { type: "promenade" });
    road([[350, 470], [330, 465], [305, 458], [275, 445], [250, 432], [240, 425]], 9, { type: "path" });
    road([[350, 470], [370, 440], [368, 400], [350, 358], [368, 325], [380, 300]], 9, { type: "path" });
    // pedestrian approach to the temple gate
    road([[380, 300], [360, 265], [345, 240], [334, 228]], 8, { type: "path" });
    // direct walking links, so the route does not double back
    road([[462, 440], [430, 442], [400, 452], [375, 465], [350, 470]], 9, { type: "path" });
    road([[240, 425], [270, 390], [310, 345], [350, 315], [380, 300]], 8, { type: "path" });

    // east walking paths
    road([[520, 455], [552, 452], [600, 470], [632, 483]], 9, { type: "path" });
    // path stays outside the arena edge, then runs to the city wall
    road([[632, 483], [620, 505], [624, 530], [640, 550], [664, 564], [690, 564],
      [714, 556], [730, 560], [750, 590], [780, 620], [800, 650]], 8, { type: "path" });
    road([[505, 405], [542, 416], [588, 390], [632, 360], [675, 330], [710, 320]], 9, { type: "path" });
    road([[710, 320], [730, 285], [748, 246], [760, 218], [760, 190]], 8, { type: "path" });
    road([[760, 190], [728, 156], [668, 124], [600, 102], [548, 88], [500, 85]], 12, { type: "service" });

    // extensions for the detailed hand-map attractions.  These are walking
    // links, not vehicle lanes: they use the same light painted treatment as
    // the reference map and make every newly added district reachable.
    road([[500, 160], [458, 142], [414, 124], [360, 116], [306, 128], [252, 128], [205, 156], [160, 176], [82, 176]], 8, { type: "path" });
    road([[188, 214], [238, 218], [286, 252], [286, 292], [330, 304], [380, 300]], 8, { type: "path" });
    road([[414, 124], [500, 150], [555, 224], [620, 238], [690, 220], [733, 182]], 8, { type: "path" });
    road([[733, 182], [770, 208], [790, 224], [823, 276], [855, 278], [900, 288], [905, 246]], 8, { type: "path" });
    road([[632, 483], [676, 520], [716, 570], [680, 634], [612, 646], [570, 560]], 8, { type: "path" });
    road([[800, 650], [846, 626], [890, 590], [920, 520], [925, 430], [925, 246]], 8, { type: "path" });

    // south wall service road
    road([[500, 690], [560, 688], [625, 682], [690, 674], [745, 664], [800, 650]], 12, { type: "service" });
    // forest lane and loop
    road([[486, 552], [430, 565], [365, 575], [300, 570], [242, 567], [216, 565]], 9, { type: "path" });
    road([[210, 565], [200, 548], [180, 538], [158, 542], [142, 556], [132, 576],
      [136, 596], [130, 612], [144, 626], [164, 632], [184, 626], [200, 612],
      [208, 596], [205, 580], [210, 565]], 8, { type: "path", mark: false });
    // only the short garden trails remain light

    flushRoads();

    // the altar is a pedestrian stone ring, not a traffic roundabout
    roundabout(500, 440, 62);
    roadName("武侠大道", 500, 610, 0, 14);
    roadName("万岁山环线", 238, 252, -0.52, 11);
    roadName("松风径", 646, 365, -0.58, 12);
    roadName("九龙步道", 268, 424, -0.34, 11);
    roadName("南门街", 536, 674, 0.08, 11);
    roadName("北境步道", 410, 142, 0.12, 10);
    roadName("仙侠水街", 676, 218, -0.22, 10);
    roadName("江湖艺巷", 760, 570, -0.62, 10);

    // hill paths are intentionally lighter than the main road network,
    // and each one now physically joins a larger path at both ends
    drawTrail([[258, 284], [242, 300], [226, 320], [212, 345], [204, 370],
      [196, 395], [184, 418], [176, 442], [180, 468], [184, 495], [182, 518], [180, 538]]);
    roadName("后山小径", 218, 340, -1.02, 10);
    drawTrail([[760, 218], [760, 242], [790, 265], [815, 288], [838, 314], [862, 338], [888, 352], [914, 356]]);
    drawTrail([[158, 542], [150, 518], [120, 532], [100, 558], [90, 598], [105, 630]]);
  }

  /* ----------------------------- 2.5D architecture ----------------------------- */

  const ROOF_TONES = {
    "#4f7b70": "#465955", "#5b8675": "#52645f", "#4b776e": "#425652",
    "#50796f": "#4a5e59", "#416c64": "#3f5350", "#426d64": "#425652",
    "#4a7268": "#455a55", "#4d776b": "#495d58", "#4f7c71": "#4a5e59",
    "#3f6864": "#3f5350", "#3a625f": "#3b4f4c", "#3f6661": "#3f5350",
    "#4d7567": "#495d58", "#4a7569": "#465c57", "#416b66": "#405450",
  };

  function drawRoof(cx, cy, bw, bd, rise, color, opts = {}) {
    color = ROOF_TONES[color] || color;
    const ow = bw * (opts.overhang ?? 1.08);
    const od = bd * (opts.overhang ?? 1.1);
    const rr = Math.min(Math.max(8, bw * 0.095), rise ?? bw * 0.11);
    const rw = ow * 0.48;
    const fl = -ow / 2;
    const fr = ow / 2;
    const front = od / 2;
    const back = -od / 2;
    const ridge = -rr;
    ctx.save();
    ctx.translate(cx, cy);

    // under-eave shadow
    ctx.beginPath();
    ctx.ellipse(0, od * 0.18, ow * 0.5, od * 0.26, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(43,37,27,0.15)";
    ctx.fill();

    // back slope
    ctx.beginPath();
    ctx.moveTo(fl, back);
    ctx.lineTo(fr, back);
    ctx.lineTo(rw / 2, ridge);
    ctx.lineTo(-rw / 2, ridge);
    ctx.closePath();
    ctx.fillStyle = shade(color, -0.25);
    ctx.fill();

    // side hips
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * ow / 2, back);
      ctx.lineTo(s * ow / 2, front);
      ctx.lineTo(s * rw / 2, ridge);
      ctx.closePath();
      ctx.fillStyle = shade(color, -0.13);
      ctx.fill();
    }

    // front slope — eaves lift at the corners
    ctx.beginPath();
    ctx.moveTo(fl, front - 3);
    ctx.quadraticCurveTo(0, front + 7, fr, front - 3);
    ctx.lineTo(rw / 2, ridge);
    ctx.lineTo(-rw / 2, ridge);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, ridge, 0, front);
    grad.addColorStop(0, shade(color, 0.12));
    grad.addColorStop(0.55, color);
    grad.addColorStop(1, shade(color, -0.14));
    ctx.fillStyle = grad;
    ctx.fill();

    // tile ribs — darker on the ochre temple roofs so the tiles stay readable
    const isOchre = color === "#c99a4e" || color === "#b98b46" || color === "#c4964f";
    ctx.save();
    ctx.strokeStyle = isOchre ? "rgba(88,61,27,0.3)" : "rgba(237,219,181,0.2)";
    ctx.lineWidth = 1;
    for (let i = -5; i <= 5; i++) {
      const u = i / 6;
      ctx.beginPath();
      ctx.moveTo(u * rw, ridge);
      ctx.quadraticCurveTo(u * ow * 0.34, front * 0.3, u * ow * 0.42, front * 0.98);
      ctx.stroke();
    }
    ctx.restore();

    // hip lines
    ctx.strokeStyle = "rgba(210,190,147,0.2)";
    ctx.lineWidth = 1;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * rw / 2, ridge);
      ctx.lineTo(s * ow / 2, back);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s * rw / 2, ridge);
      ctx.lineTo(s * ow / 2, front);
      ctx.stroke();
    }

    // eave outline (a clear rectangle, with turned-up corner ears)
    ctx.beginPath();
    ctx.moveTo(fl, front - 3);
    ctx.quadraticCurveTo(0, front + 7, fr, front - 3);
    ctx.lineTo(fr, back);
    ctx.lineTo(fl, back);
    ctx.closePath();
    ctx.strokeStyle = "rgba(38,45,37,0.65)";
    ctx.lineWidth = 1.7;
    ctx.stroke();

    // ridge
    ctx.beginPath();
    ctx.moveTo(-rw / 2, ridge);
    ctx.lineTo(rw / 2, ridge);
    ctx.strokeStyle = "rgba(241,211,153,0.9)";
    ctx.lineWidth = 2.4;
    ctx.stroke();

    // upturned eave tips
    ctx.strokeStyle = "rgba(49,46,34,0.82)";
    ctx.lineWidth = 2.4;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * ow / 2, front);
      ctx.quadraticCurveTo(s * (ow / 2 + 5), front - 3, s * (ow / 2 + 11), front - 10);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(s * (ow / 2 + 11), front - 10, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = PAL.gold;
      ctx.fill();
    }
    // ridge finials
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * rw / 2, ridge, 3, 0, Math.PI * 2);
      ctx.fillStyle = PAL.goldLight;
      ctx.fill();
    }
    ctx.restore();
  }

  function drawHall(o) {
    const cx = X(o.x);
    const cy = Z(o.z) - (o.lift ?? 0);
    const bw = o.w * S;
    const bd = o.d * S;
    const h = o.h ?? 18;
    const hx = HX(h);
    const hy = HY(h);
    const wall = o.wall ?? PAL.red;
    const roof = o.roof ?? "#4f7b70";
    const rise = o.rise ? o.rise * S : bw * 0.12;

    ctx.save();
    ctx.translate(cx, cy);

    // shadow
    ctx.beginPath();
    ctx.ellipse(9, 12, bw * 0.68, bd * 0.47, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(48,40,27,0.22)";
    ctx.fill();

    const baseFront = bd / 2;
    const topFront = baseFront - hy;
    const left = -bw / 2;
    const right = bw / 2;

    // side wall
    ctx.beginPath();
    ctx.moveTo(right, baseFront);
    ctx.lineTo(right + hx, topFront);
    ctx.lineTo(right + hx, topFront - bd * 0.85);
    ctx.lineTo(right, baseFront - bd * 0.85);
    ctx.closePath();
    ctx.fillStyle = shade(wall, -0.18);
    ctx.fill();
    ctx.strokeStyle = "rgba(68,45,31,0.35)";
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // front wall
    const wg = ctx.createLinearGradient(0, topFront, 0, baseFront);
    wg.addColorStop(0, shade(wall, 0.06));
    wg.addColorStop(1, shade(wall, -0.12));
    ctx.beginPath();
    ctx.moveTo(left, baseFront);
    ctx.lineTo(right, baseFront);
    ctx.lineTo(right + hx, topFront);
    ctx.lineTo(left + hx, topFront);
    ctx.closePath();
    ctx.fillStyle = wg;
    ctx.fill();
    ctx.strokeStyle = "rgba(61,39,28,0.55)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // stone plinth
    ctx.beginPath();
    ctx.moveTo(left - 2, baseFront);
    ctx.lineTo(right + 2, baseFront);
    ctx.lineTo(right + 4, baseFront + 5);
    ctx.lineTo(left - 4, baseFront + 5);
    ctx.closePath();
    ctx.fillStyle = "#8b7a5d";
    ctx.fill();

    // columns / door / windows
    const frontH = baseFront - topFront;
    ctx.save();
    ctx.strokeStyle = "rgba(88,43,33,0.8)";
    ctx.lineWidth = 2.4;
    for (let i = 0; i < (o.columns ?? 4); i++) {
      const px = left + hx * 0.5 + (i / ((o.columns ?? 4) - 1)) * (bw - hx);
      ctx.beginPath();
      ctx.moveTo(px, baseFront - 2);
      ctx.lineTo(px + hx * 0.5, topFront + 2);
      ctx.stroke();
    }
    const doorW = Math.min(bw * 0.19, 28);
    ctx.fillStyle = "rgba(46,31,23,0.82)";
    ctx.fillRect(-doorW / 2 + hx * 0.35, baseFront - frontH * 0.56, doorW, frontH * 0.54);
    ctx.strokeStyle = "rgba(227,193,133,0.5)";
    ctx.strokeRect(-doorW / 2 + hx * 0.35, baseFront - frontH * 0.56, doorW, frontH * 0.54);
    for (let i = 0; i < 2; i++) {
      const wx = (i ? 1 : -1) * bw * 0.28 + hx * 0.4;
      const wy = baseFront - frontH * 0.52;
      ctx.fillStyle = "rgba(38,46,38,0.76)";
      ctx.fillRect(wx - 9, wy, 18, 14);
      ctx.strokeStyle = "rgba(227,193,133,0.48)";
      ctx.strokeRect(wx - 9, wy, 18, 14);
    }
    ctx.restore();

    // gold plaque
    ctx.fillStyle = PAL.gold;
    ctx.fillRect(-12 + hx * 0.35, topFront + 3, 24, 7);

    // roof — centred on the lifted top face, not on its front edge
    drawRoof(hx, -hy, bw, bd, rise, roof, { overhang: 1.18 });

    if (o.doubleRoof) {
      // a smaller upper roof and clerestory, for the principal halls
      ctx.fillStyle = shade(wall, -0.06);
      ctx.fillRect(-bw * 0.26 + hx * 1.35, -hy - 13, bw * 0.52, 13);
      ctx.strokeStyle = "rgba(69,44,31,0.45)";
      ctx.strokeRect(-bw * 0.26 + hx * 1.35, -hy - 13, bw * 0.52, 13);
      drawRoof(hx * 1.45, -hy - 13, bw * 0.58, bd * 0.6, rise * 0.65, roof, { overhang: 1.12 });
    }

    // lanterns
    if (o.lanterns !== false) {
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(s * bw * 0.31 + hx, topFront + 8, 4.2, 0, Math.PI * 2);
        ctx.fillStyle = "#b64732";
        ctx.fill();
        ctx.strokeStyle = "rgba(101,40,28,0.6)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawGate(o) {
    const cx = X(o.x);
    const cy = Z(o.z);
    const bw = o.w * S;
    const bd = o.d * S;
    const h = (o.baseH ?? 12) + (o.bodyH ?? 12);
    const hx = HX(h);
    const hy = HY(h);
    const wall = o.wall ?? PAL.red;
    const roof = o.roof ?? "#3a625f";

    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.ellipse(9, 12, bw * 0.74, bd * 0.6, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(48,40,27,0.22)";
    ctx.fill();

    // base gate wall
    const baseFront = bd / 2;
    const wallTop = baseFront - hy;
    const left = -bw / 2;
    const right = bw / 2;
    ctx.beginPath();
    ctx.moveTo(left, baseFront);
    ctx.lineTo(right, baseFront);
    ctx.lineTo(right + hx, wallTop);
    ctx.lineTo(left + hx, wallTop);
    ctx.closePath();
    ctx.fillStyle = "#cbb995";
    ctx.fill();
    ctx.strokeStyle = "rgba(67,50,34,0.6)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // arched entrance
    const archW = bw * 0.31;
    const archH = (baseFront - wallTop) * 0.68;
    ctx.beginPath();
    ctx.moveTo(-archW / 2 + hx * 0.45, baseFront - 2);
    ctx.lineTo(-archW / 2 + hx * 0.45, baseFront - archH * 0.55);
    ctx.quadraticCurveTo(0 + hx * 0.45, baseFront - archH * 1.15, archW / 2 + hx * 0.45, baseFront - archH * 0.55);
    ctx.lineTo(archW / 2 + hx * 0.45, baseFront - 2);
    ctx.closePath();
    ctx.fillStyle = "rgba(37,29,22,0.86)";
    ctx.fill();

    // upper storey
    const upperH = 24;
    const lowerTop = wallTop;
    const upTop = lowerTop - upperH;
    ctx.beginPath();
    ctx.moveTo(left + hx * 0.7, lowerTop);
    ctx.lineTo(right + hx * 0.7, lowerTop);
    ctx.lineTo(right + hx * 1.2, upTop);
    ctx.lineTo(left + hx * 1.2, upTop);
    ctx.closePath();
    ctx.fillStyle = wall;
    ctx.fill();
    ctx.strokeStyle = "rgba(65,38,29,0.6)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // windows on upper storey
    ctx.fillStyle = "rgba(38,45,38,0.7)";
    for (let i = 0; i < 3; i++) {
      const wx = -bw * 0.22 + i * bw * 0.22 + hx;
      ctx.fillRect(wx - 8, upTop + 7, 16, 11);
      ctx.strokeStyle = "rgba(227,196,137,0.55)";
      ctx.strokeRect(wx - 8, upTop + 7, 16, 11);
    }
    ctx.fillStyle = PAL.gold;
    ctx.fillRect(-13 + hx, upTop + 2, 26, 6);

    drawRoof(hx * 1.1, upTop - 2, bw * 1.03, bd * 0.92, bw * 0.1, roof, { overhang: 1.2 });

    // lanterns
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * bw * 0.31 + hx, lowerTop + 8, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#b64732";
      ctx.fill();
      ctx.strokeStyle = "rgba(239,203,137,0.75)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPavilion(x, z, scale = 1, roof = "#4d7567") {
    const cx = X(x);
    const cy = Z(z);
    const bw = 24 * S * scale;
    const bd = 18 * S * scale;
    const h = 13 * scale;
    const hx = HX(h);
    const hy = HY(h);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.ellipse(4, 6, bw * 0.55, bd * 0.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(60,50,34,0.12)";
    ctx.fill();
    ctx.fillStyle = "#b9a884";
    ctx.beginPath();
    ctx.ellipse(0, 0, bw * 0.6, bd * 0.56, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(91,68,43,0.45)";
    ctx.stroke();
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(sx * bw * 0.32, sz * bd * 0.25);
        ctx.lineTo(sx * bw * 0.32 + hx, sz * bd * 0.25 - hy);
        ctx.strokeStyle = "#7c3f2d";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }
    drawRoof(hx, -hy - bd * 0.02, bw, bd, bw * 0.12, roof, { overhang: 1.22 });
    ctx.restore();
  }

  function drawPagoda(x, z, tiers = 3, lift = 0, roofColor = "#426d64") {
    const cx = X(x);
    const cy = Z(z) - lift;
    let baseY = 0;
    const hx = HX(8);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.ellipse(5, 8, 40, 18, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(57,49,35,0.16)";
    ctx.fill();
    for (let i = 0; i < tiers; i++) {
      const bw = (38 - i * 8) * S;
      const bd = (27 - i * 5) * S;
      const h = 12;
      const hy = HY(h);
      const hx2 = HX(h);
      ctx.fillStyle = i % 2 ? "#a64b37" : "#b75a41";
      ctx.fillRect(-bw / 2 + hx2, baseY - hy, bw, hy);
      ctx.strokeStyle = "rgba(74,43,30,0.55)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-bw / 2 + hx2, baseY - hy, bw, hy);
      drawRoof(hx2, baseY - hy, bw, bd, bw * 0.12, roofColor, { overhang: 1.25 });
      baseY -= hy + 8;
    }
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    ctx.lineTo(0, baseY - 24);
    ctx.strokeStyle = PAL.gold;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, baseY - 25, 4, 0, Math.PI * 2);
    ctx.fillStyle = PAL.goldLight;
    ctx.fill();
    ctx.restore();
  }

  function drawStall(x, z, color = "#a34d3c", rot = 0) {
    const cx = X(x);
    const cy = Z(z);
    const bw = 17 * S;
    const bd = 12 * S;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.ellipse(4, 5, bw * 0.6, bd * 0.55, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(60,51,35,0.14)";
    ctx.fill();
    // counter
    ctx.fillStyle = "#8d6747";
    ctx.fillRect(-bw / 2, -bd * 0.12, bw, bd * 0.35);
    // posts
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * bw * 0.4, 0);
      ctx.lineTo(s * bw * 0.4, -HY(8));
      ctx.strokeStyle = "#5c3f2e";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    // striped awning
    ctx.save();
    ctx.translate(0, -HY(8));
    ctx.beginPath();
    ctx.moveTo(-bw * 0.55, 0);
    ctx.lineTo(bw * 0.55, 0);
    ctx.lineTo(bw * 0.45, -bd * 0.35);
    ctx.lineTo(-bw * 0.45, -bd * 0.35);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "rgba(70,43,31,0.4)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 0.65;
    ctx.fillStyle = "#f0ddbf";
    for (let i = 0; i < 5; i += 2) {
      ctx.beginPath();
      ctx.moveTo(-bw * 0.55 + i * bw * 0.22, 0);
      ctx.lineTo(-bw * 0.45 + i * bw * 0.22, -bd * 0.35);
      ctx.lineTo(-bw * 0.34 + i * bw * 0.22, -bd * 0.35);
      ctx.lineTo(-bw * 0.44 + i * bw * 0.22, 0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // goods
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(-bw * 0.25 + i * bw * 0.25, -bd * 0.02, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = i === 1 ? PAL.gold : "#7e563c";
      ctx.fill();
    }
    ctx.restore();
  }

  function drawArena(x, z) {
    const cx = X(x);
    const cy = Z(z);
    const r = 58 * S;
    ctx.save();
    ctx.translate(cx, cy);
    // soft shadow
    ctx.beginPath();
    ctx.ellipse(8, 10, r * 1.05, r * 0.62, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(67,57,40,0.13)";
    ctx.fill();
    // sand
    const grad = ctx.createRadialGradient(-r * 0.2, -r * 0.2, 10, 0, 0, r);
    grad.addColorStop(0, "#ead4a5");
    grad.addColorStop(1, "#cbb17e");
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.64, 0, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    // tiered timber stands on the southern half
    for (let i = 0; i < 3; i++) {
      const rr = r * (1.04 + i * 0.1);
      ctx.beginPath();
      ctx.ellipse(0, 0, rr, rr * 0.64, 0, 0.08, Math.PI - 0.08);
      ctx.strokeStyle = i === 0 ? "#7b593d" : i === 1 ? "#8d6848" : "#9c7652";
      ctx.lineWidth = 17;
      ctx.stroke();
      // plank lines
      ctx.save();
      ctx.strokeStyle = "rgba(238,207,152,0.28)";
      ctx.lineWidth = 1;
      for (let k = 0; k < 16; k++) {
        const a = 0.12 + (k / 15) * (Math.PI - 0.24);
        const x1 = Math.cos(a) * (rr - 8);
        const y1 = Math.sin(a) * (rr - 8) * 0.64;
        const x2 = Math.cos(a) * (rr + 8);
        const y2 = Math.sin(a) * (rr + 8) * 0.64;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.restore();
      // spectators
      for (let k = 0; k < 12; k++) {
        const a = 0.15 + (k / 11) * (Math.PI - 0.3);
        const rr2 = rr + (k % 2 ? -3 : 3);
        const px = Math.cos(a) * rr2;
        const py = Math.sin(a) * rr2 * 0.64 - 8;
        ctx.beginPath();
        ctx.arc(px, py, 2.4, 0, Math.PI * 2);
        ctx.fillStyle = k % 3 === 0 ? "#3f6b63" : k % 3 === 1 ? "#9d4032" : "#d5b47a";
        ctx.fill();
      }
    }
    // inner stage
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.36, r * 0.24, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#d1b57d";
    ctx.fill();
    ctx.strokeStyle = "rgba(112,82,49,0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();
    // red carpet / drum platform
    ctx.fillStyle = "rgba(156,61,44,0.8)";
    ctx.fillRect(-18, -10, 36, 13);
    ctx.fillStyle = "#6a432b";
    ctx.beginPath();
    ctx.ellipse(-0, -13, 9, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(226,190,124,0.7)";
    ctx.stroke();
    // flags around the rim
    for (let i = 0; i < 9; i++) {
      const a = -0.15 + (i / 8) * (Math.PI + 0.3);
      const px = Math.cos(a) * r * 1.24;
      const py = Math.sin(a) * r * 0.64 * 1.24;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px, py - 25);
      ctx.strokeStyle = "#5d3d2b";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px, py - 25);
      ctx.lineTo(px + 11, py - 21);
      ctx.lineTo(px, py - 17);
      ctx.closePath();
      ctx.fillStyle = i % 2 ? PAL.red : PAL.gold;
      ctx.fill();
    }
    ctx.restore();
  }

  function drawAltar(x, z) {
    const cx = X(x);
    const cy = Z(z);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.ellipse(6, 8, 42 * S, 21 * S, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(55,47,34,0.14)";
    ctx.fill();
    const tiers = [
      [36, 22, "#cdbb97"], [29, 17, "#ddcaaa"], [22, 13, "#ebd8b8"],
    ];
    for (const [r, ry, color] of tiers) {
      ctx.beginPath();
      ctx.ellipse(0, 0, r * S, ry * S, 0, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "rgba(112,87,56,0.42)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    // central bronze cauldron + dragon pillar
    ctx.beginPath();
    ctx.ellipse(0, -5, 15, 8, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#74603b";
    ctx.fill();
    ctx.fillRect(-12, -20, 24, 16);
    ctx.strokeStyle = PAL.gold;
    ctx.lineWidth = 2;
    ctx.strokeRect(-12, -20, 24, 16);
    // four pillars
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const px = Math.cos(a) * 27 * S;
      const py = Math.sin(a) * 15.5 * S;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px, py - 42);
      ctx.strokeStyle = "#74342a";
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py - 44, 4, 0, Math.PI * 2);
      ctx.fillStyle = PAL.gold;
      ctx.fill();
      // small banner
      ctx.beginPath();
      ctx.moveTo(px, py - 36);
      ctx.lineTo(px + 8, py - 33);
      ctx.lineTo(px, py - 28);
      ctx.closePath();
      ctx.fillStyle = "rgba(169,67,50,0.8)";
      ctx.fill();
    }
    // tall central pole
    ctx.beginPath();
    ctx.moveTo(0, -20);
    ctx.lineTo(0, -82);
    ctx.strokeStyle = "#74342a";
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -84, 5, 0, Math.PI * 2);
    ctx.fillStyle = PAL.goldLight;
    ctx.fill();
    ctx.restore();
  }

  function drawWallSegment(x1, z1, x2, z2, h = 18, color = "#d3c19d") {
    const ax = X(x1);
    const ay = Z(z1);
    const bx = X(x2);
    const by = Z(z2);
    const hy = HY(h);
    const hx = HX(h);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.strokeStyle = "rgba(61,50,34,0.16)";
    ctx.lineWidth = 18;
    ctx.stroke();
    // front face
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx + hx, by - hy);
    ctx.lineTo(ax + hx, ay - hy);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "rgba(91,70,43,0.55)";
    ctx.lineWidth = 2;
    ctx.stroke();
    // top walk
    ctx.beginPath();
    ctx.moveTo(ax + hx, ay - hy);
    ctx.lineTo(bx + hx, by - hy);
    ctx.lineTo(bx + hx + 3, by - hy - 7);
    ctx.lineTo(ax + hx + 3, ay - hy - 7);
    ctx.closePath();
    ctx.fillStyle = shade(color, 0.12);
    ctx.fill();
    // crenellations
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(2, Math.floor(len / 26));
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    for (let i = 0; i < n; i++) {
      const px = ax + ux * ((i + 0.5) / n) * len + hx;
      const py = ay + uy * ((i + 0.5) / n) * len - hy;
      ctx.fillStyle = shade(color, 0.08);
      ctx.fillRect(px - 6, py - 13, 12, 9);
      ctx.strokeStyle = "rgba(90,69,44,0.35)";
      ctx.strokeRect(px - 6, py - 13, 12, 9);
    }
    // stone joints
    ctx.strokeStyle = "rgba(108,86,55,0.2)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const t = i / 4;
      ctx.beginPath();
      ctx.moveTo(ax + (bx - ax) * t, ay + (by - ay) * t);
      ctx.lineTo(ax + (bx - ax) * t + hx, ay + (by - ay) * t - hy);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawWatchtower(x, z) {
    const cx = X(x);
    const cy = Z(z);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.ellipse(5, 8, 42, 26, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(58,49,34,0.16)";
    ctx.fill();
    // platform
    ctx.fillStyle = "#c8b592";
    ctx.fillRect(-54, -22, 108, 22);
    ctx.strokeStyle = "rgba(91,70,43,0.55)";
    ctx.strokeRect(-54, -22, 108, 22);
    // tower body
    const h = 48;
    const hy = HY(h);
    ctx.fillStyle = PAL.red;
    ctx.fillRect(-32, -22 - hy, 64, hy);
    ctx.strokeStyle = "rgba(67,40,30,0.6)";
    ctx.strokeRect(-32, -22 - hy, 64, hy);
    // windows
    ctx.fillStyle = "rgba(38,45,38,0.72)";
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(-18 + i * 18, -22 - hy + 13, 11, 12);
    }
    // roof
    drawRoof(0, -22 - hy, 72, 38, 18, "#3a625e", { overhang: 1.2 });
    ctx.restore();
  }

  function drawTree(x, z, size, tone = "broad") {
    const cx = X(x);
    const cy = Z(z);
    const h = size * 0.8;
    const hx = HX(h);
    const hy = HY(h);
    const scale = size / 24;
    ctx.save();
    ctx.translate(cx, cy);
    // shadow
    ctx.beginPath();
    ctx.ellipse(5, 4, size * 0.5 * S, size * 0.22 * S, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(50,68,45,0.15)";
    ctx.fill();
    // trunk
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(hx * 0.6, -hy * 0.55);
    ctx.strokeStyle = "#6e5037";
    ctx.lineWidth = 2.5 * scale;
    ctx.stroke();
    const colors = tone === "pine"
      ? ["#3e6247", "#4b7354", "#2f4f38"]
      : tone === "peach"
        ? ["#d193a2", "#e4adb7", "#c37f91", "#f0c6ce"]
        : ["#517953", "#638f5e", "#3e6547", "#7ca16b"];
    if (tone === "pine") {
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(hx * 0.6, -hy * 0.42 - i * hy * 0.22);
        ctx.lineTo(hx * 0.6 - size * 0.22 * S + i * size * 0.04 * S, -hy * 0.55 - i * hy * 0.22);
        ctx.lineTo(hx * 0.6 + size * 0.22 * S - i * size * 0.04 * S, -hy * 0.55 - i * hy * 0.22);
        ctx.closePath();
        ctx.fillStyle = colors[i];
        ctx.fill();
      }
    } else {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + 0.4;
        ctx.beginPath();
        ctx.ellipse(
          hx * 0.6 + Math.cos(a) * size * 0.19 * S,
          -hy * 0.58 + Math.sin(a) * size * 0.13 * S,
          size * 0.35 * S,
          size * 0.27 * S,
          a,
          0,
          Math.PI * 2
        );
        ctx.fillStyle = colors[i % colors.length];
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(hx * 0.6, -hy * 0.74, size * 0.26 * S, 0, Math.PI * 2);
      ctx.fillStyle = colors[1];
      ctx.fill();
    }
    ctx.restore();
  }

  function drawPerson(x, z, color = "#9d4032") {
    const cx = X(x);
    const cy = Z(z);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1.25, 1.25);
    ctx.beginPath();
    ctx.ellipse(2, 2, 4, 2, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(55,45,31,0.18)";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-2, 0);
    ctx.lineTo(2, 0);
    ctx.lineTo(1.4, -9);
    ctx.lineTo(-1.4, -9);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, -11, 2.1, 0, Math.PI * 2);
    ctx.fillStyle = "#c49b75";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, -12.2, 3, Math.PI, Math.PI * 2);
    ctx.fillStyle = "#3a332b";
    ctx.fill();
    ctx.restore();
  }

  function drawFlag(x, z, color = PAL.red, h = 28) {
    const cx = X(x);
    const cy = Z(z);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -h * S * 0.8);
    ctx.strokeStyle = "#5e402c";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -h * S * 0.8);
    ctx.quadraticCurveTo(13, -h * S * 0.8 + 3, 23, -h * S * 0.8 + 1);
    ctx.lineTo(19, -h * S * 0.8 + 15);
    ctx.quadraticCurveTo(9, -h * S * 0.8 + 16, 0, -h * S * 0.8 + 11);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  function drawLanternString(x1, z1, x2, z2, count = 7) {
    const ax = X(x1), ay = Z(z1) - 38;
    const bx = X(x2), by = Z(z2) - 38;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo((ax + bx) / 2, Math.min(ay, by) + 18, bx, by);
    ctx.strokeStyle = "rgba(76,57,39,0.6)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    for (let i = 1; i < count; i++) {
      const t = i / count;
      const x = (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * ((ax + bx) / 2) + t * t * bx;
      const y = (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * (Math.min(ay, by) + 18) + t * t * by;
      ctx.beginPath();
      ctx.arc(x, y + 6, 4.4, 0, Math.PI * 2);
      ctx.fillStyle = "#b94734";
      ctx.fill();
      ctx.strokeStyle = "rgba(242,196,125,0.5)";
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawGardenWall(x1, z1, x2, z2, color = "#cdbb98") {
    const ax = X(x1);
    const ay = Z(z1);
    const bx = X(x2);
    const by = Z(z2);
    const hy = HY(4.6);
    const hx = HX(4.6);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx + hx, by - hy);
    ctx.lineTo(ax + hx, ay - hy);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "rgba(103,80,49,0.42)";
    ctx.lineWidth = 1;
    ctx.stroke();
    // tile cap
    ctx.beginPath();
    ctx.moveTo(ax + hx, ay - hy);
    ctx.lineTo(bx + hx, by - hy);
    ctx.strokeStyle = "#57766b";
    ctx.lineWidth = 3.2;
    ctx.stroke();
    ctx.strokeStyle = "rgba(226,199,145,0.4)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  function drawTrail(points) {
    trailQueue.push(points);
    if (planningRoads) return;
    ctx.save();
    ctx.setLineDash([6, 9]);
    ctx.strokeStyle = "rgba(246,239,220,0.6)";
    ctx.lineWidth = 3.2;
    worldPath(points);
    ctx.stroke();
    ctx.setLineDash([4, 8]);
    ctx.strokeStyle = "#b0a35f";
    ctx.lineWidth = 1.6;
    worldPath(points);
    ctx.stroke();
    ctx.restore();
  }

  function drawBridge(x, z, len, width, angle = 0) {
    const cx = X(x);
    const cy = Z(z);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.rotate(-0.1);
    ctx.fillStyle = "#9a724d";
    ctx.beginPath();
    ctx.moveTo(-len / 2, 0);
    ctx.quadraticCurveTo(0, -14, len / 2, 0);
    ctx.lineTo(len / 2, 9);
    ctx.quadraticCurveTo(0, -3, -len / 2, 9);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(79,55,35,0.55)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    for (let i = 0; i < 7; i++) {
      const px = -len / 2 + (i / 6) * len;
      ctx.beginPath();
      ctx.moveTo(px, -2);
      ctx.lineTo(px, 7);
      ctx.strokeStyle = "rgba(229,198,143,0.35)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // railings
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-len / 2, s * width * 0.4);
      ctx.lineTo(len / 2, s * width * 0.4);
      ctx.strokeStyle = "#6f4e35";
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPaifang(x, z, text) {
    const cx = X(x);
    const cy = Z(z);
    const h = 30 * S;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.ellipse(4, 5, 88, 13, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(58,48,33,0.14)";
    ctx.fill();
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * 42, 0);
      ctx.lineTo(s * 42, -h);
      ctx.strokeStyle = PAL.redDark;
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(s * 42, -h - 2, 5, 0, Math.PI * 2);
      ctx.fillStyle = PAL.gold;
      ctx.fill();
    }
    ctx.fillStyle = PAL.red;
    ctx.fillRect(-49, -h + 4, 98, 9);
    ctx.fillStyle = "#2f2b23";
    ctx.fillRect(-36, -h - 12, 72, 17);
    ctx.strokeStyle = PAL.gold;
    ctx.lineWidth = 1.4;
    ctx.strokeRect(-36, -h - 12, 72, 17);
    ctx.fillStyle = PAL.goldLight;
    ctx.font = `600 ${17}px ${KAI}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 0, -h - 3);
    drawRoof(0, -h - 10, 106, 22, 12, "#3f6864", { overhang: 1.15 });
    ctx.restore();
  }

  function drawSignpost(x, z) {
    const cx = X(x);
    const cy = Z(z);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -45);
    ctx.strokeStyle = "#63442e";
    ctx.lineWidth = 3;
    ctx.stroke();
    const boards = [
      ["万岁寺", -0.9, -36],
      ["松风驿站", 0.3, -28],
      ["非遗集市", 1.1, -20],
    ];
    for (const [label, dir, by] of boards) {
      ctx.save();
      ctx.translate(0, by);
      ctx.rotate(dir);
      ctx.fillStyle = "#9a7049";
      ctx.fillRect(2, -5, 31, 10);
      ctx.strokeStyle = "rgba(68,43,28,0.55)";
      ctx.strokeRect(2, -5, 31, 10);
      ctx.fillStyle = "#3c2b1e";
      ctx.font = `600 9px ${KAI}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 18, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  function drawHorse(x, z, color = "#8a5a3a") {
    const cx = X(x);
    const cy = Z(z);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = color;
    ctx.fillRect(-8, -9, 16, 7);
    ctx.fillRect(4, -15, 4, 8);
    ctx.fillRect(6, -19, 7, 4);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        ctx.fillRect(sx * 5 - 1, sz * 2 - 2, 2, 8);
      }
    }
    ctx.restore();
  }

  function drawWaterfallScene() {
    // a three-tier rock cliff with a stepped cascade; the pool is painted in terrain
    addItem(356, () => {
      ctx.save();
      ctx.translate(X(158), Z(360));

      // base shadow
      ctx.beginPath();
      ctx.ellipse(8, 16, 64, 18, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(39,55,40,0.26)";
      ctx.fill();

      function rock(cx, baseY, w, h, front, top) {
        // jagged, broad rock mass rather than a terraced step
        const topY = baseY - h;
        const pts = [
          [cx - w * 0.5, baseY],
          [cx - w * 0.46, baseY - h * 0.48],
          [cx - w * 0.34, topY + h * 0.13],
          [cx - w * 0.16, topY],
          [cx + w * 0.05, topY - h * 0.08],
          [cx + w * 0.25, topY + h * 0.06],
          [cx + w * 0.38, baseY - h * 0.45],
          [cx + w * 0.5, baseY],
        ];
        ctx.beginPath();
        pts.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
        ctx.closePath();
        const g = ctx.createLinearGradient(cx - w / 2, baseY, cx + w / 2, topY);
        g.addColorStop(0, front);
        g.addColorStop(0.48, shade(front, -0.04));
        g.addColorStop(1, shade(front, -0.13));
        ctx.fillStyle = g;
        ctx.fill();
        ctx.strokeStyle = "rgba(52,62,46,0.55)";
        ctx.lineWidth = 1.6;
        ctx.stroke();

        // right-hand facet
        ctx.beginPath();
        ctx.moveTo(cx + w * 0.25, topY + h * 0.06);
        ctx.lineTo(cx + w * 0.5, baseY);
        ctx.lineTo(cx + w * 0.34, baseY);
        ctx.lineTo(cx + w * 0.12, baseY - h * 0.35);
        ctx.closePath();
        ctx.fillStyle = "rgba(49,61,45,0.28)";
        ctx.fill();

        // crown
        ctx.beginPath();
        ctx.ellipse(cx + w * 0.02, topY + 2, w * 0.25, 6.5, -0.04, 0, Math.PI * 2);
        ctx.fillStyle = top;
        ctx.fill();
        ctx.strokeStyle = "rgba(70,78,58,0.32)";
        ctx.stroke();

        // cracks and moss
        ctx.strokeStyle = "rgba(53,64,47,0.3)";
        ctx.lineWidth = 1;
        for (let i = 0; i < 4; i++) {
          const px = cx - w * 0.26 + i * w * 0.14;
          ctx.beginPath();
          ctx.moveTo(px, baseY - 2);
          ctx.lineTo(px + (i % 2 ? 5 : -4), baseY - h * 0.45);
          ctx.lineTo(px + (i % 2 ? -2 : 5), baseY - h * 0.78);
          ctx.stroke();
        }
        ctx.fillStyle = "rgba(85,113,71,0.48)";
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.ellipse(cx - w * 0.22 + i * w * 0.22, topY + 9, 7.5, 3, 0.15, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // back to front: a tall crown, flanking masses, then the front boulder
      rock(4, -34, 54, 54, "#7a7863", "#95917a");
      rock(-36, -7, 54, 49, "#73745f", "#8d8a73");
      rock(39, -7, 58, 60, "#6e715c", "#89866f");
      rock(-6, 4, 74, 44, "#696b57", "#85816b");
      rock(-39, -45, 30, 28, "#7f7c67", "#9b9680");

      // crown pines
      for (const [px, py, ps] of [[-18, -79, 17], [9, -82, 20], [31, -74, 13]]) {
        ctx.beginPath();
        ctx.moveTo(px, py - ps);
        ctx.lineTo(px - ps * 0.65, py + ps * 0.3);
        ctx.lineTo(px + ps * 0.65, py + ps * 0.3);
        ctx.closePath();
        ctx.fillStyle = "#3e5f48";
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px, py + 8);
        ctx.strokeStyle = "#5c4630";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // a rock shelf breaks the fall into a visible upper and lower cascade
      ctx.fillStyle = "#69705b";
      ctx.beginPath();
      ctx.ellipse(1, -23, 28, 7.5, 0.05, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(54,64,47,0.5)";
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.fillStyle = "rgba(91,116,75,0.55)";
      ctx.beginPath();
      ctx.ellipse(-11, -25, 10, 3, 0.1, 0, Math.PI * 2);
      ctx.fill();

      // three-stage white water
      function ribbon(x1, x2, y1, y2, width1, width2, alpha) {
        const g = ctx.createLinearGradient(0, y1, 0, y2);
        g.addColorStop(0, `rgba(244,253,246,${alpha})`);
        g.addColorStop(0.6, `rgba(184,231,220,${alpha * 0.82})`);
        g.addColorStop(1, `rgba(108,181,174,${alpha * 0.35})`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x1 - width1 / 2, y1);
        ctx.lineTo(x1 + width1 / 2, y1);
        ctx.lineTo(x2 + width2 / 2, y2);
        ctx.lineTo(x2 - width2 / 2, y2);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(239,252,245,0.35)";
        ctx.lineWidth = 0.9;
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.moveTo(x1 - width1 * 0.25 + i * width1 * 0.25, y1);
          ctx.lineTo(x2 - width2 * 0.25 + i * width2 * 0.25, y2);
          ctx.stroke();
        }
      }
      ribbon(1, -2, -78, -54, 18, 24, 0.94);
      ribbon(-2, 3, -54, -24, 24, 32, 0.94);
      ribbon(2, 8, -24, 40, 32, 44, 0.98);
      ribbon(-18, -14, -50, -18, 6, 9, 0.45);
      ribbon(21, 25, -46, 38, 5, 8, 0.42);

      // rock lip in front of the fall, so the cascade visibly breaks twice
      ctx.fillStyle = "#656d58";
      ctx.beginPath();
      ctx.ellipse(-1, -23, 31, 7, 0.04, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(49,60,45,0.55)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = "rgba(83,111,69,0.5)";
      ctx.beginPath();
      ctx.ellipse(-16, -25, 11, 3, 0.1, 0, Math.PI * 2);
      ctx.fill();

      // a broad cloud of spray where the fall meets the pool
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      const spray = ctx.createRadialGradient(8, 42, 0, 8, 42, 52);
      spray.addColorStop(0, "rgba(239,251,242,0.35)");
      spray.addColorStop(0.55, "rgba(222,244,234,0.12)");
      spray.addColorStop(1, "rgba(222,244,234,0)");
      ctx.fillStyle = spray;
      ctx.beginPath();
      ctx.ellipse(8, 42, 52, 22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // ledge splashes
      for (const [sx, sy] of [[-2, -52], [3, -23], [8, 38]]) {
        ctx.save();
        ctx.globalCompositeOperation = "screen";
        for (let i = 0; i < 8; i++) {
          const a = Math.random() * Math.PI * 2;
          const rr = 3 + Math.random() * 12;
          ctx.beginPath();
          ctx.arc(sx + Math.cos(a) * rr, sy + Math.sin(a) * rr * 0.4, 1 + Math.random() * 3, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(239,253,245,0.55)";
          ctx.fill();
        }
        ctx.restore();
      }

      // base boulders
      for (const [bx, bz, br] of [[-53, 35, 13], [45, 42, 15], [27, 34, 9], [-24, 43, 8]]) {
        ctx.beginPath();
        ctx.ellipse(bx, bz, br, br * 0.5, 0.15, 0, Math.PI * 2);
        ctx.fillStyle = "#747a64";
        ctx.fill();
        ctx.strokeStyle = "rgba(55,66,50,0.35)";
        ctx.stroke();
      }

      // mist at the plunge pool
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      const mist = ctx.createRadialGradient(8, 36, 0, 8, 36, 44);
      mist.addColorStop(0, "rgba(238,250,240,0.32)");
      mist.addColorStop(1, "rgba(238,250,240,0)");
      ctx.fillStyle = mist;
      ctx.beginPath();
      ctx.ellipse(8, 36, 48, 18, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.restore();
    });

    // timber viewing deck and pavilion, set clear of the martial-hall label
    addItem(386, () => {
      ctx.save();
      ctx.translate(X(236), Z(390));
      ctx.fillStyle = "#9a744d";
      ctx.beginPath();
      ctx.ellipse(0, 0, 30, 16, -0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(81,56,35,0.55)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      for (let i = 0; i < 8; i++) {
        ctx.beginPath();
        ctx.moveTo(-24 + i * 7, -12);
        ctx.lineTo(-21 + i * 7, 12);
        ctx.strokeStyle = "rgba(213,180,128,0.4)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // railing
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(-24, s * 10);
        ctx.lineTo(24, s * 10);
        ctx.strokeStyle = "#6f4e35";
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      ctx.restore();
    });
    addItem(392, () => drawPavilion(246, 388, 1.35, "#8c4e3d"));
    addItem(562, () => drawBridge(214, 562, 54, 18, -0.05));

    // carved stone tablet, east of the pool
    addItem(384, () => {
      ctx.save();
      ctx.translate(X(220), Z(384));
      ctx.fillStyle = "#9e927b";
      ctx.fillRect(-8, -14, 16, 17);
      ctx.strokeStyle = "rgba(80,67,48,0.5)";
      ctx.strokeRect(-8, -14, 16, 17);
      ctx.fillStyle = "#a94433";
      ctx.fillRect(-6, -12, 12, 12);
      ctx.fillStyle = "#efd7a4";
      ctx.font = `600 6px ${KAI}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("九龙瀑", 0, -5);
      ctx.restore();
    });

    // edge planting
    for (const [x, z, s, t] of [[112, 330, 26, "pine"], [220, 334, 27, "pine"], [108, 438, 24, "pine"]]) {
      addItem(z, () => drawTree(x, z, s, t));
    }

    // boulders and reeds break up the circular pool edge
    for (const [x, z, s] of [
      [112, 420, 8], [126, 440, 7], [214, 454, 9], [232, 448, 7],
      [110, 380, 7], [222, 370, 8], [258, 418, 7], [100, 402, 6],
    ]) {
      addItem(z, () => {
        ctx.save();
        ctx.translate(X(x), Z(z));
        ctx.beginPath();
        ctx.ellipse(2, 2, s, s * 0.5, 0, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(50,55,40,0.2)";
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-s, 0);
        ctx.lineTo(-s * 0.7, -s * 0.85);
        ctx.lineTo(-s * 0.1, -s);
        ctx.lineTo(s * 0.6, -s * 0.7);
        ctx.lineTo(s, 0);
        ctx.closePath();
        ctx.fillStyle = "#747a66";
        ctx.fill();
        ctx.strokeStyle = "rgba(52,63,47,0.45)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.restore();
      });
    }
    for (let i = 0; i < 18; i++) {
      addItem(444, () => {
        const a = 0.2 + (i / 18) * 1.8;
        const x = 175 + Math.cos(a) * (55 + Math.random() * 8);
        const z = 403 + Math.sin(a) * (44 + Math.random() * 7);
        ctx.beginPath();
        ctx.moveTo(X(x), Z(z));
        ctx.quadraticCurveTo(X(x) + 3, Z(z) - 8, X(x) + 1, Z(z) - 15);
        ctx.strokeStyle = "rgba(83,112,68,0.65)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      });
    }
  }

  function drawTempleWall(x1, z1, x2, z2) {
    const ax = X(x1);
    const ay = Z(z1);
    const bx = X(x2);
    const by = Z(z2);
    const hy = HY(7);
    const hx = HX(7);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx + hx, by - hy);
    ctx.lineTo(ax + hx, ay - hy);
    ctx.closePath();
    ctx.fillStyle = "#a84b39";
    ctx.fill();
    ctx.strokeStyle = "rgba(82,42,30,0.55)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // dark tiled cap
    ctx.beginPath();
    ctx.moveTo(ax + hx - 1, ay - hy);
    ctx.lineTo(bx + hx - 1, by - hy);
    ctx.lineTo(bx + hx + 4, by - hy - 4);
    ctx.lineTo(ax + hx + 4, ay - hy - 4);
    ctx.closePath();
    ctx.fillStyle = "#425652";
    ctx.fill();
    // small red posts
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(2, Math.floor(len / 22));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      ctx.beginPath();
      ctx.arc(ax + (bx - ax) * t + hx, ay + (by - ay) * t - hy - 4, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = PAL.gold;
      ctx.fill();
    }
    ctx.restore();
  }

  function drawTemple() {
    // a stone apron laid over the road; the whole temple rides above it
    addItem(0, () => {
      ctx.save();
      ctx.translate(X(300), Z(198));
      ctx.shadowColor = "rgba(43,42,30,0.28)";
      ctx.shadowBlur = 22;
      ctx.shadowOffsetY = 10;
      ctx.beginPath();
      ctx.ellipse(0, 0, 104, 86, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#bca47a";
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = "rgba(91,69,42,0.55)";
      ctx.lineWidth = 2.2;
      ctx.stroke();
      // paving rings and joints
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath();
        ctx.ellipse(0, 0, 104 * (0.25 + i * 0.18), 86 * (0.25 + i * 0.18), 0, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(124,96,58,0.18)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 26, Math.sin(a) * 21);
        ctx.lineTo(Math.cos(a) * 96, Math.sin(a) * 79);
        ctx.strokeStyle = "rgba(124,96,58,0.12)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // red balustrade along the front half
      ctx.strokeStyle = "rgba(148,53,40,0.9)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(0, 0, 100, 82, 0, 0.08, Math.PI - 0.08);
      ctx.stroke();
      ctx.restore();
    });

    // outer red compound wall, with a wide opening to the stair
    addItem(207, () => {
      drawTempleWall(247, 207, 286, 207);
      drawTempleWall(314, 207, 353, 207);
      drawTempleWall(247, 207, 247, 153);
      drawTempleWall(353, 207, 353, 153);
    });

    // the principal hall sits higher and larger than everything around it
    addItem(154, () => drawHall({
      x: 300, z: 152, w: 72, d: 36, h: 30, lift: 0,
      roof: "#c99a4e", wall: "#a84734", columns: 5, rise: 18, doubleRoof: true,
    }));
    addItem(184, () => drawHall({ x: 238, z: 184, w: 22, d: 15, h: 12, roof: "#3f5350", wall: "#d9c29d", columns: 3, rise: 7 }));
    addItem(185, () => drawHall({ x: 362, z: 184, w: 22, d: 15, h: 12, roof: "#3f5350", wall: "#d9c29d", columns: 3, rise: 7 }));
    addItem(168, () => drawPagoda(337, 168, 4, 7, "#b98b46"));

    // incense burner in front of the hall
    addItem(199, () => {
      ctx.save();
      ctx.translate(X(300), Z(199));
      ctx.fillStyle = "#6f5a3c";
      ctx.beginPath();
      ctx.ellipse(0, 0, 14, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-9, -15, 18, 15);
      ctx.strokeStyle = "rgba(229,190,123,0.7)";
      ctx.strokeRect(-9, -15, 18, 15);
      // smoke
      ctx.strokeStyle = "rgba(236,241,226,0.5)";
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(-4 + i * 4, -16);
        ctx.quadraticCurveTo(-9 + i * 5, -28, -1 + i * 4, -40);
        ctx.stroke();
      }
      ctx.restore();
    });

    // broad ceremonial stair from the forecourt up to the terrace
    addItem(213, () => {
      ctx.save();
      ctx.translate(X(300), Z(214));
      for (let i = 0; i < 9; i++) {
        const w = 48 - i * 1.8;
        const y = -i * 5.2;
        ctx.fillStyle = i % 2 ? "#c8b48e" : "#e0cfab";
        ctx.fillRect(-w / 2, y - 5, w, 5.4);
        ctx.strokeStyle = "rgba(105,78,46,0.22)";
        ctx.strokeRect(-w / 2, y - 5, w, 5.4);
      }
      // red side rails
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * 28, 0);
        ctx.lineTo(s * 20, -48);
        ctx.strokeStyle = "rgba(139,52,39,0.85)";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.restore();
    });

    // gate at the foot of the stair
    addItem(214, () => drawGate({ x: 300, z: 214, w: 32, d: 11, baseH: 6, bodyH: 6, roof: "#3f5350", wall: "#a84b39" }));
    addItem(215, () => {
      // temple plaque and gate lanterns
      ctx.save();
      ctx.translate(X(300), Z(214) - 30);
      ctx.fillStyle = "#2f2a22";
      ctx.fillRect(-22, -7, 44, 13);
      ctx.strokeStyle = PAL.gold;
      ctx.lineWidth = 1;
      ctx.strokeRect(-22, -7, 44, 13);
      ctx.fillStyle = PAL.goldLight;
      ctx.font = `600 8px ${KAI}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("万岁寺", 0, 0);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(s * 26, 7, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = "#b64732";
        ctx.fill();
        ctx.strokeStyle = "rgba(239,203,137,0.8)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();
    });
    addItem(196, () => {
      // paired stone lanterns in the courtyard
      for (const sx of [268, 332]) {
        ctx.save();
        ctx.translate(X(sx), Z(196));
        ctx.fillStyle = "#9b907a";
        ctx.fillRect(-3, -11, 6, 11);
        ctx.fillStyle = "#7f7865";
        ctx.fillRect(-7, -20, 14, 9);
        ctx.strokeStyle = "rgba(60,52,39,0.5)";
        ctx.strokeRect(-7, -20, 14, 9);
        ctx.fillStyle = "#b94c38";
        ctx.fillRect(-2, -17, 4, 4);
        ctx.restore();
      }
    });
    addItem(219, () => {
      // two small stone lions flanking the gate
      for (const s of [-1, 1]) {
        ctx.save();
        ctx.translate(X(300 + s * 21), Z(218));
        ctx.fillStyle = "#9d9079";
        ctx.fillRect(-4, -9, 8, 9);
        ctx.beginPath();
        ctx.arc(0, -12, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(74,64,47,0.4)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
    });
    addItem(148, () => drawFlag(264, 148, PAL.gold, 24));
    addItem(148, () => drawFlag(336, 148, PAL.red, 24));
  }

  function drawManor() {
    addItem(246, () => {
      drawWallSegment(697, 245, 823, 245, 12);
      drawWallSegment(697, 245, 697, 138, 12);
      drawWallSegment(823, 245, 823, 138, 12);
    });
    addItem(242, () => drawGate({ x: 760, z: 245, w: 28, d: 14, baseH: 7, bodyH: 8, roof: "#3f6864", wall: "#a84332" }));
    addItem(164, () => drawHall({ x: 760, z: 164, w: 74, d: 32, h: 20, roof: "#3f6864", wall: "#a84332", columns: 5, rise: 12, doubleRoof: true }));
    addItem(196, () => drawHall({ x: 713, z: 196, w: 28, d: 18, h: 12, roof: "#4d776b", wall: "#d8c29d", columns: 3, rise: 7 }));
    addItem(197, () => drawHall({ x: 807, z: 196, w: 28, d: 18, h: 12, roof: "#4d776b", wall: "#d8c29d", columns: 3, rise: 7 }));
    addItem(216, () => drawPavilion(733, 216, 0.72, "#4d776b"));
  }

  function drawPostStation() {
    addItem(342, () => {
      drawWallSegment(667, 342, 753, 342, 8, "#cbb894");
      drawWallSegment(667, 342, 667, 292, 8, "#cbb894");
      drawWallSegment(753, 342, 753, 292, 8, "#cbb894");
    });
    addItem(338, () => drawHall({ x: 717, z: 336, w: 42, d: 22, h: 14, roof: "#4a7268", wall: "#dcc7a1", columns: 4, rise: 8 }));
    addItem(304, () => {
      ctx.save();
      ctx.translate(X(678), Z(303));
      ctx.fillStyle = "#8d6747";
      ctx.fillRect(-28, -3, 56, 12);
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = "#5c3f2e";
        ctx.fillRect(-25 + i * 17, -18, 2, 18);
      }
      ctx.beginPath();
      ctx.moveTo(-32, -17);
      ctx.lineTo(32, -17);
      ctx.lineTo(24, -28);
      ctx.lineTo(-24, -28);
      ctx.closePath();
      ctx.fillStyle = "#4a7268";
      ctx.fill();
      ctx.restore();
    });
    addItem(291, () => drawHorse(661, 291));
    addItem(306, () => drawHorse(681, 306, "#b19a78"));
    addItem(276, () => {
      ctx.save();
      ctx.translate(X(710), Z(276));
      ctx.fillStyle = "#6f4c33";
      ctx.fillRect(-1.5, 0, 3, 34);
      ctx.fillStyle = "#a57b4e";
      ctx.fillRect(-100, 6, 22, 9);
      ctx.restore();
    });
  }

  function drawCrossroads() {
    addItem(301, () => drawSignpost(380, 300));
    // trailhead for the dotted back-hill path down to 森林绿地
    addItem(290, () => drawSignpost(252, 290));
    addItem(314, () => drawStall(414, 314, "#9e4b3b", -0.25));
    addItem(342, () => drawPavilion(343, 342, 0.72, "#4d7567"));
    addItem(278, () => {
      ctx.save();
      ctx.translate(X(350), Z(278));
      ctx.fillStyle = "#9a8464";
      ctx.fillRect(-6, -7, 12, 7);
      ctx.fillStyle = "#d9c7a4";
      ctx.fillRect(-5, -10, 10, 4);
      ctx.restore();
    });
  }

  function drawMartialHall() {
    addItem(430, () => drawHall({ x: 318, z: 430, w: 80, d: 44, h: 24, roof: "#4b776e", wall: "#a94433", columns: 5, rise: 14, doubleRoof: true }));
    addItem(470, () => drawHall({ x: 280, z: 470, w: 28, d: 18, h: 12, roof: "#4d776b", wall: "#d9c5a1", columns: 3, rise: 7 }));
    // training yard, set south-east of the road
    addItem(505, () => {
      ctx.save();
      ctx.translate(X(360), Z(505));
      ctx.beginPath();
      ctx.ellipse(0, 0, 28 * S, 20 * S, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#d7c08d";
      ctx.fill();
      ctx.strokeStyle = "rgba(125,96,55,0.35)";
      ctx.stroke();
      for (let i = 0; i < 4; i++) {
        const px = -22 + i * 15;
        ctx.beginPath();
        ctx.moveTo(px, 5);
        ctx.lineTo(px, -16);
        ctx.strokeStyle = "#6a4932";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#a47645";
        ctx.fillRect(px - 5, -16, 10, 3);
      }
      ctx.restore();
    });
    addItem(470, () => drawFlag(286, 468, PAL.red, 24));
    addItem(530, () => drawFlag(360, 530, PAL.gold, 24));
  }

  function drawMarket() {
    addItem(626, () => drawPaifang(500, 625, "非遗集市"));
    addItem(600, () => drawHall({ x: 404, z: 600, w: 38, d: 22, h: 14, roof: "#426d64", wall: "#dcc7a3", columns: 4, rise: 8 }));
    addItem(602, () => drawHall({ x: 596, z: 600, w: 38, d: 22, h: 14, roof: "#426d64", wall: "#dcc7a3", columns: 4, rise: 8 }));
    for (let i = 0; i < 4; i++) {
      addItem(520 + i * 28, () => drawStall(444, 520 + i * 28, i % 2 ? "#9e4b3b" : "#a35b45", 0.03));
      addItem(520 + i * 28, () => drawStall(556, 520 + i * 28, i % 2 ? "#a85a42" : "#8f4c39", -0.03));
    }
    // extra canopies and a pair of larger food sheds
    for (let i = 0; i < 4; i++) {
      addItem(514 + i * 25, () => drawStall(424, 514 + i * 25, i % 2 ? "#b78d43" : "#9f4d3a", -0.04));
      addItem(514 + i * 25, () => drawStall(576, 514 + i * 25, i % 2 ? "#9f4d3a" : "#b78d43", 0.04));
    }
    addItem(532, () => {
      ctx.save();
      ctx.translate(X(402), Z(532));
      ctx.fillStyle = "#8f6a45";
      ctx.fillRect(-20, -4, 40, 14);
      ctx.fillStyle = "#b74f3a";
      ctx.fillRect(-24, -18, 48, 12);
      ctx.strokeStyle = "rgba(232,197,134,0.6)";
      ctx.strokeRect(-24, -18, 48, 12);
      ctx.restore();
    });
    addItem(532, () => {
      ctx.save();
      ctx.translate(X(598), Z(532));
      ctx.fillStyle = "#8f6a45";
      ctx.fillRect(-20, -4, 40, 14);
      ctx.fillStyle = "#b78d43";
      ctx.fillRect(-24, -18, 48, 12);
      ctx.strokeStyle = "rgba(232,197,134,0.6)";
      ctx.strokeRect(-24, -18, 48, 12);
      ctx.restore();
    });
    // lantern strings across the street
    addItem(548, () => drawLanternString(430, 548, 570, 548, 8));
    addItem(588, () => drawLanternString(430, 588, 570, 588, 8));
    // crowd
    for (const [x, z, c] of [[470, 540, "#9d4032"], [530, 552, "#3f6b63"], [490, 580, "#b58d43"], [520, 600, "#7c5a3f"], [475, 608, "#3d6b63"], [545, 570, "#9b4a39"]]) {
      addItem(z, () => drawPerson(x, z, c));
    }
  }

  function drawArenaScene() {
    addItem(500, () => drawArena(690, 500));
    // gate canopy
    addItem(586, () => drawPavilion(718, 586, 0.78, "#4a7569"));
    for (const [x, z] of [[625, 470], [755, 470], [690, 430]]) {
      addItem(z, () => drawFlag(x, z, PAL.red, 26));
    }
    for (let i = 0; i < 12; i++) {
      const a = 0.15 + (i / 11) * (Math.PI - 0.3);
      addItem(500 + Math.sin(a) * 8, () => drawPerson(690 + Math.cos(a) * 67, 500 + Math.sin(a) * 42, i % 2 ? "#3f6b63" : "#9d4032"));
    }
  }

  function drawForestLawn() {
    addItem(548, () => drawPavilion(150, 550, 0.9, "#4d7567"));
    addItem(620, () => drawPavilion(194, 618, 0.9, "#4d7567"));
    // small rest pavilion at the western hill-trail destination
    addItem(631, () => drawPavilion(105, 630, 0.54, "#4d7567"));
    // flower beds, kept outside the loop
    for (let i = 0; i < 5; i++) {
      const x = [92, 118, 88, 232, 238][i];
      const z = [535, 520, 610, 548, 605][i];
      addItem(z, () => {
        ctx.save();
        ctx.translate(X(x), Z(z));
        ctx.beginPath();
        ctx.ellipse(0, 0, 14 * S, 9 * S, 0, 0, Math.PI * 2);
        ctx.fillStyle = "#7f7651";
        ctx.fill();
        for (let j = 0; j < 12; j++) {
          const a = Math.random() * Math.PI * 2;
          const rr = Math.random() * 11 * S;
          ctx.beginPath();
          ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr * 0.6, 2.6, 0, Math.PI * 2);
          ctx.fillStyle = j % 2 ? "#d493a2" : "#f1c4cc";
          ctx.fill();
        }
        ctx.restore();
      });
    }
    // benches
    for (const [x, z] of [[120, 570], [200, 620], [250, 585]]) {
      addItem(z, () => {
        ctx.save();
        ctx.translate(X(x), Z(z));
        ctx.fillStyle = "#8f6b45";
        ctx.fillRect(-9, -2, 18, 5);
        ctx.fillStyle = "#5d432d";
        ctx.fillRect(-7, 3, 2, 4);
        ctx.fillRect(5, 3, 2, 4);
        ctx.restore();
      });
    }
  }

  function drawInfill() {
    const houses = [
      [440, 260, 28, 17, "#d7c29d", "#4d776b"],
      [560, 272, 30, 18, "#d7c29d", "#3f6864"],
      [440, 330, 32, 18, "#d7c29d", "#3f6864"],
      [565, 350, 30, 18, "#d7c29d", "#4d776b"],
      [430, 220, 25, 16, "#d7c29d", "#4d776b"],
      [600, 255, 28, 17, "#d7c29d", "#3f6864"],
      [620, 600, 34, 20, "#d7c29d", "#3f6864"],
      [390, 625, 32, 19, "#d7c29d", "#4d776b"],
      [620, 390, 28, 18, "#d7c29d", "#3f6864"],
      [430, 400, 28, 17, "#d7c29d", "#4d776b"],
      [610, 220, 24, 15, "#d7c29d", "#4d776b"],
      [375, 240, 24, 15, "#d7c29d", "#3f6864"],
      [466, 196, 22, 14, "#d9c5a0", "#8b4d3d"],
      [540, 198, 24, 15, "#d9c5a0", "#3f6864"],
      [462, 300, 22, 14, "#d9c5a0", "#4d776b"],
      [542, 304, 24, 15, "#d9c5a0", "#8b4d3d"],
      [600, 312, 25, 15, "#d9c5a0", "#4d776b"],
      [410, 365, 24, 15, "#d9c5a0", "#3f6864"],
      [648, 360, 24, 15, "#d9c5a0", "#8b4d3d"],
      [664, 418, 22, 14, "#d9c5a0", "#4d776b"],
      [615, 452, 24, 15, "#d9c5a0", "#3f6864"],
      [566, 470, 22, 14, "#d9c5a0", "#8b4d3d"],
      [460, 470, 24, 15, "#d9c5a0", "#3f6864"],
      [420, 448, 21, 13, "#d9c5a0", "#4d776b"],
      [455, 610, 26, 16, "#d9c5a0", "#8b4d3d"],
      [545, 618, 26, 16, "#d9c5a0", "#4d776b"],
      [370, 560, 22, 14, "#d9c5a0", "#3f6864"],
      [330, 610, 22, 14, "#d9c5a0", "#8b4d3d"],
      [640, 190, 22, 14, "#d9c5a0", "#3f6864"],
      [680, 238, 20, 13, "#d9c5a0", "#4d776b"],
    ];
    const roofPalette = ["#4f7b70", "#5b8675", "#8c4e3d", "#a67843", "#5d7d59", "#486d72"];
    const wallPalette = ["#d7c29d", "#a94433", "#cbb58e", "#dcc8a3", "#b06a4a", "#e0cba6"];
    // keep the street-front courts, thin out the generic in-fill so the roads
    // and lawns can breathe
    const kept = houses.filter((h, i) => i < 8 || i % 3 === 0);
    kept.forEach(([x, z, w, d, , roof], idx) => {
      if (roadClearance(x, z) < 14) return;
      addItem(z, () => drawHall({
        x, z, w, d, h: 9 + (idx % 3), roof: roofPalette[idx % roofPalette.length],
        wall: wallPalette[idx % wallPalette.length], columns: 3, rise: 6,
        lanterns: idx % 4 === 0,
      }));
    });
  }

  function drawExpandedAttractions() {
    // West / north-west cluster from the detailed reference map.
    addItem(188, () => drawGate({ x: 82, z: 176, w: 46, d: 20, baseH: 7, bodyH: 8, roof: "#3f6864", wall: "#a94433" }));
    addItem(182, () => drawWallSegment(30, 184, 62, 184, 12));
    addItem(182, () => drawWallSegment(102, 184, 148, 184, 12));
    addItem(198, () => drawHall({ x: 205, z: 184, w: 46, d: 28, h: 25, roof: "#385b59", wall: "#b75a41", columns: 4, rise: 8, doubleRoof: true }));
    addItem(140, () => drawPavilion(252, 128, 1.15, "#496f68"));
    addItem(138, () => drawFlag(226, 132, PAL.gold, 24));
    addItem(138, () => drawFlag(280, 132, PAL.red, 24));
    addItem(304, () => drawHall({ x: 286, z: 292, w: 32, d: 22, h: 14, roof: "#8c4e3d", wall: "#d2b98e", columns: 3, rise: 6 }));
    addItem(305, () => drawPavilion(250, 292, 0.8, "#557b70"));

    // The northern central axis is a sequence of pavilions, tea houses and a
    // landmark pagoda, matching the compact architectural rhythm in the
    // reference illustration without crowding the main avenue.
    addItem(138, () => drawHall({ x: 414, z: 124, w: 38, d: 24, h: 20, roof: "#496c67", wall: "#c18b5f", columns: 4, rise: 7, doubleRoof: true }));
    addItem(236, () => drawHall({ x: 555, z: 224, w: 34, d: 22, h: 15, roof: "#8d553e", wall: "#d9c29b", columns: 3, rise: 6 }));
    addItem(246, () => drawStall(595, 226, "#a34d3c", -0.08));
    addItem(246, () => drawStall(640, 248, "#b77e43", 0.08));
    addItem(258, () => drawHall({ x: 620, z: 238, w: 28, d: 18, h: 13, roof: "#4c766c", wall: "#d5bd98", columns: 3, rise: 5 }));
    addItem(146, () => drawPagoda(672, 128, 5, 0, "#3f6864"));
    addItem(192, () => drawPavilion(733, 182, 1.1, "#4a7066"));

    // East-side themed district and the second entrance.
    addItem(254, () => drawHall({ x: 790, z: 250, w: 42, d: 25, h: 18, roof: "#8f503d", wall: "#d5bc92", columns: 4, rise: 7, doubleRoof: true }));
    addItem(310, () => drawHall({ x: 855, z: 302, w: 48, d: 28, h: 19, roof: "#466d67", wall: "#c7ad84", columns: 4, rise: 7 }));
    addItem(254, () => drawGate({ x: 925, z: 246, w: 44, d: 20, baseH: 7, bodyH: 8, roof: "#3f6864", wall: "#a94433" }));
    addItem(246, () => drawWallSegment(872, 246, 905, 246, 12));
    addItem(246, () => drawWallSegment(945, 246, 975, 246, 12));
    addItem(620, () => drawPavilion(716, 604, 1.1, "#8d5b49"));
    addItem(620, () => drawStall(680, 606, "#a34d3c", -0.12));
    addItem(620, () => drawStall(754, 612, "#b77e43", 0.12));
    addItem(622, () => drawHall({ x: 612, z: 608, w: 34, d: 22, h: 15, roof: "#4e7569", wall: "#d5bf98", columns: 3, rise: 6 }));

    // Additional C-only landmarks visible on the detailed hand map. These are
    // small structures and courtyards, deliberately kept away from the road
    // centre-lines so the base paths remain readable.
    addItem(254, () => drawPavilion(108, 252, 0.72, "#557b70"));
    addItem(246, () => drawHall({ x: 92, z: 238, w: 26, d: 17, h: 12, roof: "#466d67", wall: "#d2bd98", columns: 3, rise: 5, lanterns: false }));
    addItem(362, () => drawPavilion(620, 360, 1.05, "#8c5949"));
    addItem(114, () => drawHall({ x: 820, z: 108, w: 32, d: 18, h: 14, roof: "#4b7168", wall: "#d4bf9b", columns: 3, rise: 5 }));
    addItem(202, () => drawHall({ x: 870, z: 195, w: 30, d: 18, h: 13, roof: "#a05b42", wall: "#d3bb91", columns: 3, rise: 5 }));
    addItem(316, () => drawPavilion(620, 310, 0.86, "#8e5a45"));
    addItem(668, () => drawStall(430, 662, "#a34d3c", -0.08));

    // Small illustrative gardens and trees make the new districts feel like
    // places rather than isolated labels, while remaining easy to revise when
    // surveyed coordinates arrive.
    for (const [x, z, roof] of [[180, 128, "#4c7068"], [330, 150, "#8b513e"], [470, 180, "#4d7568"], [700, 280, "#8c513e"], [820, 210, "#4e746b"], [875, 370, "#8e533f"], [760, 650, "#4e746b"]]) {
      addItem(z, () => drawHall({ x, z, w: 22, d: 15, h: 10, roof, wall: "#d4bf9c", columns: 2, rise: 5, lanterns: false }));
    }
  }

  function buildScene() {
    // walls / gates
    addItem(700, () => drawWallSegment(300, 700, 462, 700, 18));
    addItem(700, () => drawWallSegment(538, 700, 900, 700, 18));
    addItem(690, () => drawGate({ x: 500, z: 690, w: 66, d: 26, baseH: 8, bodyH: 10, roof: "#3a625f", wall: "#a94433" }));
    addItem(700, () => drawHall({ x: 458, z: 700, w: 17, d: 13, h: 20, roof: "#3f5350", wall: "#a94433", columns: 2, rise: 7, lanterns: true }));
    addItem(700, () => drawHall({ x: 542, z: 700, w: 17, d: 13, h: 20, roof: "#3f5350", wall: "#a94433", columns: 2, rise: 7, lanterns: true }));
    addItem(668, () => drawWatchtower(800, 668));

    addItem(95, () => drawWallSegment(420, 95, 472, 95, 13));
    addItem(95, () => drawWallSegment(528, 95, 580, 95, 13));
    addItem(80, () => drawGate({ x: 500, z: 80, w: 52, d: 22, baseH: 7, bodyH: 8, roof: "#3a625f", wall: "#a94433" }));
    addItem(95, () => drawHall({ x: 468, z: 95, w: 14, d: 11, h: 16, roof: "#3f5350", wall: "#a94433", columns: 2, rise: 6, lanterns: false }));
    addItem(95, () => drawHall({ x: 532, z: 95, w: 14, d: 11, h: 16, roof: "#3f5350", wall: "#a94433", columns: 2, rise: 6, lanterns: false }));

    drawMarket();
    addItem(440, () => drawAltar(500, 440));
    drawArenaScene();
    drawMartialHall();
    drawCrossroads();
    drawPostStation();
    drawManor();
    // the temple is deferred to a foreground pass so the entire complex
    // reads above the approach road instead of being cut by it
    deferTemple = true;
    drawTemple();
    deferTemple = false;
    drawWaterfallScene();
    drawForestLawn();
    drawInfill();
    drawExpandedAttractions();

    // formal rows of street trees, as in the reference map
    for (const z of [200, 255, 310, 365, 500, 555, 610]) {
      addItem(z, () => drawTree(446, z, 11, z % 2 ? "pine" : "peach"));
      addItem(z, () => drawTree(554, z, 11, z % 2 ? "peach" : "pine"));
    }

    // two low-walled residential courts frame the central avenue
    addItem(238, () => {
      drawGardenWall(398, 238, 468, 238);
      drawGardenWall(398, 238, 398, 310);
      drawGardenWall(398, 310, 468, 310);
      drawGardenWall(468, 282, 468, 310);
    });
    addItem(258, () => {
      drawGardenWall(532, 258, 606, 258);
      drawGardenWall(606, 258, 606, 326);
      drawGardenWall(606, 326, 532, 326);
      drawGardenWall(532, 300, 532, 326);
    });

    // tea hut and lookout on the eastern ridge
    addItem(292, () => drawHall({ x: 884, z: 292, w: 22, d: 14, h: 10, roof: "#8e513e", wall: "#d9c39d", columns: 3, rise: 6 }));
    addItem(356, () => drawPavilion(914, 356, 0.7, "#4d7567"));

    // lantern posts along the avenue
    for (let i = 0; i < 9; i++) {
      const z = 140 + i * 62;
      const x = i % 2 ? 468 : 532;
      addItem(z, () => {
        ctx.save();
        ctx.translate(X(x), Z(z));
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -27);
        ctx.strokeStyle = "#5d402c";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, -27, 4.2, 0, Math.PI * 2);
        ctx.fillStyle = "#b54431";
        ctx.fill();
        ctx.strokeStyle = "rgba(240,198,126,0.7)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      });
    }

    // gates and compound flags
    addItem(676, () => drawFlag(462, 676, PAL.red, 22));
    addItem(676, () => drawFlag(538, 676, PAL.red, 22));
    addItem(78, () => drawFlag(466, 78, PAL.red, 20));
    addItem(78, () => drawFlag(534, 78, PAL.gold, 20));
    addItem(470, () => drawFlag(618, 470, PAL.red, 22));
    addItem(470, () => drawFlag(760, 470, PAL.gold, 22));

    // boats on the river
    addItem(734, () => {
      ctx.save();
      ctx.translate(X(650), Z(734));
      ctx.beginPath();
      ctx.ellipse(0, 0, 22, 7, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#72523a";
      ctx.fill();
      ctx.fillStyle = "#476b60";
      ctx.fillRect(-9, -10, 18, 7);
      ctx.restore();
    });
    addItem(730, () => {
      ctx.save();
      ctx.translate(X(842), Z(730));
      ctx.beginPath();
      ctx.ellipse(0, 0, 18, 6, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#72523a";
      ctx.fill();
      ctx.restore();
    });

    // people
    const people = [
      [500, 656, "#9d4032"], [482, 620, "#3e6b63"], [520, 606, "#8d6747"], [492, 578, "#6f4d35"],
      [515, 552, "#9b5f4a"], [478, 520, "#3d6b63"], [522, 510, "#9d4032"], [500, 482, "#7c5a3f"],
      [470, 452, "#406d65"], [530, 450, "#9a4a3b"], [500, 414, "#8c684c"], [520, 390, "#3f6b5f"],
      [660, 478, "#9b4a39"], [711, 504, "#37655c"], [702, 530, "#8d633f"], [642, 470, "#9d4032"],
      [352, 466, "#8a5b3c"], [334, 499, "#3c6960"], [298, 450, "#9d4032"], [250, 432, "#79543b"],
      [382, 326, "#3e6b63"], [401, 282, "#9c4a3a"], [730, 330, "#8c633f"], [764, 238, "#9d4032"],
      [704, 200, "#3d6960"], [520, 120, "#8a5c3e"], [480, 100, "#9d4032"], [300, 204, "#3d6960"],
      [202, 596, "#9c5a45"], [240, 558, "#406d65"], [500, 365, "#8a5c3e"], [438, 560, "#3d6960"],
    ];
    for (const [x, z, color] of people) addItem(z, () => drawPerson(x, z, color));

    // trees, sorted together with architecture
    const trees = [
      [70, 480, 24, "broad"], [98, 530, 27, "broad"], [122, 588, 24, "broad"], [84, 630, 20, "broad"],
      [148, 650, 25, "broad"], [205, 642, 22, "broad"], [250, 605, 20, "broad"], [292, 565, 18, "broad"],
      [315, 520, 15, "peach"], [250, 500, 18, "peach"], [205, 480, 19, "pine"], [160, 505, 17, "broad"],
      [70, 558, 16, "peach"], [138, 545, 14, "peach"], [102, 590, 15, "peach"], [270, 635, 13, "peach"],
      [218, 160, 22, "pine"], [248, 220, 18, "pine"], [340, 184, 18, "pine"], [382, 212, 16, "pine"],
      [218, 270, 16, "pine"], [380, 258, 18, "pine"], [422, 188, 14, "pine"], [265, 300, 13, "peach"],
      [620, 260, 19, "pine"], [660, 242, 21, "pine"], [720, 230, 18, "pine"], [780, 225, 17, "pine"],
      [832, 252, 18, "pine"], [872, 300, 17, "pine"], [902, 350, 16, "pine"], [862, 390, 18, "pine"],
      [800, 390, 16, "pine"], [742, 372, 14, "pine"], [690, 380, 14, "pine"], [640, 330, 13, "pine"],
      [612, 300, 12, "pine"], [882, 452, 15, "pine"], [915, 405, 13, "pine"],
      [82, 560, 14, "peach"], [124, 575, 16, "peach"], [162, 602, 14, "peach"], [222, 598, 16, "peach"],
      [262, 624, 14, "peach"], [302, 645, 16, "peach"], [102, 652, 14, "peach"], [222, 658, 16, "peach"],
      [282, 560, 12, "peach"], [150, 532, 13, "peach"], [62, 610, 12, "broad"],
      [390, 720, 15, "broad"], [454, 735, 13, "pine"], [560, 735, 14, "broad"], [650, 742, 12, "pine"],
      [722, 730, 14, "broad"], [850, 720, 13, "pine"], [902, 732, 15, "broad"], [122, 700, 14, "broad"],
      [250, 710, 14, "pine"], [330, 718, 13, "broad"],
      [690, 160, 15, "pine"], [822, 150, 16, "pine"], [700, 278, 12, "pine"], [762, 282, 12, "pine"],
      [560, 260, 13, "pine"], [540, 300, 12, "pine"], [444, 365, 11, "peach"], [468, 350, 10, "pine"],
    ];
    for (const [x, z, size, tone] of trees) {
      if (inForestClearing(x, z) || roadClearance(x, z) < 9) continue;
      addItem(z, () => drawTree(x, z, size, tone));
    }

    const moreTrees = [
      // west forest / temple slopes
      [250, 110, 20, "pine"], [300, 100, 18, "pine"], [350, 110, 20, "pine"], [390, 130, 18, "pine"],
      [250, 145, 16, "peach"], [340, 140, 18, "pine"], [395, 165, 16, "pine"], [230, 190, 17, "pine"],
      [380, 230, 16, "pine"], [420, 260, 15, "pine"], [430, 300, 14, "pine"], [330, 330, 16, "peach"],
      [280, 350, 18, "pine"], [220, 330, 16, "peach"], [180, 310, 15, "pine"], [150, 270, 16, "pine"],
      [120, 240, 14, "pine"], [100, 290, 15, "broad"], [80, 340, 14, "pine"], [70, 390, 15, "broad"],
      [90, 470, 13, "broad"], [130, 490, 14, "pine"], [170, 470, 13, "broad"], [230, 460, 14, "peach"],
      [300, 480, 12, "peach"], [350, 500, 12, "pine"], [370, 530, 12, "peach"], [330, 560, 12, "peach"],
      [290, 590, 13, "peach"], [250, 620, 12, "peach"], [190, 635, 13, "peach"], [150, 620, 12, "peach"],
      [110, 640, 12, "broad"], [80, 600, 12, "peach"], [110, 560, 12, "peach"],
      // eastern pine ridge
      [700, 120, 18, "pine"], [750, 125, 17, "pine"], [810, 130, 18, "pine"], [860, 145, 17, "pine"],
      [900, 165, 18, "pine"], [925, 200, 16, "pine"], [940, 240, 17, "pine"], [930, 280, 16, "pine"],
      [910, 320, 17, "pine"], [880, 350, 16, "pine"], [850, 380, 17, "pine"], [810, 410, 16, "pine"],
      [770, 430, 15, "pine"], [730, 440, 14, "pine"], [690, 450, 15, "pine"], [660, 430, 14, "pine"],
      [640, 400, 13, "pine"], [620, 370, 14, "pine"], [600, 340, 13, "pine"], [580, 310, 14, "pine"],
      [560, 280, 13, "pine"], [590, 250, 14, "pine"], [620, 220, 13, "pine"], [660, 210, 14, "pine"],
      [790, 210, 14, "pine"], [820, 230, 13, "pine"], [850, 260, 14, "pine"], [860, 300, 13, "pine"],
      [840, 330, 13, "pine"], [800, 340, 12, "pine"], [760, 330, 12, "pine"],
      // central courtyards and around the avenue
      [450, 185, 12, "peach"], [550, 185, 12, "pine"], [470, 242, 11, "peach"], [535, 242, 11, "peach"],
      [470, 288, 11, "pine"], [535, 290, 11, "peach"], [590, 290, 10, "pine"], [625, 335, 10, "pine"],
      [670, 355, 11, "peach"], [690, 395, 10, "pine"], [645, 445, 11, "peach"], [590, 462, 10, "pine"],
      [520, 482, 10, "peach"], [455, 482, 11, "pine"], [410, 425, 10, "peach"], [395, 385, 10, "pine"],
      [440, 555, 10, "peach"], [570, 555, 10, "pine"], [520, 620, 11, "peach"], [470, 642, 10, "pine"],
    ];
    for (const [x, z, size, tone] of moreTrees) {
      if (inForestClearing(x, z) || roadClearance(x, z) < 9) continue;
      addItem(z, () => drawTree(x, z, size, tone));
    }

    const heroTrees = [
      [300, 540, 32, "broad"], [380, 600, 30, "peach"],
      [640, 500, 32, "pine"], [700, 420, 30, "pine"], [720, 360, 28, "pine"],
      [600, 400, 30, "peach"], [800, 360, 28, "pine"], [850, 420, 30, "pine"],
      [430, 300, 28, "peach"], [560, 300, 30, "pine"], [120, 462, 24, "pine"],
      [330, 280, 28, "peach"], [280, 220, 30, "pine"], [400, 240, 26, "pine"],
      [760, 300, 28, "pine"], [930, 380, 26, "pine"], [600, 640, 30, "peach"],
      [650, 600, 28, "peach"], [500, 620, 30, "peach"], [340, 650, 28, "peach"],
      [100, 300, 28, "pine"], [160, 440, 26, "pine"], [820, 180, 26, "pine"],
      [220, 300, 26, "peach"], [860, 500, 26, "pine"], [300, 600, 26, "peach"],
      [200, 120, 36, "pine"], [350, 80, 34, "pine"], [390, 180, 36, "pine"],
      [180, 230, 34, "pine"], [150, 330, 32, "pine"], [300, 365, 24, "peach"],
      [310, 470, 30, "pine"], [100, 620, 32, "peach"], [720, 100, 36, "pine"],
      [850, 110, 38, "pine"], [920, 220, 34, "pine"], [900, 330, 36, "pine"],
      [820, 430, 32, "pine"], [760, 460, 30, "pine"], [660, 180, 34, "pine"],
      [400, 340, 30, "peach"], [450, 360, 32, "pine"], [600, 470, 34, "peach"],
      [650, 530, 32, "pine"], [550, 650, 34, "peach"], [420, 660, 30, "peach"],
      [300, 730, 30, "pine"], [700, 720, 32, "broad"], [950, 700, 30, "pine"],
      [540, 500, 30, "gold"], [610, 586, 28, "gold"], [380, 480, 26, "gold"],
      [700, 556, 28, "gold"], [886, 438, 26, "gold"], [220, 505, 26, "gold"],
      [240, 280, 30, "gold"], [360, 320, 28, "gold"], [782, 262, 30, "gold"],
      [862, 462, 28, "gold"], [560, 662, 30, "gold"], [300, 350, 26, "gold"],
    ];
    for (const [x, z, size, tone] of heroTrees) {
      if (inForestClearing(x, z) || roadClearance(x, z) < 10) continue;
      addItem(z, () => drawTree(x, z, size, tone));
    }

    // rocks along the river / pool
    for (let i = 0; i < 10; i++) {
      const x = 80 + i * 90;
      addItem(703, () => {
        ctx.beginPath();
        ctx.ellipse(X(x), Z(703), 9, 4, 0, 0, Math.PI * 2);
        ctx.fillStyle = "#7d806b";
        ctx.fill();
      });
    }
  }

  /* ----------------------------- labels / poster ----------------------------- */

  function drawTourRoute() {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // soft paper halo
    ctx.strokeStyle = "rgba(249,240,222,0.82)";
    ctx.lineWidth = 8;
    worldPath(TOUR_ROUTE);
    ctx.stroke();
    // the route is the only dashed element on the base map
    ctx.setLineDash([11, 9]);
    ctx.strokeStyle = "#b23a2f";
    ctx.lineWidth = 3.6;
    worldPath(TOUR_ROUTE);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [x, z] of TOUR_STOPS) {
      ctx.beginPath();
      ctx.arc(X(x), Z(z), 6.5, 0, Math.PI * 2);
      ctx.fillStyle = "#f6ead6";
      ctx.fill();
      ctx.strokeStyle = "#b23a2f";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(X(x), Z(z), 2.3, 0, Math.PI * 2);
      ctx.fillStyle = "#b23a2f";
      ctx.fill();
    }
    ctx.restore();
  }

  function drawLabels() {
    // Labels are part of the illustrated map, but they still need the same
    // collision discipline as a navigation layer.  The previous renderer
    // always used the authored offset, so the western gate/temple cluster
    // could stack several cream pills on top of one another.  Try a small set
    // of hand-map-friendly alternatives and keep the candidate with the
    // smallest overlap when a dense cluster has no free slot.
    const placed = [];
    const intersects = (a, b, gap = 8) => !(a.r + gap <= b.l || a.l - gap >= b.r || a.b + gap <= b.t || a.t - gap >= b.b);
    const overlapScore = (a) => placed.reduce((score, b) => {
      const w = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l));
      const h = Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
      return score + w * h;
    }, 0);
    for (const spot of SPOTS) {
      const anchorX = X(spot.x);
      const anchorY = Z(spot.z) - HY(spot.h);
      const compact = Boolean(spot.compact);
      const nameFont = `600 ${compact ? 15 : 19}px ${KAI}`;
      ctx.save();
      ctx.font = nameFont;
      const nameW = ctx.measureText(spot.name).width;
      const seal = compact ? 19 : 22;
      const w = seal + 8 + nameW + 14;
      const h = compact ? 29 : 34;
      const preferred = [spot.label[0], spot.label[1]];
      const alternatives = [
        preferred, [preferred[0], preferred[1] - 72], [preferred[0], preferred[1] + 72],
        [preferred[0] - 150, preferred[1]], [preferred[0] + 150, preferred[1]],
        [preferred[0] - 126, preferred[1] - 58], [preferred[0] + 126, preferred[1] - 58],
        [preferred[0] - 126, preferred[1] + 58], [preferred[0] + 126, preferred[1] + 58],
      ];
      const candidates = alternatives.map(([dx, dy]) => {
        const cx = Math.max(w / 2 + 18, Math.min(W - w / 2 - 18, anchorX + dx));
        const cy = Math.max(h / 2 + 18, Math.min(H - h / 2 - 18, anchorY + dy));
        return { l: cx - w / 2, t: cy - h / 2, r: cx + w / 2, b: cy + h / 2, cx, cy };
      });
      const rect = candidates.find(candidate => !placed.some(other => intersects(candidate, other)))
        || candidates.reduce((best, candidate) => overlapScore(candidate) < overlapScore(best) ? candidate : best);
      placed.push(rect);
      // Keep the collision list bounded to the map labels themselves; guide
      // lines and pins may sit underneath without making the map unreadable.
      if (placed.length > 40) placed.shift();
      const cx = rect.cx;
      const cy = rect.cy;

      // leader line
      const tx = clamp(anchorX, rect.l - 2, rect.r + 2);
      const ty = clamp(anchorY, rect.t - 2, rect.b + 2);
      ctx.beginPath();
      ctx.moveTo(anchorX, anchorY);
      ctx.lineTo(tx, ty);
      ctx.strokeStyle = "rgba(104,80,48,0.6)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // pin
      ctx.beginPath();
      ctx.arc(anchorX, anchorY, 7, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(244,232,206,0.7)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(anchorX, anchorY, 4.2, 0, Math.PI * 2);
      ctx.fillStyle = PAL.red;
      ctx.fill();
      ctx.strokeStyle = PAL.goldLight;
      ctx.lineWidth = 1.4;
      ctx.stroke();

      // pill shadow
      ctx.shadowColor = "rgba(40,31,20,0.25)";
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 4;
      roundRect(ctx, rect.l, rect.t, w, h, 6);
      ctx.fillStyle = "rgba(248,237,216,0.96)";
      ctx.fill();
      ctx.shadowColor = "transparent";

      // border
      roundRect(ctx, rect.l, rect.t, w, h, 6);
      ctx.strokeStyle = "rgba(135,104,63,0.7)";
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // number seal
      const bx = rect.l + 6;
      const by = rect.t + 6;
      roundRect(ctx, bx, by, seal, seal, 2);
      ctx.fillStyle = spot.no % 2 ? PAL.red : PAL.redDark;
      ctx.fill();
      ctx.strokeStyle = "rgba(237,207,148,0.65)";
      ctx.stroke();
      ctx.fillStyle = "#f2dba9";
      ctx.font = `600 ${compact ? 8 : 10}px ${SANS}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(spot.no).padStart(2, "0"), bx + seal / 2, by + seal / 2 + 0.5);

      // name
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = nameFont;
      ctx.fillStyle = "#2d2c22";
      ctx.fillText(spot.name, rect.l + seal + 13, rect.t + h / 2);

      // thin gold underline
      ctx.beginPath();
      ctx.moveTo(rect.l + seal + 13, rect.b - 5);
      ctx.lineTo(rect.l + seal + 13 + nameW, rect.b - 5);
      ctx.strokeStyle = "rgba(178,138,77,0.34)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }

  function spacedText(text, x, y, spacing) {
    let px = x;
    for (const ch of text) {
      ctx.fillText(ch, px, y);
      px += ctx.measureText(ch).width + spacing;
    }
  }

  function drawHeader() {
    ctx.save();
    // seal
    ctx.save();
    ctx.translate(82, 58);
    ctx.rotate(-0.035);
    ctx.fillStyle = PAL.red;
    ctx.fillRect(0, 0, 58, 58);
    ctx.strokeStyle = "rgba(246,216,165,0.72)";
    ctx.lineWidth = 1;
    ctx.strokeRect(4, 4, 50, 50);
    ctx.fillStyle = "#f6dfb7";
    ctx.font = `600 36px ${KAI}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("汴", 29, 31);
    ctx.restore();

    // eyebrow
    ctx.fillStyle = "rgba(67,78,55,0.62)";
    ctx.font = `500 10px ${SANS}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    spacedText("KAIFENG · NORTHERN SONG · 2.5D MAP STUDY", 164, 59, 2.2);

    // title
    ctx.fillStyle = "#3e4c3b";
    ctx.font = `500 62px ${KAI}`;
    ctx.fillText("万岁山", 160, 116);
    ctx.fillStyle = "#9a6b35";
    ctx.font = `500 43px ${KAI}`;
    ctx.fillText("大宋武侠城", 354, 115);

    // subtitle
    ctx.fillStyle = "rgba(74,78,54,0.72)";
    ctx.font = `400 17px ${SANS}`;
    ctx.fillText("2.5D 全园片区图 · 游览主轴 / 示意补全", 164, 146);
    ctx.restore();
  }

  function drawStamp() {
    const x = 2130;
    const y = 52;
    ctx.save();
    ctx.strokeStyle = "rgba(219,184,120,0.3)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, 190, 84);
    ctx.fillStyle = "rgba(7,25,28,0.5)";
    ctx.fillRect(x, y, 190, 84);
    ctx.fillStyle = PAL.goldLight;
    ctx.font = `500 38px ${KAI}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("01", x + 15, y + 41);
    ctx.fillStyle = "rgba(227,207,173,0.52)";
    ctx.font = `500 8px ${SANS}`;
    spacedText("SAMPLE AREA", x + 82, y + 26, 1.5);
    ctx.fillStyle = "rgba(232,214,183,0.62)";
    ctx.font = `400 10px ${SANS}`;
    ctx.fillText("全园片区 / 南北中轴", x + 82, y + 48);
    ctx.fillStyle = "rgba(216,195,159,0.34)";
    ctx.font = `400 8px ${SANS}`;
    ctx.fillText("35 VIEWPOINTS / 示意补全", x + 82, y + 66);
    ctx.restore();
  }

  function drawLegend() {
    const x = 300;
    const y = 1560;
    ctx.save();
    ctx.fillStyle = "rgba(226,207,174,0.48)";
    ctx.font = `400 13px ${SANS}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const entries = [
      { label: "主游览步道", color: "#d8b06a", width: 19, weight: 5 },
      { label: "次级步道", color: "#e0d8c4", width: 15, weight: 3 },
      { label: "服务道路", color: "#8b9ba2", width: 15, weight: 4 },
      { label: "推荐步行线", color: "#b23a2f", dashed: true },
      { label: "示意小径", color: "#b0a35f", dotted: true },
    ];
    let px = x;
    for (const e of entries) {
      ctx.save();
      ctx.strokeStyle = e.color;
      ctx.lineWidth = e.weight || 2;
      ctx.setLineDash(e.dashed ? [7, 5] : e.dotted ? [2, 5] : []);
      ctx.beginPath();
      ctx.moveTo(px, y);
      ctx.lineTo(px + (e.width || 18), y);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = "rgba(232,215,184,0.64)";
      ctx.font = `400 12px ${SANS}`;
      ctx.fillText(e.label, px + 24, y);
      px += ctx.measureText(e.label).width + 54;
    }
    ctx.restore();
  }

  function drawDistrictLegend() {
    const x = 1745;
    const y = 86;
    const w = 315;
    const h = 138;
    const entries = [
      ["水浒区", "#9cbfca"], ["仙侠区", "#b4cba0"], ["江湖艺术区", "#d4b2a3"],
      ["万岁山寺观区", "#b9c99a"], ["九龙水景区", "#92c4bd"], ["森林亲子区", "#a9c89c"],
    ];
    ctx.save();
    roundRect(ctx, x, y, w, h, 8);
    ctx.fillStyle = "rgba(8,31,32,0.76)";
    ctx.fill();
    ctx.strokeStyle = "rgba(205,177,117,0.38)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "rgba(237,220,184,0.88)";
    ctx.font = `600 12px ${SANS}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("片区分层 / 示意补全", x + 16, y + 18);
    entries.forEach(([label, color], i) => {
      const col = i < 3 ? 0 : 1;
      const row = i % 3;
      const px = x + 16 + col * 146;
      const py = y + 46 + row * 27;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.78;
      roundRect(ctx, px, py - 7, 16, 14, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(230,218,190,0.78)";
      ctx.font = `400 11px ${KAI}`;
      ctx.fillText(label, px + 24, py);
    });
    ctx.restore();
  }

  function drawFooter() {
    ctx.save();
    ctx.fillStyle = "rgba(210,190,156,0.28)";
    ctx.font = `400 9px ${SANS}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText("STYLISED 2.5D MAP · 35 VIEWPOINTS · 分区与新增景点为示意补全", 2310, 1562);
    ctx.restore();
  }

  function drawCompass() {
    const cx = 1990;
    const cy = 286;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.arc(0, 0, 35, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(238,227,207,0.45)";
    ctx.fill();
    ctx.strokeStyle = "rgba(116,92,58,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -27);
    ctx.lineTo(6, 2);
    ctx.lineTo(0, -5);
    ctx.lineTo(-6, 2);
    ctx.closePath();
    ctx.fillStyle = "#963f31";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, 27);
    ctx.lineTo(6, 1);
    ctx.lineTo(0, 5);
    ctx.lineTo(-6, 1);
    ctx.closePath();
    ctx.fillStyle = "rgba(89,74,51,0.55)";
    ctx.fill();
    ctx.fillStyle = "rgba(83,67,45,0.72)";
    ctx.font = `600 11px ${SANS}`;
    ctx.textAlign = "center";
    ctx.fillText("N", 0, -42);
    ctx.fillStyle = "rgba(83,67,45,0.42)";
    ctx.font = `400 7px ${SANS}`;
    ctx.fillText("北", 0, 47);
    ctx.restore();
  }

  function drawScale() {
    const x = 1732;
    const y = 1484;
    ctx.save();
    ctx.fillStyle = "rgba(238,224,199,0.72)";
    ctx.fillRect(x - 10, y - 20, 178, 44);
    ctx.strokeStyle = "rgba(128,101,63,0.5)";
    ctx.strokeRect(x - 10, y - 20, 178, 44);
    ctx.fillStyle = "#6b5b43";
    ctx.font = `500 10px ${SANS}`;
    ctx.textAlign = "left";
    ctx.fillText("示意尺度", x, y - 6);
    ctx.strokeStyle = "#6b5b43";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y + 9);
    ctx.lineTo(x + 120, y + 9);
    ctx.stroke();
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(x + i * 30, y + 4);
      ctx.lineTo(x + i * 30, y + 14);
      ctx.stroke();
    }
    ctx.fillStyle = "#6b5b43";
    ctx.font = `400 7px ${SANS}`;
    ctx.fillText("0", x + 2, y + 24);
    ctx.fillText("100m", x + 108, y + 24);
    ctx.restore();
  }

  function drawVignette() {
    const g = ctx.createRadialGradient(1200, 790, 380, 1200, 790, 1300);
    g.addColorStop(0, "rgba(4,15,18,0)");
    g.addColorStop(0.66, "rgba(74,60,36,0.025)");
    g.addColorStop(1, "rgba(74,60,36,0.12)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawGrain() {
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = makeNoisePattern(180, 0.085);
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  /* ----------------------------- render ----------------------------- */

  function render() {
    drawBackground();
    drawBoard();

    ctx.save();
    roundRect(ctx, MAP.x, MAP.y, MAP.w, MAP.h, 10);
    ctx.clip();
    drawTerrain();
    roadQueue.length = 0;
    drawRoads();
    items.sort((a, b) => a.z - b.z);
    for (const item of items) item.draw();

    // foreground temple pass: drawn over roads, trees and neighbouring roofs
    templeJobs.sort((a, b) => a.z - b.z);
    for (const job of templeJobs) job.draw();

    // soft veils of cloud over the wooded slopes
    ctx.save();
    ctx.filter = "blur(24px)";
    ctx.globalCompositeOperation = "screen";
    for (const [x, y, rx, ry] of [[520, 520, 260, 54], [1420, 610, 300, 60], [1840, 480, 210, 44], [1080, 820, 220, 30]]) {
      const cloud = ctx.createRadialGradient(x, y, 0, x, y, rx);
      cloud.addColorStop(0, "rgba(241,247,236,0.15)");
      cloud.addColorStop(0.6, "rgba(241,247,236,0.06)");
      cloud.addColorStop(1, "rgba(241,247,236,0)");
      ctx.fillStyle = cloud;
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, -0.08, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // soft afternoon light from the upper left
    ctx.save();
    ctx.globalCompositeOperation = "soft-light";
    const sunlight = ctx.createLinearGradient(MAP.x, MAP.y, MAP.x + MAP.w, MAP.y + MAP.h);
    sunlight.addColorStop(0, "rgba(255,239,198,0.4)");
    sunlight.addColorStop(0.55, "rgba(255,241,210,0.05)");
    sunlight.addColorStop(1, "rgba(60,42,24,0.2)");
    ctx.fillStyle = sunlight;
    ctx.fillRect(MAP.x, MAP.y, MAP.w, MAP.h);
    ctx.restore();

    // gentle edge shade inside the sheet
    ctx.save();
    roundRect(ctx, MAP.x, MAP.y, MAP.w, MAP.h, 10);
    ctx.clip();
    const innerShade = ctx.createRadialGradient(1200, 790, 480, 1200, 790, 1120);
    innerShade.addColorStop(0, "rgba(34,44,30,0)");
    innerShade.addColorStop(0.72, "rgba(34,44,30,0.03)");
    innerShade.addColorStop(1, "rgba(34,44,30,0.2)");
    ctx.fillStyle = innerShade;
    ctx.fillRect(MAP.x, MAP.y, MAP.w, MAP.h);
    ctx.restore();
    ctx.restore();

    finishBoard();
    drawVignette();
    drawGrain();
    if (DRAW_BASE_ROUTE && !PLAIN) drawTourRoute();
    if (!PLAIN) {
      drawHeader();
      drawStamp();
      drawCompass();
      drawScale();
      drawLabels();
      drawLegend();
      drawDistrictLegend();
      drawFooter();
    }

    window.__MAP_READY__ = true;
    window.__READY__ = true;
  }

  // first pass: collect road centrelines without painting, so trees and
  // generic houses can clear the road corridors before the scene is built
  planningRoads = true;
  drawRoads();
  planningRoads = false;

  buildScene();
  render();

  // Useful for a future layer editor: expose the scene groups without
  // coupling the printed map to any interactive control.
  window.__MAP_DEBUG__ = {
    spots: SPOTS,
    map: MAP,
    render,
  };
  window.WandashanMap2D = { render, spots: SPOTS, map: MAP, worldPoint: (x, z) => [X(x), Z(z)] };
})();
