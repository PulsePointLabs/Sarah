import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveLiveHrTelemetry} from './liveHrDerivation.js';
import {computeLiveClimaxPrediction} from '../utils/liveClimaxPrediction.js';

test('continuous 4 Hz H10 builds time-based baseline and supports changing passive predictions',()=>{
  const state=new Map(),history=[],start=1790000000000;let last,peak=0;
  for(let tick=0;tick<1200;tick++){
    const seconds=tick/4,at=start+tick*250;
    last=deriveLiveHrTelemetry({source:'direct_h10',receivedAt:at,measuredAt:at,
      heartRate:seconds<60?80:seconds<240?Math.min(125,80+(seconds-60)*.6):Math.max(85,125-(seconds-240)),
      hrv:{rmssdMs:seconds<60?24:seconds<240?4:24,quality:'high',sampleCount:180}},state);
    const point={ts:at,sessionTimeSec:seconds,hr:last.currentHr,hrSmoothed:last.hrSmoothed,baseline:last.baselineHr,build:last.buildConfidence,phase:last.phase,hrvRmssd:last.hrv.rmssdMs};
    if(history.length&&Math.floor(history.at(-1).ts/1000)===Math.floor(at/1000))history[history.length-1]=point;else history.push(point);
    const prediction=computeLiveClimaxPrediction(last,null,history,{sessionTimeSec:seconds});
    point.nearClimax=prediction.nearClimax;peak=Math.max(peak,prediction.nearClimax);
  }
  assert.equal(state.get('direct_h10').length,300);assert.equal(history.length,300);
  assert.ok(last.baselineHr<100);assert.ok(peak>=68,`peak was ${peak}`);
  assert.equal(last.phase,'recovery');
  assert.ok(computeLiveClimaxPrediction(last,null,history,{sessionTimeSec:300}).nearClimax<peak);
});
