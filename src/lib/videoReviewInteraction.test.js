import test from 'node:test';
import assert from 'node:assert/strict';
import {smoothReviewDictation} from './reviewDictation.js';
import {videoEventContext} from './videoEventContext.js';
import {reflowOverlay,fitOverlayBounds,overlaps} from './videoOverlayLayout.js';
test('dictation joins short coordinated fragments without paraphrasing full sentences',()=>{
  assert.equal(smoothReviewDictation('Cleaning feet. And footrests.'),'Cleaning feet and footrests.');
  assert.equal(smoothReviewDictation('Heart rate rose. And the cuff is reading.'),'Heart rate rose. And the cuff is reading.');
  assert.equal(smoothReviewDictation('Pressure noted. No pain.'),'Pressure noted. No pain.');
});
test('event metrics use the last aligned sample and never a future or stale observation',()=>{
  const rows=[{time_offset_s:10,hr:100,baseline_hr:80,hrv_rmssd_ms:12,hrv_sdnn_ms:15},{time_offset_s:20,hr:120}];
  assert.deepEqual(videoEventContext(rows,12),[['HR','100 bpm'],['Δ baseline','+20 bpm'],['RMSSD','12.0 ms'],['SDNN','15.0 ms']]);
  assert.deepEqual(videoEventContext(rows,8),[]);assert.deepEqual(videoEventContext(rows,18),[]);
});
test('a dragged overlay owns its destination and displaces its neighbor without resizing it',()=>{
  const boxes={a:{x:0,y:0,w:.3,h:.3,opacity:.9},b:{x:.4,y:0,w:.3,h:.3,opacity:.8}};
  const moved=reflowOverlay(boxes,'a',{x:.4});assert.equal(moved.a.x,.4);assert.equal(overlaps(moved.a,moved.b),false);assert.equal(moved.b.w,.3);assert.equal(moved.b.opacity,.8);
  const dense=reflowOverlay({a:{x:0,y:0,w:1,h:1},b:{x:0,y:0,w:1,h:1}},'b',{opacity:.7});assert.equal(dense.b.opacity,.7);assert.equal(Object.keys(dense).length,2);
});
test('old tiny overlay layouts expand to readable bounds while staying on the video',()=>{
  const box=fitOverlayBounds('phase',{x:.9,y:.9,w:.1,h:.1},1280,720);
  assert.ok(box.w*1280>=360);assert.ok(box.h*720>=300);assert.ok(box.x+box.w<=1);assert.ok(box.y+box.h<=1);
});
