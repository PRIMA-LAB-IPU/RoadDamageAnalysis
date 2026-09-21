// Shared map for live capture and synchronized playback. No per-frame resize.
export class TrackMap {
  constructor(prefix) {
    this.host=document.getElementById(`${prefix}Viewport`);
    this.element=document.getElementById(`${prefix}Map`);
    this.canvas=document.getElementById(`${prefix}Fallback`);
    this.note=document.getElementById(`${prefix}Note`);
    this.retry=document.getElementById(`${prefix}Retry`);
    this.plus=document.getElementById(`${prefix}ZoomIn`);
    this.minus=document.getElementById(`${prefix}ZoomOut`);
    this.points=[];this.center=null;this.zoom=17;this.failed=new Set();this.map=null;this.zooming=false;
    this.plus.onclick=()=>this.changeZoom(1);this.minus.onclick=()=>this.changeZoom(-1);
    this.retry.onclick=()=>{this.failed.clear();this.note.textContent='地図を再取得しています…';this.tiles?.redraw()};
    this.element.addEventListener('keydown',event=>{
      if(['+','=','-'].includes(event.key)){event.preventDefault();this.changeZoom(event.key==='-'?-1:1)}
    });
    this.observer=new ResizeObserver(entries=>{
      if(!entries.some(e=>e.contentRect.width>0&&e.contentRect.height>0))return;
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame=requestAnimationFrame(()=>{
        this.map?.invalidateSize({pan:false,animate:false});this.follow();this.drawFallback();
      });
    });
    this.observer.observe(this.host);
    // The canvas also supports zoom when Leaflet cannot initialize.
    const fingers=new Map();let distance=0,initialZoom=17;
    this.canvas.addEventListener('pointerdown',e=>{fingers.set(e.pointerId,[e.clientX,e.clientY]);this.canvas.setPointerCapture(e.pointerId);if(fingers.size===2){distance=this.distance(fingers);initialZoom=this.zoom}});
    this.canvas.addEventListener('pointermove',e=>{if(!fingers.has(e.pointerId))return;fingers.set(e.pointerId,[e.clientX,e.clientY]);if(fingers.size===2&&distance>0){this.zoom=Math.max(3,Math.min(19,initialZoom+Math.log2(this.distance(fingers)/distance)));this.drawFallback();this.zoomButtons()}});
    for(const event of ['pointerup','pointercancel'])this.canvas.addEventListener(event,e=>{fingers.delete(e.pointerId);distance=0});
    this.zoomButtons();this.drawFallback();
  }
  distance(fingers){const [a,b]=[...fingers.values()];return Math.hypot(a[0]-b[0],a[1]-b[1])}
  ensureMap() {
    if(this.map||!this.center||!this.host.clientWidth||!window.L)return;
    const L=window.L;
    this.element.hidden=false;
    this.map=L.map(this.element,{zoomControl:false,dragging:false,touchZoom:'center',scrollWheelZoom:'center',
      doubleClickZoom:'center',boxZoom:false,keyboard:false,minZoom:3,maxZoom:19,
      zoomAnimation:true,fadeAnimation:false,markerZoomAnimation:true,bounceAtZoomLimits:false})
      .setView([this.center.latitude,this.center.longitude],this.zoom);
    this.map.createPane('positionPane').style.zIndex='650';
    this.map.getPane('positionPane').style.pointerEvents='none';
    this.marker=L.marker([this.center.latitude,this.center.longitude],{pane:'positionPane',interactive:false,
      icon:L.divIcon({className:'position-icon',html:'<span class="route-marker"></span>',iconSize:[24,24],iconAnchor:[12,12]})}).addTo(this.map);
    this.line=L.polyline([],{color:'#087f87',weight:5,opacity:.95,interactive:false}).addTo(this.map);
    this.tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
      maxZoom:19,keepBuffer:2,errorTileUrl:'./tile-unavailable.svg',
      attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    });
    const key=e=>`${e.coords.z}/${e.coords.x}/${e.coords.y}`;
    this.tiles.on('tileerror',e=>{this.failed.add(key(e));this.tileStatus()});
    this.tiles.on('tileload',e=>{if(!e.tile.src.endsWith('/tile-unavailable.svg'))this.failed.delete(key(e));this.tileStatus()});
    this.tiles.on('tileunload',e=>{this.failed.delete(key(e));this.tileStatus()});
    this.tiles.on('loading',()=>{clearTimeout(this.loadingTimer);this.loadingTimer=setTimeout(()=>{this.note.textContent='地図の取得に時間がかかっています。軌跡と位置は引き続き表示します。';this.retry.hidden=false},12000)});
    this.tiles.on('load',()=>{clearTimeout(this.loadingTimer);this.tileStatus()});
    this.map.on('zoomstart',()=>{this.zooming=true});
    this.map.on('zoomend',()=>{this.zooming=false;this.zoom=this.map.getZoom();this.zoomButtons();this.follow()});
    this.tiles.addTo(this.map);this.canvas.hidden=true;this.renderRoute();
    this.map.invalidateSize({pan:false,animate:false});
  }
  tileStatus(){
    this.retry.hidden=!this.failed.size;
    this.note.textContent=this.failed.size?'地図の一部を取得できません。斜線部分でも軌跡・現在位置は表示します。':'現在位置を中央に表示します。＋／− または2本指で拡大・縮小できます。';
  }
  setRoute(points){this.points=points;this.renderRoute();if(!this.map)this.drawFallback()}
  renderRoute(){
    if(!this.line)return;
    const segments=[];let segment=[];
    for(const p of this.points){if(p.latitude==null||p.longitude==null){if(segment.length)segments.push(segment);segment=[]}else segment.push([p.latitude,p.longitude])}
    if(segment.length)segments.push(segment);this.line.setLatLngs(segments);
  }
  setPosition(point){
    this.center=point?.latitude!=null&&point?.longitude!=null?point:null;
    if(!this.center){this.marker?.remove();this.element.hidden=true;this.canvas.hidden=false;this.drawFallback();return}
    this.ensureMap();
    if(this.map){
      const wasHidden=this.element.hidden;this.element.hidden=false;this.canvas.hidden=true;
      if(wasHidden)this.map.invalidateSize({pan:false,animate:false});
      if(!this.map.hasLayer(this.marker))this.marker.addTo(this.map);
      this.marker.setLatLng([this.center.latitude,this.center.longitude]);this.follow();
    }else{this.element.hidden=true;this.canvas.hidden=false;this.note.textContent='相対軌跡を表示しています。北が上です。＋／− または2本指で拡大・縮小できます。';this.drawFallback()}
  }
  follow(){
    if(!this.map||!this.center||this.zooming)return;
    const next=window.L.latLng(this.center.latitude,this.center.longitude),current=this.map.getCenter();
    if(!next.equals(current,1e-10))this.map.setView(next,this.map.getZoom(),{animate:false});
  }
  changeZoom(delta){
    if(this.map&&!this.element.hidden)this.map.setZoom(Math.max(3,Math.min(19,this.map.getZoom()+delta)),{animate:false});
    else{this.zoom=Math.max(3,Math.min(19,this.zoom+delta));this.drawFallback();this.zoomButtons()}
  }
  zoomButtons(){this.plus.disabled=this.zoom>=19;this.minus.disabled=this.zoom<=3}
  drawFallback(){
    if(this.canvas.hidden)return;
    const c=this.canvas,ctx=c.getContext('2d'),w=this.host.clientWidth||320,h=this.host.clientHeight||240,dpr=devicePixelRatio||1;
    c.width=Math.round(w*dpr);c.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle='#e9eff0';ctx.fillRect(0,0,w,h);ctx.strokeStyle='#cedbdc';ctx.lineWidth=1;
    for(let x=w/2%40;x<w;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke()}
    for(let y=h/2%40;y<h;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}
    ctx.fillStyle='#294b59';ctx.font='13px system-ui';ctx.fillText('N ↑',14,24);
    if(!this.center){ctx.fillText('位置情報がありません',Math.max(14,w/2-65),h/2);return}
    const cos=Math.max(.01,Math.cos(this.center.latitude*Math.PI/180)),metersPerPixel=156543.03392*cos/2**this.zoom;
    ctx.beginPath();let pen=false;
    for(const p of this.points){if(p.latitude==null||p.longitude==null){pen=false;continue}
      const x=w/2+(((p.longitude-this.center.longitude+540)%360)-180)*111320*cos/metersPerPixel;
      const y=h/2-(p.latitude-this.center.latitude)*111320/metersPerPixel;
      if(pen)ctx.lineTo(x,y);else ctx.moveTo(x,y);pen=true;
    }
    ctx.strokeStyle='#087f87';ctx.lineWidth=4;ctx.lineJoin='round';ctx.stroke();
    ctx.beginPath();ctx.arc(w/2,h/2,8,0,Math.PI*2);ctx.fillStyle='#e84258';ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=3;ctx.stroke();
  }
}
