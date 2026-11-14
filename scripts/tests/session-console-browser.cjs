const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');let pw;try{pw=require('playwright');}catch{pw=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}const {chromium}=pw;
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width:1366,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5175/scripts/tests/fixtures/session-console.html');
 await page.getByRole('heading',{name:'NOT RECORDING'}).waitFor();assert.equal(await page.locator('.civet-live-alert').count(),0);
 await page.getByRole('button',{name:/Body exploration/}).click();await page.getByLabel('Session title').fill('Procedure observation');await page.getByLabel('Session notes').fill('Initial notes');
 await page.getByRole('button',{name:'Start session + OBS recording'}).click();await page.getByRole('heading',{name:'RECORDING · OBS'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.started),{kind:'body_exploration',title:'Procedure observation',notes:'Initial notes'});
 await page.getByRole('button',{name:'Save session details'}).click();assert.equal((await page.evaluate(()=>window.saved)).notes,'Initial notes');
 assert.equal(await page.getByRole('button',{name:/Sexual session/}).isDisabled(),true);
 await page.evaluate(()=>window.pause());await page.getByRole('heading',{name:'PAUSED · OBS'}).waitFor();
 await page.evaluate(()=>window.stop());await page.getByRole('heading',{name:'NOT RECORDING'}).waitFor();
 await page.getByLabel('Use CIVET pelvic pressure for this session').check();assert.equal(await page.locator('.civet-live-alert').count(),0);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:'logs/session-console-mobile.png'});assert.deepEqual(errors,[]);console.log('PASS recording truth, type choice, title/notes, save, pause, unused/stale CIVET, mobile width');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
