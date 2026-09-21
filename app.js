import {positionAt, normalizePoints, interpolateFrames, makeCsv, parseLog} from './core.js';
import {listRecordings, getRecording, putRecording, deleteRecording} from './storage.js';

const $=id=>document.getElementById(id);
const preview=$('preview'), playback=$('playback');
let stream=null, recorder=null, watchId=null, gpsGranted=false, cameraReady=false, preparing=false, saving=false, libraryBusy=false;
let facingMode='environment', gpsLog=[], sessionGps=[], latestGps=null, chunks=[], bytes=0;
let startedAt=0, startedMono=0, stoppedMono=0, timerId, wakeLock=null, recordingProblem='';
let result=null, unsaved=false, playbackUrl=null, routeMap=null, routeLine=null, routeMarker=null, tiles=null, mapAvailable=false;
let animationId=null;
const fmt=seconds=>{
  const n=Math.max(0,Math.floor(Number.isFinite(seconds)?seconds:0));
  return [Math.floor(n/3600),Math.floor(n%3600/60),n%60].map(v=>String(v).padStart(2,'0')).join(':');
};
const isRecording=()=>recorder?.state==='recording';
function status(message,error=false){$('status').textContent=message;$('status').style.color=error?'#ff9ca7':''}
function libraryStatus(message){$('libraryStatus').textContent=message}
function controls(){
  const busy=isRecording()||saving||preparing||libraryBusy;
  $('prepareBtn').disabled=busy;
  $('prepareBtn').textContent=preparing?'許可を確認中…':cameraReady&&gpsGranted?'位置情報・カメラ許可中':'カメラとGPSを許可';
  $('recordBtn').disabled=preparing||saving||libraryBusy||(!isRecording()&&(!cameraReady||!gpsGranted||!window.MediaRecorder));
  $('switchBtn').disabled=busy||!cameraReady;
  $('recordAudio').disabled=busy;
  $('clearTrackBtn').disabled=isRecording()||saving;
  $('recordingSelect').disabled=busy||libraryBusy;
  $('openRecording').disabled=busy||libraryBusy||!$('recordingSelect').value;
  $('deleteRecording').disabled=busy||libraryBusy||!$('recordingSelect').value;
  $('importBtn').disabled=busy||libraryBusy;
  ['downloadVideo','downloadGps','downloadMeta'].forEach(id=>$(id).disabled=!result||saving||isRecording());
}

async function prepareCamera(){
  if(preparing||isRecording()||saving)return;
  if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){status('カメラにはHTTPS接続と対応ブラウザが必要です。',true);return}
  preparing=true;cameraReady=false;controls();
  status('カメラと位置情報の利用を許可してください。');
  startGps();
  try {
    stream?.getTracks().forEach(track=>track.stop());
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facingMode},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}},audio:$('recordAudio').checked});
    preview.srcObject=stream;
    await preview.play();
    cameraReady=true;$('cameraEmpty').hidden=true;
    stream.getVideoTracks()[0].addEventListener('ended',()=>{
      cameraReady=false;$('cameraEmpty').hidden=false;
      if(isRecording()){recordingProblem='カメラ接続が切れたため録画を終了しました。';stopRecording()}
      status('カメラ接続が切れました。もう一度許可ボタンを押してください。',true);controls();
    });
    status(gpsGranted?'準備完了。中央のボタンで撮影を開始できます。':'カメラの準備完了。GPSの取得を待っています。');
    if(!window.MediaRecorder)status('このブラウザは録画に対応していません。保存済み動画の閲覧は利用できます。',true);
  } catch(error){
    stream?.getTracks().forEach(t=>t.stop());stream=null;preview.srcObject=null;$('cameraEmpty').hidden=false;
    status(error.name==='NotAllowedError'?'カメラが許可されていません。ブラウザのサイト設定で許可して再試行してください。':'カメラを開始できません。他のアプリで使用中でないか確認して再試行してください。',true);
  } finally {preparing=false;controls()}
}

