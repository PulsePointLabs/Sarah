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

test('graph data excludes command parameters and explicitly breaks stale observations',async()=>{
 const {howlGraphData,HOWL_GRAPH_GROUPS}=await import('./howlTimeline.js');
 const points=howlTimeline([{id:'c',time_offset_s:0,connection_state:'command',raw:{command:{frequency_hz:0}}},
 {id:'a',time_offset_s:1,connection_state:'connected',options:{power_a:5,power_b:0}},
 {id:'b',time_offset_s:20,connection_state:'connected',options:{power_a:8,power_b:1}}]);
 const graph=howlGraphData(points);
 assert.equal(graph[0].t,1);assert.equal(graph.find(p=>p.t===7.001).powerA,null);
 assert.equal(graph[0].powerB,0);
 const groups=HOWL_GRAPH_GROUPS.filter(g=>g.lines.some(([k])=>graph.some(p=>p[k]!=null)));
 assert.deepEqual(groups.map(g=>g.key),['power']);
});

test('legacy power snapshots have only their recorded times and no inferred Hz or intervening levels',async()=>{
 const {howlCommandGraphData}=await import('./howlTimeline.js');
 const points=howlTimeline([{id:'a',time_offset_s:158,connection_state:'command',raw:{command:{intensity_a:6,intensity_b:0,frequency_hz:20,controller:{rmssd:106.4}}}},
 {id:'b',time_offset_s:276,connection_state:'command',raw:{command:{intensity_a:14,intensity_b:43}}}]);
 assert.deepEqual(howlCommandGraphData(points),[{t:158,powerA:6,powerB:0},{t:276,powerA:14,powerB:43}]);
});
