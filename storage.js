import {readVideoFile,removeVideoFile} from './video-file.js';
let pending;
function database() {
  if (!pending) pending = new Promise((resolve,reject)=>{
    const request=indexedDB.open('geoframe-recordings',1);
    request.onupgradeneeded=()=>{
      request.result.createObjectStore('recordings',{keyPath:'id'});
      request.result.createObjectStore('summaries',{keyPath:'id'});
    };
    request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();pending=null};resolve(request.result)};
    request.onerror=()=>{pending=null;reject(request.error)};
    request.onblocked=()=>{pending=null;reject(new Error('別のタブを閉じて再試行してください。'))};
  });
  return pending;
}
export async function listRecordings() {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const request=db.transaction('summaries').objectStore('summaries').getAll();
    request.onsuccess=()=>resolve(request.result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));
    request.onerror=()=>reject(request.error);
  });
}
export async function getRecording(id) {
  const db=await database();
  const record=await new Promise((resolve,reject)=>{
    const request=db.transaction('recordings').objectStore('recordings').get(id);
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  if(record?.videoPath)record.video=await readVideoFile(record.videoPath);
  return record;
}
export async function putRecording(recording) {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(['recordings','summaries'],'readwrite');
    // Keep the persistent file reference, never duplicate a multi-GB video in IDB.
    const stored={...recording};if(stored.videoPath)delete stored.video;
    tx.objectStore('recordings').put(stored);
    const {id,name,createdAt,duration,points,video}=recording;
    tx.objectStore('summaries').put({id,name,createdAt,duration,pointCount:points.length,size:video.size});
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}
export async function deleteRecording(id) {
  const db=await database();
  const record=await new Promise((resolve,reject)=>{const r=db.transaction('recordings').objectStore('recordings').get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(['recordings','summaries'],'readwrite');
    tx.objectStore('recordings').delete(id);tx.objectStore('summaries').delete(id);
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
  if(record?.videoPath){
    const records=await new Promise((resolve,reject)=>{const r=db.transaction('recordings').objectStore('recordings').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    if(!records.some(r=>r.videoPath===record.videoPath))await removeVideoFile(record.videoPath).catch(()=>{});
  }
  await removeVideoFile(`export_${id}.zip`).catch(()=>{});
}
