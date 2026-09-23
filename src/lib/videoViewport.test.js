import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_VIDEO_VIEW,changeVideoView} from './videoViewport.js';
test('zoom and pan are bounded and returning to normal recenters',()=>{
  let view=changeVideoView(DEFAULT_VIDEO_VIEW,'+');
  assert.equal(view.zoom,1.25);
  for(let i=0;i<100;i++)view=changeVideoView(view,'ArrowLeft');
  assert.equal(view.x,12.5);
  assert.deepEqual(changeVideoView(view,'-'),DEFAULT_VIDEO_VIEW);
  for(let i=0;i<100;i++)view=changeVideoView(view,'+');
  assert.equal(view.zoom,8);
  assert.deepEqual(changeVideoView(DEFAULT_VIDEO_VIEW,'-'),DEFAULT_VIDEO_VIEW);
});
