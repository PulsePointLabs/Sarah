const assert=require('node:assert/strict');
const path=require('node:path');
const os=require('node:os');
let playwright;
try{playwright=require('playwright');}catch{playwright=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
(async()=>{
  const browser=await playwright.chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const real=process.argv[2];
    if(!real){
      let attempts=0;
      const {packCivetTimeline}=await import('../../src/lib/civetTimelineTransport.js');
      await page.route('**/api/civet/session/**',async route=>{
        attempts++;
        await new Promise(resolve=>setTimeout(resolve,700));
        await route.fulfill(attempts===1?{status:503,json:{error:'Temporary connection failure'}}:{json:packCivetTimeline({samples:[{t:60,pressure_kpa:2,usable:true}],analysis:null})});
      });
    }
    await page.goto('http://127.0.0.1:5175/scripts/tests/fixtures/civet-loading.html'+(real?'?session='+encodeURIComponent(real):''));
    await page.getByText('Loading saved CIVET pressure and analysis…').waitFor();
    if(!real){await page.getByRole('alert').waitFor();await page.getByRole('button',{name:'Retry CIVET'}).click();}
    await page.locator('.civet-card').waitFor({timeout:60000});
    const count=Number(await page.getByLabel('Saved sample count').textContent());
    assert.ok(count>0);assert.deepEqual(errors,[]);
    assert.ok(await page.locator('.civet-card').isVisible());
    console.log('PASS: CIVET visible in Full Telemetry, samples='+count+(real?' (saved session)':' after failed request and Retry'));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
