import test from 'node:test';
import assert from 'node:assert/strict';
import {monitorBounds,monitorNiceTicks,monitorPath} from './monitorChartGeometry.js';

test('Sarah Monitor nice ticks and minimum span/padding match the Kotlin renderer',()=>{
  assert.deepEqual(monitorNiceTicks(90,112,4),[90,100,110]);
  assert.deepEqual(monitorNiceTicks(-.5,1.5,4),[-.5,0,.5,1,1.5]);
  assert.deepEqual(monitorBounds([100,102],10),[95,107]);
  assert.deepEqual(monitorBounds([],10),[0,10]);
  assert.deepEqual(monitorBounds([50,80],10,[0,100]),[0,100]);
});
test('native-style traces stay linear and leave missing/late/calibration gaps open',()=>{
  const rows=[{t:0,p:2},{t:1,p:3},{t:2,p:null},{t:3,p:4},{t:40,p:5},{t:41,p:6,gap:true}];
  const path=monitorPath(rows,'p',{start:0,end:60,x:t=>t,y:v=>v});
  assert.equal(path,'M0.00,2.00 L1.00,3.00  M3.00,4.00 M40.00,5.00 M41.00,6.00');
  assert.equal(monitorPath([{t:0,p:1,id:1},{t:.1,p:2,id:2}],'p',{start:0,end:1,x:t=>t,y:v=>v,breakBefore:(a,b)=>a.id!==b.id}),'M0.00,1.00 M0.10,2.00');
});
