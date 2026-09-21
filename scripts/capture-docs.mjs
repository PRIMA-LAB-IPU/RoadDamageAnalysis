// Capture the real UI with synthetic camera/GPS/map data, without cloud uploads.
// Uses the same optional Playwright dependency as tests/browser.mjs.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const output=path.join(root,'docs/screenshots');
await fs.mkdir(output,{recursive:true});
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server=http.createServer(async(req,res)=>{
  try{
    const filename=path.resolve(root,'.'+(req.url==='/'?'/index.html':req.url.split('?')[0]));
    if(!filename.startsWith(root))throw Error();
    res.setHeader('Content-Type',types[path.extname(filename)]||'application/octet-stream');res.end(await fs.readFile(filename));
  }catch{res.statusCode=404;res.end()}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:390,height:1200},deviceScaleFactor:2,isMobile:true,hasTouch:true,permissions:['geolocation'],geolocation:{latitude:39.7036,longitude:141.1527,accuracy:10},serviceWorkers:'block'});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://tile.openstreetmap.org/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e1ecdf"/><path d="M0 128H256M128 0V256" stroke="white" stroke-width="14"/><path d="M0 128H256M128 0V256" stroke="#b7c4b4" stroke-width="2"/><text x="12" y="24" fill="#758776" font-family="sans-serif" font-size="11">SAMPLE MAP</text></svg>'}));
  await page.addInitScript(()=>{
    navigator.mediaDevices.getUserMedia=async()=>{
      const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;
      const ctx=canvas.getContext('2d');let tick=0;
      const draw=()=>{
        ctx.fillStyle='#bedce5';ctx.fillRect(0,0,1920,450);
        ctx.fillStyle='#799b80';ctx.fillRect(0,450,1920,630);
        ctx.fillStyle='#45545b';ctx.beginPath();ctx.moveTo(820,450);ctx.lineTo(1100,450);ctx.lineTo(1750,1080);ctx.lineTo(170,1080);ctx.fill();
        ctx.strokeStyle='#e3ece7';ctx.lineWidth=12;ctx.beginPath();ctx.moveTo(820,450);ctx.lineTo(170,1080);ctx.moveTo(1100,450);ctx.lineTo(1750,1080);ctx.stroke();
        ctx.strokeStyle='#f1dfad';ctx.lineWidth=10;ctx.setLineDash([50,50]);ctx.lineDashOffset=-(tick++%100);ctx.beginPath();ctx.moveTo(960,450);ctx.lineTo(960,1080);ctx.stroke();ctx.setLineDash([]);
        ctx.fillStyle='#163345';ctx.font='bold 48px sans-serif';ctx.fillText('SAMPLE VIDEO',1440,95);
      };
      draw();const timer=setInterval(draw,33),stream=canvas.captureStream(30);
      stream.getVideoTracks()[0].addEventListener('ended',()=>clearInterval(timer));return stream;
    };
    Object.defineProperty(navigator,'canShare',{value:()=>true});
    Object.defineProperty(navigator,'share',{value:async()=>{throw Error('Documentation capture must not upload')}});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>document.getElementById('libraryCount').textContent==='0件');
  await page.locator('#prepareBtn').click();
  await page.waitForFunction(()=>!document.getElementById('recordBtn').disabled);
  await page.locator('#recordBtn').click();await page.waitForTimeout(1100);
  await page.locator('.capture-card').screenshot({path:path.join(output,'capture.png')});
  await context.setGeolocation({latitude:39.704,longitude:141.1534,accuracy:12});await page.waitForTimeout(1100);
  await page.locator('#recordBtn').click();
  await page.waitForFunction(()=>document.getElementById('libraryCount').textContent==='1件');
  const recordId=await page.locator('#recordingSelect').inputValue();
  await page.evaluate(async id=>{const {getRecording,putRecording}=await import('/storage.js');const r=await getRecording(id);r.name='サンプル走行';await putRecording(r)},recordId);
  await page.reload();await page.waitForFunction(()=>document.getElementById('libraryCount').textContent==='1件');
  await page.locator('#recordingSelect').selectOption(recordId);
  await page.waitForFunction(()=>document.getElementById('playback').readyState>=2);
  await page.locator('#playback').evaluate(video=>new Promise(resolve=>{video.addEventListener('seeked',resolve,{once:true});video.currentTime=1}));
  await page.locator('#playback').evaluate(video=>video.play());
  await page.waitForTimeout(200);
  await page.locator('#playback').evaluate(video=>video.pause());
  await page.waitForTimeout(1000);
  await page.waitForSelector('#routeMap .leaflet-tile-loaded');
  await page.locator('#reviewPanel').screenshot({path:path.join(output,'playback.png')});
  const fixture=await page.evaluate(async id=>{const {getRecording}=await import('/storage.js');const r=await getRecording(id);return {bytes:Array.from(new Uint8Array(await r.video.arrayBuffer())),gps:r.points}},recordId);
  await page.locator('.import-form summary').click();
  await page.locator('#importFiles').setInputFiles([
    {name:'sample_drive.webm',mimeType:'video/webm',buffer:Buffer.from(fixture.bytes)},
    {name:'sample_drive_metadata.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({gps:fixture.gps}))}
  ]);
  await page.waitForFunction(()=>!document.getElementById('importBtn').disabled);
  await page.locator('#recordedPanel').screenshot({path:path.join(output,'recorded-data.png')});
  await page.locator('#saveDestination').selectOption('local');
  await page.locator('#exportPanel').screenshot({path:path.join(output,'save-local.png')});
  await page.locator('#saveDestination').selectOption('dropbox');
  await page.waitForFunction(()=>!document.getElementById('saveArchive').disabled);
  await page.locator('#exportPanel').screenshot({path:path.join(output,'save-dropbox.png')});
  if(errors.length)throw Error(errors.join('\n'));
  console.log('Saved five actual UI screenshots using labeled synthetic data to docs/screenshots.');
}finally{await browser?.close();server.close()}
