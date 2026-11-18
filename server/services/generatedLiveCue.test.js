import test from 'node:test';import assert from 'node:assert/strict';
import {generateLiveCue,liveCueContext} from './generatedLiveCue.js';
test('generation sends only finite numeric summary fields, never notes/audio/video',async()=>{
  let sent;const text=await generateLiveCue({type:'sustained_build',context:{hr:105,baselineHr:78,notes:'private',audio:'private',video:'private',recovery:NaN},recent:['A different earlier thought']},async payload=>{sent=payload;return {content:[{type:'text',text:'Your heart rate has risen from baseline; there is no need to chase the number.'}],stop_reason:'end_turn'};});
  assert.ok(text.includes('heart rate'));assert.deepEqual(liveCueContext({hr:105,notes:'private'}),{hr:105});assert.ok(!JSON.stringify(sent).includes('private'));
});
test('repeated or cut-off output stays quiet instead of looping a fallback',async()=>{
  const create=async()=>({content:[{type:'text',text:'Steady now.'}],stop_reason:'end_turn'});
  assert.equal(await generateLiveCue({type:'recovery',recent:['Steady now.']},create),'');
  assert.equal(await generateLiveCue({type:'recovery'},async()=>({content:[{type:'text',text:'Incomplete'}],stop_reason:'max_tokens'})),'');
});
