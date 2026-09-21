// Optional integration suite: npm install --no-save playwright && npx playwright install chromium
// Run: node tests/browser.mjs. Browser camera/share are simulated; Leaflet/IndexedDB/ZIP are real.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
    navigator.mediaDevices.getUserMedia=async constraints=>{
      window.lastCameraConstraints=constraints;
      const smooth=constraints.video.frameRate.ideal===60;
      const canvas=document.createElement('canvas');canvas.width=smooth?640:320;canvas.height=smooth?360:240;
      const ctx=canvas.getContext('2d');let tick=0;
      setInterval(()=>{ctx.fillStyle='#345b76';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#c8dce7';ctx.fillText(`TEST VIDEO ${tick++}`,20,20);ctx.fillStyle='#ffff00';ctx.beginPath();ctx.arc(canvas.width/2,canvas.height/2,40,0,Math.PI*2);ctx.fill()},smooth?16:30);
      return canvas.captureStream(smooth?60:30);
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
  assert.equal(await page.locator('#importLog').count(),0);
  assert.equal(await page.locator('#qualitySelect').inputValue(),'high');
  assert.equal(await page.evaluate(()=>window.lastCameraConstraints.video.width.ideal),1920);
  assert.match(await page.locator('#qualityReadout').textContent(),/実際の入力：320 × 240.*目標 16 Mbps.*端末の対応範囲/);
  await page.locator('#qualitySelect').selectOption('smooth');
  await page.waitForFunction(()=>window.lastCameraConstraints.video.frameRate.ideal===60&&!document.getElementById('qualitySelect').disabled);
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
  assert.equal(await page.locator('#qualitySelect').isDisabled(),true);
  await context.setGeolocation({latitude:39.704,longitude:141.1534,accuracy:12});await page.waitForTimeout(1100);
  await page.locator('#recordBtn').click();
  await page.waitForFunction(()=>document.getElementById('libraryCount').textContent==='1件');
  const capture=await page.evaluate(async()=>{const {listRecordings,getRecording}=await import('/storage.js');return (await getRecording((await listRecordings())[0].id)).meta.capture});
  assert.equal(capture.quality,'smooth');assert.equal(capture.requestedVideoBitsPerSecond,24000000);
  assert.equal(capture.width,640);assert.equal(capture.height,360);assert.equal(capture.frameRate,60);
  await page.waitForFunction(()=>document.getElementById('playback').readyState>=2);
  await page.locator('#playback').evaluate(video=>new Promise(resolve=>{video.addEventListener('seeked',resolve,{once:true});video.currentTime=0.5}));
  const geometry=await page.locator('#playback').evaluate(video=>{
    const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    const ctx=canvas.getContext('2d');ctx.drawImage(video,0,0);const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    let left=Infinity,right=-1,top=Infinity,bottom=-1;
    for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){const i=(y*canvas.width+x)*4;if(data[i]>180&&data[i+1]>180&&data[i+2]<90){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y)}}
    const box=video.getBoundingClientRect();return {width:video.videoWidth,height:video.videoHeight,circleWidth:right-left+1,circleHeight:bottom-top+1,displayRatio:box.width/box.height};
  });
  assert.equal(geometry.width,640);assert.equal(geometry.height,360);
  assert.ok(geometry.circleWidth>70&&Math.abs(geometry.circleWidth-geometry.circleHeight)<=2,`decoded recording preserves a circular target: ${JSON.stringify(geometry)}`);
  assert.ok(Math.abs(geometry.displayRatio-16/9)<0.01,'playback element follows recorded aspect ratio');
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
  assert.equal(await page.locator('#qualitySelect').inputValue(),'smooth','quality preference survives reload');
  const fixture=await page.evaluate(async()=>{
    const {listRecordings,getRecording}=await import('/storage.js');const row=(await listRecordings()).find(r=>r.id!=='selection-test');
    const record=await getRecording(row.id);return {id:record.id,bytes:Array.from(new Uint8Array(await record.video.arrayBuffer())),points:record.points,meta:record.meta};
  });
  const videoPayload=name=>({name,mimeType:'video/webm',buffer:Buffer.from(fixture.bytes)});
  const logPayload=(name,lat)=>({name,mimeType:'text/plain',buffer:Buffer.from(JSON.stringify({durationSeconds:2.2,gps:[{videoTime:0,latitude:lat,longitude:141.1}]}))});
  const details=page.locator('#importForm').locator('..');await details.evaluate(el=>el.open=true);
  // Android-style shared filenames: video alone can recover GPS already on this device.
  await page.locator('#importFiles').setInputFiles(videoPayload(`road_damage_${fixture.id}.webm`));
  await page.waitForFunction(()=>document.getElementById('importMatch').textContent.includes('端末の録画データから'));
  await page.locator('#importBtn').click();await page.waitForFunction(()=>document.getElementById('libraryCount').textContent==='3件');
  // Real directory input: two folders may contain identical filenames without mixing GPS.
  const fixtureRoot=await fs.mkdtemp(path.join(output||os.tmpdir(),'import-fixture-'));
  for(const [folder,lat] of [['a',39.8],['b',40.2]]){
    await fs.mkdir(path.join(fixtureRoot,folder),{recursive:true});
    await fs.writeFile(path.join(fixtureRoot,folder,'video.webm'),Buffer.from(fixture.bytes));
    await fs.writeFile(path.join(fixtureRoot,folder,'metadata.json'),logPayload('metadata.json',lat).buffer);
  }
  await page.locator('#importFolder').setInputFiles(fixtureRoot);
  const options=await page.locator('#importVideo option').evaluateAll(options=>options.map(o=>({value:o.value,text:o.textContent})));
  await page.locator('#importVideo').selectOption(options.find(o=>o.text.endsWith('/b/video.webm')).value);
  assert.match(await page.locator('#importMatch').textContent(),/metadata.json（自動選択）/);
  await page.locator('#importBtn').click();await page.waitForFunction(()=>document.getElementById('libraryCount').textContent==='4件');
  await page.waitForFunction(()=>document.getElementById('mapCoordinates').textContent.includes('40.200000'));
  await page.locator('#importVideo').selectOption(options.find(o=>o.text.endsWith('/a/video.webm')).value);
  await page.locator('#importBtn').click();await page.waitForFunction(()=>document.getElementById('libraryCount').textContent==='5件');
  await page.waitForFunction(()=>document.getElementById('mapCoordinates').textContent.includes('39.800000'));
  // Combined files fallback auto-selects JSON TXT and never carries GPS over to unmatched videos.
  await page.locator('#importFiles').setInputFiles([videoPayload('trip.webm'),logPayload('trip_metadata.json.txt',38.5)]);
  await page.locator('#importBtn').click();await page.waitForFunction(()=>document.getElementById('libraryCount').textContent==='6件');
  await page.waitForFunction(()=>document.getElementById('mapCoordinates').textContent.includes('38.500000'));
  await page.locator('#importFiles').setInputFiles(videoPayload('no-gps.webm'));
  assert.match(await page.locator('#importMatch').textContent(),/対応する位置情報がありません/);
  await page.locator('#importBtn').click();await page.waitForFunction(()=>document.getElementById('libraryCount').textContent==='7件');
  await page.waitForFunction(()=>document.getElementById('mapCoordinates').textContent==='この時刻の位置情報なし');
  await page.locator('#importFiles').setInputFiles([videoPayload('bad.webm'),{name:'bad.json',mimeType:'application/json',buffer:Buffer.from('broken')}]);
  await page.locator('#importBtn').click();await page.waitForFunction(()=>document.getElementById('libraryStatus').textContent.includes('読み込めませんでした'));
  assert.equal(await page.locator('#libraryCount').textContent(),'7件');
  await page.locator('#importFiles').setInputFiles([videoPayload('trip.webm'),logPayload('trip_metadata.json.txt',38.5)]);
  await page.locator('#importBtn').click();await page.waitForFunction(()=>document.getElementById('libraryCount').textContent==='8件');
  // Exercise the native directory-picker path as well as the directory-input fallback.
  await page.evaluate(({bytes})=>{
    const file=(name,data)=>({kind:'file',name,getFile:async()=>new File([data],name)});
    window.showDirectoryPicker=async()=>({async *values(){yield file('native.webm',new Uint8Array(bytes));yield file('native.csv','videoTime,latitude,longitude\n0,37.5,141.1')}});
  },fixture);
  await page.locator('#chooseImportFolder').click();
  await page.waitForFunction(()=>document.getElementById('importMatch').textContent.includes('native.csv'));
  assert.equal(await page.locator('#importBtn').isEnabled(),true);
  await page.locator('#prepareBtn').click();
  await page.waitForFunction(()=>!document.getElementById('qualitySelect').disabled);
  if(output)await page.screenshot({path:path.join(output,'quality-import-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: quality constraints, actual capture metadata, setting persistence, folder/combined-file import, filename matching, native directory picker, stored GPS recovery, missing/invalid logs, plus recording/playback/share/map/history regressions.');
}finally{await browser?.close();server.close()}
