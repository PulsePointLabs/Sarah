import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEmgHelper } from './emgHelper.js';

test('managed EMG validates ports, prevents duplicate collectors, preserves paths and closes gracefully', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sarah-emg-test-'));
  const launches = [];
  const process = new EventEmitter(); process.stdout = new EventEmitter(); process.stderr = new EventEmitter();
  const manager = createEmgHelper({ emgTextDir: directory, emgSessionsDir: path.join(directory, 'sessions'), hrObsWsUrl: 'ws://127.0.0.1:4455', hrObsPassword: 'fixture-secret' }, {
    exec: async () => ({ stdout: JSON.stringify([{ port: 'COM7', label: 'Arduino' }]) }),
    spawn: (...args) => { launches.push(args); return process; },
  });
  try {
    await assert.rejects(manager.start({ port: 'COM999' }), /unavailable/);
    assert.equal(launches.length, 0);
    await manager.start({ port: 'COM7', channels: 2 });
    await manager.start({ port: 'COM7', channels: 2 });
    assert.equal(launches.length, 1);
    await assert.rejects(manager.start({ port: 'COM7', channels: 1 }), /Disconnect/);
    const options = launches[0][2];
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.EMG_HEADLESS, '1');
    assert.equal(options.env.EMG_LEFT_TEXT_PATH, path.join(directory, 'emg_left.txt'));
    assert.equal(options.env.OBS_HOST, '127.0.0.1');
    assert.equal(JSON.stringify(manager.status()).includes('fixture-secret'), false);
    await manager.stop();
    assert.equal(await fs.readFile(path.join(directory, 'emg_stop'), 'utf8'), 'stop');
    process.emit('exit', 0);
    assert.equal(manager.status().running, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('installation, process and fresh samples are independent; profiles persist across instances', async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sarah-emg-status-'));
  const config={emgTextDir:directory,emgSessionsDir:path.join(directory,'sessions'),hrObsWsUrl:'ws://localhost:4455'};
  const process=new EventEmitter();process.stdout=new EventEmitter();process.stderr=new EventEmitter();
  const dependencies={exec:async()=>({stdout:JSON.stringify([{port:'COM7',label:'Arduino'}])}),spawn:()=>process};
  const manager=createEmgHelper(config,dependencies);
  try {
    const saved=await manager.saveProfile({names:['Foot','Perineum'],notes:['left foot','placement note'],channels:2});
    assert.deepEqual((await createEmgHelper(config,dependencies).profile()).names,saved.names);
    let status=await manager.inspect();assert.equal(status.installed,true);assert.equal(status.running,false);assert.equal(status.receiving,false);
    await manager.start({port:'COM7'});status=await manager.inspect();assert.equal(status.running,true);assert.equal(status.receiving,false);
    await fs.writeFile(path.join(directory,'emg_setup_status.json'),JSON.stringify({measured_at:Date.now()/1000,calibration:{phase:'collecting'}}));
    assert.equal((await manager.inspect()).receiving,true);
    await fs.writeFile(path.join(directory,'emg_setup_status.json'),JSON.stringify({measured_at:Date.now()/1000-2}));
    assert.equal((await manager.inspect()).receiving,false);
    assert.equal((await manager.profile()).lastPort,'COM7');
  } finally {await manager.stop();process.emit('exit',0);await fs.rm(directory,{recursive:true,force:true});}
});

test('reconnect follows the same Arduino identity after COM changes and stops on Disconnect', async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sarah-emg-reconnect-'));
  let ports=[{port:'COM7',label:'Arduino',serialNumber:'device-one',vid:123,pid:456}];
  const children=[];
  const manager=createEmgHelper({emgTextDir:directory,emgSessionsDir:path.join(directory,'sessions'),hrObsWsUrl:'ws://localhost:4455'}, {
    exec:async()=>({stdout:JSON.stringify(ports)}),spawn:()=>{const p=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();children.push(p);return p;},
  });
  try {
    await manager.start({port:'COM7'});
    ports=[{port:'COM7',serialNumber:'different',vid:123,pid:456},{port:'COM9',serialNumber:'device-one',vid:123,pid:456}];
    children[0].emit('exit',1);
    const deadline=Date.now()+5000;
    while(children.length<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(children.length,2);assert.equal(manager.status().port,'COM9');
    await manager.stop();children[1].emit('exit',0);
    await new Promise(resolve=>setTimeout(resolve,3200));assert.equal(children.length,2);
  } finally {await manager.stop();await fs.rm(directory,{recursive:true,force:true});}
});
