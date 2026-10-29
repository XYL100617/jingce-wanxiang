const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'map2-visual-'));
const output = process.env.MAP2_SCREENSHOT || path.join(os.tmpdir(), 'map2-visual.png');
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1600,1000', process.env.SMOKE_SITE || 'http://localhost:4173/?guest=1'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  let port;
  for (let i = 0; i < 100; i++) {
    const file = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(file)) { port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); break; }
    await pause(100);
  }
  if (!port) throw new Error('Chrome debugging endpoint unavailable');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(targets.find(item => item.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const data = JSON.parse(event.data);
    if (!data.id || !pending.has(data.id)) return;
    const { resolve, reject } = pending.get(data.id); pending.delete(data.id);
    data.error ? reject(new Error(data.error.message)) : resolve(data.result);
  };
  function call(method, params = {}) {
    return new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  await call('Runtime.enable');
  for (let i = 0; i < 150; i++) {
    if (await evaluate('!!window.CScenicMap?.getData()?.graph && !!document.querySelector("#navFrom option")')) break;
    await pause(100);
  }
  await evaluate(`(() => {
    document.querySelector('[data-view="navigation"]')?.click();
    document.querySelector('#enterGuidance')?.click();
  })()`);
  await pause(700);
  await evaluate(`(() => {
    const from=document.querySelector('#navFrom'),to=document.querySelector('#navTo');
    if(!from||!to)throw new Error('Navigation controls are missing');
    from.value=${JSON.stringify(process.env.MAP2_FROM || 'gate')};to.value=${JSON.stringify(process.env.MAP2_TO || 'market')};
    from.dispatchEvent(new Event('change',{bubbles:true}));to.dispatchEvent(new Event('change',{bubbles:true}));
    document.querySelector('#navPlan')?.click();
    document.querySelector('#guidedDetail')?.scrollIntoView({block:'start'});
  })()`);
  for (let i = 0; i < 100; i++) {
    if (await evaluate('document.querySelector("#cMapSurface")?.getAttribute("data-navigation-focus") === "true"')) break;
    await pause(100);
  }
  await pause(800);
  await evaluate(`document.querySelector('.map-container')?.scrollIntoView({block:'center',behavior:'instant'})`);
  await pause(200);
  const controlCheck = await evaluate(`(() => {
    document.querySelector('#mapRotateRight')?.click();
    const rotated=window.CScenicMap.getData();
    document.querySelector('#mapLocate')?.click();
    const reset=window.CScenicMap.getData();
    const speed=document.querySelector('#walkingSpeed');speed.value='2';speed.dispatchEvent(new Event('change',{bubbles:true}));
    const speedValue=speed.value;speed.value='1';speed.dispatchEvent(new Event('change',{bubbles:true}));
    if(rotated.bearing===0||!reset.northUp||reset.bearing!==0||speedValue!=='2')throw new Error('rotation, map1 recenter, or speed selector failed');
    return {bearingAfterRotate:rotated.bearing,northUpAfterRecenter:reset.northUp,bearingAfterRecenter:reset.bearing,speedOption:speedValue};
  })()`);
  const freeModeSummary=await evaluate(`document.querySelector('#navSummary .nav-model-note')?.textContent||''`);
  const demoPlan=JSON.parse(fs.readFileSync(path.join(__dirname,'..','public','c-demo-plan.json'),'utf8'));
  await evaluate(`(() => { app.activePlan=${JSON.stringify(demoPlan)}; renderTripOverview(app.activePlan); startGuidedTrip(); })()`);
  await pause(400);
  const fullRouteCheck=await evaluate(`(() => {
    const before=window.CScenicMap.getData();
    const edgeIds=[...document.querySelectorAll('#cMapSurface [data-navigation-edge]')].map(el=>el.dataset.navigationEdge).filter((v,i,a)=>a.indexOf(v)===i);
    document.querySelector('#walkingPlay')?.click();
    const following=window.CScenicMap.getData().followNavigation;
    document.querySelector('#walkingPlay')?.click();
    window.CScenicMap.setNavigationProgress(0);
    window.CScenicMap.setFollowNavigation(false);
    return {continuous:before.continuousRoute,wholeRouteEdgeCount:edgeIds.length,stopCount:document.querySelector('#navSummary .nav-model-note')?.textContent.match(/经过景点/) ? 3 : 0,initialWholeRouteView:document.querySelector('#cMapSurface')?.getAttribute('data-navigation-focus'),simulationStartsFollowing:following};
  })()`);
  if(!fullRouteCheck.continuous||fullRouteCheck.wholeRouteEdgeCount<3||!fullRouteCheck.simulationStartsFollowing)throw new Error(`full recommended route simulation failed: ${JSON.stringify(fullRouteCheck)}`);
  const report = await evaluate(`(() => ({
    focused:document.querySelector('#cMapSurface')?.getAttribute('data-navigation-focus'),
    scenicNodes:new Set([...document.querySelectorAll('#cMapSurface .m2-source-landmark[data-node-id]')].map(el=>el.dataset.nodeId)).size,
    routeEdges:[...document.querySelectorAll('#cMapSurface [data-navigation-edge]')].map(el=>el.dataset.navigationEdge).filter((v,i,a)=>a.indexOf(v)===i),
    routeBelowBuildings:(()=>{const scene=document.querySelector('#cMapSurface [data-layer-group="scene"]'),route=scene?.querySelector('[data-layer-group="navigation"]'),buildings=scene?.querySelector('[data-layer-group="buildings"]');return !!route&&!!buildings&&[...scene.children].indexOf(route)<[...scene.children].indexOf(buildings)})(),
    routeEndsAtScenicAccess:(()=>{const target=document.querySelector('#cMapSurface .m2-poi.is-target');const paths=[...document.querySelectorAll('#cMapSurface .c-navigation-context')];if(!target||!paths.length)return null;const d=paths.at(-1).getAttribute('d')||'',match=[...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].at(-1);if(!match)return null;return Math.round(Math.hypot(Number(match[1])-Number(target.dataset.anchorX),Number(match[2])-Number(target.dataset.anchorY))*10)/10})(),
    routeModeSummary:document.querySelector('#navSummary .nav-model-note')?.textContent||'',
    freeModeSummary:${JSON.stringify(freeModeSummary)},
    visiblePoiLabels:[...document.querySelectorAll('#cMapSurface .m2-poi .m2-label')].filter(label=>getComputedStyle(label).display!=='none').slice(0,12).map(label=>({text:label.textContent,font:getComputedStyle(label).fontSize,box:(()=>{const b=label.getBoundingClientRect();return {width:Math.round(b.width),height:Math.round(b.height)}})()})),
    visibleRoadLabels:[...document.querySelectorAll('#cMapSurface .m2-road-label')].map(label=>({text:label.textContent,font:getComputedStyle(label).fontSize})),
    instruction:document.querySelector('#walkingInstruction')?.textContent,
    mapRect:(()=>{const r=document.querySelector('.map-container').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})()
  }))()`);
  const screenshot = await call('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
  fs.writeFileSync(output, Buffer.from(screenshot.data, 'base64'));
  const layerChecks={};
  for(const theme of ['crowd','comfort']){
    await evaluate(`window.CScenicMap.setTheme(${JSON.stringify(theme)})`);
    await pause(180);
    layerChecks[theme]=await evaluate(`({theme:window.CScenicMap.getData().theme,poiLabels:document.querySelectorAll('#cMapSurface .m2-data-label-backdrop.${theme==='crowd'?'crowd':'comfort'}').length,layerPanel:!!document.querySelector('#mapCrowdPanel')})`);
    const layerShot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(output.replace(/\.png$/i,`-${theme}.png`),Buffer.from(layerShot.data,'base64'));
  }
  await evaluate(`window.CScenicMap.setTheme('base')`);
  console.log(JSON.stringify({ output, controlCheck, freeModeSummary, fullRouteCheck, layerChecks, ...report }, null, 2));
  socket.close();
}
main().catch(error => { console.error(error); process.exitCode=1; }).finally(() => browser.kill());
