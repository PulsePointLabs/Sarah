import test from 'node:test';
import assert from 'node:assert/strict';
import {hasActiveLiveSession,describeSessionRecording} from './liveSessionState.js';
const ended={activeSessionId:'finished-id',active:false,finalizedAt:'2026-11-14T20:00:27.145Z'};
test('a finalized ID never enables End active session, including when OBS is offline',()=>{
  assert.equal(hasActiveLiveSession(ended,null),false);
  assert.equal(describeSessionRecording({session:ended,obsConnected:false}).label,'SESSION ENDED');
});
test('a new confirmed recording is not masked by the previous finished record',()=>{
  assert.equal(hasActiveLiveSession(ended,{active:true}),true);
  assert.equal(describeSessionRecording({session:ended,recording:{active:true},obsConnected:true}).label,'RECORDING · OBS');
});
test('offline OBS distinguishes active, finalized, idle, and unknown server state',()=>{
  assert.equal(hasActiveLiveSession({...ended,active:true},null),true);
  assert.match(describeSessionRecording({session:{...ended,active:true},obsConnected:false}).label,/unconfirmed/);
  assert.equal(describeSessionRecording({session:{active:false},obsConnected:false}).label,'NO ACTIVE SARAH SESSION');
  assert.match(describeSessionRecording({obsConnected:false}).label,/unconfirmed/);
});
test('camera recording and saving have priority over an offline OBS connection',()=>{
  assert.match(describeSessionRecording({session:ended,camera:{phase:'recording'},obsConnected:false}).label,/RECORDING/);
  assert.match(describeSessionRecording({session:{...ended,importing:true},obsConnected:false}).label,/SAVING/);
});
