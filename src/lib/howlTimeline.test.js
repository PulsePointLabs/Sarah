import test from 'node:test';
import assert from 'node:assert/strict';
import {howlAt,howlTimeline,howlStepPath,howlClock} from './howlTimeline.js';
test('timeline preserves zero, units, session offsets, and breaks on stale/disconnected samples',()=>{
 const rows=howlTimeline([{id:'1',time_offset_s:10,options:{power_a:0,power_b:5},raw:{options:{frequency_hz:80}},connection_state:'connected'},
 {id:'2',time_offset_s:15,connection_state:'disconnected'}, {id:'3',time_offset_s:30,options:{power_a:9},connection_state:'connected'}],5);
 assert.equal(rows[0].powerA,0);assert.equal(rows[0].fields['options.frequency_hz'],80);
 assert.equal(howlAt(rows,6).id,'1');assert.equal(howlAt(rows,11),null);assert.equal(howlAt(rows,22),null);assert.equal(howlAt(rows,4),null);
 assert.ok(howlStepPath(rows,'powerA',0,30).split('M').length===3);assert.equal(howlClock(126.5),'2:06.5');
});
