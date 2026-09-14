import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPlaybackProgress,playbackJobStatus} from './playbackProgress.js';
test('encoder progress produces percent, speed, ETA and finalization, never premature completion',()=>{
 const job={status:'processing',durationSeconds:100,startedAt:1000};
 applyPlaybackProgress(job,{out_time_us:'25000000',speed:'2.0x',progress:'continue'},11000);
 assert.equal(job.percent,25);assert.equal(job.etaSeconds,37.5);
 assert.equal(playbackJobStatus(job,0,51000).secondsSinceProgress,40);
 applyPlaybackProgress(job,{out_time_us:'100000000',speed:'1x',progress:'end'});
 assert.equal(job.percent,99);assert.equal(job.stage,'Finalizing MP4');
});
test('queued and unknown duration jobs do not invent completion percentages',()=>{
 assert.equal(playbackJobStatus({status:'queued',createdAt:1000},2,6000).queuePosition,2);
 const job={durationSeconds:0};applyPlaybackProgress(job,{speed:'N/A',progress:'continue'});
 assert.equal(job.percent,null);assert.equal(job.etaSeconds,null);
});
