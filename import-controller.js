import {importEntries,isVideoFile,matchPositionFile,storedRecordingId,directoryEntries} from './import-matching.js';
import {getRecording} from './storage.js';

export class ImportSource {
  constructor(onStateChange){
    this.entries=[];this.videos=[];this.selected=null;this.match={status:'missing'};this.version=0;this.busy=false;this.blocked=false;
    this.change=onStateChange;this.select=document.getElementById('importVideo');this.note=document.getElementById('importMatch');
    this.folder=document.getElementById('importFolder');this.files=document.getElementById('importFiles');this.picker=document.getElementById('chooseImportFolder');
    this.picker.onclick=()=>this.chooseFolder();
    document.getElementById('chooseImportFiles').onclick=()=>this.files.click();
    this.folder.onchange=()=>{if(this.folder.files.length)this.setEntries(importEntries(this.folder.files));this.folder.value=''};
    this.files.onchange=()=>{if(this.files.files.length)this.setEntries(importEntries(this.files.files));this.files.value=''};
    this.select.onchange=()=>this.selectVideo();
  }
  setNote(message){this.note.textContent=message;this.note.hidden=!message}
  updateDisabled(blocked){
    this.blocked=blocked;
    for(const id of ['chooseImportFolder','chooseImportFiles','importFolder','importFiles','importVideo'])document.getElementById(id).disabled=blocked||this.busy;
    document.getElementById('importBtn').disabled=blocked||this.busy||!this.selected||this.match.status==='ambiguous';
  }
  async chooseFolder(){
    if(this.blocked||this.busy)return;
    if(typeof window.showDirectoryPicker!=='function'){this.folder.click();return}
    this.busy=true;this.change();
    try{
      const handle=await window.showDirectoryPicker({mode:'read',id:'road-damage-import'});
      this.setNote('フォルダーを確認しています…');
      const entries=await directoryEntries(handle);
      await this.setEntries(entries);
    }catch(error){if(error.name!=='AbortError')this.setNote('フォルダーを開けませんでした。「ファイルを開く」から動画と関連ファイルをまとめて選択できます。')}
    finally{this.busy=false;this.change()}
  }
  async setEntries(entries){
    this.entries=entries;this.videos=entries.filter(entry=>isVideoFile(entry.file));this.selected=null;this.match={status:'missing'};
    this.select.replaceChildren(new Option(this.videos.length?'動画を選択してください':'動画がありません',''));
    this.videos.forEach((entry,index)=>this.select.add(new Option(entry.path,String(index))));
    document.getElementById('importSourceSummary').textContent=`動画 ${this.videos.length}件`;
    this.select.value=this.videos.length===1?'0':'';
    await this.selectVideo();
  }
  async selectVideo(){
    const version=++this.version;
    this.selected=this.select.value===''?null:this.videos[Number(this.select.value)];this.match={status:'missing'};
    if(!this.selected){this.busy=false;this.setNote(this.videos.length?'':'動画と位置情報のあるフォルダーを開いてください。');this.change();return}
    this.busy=true;this.change();this.setNote('位置情報を照合しています…');
    const selected=this.selected,match=matchPositionFile(selected,this.entries);
    if(match.status==='missing'){
      const id=storedRecordingId(selected.file.name);
      if(id)try{const stored=await getRecording(id);if(stored&&stored.video.size===selected.file.size&&stored.points.length){match.status='stored';match.recording=stored}}catch{}
    }
    if(version!==this.version)return;
    this.match=match;this.busy=false;
    if(match.status==='matched')this.setNote(`位置情報：${match.entry.file.name}（自動選択）`);
    else if(match.status==='stored')this.setNote('位置情報：この端末の録画データから自動取得');
    else if(match.status==='ambiguous')this.setNote(`「${match.name}」が複数あります。対象のフォルダーを選び直してください。`);
    else this.setNote('対応する位置情報がありません。動画のみ読み込めます。自動取得するには、位置情報も入ったフォルダーを選択してください。');
    this.change();
  }
  snapshot(){return {video:this.selected?.file,match:this.match}}
}
