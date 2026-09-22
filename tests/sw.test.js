import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../sw.js',import.meta.url),'utf8');
function worker(){
  const events={},opened=[],requests=[],deleted=[];
  const cache={addAll:async items=>requests.push(...items),match:async()=>({current:true})};
  const self={location:{origin:'https://example.test'},registration:{scope:'https://example.test/'},addEventListener:(name,callback)=>events[name]=callback};
  vm.runInNewContext(source,{self,URL,Request:class{constructor(url,options){this.url=url;this.cache=options.cache}},
    caches:{open:async name=>{opened.push(name);return cache},keys:async()=>['geoframe-v8','geoframe-v13','other-app'],delete:async name=>deleted.push(name)},fetch:()=>{throw Error('unexpected network fallback')}});
  return {events,opened,requests,deleted};
}
test('new service worker bypasses HTTP cache when precaching a release',async()=>{
  const w=worker();let pending;w.events.install({waitUntil:p=>pending=p});await pending;
  assert.equal(w.opened[0],'geoframe-v13');assert.ok(w.requests.length>10);
  assert.ok(w.requests.every(r=>r.cache==='reload'));
});
test('fetch only reads the current version cache',async()=>{
  const w=worker();let pending;w.events.fetch({request:{method:'GET',url:'https://example.test/app.js'},respondWith:p=>pending=p});
  assert.equal((await pending).current,true);assert.deepEqual(w.opened,['geoframe-v13']);
});
test('activation removes only older application caches',async()=>{
  const w=worker();let pending;w.events.activate({waitUntil:p=>pending=p});await pending;
  assert.deepEqual(w.deleted,['geoframe-v8']);
});