function startGps(){
  if(watchId!==null)return;
  if(!navigator.geolocation){status('このブラウザでは位置情報を利用できません。',true);return}
  $('gpsState').textContent='測位中';$('gpsState').className='state';
  watchId=navigator.geolocation.watchPosition(p=>{
    const c=p.coords;
    if(!Number.isFinite(c.latitude)||!Number.isFinite(c.longitude))return;
    const recovered=!gpsGranted||$('gpsState').classList.contains('bad');gpsGranted=true;
    const point={timestamp:p.timestamp,absoluteTime:new Date(p.timestamp).toISOString(),latitude:c.latitude,longitude:c.longitude,altitude:c.altitude,accuracy:c.accuracy,speed:c.speed,heading:c.heading};
    latestGps=point;gpsLog.push(point);if(gpsLog.length>10000)gpsLog.shift();
    if(isRecording()){
      const videoTime=(performance.now()-startedMono-Math.max(0,Date.now()-p.timestamp))/1000;
      if(videoTime>=0&&(!sessionGps.length||videoTime>sessionGps.at(-1).videoTime))sessionGps.push({...point,videoTime});
    }
    $('latitude').textContent=c.latitude.toFixed(7);$('longitude').textContent=c.longitude.toFixed(7);
    $('altitude').textContent=c.altitude==null?'—':`${c.altitude.toFixed(1)} m`;
    $('speed').textContent=c.speed==null?'—':`${(c.speed*3.6).toFixed(1)} km/h`;
    $('accuracy').textContent=`±${c.accuracy.toFixed(1)} m`;
    $('pointCount').textContent=isRecording()?sessionGps.length:gpsLog.length;
    $('gpsState').textContent=c.accuracy>50?'精度低下':'取得中';$('gpsState').className=c.accuracy>50?'state':'state good';
    if(recovered&&cameraReady&&!isRecording()&&!saving)status('準備完了。中央のボタンで撮影を開始できます。');
    controls();drawLiveTrack();
  },error=>{
    $('gpsState').textContent=error.code===1?'未許可':'取得失敗';$('gpsState').className='state bad';
    if(error.code===1){gpsGranted=false;navigator.geolocation.clearWatch(watchId);watchId=null}
    status(error.code===1?'位置情報が許可されていません。サイト設定で許可し、もう一度許可ボタンを押してください。':'GPSを取得できません。位置情報設定や電波状況を確認してください。',true);controls();
  },{enableHighAccuracy:true,maximumAge:0,timeout:15000});
}

async function acquireWakeLock(){
  try{if(navigator.wakeLock&&isRecording()&&document.visibilityState==='visible')wakeLock=await navigator.wakeLock.request('screen')}catch{}
}
function stopRecording(){
  if(!isRecording())return;
  stoppedMono=performance.now();saving=true;recorder.stop();clearInterval(timerId);controls();status('録画を終了し、端末に保存しています…');
}
function toggleRecord(){
  if(isRecording()){stopRecording();return}
  if(!cameraReady||!gpsGranted||saving)return;
  if(!latestGps||Date.now()-latestGps.timestamp>15000){status('新しいGPS位置情報を待ってから撮影してください。',true);return}
  if(unsaved&&!confirm('未保存の記録があります。先にダウンロードしてください。新しい録画を開始しますか？'))return;
  playback.pause();chunks=[];bytes=0;sessionGps=[];recordingProblem='';
  try{
    const mime=['video/webm;codecs=vp8','video/webm','video/mp4'].find(t=>MediaRecorder.isTypeSupported(t));
    recorder=new MediaRecorder(stream,mime?{mimeType:mime,videoBitsPerSecond:6000000}:undefined);
    recorder.ondataavailable=e=>{
      if(e.data.size){chunks.push(e.data);bytes+=e.data.size}
      if(bytes>=512*1024*1024&&isRecording()){recordingProblem='録画サイズが512 MBに達したため終了しました。';stopRecording()}
    };
    recorder.onstop=finishRecording;
    recorder.onerror=()=>{recordingProblem='録画エラーが発生しました。保存された動画を確認してください。';if(isRecording())stopRecording()};
    startedAt=Date.now();startedMono=performance.now();stoppedMono=0;
    sessionGps=[{...latestGps,videoTime:0}];
    recorder.start(1000);
  }catch{status('録画を開始できません。カメラを再接続して再試行してください。',true);return}
  $('recordBtn').classList.add('recording');$('recordBtn').setAttribute('aria-label','撮影停止');$('recIndicator').hidden=false;
  $('timer').textContent='00:00:00';$('pointCount').textContent=sessionGps.length;
  timerId=setInterval(()=>$('timer').textContent=fmt((performance.now()-startedMono)/1000),250);
  controls();drawLiveTrack();acquireWakeLock();status('動画とGPSを記録中。画面を開いたまま使用してください。');
}

