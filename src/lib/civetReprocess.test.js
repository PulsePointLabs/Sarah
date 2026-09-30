import test from 'node:test';
import assert from 'node:assert/strict';
import { reprocessCivetRecording } from './civetReprocess.js';

function recording({low=false,verified=true}={}) {
  const calibration={id:'recorded-rest-hold',baseline:21,reference:4,noise:.02};
  return Array.from({length:700},(_,i)=>({t:i/10,timestamp_ms:100000+i*100,
    pressure_kpa:i<100||i>600?21:low?19:26+Math.sin(i/4)*.3,
    calibration,acquisition_policy:'pressure-acquisition-3',
    acquisition_state:i>=170&&i<=650?'recalibrate':verified?'ready':'uncalibrated',
    acquisition_message:i>=170&&i<=650?'Pressure remains shifted. Relax; recalibrate if it does not recover.':'Reference ready · pressure recording',
    usable:verified&&!(i>=170&&i<=650),calibration_valid:verified&&!(i>=170&&i<=650),
    quality_flags:i>=170&&i<=650?['calibration_invalidated','baseline_drift_or_tonic_shift']:[],
    connection_id:1,capture_id:'capture',sequence:i,raw_packet_hex:`packet-${i}`,level_pct:null,events:[]}));
}
test('replay recovers elevated-pressure metrics without changing raw samples, reference or clocks',()=>{
  const source=recording(),before=JSON.stringify(source),result=reprocessCivetRecording(source);
  assert.equal(result.recovered_samples,481);assert.ok(result.rows.every(r=>r.usable));
  assert.ok(result.rows[500].duration_s>30);assert.ok(result.rows[500].level_pct>100);
  assert.ok(result.events.length>5);assert.ok(result.trains.length>0);
  result.rows.forEach((r,i)=>{for(const field of ['t','timestamp_ms','pressure_kpa','raw_packet_hex','sequence'])assert.equal(r[field],source[i][field]);assert.deepEqual(r.calibration,source[i].calibration);});
  assert.equal(JSON.stringify(source),before);
});
test('replay preserves low-pressure drift, failed calibration and unverified references',()=>{
  assert.equal(reprocessCivetRecording(recording({low:true})).rows[500].usable,false);
  assert.equal(reprocessCivetRecording(recording({verified:false})).recovered_samples,0);
  const source=recording();source[150]={...source[150],acquisition_state:'recalibrate',usable:false,calibration_valid:false,calibration_error:'Reference was not held steadily'};
  // A failure with no later verified calibration must not be patched over.
  for(let i=151;i<source.length;i++){source[i].usable=false;source[i].calibration_valid=false;}
  assert.equal(reprocessCivetRecording(source).rows[500].usable,false);
});
test('a real outage prevents recovery under the old reference until verified calibration resumes',()=>{
  const source=recording();for(let i=200;i<source.length;i++)source[i].t+=3;
  const result=reprocessCivetRecording(source);
  assert.equal(result.rows[200].gap,true);assert.equal(result.rows[500].usable,false);
  assert.equal(result.rows[500].level_pct,null);
});
