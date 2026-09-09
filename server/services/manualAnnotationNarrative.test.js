import test from 'node:test';
import assert from 'node:assert/strict';
import { polishFeetReview } from './manualAnnotationNarrative.js';

test('presentation polish preserves candidate confidence, intervals, asymmetry and local release',async()=>{
  const original={narrative:{before:'The tracker moves.',around:'Direction-change counts increase.',after:'The motion energy falls.'},findings:[{observation:'The tracker shows possible toe release.',confidence:'low',start_s:72,end_s:74,laterality:'left',asymmetry:'left more flexed than right',change:'release'}]};
  const result=await polishFeetReview(original,async request=>{
    assert.equal(request.images,undefined);
    return {narrative:{before:'Before, your left toes begin to curl.',around:'Around the mark, the left curl increases slightly.',after:'Afterward, toe flexion may decrease while the ankle remains plantar-flexed.'},observations:[{index:0,text:'Possible local decrease in left toe flexion.'}]};
  });
  assert.equal(result.findings[0].confidence,'low');assert.equal(result.findings[0].start_s,72);assert.equal(result.findings[0].asymmetry,original.findings[0].asymmetry);
  assert.match(result.summary,/Before.*Around.*Afterward/);assert.doesNotMatch(result.summary,/tracker|motion energy/);
});

test('already readable temporal prose incurs no extra model request',async()=>{
  const result={narrative:{before:'Before, toe flexion begins.',around:'Around the mark, it increases.',after:'Afterward, toe flexion decreases.'},findings:[]};
  assert.equal(await polishFeetReview(result,()=>{throw Error('should not call');}),result);
});
