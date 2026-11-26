import test from 'node:test';
import assert from 'node:assert/strict';
import { fits, place, restoreLayout, overlaps,snapOverlayBox,reflowOverlay,meaningfulOverlayOverlap } from './videoOverlayLayout.js';
test('placement avoids neighbors and returns no space instead of overlapping',()=>{
 const a={x:0,y:0,w:.5,h:.5,opacity:.9};
 const b=place({...a}, {a}); assert.ok(b); assert.equal(overlaps(a,b),false);
 assert.equal(fits({...a,x:.1}, {a,b},'b'),false);
 assert.equal(place(a,{full:{x:0,y:0,w:1,h:1}}),null);
});

test('grid snaps geometry, honors readable floors and allows a precise override',()=>{
 const original={x:.103,y:.067,w:.24,h:.25,opacity:.83};
 const moved=snapOverlayBox('metric-heart-rate',original,1200,800);assert.equal(moved.x*1200,120);assert.equal(moved.y*800,48);assert.equal(moved.opacity,.83);
 const fine=snapOverlayBox('metric-heart-rate',original,1200,800,{enabled:false});assert.equal(fine.x,original.x);
 const resized=snapOverlayBox('phase',{...original,w:.1,h:.1},1200,800,{mode:'resize'});assert.ok(resized.w*1200>=360&&resized.h*800>=340);assert.equal(resized.h*800%24,0);
});

test('edge wiggle does not move neighbors; deliberate overlaps move them to a nearby grid position',()=>{
 const boxes={a:{x:0,y:0,w:.2,h:.4,opacity:.9},b:{x:.2,y:0,w:.2,h:.4,opacity:.8}};
 const options={width:1200,height:800,gridPx:24};
 assert.equal(meaningfulOverlayOverlap({...boxes.a,x:.01},boxes.b,options),false);
 const shallow=reflowOverlay(boxes,'a',{x:.01},options);assert.deepEqual(shallow.b,boxes.b);
 const deep=reflowOverlay(boxes,'a',{x:.08},options);assert.notEqual(deep.b.x,boxes.b.x);assert.equal(overlaps(deep.a,deep.b),false);assert.ok(Math.abs(deep.b.x*1200/24-Math.round(deep.b.x*1200/24))<1e-8);assert.equal(deep.b.w,boxes.b.w);
});
test('legacy overlapping layouts restore every selected overlay without collisions',()=>{
 const boxes=Object.fromEntries(Array.from({length:12},(_,i)=>[String(i),{x:.1,y:.1,w:.48,h:.4,opacity:.7}]));
 const restored=restoreLayout(boxes), values=Object.values(restored);
 assert.equal(values.length,12);
 for(let i=0;i<values.length;i++)for(let j=i+1;j<values.length;j++)assert.equal(overlaps(values[i],values[j]),false);
 assert.ok(values.every(b=>b.opacity===.7&&b.x+b.w<=1&&b.y+b.h<=1));
});
