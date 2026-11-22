const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});try{
 const p=await browser.newPage({viewport:{width:1920,height:1080}}),errors=[],saved=[];p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(()=>{window.reviewFixtureEvents=[{event_id:'past',time_s:0,note:'Current observation',category:['other']},{event_id:'future',time_s:60,note:'Upcoming observation',category:['other']}];});
 await p.route('**/api/**',route=>{
  const req=route.request(),u=req.url();if(u.includes('/src/'))return route.continue();
  if(u.endsWith('/functions/whisperSTT'))return route.fulfill({json:{text:'Cleaning feet. And footrests.'}});
  if(req.method()==='PATCH'){saved.push(req.postDataJSON());return route.fulfill({json:req.postDataJSON()});}
  return route.fulfill({json:[]});
 });
 await p.goto('http://127.0.0.1:5175/scripts/tests/fixtures/video-sidebar-resize.html');await p.locator('input[type=file][accept*="video"]').first().setInputFiles('logs/two-angle-test.mp4');await p.getByRole('button',{name:'Full Telemetry',exact:true}).click();
 const video=p.locator('[data-camera=composite] video');await video.click();
 await p.keyboard.press('m');const dialog=p.getByRole('dialog').filter({has:p.getByPlaceholder('Describe the event… or tap mic to dictate')});await dialog.waitFor();
 await dialog.getByRole('button',{name:'Stop dictation',exact:true}).waitFor();const draft=dialog.getByPlaceholder('Describe the event… or tap mic to dictate');await draft.fill('Typed context.');await p.waitForTimeout(400);await dialog.getByRole('button',{name:'Stop dictation',exact:true}).click();
 await p.waitForFunction(()=>document.querySelector('.video-event-editor textarea')?.value.includes('Cleaning feet and footrests.'));
 assert.ok((await draft.inputValue()).startsWith('Typed context.'));assert.equal(saved.length,0,'dictation stays in the writable draft');
 assert.ok(await dialog.evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight+1&&Number(getComputedStyle(e).zIndex)>11000;}));
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await video.click();await p.keyboard.press('h');await p.waitForTimeout(160);
 const controls=p.getByLabel('Video playback controls',{exact:true});assert.equal(await controls.evaluate(e=>getComputedStyle(e).opacity),'0');await video.click();await p.waitForTimeout(150);assert.equal(await controls.evaluate(e=>getComputedStyle(e).opacity),'1');await p.keyboard.press('Digit3');assert.equal(await video.evaluate(v=>v.playbackRate),3);
 await video.click();await p.waitForTimeout(150);assert.equal(await controls.evaluate(e=>getComputedStyle(e).opacity),'0');await p.keyboard.press('h');
 assert.ok((await p.getByRole('article',{name:'Current Event',exact:true}).innerText()).includes('HR'));
 const add=async name=>{await p.getByRole('button',{name:'Add overlays to video',exact:true}).click();await p.getByRole('menuitemcheckbox',{name,exact:true}).click();};
 await add('Phase evidence');await add('Cardiac trend');const phase=p.locator('[data-video-overlay=phase]'),cardiac=p.locator('[data-video-overlay=cardiac]');await phase.waitFor();
 const old=await cardiac.boundingBox(),handle=await p.getByRole('button',{name:'Move Phase evidence overlay',exact:true}).boundingBox();await p.mouse.move(handle.x+20,handle.y+10);await p.mouse.down();await p.mouse.move(old.x+old.width/2,old.y+20,{steps:10});await p.mouse.up();await p.waitForTimeout(200);
 const moved=await phase.boundingBox();assert.ok(moved.width>=359&&moved.height>=299);
 const fit=await phase.evaluate(e=>{const c=e.querySelector('.video-overlay-content'),svg=e.querySelector('svg[role=img]'),r=c.getBoundingClientRect(),s=svg.getBoundingClientRect();return {scroll:c.scrollHeight>c.clientHeight+2||c.scrollWidth>c.clientWidth+2,graphFits:s.bottom<=r.bottom+1&&s.top>=r.top-1,font:Math.min(...[...c.querySelectorAll('p,span,h3,button,summary')].filter(n=>n.getClientRects().length).map(n=>parseFloat(getComputedStyle(n).fontSize)))};});assert.equal(fit.scroll,false);assert.equal(fit.graphFits,true);assert.ok(fit.font>=16,JSON.stringify(fit));
 await p.getByRole('button',{name:'Expand Phase evidence overlay',exact:true}).click();await p.getByRole('dialog',{name:'Phase evidence breakout',exact:true}).waitFor();await p.getByRole('button',{name:'Close expanded card',exact:true}).click();await phase.getByRole('button',{name:'Evidence & key moments',exact:true}).click();await p.getByRole('dialog',{name:'Phase evidence details',exact:true}).waitFor();await p.getByRole('button',{name:'Close evidence',exact:true}).click();
 const sidebarFit=await p.locator('[data-video-section=phase] .video-phase-card').evaluate(e=>({height:e.clientHeight,scroll:e.scrollHeight,children:[...e.children].filter(c=>c.tagName!=='DETAILS').every(c=>c.getBoundingClientRect().bottom<=e.getBoundingClientRect().bottom+1)}));assert.ok(sidebarFit.children&&sidebarFit.scroll<=sidebarFit.height+2,JSON.stringify(sidebarFit));const plotFill=await p.locator('[data-video-section=phase] svg[role=img]').evaluate(e=>Math.max(...[...e.querySelectorAll('path')].map(p=>p.getBBox().height))/e.clientHeight);assert.ok(plotFill>.3,`phase plot uses its height: ${plotFill}`);await p.screenshot({path:'logs/video-review-316.png'});assert.deepEqual(errors,[]);console.log('PASS M opens writable dictation dialog; transcript punctuation/draft preserved; click toggles hidden playback controls; event-time metrics; readable free overlays/reflow and breakout');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