async function finishRecording(){
  saving=true;clearInterval(timerId);controls();
  if(wakeLock){wakeLock.release().catch(()=>{});wakeLock=null}
  const duration=((stoppedMono||performance.now())-startedMono)/1000;
  const type=recorder.mimeType||chunks[0]?.type||'video/webm',ext=type.includes('mp4')?'mp4':'webm';
  const video=new Blob(chunks,{type});chunks=[];
  $('recordBtn').classList.remove('recording');$('recordBtn').setAttribute('aria-label','撮影開始');$('recIndicator').hidden=true;
  $('timer').textContent=fmt(duration);
  if(!video.size){saving=false;status('動画データを取得できませんでした。カメラを再接続してください。',true);controls();return}
  const createdAt=new Date(startedAt).toISOString(),fps=stream?.getVideoTracks()[0]?.getSettings().frameRate||30;
  result={id:crypto.randomUUID(),name:`撮影 ${new Date(startedAt).toLocaleString('ja-JP')}`,createdAt,video,ext,duration,
    points:normalizePoints(sessionGps),fps,meta:{formatVersion:2,createdAt,durationSeconds:duration,estimatedFrameRate:fps,
      videoFile:`video.${ext}`,gpsFile:'gps.csv',audio:stream.getAudioTracks().length>0,note:'Frame times are estimated at the camera frame rate, not decoded frame timestamps. Positions are interpolated GPS estimates; endpoints use the nearest sample.'}};
  unsaved=true;
  try{
    await putRecording(result);unsaved=false;await refreshLibrary(result.id);
    status(`${recordingProblem}録画を保存しました。ライブラリからいつでも確認できます。`,!!recordingProblem);
  }catch{libraryStatus('端末への保存に失敗しました。空き容量を確認し、記録データをダウンロードしてください。');status('保存できませんでした。画面を閉じる前に動画と位置情報をダウンロードしてください。',true)}
  finally{saving=false;controls();showReview()}
}

async function refreshLibrary(selected=$('recordingSelect').value){
  const rows=await listRecordings(),select=$('recordingSelect');
  select.replaceChildren(new Option(rows.length?'動画を選択してください':'保存された動画はありません',''));
  rows.forEach(row=>select.add(new Option(`${row.name} · ${fmt(row.duration)} · ${(row.size/1024/1024).toFixed(1)} MB`,row.id)));
  select.value=selected;$('libraryCount').textContent=`${rows.length}件`;
  libraryStatus(rows.length?'動画を選んで「再生・軌跡を表示」を押してください。':'撮影した動画はここに自動保存されます。過去の動画も読み込めます。');controls();
}

