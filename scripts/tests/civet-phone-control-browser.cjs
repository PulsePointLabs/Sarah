const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
let pw;try{pw=require('playwright');}catch{pw=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
(async()=>{const browser=await pw.chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5175/scripts/tests/fixtures/civet-calibration.html?phone');
 const rest=page.getByRole('button',{name:/1 · Start rest/}),hold=page.getByRole('button',{name:/2 · Start hold/});
 await rest.waitFor();await page.waitForTimeout(250);assert.equal(await rest.isEnabled(),true);
 assert.equal(await page.getByRole('button',{name:/Zero —/}).isEnabled(),true);
 await rest.click();await page.getByText('Get ready to relax',{exact:true}).waitFor();
 const restart=page.getByRole('button',{name:/Start calibration over/});assert.equal(await restart.isEnabled(),true);await restart.click();
 await page.getByText('Rest accepted — ready to hold',{exact:true}).waitFor({timeout:12000});assert.equal(await hold.isEnabled(),true);
 await hold.click();await page.evaluate(()=>window.setPressure(4));await page.getByText('Release and relax',{exact:true}).waitFor({timeout:12000});
 await page.evaluate(()=>window.setPressure(2));await page.getByText('Calibration ready',{exact:true}).waitFor({timeout:7000});
 assert.equal(await page.evaluate(()=>window.connectionCalls.filter(c=>c.url.endsWith('/calibrate')).length),3);
 await page.screenshot({path:'logs/civet-phone-control-ready.png'});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('.civet-setup').evaluate(el=>el.scrollWidth>el.clientWidth+2),false);
 assert.deepEqual(errors,[]);console.log('PASS Chrome phone-stream rest, restart, hold, release, zero availability, and mobile width');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
