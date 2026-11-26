const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const KEY='sarah.videoSync.overlays.v1';
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const p=await browser.newPage({viewport:{width:1920,height:1080},hasTouch:true}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 const original={cardiac:{x:.02,y:.04,w:.42,h:.30,opacity:.85},phase:{x:.03,y:.49,w:.4,h:.4,opacity:.92},'metric-heart-rate':{x:.65,y:.10,w:.25,h:.28,opacity:.9},autonomic:{x:.53,y:.58,w:.44,h:.33,opacity:.8}};
 await p.addInitScript(value=>{if(!localStorage.getItem('overlay-seeded')){localStorage.setItem('sarah.videoSync.overlays.v1',JSON.stringify(value));localStorage.setItem('overlay-seeded','yes');}},original);
 await p.route('**/api/**',r=>r.request().url().includes('/src/')?r.continue():r.fulfill({json:[]}));
 const load=async()=>{await p.locator('input[type=file][accept*="video"]').first().setInputFiles('logs/two-angle-test.mp4');await p.getByRole('button',{name:'Full Telemetry',exact:true}).click();await p.locator('[data-video-overlay=phase]').waitFor();};
 const profile=()=>p.evaluate(key=>JSON.parse(localStorage.getItem(key)),KEY);
 await p.goto('http://127.0.0.1:5175/scripts/tests/fixtures/video-overlay-sessions.html');await load();assert.deepEqual(await profile(),original,'mounting and fitting never overwrite preferred geometry');
 const phase=p.locator('[data-video-overlay=phase]'),cardiac=p.locator('[data-video-overlay=cardiac]'),heart=p.locator('[data-video-overlay=metric-heart-rate]');
 await heart.getByRole('button',{name:'Move Heart Rate overlay',exact:true}).click();assert.deepEqual(await profile(),original,'clicking a header does not move or save a fitted box');await phase.getByRole('button',{name:'Color cue on',exact:true}).click();await cardiac.getByRole('button',{name:'Phase bands on',exact:true}).click();
 await p.getByLabel('Video playback controls',{exact:true}).getByRole('button',{name:'5m',exact:true}).click();await p.keyboard.press('h');await p.waitForTimeout(180);assert.equal(await p.locator('.video-full-header').isVisible(),false);
 assert.deepEqual(await profile(),original,'entering video-only does not refit saved boxes');
 // Neighbors remain stationary during the drag; the dragged card itself snaps.
 const layer=p.locator('.video-overlay-layer'),area=await layer.boundingBox(),beforeNeighbor=await cardiac.boundingBox();
 const handle=heart.getByRole('button',{name:'Move Heart Rate overlay',exact:true}),rect=await handle.boundingBox();
 await p.mouse.move(rect.x+20,rect.y+12);await p.mouse.down();await p.mouse.move(area.x+area.width*.15,area.y+area.height*.15,{steps:10});
 assert.ok(await p.locator('.video-overlay-snap-grid').isVisible());assert.equal((await cardiac.boundingBox()).x,beforeNeighbor.x);assert.deepEqual(await profile(),original,'drag previews are not persisted');await p.mouse.up();await p.waitForTimeout(180);
 const saved=await profile(),box=saved['metric-heart-rate'];assert.ok(Math.abs(box.x*area.width/24-Math.round(box.x*area.width/24))<.001);assert.ok(Math.abs(box.y*area.height/24-Math.round(box.y*area.height/24))<.001);
 await p.keyboard.press('h');assert.equal(await p.locator('.video-full-header').isVisible(),true,'H still works after dragging a header');await p.keyboard.press('h');
 // Resize, transparency and preferred geometry survive a narrow viewport round-trip.
 const resize=await heart.getByRole('button',{name:'Resize Heart Rate overlay',exact:true}).boundingBox();await p.mouse.move(resize.x+5,resize.y+5);await p.mouse.down();await p.mouse.move(resize.x+65,resize.y+53,{steps:8});await p.mouse.up();await heart.focus();await p.keyboard.press('+');const persisted=await profile();assert.equal(persisted['metric-heart-rate'].opacity,.85);
 await p.setViewportSize({width:980,height:640});await p.waitForTimeout(200);assert.deepEqual(await profile(),persisted);await p.setViewportSize({width:1920,height:1080});await p.waitForTimeout(200);assert.deepEqual(await profile(),persisted);
 await p.screenshot({path:'logs/video-overlays-monitor-320.png'});
 // A new record remounts the player; data changes, while the shared overlay profile does not.
 await p.evaluate(()=>window.overlaySessionFixture.switchRecord());await load();await p.waitForTimeout(180);assert.deepEqual(await profile(),persisted);assert.equal(await p.locator('.video-full-header').isVisible(),false,'hide-controls preference survives session selection');
 await phase.getByRole('button',{name:'Color cue off',exact:true}).waitFor();await cardiac.getByRole('button',{name:'Phase bands off',exact:true}).waitFor();await p.locator('[data-video-overlay=autonomic] .video-overlay-empty').waitFor();assert.match(await heart.locator('.monitor-metric-value').innerText(),/110/,'new session readings replace old readings');
 await p.keyboard.press('h');assert.equal(await p.getByLabel('Video playback controls',{exact:true}).getByRole('button',{name:'5m',exact:true}).getAttribute('aria-pressed'),'true');
 await p.getByRole('button',{name:'Add overlays to video',exact:true}).click();await p.getByRole('menuitemcheckbox',{name:'Snap to grid',exact:true}).click();assert.equal(await p.evaluate(()=>JSON.parse(localStorage.getItem('sarah.videoSync.overlayOptions.v1')).snap),false);
 await p.reload();await load();await p.getByRole('button',{name:'Add overlays to video',exact:true}).click();assert.equal(await p.getByRole('menuitemcheckbox',{name:'Snap to grid',exact:true}).getAttribute('aria-checked'),'false');await p.keyboard.press('Escape');assert.deepEqual(await profile(),persisted);
 assert.deepEqual(errors,[]);console.log('PASS session/reload/viewport persistence, card options, hide mode, missing-data placeholders, snapped drag/resize, stable previews and snap preference');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
