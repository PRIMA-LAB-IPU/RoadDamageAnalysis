import {ImportSource} from './import-controller.js';
import {qualityPreset,cameraConstraints,recorderOptions,cameraQualitySummary,optimizeTrack} from './quality.js';
import {positionAt, normalizePoints, interpolateFrames, makeCsv, parseLog} from './core.js';
import {listRecordings, getRecording, putRecording, deleteRecording} from './storage.js';
import {TrackMap} from './map-view.js';
import {recordingArchive,recordingMetadata,recordingShareFiles,shareRecordingFiles,savePreparedArchive,supportsFileShare} from './export.js';

const $=id=>document.getElementById(id);
const preview=$('preview'), playback=$('playback');
let stream=null, recorder=null, watchId=null, gpsGranted=false, cameraReady=false, preparing=false, saving=false, libraryBusy=false;
let facingMode='environment', gpsLog=[], sessionGps=[], latestGps=null, chunks=[], bytes=0;
let startedAt=0, startedMono=0, stoppedMono=0, timerId, wakeLock=null, recordingProblem='';
let result=null, unsaved=false, playbackUrl=null;
const liveMap=new TrackMap('live'), reviewMap=new TrackMap('route');
let archiveFile=null,archiveId=null,exportBusy=false,shareFiles=[];
const sharedFiles=new Set();
let preparationWorker=null,preparationVersion=0,preparingFiles=false,selectionVersion=0;
let animationId=null;
let sessionCapture=null;
const importSource=new ImportSource(controls);
try{const quality=localStorage.getItem('road-damage-quality');if(['high','ultra','smooth','compact'].includes(quality))$('qualitySelect').value=quality}catch{}
function updateQualityReadout(){
  const settings=stream?.getVideoTracks()[0]?.getSettings()||{};
  $('qualityReadout').textContent=cameraQualitySummary($('qualitySelect').value,settings);
  const width=preview.videoWidth||settings.width,height=preview.videoHeight||settings.height;
  if(width&&height)preview.parentElement.style.aspectRatio=String(width/height);
}
preview.addEventListener('resize',updateQualityReadout);
updateQualityReadout();
const fmt=seconds=>{
  const n=Math.max(0,Math.floor(Number.isFinite(seconds)?seconds:0));
  return [Math.floor(n/3600),Math.floor(n%3600/60),n%60].map(v=>String(v).padStart(2,'0')).join(':');
};
const isRecording=()=>recorder?.state==='recording';
function status(message,error=false){$('status').hidden=!message;$('status').textContent=message;$('status').style.color=error?'#ff9ca7':''}
function libraryStatus(message){$('libraryStatus').textContent=message;$('libraryStatus').hidden=!message}
function controls(){
  const busy=isRecording()||saving||preparing||libraryBusy||exportBusy;
  $('prepareBtn').disabled=busy;
  const permissionLabel=preparing?'許可を確認中…':cameraReady&&gpsGranted?'位置情報・カメラ許可中':'カメラとGPSを許可';
  $('prepareBtn').setAttribute('aria-label',permissionLabel);$('prepareBtn').title=permissionLabel;$('prepareBtn').setAttribute('aria-busy',String(preparing));
  $('cameraPermission').classList.toggle('granted',cameraReady);$('gpsPermission').classList.toggle('granted',gpsGranted);
  $('recordBtn').disabled=preparing||saving||libraryBusy||exportBusy||(!isRecording()&&(!cameraReady||!gpsGranted||!window.MediaRecorder));
  $('switchBtn').disabled=busy||!cameraReady;
  $('recordAudio').disabled=busy;$('qualitySelect').disabled=busy;
  $('clearTrackBtn').disabled=isRecording()||saving;
  $('recordingSelect').disabled=busy||libraryBusy;
  $('deleteRecording').disabled=busy||libraryBusy||!$('recordingSelect').value;
  importSource.updateDisabled(busy);
  ['downloadVideo','downloadGps','downloadMeta'].forEach(id=>$(id).disabled=!result||saving||isRecording()||exportBusy);
  const dropbox=$('saveDestination').value==='dropbox',prepared=archiveId===result?.id&&shareFiles.length>0;
  $('saveArchive').disabled=busy||!result||(dropbox&&(!prepared||preparingFiles||!supportsFileShare(shareFiles)));
  $('saveArchive').textContent=dropbox?(exportBusy?'アップロード中…':'アップロード'):(exportBusy?'保存中…':'保存');
  $('exportPanel').setAttribute('aria-busy',String(exportBusy||preparingFiles));
  $('reviewLink').setAttribute('aria-disabled',String(!result));
  $('saveDestination').disabled=busy;$('dropboxFiles').hidden=!dropbox||!prepared;
  ['shareVideo','shareGps','shareMetadata'].forEach((id,index)=>$(id).disabled=busy||!prepared||!supportsFileShare(shareFiles[index]));
}

