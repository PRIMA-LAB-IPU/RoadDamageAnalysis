import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crc32,makeZip,recordingArchive,saveArchive} from '../export.js';

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
  try{assert.equal(await saveArchive(new File(['x'],'x.zip'),'gdrive',()=>downloaded=true),'manual-upload');assert.equal(downloaded,true)}finally{Object.defineProperty(globalThis,'navigator',previous)}
});
