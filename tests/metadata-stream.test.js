import test from 'node:test';
import assert from 'node:assert/strict';
import {metadataBlob,recordingMetadata} from '../export.js';
test('chunked JSON preserves every estimated frame across block boundaries',async()=>{
  for(const count of [0,1,2048,2049,4096,4097]){
    const record={ext:'mp4',fps:30,duration:count/30,points:[{videoTime:0,latitude:39,longitude:141,accuracy:10}],meta:{capture:{quality:'high'},frames:[{old:true}]}};
    const expected=recordingMetadata(record),actual=JSON.parse(await metadataBlob(record).text());
    assert.deepEqual(actual,expected);
  }
});
test('20 minute metadata retains export filenames without a full frames array in callers',async()=>{
  const record={ext:'mp4',fps:30,duration:1200,points:[],meta:{}};
  const result=JSON.parse(await metadataBlob(record,{videoFile:'road_damage_test.mp4'}).text());
  assert.equal(result.frames.length,36000);assert.equal(result.frames.at(-1).frame,35999);
  assert.equal(result.videoFile,'road_damage_test.mp4');assert.equal(result.frames[0].latitude,null);
});
