import test from 'node:test';
import assert from 'node:assert/strict';
import { fits, place, restoreLayout, overlaps } from './videoOverlayLayout.js';
test('placement avoids neighbors and returns no space instead of overlapping',()=>{
 const a={x:0,y:0,w:.5,h:.5,opacity:.9};
 const b=place({...a}, {a}); assert.ok(b); assert.equal(overlaps(a,b),false);
 assert.equal(fits({...a,x:.1}, {a,b},'b'),false);
 assert.equal(place(a,{full:{x:0,y:0,w:1,h:1}}),null);
});
test('legacy overlapping layouts restore every selected overlay without collisions',()=>{
 const boxes=Object.fromEntries(Array.from({length:12},(_,i)=>[String(i),{x:.1,y:.1,w:.48,h:.4,opacity:.7}]));
 const restored=restoreLayout(boxes), values=Object.values(restored);
 assert.equal(values.length,12);
 for(let i=0;i<values.length;i++)for(let j=i+1;j<values.length;j++)assert.equal(overlaps(values[i],values[j]),false);
 assert.ok(values.every(b=>b.opacity===.7&&b.x+b.w<=1&&b.y+b.h<=1));
});
