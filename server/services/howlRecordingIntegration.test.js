import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// Real Howl HTTP route, recorder scheduler, SQLite persistence and read endpoint;
// isolated database and fake device, never touches Ben's recordings or hardware.
test('external Howl status reaches the saved session API without a Sarah control command', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sarah-howl-test-'));
  const old = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = path.join(dir, 'test.sqlite');
  let deviceServer, apiServer, stop, db;
  try {
    const database = await import('../db.js'); db=database.db; database.initDb();
    const {howlRouter,startHowlRecording}=await import('../routes/howl.js');
    let power=4;
    const device=express();device.use(express.json());
    device.post('/status',(req,res)=>{assert.equal(req.headers.authorization,'Bearer test-only');res.json({options:{power_a:power,power_b:6,mute:false},player:{title:'example.funscript',position:0,playing:false,duration:60}});});
    deviceServer=device.listen(0,'127.0.0.1');await new Promise(r=>deviceServer.once('listening',r));
    database.upsertEntity('HowlControlSettings','default',{controlUrl:`http://127.0.0.1:${deviceServer.address().port}`,remoteAccessKey:'test-only',controlEnabled:false});
    const startedAt=new Date().toISOString();
    database.upsertEntity('Session','test-session',{capture_started_at:startedAt,event_timeline:[]});
    stop=startHowlRecording(()=>({id:'test-session',startedAt}));
    const waitFor=async check=>{for(let i=0;i<30;i++){if(check())return;await new Promise(r=>setTimeout(r,100));}throw Error('Recorder did not persist');};
    await waitFor(()=>database.listEntities('HowlTelemetry').length>0);
    power=9;
    await waitFor(()=>database.listEntities('HowlTelemetry').some(r=>r.channel_state?.a?.intensity===9));
    const api=express();api.use('/api/howl',howlRouter);apiServer=api.listen(0,'127.0.0.1');await new Promise(r=>apiServer.once('listening',r));
    const data=await (await fetch(`http://127.0.0.1:${apiServer.address().port}/api/howl/telemetry/session/test-session`)).json();
    assert.ok(data.samples.length>=2);assert.equal(data.samples.at(-1).channel_state.a.intensity,9);
    assert.equal(data.samples.at(-1).script_title,'example.funscript');assert.ok(data.samples.at(-1).time_offset_s>=0);
    assert.equal(database.listEntities('HowlControlCommand').length,0);
  } finally {
    stop?.();await Promise.all([deviceServer,apiServer].filter(Boolean).map(server=>new Promise(r=>server.close(r))));
    db?.close();if(old==null)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=old;
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('sarah-howl-test-')) throw Error('Unexpected test cleanup path');
    await rm(dir,{recursive:true,force:true});
  }
});
