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


  await page.evaluate(()=>localStorage.setItem('sarah.videoSync.overlays.v1',JSON.stringify({'metric-heart-rate':{x:0,y:.05,w:.24,h:.25,opacity:.9},'metric-sdnn':{x:.4,y:.05,w:.24,h:.25,opacity:.9}})));
  await page.reload();await page.locator('input[type=file][accept="video/*"]').first().setInputFiles(fixtureVideo);await page.getByRole('button',{name:'Full Telemetry',exact:true}).click();
  const overlay=page.locator('[data-video-overlay="metric-heart-rate"]');await overlay.waitFor();
  const bounds=await overlay.evaluate(el=>{const b=el.parentElement.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height};});
  const drag=async(dx,dy,across=false)=>{const b=await overlay.boundingBox();const x=b.x+15,y=b.y+15;await page.keyboard.down('Control');await page.mouse.move(x,y);await page.mouse.down();if(across)await page.mouse.move(x+dx,y,{steps:10});await page.mouse.move(x+dx,y+dy,{steps:10});await page.mouse.up();await page.keyboard.up('Control');};
  await drag(bounds.w*.4,bounds.h*.5,true);let saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('sarah.videoSync.overlays.v1')));assert.ok(Math.abs(saved['metric-heart-rate'].x-.4)<.01);assert.ok(Math.abs(saved['metric-heart-rate'].y-.55)<.01,'card crosses occupied neighbor to free destination');
  await drag(0,-bounds.h*.5);saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('sarah.videoSync.overlays.v1')));assert.ok(Math.abs(saved['metric-heart-rate'].y-.55)<.01,'overlapping drop rejected');
  const before=await overlay.locator('.monitor-metric-value').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));const handle=await page.getByLabel('Resize Heart Rate overlay').boundingBox();await page.mouse.move(handle.x+5,handle.y+5);await page.mouse.down();await page.mouse.move(handle.x+85,handle.y+55,{steps:8});await page.mouse.up();const after=await overlay.locator('.monitor-metric-value').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));assert.ok(after>before,'resized card uses larger text');
  const popupEvent=page.waitForEvent('popup');await page.getByRole('button',{name:'Dual monitors',exact:true}).click();const popup=await popupEvent;await popup.getByRole('button',{name:'Add overlays to video',exact:true}).click();await popup.getByRole('menu').waitFor();assert.equal(await page.getByRole('menu').count(),0,'menu belongs to detached document');await popup.keyboard.press('Escape');await popup.getByRole('menu').waitFor({state:'hidden'});await popup.close();assert.deepEqual(errors,[]);console.log('PASS unrestricted overlay drag path, rejected overlap at drop, growing metric text, detached-document menu and Escape');
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exit(1)});
