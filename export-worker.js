import {recordingShareFiles} from './export.js';
self.onmessage=({data})=>{
  try{self.postMessage({files:recordingShareFiles(data)})}
  catch(error){self.postMessage({error:error.message})}
};
