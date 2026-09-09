import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { withManualEvidenceWorkspace, runEvidenceProcess, probeAnnotationVideo, extractNativeAnnotationFrames, mainDetailCrops, denseFeetEvidence, retainAnnotationEvidence, removeUnpersistedAnnotationEvidence, retainedEvidenceAvailable } from './manualAnnotationEvidence.js';
import { resolveMaxImageCount } from '../routes/internalAi.js';

test('explicit evidence requests retain more than twelve images without changing default',()=>{
  assert.equal(resolveMaxImageCount(35),35);assert.equal(resolveMaxImageCount(undefined),5);
});

test('isolated workspaces are removed on success, thrown failure and cancellation',async()=>{
  let directory;
  await withManualEvidenceWorkspace(async dir=>{directory=dir;await fsp.writeFile(path.join(dir,'dense.jpg'),'synthetic');});
  await assert.rejects(fsp.access(directory));
  await assert.rejects(withManualEvidenceWorkspace(async dir=>{directory=dir;throw Error('failed');}),/failed/);
  await assert.rejects(fsp.access(directory));
  const controller=new AbortController();
  await assert.rejects(withManualEvidenceWorkspace(async dir=>{
    directory=dir;
    const timer=setTimeout(()=>controller.abort(),100);
    try { await runEvidenceProcess(process.execPath,['-e','setTimeout(()=>{},30000)'],controller.signal); }
    finally { clearTimeout(timer); }
  }),/cancelled/);
  await assert.rejects(fsp.access(directory));
});

test('real 4K extraction preserves native full frame and original-detail tiles; retained evidence survives cleanup',async()=>{
  let retained, directory;
  try {
    await withManualEvidenceWorkspace(async dir=>{
      directory=dir;const sourcePath=path.join(dir,'source.mp4');
      await runEvidenceProcess('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=3840x2160:rate=2','-t','1','-c:v','libx264','-preset','ultrafast',sourcePath]);
      const source=await probeAnnotationVideo(sourcePath);
      assert.equal(source.width,3840);assert.equal(source.height,2160);
      const frames=await extractNativeAnnotationFrames({sourcePath,timesSeconds:[0,.5],directory:dir});
      const dimensions=await probeAnnotationVideo(path.join(dir,frames[0].filename));
      assert.equal(dimensions.width,3840);
      const crops=await mainDetailCrops(frames,dir,source);
      assert.equal(crops.length,9);
      const cropSize=await probeAnnotationVideo(path.join(dir,crops[0].filename));
      assert.equal(cropSize.width,1280);assert.equal(cropSize.height,720);
      retained=await retainAnnotationEvidence([{...frames[0],purpose:'annotation_mark',recordTimeSeconds:72},{...frames[1],purpose:'comparison_reference',recordTimeSeconds:67}],dir,`test-${crypto.randomUUID()}`);
    });
    await assert.rejects(fsp.access(directory));
    assert.equal(await retainedEvidenceAvailable(retained),true);
  } finally { if(retained) await removeUnpersistedAnnotationEvidence(retained); }
});

test('real 1080p dense path supplies subsecond full-field CV and ordered native context',async()=>{
  await withManualEvidenceWorkspace(async directory=>{
    const sourcePath=path.join(directory,'source.mp4');
    await runEvidenceProcess('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=1920x1080:rate=16','-t','2.2','-c:v','libx264','-preset','ultrafast',sourcePath]);
    const source=await probeAnnotationVideo(sourcePath);
    const result=await denseFeetEvidence({sourcePath,start:0,end:2,mark:1,offset:67,directory,source,invoke:async()=>({regions:[{region:'foot',side:'unresolved',confidence:'low',box:[.1,.3,.2,.3]}]})});
    assert.equal(result.motion.frame_times_s.length,17);
    assert.equal(result.motion.frame_times_s[0],67);assert.equal(result.motion.frame_times_s.at(-1),69);
    assert.equal(result.motion.width,1920);assert.equal(result.motion.sample_fps,8);
    assert.equal(result.motion.frame_metrics.length,16);
    assert.equal(result.frames[0].frameTimeSeconds,0);assert.equal(result.frames.at(-1).frameTimeSeconds,2);
    assert.ok(result.frames.every(f=>f.context==='full native frame'));
  });
});
