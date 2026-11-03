import test from 'node:test';
import assert from 'node:assert/strict';
import {anatomySections,evidenceFramesFor,REVIEW_READER_RULE} from './anatomyReview.js';
test('every main-camera report has the same anatomical sections without inventing findings',()=>{
 const sections=anatomySections([{anatomical_area:'Abdomen',observation:'The subject’s abdomen was tense.',evidence_time_s:72,confidence:'low'}]);
 assert.ok(sections.some(s=>s.label==='Penis / glans'&&!s.findings.length));
 const abdomen=sections.find(s=>s.id==='abdomen');assert.match(abdomen.findings[0].observation,/Your abdomen was tense/);assert.equal(abdomen.findings[0].confidence,'low');
 assert.equal(sections.find(s=>s.id==='breathing').findings.length,0);
});
test('feet-camera report does not invent upper-body coverage',()=>{
 const sections=anatomySections([{metric:'Toe splay',observation:'Possible spreading.',confidence:'low'}],'feet');
 assert.ok(!sections.some(s=>s.id==='penis'));assert.equal(sections.find(s=>s.id==='toes').findings[0].confidence,'low');
});
test('images must have a matching saved timestamp rather than an arbitrary representative frame',()=>{
 const frames=[{url:'/uploads/real.jpg',recordTimeSeconds:72},{url:'/uploads/other.jpg',recordTimeSeconds:80}];
 assert.deepEqual(evidenceFramesFor({evidence_time_s:72.3},frames),[frames[0]]);
 assert.deepEqual(evidenceFramesFor({evidence_time_s:75},frames),[]);
 assert.deepEqual(evidenceFramesFor({},frames),[]);
});
test('the writing rule separates observed physiology, user markers and uncertainty',()=>{
 assert.match(REVIEW_READER_RULE,/never subject, patient/);assert.match(REVIEW_READER_RULE,/Do not infer breath holding from a still frame/);
});
