// Real OPFS/worker/service-worker integration. Uses a temporary browser profile.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const types={'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const server=http.createServer(async(req,res)=>{
  try{const filename=path.resolve(root,'.'+(req.url==='/'?'/index.html':req.url.split('?')[0]));if(!filename.startsWith(root))throw Error();res.setHeader('Content-Type',types[path.extname(filename)]||'application/octet-stream');res.end(await fs.readFile(filename))}catch{res.statusCode=404;res.end()}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
// A fresh normal profile models regular browsing; Chrome private contexts have
// a smaller storage quota and are unsuitable for multi-GB capacity testing.
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'rda-storage-'));
const browser=await chromium.launchPersistentContext(profile,{headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
try{
  const page=await browser.newPage();page.setDefaultTimeout(30000);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.reload();await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  const megabytes=Number(process.env.STORAGE_TEST_MB||600);
  const saved=await page.evaluate(async megabytes=>{
    const {VideoFileWriter}=await import('/video-file.js');
    const writer=await VideoFileWriter.open('disk-test.webm');
    const bytes=new Uint8Array(1024*1024).fill(37),blob=new Blob([bytes]);
    let last;for(let i=0;i<megabytes;i++)last=await writer.append(blob);
    const file=await writer.finish();
    const {putRecording}=await import('/storage.js');
    await putRecording({id:'disk-test',name:'Disk test',createdAt:new Date().toISOString(),video:file,videoPath:writer.path,points:[],duration:1200,fps:30,ext:'webm',meta:{}});
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('geoframe-recordings');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    const raw=await new Promise(resolve=>{const r=db.transaction('recordings').objectStore('recordings').get('disk-test');r.onsuccess=()=>resolve(r.result)});db.close();
    return {size:file.size,hasBlob:Object.hasOwn(raw,'video'),path:raw.videoPath,requested:megabytes,last};
  },megabytes);
  assert.equal(saved.size,megabytes*1024*1024,JSON.stringify(saved));assert.equal(saved.hasBlob,false);assert.equal(saved.path,'disk-test.webm');
  await page.reload();
  const probes=await page.evaluate(async size=>{
    const {getRecording}=await import('/storage.js');const record=await getRecording('disk-test');
    const results=[];
    for(const range of ['bytes=0-31',`bytes=${size-32}-${size-1}`,'bytes=-16']){
      const r=await fetch('/__recordings__/disk-test.webm',{headers:{Range:range}});
      results.push({status:r.status,bytes:Array.from(new Uint8Array(await r.arrayBuffer()))});
    }
    const invalid=await fetch('/__recordings__/disk-test.webm',{headers:{Range:`bytes=${size}-`}});
    return {size:record.video.size,results,invalid:invalid.status};
  },saved.size);
  assert.equal(probes.size,saved.size);assert.equal(probes.invalid,416);
  for(const probe of probes.results){assert.equal(probe.status,206);assert.ok(probe.bytes.length>0&&probe.bytes.every(b=>b===37))}
  await page.evaluate(async()=>{
    const {deleteRecording}=await import('/storage.js');await deleteRecording('disk-test');
    const {VideoFileWriter}=await import('/video-file.js');
    const writer=await VideoFileWriter.open('download-test.zip');await writer.append(new Blob(['download bytes']));await writer.finish();
  });
  assert.equal(await page.evaluate(async()=>{const r=await fetch('/__recordings__/disk-test.webm');return r.status}),404);
  const download=page.waitForEvent('download');
  await page.evaluate(()=>{const a=document.createElement('a');a.href='/__recordings__/download-test.zip?download=road_damage_test.zip';a.download='road_damage_test.zip';a.click()});
  assert.equal((await download).suggestedFilename(),'road_damage_test.zip');
  // Real encoded MP4 remains playable after disk persistence and HTTP range loading.
  const mp4=await page.evaluate(async()=>{
    if(!MediaRecorder.isTypeSupported('video/mp4'))return false;
    const {VideoFileWriter}=await import('/video-file.js');const writer=await VideoFileWriter.open('playback-test.mp4');
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;document.body.prepend(canvas);const ctx=canvas.getContext('2d');
    ctx.fillStyle='#267b81';ctx.fillRect(0,0,320,180);
    const timer=setInterval(()=>{ctx.fillStyle='#267b81';ctx.fillRect(0,0,320,180);ctx.fillStyle='white';ctx.fillText(String(Date.now()),20,50)},33);
    const stream=canvas.captureStream(30),recorder=new MediaRecorder(stream,{mimeType:'video/mp4;codecs=avc1.42E01E'});
    const preview=document.createElement('video');preview.muted=true;preview.srcObject=stream;document.body.prepend(preview);await preview.play();
    const pending=[],sizes=[];let recorderError='';recorder.onerror=e=>recorderError=e.error?.message;recorder.ondataavailable=e=>{sizes.push(e.data.size);if(e.data.size)pending.push(writer.append(e.data))};
    const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.start(200);await new Promise(r=>setTimeout(r,3200));recorder.stop();await stopped;await Promise.all(pending);const writtenFile=await writer.finish();clearInterval(timer);stream.getTracks().forEach(t=>t.stop());
    const video=document.createElement('video');video.muted=true;video.playsInline=true;video.src='/__recordings__/playback-test.mp4';document.body.append(video);
    await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=async()=>{const probe=await fetch(video.src);reject(Error(`persistent MP4 cannot play: ${JSON.stringify({sizes,recorderError,error:video.error?.message,code:video.error?.code,mime:recorder.mimeType,size:writtenFile.size,status:probe.status,header:Array.from(new Uint8Array(await writtenFile.slice(0,32).arrayBuffer()))})}`))};setTimeout(()=>reject(Error('MP4 load timeout')),15000)});
    await video.play();await new Promise(r=>setTimeout(r,200));video.pause();return video.videoWidth===320&&video.currentTime>0;
  });
  assert.equal(mp4,true);
  console.log(`PASS: ${megabytes} MiB streamed to OPFS, no video Blob in IndexedDB, reload, range/suffix/416, deletion, file download, real MP4 playback.`);
}finally{
  await browser.close();server.close();
  if(path.dirname(profile)===os.tmpdir()&&path.basename(profile).startsWith('rda-storage-'))await fs.rm(profile,{recursive:true,force:true});
}
