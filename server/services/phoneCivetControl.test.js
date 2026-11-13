import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createPhoneCivetControl } from './phoneCivetControl.js';

test('commands go only to the live capture and resolve only after phone acknowledgement', async()=>{
  const db=new Database(':memory:');const q=createPhoneCivetControl(db);
  try {
    assert.throws(()=>q.request('capture-one','zero',{}),/offline/);
    q.poll('capture-one');
    const pending=q.request('capture-one','calibrate',{kind:'baseline',prepare_s:3});
    assert.deepEqual(q.poll('capture-two').commands,[]);
    const [command]=q.poll('capture-one').commands;
    assert.equal(command.body.kind,'baseline');
    assert.equal(q.poll('capture-one').commands[0].id,command.id);
    assert.throws(()=>q.acknowledge({id:command.id,capture_id:'capture-two'}),/expired/);
    q.acknowledge({id:command.id,capture_id:'capture-one'});await pending;
    assert.deepEqual(q.poll('capture-one').commands,[]);
    assert.deepEqual(q.acknowledge({id:command.id,capture_id:'capture-one'}),{ok:true});
  } finally {db.close();}
});
test('phone errors reach the caller, and expired commands cannot execute after reconnect',async()=>{
  let clock=100;const db=new Database(':memory:');const q=createPhoneCivetControl(db,{now:()=>clock,timeoutMs:30});
  try {
    q.poll('capture-one');
    const failed=q.request('capture-one','calibrate',{kind:'reference'});
    const [command]=q.poll('capture-one').commands;
    q.acknowledge({id:command.id,capture_id:'capture-one',error:'No fresh pressure'});
    await assert.rejects(failed,/No fresh pressure/);
    const timedOut=q.request('capture-one','zero',{deflated:true});
    clock=200;
    assert.deepEqual(q.poll('capture-one').commands,[]);
    await assert.rejects(timedOut,/did not confirm/);
  } finally {db.close();}
});
