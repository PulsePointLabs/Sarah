import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAnnotationTimeline, annotationTimelineEntries, annotationReviewFeed, mergeManualAnnotationReview } from './manualAnnotationFrameCoverage.js';
import { TEMPORAL_FEET_SCHEMA, promoteManualFinding, temporalFindingInWindow } from './manualAnnotationTemporal.js';
import { manualAnnotationReport } from './manualAnnotationReport.js';

test('Both/Main/Feet filters preserve global chronology, original indices and ownership', () => {
  const events = [
    {event_id:'c',time_s:77,annotation_camera:{role:'main'}},
    {event_id:'a',time_s:63,annotation_camera:{role:'main'}},
    {event_id:'d',time_s:91,annotation_camera:{role:'feet'}},
    {event_id:'b',time_s:72,annotation_camera:{role:'feet'}},
    {event_id:'legacy',time_s:60},
  ];
  const before = JSON.stringify(events), entries = annotationTimelineEntries(events);
  assert.deepEqual(filterAnnotationTimeline(entries,[],'both').map(e=>e.ev.event_id), ['legacy','a','b','c','d']);
  assert.deepEqual(filterAnnotationTimeline(entries,[],'main').map(e=>e.i), [1,0]);
  assert.deepEqual(filterAnnotationTimeline(entries,[],'feet').map(e=>e.i), [3,2]);
  assert.equal(JSON.stringify(events),before);
});

test('reanalysis resolves saved original and offset regardless of selected playback', () => {
  const event={event_id:'note',time_s:72};
  const review={event_id:'note',source_video:{role:'feet',path:'D:/original.mp4',timelineOffsetSeconds:11},summary:'Old readable report'};
  const feed=annotationReviewFeed(event,[review],{},[],{key:'main',localPath:'wrong.mp4'});
  assert.equal(feed.key,'lower_body');assert.equal(feed.localPath,'D:/original.mp4');assert.equal(feed.timelineOffsetSeconds,11);
  assert.equal(manualAnnotationReport(review).summary,'Old readable report');
  assert.equal(annotationReviewFeed({annotation_camera:{role:'feet'}},[],{},[],{key:'main',localPath:'wrong.mp4'}),null);
});

test('reanalyzing a moved source replaces the review while preserving other-camera evidence', () => {
  const main={event_id:'note',source_video:{role:'main',path:'old-main.mp4'}};
  const feet={event_id:'note',source_video:{role:'feet',path:'old-feet.mp4'}};
  const replacement={event_id:'note',source_video:{role:'feet',path:'moved-feet.mp4'}};
  assert.deepEqual(mergeManualAnnotationReview([main,feet],replacement),[main,replacement]);
});

test('schema preserves small asymmetry and separates temporal evidence from promotion', () => {
  const fields=TEMPORAL_FEET_SCHEMA.properties.findings.items.properties;
  for (const key of ['state','laterality','direction','magnitude','asymmetry','start_s','end_s','change','visibility','confidence']) assert.ok(fields[key]);
  assert.equal(promoteManualFinding({confidence:'low',visibility:'clear'}),false);
  assert.equal(promoteManualFinding({confidence:'high',visibility:'limited'}),false);
  assert.equal(promoteManualFinding({confidence:'high',visibility:'clear'}),true);
  assert.equal(temporalFindingInWindow({start_s:67,end_s:77,evidence_time_s:72},67,77),true);
  assert.equal(temporalFindingInWindow({start_s:66,end_s:77,evidence_time_s:72},67,77),false);
});

test('legacy canned relaxation sentence is omitted without reversing a negative',()=>{
  assert.equal(manualAnnotationReport({source_video_role:'feet',summary:'Reduced sampled movement alone does not establish relaxation.'}).summary,'');
  const finding={anatomical_area:'Left toes',confidence:'low',observation:'Possible slight toe extension while the ankle remains plantar-flexed.'};
  assert.equal(manualAnnotationReport({source_video_role:'feet',findings:[finding]}).findings[0].observation,finding.observation);
});
