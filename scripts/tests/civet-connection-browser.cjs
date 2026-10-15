const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
let pw;try{pw=require('playwright');}catch{pw=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
(async()=>{const browser=await pw.chromium.launch({channel:'chrome',headless:true});try{
const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:5175/scripts/tests/fixtures/civet-calibration.html?remembered');
const toggle=page.getByRole('checkbox',{name:'Reconnect my CIVET when Live Capture opens'});await toggle.waitFor();
assert.equal(await page.getByLabel('CIVET device').inputValue(),'AA:BB:CC:DD:EE:FF');
await toggle.click();await page.waitForTimeout(200);assert.equal(await toggle.isChecked(),false);
await page.getByText('Bluetooth connection',{exact:true}).click();await page.getByRole('button',{name:'Connect',exact:true}).click();
assert.ok(await page.evaluate(()=>window.connectionCalls.some(c=>c.url.endsWith('/connect')&&c.body.address==='AA:BB:CC:DD:EE:FF')));
await page.getByRole('button',{name:'Forget sensor',exact:true}).click();await toggle.waitFor({state:'detached'});
assert.equal(await page.getByLabel('CIVET device').inputValue(),'');
assert.deepEqual(errors,[]);console.log('PASS saved sensor selected, direct reconnect, opt out and forget controls');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
