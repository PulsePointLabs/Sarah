const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
require('node:fs').mkdirSync('logs',{recursive:true});
let pw;try{pw=require('playwright');}catch{pw=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
(async()=>{const browser=await pw.chromium.launch({...process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{channel:'chrome'},headless:true});try{
  const page=await browser.newPage({viewport:{width:1920,height:1080}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('sarah.videoSync.sectionWeights.v4',JSON.stringify({civet:99999})));
  await page.route('**/api/**',async route=>{const url=route.request().url();if(url.includes('/src/'))return route.continue();return route.fulfill({json:url.includes('/civet/session/')?await page.evaluate(()=>window.civetFixture):[]});});
  await page.goto('http://127.0.0.1:5175/scripts/tests/fixtures/video-sidebar-resize.html');
  const bytes=await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
    const context=canvas.getContext('2d');context.fillStyle='#156e75';context.fillRect(0,0,640,360);
    const stream=canvas.captureStream(10),recorder=new MediaRecorder(stream),chunks=[];
    recorder.ondataavailable=event=>chunks.push(event.data);const done=new Promise(resolve=>recorder.onstop=resolve);
    recorder.start();await new Promise(resolve=>setTimeout(resolve,350));recorder.stop();await done;
    stream.getTracks().forEach(track=>track.stop());return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  });
  const fixtureVideo={name:'sidebar-fixture.webm',mimeType:'video/webm',buffer:Buffer.from(bytes)};
  await page.locator('input[type=file][accept="video/*"]').first().setInputFiles(fixtureVideo);
  await page.getByRole('button',{name:'Full Telemetry',exact:true}).click();
  const sidebar=page.locator('.video-resizable-sidebar');
  await page.locator('[data-video-section=civet]').waitFor();
  await page.locator('[data-camera] video').first().evaluate(video=>{video.currentTime=20;});
  const sizes=()=>page.locator('[data-video-section]').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>[n.dataset.videoSection,n.getBoundingClientRect().height])));
  const fits=async()=>{
    await page.waitForTimeout(150);
    assert.ok(await sidebar.evaluate(el=>el.scrollHeight<=el.clientHeight+2),'sidebar never needs scrolling');
    const issues=await page.locator('[data-video-section]').evaluateAll(nodes=>nodes.flatMap(n=>{
      const content=n.firstElementChild,card=content.firstElementChild,box=n.getBoundingClientRect();
      return box.bottom>innerHeight+1||content.scrollWidth>content.clientWidth+2||content.scrollHeight>content.clientHeight+2||card.scrollHeight>card.clientHeight+2?[{id:n.dataset.videoSection,content:content.scrollHeight-content.clientHeight,card:card.scrollHeight-card.clientHeight,bottom:box.bottom}]:[];
    }));
    assert.deepEqual(issues,[],'all selected cards fit without clipped content');
    assert.deepEqual(await sidebar.locator('.telemetry-metric-card').evaluateAll(nodes=>nodes.filter(n=>n.scrollHeight>n.clientHeight+2||n.scrollWidth>n.clientWidth+2).map(n=>n.title)),[],'vital values, units and deltas fit inside their cells');
    for(const selector of ['[data-video-section=civet] svg','[data-video-section=phase] svg']){
      assert.ok(await page.locator(selector).evaluate(svg=>{const box=svg.getBoundingClientRect(),view=svg.viewBox.baseVal;return Math.abs(box.width-view.width)<1&&Math.abs(box.height-view.height)<1;}),'SVG coordinates use actual pixels; labels are not distorted');
    }
  };
  for(const viewport of [{width:1920,height:1080},{width:1536,height:864},{width:1280,height:720}]){
    await page.setViewportSize(viewport);await fits();
    assert.equal(await page.locator('[data-video-section]').count(),6);
    const initial=await sizes();
    assert.ok(initial.metrics<initial.phase,'vital row starts shorter');
    assert.ok(Math.abs(initial.phase-initial.civet)<1,'graph cards start equal');
    assert.ok(Math.abs(initial.cardiac-initial.autonomic)<1);
    await page.screenshot({path:`logs/video-sidebar-fit-${viewport.height}.png`});
  }
  await page.setViewportSize({width:1920,height:1080});await fits();
  const widthHandle=page.getByRole('separator',{name:'Resize telemetry sidebar',exact:true});
  await widthHandle.focus();await page.keyboard.press('Home');await fits();
  const pressureHandle=page.getByRole('separator',{name:'Resize Pelvic response height',exact:true});
  await pressureHandle.focus();await page.keyboard.press('End');await fits();
  assert.ok((await sizes()).civet<=360);
  for(let i=0;i<40;i++)await page.keyboard.press('ArrowDown');await fits();
  await pressureHandle.focus();await page.keyboard.press('Home');await fits();
  const box=await pressureHandle.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+4);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y+50,{steps:5});await page.mouse.up();await fits();
  const metricsHandle=page.getByRole('separator',{name:'Resize Vital signs height'});
  const metric=sidebar.locator('.monitor-metric-value').first();
  const fontBefore=await metric.evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
  await metricsHandle.focus();for(let i=0;i<10;i++)await page.keyboard.press('ArrowDown');await fits();
  assert.ok(await metric.evaluate(el=>parseFloat(getComputedStyle(el).fontSize))>fontBefore,'vital text increases when the card is made taller');
  const picker=page.getByLabel('Sidebar cards',{exact:true});await picker.click();
  const menu=page.getByRole('group',{name:'Visible sidebar cards'});
  const beforeHide=await sizes();await menu.getByRole('checkbox',{name:'Pelvic response',exact:true}).uncheck();
  const afterHide=await sizes();for(const id of Object.keys(afterHide))assert.ok(afterHide[id]<=beforeHide[id]+2,'hiding cards does not stretch the rest');
  for(const checkbox of await menu.getByRole('checkbox').all())await checkbox.uncheck();
  assert.equal(await page.locator('[data-video-section]').count(),0,'every card can be hidden');
  await menu.getByRole('checkbox',{name:'Cardiac trend',exact:true}).check();
  assert.ok((await sizes()).cardiac<=360,'single remaining card cannot fill the screen');
  for(const checkbox of await menu.getByRole('checkbox').all())await checkbox.check();await picker.click();await fits();
  await page.locator('.video-overlay-picker summary').click();await page.locator('.video-overlay-picker').getByRole('button',{name:/Vital signs/}).click();
  await page.mouse.move(100,100);await page.keyboard.press('h');
  assert.equal(await sidebar.isVisible(),false);assert.equal(await page.locator('[data-video-overlay=metrics]').isVisible(),true);
  const playback=page.getByLabel('Video playback controls');
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('[aria-label="Video playback controls"]')).opacity==='0');
  await page.mouse.move(900,1060);await page.waitForFunction(()=>getComputedStyle(document.querySelector('[aria-label="Video playback controls"]')).opacity==='1');
  assert.equal(await playback.getByRole('group',{name:'Telemetry window'}).count(),1);
  await page.keyboard.press('Escape');assert.equal(await sidebar.isVisible(),true);
  assert.equal(await page.locator('[data-camera] video').first().evaluate(el=>getComputedStyle(el).objectFit),'contain');
  await page.setViewportSize({width:1280,height:720});
  await page.goto('http://127.0.0.1:5175/scripts/tests/fixtures/video-sidebar-resize.html?missingPressure=1');
  await page.locator('input[type=file][accept="video/*"]').first().setInputFiles(fixtureVideo);
  await page.getByRole('button',{name:'Full Telemetry',exact:true}).click();
  await sidebar.getByText('No current pressure sample',{exact:true}).waitFor();await fits();
  assert.deepEqual(errors,[]);
  console.log('PASS viewport-fitted equal graph cards, short scalable vitals, dropdown toggles, bounded resizing, no hidden-card inflation, pressure/phase pixel axes, overlays and video-only hover controls');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