async function prepareCamera(){
  if(preparing||isRecording()||saving)return;
  if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){status('カメラにはHTTPS接続と対応ブラウザが必要です。',true);return}
  preparing=true;cameraReady=false;controls();
  status('カメラと位置情報の利用を許可してください。');
  startGps();
  try {
    stream?.getTracks().forEach(track=>track.stop());
    stream=await navigator.mediaDevices.getUserMedia(cameraConstraints($('qualitySelect').value,facingMode,$('recordAudio').checked));
    await optimizeTrack(stream.getVideoTracks()[0],$('qualitySelect').value);
    preview.srcObject=stream;
    await preview.play();
    cameraReady=true;$('cameraEmpty').hidden=true;updateQualityReadout();
    stream.getVideoTracks()[0].addEventListener('ended',()=>{
      cameraReady=false;$('cameraEmpty').hidden=false;
      if(isRecording()){recordingProblem='カメラ接続が切れたため録画を終了しました。';stopRecording()}
      status('カメラ接続が切れました。もう一度許可ボタンを押してください。',true);controls();
    });
    status(gpsGranted?'準備完了。中央のボタンで撮影を開始できます。':'カメラの準備完了。GPSの取得を待っています。');
    if(!window.MediaRecorder)status('このブラウザは録画に対応していません。保存済み動画の閲覧は利用できます。',true);
  } catch(error){
    stream?.getTracks().forEach(t=>t.stop());stream=null;preview.srcObject=null;$('cameraEmpty').hidden=false;updateQualityReadout();
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
    const quality=$('qualitySelect').value;
    recorder=new MediaRecorder(stream,recorderOptions(quality,mime));
    const settings=stream.getVideoTracks()[0].getSettings();
    sessionCapture={quality,requested:{...qualityPreset(quality)},width:settings.width??null,height:settings.height??null,
      frameRate:settings.frameRate??qualityPreset(quality).fps,requestedVideoBitsPerSecond:qualityPreset(quality).bitrate,
      encoderVideoBitsPerSecond:recorder.videoBitsPerSecond??null,mimeType:recorder.mimeType,audio:stream.getAudioTracks().length>0};
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
  const createdAt=new Date(startedAt).toISOString(),fps=sessionCapture?.frameRate||30;
  result={id:crypto.randomUUID(),name:`撮影 ${new Date(startedAt).toLocaleString('ja-JP')}`,createdAt,video,ext,duration,
    points:normalizePoints(sessionGps),fps,meta:{formatVersion:2,createdAt,durationSeconds:duration,estimatedFrameRate:fps,
      videoFile:`video.${ext}`,gpsFile:'gps.csv',audio:sessionCapture?.audio??false,capture:sessionCapture,note:'Frame times are estimated at the camera frame rate, not decoded frame timestamps. Positions are interpolated GPS estimates; endpoints use the nearest sample.'}};
  unsaved=true;
  try{
    await putRecording(result);unsaved=false;await refreshLibrary(result.id);
    status(`${recordingProblem}録画を保存しました。`,!!recordingProblem);
  }catch{libraryStatus('端末への保存に失敗しました。「データの保存」からダウンロードしてください。');status('保存できませんでした。画面を閉じる前に動画と位置情報をダウンロードしてください。',true)}
  finally{saving=false;controls();showReview()}
}

