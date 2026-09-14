import test from 'node:test';
import assert from 'node:assert/strict';
import {relocateLinkedVideo} from './linkedVideoLocation.js';
test('relocation preserves camera, ID, offset and prior metadata without adding another entry',()=>{
 const original={id:'feet',path:'E:/old.mkv',label:'Feet',cameraRole:'lower_body',timelineOffsetSeconds:12,linkedAt:'original'};
 const other={id:'main',path:'E:/main.mkv'};
 const result=relocateLinkedVideo([original,other],original,{path:'D:/moved.mkv',filename:'moved.mkv',fingerprint:'same'});
 assert.equal(result.length,2);assert.equal(result[0].id,'feet');assert.equal(result[0].cameraRole,'lower_body');assert.equal(result[0].timelineOffsetSeconds,12);assert.equal(result[0].label,'Feet');assert.deepEqual(result[0].previousPaths,['E:/old.mkv']);assert.equal(result[1],other);assert.equal(original.path,'E:/old.mkv');
 assert.throws(()=>relocateLinkedVideo([original,other],original,{path:other.path}),/already linked/);
});
