const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
let pw;try{pw=require('playwright');}catch{pw=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
(async()=>{const browser=await pw.chromium.launch({channel:'chrome',headless:true});try{
const page=await browser.newPage({viewport:{width:1920,height:1080}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:5175/scripts/tests/fixtures/civet-calibration.html');
const rest=page.getByRole('button',{name:/1 · Start rest/}),hold=page.getByRole('button',{name:/2 · Start hold/});
await rest.waitFor();await page.waitForTimeout(300);assert.equal(await hold.isDisabled(),true);
await page.getByRole('button',{name:/Zero —/}).click();assert.equal(await page.evaluate(()=>window.zeroCalls),1);assert.equal(await page.getByRole('checkbox').count(),0);
await rest.click();await page.getByText('Get ready to relax',{exact:true}).waitFor();await page.getByText('REST — stay relaxed',{exact:true}).waitFor();
await page.getByLabel('Measurement: 4 seconds remaining').waitFor();await page.screenshot({path:'logs/civet-calibration-countdown.png'});
await page.getByText('Rest accepted — ready to hold',{exact:true}).waitFor({timeout:8000});assert.equal(await hold.isEnabled(),true);
await hold.click();await page.evaluate(()=>window.setPressure(4));await page.getByText('HOLD — keep it steady',{exact:true}).waitFor();
await page.waitForTimeout(2000);await page.evaluate(()=>window.setPressure(2));await page.getByText('Redo suggested',{exact:true}).waitFor({timeout:8000});
const redo=page.getByRole('button',{name:/Redo hold/});assert.equal(await redo.isEnabled(),true);await page.screenshot({path:'logs/civet-calibration-redo.png'});
await redo.click();await page.evaluate(()=>window.setPressure(4));await page.getByText('Calibration ready',{exact:true}).waitFor({timeout:11000});
await page.evaluate(()=>window.setPressure(2));await page.waitForTimeout(500);await page.screenshot({path:'logs/civet-calibration-ready.png'});
assert.equal(await page.locator('.civet-setup').evaluate(el=>el.scrollHeight>el.clientHeight+2),false);
await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('.civet-setup').evaluate(el=>el.scrollWidth>el.clientWidth+2),false);await page.screenshot({path:'logs/civet-calibration-mobile.png'});
assert.deepEqual(errors,[]);console.log('PASS single-click zero, preparation/sample countdowns, rest gate, early release/hold-only retry, desktop fit and mobile width');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
