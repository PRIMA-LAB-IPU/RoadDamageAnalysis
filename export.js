import {interpolateFrames,makeCsv,positionAt} from './core.js';

const encoder=new TextEncoder();
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0});
export function crc32(bytes,crc=0xffffffff){for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return crc>>>0}

// ZIP STORE: reuse the video Blob instead of buffering/compressing it again.
// The asynchronous CRC pass yields regularly so even large exports keep the UI responsive.
export async function makeZip(entries,onProgress=()=>{}) {
  const total=entries.reduce((n,e)=>n+e.blob.size,0);
  if(total>0xffff0000||entries.length>65535)throw new Error('ZIPにまとめられるサイズ（約4 GB）を超えています。個別に保存してください。');
  const local=[],central=[];let offset=0,done=0;
  for(const {name,blob} of entries){
    const filename=encoder.encode(name),reader=blob.stream().getReader();let crc=0xffffffff,lastYield=0;
    try{while(true){const {value,done:finished}=await reader.read();if(finished)break;crc=crc32(value,crc);done+=value.length;onProgress(total?done/total:1);if(done-lastYield>4*1024*1024){lastYield=done;await new Promise(r=>setTimeout(r,0))}}}finally{reader.releaseLock()}
    crc=(crc^0xffffffff)>>>0;
    const header=new Uint8Array(30+filename.length),h=new DataView(header.buffer);
    h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x800,true);h.setUint16(12,0x21,true);
    h.setUint32(14,crc,true);h.setUint32(18,blob.size,true);h.setUint32(22,blob.size,true);h.setUint16(26,filename.length,true);header.set(filename,30);
    const directory=new Uint8Array(46+filename.length),d=new DataView(directory.buffer);
    d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);d.setUint16(14,0x21,true);
    d.setUint32(16,crc,true);d.setUint32(20,blob.size,true);d.setUint32(24,blob.size,true);d.setUint16(28,filename.length,true);d.setUint32(42,offset,true);directory.set(filename,46);
    local.push(header,blob);central.push(directory);offset+=header.length+blob.size;
  }
  const directorySize=central.reduce((n,c)=>n+c.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);
  if(offset+directorySize+22>0xffffffff)throw new Error('ZIPのサイズが上限を超えています。');
  e.setUint32(0,0x06054b50,true);e.setUint16(8,entries.length,true);e.setUint16(10,entries.length,true);e.setUint32(12,directorySize,true);e.setUint32(16,offset,true);
  return new Blob([...local,...central,end],{type:'application/zip'});
}
export function recordingMetadata(recording) {
  return {...recording.meta,formatVersion:2,durationSeconds:recording.duration,
    videoFile:`video.${recording.ext}`,gpsFile:'gps.csv',gps:recording.points,estimatedFrameRate:recording.fps,
    frames:interpolateFrames(recording.points,recording.duration,recording.fps)};
}
export function metadataBlob(recording,overrides={}){
  const {frames:ignored,...meta}=recording.meta||{};
  const header={...meta,formatVersion:2,durationSeconds:recording.duration,videoFile:`video.${recording.ext}`,gpsFile:'gps.csv',gps:recording.points,estimatedFrameRate:recording.fps,...overrides};
  const parts=[JSON.stringify(header).slice(0,-1)+',"frames":['];
  const count=Math.max(0,Math.floor(recording.duration*recording.fps));
  let batch=[];
  for(let frame=0;frame<count;frame++){
    const videoTime=+(frame/recording.fps).toFixed(6),p=positionAt(recording.points,videoTime);
    batch.push(JSON.stringify({frame,videoTime,latitude:p?.latitude??null,longitude:p?.longitude??null,altitude:p?.altitude??null,accuracy:p?.accuracy??null}));
    if(batch.length===2048||frame===count-1){parts.push((frame>=2048?',':'')+batch.join(','));batch=[]}
  }
  parts.push(']}');return new Blob(parts,{type:'application/json'});
}
export async function recordingArchive(recording,onProgress){
  const readme='Road Damage Analysis\n\nZIPを展開後、アプリの「フォルダーを開く」で動画と位置情報のフォルダーを開き、動画を選択するとmetadata.jsonまたはgps.csvを自動照合します。\nフレーム位置と時刻は推定値です。\n';
  const zip=await makeZip([
    {name:`video.${recording.ext}`,blob:recording.video},
    {name:'gps.csv',blob:new Blob([makeCsv(recording.points)],{type:'text/csv;charset=utf-8'})},
    {name:'metadata.json',blob:metadataBlob(recording)},
    {name:'README.txt',blob:new Blob([readme],{type:'text/plain;charset=utf-8'})}
  ],onProgress);
  return new File([zip],`road_damage_${recording.id}.zip`,{type:'application/zip'});
}
export function recordingShareFiles(recording){
  const base=`road_damage_${recording.id}`,meta={videoFile:`${base}.${recording.ext}`,gpsFile:`${base}_gps.csv`};
  // These are actual video/CSV/plain-text files, not ZIP bytes with a false MIME type.
  // Drop codec parameters from MediaRecorder's MIME value for native share matching.
  const type=recording.video.type.split(';')[0]||({mp4:'video/mp4',webm:'video/webm'}[recording.ext]||'application/octet-stream');
  return [new File([recording.video],meta.videoFile,{type}),
    new File([makeCsv(recording.points)],meta.gpsFile,{type:'text/csv'}),
    new File([metadataBlob(recording,meta)],`${base}_metadata.json.txt`,{type:'text/plain'})];
}
export function supportsFileShare(fileOrFiles){
  const files=Array.isArray(fileOrFiles)?fileOrFiles:[fileOrFiles];
  try{return files.length>0&&files.every(file=>file instanceof File)&&!!navigator.share&&!!navigator.canShare?.({files})}catch{return false}
}
export async function shareRecordingFiles(files){
  if(!supportsFileShare(files))throw new DOMException('このファイルの共有には対応していません。','NotSupportedError');
  // No extra title/text: send only the files to Android's receiving app.
  await navigator.share({files});return 'shared';
}
export async function saveArchive(file,destination,download){
  if(destination==='dropbox'){
    if(supportsFileShare(file))return shareRecordingFiles([file]);
    download(file,file.name);return 'manual-upload';
  }
  if(destination!=='local')throw new Error('保存先が無効です。');
  if(typeof window.showSaveFilePicker==='function'){
    const handle=await window.showSaveFilePicker({suggestedName:file.name,types:[{description:'動画・位置情報 ZIP',accept:{'application/zip':['.zip']}}]});
    const writable=await handle.createWritable();
    try{await writable.write(file);await writable.close()}catch(error){await writable.abort().catch(()=>{});throw error}
    return 'saved';
  }
  download(file,file.name);return 'downloaded';
}

// Open the native picker while the click still has user activation; prepare the
// ZIP afterwards. Unsupported browsers download once preparation is complete.
export async function savePreparedArchive(name,prepare,download){
  const handle=typeof window.showSaveFilePicker==='function'
    ? await window.showSaveFilePicker({suggestedName:name,types:[{description:'動画・位置情報 ZIP',accept:{'application/zip':['.zip']}}]}) : null;
  const file=await prepare();
  if(!handle){download(file,name);return 'downloaded'}
  const writable=await handle.createWritable();
  try{await writable.write(file);await writable.close()}catch(error){await writable.abort().catch(()=>{});throw error}
  return 'saved';
}
