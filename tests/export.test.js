import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crc32,makeZip,recordingArchive,saveArchive,recordingShareFiles,shareRecordingFiles,supportsFileShare,savePreparedArchive} from '../export.js';
import {parseLog} from '../core.js';

test('ZIP CRC matches the standard check value',()=>assert.equal((crc32(new TextEncoder().encode('123456789'))^0xffffffff)>>>0,0xcbf43926));
test('ZIP stores video and Unicode filenames with a valid central directory',async()=>{
  const zip=await makeZip([{name:'video.webm',blob:new Blob(['video'])},{name:'位置情報.csv',blob:new Blob(['gps'])}]);
  const bytes=new Uint8Array(await zip.arrayBuffer()),view=new DataView(bytes.buffer);
  assert.equal(view.getUint32(0,true),0x04034b50);
  assert.equal(view.getUint32(14,true),(crc32(new TextEncoder().encode('video'))^0xffffffff)>>>0);
  const end=bytes.length-22,central=view.getUint32(end+16,true);
  assert.equal(view.getUint32(end,true),0x06054b50);assert.equal(view.getUint16(end+10,true),2);
  assert.equal(view.getUint32(central,true),0x02014b50);
  assert.equal(view.getUint32(central+42,true),0);
  assert.equal(view.getUint16(central+8,true),0x800);
  assert.match(new TextDecoder().decode(bytes),/位置情報.csv/);
});
test('archive includes video, metadata, GPS and instructions with matching paths',async()=>{
  const archive=await recordingArchive({id:'test',video:new Blob(['video']),ext:'webm',duration:1,fps:1,points:[],meta:{}});
  const contents=await archive.text();
  assert.equal(archive.name,'road_damage_test.zip');
  for(const name of ['video.webm','metadata.json','gps.csv','README.txt'])assert.ok(contents.includes(name));
  assert.ok(contents.includes('"videoFile":"video.webm"'));
});
test('local save waits for write/close and reports success only afterwards',async()=>{
  const previous=globalThis.window,calls=[];
  globalThis.window={showSaveFilePicker:async()=>({createWritable:async()=>({write:async()=>calls.push('write'),close:async()=>calls.push('close')})})};
  try{assert.equal(await saveArchive(new File(['x'],'x.zip'),'local',()=>assert.fail()),'saved');assert.deepEqual(calls,['write','close'])}finally{globalThis.window=previous}
});
test('share cancel never downloads a fallback or claims saved',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{canShare:()=>true,share:async()=>{throw new DOMException('cancel','AbortError')}}});
  try{await assert.rejects(()=>saveArchive(new File(['x'],'x.zip'),'dropbox',()=>assert.fail()),{name:'AbortError'})}finally{Object.defineProperty(globalThis,'navigator',previous)}
});
test('unsupported sharing explicitly returns manual upload',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');let downloaded=false;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
  try{assert.equal(await saveArchive(new File(['x'],'x.zip'),'dropbox',()=>downloaded=true),'manual-upload');assert.equal(downloaded,true)}finally{Object.defineProperty(globalThis,'navigator',previous)}
});

const recording={id:'android-test',video:new Blob(['real video bytes'],{type:'video/webm;codecs=vp8'}),ext:'webm',duration:1,fps:1,
  points:[{videoTime:0,latitude:39,longitude:141,accuracy:10}],meta:{}};
test('Dropbox files have compatible MIME types and retain all recording data',async()=>{
  const files=recordingShareFiles(recording);
  assert.deepEqual(files.map(f=>f.type),['video/webm','text/csv','text/plain']);
  assert.equal(await files[0].text(),'real video bytes');
  assert.match(files[2].name,/\.json\.txt$/);
  const {points,meta}=parseLog(await files[2].text(),files[2].name);
  assert.deepEqual(points,recording.points);assert.equal(meta.videoFile,files[0].name);assert.equal(meta.gpsFile,files[1].name);
  assert.equal(meta.frames.length,1);
  assert.equal(parseLog(await files[1].text(),files[1].name).points[0].latitude,39);
});
test('Android rejects ZIP/JSON but can share the actual video/CSV/text files',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');let payload;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{
    canShare:({files})=>files.every(f=>['video/webm','text/csv','text/plain'].includes(f.type)),
    share:async data=>{payload=data}
  }});
  try{
    assert.equal(supportsFileShare(new File(['zip'],'recording.zip',{type:'application/zip'})),false);
    const files=recordingShareFiles(recording);assert.equal(supportsFileShare(files),true);
    assert.equal(await shareRecordingFiles(files),'shared');assert.deepEqual(payload,{files});
  }finally{Object.defineProperty(globalThis,'navigator',previous)}
});
test('individual file sharing works when multiple files are rejected',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');const sent=[];
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{canShare:({files})=>files.length===1,share:async({files})=>sent.push(files[0].name)}});
  try{const files=recordingShareFiles(recording);assert.equal(supportsFileShare(files),false);for(const file of files)await shareRecordingFiles([file]);assert.deepEqual(sent,files.map(f=>f.name))}finally{Object.defineProperty(globalThis,'navigator',previous)}
});
test('failed transfer propagates without reporting shared or downloading',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{canShare:()=>true,share:async()=>{throw new DOMException('transfer failed','DataError')}}});
  try{await assert.rejects(()=>shareRecordingFiles(recordingShareFiles(recording)),{name:'DataError'})}finally{Object.defineProperty(globalThis,'navigator',previous)}
});
test('removed destinations are rejected',async()=>assert.rejects(()=>saveArchive(new File(['x'],'x.zip'),'removed',()=>assert.fail()),/保存先が無効/));

test('one-click local save opens picker before asynchronous ZIP preparation',async()=>{
  const previous=globalThis.window,calls=[];
  globalThis.window={showSaveFilePicker:async()=>{calls.push('picker');return {createWritable:async()=>({write:async()=>calls.push('write'),close:async()=>calls.push('close')})}}};
  try{assert.equal(await savePreparedArchive('x.zip',async()=>{calls.push('prepare');return new File(['zip'],'x.zip')},()=>assert.fail()),'saved');assert.deepEqual(calls,['picker','prepare','write','close'])}finally{globalThis.window=previous}
});
test('cancelling picker does not generate a ZIP or download',async()=>{
  const previous=globalThis.window;
  globalThis.window={showSaveFilePicker:async()=>{throw new DOMException('cancel','AbortError')}};
  try{await assert.rejects(()=>savePreparedArchive('x.zip',()=>assert.fail(),()=>assert.fail()),{name:'AbortError'})}finally{globalThis.window=previous}
});
test('one-click local save without picker prepares then downloads',async()=>{
  const previous=globalThis.window,calls=[];globalThis.window={};
  try{assert.equal(await savePreparedArchive('x.zip',async()=>{calls.push('prepare');return new File(['zip'],'x.zip')},file=>calls.push(file.name)),'downloaded');assert.deepEqual(calls,['prepare','x.zip'])}finally{globalThis.window=previous}
});
