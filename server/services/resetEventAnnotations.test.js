import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'sarah-reset-events-'));
process.env.DATA_DIR=temp;
process.env.DATABASE_PATH=path.join(temp,'test.sqlite');
process.env.UPLOAD_DIR=path.join(temp,'uploads');
process.env.LEGACY_UPLOAD_DIR=process.env.UPLOAD_DIR;
const {db,initDb,upsertEntity,getEntity}=await import('../db.js');
initDb();
const {resetEventAnnotations}=await import('./resetEventAnnotations.js');
const {getJob}=await import('./jobQueue.js');
fs.mkdirSync(process.env.UPLOAD_DIR,{recursive:true});
test('session reset clears all cameras, reviews and completed job history but retains independent data and shared media',()=>{
 for(const name of ['annotation-evidence-own-0.jpg','annotation-evidence-shared-0.jpg','source.mp4'])fs.writeFileSync(path.join(process.env.UPLOAD_DIR,name),'test');
 const original={id:'s',event_timeline:[{source:'manual',annotation_camera:{role:'feet'}},{source:'ai_video_pass'}],
 linked_local_videos:[{path:'source.mp4'}],subjective_near_climax_episodes:[{start_s:1,end_s:3}],
 ai_analysis:{summary:'keep report',_manual_annotation_visual_reviews:[{sampled_frames:[{filename:'annotation-evidence-own-0.jpg'},{filename:'annotation-evidence-shared-0.jpg'}]}],_video_pass_findings:[{id:'review'}],_video_pass_digest:'old digest',cloud_multimodal_passes:[{id:'pass'}],_visual_snapshot_reviews:[{filename:'annotation-evidence-shared-0.jpg'}]}};
 upsertEntity('Session','s',original);upsertEntity('Session','other',{event_timeline:[{note:'keep'}]});
 upsertEntity('HeartRateTimeline','hr',{session_id:'s',hr:90});
 upsertEntity('ProcessingJob','j',{type:'manual_annotation_visual_review',status:'complete',meta:{sessionId:'s',recordType:'session'},result:{review:'old'}});
 upsertEntity('ProcessingJob','tts',{type:'tts_export',status:'complete',meta:{sessionId:'s'}});
 const result=resetEventAnnotations('Session','s');
 assert.equal(result.removedEvents,2);assert.deepEqual(result.record.event_timeline,[]);
 assert.equal(result.record.ai_analysis._manual_annotation_visual_reviews,undefined);
 assert.equal(result.record.ai_analysis._video_pass_digest,undefined);
 assert.equal(result.record.ai_analysis.summary,'keep report');assert.equal(result.record.ai_analysis._visual_snapshot_reviews.length,1);
 assert.deepEqual(result.record.subjective_near_climax_episodes,original.subjective_near_climax_episodes);
 assert.equal(getJob('j'),null);assert.ok(getJob('tts'));assert.equal(getEntity('HeartRateTimeline','hr').hr,90);
 assert.equal(getEntity('Session','other').event_timeline.length,1);
 assert.equal(fs.existsSync(path.join(process.env.UPLOAD_DIR,'annotation-evidence-own-0.jpg')),false);
 assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR,'annotation-evidence-shared-0.jpg')));
 assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR,'source.mp4')));
 assert.equal(resetEventAnnotations('Session','s').removedEvents,0);
});
test('active jobs reject reset before any data changes, and Body Exploration uses its own analysis field',()=>{
 upsertEntity('BodyExploration','b',{event_timeline:[{note:'keep until reset'}],ai_body_exploration:{summary:'keep',_manual_annotation_visual_reviews:[{id:'r'}]}});
 upsertEntity('ProcessingJob','active',{type:'manual_annotation_visual_review',status:'running',meta:{sessionId:'b',recordType:'body_exploration'}});
 assert.throws(()=>resetEventAnnotations('BodyExploration','b'),{status:409});
 assert.equal(getEntity('BodyExploration','b').event_timeline.length,1);
 upsertEntity('ProcessingJob','active',{status:'complete'});
 assert.equal(resetEventAnnotations('BodyExploration','b').record.ai_body_exploration._manual_annotation_visual_reviews,undefined);
 assert.throws(()=>resetEventAnnotations('Session','missing'),{status:404});
 assert.throws(()=>resetEventAnnotations('HeartRateTimeline','hr'),{status:400});
});
test('HTTP reset requires explicit confirmation and returns the refreshed record',async()=>{
 const {default:express}=await import('express');
 const {entitiesRouter}=await import('../routes/entities.js');
 const app=express();app.use(express.json());app.use('/entities',entitiesRouter);
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const url=`http://127.0.0.1:${server.address().port}/entities/Session/s/reset-event-annotations`;
 try {
  const denied=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(denied.status,400);
  const cleared=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'clear_all_event_annotations'})});
  assert.equal(cleared.status,200);assert.deepEqual((await cleared.json()).record.event_timeline,[]);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test.after(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});});
