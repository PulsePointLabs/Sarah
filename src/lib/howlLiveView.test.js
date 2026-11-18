import test from 'node:test';import assert from 'node:assert/strict';import {howlLiveView} from './howlLiveView.js';
test('reported power never becomes invented current or pulse state',()=>{
  const now=Date.now(),view=howlLiveView({measured_at:new Date(now).toISOString(),power_a:90,power_b:70,player:{playing:true},mute:false},now);
  assert.equal(view.channels[0].power,90);assert.equal(view.channels[0].active,null);assert.equal(view.channels[0].current,null);assert.deepEqual(view.channels[0].samples,[]);
});
test('fresh supplied samples and current are exposed; stale values are withheld',()=>{
  const now=Date.now(),sample={measured_at:new Date(now).toISOString(),channels:{a:{current_ma:2,output_active:true,waveform_samples:[0,.5,NaN,1]}}};
  assert.deepEqual(howlLiveView(sample,now).channels[0].samples,[0,.5,1]);assert.equal(howlLiveView(sample,now).channels[0].active,true);
  assert.equal(howlLiveView(sample,now+7000).channels[0].current,null);assert.deepEqual(howlLiveView(sample,now+7000).channels[0].samples,[]);
});
