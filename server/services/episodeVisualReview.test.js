import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { episodeSignature, mainMetrics, feetMetrics } from '../../src/lib/episodeAnalysis.js';
// Keep all imported database initialization away from the user's live database.
const root=await fs.mkdtemp(path.join(os.tmpdir(),'sarah-episode-test-'));
process.env.DATABASE_PATH=path.join(root,'test.sqlite');process.env.DATA_DIR=root;process.env.UPLOAD_DIR=root;
const {createEpisodeReviewHandler}=await import('./episodeVisualReview.js');
const {withManualEvidenceWorkspace}=await import('./manualAnnotationEvidence.js');
after(async()=>{const {listJobs,cancelJob}=await import('./jobQueue.js');for(const j of listJobs({type:'episode_visual_review',limit:100}))if(['queued','running'].includes(j.status))cancelJob(j.id);await new Promise(r=>setTimeout(r,200));const {db}=await import('../db.js');db.close();await fs.rm(root,{recursive:true,force:true});});

function fixture({feet=false,fail=false,edit=false,cancel=false,first=false,invalidComparison=false,comparisonFailure=false,summaryFailure=false}={}) {
  const e={id:'e',kind:'near_climax',start_s:10,end_s:31,source:{key:feet?'feet':'main',localPath:'original.mkv',timelineOffsetSeconds:2}};
  const record={id:'r',subjective_near_climax_episodes:[{id:'earlier',kind:'near_climax',start_s:1,end_s:5},e]};
  if(first)record.subjective_near_climax_episodes=[e];
  const entry={job_id:'j',result:{overview:'old review'}},workspaces=[],calls=[],writes=[];
  const controller=new AbortController();
  const metrics=feet?feetMetrics:mainMetrics;
  const invoke=async request=>{
    calls.push(request);
    if(fail)throw Error('provider failure');
    if(request.images){
      assert.ok(!request.prompt.includes('old review'));
      const [,a,b]=request.prompt.match(/Segment SESSION seconds: ([\d.]+) to ([\d.]+)/);
      return {summary:'Early change followed by local release',metrics:metrics.map(metric=>({metric,observation:'Candidate change',visibility:'uncertain',confidence:'low',time_s:Number(a),progression:'Local decrease',laterality:'unresolved',magnitude:'slight'}))};
    }
    if(request.prompt.startsWith('Compare this')) {
      if(comparisonFailure)throw Error('Comparison provider failed');
      return {comparisons:[{episode_id:invalidComparison?'unknown':'earlier',observation:'Earlier comparison'}]};
    }
    if(summaryFailure)throw Error('Summary failed');
    if(edit)e.end_s=32;
    if(cancel)controller.abort();
    return {overview:'Current independent evidence',approach_assessment:'No calibrated probability',progression:'Early to late',recovery:'Local release',limitations:'Synthetic source',comparisons:[{episode_id:'earlier',observation:'Earlier episode has no visual review'}]};
  };
  const dependencies={getEntity:(entity)=>entity==='EpisodeVisualReview'?entry:record,
    upsertEntity:(...args)=>{writes.push(structuredClone(args));Object.assign(entry,args[2]);},listEntitiesByExactCriteria:()=>[],
    probe:async()=>({width:3840,height:2160,fps:30,duration_s:60}),
    workspace:task=>withManualEvidenceWorkspace(async dir=>{workspaces.push(dir);await fs.writeFile(path.join(dir,'analysis.jpg'),'synthetic');return task(dir);}),
    extract:async({timesSeconds})=>timesSeconds.map(t=>({filename:'test.jpg',frameTimeSeconds:t,mimeType:'image/jpeg',data:'synthetic',context:'native full frame'})),
    details:async()=>[],dense:async({start,end,offset})=>({frames:[{filename:'feet.jpg',frameTimeSeconds:start,mimeType:'image/jpeg',data:'synthetic'}],crops:[],motion:{frame_times_s:[start+offset,end+offset]}})};
  return {run:(resume=false)=>createEpisodeReviewHandler(invoke,dependencies)({entity:'Session',recordId:'r',episodeId:'e',signature:episodeSignature(e),resume},{jobId:'j',signal:controller.signal,updateProgress(){}}),workspaces,writes,calls,entry};
}
test('full episode, source offset, independent pass then prior comparison, one durable result',async()=>{
  const f=fixture();await f.run();
  const result=f.entry.result;
  assert.deepEqual(result.reviewed_window,{start_s:5,end_s:36});assert.equal(result.segments.length,4);
  assert.equal(result.segments[0].evidence.frame_times_s[0],5);
  assert.equal(result.segments.at(-1).end_s,36);assert.equal(result.segments[0].metrics[0].confidence,'low');
  assert.equal(f.calls.length,6);assert.match(f.calls.at(-1).prompt,/Earlier episodes/);assert.equal(f.writes.filter(w=>w[2].checkpoint).length,4);
  for(const dir of f.workspaces)await assert.rejects(fs.access(dir));
});
test('feet retains its specialized lane and temporal evidence',async()=>{
  const f=fixture({feet:true});await f.run();const result=f.entry.result;
  assert.equal(result.source.role,'feet');assert.equal(result.segments[0].evidence.temporal_cv,true);
  assert.deepEqual(result.segments[0].metrics.map(m=>m.metric),feetMetrics);
});
test('failure, cancellation and boundary changes preserve the old review and clean media',async()=>{
  for(const options of [{fail:true},{cancel:true},{edit:true}]){
    const f=fixture(options);await assert.rejects(f.run());assert.equal(f.entry.result.overview,'old review');
    for(const dir of f.workspaces)await assert.rejects(fs.access(dir));
  }
});
test('first episode never requests historical comparison, even if summary adds an invented one',async()=>{
  const f=fixture({first:true});await f.run();
  assert.equal(f.calls.length,5);assert.deepEqual(f.entry.result.synthesis.comparisons,[]);
  assert.equal(f.entry.result.comparison_status,'not_applicable');assert.equal(f.entry.result.segments.length,4);
});
test('unknown historical IDs cannot discard the saved head-to-toe report',async()=>{
  const f=fixture({invalidComparison:true});await f.run();
  assert.equal(f.entry.result.segments.length,4);assert.deepEqual(f.entry.result.synthesis.comparisons,[]);
  assert.equal(f.entry.result.comparison_status,'incomplete');
});
test('comparison failure leaves a complete report; retry reuses every saved visual segment',async()=>{
  const f=fixture({comparisonFailure:true});await assert.rejects(f.run(),/Comparison provider/);
  assert.equal(f.entry.result.segments.length,4);assert.equal(f.entry.result.comparison_status,'error');
  const imageCalls=f.calls.filter(c=>c.images).length;
  await assert.rejects(f.run(true),/Comparison provider/);
  assert.equal(f.calls.filter(c=>c.images).length,imageCalls);
});
test('summary failure keeps independently validated checklist checkpoints',async()=>{
  const f=fixture({summaryFailure:true});await assert.rejects(f.run(),/Summary failed/);
  assert.equal(f.entry.checkpoint.segments.length,4);assert.equal(f.entry.checkpoint.visual_complete,true);
  assert.equal(f.entry.result.overview,'old review');
});

