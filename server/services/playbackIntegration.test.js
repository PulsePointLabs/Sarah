import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import express from 'express';
test('real file API browses host originals, converts a clip, exposes progress, and preserves failures until retry',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sarah-preview-test-'));
 process.env.UPLOAD_DIR=path.join(dir,'output');
 let server;
 try {
  const source=path.join(dir,'test.mkv');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=10','-t','2','-c:v','libx264',source],{windowsHide:true});
  const {filesRouter}=await import('../routes/files.js');
  const app=express();app.use(express.json());app.use(filesRouter);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const post=async(route,body)=>{const res=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:res.status,data:await res.json()};};
  const missing=await post('/local-video/playback-preview',{path:path.join(dir,'moved.mkv')});
  assert.equal(missing.status,404);assert.equal(missing.data.code,'SOURCE_VIDEO_MISSING');
  const listing=await post('/local-video/directory',{path:dir});assert.ok(listing.data.entries.some(e=>e.path===source));
  assert.equal((await post('/local-video/directory',{path:'sftp://host/E:/'})).status,400);
  let result=await post('/local-video/playback-preview',{path:source});assert.equal(result.status,202);assert.ok(result.data.progress.stage);
  for(let i=0;i<80&&result.status===202;i++){await new Promise(r=>setTimeout(r,100));result=await post('/local-video/playback-preview',{path:source});}
  assert.equal(result.status,200);assert.match(result.data.url,/\.mp4$/);
  const bad=path.join(dir,'broken.mkv');await writeFile(bad,'not a video');
  result=await post('/local-video/playback-preview',{path:bad});
  for(let i=0;i<80&&result.status===202;i++){await new Promise(r=>setTimeout(r,100));result=await post('/local-video/playback-preview',{path:bad});}
  assert.equal(result.data.code,'PLAYBACK_CONVERSION_FAILED');
  assert.equal((await post('/local-video/playback-preview',{path:bad})).data.code,'PLAYBACK_CONVERSION_FAILED');
 }finally{
  if(server)await new Promise(r=>server.close(r));
  if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('sarah-preview-test-'))throw Error('Unexpected cleanup path');
  await rm(dir,{recursive:true,force:true});
 }
});
