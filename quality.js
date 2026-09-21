export const QUALITY_PRESETS=Object.freeze({
  high:{label:'高画質',width:1920,height:1080,fps:30,bitrate:16000000},
  ultra:{label:'最高画質',width:3840,height:2160,fps:30,bitrate:45000000},
  smooth:{label:'動き優先',width:1920,height:1080,fps:60,bitrate:24000000},
  compact:{label:'容量優先',width:1280,height:720,fps:30,bitrate:6000000}
});
export function qualityPreset(id){return QUALITY_PRESETS[id]||QUALITY_PRESETS.high}
export function cameraConstraints(id,facingMode,audio=false){
  const p=qualityPreset(id);
  return {video:{facingMode:{ideal:facingMode},width:{ideal:p.width},height:{ideal:p.height},frameRate:{ideal:p.fps}},audio};
}
export function recorderOptions(id,mimeType){
  return {...(mimeType?{mimeType}:{}),videoBitsPerSecond:qualityPreset(id).bitrate,audioBitsPerSecond:128000};
}
export function cameraQualitySummary(id,settings={}){
  const p=qualityPreset(id),size=Math.round(p.bitrate*60/8/1000000),hasSize=Number.isFinite(settings.width)&&Number.isFinite(settings.height);
  const fps=Number.isFinite(settings.frameRate)?Math.round(settings.frameRate*10)/10:p.fps;
  const adjusted=hasSize&&(Math.max(settings.width,settings.height)<p.width||Math.min(settings.width,settings.height)<p.height||fps<p.fps-1);
  return `${hasSize?'実際の入力':'設定'}：${hasSize?settings.width:p.width} × ${hasSize?settings.height:p.height} / ${fps} fps · 目標 ${p.bitrate/1000000} Mbps · 約${size} MB/分${adjusted?'（端末の対応範囲に調整）':''}`;
}
export async function optimizeTrack(track,id){
  try{if('contentHint' in track)track.contentHint=id==='smooth'?'motion':'detail'}catch{}
  try{
    const capabilities=track.getCapabilities?.()||{},continuous={};
    for(const name of ['focusMode','exposureMode','whiteBalanceMode'])if(capabilities[name]?.includes('continuous'))continuous[name]='continuous';
    if(Object.keys(continuous).length)await track.applyConstraints({advanced:[continuous]});
  }catch{/* Optional camera controls must never prevent recording. */}
}
