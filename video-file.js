function validPath(path){if(!/^[a-zA-Z0-9_-]+\.(mp4|webm|zip)$/.test(path))throw new Error('動画ファイル名が不正です。');return path}
export async function readVideoFile(path){
  const root=await navigator.storage.getDirectory();
  const dir=await root.getDirectoryHandle('recording-files');
  return (await dir.getFileHandle(validPath(path))).getFile();
}
export async function removeVideoFile(path){
  const root=await navigator.storage.getDirectory();
  const dir=await root.getDirectoryHandle('recording-files');
  await dir.removeEntry(validPath(path));
}
export class VideoFileWriter{
  constructor(path){
    this.path=validPath(path);this.pending=new Map();this.sequence=0;this.error=null;this.closed=false;
    this.worker=new Worker(new URL('./video-file-worker.js',import.meta.url),{type:'module'});
    this.worker.onmessage=({data})=>{
      const request=this.pending.get(data.id);if(!request)return;this.pending.delete(data.id);
      if(data.error){const error=new Error(data.error.message);error.name=data.error.name;this.error=error;request.reject(error)}else request.resolve(data);
    };
    this.worker.onerror=event=>{event.preventDefault();this.error=new Error('動画保存処理が終了しました。');for(const request of this.pending.values())request.reject(this.error);this.pending.clear();this.closed=true;this.worker.terminate()};
  }
  request(action,blob){
    return new Promise((resolve,reject)=>{
      if(this.closed){reject(this.error||new Error('動画ファイルは閉じられています。'));return}
      if(this.error&&action!=='close'){reject(this.error);return}
      const id=++this.sequence;this.pending.set(id,{resolve,reject});
      try{this.worker.postMessage({id,action,path:this.path,blob})}catch(error){this.pending.delete(id);reject(error)}
    });
  }
  static async open(path){
    const writer=new VideoFileWriter(path);
    try{await writer.request('open');return writer}catch(error){writer.worker.terminate();throw error}
  }
  append(blob){return this.request('append',blob)}
  async finish(){
    try{
      const completed=await this.request(this.error?'close':'finish');if(this.error)throw this.error;
      const file=await readVideoFile(this.path);
      if(file.size!==completed.size)throw new Error(`動画の保存サイズが一致しません（${file.size} / ${completed.size} bytes）。`);
      return file;
    }finally{this.closed=true;this.worker.terminate()}
  }
  async close(){if(this.closed)return;try{await this.request('close')}finally{this.closed=true;this.worker.terminate()}}
}
