import test from 'node:test';
import assert from 'node:assert/strict';
import { telemetryValueChange, discreteValueChange } from './telemetryValueChange.js';
test('continuous arrows compare ten seconds, never future or stale samples',()=>{
 const rows=[{t:0,hr:90},{t:10,hr:94},{t:11,hr:110}];
 assert.deepEqual(telemetryValueChange(rows,'hr',10),{delta:4,arrow:'\u2191',interval:10});
 assert.equal(telemetryValueChange(rows,'hr',5),null);
 assert.equal(telemetryValueChange(rows,'hr',30),null);
 assert.equal(telemetryValueChange([{t:0,hr:90},{t:10,hr:90}],'hr',10).delta,0);
});
test('BP reports independent systolic and diastolic changes from previous measurement',()=>{
 const readings=[{time_s:1,systolic_mm_hg:120,diastolic_mm_hg:90},{time_s:50,systolic_mm_hg:125,diastolic_mm_hg:85}];
 assert.equal(discreteValueChange(readings,['systolic_mm_hg','diastolic_mm_hg'],40),null);
 const result=discreteValueChange(readings,['systolic_mm_hg','diastolic_mm_hg'],50);
 assert.equal(result.delta,5);assert.match(result.text,/5.*-5/);assert.equal(result.label,'prior reading');
});
