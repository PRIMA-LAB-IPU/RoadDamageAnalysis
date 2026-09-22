const CACHE='geoframe-v12';
const ASSETS=['./','./index.html','./app.js','./core.js','./storage.js','./video-file.js','./video-file-worker.js','./map-view.js','./export.js','./export-worker.js','./quality.js','./import-controller.js','./import-matching.js','./manifest.webmanifest','./logo.png','./tile-unavailable.svg',
  './vendor/leaflet/leaflet.js','./vendor/leaflet/leaflet.css','./vendor/leaflet/images/layers.png','./vendor/leaflet/images/layers-2x.png',
  './vendor/leaflet/images/marker-icon.png','./vendor/leaflet/images/marker-icon-2x.png','./vendor/leaflet/images/marker-shadow.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS.map(url=>new Request(url,{cache:'reload'}))))));
// Activate on the next app launch, never replace code during a recording.
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE&&key.startsWith('geoframe-')).map(key=>caches.delete(key)))).then(()=>self.clients?.claim())));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin)return;
  const fileRoute=new URL('./__recordings__/',self.registration.scope).pathname;
  if(['GET','HEAD'].includes(event.request.method)&&url.pathname.startsWith(fileRoute)){
    event.respondWith(serveVideoFile(event.request,url.pathname.slice(fileRoute.length),url.searchParams.get('download')));return;
  }
  if(event.request.method!=='GET')return;
  event.respondWith(caches.open(CACHE).then(cache=>cache.match(event.request)).then(cached=>cached||fetch(event.request)));
});
async function serveVideoFile(request,path,download){
  if(!/^[a-zA-Z0-9_-]+\.(mp4|webm|zip)$/.test(path))return new Response(null,{status:404});
  try{
    const root=await navigator.storage.getDirectory(),dir=await root.getDirectoryHandle('recording-files');
    const file=await(await dir.getFileHandle(path)).getFile();
    const type=path.endsWith('.mp4')?'video/mp4':path.endsWith('.webm')?'video/webm':'application/zip';
    const headers={'Content-Type':type,'Accept-Ranges':'bytes','Cache-Control':'no-store'};
    if(download&&/^[a-zA-Z0-9_.-]+$/.test(download))headers['Content-Disposition']=`attachment; filename="${download}"`;
    if(request.method==='HEAD'){headers['Content-Length']=String(file.size);return new Response(null,{headers})}
    const range=request.headers.get('range');
    if(!range){headers['Content-Length']=String(file.size);return new Response(file,{headers})}
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${file.size}`}});
    const start=match[1]?Number(match[1]):Math.max(0,file.size-Number(match[2]));
    const end=match[1]&&match[2]?Math.min(file.size-1,Number(match[2])):file.size-1;
    if(start>end||start>=file.size)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${file.size}`}});
    headers['Content-Range']=`bytes ${start}-${end}/${file.size}`;headers['Content-Length']=String(end-start+1);
    return new Response(file.slice(start,end+1),{status:206,headers});
  }catch{return new Response('動画ファイルを読み出せません。',{status:404})}
}
