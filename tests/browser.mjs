// Optional integration suite: npm install --no-save playwright && npx playwright install chromium
// Run: node tests/browser.mjs. Browser camera/share are simulated; Leaflet/IndexedDB/ZIP are real.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const output=process.env.TEST_OUTPUT_DIR;
if(output)await fs.mkdir(output,{recursive:true});
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server=http.createServer(async(req,res)=>{
  try{const filename=path.resolve(root,'.'+(req.url==='/'?'/index.html':req.url.split('?')[0]));if(!filename.startsWith(root))throw Error();const data=await fs.readFile(filename);res.setHeader('Content-Type',types[path.extname(filename)]||'application/octet-stream');res.end(data)}catch{res.statusCode=404;res.end()}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
    permissions:['geolocation'],geolocation:{latitude:39.7036,longitude:141.1527,accuracy:10},serviceWorkers:'block'});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  let tileFailure=false;const zoomRequests=[];
  await page.route('https://tile.openstreetmap.org/**',route=>{
    zoomRequests.push(Number(new URL(route.request().url()).pathname.split('/')[1]));
    if(tileFailure)return route.abort();
    return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e1ecdf"/><path d="M0 128H256M128 0V256" stroke="white" stroke-width="12"/><path d="M0 128H256M128 0V256" stroke="#c3c6b2" stroke-width="1"/></svg>'});
  });
  await page.addInitScript(()=>{
    navigator.mediaDevices.getUserMedia=async()=>{
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=240;
      const ctx=canvas.getContext('2d');let tick=0;
      setInterval(()=>{ctx.fillStyle='#345b76';ctx.fillRect(0,0,320,240);ctx.fillStyle='#c8dce7';ctx.fillText(`TEST VIDEO ${tick++}`,20,20)},30);
      return canvas.captureStream(30);
    };
    window.showSaveFilePicker=undefined;
    localStorage.setItem('road-damage-save-destination','removed-provider');
    Object.defineProperty(navigator,'canShare',{value:({files})=>files.length>0&&(!window.singleFileOnly||files.length===1)&&files.every(file=>['video/webm','video/mp4','text/csv','text/plain'].includes(file.type))});
    Object.defineProperty(navigator,'share',{value:async data=>{
      if(!navigator.userActivation.isActive)throw new DOMException('activation lost','NotAllowedError');
      if(window.cancelShare)throw new DOMException('cancel','AbortError');
      if(window.failShare)throw new DOMException('transfer failed','DataError');
      window.sharedData={names:data.files.map(f=>f.name),types:data.files.map(f=>f.type),title:data.title};
    }});
  });
  await page.goto(origin);
  await page.waitForFunction(()=>document.getElementById('libraryCount').textContent==='0件');
  assert.equal(await page.title(),'Road Damage Analysis');
  assert.equal(await page.locator('.topbar .eyebrow').textContent(),'Prima Laboratory');
  assert.deepEqual(await page.locator('.panel h2').allTextContents(),['現在位置','移動軌跡','録画データ','データの再生','データの保存']);
  assert.equal(await page.locator('#openRecording,#prepareArchive').count(),0);
  assert.equal(await page.locator('#liveNote').isVisible(),false);
  assert.deepEqual(await page.locator('#saveDestination option').evaluateAll(options=>options.map(o=>o.value)),['local','dropbox']);
  assert.equal(await page.locator('#saveDestination').inputValue(),'local');
  assert.equal(await page.locator('#secureBadge').count(),0);
  assert.equal(await page.locator('.brand-logo').evaluate(i=>i.complete&&i.naturalWidth>0),true);
  assert.equal(await page.locator('#status').isVisible(),false);
  assert.equal(await page.locator('#prepareBtn svg').count(),2);
  assert.equal(await page.locator('#prepareBtn').innerText(),'');
  await page.locator('#prepareBtn').click();
  await page.waitForFunction(()=>document.getElementById('prepareBtn').getAttribute('aria-label')==='位置情報・カメラ許可中');
  assert.equal(await page.locator('#cameraEmpty').isVisible(),false);
  await page.waitForSelector('#liveMap .leaflet-tile-loaded');
  assert.equal(await page.locator('#liveMap .leaflet-tile').first().evaluate(i=>getComputedStyle(i).position),'absolute');
  async function assertCentered(prefix){
    const {viewport,marker}=await page.evaluate(prefix=>({viewport:document.getElementById(prefix+'Viewport').getBoundingClientRect().toJSON(),marker:document.querySelector('#'+prefix+'Map .route-marker')?.getBoundingClientRect().toJSON()}),prefix);
    assert.ok(marker,`${prefix} marker visible`);
    assert.ok(Math.abs(marker.x+marker.width/2-viewport.x-viewport.width/2)<2,`${prefix} horizontal center`);
    assert.ok(Math.abs(marker.y+marker.height/2-viewport.y-viewport.height/2)<2,`${prefix} vertical center: ${JSON.stringify({viewport,marker})}`);
    assert.equal(await page.locator(`#${prefix}Map .leaflet-position-pane`).evaluate(e=>getComputedStyle(e).zIndex),'650');
  }
  await assertCentered('live');
  await page.locator('#liveZoomIn').click();await page.waitForTimeout(200);
  assert.ok(zoomRequests.includes(18));await assertCentered('live');
  await page.locator('#recordBtn').click();await page.waitForTimeout(1100);
  await context.setGeolocation({latitude:39.704,longitude:141.1534,accuracy:12});await page.waitForTimeout(1100);
  await page.locator('#recordBtn').click();
  await page.waitForFunction(()=>document.getElementById('libraryCount').textContent==='1件');
  await page.waitForSelector('#routeMap .route-marker');await assertCentered('route');
  assert.equal(await page.locator('#routeNote').isVisible(),false);
  const mapBox=await page.locator('#routeViewport').boundingBox(),readout=await page.locator('.map-readout').boundingBox();
  assert.ok(readout.y>=mapBox.y+mapBox.height,'readout is outside the map');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.evaluate(()=>{document.getElementById('playback').currentTime=1});
  await page.waitForFunction(()=>document.getElementById('mapTime').textContent.startsWith('00:00:01'));
  await assertCentered('route');
  await page.locator('#routeZoomIn').click();await page.waitForTimeout(200);await assertCentered('route');
  // Native two-touch sequence, using the actual Leaflet touch handler.
  await page.locator('#routeViewport').scrollIntoViewIfNeeded();
  const box=await page.locator('#routeViewport').boundingBox(),cx=box.x+box.width/2,cy=box.y+box.height/2;
  const cdp=await context.newCDPSession(page),beforePinch=zoomRequests.length;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:cx-30,y:cy,id:1},{x:cx+30,y:cy,id:2}]});
  for(const spread of [40,55,75,95])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:cx-spread,y:cy,id:1},{x:cx+spread,y:cy,id:2}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(400);
  assert.ok(zoomRequests.slice(beforePinch).includes(19),'pinch zoom changed tile zoom');await assertCentered('route');
  tileFailure=true;await page.locator('#routeZoomOut').click();await page.locator('#routeZoomOut').click();await page.locator('#routeZoomOut').click();
  await page.waitForFunction(()=>document.getElementById('routeNote').textContent.includes('取得できません'));
  await assertCentered('route');assert.equal(await page.locator('#routeMap').isVisible(),true);
  if(output)await page.screenshot({path:path.join(output,'tile-failure.png'),fullPage:true});
  tileFailure=false;await page.locator('#routeRetry').click();
  await page.waitForFunction(()=>document.getElementById('routeRetry').hidden);
  // Stable size after portrait -> landscape -> portrait changes.
  await page.setViewportSize({width:844,height:390});await page.waitForTimeout(200);await assertCentered('route');
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);await assertCentered('route');
  await page.waitForFunction(()=>!document.getElementById('saveArchive').disabled);
  const download=page.waitForEvent('download');await page.locator('#saveArchive').click();const zip=await download;
  assert.match(zip.suggestedFilename(),/^road_damage_.*\.zip$/);if(output)await zip.saveAs(path.join(output,'recording.zip'));
  await page.locator('#saveDestination').selectOption('dropbox');
  await page.waitForFunction(()=>!document.getElementById('saveArchive').disabled);
  assert.equal(await page.locator('#saveArchive').textContent(),'アップロード');await page.locator('#saveArchive').click();
  await page.waitForFunction(()=>document.getElementById('saveStatus').textContent.includes('Dropboxを共有先に選択'));
  const shared=await page.evaluate(()=>window.sharedData);
  assert.deepEqual(shared.types,['video/webm','text/csv','text/plain']);assert.equal(shared.title,undefined);
  assert.equal(shared.names.length,3);assert.ok(shared.names.every(name=>!name.endsWith('.zip')));
  await page.evaluate(()=>window.singleFileOnly=true);
  await page.locator('#saveDestination').selectOption('local');await page.locator('#saveDestination').selectOption('dropbox');
  assert.equal(await page.locator('#saveArchive').isDisabled(),true);
  for(const id of ['shareVideo','shareGps','shareMetadata']){await page.locator('#'+id).click();await page.waitForFunction(()=>document.getElementById('saveStatus').textContent.includes('Dropboxを共有先に選択'));assert.equal((await page.evaluate(()=>window.sharedData)).names.length,1)}
  await page.evaluate(()=>{window.singleFileOnly=false;window.failShare=true});
  await page.locator('#shareVideo').click();await page.waitForFunction(()=>document.getElementById('saveStatus').textContent.includes('共有できませんでした'));
  await page.evaluate(()=>window.failShare=false);
  await page.locator('#saveDestination').selectOption('local');await page.locator('#saveDestination').selectOption('dropbox');
  await page.evaluate(()=>window.cancelShare=true);await page.locator('#saveArchive').click();
  await page.waitForFunction(()=>document.getElementById('saveStatus').textContent.includes('アップロードを中止'));
  assert.equal(await page.locator('#saveArchive').isEnabled(),true);
  if(output)await page.screenshot({path:path.join(output,'review-mobile.png'),fullPage:true});
  await page.reload();await page.waitForFunction(()=>document.getElementById('libraryCount').textContent==='1件');
  await page.locator('#recordingSelect').selectOption({index:1});
  await page.waitForSelector('#routeMap .route-marker');await assertCentered('route');
  assert.equal(await page.locator('#saveArchive').isEnabled(),true);
  // Dropbox preparation must not require a ZIP or a prior local export.
  await page.locator('#saveDestination').selectOption('dropbox');
  await page.waitForFunction(()=>!document.getElementById('saveArchive').disabled);
  await page.locator('#saveArchive').click();
  await page.waitForFunction(()=>document.getElementById('saveStatus').textContent.includes('Dropboxを共有先に選択'));
  assert.equal((await page.evaluate(()=>window.sharedData)).names.length,3);
  await page.locator('#saveDestination').selectOption('local');assert.equal(await page.locator('#saveArchive').isEnabled(),true);
  await page.waitForFunction(()=>!document.getElementById('saveArchive').disabled);
  await page.locator('#playbackSpeed').selectOption('0.5');assert.equal(await page.locator('#playback').evaluate(v=>v.playbackRate),0.5);
  await page.locator('#skipForward').click();assert.ok(await page.locator('#playback').evaluate(v=>v.currentTime<=v.duration));
  await page.locator('#skipBack').click();assert.equal(await page.locator('#playback').evaluate(v=>v.currentTime),0);
  await page.locator('#recordingSelect').selectOption('');assert.equal(await page.locator('#reviewPanel').isVisible(),false);assert.equal(await page.locator('#saveArchive').isDisabled(),true);
  await page.locator('#recordingSelect').selectOption({index:1});await page.waitForSelector('#routeMap .route-marker');
  // A new selection must never upload cached files from the previous recording.
  await page.evaluate(async()=>{const {listRecordings,getRecording,putRecording}=await import('/storage.js');const [first]=await listRecordings();const record=await getRecording(first.id);await putRecording({...record,id:'selection-test',name:'切替テスト',createdAt:new Date().toISOString()})});
  await page.reload();await page.waitForFunction(()=>document.getElementById('libraryCount').textContent==='2件');
  await page.locator('#recordingSelect').selectOption('selection-test');await page.locator('#saveDestination').selectOption('dropbox');
  await page.waitForFunction(()=>!document.getElementById('saveArchive').disabled);await page.locator('#saveArchive').click();
  await page.waitForFunction(()=>window.sharedData?.names[0]==='road_damage_selection-test.webm');
  await page.locator('#recordingSelect').selectOption({index:2});await page.waitForFunction(()=>!document.getElementById('saveArchive').disabled);
  await page.locator('#saveArchive').click();await page.waitForFunction(()=>window.sharedData?.names[0]!=='road_damage_selection-test.webm');
  assert.deepEqual(errors,[]);
  console.log('PASS: requested headings/text removal, automatic review, one-click save/share with active user gesture, worker file preparation, empty selection, speed/seek controls, plus Android share/map/history regressions.');
}finally{await browser?.close();server.close()}