test('automatic completion, deduplication, missing fill and re-run keep episode identity',async()=>{
  const {upsertEntity,getEntity,initDb}=await import('../db.js');
  initDb();
  const {registerJobHandler,cancelJob,getJob}=await import('./jobQueue.js');
  const {queueChangedEpisodes,queueEpisodeReview,episodeReviews,episodeReviewId}=await import('./episodeReviewJobs.js');
  registerJobHandler('episode_visual_review',async(_,context)=>new Promise(resolve=>context.signal.addEventListener('abort',()=>resolve({synthetic:true}),{once:true})));
  const e={id:'marked',start_s:3,end_s:null,kind:'near_climax',source:{key:'main',localPath:'synthetic.mkv'}};
  const old=upsertEntity('Session','queue-test',{subjective_near_climax_episodes:[e]});
  queueChangedEpisodes('Session',old,old);assert.equal(episodeReviews('Session',old.id).length,0);
  const done=upsertEntity('Session',old.id,{subjective_near_climax_episodes:[{...e,end_s:12}]});
  queueChangedEpisodes('Session',old,done);
  const review=episodeReviews('Session',old.id)[0];assert.ok(review.job_id);
  assert.equal(queueEpisodeReview('Session',old.id,e.id,{force:true}).id,review.job_id);
  cancelJob(review.job_id);
  const signature=episodeSignature(done.subjective_near_climax_episodes[0]);
  upsertEntity('EpisodeVisualReview',episodeReviewId('Session',old.id,e.id),{result:{signature,overview:'saved'}});
  assert.equal(queueEpisodeReview('Session',old.id,e.id),null);
  const rerun=queueEpisodeReview('Session',old.id,e.id,{force:true});assert.notEqual(rerun.id,review.job_id);
  assert.equal(getEntity('Session',old.id).subjective_near_climax_episodes.length,1);
  assert.equal(episodeReviews('Session',old.id)[0].result.overview,'saved');
  const edited=upsertEntity('Session',old.id,{subjective_near_climax_episodes:[{...e,end_s:14}]});
  queueChangedEpisodes('Session',done,edited);
  assert.equal(getJob(rerun.id).status,'cancelled');
  cancelJob(episodeReviews('Session',old.id)[0].job_id);
});

test('HTTP episode endpoints enqueue after a persisted PATCH and support fill/re-run',async()=>{
  const express=(await import('express')).default;
  const {entitiesRouter}=await import('../routes/entities.js');
  const {upsertEntity}=await import('../db.js');
  const {cancelJob}=await import('./jobQueue.js');
  const record=upsertEntity('BodyExploration','http-episode-test',{subjective_near_climax_episodes:[]});
  const app=express();app.use(express.json());app.use('/api/entities',entitiesRouter);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/entities/BodyExploration/${record.id}`;
  try{
    const response=await fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({subjective_near_climax_episodes:[{id:'http-e',start_s:10,end_s:20,source:{key:'feet',localPath:'synthetic.mkv'}}]})});
    assert.equal(response.status,200);
    const reviews=await (await fetch(`${url}/episode-reviews`)).json();assert.equal(reviews.length,1);assert.ok(reviews[0].job_id);
    const filled=await (await fetch(`${url}/episode-reviews`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fillMissing:true})})).json();
    assert.equal(filled.jobs[0].id,reviews[0].job_id);
    cancelJob(reviews[0].job_id);
    const retry=await (await fetch(`${url}/episode-reviews`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({episodeId:'http-e'})})).json();
    assert.notEqual(retry.jobs[0].id,reviews[0].job_id);cancelJob(retry.jobs[0].id);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
