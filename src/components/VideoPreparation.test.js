import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {buildSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);
function bundle(file,extras={}) {
 const code=buildSync({entryPoints:[fileURLToPath(new URL(file,import.meta.url))],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',mainFields:['module','main'],alias:{'@':fileURLToPath(new URL('../',import.meta.url))},define:{'import.meta.env':'{}'},external:['react','react-dom','recharts']}).outputFiles[0].text;
 const module={exports:{}};
 vm.runInNewContext(code,{module,exports:module.exports,require,console,process,URL,URLSearchParams,AbortController,DOMException,setTimeout,clearTimeout,window:{location:{origin:'http://localhost',hostname:'localhost',search:''},setTimeout,clearTimeout,addEventListener(){},removeEventListener(){}},...extras});
 return module.exports;
}
test('visible conversion status includes percent, ETA, stalled status and queue position',()=>{
 const Card=bundle('./PlaybackPreparationStatus.jsx').default;
 const html=renderToStaticMarkup(React.createElement(Card,{filename:'test.mkv',progress:{stage:'Converting with CPU',percent:25,encodedSeconds:25,durationSeconds:100,speed:2,etaSeconds:37,elapsedSeconds:15,secondsSinceProgress:40,fallback:true}}));
 assert.match(html,/MP4 conversion progress/);assert.match(html,/25%/);assert.match(html,/remaining/);assert.match(html,/may be stalled/);
});
test('original source manager exposes host browser and camera labels',()=>{
 const Manager=bundle('./LinkedLocalVideoManager.jsx').default;
 const html=renderToStaticMarkup(React.createElement(Manager,{videos:[],onChange(){}}));
 assert.match(html,/Browse Windows recordings/);assert.match(html,/Camera label/);assert.match(html,/Link Video/);
});
test('conversion client stops on explicit encoder failure instead of retrying',async()=>{
 let calls=0;
 const {base44}=bundle('../api/base44Client.js',{fetch:async()=>{calls++;return{ok:false,status:500,headers:{get:()=> 'application/json'},json:async()=>({code:'PLAYBACK_CONVERSION_FAILED',error:'Invalid video'})};}});
 await assert.rejects(base44.integrations.Core.ConvertLocalVideoForPlayback({path:'E:/broken.mkv'}),/Invalid video/);
 assert.equal(calls,1);
});

test('video recovery exposes change location and clear link for the original',()=>{
 const Recovery=bundle('./VideoLinkRecovery.jsx').default;
 const html=renderToStaticMarkup(React.createElement(Recovery,{video:{id:'v',path:'E:/old.mkv'},videos:[],onChange(){}}));
 assert.match(html,/Change location/);assert.match(html,/Clear link/);
});

test('camera card recovery uses Change video and Clear video labels',()=>{
 const Recovery=bundle('./VideoLinkRecovery.jsx').default;
 const html=renderToStaticMarkup(React.createElement(Recovery,{cameraCard:true,video:{id:'v',path:'E:/old.mkv'},videos:[],onChange(){}}));
 assert.match(html,/Change video/);assert.match(html,/Clear video/);
});