function showReview(){
  playback.pause();if(playbackUrl)URL.revokeObjectURL(playbackUrl);
  playbackUrl=URL.createObjectURL(result.video);playback.src=playbackUrl;playback.load();
  $('reviewPanel').hidden=false;$('recordingSummary').textContent=`${result.name} · ${fmt(result.duration)} · GPS ${result.points.length}点`;
  $('videoFileLabel').textContent=`video.${result.ext}`;
  requestAnimationFrame(()=>{initMap();renderRoute();updatePlaybackPosition();$('reviewPanel').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'})});
  controls();
}

function initMap(){
  if(routeMap){routeMap.invalidateSize();return}
  if(!window.L){$('routeMap').hidden=true;return}
  routeMap=L.map('routeMap',{dragging:false,touchZoom:false,scrollWheelZoom:false,doubleClickZoom:false,boxZoom:false,keyboard:false}).setView([0,0],17);
  tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'});
  tiles.on('tileerror',()=>{mapAvailable=false;$('routeMap').style.opacity='0';$('routeMap').style.pointerEvents='none';$('reviewNote').textContent='地図を取得できないため、現在位置を中央にした相対軌跡を表示しています。北が上です。'});
  tiles.on('tileload',()=>{mapAvailable=true;$('routeMap').style.opacity='';$('routeMap').style.pointerEvents='';$('reviewNote').textContent='再生位置に合わせて推定位置を中央に表示します。地図のズームは＋／−で変更できます。'});
  tiles.addTo(routeMap);
  routeMarker=L.marker([0,0],{interactive:false,icon:L.divIcon({className:'',html:'<div class="route-marker"></div>',iconSize:[22,22],iconAnchor:[11,11]})});
  routeMap.on('zoomend',updatePlaybackPosition);
}
function renderRoute(){
  if(!routeMap)return;
  routeLine?.remove();routeMarker?.remove();
  // Preserve gaps in imported logs instead of connecting through unknown positions.
  const segments=[];let segment=[];
  for(const p of result.points){if(p.latitude==null){if(segment.length)segments.push(segment);segment=[]}else segment.push([p.latitude,p.longitude])}
  if(segment.length)segments.push(segment);
  routeLine=L.polyline(segments,{color:'#2de0cf',weight:4,opacity:.9}).addTo(routeMap);
}
function updatePlaybackPosition(time=playback.currentTime||0){
  if(typeof time!=='number')time=playback.currentTime||0;
  if(!result)return;
  const duration=Number.isFinite(playback.duration)?playback.duration:result.duration;
  $('reviewPosition').textContent=`${fmt(time)} / ${fmt(duration)}`;$('mapTime').textContent=`${fmt(time)}.${String(Math.floor(time%1*1000)).padStart(3,'0')}`;
  const point=positionAt(result.points,time);
  if(!point||point.latitude==null){routeMarker?.remove();$('routeMap').hidden=true;$('mapCoordinates').textContent='この時刻の位置情報なし';drawTrack($('routeFallback'),[],null);return}
  $('routeMap').hidden=!routeMap;
  if(routeMap){routeMap.invalidateSize();routeMarker.setLatLng([point.latitude,point.longitude]);if(!routeMap.hasLayer(routeMarker))routeMarker.addTo(routeMap);routeMap.setView([point.latitude,point.longitude],routeMap.getZoom(),{animate:false})}
  $('mapCoordinates').textContent=`${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}${point.accuracy==null?'':` ±${point.accuracy.toFixed(1)} m`}`;
  if(!mapAvailable||!routeMap)drawTrack($('routeFallback'),result.points,point);
}
function playbackLoop(){
  updatePlaybackPosition();
  if(!playback.paused&&!playback.ended)animationId=requestAnimationFrame(playbackLoop);
}

function drawTrack(canvas,points,center){
  const ctx=canvas.getContext('2d'),dpr=devicePixelRatio||1,w=canvas.clientWidth||800,h=canvas.clientHeight||360;
  if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr)}
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.fillStyle='#071219';ctx.fillRect(0,0,w,h);
  ctx.strokeStyle='#19313d';ctx.lineWidth=1;
  for(let x=w/2%40;x<w;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke()}
  for(let y=h/2%40;y<h;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}
  ctx.fillStyle='#91a9b4';ctx.font='12px system-ui';ctx.fillText('N ↑',12,22);
  if(!center){ctx.fillText('位置情報を待っています',Math.max(12,w/2-65),h/2);return}
  const cos=Math.max(.01,Math.cos(center.latitude*Math.PI/180));
  const xy=p=>[(((p.longitude-center.longitude+540)%360)-180)*111320*cos,(p.latitude-center.latitude)*111320];
  let maxX=25,maxY=25;
  for(const p of points){if(p.latitude==null)continue;const [x,y]=xy(p);maxX=Math.max(maxX,Math.abs(x));maxY=Math.max(maxY,Math.abs(y))}
  const scale=Math.min((w/2-24)/maxX,(h/2-24)/maxY);
  ctx.beginPath();let pen=false;
  for(const p of points){if(p.latitude==null){pen=false;continue}const [x,y]=xy(p);if(pen)ctx.lineTo(w/2+x*scale,h/2-y*scale);else ctx.moveTo(w/2+x*scale,h/2-y*scale);pen=true}
  ctx.strokeStyle='#2de0cf';ctx.lineWidth=3;ctx.lineJoin='round';ctx.stroke();
  ctx.fillStyle='#ffc857';ctx.beginPath();ctx.arc(w/2,h/2,6,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();
}
function drawLiveTrack(){const points=isRecording()?sessionGps:gpsLog;drawTrack($('trackCanvas'),points,points.at(-1))}

async function importRecording(event){
  event.preventDefault();if(libraryBusy||isRecording()||saving)return;
  const video=$('importVideo').files[0],log=$('importLog').files[0];if(!video)return;
  if(unsaved&&!confirm('未保存の記録があります。新しい動画を読み込みますか？'))return;
  libraryBusy=true;controls();libraryStatus('動画と位置情報を読み込んでいます…');
  try{
    if(!video.size)throw new Error('空の動画は読み込めません。');
    if(log&&log.size>100*1024*1024)throw new Error('位置情報ファイルは100 MB以下で選択してください。');
    const {points,meta}=log?parseLog(await log.text(),log.name):{points:[],meta:{}};
    const measured=await videoDuration(video);
    const duration=Number.isFinite(measured)?measured:Number.isFinite(meta.durationSeconds)?meta.durationSeconds:points.at(-1)?.videoTime||0;
    if(points.length&&Number.isFinite(measured)&&points.at(-1).videoTime>measured+2)throw new Error('位置情報が動画の長さを超えています。同じ撮影のファイルを選択してください。');
    const imported={id:crypto.randomUUID(),name:video.name,createdAt:new Date().toISOString(),video,ext:video.name.split('.').pop().toLowerCase(),duration,points,
      fps:Number.isFinite(meta.estimatedFrameRate)&&meta.estimatedFrameRate>0?Math.min(120,meta.estimatedFrameRate):30,meta};
    result=imported;unsaved=true;
    try{await putRecording(imported);unsaved=false;await refreshLibrary(imported.id);libraryStatus('読み込み、保存しました。位置情報は同じ撮影のファイルか再生画面で確認してください。')}
    catch{libraryStatus('読み込みましたが端末への保存に失敗しました。空き容量を確認してください。この画面では再生できます。')}
    showReview();$('importForm').reset();
  }catch(error){libraryStatus(`読み込めませんでした：${error.message}`)}
  finally{libraryBusy=false;controls()}
}
function videoDuration(file){
  return new Promise((resolve,reject)=>{
    const video=document.createElement('video'),url=URL.createObjectURL(file);
    video.preload='metadata';video.muted=true;video.playsInline=true;
    const cleanup=()=>{clearTimeout(timeout);video.removeAttribute('src');video.load();URL.revokeObjectURL(url)};
    const timeout=setTimeout(()=>{cleanup();reject(new Error('動画の読み込みがタイムアウトしました。'))},15000);
    video.onloadedmetadata=()=>{const duration=video.duration;cleanup();resolve(duration)};
    video.onerror=()=>{cleanup();reject(new Error('この端末で再生できない動画形式です。MP4などの対応形式を選択してください。'))};video.src=url;
  });
}
function save(blob,name){const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000)}
function basename(){return `geoframe_${result.id}`}

