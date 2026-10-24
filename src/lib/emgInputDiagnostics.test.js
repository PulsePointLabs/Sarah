import test from 'node:test';
import assert from 'node:assert/strict';
import {emgInputDiagnostics,emgPlotRange} from './emgInputDiagnostics.js';

test('near-ceiling input is identified before calibration without declaring muscle activity',()=>{
  const history=Array.from({length:100},(_,i)=>({raw:[995+i%3],values:[500]}));
  const result=emgInputDiagnostics(history,0,996);
  assert.equal(result.state,'high');assert.equal(result.min,995);assert.equal(result.max,997);assert.equal(result.span,2);
  assert.match(result.message,/If relaxed/);
});
test('quiet input is not labeled a dead sensor; a noisy unused second input does not affect A0',()=>{
  const history=Array.from({length:100},(_,i)=>({raw:[40+i%2,i%2?0:1023]}));
  assert.equal(emgInputDiagnostics(history,0).state,'quiet');
  assert.match(emgInputDiagnostics(history,0).message,/cannot distinguish/);
  assert.equal(emgInputDiagnostics([],0).state,'missing');
  assert.equal(emgInputDiagnostics([],0,995).state,'high');
});
test('detail view retains a minimum 40 ADC span so quiet noise is not drawn as a full-scale response',()=>{
  const history=Array.from({length:30},(_,i)=>({raw:[995+i%2],values:[995.4]}));
  assert.deepEqual(emgPlotRange(history,0,false),{min:0,max:1023});
  const range=emgPlotRange(history,0,true);
  assert.ok(range.max<=1023 && range.min>=0);assert.ok(range.max-range.min>=40);
  assert.ok(range.min<=995 && range.max>=996);
});
