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

  for(const name of ['Channels','Cards','Add overlays to video']) {
    const trigger=page.getByRole('button',{name,exact:true});await trigger.click();
    const menu=page.getByRole('menu');await menu.waitFor();const first=menu.getByRole('menuitemcheckbox').first();await first.click();await menu.waitFor({state:'hidden'});
    await trigger.click();await page.getByRole('menu').waitFor();await page.keyboard.press('Escape');await page.getByRole('menu').waitFor({state:'hidden'});
    await trigger.click();await page.getByRole('menu').waitFor();await page.mouse.click(30,100);await page.getByRole('menu').waitFor({state:'hidden'});
  }
  for(const width of [1366,1920]){await page.setViewportSize({width,height:900});await page.getByRole('button',{name:'Cards',exact:true}).click();const rect=await page.getByRole('menu').boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=width);await page.keyboard.press('Escape');}
  assert.deepEqual(errors,[]);console.log('PASS Channels, Cards and Overlays close after selection, Escape and outside taps; menus fit viewport');
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exit(1)});
