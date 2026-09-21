import test from 'node:test';
import assert from 'node:assert/strict';
import {importEntries,matchPositionFile,storedRecordingId,directoryEntries} from '../import-matching.js';
import {QUALITY_PRESETS,cameraConstraints,recorderOptions,cameraQualitySummary,optimizeTrack} from '../quality.js';
const entries=paths=>importEntries(paths.map(path=>({name:path.split('/').at(-1),webkitRelativePath:path})));
const match=paths=>{const e=entries(paths);return matchPositionFile(e[0],e)};
test('associate exact export names, prefer metadata, support Android TXT and older downloads',()=>{
  for(const [video,log] of [['road_damage_abc.webm','road_damage_abc_metadata.json'],['road_damage_abc.mp4','road_damage_abc_metadata.json.txt'],['route.mov','route_gps.csv'],['route.mp4','route.csv'],['recording_20250101.webm','metadata_20250101.json'],['recording_20250101.webm','gps_20250101.csv']])assert.equal(match([video,log]).entry.file.name,log);
  assert.equal(match(['a.mp4','a_gps.csv','a_metadata.json']).entry.file.name,'a_metadata.json');
});
test('never match partial names or other folders; generic ZIP logs require one video',()=>{
  assert.equal(match(['a.mp4','ab.json']).status,'missing');
  assert.equal(match(['one/a.mp4','two/a.json']).status,'missing');
  assert.equal(match(['one/video.mp4','one/metadata.json','two/video.mp4']).entry.path,'one/metadata.json');
  assert.equal(match(['video.mp4','video.webm','metadata.json']).status,'missing');
  assert.equal(match(['other.mp4','metadata.json']).status,'missing');
});
test('case and Unicode normalization; duplicate candidates are ambiguous',()=>{
  assert.equal(match(['ROUTE.MP4','route.JSON']).status,'matched');
  assert.equal(match(['が.mp4','か\u3099.json']).status,'matched');
  assert.equal(match(['route.mp4','route.json','ROUTE.JSON']).status,'ambiguous');
});
test('local recovery accepts only complete UUID export names',()=>{
  const id='12345678-1234-4321-abcd-123456789abc';
  assert.equal(storedRecordingId(`road_damage_${id}.webm`),id);
  assert.equal(storedRecordingId(`geoframe_${id}.mp4`),id);
  assert.equal(storedRecordingId('road_damage_selection-test.webm'),null);
});
test('directory traversal keeps relative paths and excludes unrelated assets',async()=>{
  const file=name=>({kind:'file',name,getFile:async()=>({name})});
  const folder={kind:'directory',name:'trip',async *values(){yield file('video.mp4');yield file('metadata.json');yield file('logo.png')}};
  const root={async *values(){yield folder}};
  assert.deepEqual((await directoryEntries(root)).map(e=>e.path),['trip/video.mp4','trip/metadata.json']);
});
test('quality uses higher default bitrate and soft constraints for hardware fallback',()=>{
  assert.equal(recorderOptions('high','video/webm').videoBitsPerSecond,16000000);
  assert.equal(recorderOptions('unknown','').videoBitsPerSecond,16000000);
  for(const [id,p] of Object.entries(QUALITY_PRESETS)){
    const c=cameraConstraints(id,'environment',true);
    assert.deepEqual(c.video.width,{ideal:p.width});assert.deepEqual(c.video.frameRate,{ideal:p.fps});assert.equal(c.audio,true);
    assert.equal(recorderOptions(id,'video/mp4').videoBitsPerSecond,p.bitrate);
  }
});
test('quality readout reports actual fallback without confusing portrait dimensions',()=>{
  assert.match(cameraQualitySummary('high',{width:1280,height:720,frameRate:30}),/実際の入力：1280 × 720.*端末の対応範囲/);
  assert.doesNotMatch(cameraQualitySummary('high',{width:1080,height:1920,frameRate:30}),/端末の対応範囲/);
  assert.match(cameraQualitySummary('ultra'),/設定：3840 × 2160/);
});
test('continuous controls are optional and unsupported devices still record',async()=>{
  let applied;const track={contentHint:'',getCapabilities:()=>({focusMode:['manual','continuous']}),applyConstraints:async c=>{applied=c}};
  await optimizeTrack(track,'high');assert.equal(track.contentHint,'detail');assert.deepEqual(applied,{advanced:[{focusMode:'continuous'}]});
  await optimizeTrack({getCapabilities(){throw Error('unsupported')}},'high');
  await optimizeTrack({getCapabilities:()=>({focusMode:['continuous']}),applyConstraints:async()=>{throw Error('unsupported')}},'high');
});
