import test from 'node:test';
import assert from 'node:assert/strict';
import { fitTelemetryHeights, telemetryMinimum, telemetryMaximum } from './videoTelemetrySizing.js';
const ids=['metrics','phase','cardiac','autonomic','civet','respiration'];
test('defaults fit the viewport with equal graph cards and a short vital row',()=>{
  for(const budget of [560,700,920]){
    const sizes=fitTelemetryHeights(ids,budget);
    assert.ok(Object.values(sizes).reduce((a,b)=>a+b,0)<=budget+.01);
    assert.ok(sizes.metrics<sizes.phase);
    assert.ok(Math.abs(sizes.phase-sizes.civet)<.01);
    assert.ok(Math.abs(sizes.cardiac-sizes.civet)<.01);
  }
});
test('resizing borrows from peers within their floors; hidden cards do not inflate',()=>{
  const initial=fitTelemetryHeights(ids,800);
  const larger=fitTelemetryHeights(ids,800,{...initial,civet:300},'civet');
  assert.equal(larger.civet,300);
  for(const id of ids)assert.ok(larger[id]>=telemetryMinimum(id));
  assert.ok(Object.values(larger).reduce((a,b)=>a+b,0)<=800+.01);
  const visible=ids.filter(id=>id!=='civet');
  const hidden=fitTelemetryHeights(visible,800,initial);
  for(const id of visible)assert.equal(hidden[id],initial[id]);
});
test('oversized saved preferences cannot recreate the scrolling canvas',()=>{
  const sizes=fitTelemetryHeights(ids,700,Object.fromEntries(ids.map(id=>[id,10000])));
  for(const id of ids){assert.ok(sizes[id]<=telemetryMaximum(id));assert.ok(sizes[id]>=telemetryMinimum(id));}
  assert.ok(Object.values(sizes).reduce((a,b)=>a+b,0)<=700+.01);
  assert.deepEqual(fitTelemetryHeights([],700),{});
});
