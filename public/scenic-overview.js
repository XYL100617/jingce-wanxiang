/* Editorial route-overview map rebuilt from the supplied hand-drawn map's
 * approximate landmark distribution. This is C-only presentation geometry. */
(() => {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (name, attrs = {}, text = '') => {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text) node.textContent = text;
    return node;
  };
  const smoothPath = points => {
    const projected = points.map(point => window.ScenicMapLayout.overviewPoint(point));
    if (projected.length < 2) return '';
    if (projected.length === 2) return `M${projected[0][0].toFixed(1)},${projected[0][1].toFixed(1)} L${projected[1][0].toFixed(1)},${projected[1][1].toFixed(1)}`;
    let d = `M${projected[0][0].toFixed(1)},${projected[0][1].toFixed(1)}`;
    for (let index = 0; index < projected.length - 1; index++) {
      const p0 = projected[index - 1] || projected[index];
      const p1 = projected[index], p2 = projected[index + 1], p3 = projected[index + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  };
  const addText = (group, x, y, text, cls, anchor = 'middle') => group.append(svgEl('text', { x, y, class: cls, 'text-anchor': anchor }, text));

  function addTree(group, x, y, scale = 1, blossom = false) {
    const tree = svgEl('g', { class: `overview-tree${blossom ? ' is-blossom' : ''}`, transform: `translate(${x} ${y}) scale(${scale})` });
    tree.append(svgEl('ellipse', { cx: 2, cy: 10, rx: 17, ry: 6, class: 'overview-tree-shadow' }));
    tree.append(svgEl('path', { d: 'M0 9Q-2 0 0-10', class: 'overview-tree-trunk' }));
    const leaves = blossom
      ? [[-7,-13,9], [5,-15,10], [0,-23,9], [12,-8,8], [-12,-5,8]]
      : [[-7,-12,10], [5,-14,11], [0,-22,9], [12,-7,8], [-12,-5,8], [2,-5,10]];
    leaves.forEach(([cx, cy, r], index) => tree.append(svgEl('circle', { cx, cy, r, class: blossom ? `overview-blossom-leaf leaf-${index % 3}` : `overview-leaf leaf-${index % 3}` })));
    group.append(tree);
  }

  function addReferenceLandmark(group, item, labelPlacement) {
    const [x, y] = window.ScenicMapLayout.overviewPoint([item.x, item.y]);
    const g = svgEl('g', { class: `overview-reference overview-reference-${item.kind}`, transform: `translate(${x} ${y})`, 'data-reference-id': item.id });
    if (item.kind === 'gate') g.append(svgEl('path', { d:'M-15 10V-10L0-23L15-10V10M-21 10H21M-7 9V-7H7V9' }));
    else if (item.kind === 'water') g.append(svgEl('path', { d:'M-19 3Q-10-9 0 3T19 3Q10 15 0 3T-19 3Z' }));
    else if (item.kind === 'square') g.append(svgEl('polygon', { points:'0,-13 14,0 0,13 -14,0' }));
    else g.append(svgEl('path', { d:'M-18 10V-5L0-17L18-5V10H-18M-13-8L0-22L13-8' }));
    const dx = labelPlacement.x - x, dy = labelPlacement.y - y, width = labelPlacement.width;
    g.append(svgEl('path', { d:`M0 0 L${dx} ${dy > 0 ? dy - 11 : dy + 11}`, class:'overview-reference-leader' }));
    g.append(svgEl('rect', { x:dx-width/2, y:dy-12, width, height:24, rx:6, class:'overview-reference-label-bg', 'data-overview-label-box':'reference', 'data-label-x':x+dx-width/2, 'data-label-y':y+dy-12, 'data-label-width':width, 'data-label-height':24 }));
    if (item.poiNumber) {
      g.append(svgEl('rect',{x:dx-width/2+4,y:dy-8,width:20,height:16,rx:3,class:'overview-reference-number-bg'}));
      addText(g,dx-width/2+14,dy+3,String(item.poiNumber).padStart(2,'0'),'overview-reference-number');
      addText(g,dx-width/2+30,dy+4,item.name,'overview-reference-label','start');
    } else addText(g, dx, dy + 4, item.name, 'overview-reference-label');
    group.append(g);
  }

  function addBuilding(group, x, y, size, tone, label, type, id) {
    if (id === 'wanfo_tower') {
      const tower=svgEl('g',{class:'overview-landmark overview-pagoda',transform:`translate(${x} ${y})`});
      tower.append(svgEl('ellipse',{cx:0,cy:size*.27,rx:size*.44,ry:size*.12,class:'overview-building-shadow'}));
      for(let tier=0;tier<3;tier++){
        const width=size*(.56-tier*.095), top=size*(.15-tier*.29);
        tower.append(svgEl('path',{d:`M${-width*.38} ${top-8}H${width*.38}V${top+11}H${-width*.38}Z`,class:'overview-pagoda-wall'}));
        tower.append(svgEl('path',{d:`M${-width*.62} ${top-9}Q${-width*.45} ${top-15} 0 ${top-19}Q${width*.45} ${top-15} ${width*.62} ${top-9}L${width*.46} ${top-5}H${-width*.46}Z`,class:'overview-pagoda-roof'}));
        tower.append(svgEl('path',{d:`M${-width*.57} ${top-9}Q0 ${top-16} ${width*.57} ${top-9}`,class:'overview-pagoda-eave'}));
      }
      tower.append(svgEl('path',{d:`M0 ${-size*.66}V${-size*.74}`,class:'overview-pagoda-finial'}));
      group.append(tower);
      return;
    }
    if (['hero_square','xianxia_square','art_square','wulin_square','magic_square'].includes(id)) {
      const plaza=svgEl('g',{class:`overview-plaza overview-plaza-${id}`,transform:`translate(${x} ${y})`});
      plaza.append(svgEl('path',{d:`M${-size*.56} 7 Q${-size*.34} ${-size*.19} 0 ${-size*.15} Q${size*.34} ${-size*.19} ${size*.56} 7 L${size*.41} ${size*.25} Q0 ${size*.34} ${-size*.41} ${size*.25}Z`,class:'overview-plaza-ground'}));
      plaza.append(svgEl('path',{d:`M${-size*.39} 7 Q0 ${size*.2} ${size*.39} 7`,class:'overview-plaza-ring'}));
      if(id==='hero_square'||id==='wulin_square'){
        plaza.append(svgEl('path',{d:`M${-size*.2} ${size*.12} L${size*.14} ${-size*.34} M${size*.2} ${size*.12} L${-size*.14} ${-size*.34} M${-size*.24} ${size*.04} L${-size*.12} ${size*.12} M${size*.24} ${size*.04} L${size*.12} ${size*.12}`,class:'overview-plaza-swords'}));
        for(const side of [-1,1]) plaza.append(svgEl('path',{d:`M${side*size*.4} ${size*.08} V${-size*.37} L${side*size*.17} ${-size*.28} L${side*size*.4} ${-size*.17}Z`,class:'overview-plaza-flag'}));
      }else if(id==='art_square'){
        plaza.append(svgEl('path',{d:`M${-size*.32} 0 Q${-size*.08} ${-size*.32} ${size*.22} ${-size*.24} Q${size*.42} ${-size*.16} ${size*.23} ${size*.05} M${-size*.2} ${size*.1} Q0 ${-size*.08} ${size*.27} ${size*.08}`,class:'overview-plaza-ribbon'}));
      }else{
        plaza.append(svgEl('path',{d:`M0 ${-size*.4} L${size*.11} ${-size*.13} L${size*.39} ${-size*.08} L${size*.13} 0 L0 ${size*.22} L${-size*.13} 0 L${-size*.39} ${-size*.08} L${-size*.11} ${-size*.13}Z`,class:'overview-plaza-star'}));
      }
      group.append(plaza);
      return;
    }
    if (id === 'circus') {
      const tent=svgEl('g',{class:'overview-landmark overview-circus',transform:`translate(${x} ${y})`});
      tent.append(svgEl('ellipse',{cx:0,cy:size*.18,rx:size*.52,ry:size*.18,class:'overview-building-shadow'}));
      tent.append(svgEl('path',{d:`M${-size*.46} ${size*.12} Q${-size*.36} ${-size*.08} ${-size*.22} ${size*.12} L0 ${-size*.42} L${size*.22} ${size*.12} Q${size*.36} ${-size*.08} ${size*.46} ${size*.12}Z`,class:'overview-circus-canopy'}));
      tent.append(svgEl('path',{d:`M${-size*.46} ${size*.12} L${-size*.26} ${size*.12} L0 ${-size*.42}Z M${size*.26} ${size*.12} L${size*.46} ${size*.12} L0 ${-size*.42}Z`,class:'overview-circus-stripe'}));
      tent.append(svgEl('path',{d:`M${-size*.22} ${size*.12}L0 ${-size*.42}L${size*.22} ${size*.12} M0 ${-size*.42}V${size*.12}`,class:'overview-circus-seam'}));
      tent.append(svgEl('path',{d:`M${-size*.46} ${size*.12}H${size*.46}V${size*.3}H${-size*.46}Z`,class:'overview-circus-skirt'}));
      group.append(tent);
      return;
    }
    if (type === 'service' || id === 'rest') {
      const pavilion=svgEl('g',{class:`overview-landmark overview-service-pavilion overview-building-${id}`,transform:`translate(${x} ${y})`});
      pavilion.append(svgEl('ellipse',{cx:0,cy:size*.28,rx:size*.52,ry:size*.17,class:'overview-building-shadow'}));
      pavilion.append(svgEl('path',{d:`M${-size*.34} ${size*.12} L0 ${size*.22} L${size*.34} ${size*.12} V${size*.25} H${-size*.34}Z`,class:'overview-pavilion-platform'}));
      pavilion.append(svgEl('path',{d:`M${-size*.28} ${size*.12} V${-size*.1} M${size*.28} ${size*.12} V${-size*.1} M0 ${size*.13} V${-size*.13}`,class:'overview-pavilion-posts'}));
      pavilion.append(svgEl('path',{d:`M${-size*.58} ${-size*.08} Q${-size*.4} ${-size*.15} 0 ${-size*.42} Q${size*.4} ${-size*.15} ${size*.58} ${-size*.08} L${size*.4} ${-size*.01} H${-size*.4}Z`,class:'overview-pavilion-roof'}));
      pavilion.append(svgEl('path',{d:`M${-size*.56} ${-size*.08} Q0 ${-size*.18} ${size*.56} ${-size*.08}`,class:'overview-pavilion-eave'}));
      group.append(pavilion);
      return;
    }
    if (id === 'museum') {
      const hall=svgEl('g',{class:'overview-landmark overview-martial-hall',transform:`translate(${x} ${y})`});
      hall.append(svgEl('path',{d:`M${-size*.7} ${size*.25} L0 ${size*.43} L${size*.7} ${size*.25} L${size*.7} ${size*.39} Q0 ${size*.6} ${-size*.7} ${size*.39}Z`,class:'overview-hall-court'}));
      for(const side of [-1,1]){
        hall.append(svgEl('path',{d:`M${side*size*.36} ${size*.1} L${side*size*.72} ${size*.16} V${size*.32} L${side*size*.36} ${size*.27}Z`,class:'overview-martial-wing'}));
        hall.append(svgEl('path',{d:`M${side*size*.34} ${-size*.04} L${side*size*.55} ${-size*.18} L${side*size*.79} ${-size*.02} L${side*size*.64} ${size*.05} L${side*size*.37} ${size*.05}Z`,class:'overview-martial-roof'}));
        hall.append(svgEl('rect',{x:side<0?-size*.59:size*.48,y:size*.13,width:size*.11,height:size*.11,rx:1,class:'overview-window'}));
      }
      hall.append(svgEl('path',{d:`M${-size*.37} ${-size*.09} L0 ${-size*.31} L${size*.37} ${-size*.09} V${size*.31} L0 ${size*.38} L${-size*.37} ${size*.31}Z`,class:'overview-martial-front'}));
      hall.append(svgEl('path',{d:`M${-size*.49} ${-size*.13} Q${-size*.34} ${-size*.2} 0 ${-size*.43} Q${size*.34} ${-size*.2} ${size*.49} ${-size*.13} L${size*.37} ${-size*.03} L0 ${-size*.18} L${-size*.37} ${-size*.03}Z`,class:'overview-martial-roof'}));
      hall.append(svgEl('path',{d:`M${-size*.44} ${-size*.12} Q0 ${-size*.25} ${size*.44} ${-size*.12} M${-size*.26} ${size*.11} H${size*.26}`,class:'overview-martial-eave'}));
      hall.append(svgEl('path',{d:`M${-size*.1} ${size*.12} Q0 ${size*.03} ${size*.1} ${size*.12} V${size*.37} H${-size*.1}Z`,class:'overview-building-door'}));
      hall.append(svgEl('path',{d:`M${-size*.14} ${size*.37} H${size*.14}`,class:'overview-building-step'}));
      group.append(hall);
      return;
    }
    const g = svgEl('g', { class: `overview-landmark overview-${type || 'culture'} overview-building-${id}`, transform: `translate(${x} ${y})` });
    const w = size, h = size * .5;
    g.append(svgEl('ellipse', { cx: 1, cy: h*.64, rx: w*.67, ry: h*.29, class: 'overview-building-shadow' }));
    // A shallow side wing and stone terrace give the little buildings a
    // hand-painted 2.5D footprint instead of a row of identical flat icons.
    g.append(svgEl('path',{d:`M${-w*.55} ${h*.38} L${-w*.38} ${h*.2} L${w*.53} ${h*.2} L${w*.64} ${h*.34} L${w*.47} ${h*.54} L${-w*.43} ${h*.54}Z`,class:'overview-building-terrace'}));
    g.append(svgEl('path',{d:`M${w*.3} ${-h*.04} L${w*.51} ${-h*.16} L${w*.51} ${h*.37} L${w*.3} ${h*.47}Z`,class:'overview-building-side'}));
    // Low plinth and a readable, front-facing timber hall, based on the
    // supplied 大宋武馆 icon rather than the earlier generic isometric box.
    g.append(svgEl('path', { d:`M${-w*.48} ${h*.38} L0 ${h*.52} L${w*.48} ${h*.38} L0 ${h*.27}Z`, class:'overview-building-plinth' }));
    g.append(svgEl('path', { d:`M${-w*.42} ${-h*.02} L0 ${-h*.13} L${w*.42} ${-h*.02} V${h*.43} L0 ${h*.5} L${-w*.42} ${h*.43}Z`, class:'overview-building-front' }));
    g.append(svgEl('path', { d:`M${-w*.4} ${h*.08} H${w*.4} M${-w*.4} ${h*.35} H${w*.4}`, class:'overview-timber-beam' }));
    for (const wx of [-.29,.29]) {
      const cx = w*wx;
      g.append(svgEl('rect',{x:cx-w*.047,y:h*.11,width:w*.094,height:h*.16,rx:1.5,class:'overview-window'}));
      g.append(svgEl('path',{d:`M${cx-w*.05} ${h*.12} H${cx+w*.05} M${cx} ${h*.12} V${h*.26}`,class:'overview-window-lattice'}));
    }
    // Recessed central entrance with pale jambs, matching the reference icon.
    g.append(svgEl('path',{d:`M${-w*.12} ${h*.18} Q0 ${h*.09} ${w*.12} ${h*.18} V${h*.5} H${-w*.12}Z`,class:'overview-building-door'}));
    g.append(svgEl('path',{d:`M${-w*.15} ${h*.19} V${h*.49} M${w*.15} ${h*.19} V${h*.49} M${-w*.2} ${h*.51} H${w*.2}`,class:'overview-building-step'}));
    const roof = (scale = 1, lift = 0) => {
      const rw=w*scale, top=-h*.13-lift, rise=h*.34*scale;
      // Broad double-eave silhouette with raised corners and a gabled face.
      g.append(svgEl('path',{d:`M${-rw*.62} ${top+h*.1} Q${-rw*.5} ${top-h*.12} ${-rw*.38} ${top+h*.02} L0 ${top-rise} L${rw*.38} ${top+h*.02} Q${rw*.5} ${top-h*.12} ${rw*.62} ${top+h*.1} L${rw*.48} ${top+h*.21} L0 ${top+h*.08} L${-rw*.48} ${top+h*.21}Z`,class:`overview-roof ${tone}`}));
      g.append(svgEl('path',{d:`M${-rw*.62} ${top+h*.1} Q0 ${top+h*.34} ${rw*.62} ${top+h*.1}`,class:'overview-roof-eave'}));
      g.append(svgEl('path',{d:`M${-rw*.38} ${top+h*.02} L0 ${top-rise} L${rw*.38} ${top+h*.02}`,class:'overview-roof-ridge'}));
      g.append(svgEl('path',{d:`M${-rw*.31} ${top+h*.1} L0 ${top+h*.03} L${rw*.31} ${top+h*.1} L0 ${top+h*.31}Z`,class:'overview-roof-gable'}));
      for(const side of [-1,1]) g.append(svgEl('path',{d:`M${side*rw*.31} ${top+h*.01} L${side*rw*.43} ${top+h*.16}`,class:'overview-roof-rib'}));
    };
    roof();
    if (['temple','shenboat'].includes(id)) {
      // A visible upper storey joins the two roof tiers; a roof drawn alone
      // looked like a separate building floating above the main hall.
      g.append(svgEl('path',{d:`M${-w*.19} ${-h*.31} L0 ${-h*.37} L${w*.19} ${-h*.31} V${-h*.03} L0 ${h*.02} L${-w*.19} ${-h*.03}Z`,class:'overview-building-upper-storey'}));
      g.append(svgEl('path',{d:`M${-w*.1} ${-h*.21} H${w*.1} M0 ${-h*.21} V${-h*.07}`,class:'overview-upper-window'}));
      roof(.54,h*.26);
    }
    if (['temple','museum','juxianzhuang'].includes(id)) {
      g.append(svgEl('path',{d:`M${-w*.58} ${h*.48} H${w*.58} M${-w*.5} ${h*.55} H${w*.5} M${-w*.53} ${h*.45} V${h*.59} M${w*.53} ${h*.45} V${h*.59}`,class:'overview-hall-court'}));
    }
    if (id === 'fortress') {
      g.append(svgEl('path',{d:`M${-w*.55} ${h*.4} V${h*.02} H${-w*.34} V${-h*.1} H${-w*.17} V${h*.02} H${w*.17} V${-h*.1} H${w*.34} V${h*.02} H${w*.55} V${h*.4}`,class:'overview-fortress-wall'}));
    }
    if (['shenboat','kuaipolin'].includes(id)) {
      g.append(svgEl('path',{d:`M${-w*.42} ${h*.43} L${-w*.62} ${h*.3} V${h*.08} L${-w*.4} ${h*.16} M${w*.42} ${h*.43} L${w*.62} ${h*.3} V${h*.08} L${w*.4} ${h*.16}`,class:'overview-hall-wing'}));
    }
    if (type === 'show') {
      for (const side of [-1,1]) g.append(svgEl('path',{d:`M${side*w*.46} ${h*.1} l${side*w*.08} -${h*.16} v${h*.3} l${-side*w*.08} ${h*.08}Z`,class:'overview-stage-banner'}));
    }
    if (['market','retro_block','water_street'].includes(id)) {
      for (const side of [-1,1]) {
        // Shopfronts overlap the main hall instead of hovering beside it.
        g.append(svgEl('path',{d:`M${side*w*.39} ${h*.12} L${side*w*.78} ${h*.1} L${side*w*.78} ${h*.48} L${side*w*.39} ${h*.49}Z`,class:'overview-market-stall'}));
        g.append(svgEl('path',{d:`M${side*w*.38} ${h*.11} L${side*w*.64} ${-h*.12} L${side*w*.85} ${h*.11}Z`,class:'overview-market-awning'}));
        g.append(svgEl('path',{d:`M${side*w*.5} ${h*.24} V${h*.44} M${side*w*.68} ${h*.23} V${h*.43}`,class:'overview-market-posts'}));
      }
    }
    if (['temple','juxianzhuang','museum','shenboat'].includes(id)) {
      for (const side of [-1,1]) {
        g.append(svgEl('circle',{cx:side*w*.47,cy:h*.27,r:3.8,class:'overview-hall-lantern'}));
        g.append(svgEl('path',{d:`M${side*w*.46} ${h*.1}V${h*.4}`,class:'overview-hall-column'}));
      }
    }
    group.append(g);
  }

  function addGate(group, x, y, id) {
    const scale=id==='southgate'?1.22:id==='eastgate'?1.08:1;
    const g=svgEl('g',{class:`overview-gate overview-gate-${id}`,transform:`translate(${x} ${y}) scale(${scale})`});
    g.append(svgEl('ellipse',{cx:0,cy:20,rx:43,ry:11,class:'overview-building-shadow'}));
    g.append(svgEl('path',{d:'M-43 20L-43 -9L43 -9L43 20L20 20L20 1Q0 -13 -20 1L-20 20Z',class:'overview-gate-wall'}));
    g.append(svgEl('path',{d:'M-24 20V3Q0 -17 24 3V20Z',class:'overview-gate-arch'}));
    g.append(svgEl('path',{d:'M-50 -10L-36 -15L-30 -27L0 -35L30 -27L36 -15L50 -10L35 -6L0 -12L-35 -6Z',class:'overview-gate-roof'}));
    g.append(svgEl('path',{d:'M-34 -23L0 -35L34 -23M-45 -10Q0 -18 45 -10',class:'overview-gate-ridge'}));
    for(const side of [-1,1]) {
      g.append(svgEl('rect',{x:side<0?-38:29,y:-6,width:9,height:14,rx:1,class:'overview-gate-window'}));
      g.append(svgEl('circle',{cx:side*36,cy:-9,r:3,class:'overview-gate-lantern'}));
    }
    group.append(g);
  }

  function visualSize(node) {
    const id=node.node_id || node.id;
    let size=node.type==='gate'?(id==='southgate'?88:id==='eastgate'?78:72)
      :node.type==='show'?76
      :node.type==='service'?48
      :node.type==='scenery'?58
      :id==='temple'?100
      :['shenboat','wanfo_tower','museum','juxianzhuang'].includes(id)?88
      :['market','fortress','theater','longtan'].includes(id)?72:58;
    // Close rows are intentional old-town clusters, but icons still need a
    // readable size hierarchy instead of overlapping roofs. Protect the
    // principal gates, the main temple and the performance-stage silhouette;
    // let nearby secondary halls and markers step down into smaller scale.
    const anchors=window.ScenicMapLayout?.nodes||{},point=anchors[id];
    const protectedIds=new Set(['gate','southgate','westgate','eastgate','temple','theater','shenboat']);
    if(point&&!protectedIds.has(id)){
      let nearest=Infinity;
      for(const [otherId,other] of Object.entries(anchors)) if(otherId!==id) nearest=Math.min(nearest,Math.hypot(point[0]-other[0],point[1]-other[1]));
      const factor=nearest<44?.5:nearest<58?.62:nearest<76?.76:nearest<94?.88:1;
      size*=factor;
    }
    return size;
  }

  function addSceneryMark(group, id, x, y, size) {
    const g = svgEl('g', { class:`overview-scenery-mark overview-scenery-${id}`, transform:`translate(${x} ${y})` });
    if (id === 'lake') {
      // A compact cascade mark belongs to 九龙瀑; the pool itself is drawn
      // separately from the named-water polygons in the terrain layer.
      g.append(svgEl('path',{d:`M${-size*.46} ${-size*.39} Q${-size*.3} ${-size*.55} ${-size*.12} ${-size*.43} Q${size*.08} ${-size*.62} ${size*.32} ${-size*.42} L${size*.42} ${size*.02} Q${size*.28} ${size*.16} ${size*.17} ${size*.12} L${-size*.35} ${size*.13}Z`,class:'overview-fall-rock'}));
      g.append(svgEl('path',{d:`M${-size*.39} ${-size*.32} Q0 ${-size*.43} ${size*.36} ${-size*.32} M${-size*.31} ${size*.1} Q0 ${size*.03} ${size*.28} ${size*.09}`,class:'overview-fall-rock-detail'}));
      g.append(svgEl('path',{d:`M${-size*.29} ${-size*.29} Q${-size*.05} ${-size*.35} ${size*.24} ${-size*.29} C${size*.16} ${-size*.07} ${size*.24} ${size*.12} ${size*.14} ${size*.31} Q${-size*.02} ${size*.4} ${-size*.24} ${size*.32} C${-size*.31} ${size*.12} ${-size*.21} ${-size*.08} ${-size*.29} ${-size*.29}Z`,class:'overview-fall-water'}));
      g.append(svgEl('path',{d:`M${-size*.15} ${-size*.25} C${-size*.12} ${-size*.04} ${-size*.18} ${size*.13} ${-size*.11} ${size*.27} M${size*.04} ${-size*.24} C${size*.02} ${-size*.04} ${size*.11} ${size*.12} ${size*.06} ${size*.28}`,class:'overview-fall-water-detail'}));
      g.append(svgEl('path',{d:`M${-size*.42} ${size*.3} Q${-size*.27} ${size*.22} ${-size*.13} ${size*.28} Q0 ${size*.2} ${size*.14} ${size*.27} Q${size*.3} ${size*.23} ${size*.44} ${size*.31} Q${size*.16} ${size*.46} 0 ${size*.38} Q${-size*.25} ${size*.46} ${-size*.42} ${size*.3}Z`,class:'overview-fall-pool'}));
      g.append(svgEl('path',{d:`M${-size*.48} ${size*.36} q${size*.08} ${-size*.05} ${size*.14} 0 M${size*.31} ${size*.39} q${size*.1} ${-size*.04} ${size*.16} 0`,class:'overview-fall-spray'}));
    } else if (id === 'qianqiu_lake' || id === 'wanshou_lake') {
      g.append(svgEl('path',{d:`M${-size*.2} ${-size*.03} Q0 ${-size*.13} ${size*.2} ${-size*.03} M${-size*.12} ${size*.1} Q0 ${size*.04} ${size*.13} ${size*.1}`,class:'overview-lake-mark' }));
    } else {
      addTree(g,-size*.2,size*.08,.9,false); addTree(g,size*.12,-size*.06,1.05,false); addTree(g,size*.34,size*.12,.78,id==='children_park');
    }
    group.append(g);
  }

  function addStageBase(group, x, y, size) {
    // The hall itself is centred at y-25. Its front wall ends near y-8, so
    // the stage must rise beneath that wall instead of hovering 20px below it.
    group.append(svgEl('ellipse',{cx:x,cy:y-4,rx:size*.62,ry:size*.22,class:'overview-stage-base'}));
    group.append(svgEl('ellipse',{cx:x,cy:y-7,rx:size*.49,ry:size*.15,class:'overview-stage-ring'}));
    group.append(svgEl('path',{d:`M${x-size*.47} ${y-1} Q${x} ${y+size*.28} ${x+size*.47} ${y-1} M${x-size*.32} ${y+2} Q${x} ${y+size*.22} ${x+size*.32} ${y+2}`,class:'overview-stage-seating'}));
  }

  function addWallLookout(group, x, y, size) {
    const g=svgEl('g',{class:'overview-lookout',transform:`translate(${x} ${y})`});
    g.append(svgEl('path',{d:`M${-size*.45} ${size*.18} V${-size*.08} L${-size*.31} ${-size*.08} V${-size*.27} L${-size*.2} ${-size*.27} V${-size*.1} H${size*.2} V${-size*.27} L${size*.31} ${-size*.27} V${-size*.08} L${size*.45} ${-size*.08} V${size*.18}Z`,class:'overview-wall-body'}));
    g.append(svgEl('path',{d:`M${-size*.5} ${size*.19} H${size*.5} M${-size*.3} ${-size*.11} V${size*.1} M0 ${-size*.11} V${size*.1} M${size*.3} ${-size*.11} V${size*.1}`,class:'overview-wall-detail'}));
    group.append(g);
  }

  function nodeFootprint(node, x, y, size) {
    const id = node.node_id || node.id;
    if (node.type === 'gate') { const extent=id==='southgate'?63:id==='eastgate'?56:51; return { left:x-extent,right:x+extent,top:y-44,bottom:y+25 }; }
    if (node.type === 'scenery') return { left:x-size*.52,right:x+size*.52,top:y-12-size*.52,bottom:y-12+size*.5 };
    if (node.type === 'view') return { left:x-size*.52,right:x+size*.52,top:y-size*.42,bottom:y+size*.24 };
    const widthFactor=['market','retro_block','water_street'].includes(id)? .84 : ['temple','museum','juxianzhuang'].includes(id)? .74 : .66;
    const roofHeight=id==='wanfo_tower'? .76 : ['temple','museum','shenboat','juxianzhuang'].includes(id)? .49 : .29;
    return {
      left:x-size*widthFactor,right:x+size*widthFactor,
      top:y-25-size*roofHeight,
      bottom:node.type==='show'?y+size*.23:y-25+size*.56
    };
  }

  function addNodeLabel(group, node, x, y, size, width, height, dx, dy) {
    const id = node.node_id || node.id, name = window.ScenicMapLayout.displayNames?.[id] || node.name;
    const number = window.ScenicMapLayout.nodeNumbers?.[id], left = x + dx - width / 2, top = y + dy - height / 2;
    const g = svgEl('g', { class:'overview-node-label', 'data-overview-node-label':id,
      'data-label-x':left, 'data-label-y':top, 'data-label-width':width, 'data-label-height':height });
    const footprint=nodeFootprint(node,x,y,size);
    const targetX=left+width/2;
    const targetY=top+height/2;
    const dxToLabel=targetX-x,dyToLabel=targetY-y;
    const scale=1/Math.max(Math.abs(dxToLabel)/((footprint.right-footprint.left)/2),Math.abs(dyToLabel)/((footprint.bottom-footprint.top)/2),1);
    const startX=x+dxToLabel*scale,startY=y+dyToLabel*scale;
    const endX=Math.max(left+4,Math.min(startX,left+width-4));
    const endY=Math.max(top+4,Math.min(startY,top+height-4));
    const leaderLength=Math.hypot(endX-startX,endY-startY);
    if (leaderLength>5) g.append(svgEl('path', { d:`M${startX} ${startY} L${endX} ${endY}`, class:'overview-label-leader' }));
    if (leaderLength>20) g.append(svgEl('circle',{cx:startX,cy:startY,r:2.3,class:'overview-label-anchor'}));
    g.append(svgEl('rect', { x:left, y:top, width, height, rx:6, class:'overview-label-bg' }));
    if (number) {
      g.append(svgEl('rect', { x:left + 5, y:top + 5, width:20, height:height - 10, rx:3, class:'overview-number-seal' }));
      addText(g, left + 15, top + height/2 + 4, String(number).padStart(2, '0'), 'overview-number');
      addText(g, left + 32, top + height/2 + 5, name, 'overview-label', 'start');
    } else addText(g, x + dx, top + height/2 + 5, name, 'overview-label');
    group.append(g);
  }

  const intersects = (a, b, gap = 0) => !(a.right + gap <= b.left || a.left - gap >= b.right || a.bottom + gap <= b.top || a.top - gap >= b.bottom);
  function chooseNodeLabel(node, x, y, size, obstacles, labels) {
    const id = node.node_id || node.id, name = window.ScenicMapLayout.displayNames?.[id] || node.name;
    const width = Math.max(78, [...name].length * 14 + (window.ScenicMapLayout.nodeNumbers?.[id] ? 38 : 18)), height = 25;
    // Label cards nearly kiss the eaves (with a small breathing gap) so the
    // eye can associate each name with its own roof without long callouts.
    const footprint=nodeFootprint(node,x,y,size);
    const side = width / 2 + (footprint.right-x) + 2, buildingY = (footprint.top+footprint.bottom)/2-y;
    // Keep the paper tag tucked close to its own building. If this first ring
    // is occupied, expand only a little; never throw the label across a road.
    const candidates = [[-side,buildingY],[side,buildingY],[0,footprint.top-y-height/2-2],[0,footprint.bottom-y+height/2+2]];
    // Dense clusters get a small, controlled orbit around their own building.
    // Never fall back to a colliding label: an unlabelled secondary marker is
    // less misleading than text laid over another POI.
    for (const radius of [side + 8, side + 22, side + 38, side + 56, side + 76, side + 98, side + 122]) {
      for (let angle = 0; angle < 360; angle += 12) {
        const radians = angle * Math.PI / 180;
        candidates.push([Math.cos(radians) * radius, buildingY + Math.sin(radians) * radius * .62]);
      }
    }
    const ownId = id;
    let best = null, bestScore = Infinity;
    for (const [dx,dy] of candidates) {
      const left = x + dx - width/2, top = y + dy - height/2;
      if (left < 8 || left + width > 2552 || top < -22 || top + height > 522) continue;
      const box = {left,top,right:left+width,bottom:top+height};
      // A label may never cover another roof, another label or the district
      // title. Soft penalties previously selected exactly those collisions.
      if (obstacles.some(obstacle => intersects(box, obstacle.box, obstacle.id === ownId ? 0 : 5))) continue;
      if (labels.some(prior => intersects(box, prior, 5))) continue;
      const preferred = Math.hypot(dx,dy) * .018;
      const score = preferred + Math.abs(dy + 25) * .003;
      if (score < bestScore) { bestScore = score; best = {dx,dy,box,width,height}; }
      if (score < preferred + 0.001) break;
    }
    if (!best) return null;
    labels.push(best.box);
    return best;
  }

  function findOpenLabelPosition(node, x, y, size, obstacles, labels) {
    const id=node.node_id || node.id;
    const name=window.ScenicMapLayout.displayNames?.[id] || node.name;
    const width=Math.max(78,[...name].length*14+38),height=25;
    let best=null,bestDistance=Infinity;
    // Crowded landmark chains occasionally need a label outside the first
    // ring. Search the whole board for the nearest genuinely clear tag slot;
    // the previous emergency offset ignored collision checks and caused the
    // very roof/text overlaps visible in the comparison screenshots.
    for(let top=-18;top+height<526;top+=22){
      for(let left=8;left+width<2552;left+=28){
        const box={left,top,right:left+width,bottom:top+height};
        if(obstacles.some(obstacle=>intersects(box,obstacle.box,4))) continue;
        if(labels.some(other=>intersects(box,other,6))) continue;
        const distance=Math.hypot(left+width/2-x,top+height/2-(y-25));
        if(distance<bestDistance){bestDistance=distance;best={dx:left+width/2-x,dy:top+height/2-y,width,height,box};}
      }
    }
    if(best) labels.push(best.box);
    return best;
  }

  function draw(selector, graph) {
    const root = typeof selector === 'string' ? document.querySelector(selector) : selector;
    const layout = window.ScenicMapLayout;
    if (!root || !layout || !graph) return;
    // Add a quiet northern margin without moving the shared A/B/C coordinates.
    // The same viewBox is used by the route overlay so every route stays aligned.
    root.setAttribute('viewBox', `0 -40 ${layout.width} 591`);
    root.setAttribute('preserveAspectRatio', 'none');
    root.replaceChildren();
    const defs = svgEl('defs');
    const ground = svgEl('linearGradient', { id: 'overviewGround', x1: 0, y1: 0, x2: 1, y2: 1 });
    ground.append(svgEl('stop', { offset: '0%', 'stop-color': '#d2d4aa' }), svgEl('stop', { offset: '42%', 'stop-color': '#bac79a' }), svgEl('stop', { offset: '100%', 'stop-color': '#91a47b' }));
    const water = svgEl('linearGradient', { id: 'overviewWater', x1: 0, y1: 0, x2: 0.8, y2: 1 });
    water.append(svgEl('stop', { offset: '0%', 'stop-color': '#a5c5b7' }), svgEl('stop', { offset: '55%', 'stop-color': '#6f9b8d' }), svgEl('stop', { offset: '100%', 'stop-color': '#4e7e76' }));
    const paper = svgEl('linearGradient', { id: 'overviewPaper', x1: 0, y1: 0, x2: 1, y2: 1 });
    paper.append(svgEl('stop', { offset: '0%', 'stop-color': '#e2dcba' }), svgEl('stop', { offset: '52%', 'stop-color': '#d4d1a9' }), svgEl('stop', { offset: '100%', 'stop-color': '#c2c59a' }));
    const groundTexture = svgEl('pattern',{id:'overviewGroundTexture',width:268,height:216,patternUnits:'userSpaceOnUse'});
    groundTexture.append(svgEl('rect',{width:268,height:216,fill:'#b7c397'}));
    [[18,29,1.7],[72,69,1.1],[156,27,1.5],[231,83,1.2],[36,176,1.4],[128,139,1.1],[198,193,1.6],[250,157,1.1]].forEach(([cx,cy,r])=>groundTexture.append(svgEl('circle',{cx,cy,r,fill:'#637d5d',opacity:.12})));
    [[49,104,25,11],[184,121,34,13],[106,202,20,8]].forEach(([cx,cy,rx,ry])=>groundTexture.append(svgEl('ellipse',{cx,cy,rx,ry,fill:'#e1d9b3',opacity:.09})));
    [[35,46],[111,87],[221,45],[78,168],[240,190]].forEach(([x,y])=>groundTexture.append(svgEl('path',{d:`M${x} ${y}q4 -3 7 -1`,fill:'none',stroke:'#5c805a','stroke-width':.8,opacity:.16})));
    const hillWash=svgEl('linearGradient',{id:'overviewHillWash',x1:0,y1:0,x2:0.6,y2:1});
    hillWash.append(svgEl('stop',{offset:'0%','stop-color':'#4e7957','stop-opacity':.25}),svgEl('stop',{offset:'65%','stop-color':'#6d9269','stop-opacity':.19}),svgEl('stop',{offset:'100%','stop-color':'#98b489','stop-opacity':.05}));
    const mistWash=svgEl('radialGradient',{id:'overviewMist'});
    mistWash.append(svgEl('stop',{offset:'0%','stop-color':'#f6efcf','stop-opacity':.42}),svgEl('stop',{offset:'100%','stop-color':'#f6efcf','stop-opacity':0}));
    const shadow = svgEl('filter', { id: 'overviewSoftShadow', x: '-30%', y: '-30%', width: '160%', height: '180%' });
    shadow.append(svgEl('feGaussianBlur', { stdDeviation: '3' }));
    defs.append(ground, water, paper, groundTexture, hillWash, mistWash, shadow); root.append(defs);
    root.append(svgEl('rect', { x:0, y:-40, width:layout.width, height:591, class: 'overview-ground' }));
    root.append(svgEl('rect', { x: 10, y: -34, width: layout.width-20, height: 579, rx: 10, class: 'overview-board' }));
    root.append(svgEl('path', { d: `M20 -24H${layout.width-20}V535H20Z`, class: 'overview-board-inset' }));
    const terrain = svgEl('g', { class: 'overview-terrain' });
    const fromPoster = point => layout.overviewPoint(point);
    // Preserve the landscape footprint and the original vertical spacing.
    // The northern boundary is gently irregular; the park remains one
    // continuous land surface down to the south entrance and garden margin.
    terrain.append(svgEl('path', { d: 'M18 3 C250 -6 432 11 628 3 C850 -7 1030 9 1240 1 C1450 -7 1685 10 1888 1 C2130 -8 2340 8 2542 -1 L2542 514 C2340 520 2150 509 1940 517 C1695 524 1488 510 1260 519 C1025 524 810 512 600 520 C382 526 180 510 18 518Z', class: 'overview-park' }));
    [
      'M38 80 C105 53 170 67 218 95 C281 61 350 75 402 115 C378 155 309 176 232 174 C151 170 91 150 38 126Z',
      'M410 91 C471 63 550 68 612 100 C648 143 608 193 549 215 C483 227 423 187 390 143Z',
      'M706 75 C788 53 879 67 949 113 C981 152 947 198 891 211 C810 207 736 175 697 129Z',
      'M1285 70 C1365 43 1468 50 1531 82 C1582 126 1537 177 1461 181 C1388 176 1313 151 1275 115Z',
      'M1659 86 C1750 54 1867 65 1934 109 C1957 150 1914 196 1847 215 C1766 207 1694 177 1652 131Z',
      'M2075 79 C2183 45 2341 67 2416 109 C2457 159 2429 215 2356 234 C2255 223 2155 182 2092 133Z'
    ].forEach((path,index)=>{
      terrain.append(svgEl('path',{d:path,transform:'translate(5 9)',class:'overview-hill-shoulder'}));
      terrain.append(svgEl('path',{d:path,class:`overview-grove overview-grove-${index%3}`}));
    });
    [
      'M32 388 C98 348 192 351 258 385 C335 365 430 382 492 424 C432 456 354 445 296 469 C195 465 100 448 32 410Z',
      'M675 447 C760 398 847 404 909 429 C983 392 1088 403 1157 445 C1257 423 1357 435 1418 477 C1300 504 1192 482 1118 489 C1006 468 902 490 813 478 C744 477 703 470 675 447Z',
      'M1557 438 C1666 394 1775 402 1850 438 C1938 410 2049 425 2118 458 C2223 432 2339 452 2474 479 C2389 503 2254 501 2134 486 C2025 509 1929 487 1828 482 C1725 497 1627 476 1557 438Z'
    ].forEach(path=>terrain.append(svgEl('path',{d:path,class:'overview-south-swell'})));
    [[400,196,290,38],[1050,205,320,34],[1710,205,330,36],[2280,226,280,30]].forEach(([cx,cy,rx,ry])=>terrain.append(svgEl('ellipse',{cx,cy,rx,ry,fill:'url(#overviewMist)',class:'overview-terrain-mist'})));
    // Shade only the compact attraction clusters that belong to each named
    // district. The park is not three continuous west-to-east bands: neutral
    // land between attractions stays neutral, and outlying POIs remain outside
    // a tinted district unless the source places them inside one.
    const areas = [
      // District tint follows compact attraction pockets, not the whole land
      // between them. These separate lobes leave the circulation corridors
      // and unassigned open ground in the neutral park color.
      ['water-margin','水浒区','M51 91 C80 32 215 24 340 49 C430 35 526 47 594 81 C680 48 794 48 883 72 C1011 71 1143 111 1182 166 C1218 219 1147 259 1050 250 C953 277 859 257 782 241 C684 265 594 265 509 246 C399 272 299 259 222 240 C122 237 44 192 42 141 C36 121 40 103 51 91Z'],
      // Xianxia sits in several separated courts along its own path; the
      // empty space between the courts remains untinted.
      ['xianxia','仙侠区','M1290 123 C1327 62 1444 52 1535 79 C1647 56 1750 72 1813 105 C1910 111 1990 150 2012 188 C2015 229 1943 244 1879 228 C1804 256 1703 243 1634 219 C1553 224 1513 199 1475 205 C1433 219 1447 273 1398 294 C1352 309 1315 283 1332 242 C1355 202 1322 157 1290 123Z'],
      // The east-side arts district is limited to the named attraction
      // cluster and garden pocket; it no longer paints one broad rectangle.
      ['jianghu','江湖艺术区','M2080 158 C2117 111 2234 104 2321 126 C2414 128 2490 172 2505 217 C2501 260 2466 275 2425 270 C2409 314 2351 334 2293 314 C2221 324 2139 291 2119 256 C2083 224 2062 184 2080 158Z']
    ];
    for (const [key,name,path] of areas) {
      terrain.append(svgEl('path',{d:path,class:`overview-area overview-area-${key}`}));
      const center = key === 'water-margin' ? [920,276] : key === 'xianxia' ? [1670,270] : [2265,326];
      (terrain._districtTitles ||= []).push({name,key,center});
    }
    // Narrow garden corridors make each signed district entrance visibly
    // belong to its attraction pocket without tinting the whole intervening
    // park into three artificial horizontal bands.
    const entranceLinks = [
      ['water-margin','M888 158 C905 171 931 198 934 231 C939 273 912 306 911 346 L878 346 C880 302 909 267 905 231 C901 198 882 178 888 158Z'],
      ['xianxia','M1784 203 C1798 226 1795 253 1787 274 C1779 292 1782 307 1784 325 L1753 325 C1746 298 1759 278 1765 256 C1772 229 1764 216 1784 203Z'],
      ['jianghu','M2438 218 C2458 238 2455 266 2451 291 C2447 318 2460 343 2472 369 L2433 369 C2415 343 2418 315 2426 289 C2434 261 2421 235 2438 218Z']
    ];
    for(const [key,path] of entranceLinks) terrain.append(svgEl('path',{d:path,class:`overview-area overview-area-${key} overview-area-link`}));
    // Small internal sub-area names were not legible enough in the source;
    // leave those unnamed rather than inventing attractions or districts.
    // The source shows a continuous lake-to-creek shoreline, not a diagonal
    // ribbon laid over the meadow. The first two polygons are joined below.
    // 万寿湖 also has a short southern outlet; keep it narrow so the mapped
    // blue areas read as one water system without inventing another lake.
    terrain.append(svgEl('path',{d:'M1660 182 C1677 205 1664 229 1675 250 C1682 269 1687 287 1680 307 L1701 307 C1707 285 1696 266 1688 248 C1680 224 1696 204 1686 183Z',class:'overview-water overview-water-link'}));
    const sourceWater=layout.waterBodies||[];
    const joinedWestWater=[...sourceWater[0].slice(0,7),[349,261],[347,274],[352,283],[365,294],[380,310],[390,326],...sourceWater[1].slice(1).map(([x,y])=>[x,y+24]),[403,341],[390,338],[375,325],[358,306],[341,287],...sourceWater[0].slice(9)];
    const waterShapes=[joinedWestWater,...sourceWater.slice(2)];
    for (const [waterIndex,shape] of waterShapes.entries()) {
      const waterPath=`${smoothPath(shape)}Z`, clipId=`overviewWaterClip${waterIndex}`;
      const clip=svgEl('clipPath',{id:clipId,clipPathUnits:'userSpaceOnUse'});
      clip.append(svgEl('path',{d:waterPath}));defs.append(clip);
      terrain.append(svgEl('path', { d: waterPath, class: 'overview-water' }));
      const xs=shape.map(point=>point[0]),ys=shape.map(point=>point[1]);
      const left=Math.min(...xs)+12,right=Math.max(...xs)-12,top=Math.min(...ys)+8,bottom=Math.max(...ys)-8;
      for(let i=0;i<2;i++){
        const y=top+(bottom-top)*(i+1)/4;
        terrain.append(svgEl('path',{d:`M${left} ${y} Q${(left+right)/2} ${y-3} ${right} ${y+1}`,class:'overview-water-line','clip-path':`url(#${clipId})`}));
      }
    }
    root.append(terrain);

    const decorative = svgEl('g', { class: 'overview-decoration' });
    // Woodland is deliberately kept at the park margins and behind all
    // routes, landmarks, and labels, echoing the supplied illustrated map.
    [[48,110,.7,0],[82,170,.82,0],[55,258,.72,1],[100,332,.85,0],[178,375,.7,1],[294,393,.75,0],[392,414,.85,0],[492,407,.72,1],[624,392,.62,0],[710,416,.73,1],[805,399,.64,0],[1015,418,.68,1],[1140,400,.64,0],[1358,414,.7,0],[1482,399,.64,1],[1638,419,.73,0],[1780,397,.68,1],[1930,412,.8,0],[2062,397,.76,0],[2175,416,.72,1],[2316,399,.82,0],[2445,374,.72,1],[2500,267,.72,0],[2465,108,.64,0],[2292,82,.68,1],[2070,95,.62,0],[1850,90,.65,0],[1190,87,.55,1],[366,91,.62,0],[260,470,.8,0],[495,480,.75,1],[760,469,.85,0],[1010,482,.72,0],[1260,468,.8,1],[1510,482,.72,0],[1770,469,.85,0],[2025,482,.72,1],[2310,468,.8,0]].forEach(([x,y,s,b])=>addTree(decorative,x,y,s,Boolean(b)));
    // Uneven woodland pockets replace the old even scatter. Their irregular
    // silhouettes and varied tree sizes fill the southern garden without
    // turning the whole empty margin into a repeated tree pattern.
    const groves = [
      [135,380,94,37,[[0,0,.8,0],[28,14,.58,0],[-24,21,.62,1],[53,-12,.42,0],[-56,-9,.37,0]]],
      [506,466,138,42,[[0,0,.8,0],[33,-15,.58,1],[-35,13,.64,0],[69,14,.42,0],[-83,4,.45,1]]],
      [871,403,76,29,[[0,0,.76,1],[27,18,.54,0],[-33,-11,.52,0]]],
      [1198,458,164,48,[[0,0,.85,0],[-29,15,.58,1],[34,-13,.53,0],[87,8,.4,0],[-106,-8,.45,0]]],
      [1580,417,85,27,[[0,0,.73,0],[28,-17,.52,1],[-38,16,.5,0]]],
      [1940,468,150,46,[[0,0,.82,1],[33,13,.56,0],[-30,-15,.53,0],[82,-9,.4,1],[-91,13,.38,0]]],
      [2318,425,109,35,[[0,0,.76,0],[-32,15,.57,0],[34,-18,.52,1],[68,11,.42,0]]]
    ];
    for(const [gx,gy,rx,ry,trees] of groves){
      decorative.append(svgEl('path',{d:`M${gx-rx} ${gy+3} Q${gx-rx*.92} ${gy-ry*.7} ${gx-rx*.55} ${gy-ry*.62} Q${gx-rx*.18} ${gy-ry*1.45} ${gx+rx*.19} ${gy-ry*.68} Q${gx+rx*.77} ${gy-ry*.91} ${gx+rx} ${gy-ry*.06} Q${gx+rx*.84} ${gy+ry*.83} ${gx+rx*.28} ${gy+ry*.61} Q${gx-rx*.1} ${gy+ry*1.15} ${gx-rx*.44} ${gy+ry*.57} Q${gx-rx*.92} ${gy+ry*.76} ${gx-rx} ${gy+3}Z`,class:'overview-grove-patch'}));
      for(const [dx,dy,scale,blossom] of trees) addTree(decorative,gx+dx,gy+dy,scale,Boolean(blossom));
    }
    // Sparse accents help the north and central courts feel inhabited.
    [[58,298,.47,1],[147,351,.56,0],[337,376,.48,0],[588,438,.54,1],[813,362,.47,0],[1098,401,.56,0],[1331,439,.45,1],[1712,396,.52,0],[1868,436,.48,1],[2194,370,.51,0],[2471,408,.45,1],[505,222,.5,0],[845,342,.48,1],[1118,274,.46,0],[1450,350,.48,1],[1760,210,.52,0],[2260,254,.46,1]].forEach(([x,y,s,b])=>addTree(decorative,x,y,s,Boolean(b)));
    // Low-count micro accents are intentionally non-uniform and sit behind
    // the road/POI layers; no invented water or named features are added.
    let seed=20261023;
    const random=()=>{seed=(seed*48271)%2147483647;return seed/2147483647;};
    const inWater=(x,y,polygon)=>{
      let inside=false;
      for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
        const [xi,yi]=polygon[i],[xj,yj]=polygon[j];
        if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi))inside=!inside;
      }
      return inside;
    };
    for (let index=0; index<38; index++) {
      const x=40+random()*2480, y=42+random()*448;
      if (Object.values(layout.nodes).some(([nx,ny])=>Math.hypot(nx-x,ny-y)<56)) continue;
      if (waterShapes.some(shape=>inWater(x,y,shape))) continue;
      addTree(decorative,x,y,.2+random()*.14,random()<.06);
    }
    root.append(decorative);

    const roads = svgEl('g', { class: 'overview-roads' });
    const mainRoadIds = new Set(['edge_002','edge_008','edge_012','edge_027','edge_031','edge_036','edge_040','edge_045']);
    for (const edge of graph.edges || []) {
      if (!(layout.overviewBaseEdges || []).includes(edge.edge_id)) continue;
      const points = layout.edges[edge.edge_id]; if (!points) continue;
      const d = smoothPath(points), main = mainRoadIds.has(edge.edge_id);
      roads.append(svgEl('path', { d, class: `overview-road-casing ${main ? 'is-main' : ''}` }));
      roads.append(svgEl('path', { d, class: `overview-road ${main ? 'is-main' : ''}`, 'data-overview-edge': edge.edge_id }));
    }
    root.append(roads);

    const minorRoads=svgEl('g',{class:'overview-minor-roads'});
    for(const path of layout.secondaryPaths||[]){
      // Render every source-verified lane. The previous hand-picked subset
      // hid the junctions feeding several attraction clusters and made the
      // main promenade look like isolated diagonal connectors.
      if(!path.verified) continue;
      minorRoads.append(svgEl('path',{d:smoothPath(path.points),class:`overview-minor-road ${Math.max(...path.points.map(point=>point[1]))<240?'is-upper':''}`}));
    }
    root.append(minorRoads);

    const districtTitles=svgEl('g',{class:'overview-district-titles'});
    for(const {name,key,center:[x,y]} of terrain._districtTitles||[]){
      const width=name.length*23+18;
      districtTitles.append(svgEl('text',{x,y:y+6,class:`overview-area-title overview-area-title-${key}`,'text-anchor':'middle',
        'data-overview-label-box':'district','data-label-x':x-width/2,'data-label-y':y-17,'data-label-width':width,'data-label-height':34},name));
    }

    const references = svgEl('g', { class:'overview-reference-landmarks' });
    const occupied = (graph.nodes || []).map(node => {
      const point = layout.nodes[node.node_id || node.id], projected = point && layout.overviewPoint(point);
      if(!projected) return null;
      const size=visualSize(node);
      return nodeFootprint(node,projected[0],projected[1],size);
    }).filter(Boolean);
    for(const {name,center:[x,y]} of terrain._districtTitles||[]){
      const width=name.length*20+30;
      occupied.push({left:x-width/2,right:x+width/2,top:y-18,bottom:y+18});
    }
    const overlaps = box => occupied.some(other => !(box.right < other.left || box.left > other.right || box.bottom < other.top || box.top > other.bottom));
    // Show only names explicitly legible on the supplied visitor map. These
    // orientation labels are visual references, not new routable POIs.
    (layout.referenceLandmarks || []).forEach((item,index)=>{
      const [x,y]=layout.overviewPoint([item.x,item.y]),width=Math.max(68,item.name.length*12+18);
      // Keep the source's distinct names visible at overview scale; A's node
      // set remains the only routable POI inventory.
      const normalizeName = value => String(value || '').replace(/[\s·区入口]/g,'');
      const closeToMapped = (graph.nodes || []).some(node => normalizeName(layout.displayNames?.[node.node_id || node.id] || node.name) === normalizeName(item.name));
      if(closeToMapped) return;
      const candidates=[[0,-34],[0,36],[-54,-31],[54,-31],[-58,34],[58,34],[0,-56],[0,58]];
      let chosen=candidates[index%candidates.length],box;
      for(const candidate of candidates){
        const cx=Math.max(width/2+8,Math.min(layout.width-width/2-8,x+candidate[0])),cy=Math.max(-10,Math.min(515,y+candidate[1]));
        const next={left:cx-width/2,right:cx+width/2,top:cy-12,bottom:cy+12};
        if(!overlaps(next)){chosen=[cx-x,cy-y];box=next;break;}
      }
      if(!box) return;
      occupied.push(box);addReferenceLandmark(references,item,{x:x+chosen[0],y:y+chosen[1],width});
    });
    // Unconfirmed C-only names and service markers stay off this public map.
    // A/B shared nodes remain intact for routing and the detailed map.
    root.append(references);

    const landmarks = svgEl('g', { class: 'overview-landmarks' });
    const tones = ['red','jade','gold','blue'];
    const nodeSpecs = [];
    (graph.nodes || []).forEach((node, index) => {
      const point = layout.nodes[node.node_id || node.id]; if (!point) return;
      const [x, y] = layout.overviewPoint(point);
      if (node.type === 'gate') { addGate(landmarks,x,y,node.node_id || node.id); nodeSpecs.push({node,x,y,size:72}); return; }
      const id=node.node_id || node.id;
      const size = visualSize(node);
      if (node.type === 'scenery') addSceneryMark(landmarks,id,x,y-12,size);
      else if (node.type === 'view') addWallLookout(landmarks,x,y-22,size);
      else {
        if (node.type === 'show') addStageBase(landmarks,x,y,size);
        const tone = id === 'temple' || id === 'shenboat' ? 'gold' : node.type === 'show' ? 'red' : node.area_id === 'xianxia' ? 'blue' : node.area_id === 'water_margin' ? 'jade' : tones[index % tones.length];
        addBuilding(landmarks, x, y - 25, size, tone, layout.displayNames?.[id] || node.name, node.type, id);
      }
      nodeSpecs.push({node,x,y,size});
    });
    const obstacles = nodeSpecs.map(({node,x,y,size}) => ({id:node.node_id || node.id,box:nodeFootprint(node,x,y,size)}));
    const labelBoxes = [...references.querySelectorAll('[data-overview-label-box]')].map(label=>({left:Number(label.dataset.labelX),top:Number(label.dataset.labelY),right:Number(label.dataset.labelX)+Number(label.dataset.labelWidth),bottom:Number(label.dataset.labelY)+Number(label.dataset.labelHeight)}));
    for(const {name,center:[x,y]} of terrain._districtTitles||[]){
      const width=name.length*20+30;
      labelBoxes.push({left:x-width/2,top:y-18,right:x+width/2,bottom:y+18});
    }
    for (const spec of nodeSpecs) {
      const placement = chooseNodeLabel(spec.node,spec.x,spec.y,spec.size,obstacles,labelBoxes);
      if (!placement) {
        const fallback=findOpenLabelPosition(spec.node,spec.x,spec.y,spec.size,obstacles,labelBoxes);
        if(fallback) addNodeLabel(landmarks,spec.node,spec.x,spec.y,spec.size,fallback.width,fallback.height,fallback.dx,fallback.dy);
        continue;
      }
      addNodeLabel(landmarks,spec.node,spec.x,spec.y,spec.size,placement.width,placement.height,placement.dx,placement.dy);
    }
    root.append(landmarks);
    // Keep the zone names on the final base-map layer so roads, trees,
    // buildings and nearby POI labels cannot obscure their text.
    root.append(districtTitles);
    const mapFurniture = svgEl('g',{class:'overview-map-furniture'});
    mapFurniture.append(svgEl('path',{d:'M70 506H220M70 498V514M145 498V514M220 498V514',class:'overview-scale'}));
    addText(mapFurniture,145,528,'比例示意 · 100 m','overview-scale-text');
    const legend = svgEl('g',{transform:'translate(390 506)',class:'overview-legend'});
    [['#c4a66f','主游览步道'],['#d8c8a9','普通步道'],['#9e3d31','推荐路线'],['#78a9a4','水系 / 景观']].forEach(([color,label],index)=>{ legend.append(svgEl('line',{x1:index*180,y1:0,x2:index*180+25,y2:0,stroke:color,class:'overview-legend-line'})); addText(legend,index*180+34,4,label,'overview-legend-text','start'); });
    mapFurniture.append(legend); root.append(mapFurniture);
  }

  window.ScenicOverviewMap = { draw };
})();