$('prepareBtn').onclick=prepareCamera;$('recordBtn').onclick=toggleRecord;
$('recordAudio').onchange=()=>{if(cameraReady)prepareCamera()};
$('switchBtn').onclick=()=>{facingMode=facingMode==='environment'?'user':'environment';prepareCamera()};
$('clearTrackBtn').onclick=()=>{if(isRecording())return;gpsLog=latestGps?[latestGps]:[];drawLiveTrack();$('pointCount').textContent=gpsLog.length};
$('recordingSelect').onchange=controls;
$('openRecording').onclick=async()=>{
  if(unsaved&&!confirm('未保存の記録があります。別の動画を開きますか？'))return;
  libraryBusy=true;controls();
  try{const record=await getRecording($('recordingSelect').value);if(!record)throw new Error();result=record;unsaved=false;showReview();libraryStatus('選択した動画と位置情報を表示しています。')}
  catch{libraryStatus('録画を開けませんでした。再読み込みして試してください。')}
  finally{libraryBusy=false;controls()}
};
$('deleteRecording').onclick=async()=>{
  const id=$('recordingSelect').value;if(!id||!confirm('選択した録画と位置情報をこのブラウザから削除しますか？この操作は取り消せません。'))return;
  libraryBusy=true;controls();
  try{await deleteRecording(id);if(result?.id===id){playback.pause();playback.removeAttribute('src');playback.load();URL.revokeObjectURL(playbackUrl);playbackUrl=null;result=null;unsaved=false;$('reviewPanel').hidden=true;$('recordingSummary').textContent='動画を選択してください'}await refreshLibrary();libraryStatus('録画を削除しました。')}
  catch{libraryStatus('削除できませんでした。再試行してください。')}
  finally{libraryBusy=false;controls()}
};
$('importForm').onsubmit=importRecording;
$('downloadVideo').onclick=()=>save(result.video,`${basename()}.${result.ext}`);
$('downloadGps').onclick=()=>save(new Blob([makeCsv(result.points)],{type:'text/csv;charset=utf-8'}),`${basename()}_gps.csv`);
$('downloadMeta').onclick=()=>{
  const meta={...result.meta,formatVersion:2,durationSeconds:result.duration,videoFile:`${basename()}.${result.ext}`,gpsFile:`${basename()}_gps.csv`,gps:result.points,
    estimatedFrameRate:result.fps,frames:interpolateFrames(result.points,result.duration,result.fps)};
  save(new Blob([JSON.stringify(meta)],{type:'application/json'}),`${basename()}_metadata.json`);
};
['timeupdate','seeked','loadedmetadata','durationchange'].forEach(type=>playback.addEventListener(type,()=>updatePlaybackPosition()));
playback.addEventListener('play',()=>{cancelAnimationFrame(animationId);playbackLoop()});
playback.addEventListener('pause',()=>{cancelAnimationFrame(animationId);updatePlaybackPosition()});
playback.addEventListener('error',()=>{if(result)libraryStatus('動画を再生できません。この端末が対応する形式の動画を選択してください。')});
window.addEventListener('resize',()=>{drawLiveTrack();routeMap?.invalidateSize();updatePlaybackPosition()});
window.addEventListener('beforeunload',e=>{if(isRecording()||saving||unsaved){e.preventDefault();e.returnValue=''}});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden&&isRecording()){recordingProblem='画面が非表示になったため録画を終了しました。';stopRecording()}
});
window.addEventListener('pagehide',()=>{if(isRecording())stopRecording();stream?.getTracks().forEach(t=>t.stop());cameraReady=false;if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null}gpsGranted=false});
window.addEventListener('pageshow',()=>{if(!cameraReady){$('cameraEmpty').hidden=false;controls()}});
$('secureBadge').textContent=window.isSecureContext?'端末内に保存':'HTTPSが必要';$('secureBadge').className=`badge ${window.isSecureContext?'good':'bad'}`;
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>libraryStatus('オフライン機能を準備できませんでした。オンラインでご利用ください。'));
refreshLibrary().catch(()=>{libraryStatus('端末内ストレージを利用できません。録画後は必ずダウンロードしてください。');$('libraryCount').textContent='保存不可'});
drawLiveTrack();controls();

