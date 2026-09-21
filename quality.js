export const QUALITY_PRESETS=Object.freeze({
  high:{label:'高画質',width:1920,height:1080,fps:30,bitrate:16000000},
  ultra:{label:'最高画質',width:3840,height:2160,fps:30,bitrate:45000000},
  smooth:{label:'動き優先',width:1920,height:1080,fps:60,bitrate:24000000},
  compact:{label:'容量優先',width:1280,height:720,fps:30,bitrate:6000000}
});
export function qualityPreset(id){return QUALITY_PRESETS[id]||QUALITY_PRESETS.high}
export function cameraConstraints(id,facingMode,audio=false){
  const p=qualityPreset(id);
  const video={facingMode:{ideal:facingMode},width:{ideal:p.width},height:{ideal:p.height},frameRate:{ideal:p.fps}};
  if(id==='smooth'){
    // Use a native camera mode instead of a synthesized crop/scale mode at 60fps.
    // Keep dimensions/fps optional so devices can return their native fallback.
    // Unsupported constraint names are ignored by the capture API.
    video.resizeMode={exact:'none'};
    video.aspectRatio={ideal:p.width/p.height};
  }
  return {video,audio};
}
export function recorderOptions(id,mimeType){
  return {...(mimeType?{mimeType}:{}),videoBitsPerSecond:qualityPreset(id).bitrate,audioBitsPerSecond:128000};
}
export function recordingMimeType(id,isSupported,device={}){
  const appleMobile=/iPhone|iPad|iPod/.test(device.userAgent||'')||(/Macintosh/.test(device.userAgent||'')&&device.maxTouchPoints>1);
  // Prefer the native MP4 recording path for high-frame-rate iOS capture.
  const types=id==='smooth'&&appleMobile?['video/mp4','video/webm;codecs=vp8','video/webm']:['video/webm;codecs=vp8','video/webm','video/mp4'];
  return types.find(type=>isSupported(type));
}
export function cameraQualitySummary(id,settings={}){
  const p=qualityPreset(id),size=Math.round(p.bitrate*60/8/1000000),hasSize=Number.isFinite(settings.width)&&Number.isFinite(settings.height);
  const fps=Number.isFinite(settings.frameRate)?Math.round(settings.frameRate*10)/10:p.fps;
  const adjusted=hasSize&&(Math.max(settings.width,settings.height)<p.width||Math.min(settings.width,settings.height)<p.height||fps<p.fps-1);
  return `${hasSize?'実際の入力':'設定'}：${hasSize?settings.width:p.width} × ${hasSize?settings.height:p.height} / ${fps} fps · 目標 ${p.bitrate/1000000} Mbps · 約${size} MB/分${adjusted?'（端末の対応範囲に調整）':''}`;
}
export async function optimizeTrack(track,id){
  // Road inspection needs spatial detail at every frame rate; do not ask the
  // encoder to trade spatial resolution for motion in the 60fps preset.
  try{if('contentHint' in track)track.contentHint='detail'}catch{}
  try{
    const capabilities=track.getCapabilities?.()||{},continuous={};
    for(const name of ['focusMode','exposureMode','whiteBalanceMode'])if(capabilities[name]?.includes('continuous'))continuous[name]='continuous';
    if(Object.keys(continuous).length)await track.applyConstraints({advanced:[continuous]});
  }catch{/* Optional camera controls must never prevent recording. */}
}
