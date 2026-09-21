import test from 'node:test';
import assert from 'node:assert/strict';
import { episodeSegments, episodeSignature, completedEpisode, episodeEvidence, feetMetrics, mainMetrics, validateEpisodeSegment } from './episodeAnalysis.js';
test('whole intervals are covered without gaps or truncating long episodes',()=>{
  const parts=episodeSegments(7,138.6);
  assert.equal(parts[0].start_s,7);assert.equal(parts.at(-1).end_s,138.6);
  assert.ok(parts.every((p,i)=>i===0 || p.start_s===parts[i-1].end_s));
});
test('closed episodes and source/boundary changes have distinct revisions',()=>{
  const e={id:'e',start_s:7,end_s:null};assert.equal(completedEpisode(e),false);
  e.end_s=20;assert.equal(completedEpisode(e),true);
  assert.notEqual(episodeSignature(e),episodeSignature({...e,end_s:21}));
  assert.notEqual(episodeSignature(e),episodeSignature({...e,source:{key:'feet'}}));
});
test('unavailable physiology stays missing and never becomes probability',()=>{
  const result=episodeEvidence({start_s:0,end_s:10},[]);
  assert.equal(result.peak,null);assert.equal(result.median_score,null);assert.equal(result.usable_hrv_samples,0);
  assert.match(result.interpretation,/not calibrated/);
});
test('checklist preserves uncertain observations and rejects omissions/out-of-window claims',()=>{
  const valid={summary:'Early toe flexion eases later.',metrics:feetMetrics.map(metric=>({metric,observation:'Possible local change',visibility:'uncertain',confidence:'low',time_s:11}))};
  assert.equal(validateEpisodeSegment(valid,feetMetrics,10,20).metrics.length,feetMetrics.length);
  assert.throws(()=>validateEpisodeSegment({...valid,metrics:valid.metrics.slice(1)},feetMetrics,10,20),/omitted/);
  assert.throws(()=>validateEpisodeSegment(valid,feetMetrics,12,20),/timestamp/);
  assert.ok(!feetMetrics.some(m=>/penile|scrotal|stimulation/i.test(m)));
  assert.ok(mainMetrics.some(m=>/Penile/.test(m)));
});
