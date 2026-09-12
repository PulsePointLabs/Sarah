import test from 'node:test';
import assert from 'node:assert/strict';
import {createHowlRecorder} from './howlRecorder.js';
import {normalizeHowlTelemetrySample} from './howlTelemetry.js';
const status = () => ({options:{power_a:4,power_b:6,mute:false,swap_channels:false},player:{title:'download.hwl',position:0,playing:false,duration:120}});
function rig() {
 let time=100000, session={id:'one',startedAt:new Date(100000).toISOString()}, raw=status(), fail=false;
 const saved=[];
 const tick=createHowlRecorder({getSession:()=>session,readStatus:async()=>{if(fail)throw Error('offline');return raw;},save:r=>saved.push(r),now:()=>time});
 return {tick,saved,setTime:v=>time=v,setSession:v=>session=v,setRaw:v=>raw=v,setFail:v=>fail=v};
}
test('external changes and scripts persist independently of Sarah commands; unchanged snapshots are bounded',async()=>{
 const r=rig();await r.tick();assert.equal(r.saved[0].script_title,'download.hwl');assert.equal(r.saved[0].channel_state.a.intensity,4);
 r.setTime(100500);await r.tick();assert.equal(r.saved.length,1);
 const raw=status();raw.options.power_a=8;raw.options.frequency_hz=65;r.setRaw(raw);r.setTime(101000);await r.tick();
 assert.equal(r.saved.at(-1).raw.options.frequency_hz,65);assert.equal(r.saved.at(-1).time_offset_s,1);
 raw.player.title='another.funscript';r.setTime(101500);await r.tick();assert.equal(r.saved.at(-1).script_title,'another.funscript');
 r.setTime(107000);await r.tick();assert.equal(r.saved.at(-1).is_change,false);
});
test('offline intervals recorded once, reconnect recorded, rollover resets and idle does not save',async()=>{
 const r=rig();await r.tick();r.setFail(true);r.setTime(101000);await r.tick();await r.tick();assert.equal(r.saved.length,2);assert.equal(r.saved[1].connection_state,'disconnected');
 r.setFail(false);r.setTime(102000);await r.tick();assert.equal(r.saved[2].is_change,true);
 r.setSession({id:'two',startedAt:new Date(102000).toISOString()});await r.tick();assert.equal(r.saved.at(-1).session,'two');assert.equal(r.saved.at(-1).time_offset_s,0);
 const count=r.saved.length;r.setSession(null);await r.tick();assert.equal(r.saved.length,count);
});
test('in-flight request cannot save to a stopped or replaced session or overlap',async()=>{
 let session={id:'one',startedAt:new Date(0).toISOString()},resolve,calls=0;const saved=[];
 const tick=createHowlRecorder({getSession:()=>session,readStatus:()=>{calls++;return new Promise(r=>resolve=r);},save:r=>saved.push(r)});
 const pending=tick();await tick();assert.equal(calls,1);session=null;resolve(status());await pending;assert.equal(saved.length,0);
});
test('missing numbers remain unknown, channel fields retained, secrets excluded',()=>{
 const p=normalizeHowlTelemetrySample({options:{power_a:0,remoteAccessKey:'secret'},channels:{a:{frequency_hz:80,pulse_width_us:150}},a_power:0});
 assert.equal(p.frequency_hz,null);assert.equal(p.channel_state.a.intensity,0);assert.equal(p.channel_state.a.frequency_hz,80);assert.equal(p.channel_state.a.pulse_width_us,150);
 assert.doesNotMatch(JSON.stringify(p),/secret/);
});
