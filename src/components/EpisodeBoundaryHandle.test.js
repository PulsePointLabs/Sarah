import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import vm from 'node:vm';
const code = buildSync({entryPoints:['src/components/EpisodeBoundaryHandle.jsx'],bundle:true,write:false,format:'cjs',platform:'node',external:['react'],jsx:'automatic'}).outputFiles[0].text;
function handle() {
 const module={exports:{}};
 vm.runInNewContext(code,{module,exports:module.exports,require:()=>({useRef:(v)=>({current:v}),jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}),DOMPoint:class {constructor(x,y){this.x=x;this.y=y;} matrixTransform(){return this;}}});
 const previews=[],commits=[]; let paused=0,captured=0;
 const node=module.exports.default({x1:50,y1:100,y2:0,stroke:'purple',episode:{id:'n',start_s:10,end_s:20},boundary:'start_s',domain:[0,30],onPreview:v=>previews.push(v),onCommit:(...args)=>commits.push(args),onStart:()=>paused++});
 const target={ownerSVGElement:{getScreenCTM:()=>({inverse:()=>({})}),querySelector:()=>({getBBox:()=>({width:300})})},setPointerCapture:()=>captured++,releasePointerCapture:()=>captured--};
 const event=(x)=>({button:0,clientX:x,clientY:0,pointerId:1,currentTarget:target,preventDefault(){},stopPropagation(){}});
 return {p:node.props,event,previews,commits,state:()=>({paused,captured})};
}
test('drag uses plot width, previews without saving and commits once on release',()=>{
 const h=handle(); h.p.onPointerDown(h.event(100)); h.p.onPointerMove(h.event(130));
 assert.equal(h.previews.at(-1).time,13); assert.equal(h.commits.length,0);
 h.p.onPointerUp(h.event(150)); assert.equal(h.commits.length,1); assert.deepEqual(h.commits[0],['n','start_s',15]);
 assert.equal(h.previews.at(-1),null); assert.deepEqual(h.state(),{paused:1,captured:0});
});
test('cancel discards draft and dragging beyond end cannot invert episode',()=>{
 const h=handle();h.p.onPointerDown(h.event(100));h.p.onPointerMove(h.event(500));
 assert.equal(h.previews.at(-1).time,19.9);h.p.onPointerCancel();h.p.onPointerUp(h.event(500));
 assert.equal(h.commits.length,0);assert.equal(h.previews.at(-1),null);
});
