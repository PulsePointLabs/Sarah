import test from 'node:test';
import assert from 'node:assert/strict';
import { editSubjectiveEpisode, episodeBoundaryTime } from './subjectiveNearClimax.js';
test('moving boundaries updates the same episode, duration and telemetry without changing source or other episodes', () => {
 const source = { key: 'feet', timelineOffsetSeconds: 12 };
 const episodes = [{ id:'n', kind:'near_climax', start_s:10, end_s:20, source, thumbnail_url:'image' }, { id:'c',kind:'climax',start_s:30,end_s:35 }];
 const rows = [{time_offset_s:12,hr:80},{time_offset_s:18,hr:100}];
 const next = editSubjectiveEpisode(episodes,'n','start_s',15,rows,{});
 assert.equal(next.length,2); assert.equal(next[0].id,'n'); assert.equal(next[0].duration_s,5);
 assert.equal(next[0].telemetry.hr_mean,100); assert.equal(next[0].source,source);
 assert.equal(next[0].thumbnail_time_s,10); assert.equal(next[0].thumbnail_url,'image');
 assert.equal(next[1],episodes[1]); assert.equal(episodes[0].start_s,10);
 const climax = editSubjectiveEpisode(next,'c','end_s',40,rows,{});
 assert.equal(climax[1].duration_s,10);
});
test('bounds cannot cross, go negative or accidentally finish an open episode', () => {
 const e={start_s:10,end_s:20};
 assert.equal(episodeBoundaryTime(e,'start_s',30),19.9);
 assert.equal(episodeBoundaryTime(e,'end_s',0),10.1);
 assert.equal(episodeBoundaryTime(e,'start_s',-5),0);
 assert.throws(()=>episodeBoundaryTime({...e,end_s:null},'end_s',30));
 const next=editSubjectiveEpisode([{id:'a',start_s:10,end_s:null}],'a','start_s',5,[],{});
 assert.equal(next[0].end_s,null); assert.equal(next[0].start_s,5);
});
