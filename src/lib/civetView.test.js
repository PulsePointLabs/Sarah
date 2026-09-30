import test from 'node:test';
import assert from 'node:assert/strict';
import {civetView} from './civetView.js';
test('trimmed views align pressure and events with HR/video without changing source times',()=>{
 const e={id:'live-1',onset:11,peak:12,end:13,trough:13,confirmed_at:13.3,peak_timestamp_ms:112000};
 const data={samples:[{t:9,events:[]},{t:12,pressure_kpa:3,events:[]},{t:13.3,events:[e]},{t:21,events:[]}],analysis:{live:{events:[e]},review:{events:[{...e,mode:'review'}],rows:[{t:12,pressure_kpa:3}]},reprocessed:{events:[{...e,mode:'reprocessed'}],rows:[{t:12,pressure_kpa:3,events:[e]}]}}};
 const original=JSON.stringify(data),view=civetView(data,{start_s:10,end_s:20});
 assert.deepEqual(view.samples.map(r=>r.t),[2,3.3000000000000007]);
 assert.equal(view.analysis.live.events[0].peak,2);assert.equal(view.analysis.live.events[0].peak_timestamp_ms,112000);
 assert.equal(view.analysis.review.rows[0].t,2);assert.equal(view.analysis.view_offset_s,10);
 assert.equal(view.analysis.reprocessed.rows[0].t,2);assert.equal(view.analysis.reprocessed.events[0].peak,2);
 assert.equal(JSON.stringify(data),original);assert.equal(civetView(data,null),data);
});
