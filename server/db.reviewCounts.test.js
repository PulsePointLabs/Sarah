import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('record picker counts do not transfer event snapshots or alter saved detail',async()=>{
  const prefix=path.join(os.tmpdir(),'sarah-visual-count-'),directory=fs.mkdtempSync(prefix);
  process.env.DATABASE_PATH=path.join(directory,'test.sqlite');
  const {db,initDb,upsertEntity,listEntityPage,getEntity}=await import('./db.js');
  try{
    initDb();upsertEntity('Session','marked',{title:'Fixture',event_timeline:[{visual_annotation:{frame:{data_url:'private-frame-data'}}},{}],subjective_near_climax_episodes:[{}]});
    const [record]=listEntityPage('Session',{fields:['title','review_event_count','review_episode_count']});
    assert.equal(record.review_event_count,2);assert.equal(record.review_episode_count,1);assert.equal(record.event_timeline,undefined);assert.ok(!JSON.stringify(record).includes('private-frame-data'));
    assert.equal(getEntity('Session','marked').event_timeline[0].visual_annotation.frame.data_url,'private-frame-data');
  }finally{db.close();if(directory.startsWith(prefix))fs.rmSync(directory,{recursive:true,force:true});}
});