async function refreshLibrary(selected=$('recordingSelect').value){
  const rows=await listRecordings(),select=$('recordingSelect');
  select.replaceChildren(new Option(rows.length?'動画を選択してください':'保存された動画はありません',''));
  rows.forEach(row=>select.add(new Option(`${row.name} · ${fmt(row.duration)} · ${(row.size/1024/1024).toFixed(1)} MB`,row.id)));
  select.value=selected;$('libraryCount').textContent=`${rows.length}件`;
  libraryStatus(rows.length?'':'録画データはまだありません。');controls();
}

function showReview(){
  resetArchive();prepareShareFiles();playback.pause();if(playbackUrl)URL.revokeObjectURL(playbackUrl);
  playbackUrl=URL.createObjectURL(result.video);playback.src=playbackUrl;playback.load();playback.playbackRate=Number($('playbackSpeed').value);
  $('reviewPanel').hidden=false;$('recordingSummary').textContent=`${result.name} · ${fmt(result.duration)} · GPS ${result.points.length}点`;
  $('videoFileLabel').textContent=`video.${result.ext}`;
  requestAnimationFrame(()=>{reviewMap.setRoute(result.points);updatePlaybackPosition();$('reviewPanel').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'})});
  controls();
}

function updatePlaybackPosition(time=playback.currentTime||0){
  if(typeof time!=='number')time=playback.currentTime||0;
  if(!result)return;
  const duration=Number.isFinite(playback.duration)?playback.duration:result.duration;
  $('reviewPosition').textContent=`${fmt(time)} / ${fmt(duration)}`;$('mapTime').textContent=`${fmt(time)}.${String(Math.floor(time%1*1000)).padStart(3,'0')}`;
  const point=positionAt(result.points,time);
  reviewMap.setPosition(point);
  if(!point||point.latitude==null){$('mapCoordinates').textContent='この時刻の位置情報なし';return}
  $('mapCoordinates').textContent=`${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}${point.accuracy==null?'':` ±${point.accuracy.toFixed(1)} m`}`;
}
function playbackLoop(){
  updatePlaybackPosition();
  if(!playback.paused&&!playback.ended)animationId=requestAnimationFrame(playbackLoop);
}

function drawLiveTrack(){const points=isRecording()?sessionGps:gpsLog;liveMap.setRoute(points);liveMap.setPosition(points.at(-1))}

async function importRecording(event){
  event.preventDefault();if(libraryBusy||isRecording()||saving)return;
  const {video,match}=importSource.snapshot();if(!video||importSource.busy)return;
  if(match.status==='ambiguous'){libraryStatus('同名の位置情報が複数あります。フォルダーを選び直してください。');return}
  const log=match.entry?.file;
  if(unsaved&&!confirm('未保存の記録があります。新しい動画を読み込みますか？'))return;
  libraryBusy=true;controls();libraryStatus('動画と位置情報を読み込んでいます…');
  try{
    if(!video.size)throw new Error('空の動画は読み込めません。');
    if(log&&log.size>100*1024*1024)throw new Error('位置情報ファイルは100 MB以下で選択してください。');
    const {points,meta}=log?parseLog(await log.text(),log.name):match.status==='stored'?{points:match.recording.points,meta:match.recording.meta}:{points:[],meta:{}};
    const measured=await videoDuration(video);
    const duration=Number.isFinite(measured)?measured:Number.isFinite(meta.durationSeconds)?meta.durationSeconds:points.at(-1)?.videoTime||0;
    if(points.length&&Number.isFinite(measured)&&points.at(-1).videoTime>measured+2)throw new Error('位置情報が動画の長さを超えています。同じ撮影のファイルを選択してください。');
    const imported={id:crypto.randomUUID(),name:video.name,createdAt:new Date().toISOString(),video,ext:video.name.split('.').pop().toLowerCase(),duration,points,
      fps:Number.isFinite(meta.estimatedFrameRate)&&meta.estimatedFrameRate>0?Math.min(120,meta.estimatedFrameRate):30,meta};
    result=imported;unsaved=true;
    try{await putRecording(imported);unsaved=false;await refreshLibrary(imported.id);libraryStatus(points.length?'動画と対応する位置情報を保存しました。':'位置情報なしで動画を保存しました。')}
    catch{libraryStatus('読み込みましたが端末への保存に失敗しました。空き容量を確認してください。この画面では再生できます。')}
    showReview();
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
function basename(){return `road_damage_${result.id}`}

const destinations={local:'このデバイス',dropbox:'Dropbox'};
function exportStatus(message){$('saveStatus').hidden=!message;$('saveStatus').textContent=message}
function destinationHint(){
  const dropbox=$('saveDestination').value==='dropbox',prepared=archiveId===result?.id&&shareFiles.length>0;
  $('saveHint').textContent=!dropbox?'ZIP · 動画と位置情報':preparingFiles?'ファイルを準備しています…':
    prepared&&!supportsFileShare(shareFiles)?'まとめて共有できません。「個別にアップロード」をお使いください。':
    '3ファイル · 共有画面でDropboxを選択';
  if(prepared&&dropbox&&!supportsFileShare(shareFiles))$('dropboxFiles').open=true;
}
function shareProgress(){
  $('shareProgress').hidden=!sharedFiles.size;
  $('shareProgress').textContent=`共有先へ送信：${sharedFiles.size} / 3。保存完了はDropboxで確認してください。`;
}
function resetArchive(){
  ++preparationVersion;preparationWorker?.terminate();preparationWorker=null;preparingFiles=false;
  archiveFile=null;archiveId=null;shareFiles=[];sharedFiles.clear();$('dropboxFiles').open=false;exportStatus('');shareProgress();destinationHint();
}
function prepareShareFiles(){
  if(!result)return;
  const selected=result,version=preparationVersion;preparingFiles=true;destinationHint();controls();
  const finish=(files,error)=>{
    if(version!==preparationVersion||result?.id!==selected.id)return;
    preparationWorker?.terminate();preparationWorker=null;preparingFiles=false;
    if(error){exportStatus('共有ファイルを準備できませんでした。録画データを選び直すか、ローカル保存をご利用ください。')}
    else{shareFiles=files;archiveId=selected.id}
    destinationHint();controls();
  };
  const fallback=()=>setTimeout(()=>{if(version!==preparationVersion)return;try{finish(recordingShareFiles(selected))}catch(error){finish(null,error)}},0);
  try{
    preparationWorker=new Worker(new URL('./export-worker.js',import.meta.url),{type:'module'});
    preparationWorker.onmessage=({data})=>finish(data.files,data.error);
    preparationWorker.onerror=event=>{event.preventDefault();if(version!==preparationVersion)return;preparationWorker?.terminate();preparationWorker=null;fallback()};
    preparationWorker.postMessage(selected);
  }catch{preparationWorker?.terminate();preparationWorker=null;fallback()}
}
try{const saved=localStorage.getItem('road-damage-save-destination');$('saveDestination').value=Object.hasOwn(destinations,saved)?saved:'local';localStorage.setItem('road-damage-save-destination',$('saveDestination').value)}catch{}
$('saveDestination').onchange=()=>{try{localStorage.setItem('road-damage-save-destination',$('saveDestination').value)}catch{}exportStatus('');destinationHint();controls()};
function shareError(error){
  $('dropboxFiles').open=true;
  exportStatus(error.name==='AbortError'?'アップロードを中止しました。再試行できます。':'共有できませんでした。個別アップロードかローカル保存をご利用ください。');
}
async function sendDropbox(indices){
  if(archiveId!==result?.id||!shareFiles.length||exportBusy||preparingFiles)return;
  exportBusy=true;controls();
  try{
    // Cached Files keep share() in this button's user activation, including Android.
    await shareRecordingFiles(indices.map(index=>shareFiles[index]));
    indices.forEach(index=>sharedFiles.add(index));shareProgress();exportStatus('Dropboxを共有先に選択し、保存を完了してください。');
  }catch(error){shareError(error)}finally{exportBusy=false;controls()}
}
$('saveArchive').onclick=async()=>{
  if($('saveDestination').value==='dropbox'){await sendDropbox([0,1,2]);return}
  if(!result||exportBusy||isRecording())return;
  exportBusy=true;controls();
  try{
    const selected=result;
    const outcome=await savePreparedArchive(`road_damage_${selected.id}.zip`,async()=>{
      if(!archiveFile)archiveFile=await recordingArchive(selected,progress=>exportStatus(`保存中… ${Math.round(progress*100)}%`));
      return archiveFile;
    },save);
    exportStatus(outcome==='saved'?'保存しました。':'ダウンロードを開始しました。');
  }catch(error){exportStatus(error.name==='AbortError'?'保存をキャンセルしました。':'保存できませんでした。再試行するか、個別ダウンロードをご利用ください。')}
  finally{exportBusy=false;controls()}
};
['shareVideo','shareGps','shareMetadata'].forEach((id,index)=>$(id).onclick=()=>sendDropbox([index]));
destinationHint();

$('prepareBtn').onclick=prepareCamera;$('recordBtn').onclick=toggleRecord;
$('recordAudio').onchange=()=>{if(cameraReady)prepareCamera()};
$('qualitySelect').onchange=async()=>{
  if(isRecording()||saving)return;
  try{localStorage.setItem('road-damage-quality',$('qualitySelect').value)}catch{}
  if(cameraReady)await prepareCamera();else updateQualityReadout();
};
$('switchBtn').onclick=()=>{facingMode=facingMode==='environment'?'user':'environment';prepareCamera()};
$('clearTrackBtn').onclick=()=>{if(isRecording())return;gpsLog=latestGps?[latestGps]:[];drawLiveTrack();$('pointCount').textContent=gpsLog.length};
function clearSelectedRecording(){
  playback.pause();playback.removeAttribute('src');playback.load();if(playbackUrl)URL.revokeObjectURL(playbackUrl);
  playbackUrl=null;result=null;unsaved=false;resetArchive();$('reviewPanel').hidden=true;$('recordingSummary').textContent='動画を選択してください';controls();
}
$('recordingSelect').onchange=async()=>{
  const id=$('recordingSelect').value,previous=result?.id||'';
  if(unsaved&&!confirm('未保存の記録があります。別の動画を開きますか？')){$('recordingSelect').value=previous;return}
  const version=++selectionVersion;
  if(!id){libraryBusy=false;clearSelectedRecording();libraryStatus('');return}
  libraryBusy=true;controls();libraryStatus('読み込み中…');
  try{const record=await getRecording(id);if(version!==selectionVersion)return;if(!record)throw new Error();result=record;unsaved=false;showReview();libraryStatus('')}
  catch{if(version===selectionVersion){$('recordingSelect').value=previous;libraryStatus('録画を開けませんでした。もう一度選択してください。')}}
  finally{if(version===selectionVersion){libraryBusy=false;controls()}}
};
$('deleteRecording').onclick=async()=>{
  const id=$('recordingSelect').value;if(!id||!confirm('選択した録画と位置情報をこのブラウザから削除しますか？この操作は取り消せません。'))return;
  libraryBusy=true;controls();
  try{await deleteRecording(id);if(result?.id===id)clearSelectedRecording();await refreshLibrary();libraryStatus('録画を削除しました。')}
  catch{libraryStatus('削除できませんでした。再試行してください。')}
  finally{libraryBusy=false;controls()}
};
$('reviewLink').onclick=event=>{if(!result)event.preventDefault()};
$('playbackSpeed').onchange=()=>{playback.playbackRate=Number($('playbackSpeed').value)};
function skip(seconds){if(!result)return;const duration=Number.isFinite(playback.duration)?playback.duration:result.duration;playback.currentTime=Math.max(0,Math.min(duration,playback.currentTime+seconds));updatePlaybackPosition()}
$('skipBack').onclick=()=>skip(-5);$('skipForward').onclick=()=>skip(5);
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

window.addEventListener('beforeunload',e=>{if(isRecording()||saving||unsaved){e.preventDefault();e.returnValue=''}});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden&&isRecording()){recordingProblem='画面が非表示になったため録画を終了しました。';stopRecording()}
});
window.addEventListener('pagehide',()=>{if(isRecording())stopRecording();stream?.getTracks().forEach(t=>t.stop());cameraReady=false;if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null}gpsGranted=false});
window.addEventListener('pageshow',()=>{if(!cameraReady){$('cameraEmpty').hidden=false;controls()}});
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>libraryStatus('オフライン機能を準備できませんでした。オンラインでご利用ください。'));
refreshLibrary().catch(()=>{libraryStatus('端末内ストレージを利用できません。録画後は必ずダウンロードしてください。');$('libraryCount').textContent='保存不可'});
drawLiveTrack();controls();

