import {test} from 'node:test';
import assert from 'node:assert/strict';
import {positionAt,normalizePoints,interpolateFrames,parseLog,makeCsv} from '../core.js';
const points=[{videoTime:0,latitude:35,longitude:139,accuracy:10},{videoTime:2,latitude:37,longitude:141,accuracy:20}];
test('seek uses timestamps, independent of capture frame rate',()=>{
  assert.equal(positionAt(points,1).latitude,36);
  assert.equal(positionAt(points,1).accuracy,15);
  assert.equal(positionAt(points,5).latitude,37);
  assert.equal(positionAt(points,0).latitude,35);
  assert.equal(positionAt([],1),null);
});
test('unknown locations and precision are not fabricated',()=>{
  assert.equal(positionAt([{...points[0],latitude:null},points[1]],1),null);
  assert.equal(positionAt([{...points[0],accuracy:null},points[1]],1).accuracy,null);
  assert.equal(positionAt([{...points[0],latitude:null},points[1]],2).latitude,37);
});
test('old frame metadata and BOM CSV import correctly',()=>{
  assert.deepEqual(parseLog(JSON.stringify({frames:points}),'metadata.json').points,normalizePoints(points));
  const imported=parseLog(makeCsv(points),'GPS.CSV').points;
  assert.equal(imported[1].videoTime,2);assert.equal(imported[1].longitude,141);
  assert.equal(imported[0].altitude,null);
});
test('invalid files fail before replacing the current recording',()=>{
  assert.throws(()=>parseLog('{','meta.json'));
  assert.throws(()=>parseLog('{}','meta.json'));
  assert.throws(()=>parseLog('latitude,longitude\n35,139','gps.csv'));
  assert.throws(()=>normalizePoints([{...points[0],latitude:91}]));
  assert.throws(()=>normalizePoints([{...points[0],videoTime:-1}]));
});
test('sort and deduplicate imported samples',()=>assert.deepEqual(normalizePoints([points[1],points[0],points[1]]),points));
test('frame export uses camera rate and records missing GPS as null',()=>{
  assert.equal(interpolateFrames(points,2,24).length,48);
  assert.equal(interpolateFrames([],1,30)[0].latitude,null);
  assert.equal(interpolateFrames(points,1,30)[15].latitude,35.5);
});
test('interpolation crosses the date line along the short path',()=>assert.equal(positionAt([{...points[0],longitude:179},{...points[1],longitude:-179}],1).longitude,-180));
