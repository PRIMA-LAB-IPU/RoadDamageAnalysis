const VIDEO=/\.(mp4|webm|mov|m4v|ogv)$/i;
const LOG=/\.(json|csv|txt)$/i;
const key=name=>name.normalize('NFC').toLowerCase();
const parent=entry=>entry.path.slice(0,Math.max(0,entry.path.lastIndexOf('/')));
export const isVideoFile=file=>VIDEO.test(file.name);
export function importEntries(files){
  return Array.from(files).filter(file=>VIDEO.test(file.name)||LOG.test(file.name))
    .map(file=>({file,path:(file.webkitRelativePath||file.name).replaceAll('\\','/')}));
}
export function matchPositionFile(video,entries){
  const directory=parent(video),stem=key(video.file.name.replace(VIDEO,''));
  const sameDirectory=entries.filter(entry=>parent(entry)===directory);
  const names=[`${stem}_metadata.json`,`${stem}_metadata.json.txt`,`${stem}_metadata.txt`,`${stem}.json`,`${stem}.json.txt`,`${stem}.txt`,`${stem}_gps.csv`,`${stem}.csv`];
  // Original app's separate recording_*, metadata_* and gps_* downloads.
  if(stem.startsWith('recording_')){const suffix=stem.slice(10);names.unshift(`metadata_${suffix}.json`);names.push(`gps_${suffix}.csv`)}
  // Exported ZIP folders each contain video.ext + metadata.json + gps.csv.
  if(stem==='video'&&sameDirectory.filter(entry=>isVideoFile(entry.file)).length===1)
    names.push('metadata.json','metadata.json.txt','gps.csv');
  for(const name of names){
    const matches=sameDirectory.filter(entry=>key(entry.file.name)===name);
    if(matches.length>1)return {status:'ambiguous',name};
    if(matches.length===1)return {status:'matched',entry:matches[0]};
  }
  return {status:'missing'};
}
export function storedRecordingId(name){
  return /^(?:road_damage|geoframe)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:mp4|webm|mov|m4v)$/i.exec(name)?.[1]||null;
}
export async function directoryEntries(directory,prefix='',entries=[],depth=0){
  if(depth>20)throw new Error('フォルダーの階層が深すぎます。動画を含むフォルダーを直接選んでください。');
  for await(const handle of directory.values()){
    const path=prefix+handle.name;
    if(handle.kind==='directory')await directoryEntries(handle,path+'/',entries,depth+1);
    else if(VIDEO.test(handle.name)||LOG.test(handle.name)){
      if(entries.length>=10000)throw new Error('ファイルが多すぎます。動画を含むフォルダーを直接選んでください。');
      entries.push({file:await handle.getFile(),path});
    }
  }
  return entries;
}
