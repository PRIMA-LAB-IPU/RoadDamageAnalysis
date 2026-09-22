import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../video-file-worker.js',import.meta.url),'utf8');
function fixture(write){
  let reply,closed=0,flushed=0;
  const access={write,truncate(){},flush(){flushed++},close(){closed++}};
  const handle={createSyncAccessHandle:async()=>access};
  const dir={getFileHandle:async()=>handle};
  const self={postMessage:message=>reply(message)};
  vm.runInNewContext(source,{self,navigator:{storage:{getDirectory:async()=>({getDirectoryHandle:async()=>dir})}},Uint8Array});
  return {send:(action,blob)=>new Promise(resolve=>{reply=resolve;self.onmessage({data:{id:1,action,path:'test.mp4',blob}})}),closed:()=>closed,flushed:()=>flushed};
}
test('partial writes advance offsets without losing bytes',async()=>{
  const target=new Uint8Array(6),f=fixture((bytes,{at})=>{const count=Math.min(2,bytes.length);target.set(bytes.subarray(0,count),at);return count});
  await f.send('open');assert.equal((await f.send('append',new Blob(['abcdef']))).size,6);
  assert.equal(new TextDecoder().decode(target),'abcdef');await f.send('finish');assert.equal(f.closed(),1);assert.equal(f.flushed(),2);
});
test('impossible write counts are rejected and the file handle closes',async()=>{
  for(const count of [0,-1,4294967295]){
    const f=fixture(()=>count);await f.send('open');
    assert.match((await f.send('append',new Blob(['a']))).error.message,/書き込み結果が不正/);
    assert.equal(f.closed(),1);assert.ok((await f.send('finish')).error);
  }
});
test('quota errors are surfaced without retaining the access handle',async()=>{
  const f=fixture(()=>{const error=new Error('full');error.name='QuotaExceededError';throw error});await f.send('open');
  assert.equal((await f.send('append',new Blob(['a']))).error.name,'QuotaExceededError');assert.equal(f.closed(),1);
});
