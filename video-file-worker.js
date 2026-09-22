// OPFS synchronous access is available in dedicated workers, including Safari.
let access,handle,offset=0,failed=null,queue=Promise.resolve();
self.onmessage=({data})=>{
  queue=queue.then(async()=>{
    try{
      if(data.action==='open'){
        const root=await navigator.storage.getDirectory();
        const directory=await root.getDirectoryHandle('recording-files',{create:true});
        handle=await directory.getFileHandle(data.path,{create:true});
        access=await handle.createSyncAccessHandle();
        access.truncate(0);
      }else if(data.action==='append'){
        if(failed)throw failed;
        // Read bounded slices, even if Safari delivers one unusually large chunk.
        for(let at=0;at<data.blob.size;at+=1024*1024){
          const bytes=new Uint8Array(await data.blob.slice(at,at+1024*1024).arrayBuffer());
          let written=0;
          while(written<bytes.length){
            const count=access.write(bytes.subarray(written),{at:offset});
            if(!Number.isSafeInteger(count)||count<=0||count>bytes.length-written)throw new Error('動画ファイルへの書き込み結果が不正です。保存容量を確認してください。');
            offset+=count;written+=count;
          }
        }
        access.flush();
      }else if(data.action==='finish'){
        if(access){try{access.flush()}finally{access.close();access=null}}
        if(failed)throw failed;
      }else if(data.action==='close'){
        if(access){access.close();access=null}
      }
      self.postMessage({id:data.id,size:offset});
    }catch(error){
      failed=error;
      if(access){try{access.close()}catch{}access=null}
      self.postMessage({id:data.id,error:{name:error.name,message:error.message}});
    }
  });
};
