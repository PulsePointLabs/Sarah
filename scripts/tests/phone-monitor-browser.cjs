const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
let pw;try{pw=require('playwright');}catch{pw=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
(async()=>{
  const browser=await pw.chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
    page.on('pageerror',error=>{errors.push(error.message);console.error('Browser error:',error.message)});
    await page.route('**/*',route=>['xhr','fetch','eventsource'].includes(route.request().resourceType())?route.abort('internetdisconnected'):route.continue());
    await page.goto('http://127.0.0.1:5175/scripts/tests/fixtures/live-capture-display.html?phone=1');
    await page.getByRole('button',{name:'Devices & Setup',exact:true}).click();
    await page.getByRole('region',{name:'Phone sensor setup'}).waitFor();
    await page.getByRole('button',{name:'Telemetry',exact:true}).click();
    await page.getByRole('button',{name:'Display View',exact:true}).click();
    await page.locator('[data-testid="viewport-telemetry-grid"]').waitFor();
    const hr=page.locator('[data-telemetry-item="metric:Current HR"]');
    assert.match(await hr.innerText(),/—/,'no signal is not displayed as zero beats per minute');
    await page.getByRole('button',{name:'Full screen (F)',exact:true}).click();
    await page.waitForFunction(()=>!!document.fullscreenElement);
    await page.getByRole('button',{name:'Exit full screen',exact:true}).waitFor({state:'visible'});
    await page.getByRole('button',{name:'Telemetry controls',exact:true}).click();
    await page.getByRole('button',{name:'Connect CIVET',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Connect CIVET',exact:true});
    await dialog.waitFor({state:'visible'});
    assert.equal(await dialog.evaluate(el=>document.fullscreenElement.contains(el)),true,'sensor setup remains visible above fullscreen telemetry');
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('button',{name:'Exit full screen',exact:true}).click();
    await page.waitForFunction(()=>!document.fullscreenElement);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);
    console.log('PASS: offline phone monitor, sensor setup, withheld HR, fullscreen exit and CIVET dialog');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
