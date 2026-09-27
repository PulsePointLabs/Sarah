const assert=require('node:assert/strict');const path=require('node:path');const os=require('node:os');
let playwright;try{playwright=require('playwright');}catch{playwright=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
(async()=>{const browser=await playwright.chromium.launch({channel:'chrome',headless:true});try{const page=await browser.newPage({viewport:{width:1600,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/api/civet/**',route=>route.fulfill({json:route.request().url().includes('/scan')?{devices:[]}:{samples:[]}}));await page.goto('http://127.0.0.1:5175/scripts/tests/fixtures/civet.html');const card=page.locator('.civet-card').first();await card.waitFor();const color=await card.evaluate(el=>getComputedStyle(el).backgroundColor);await page.getByLabel('Test playhead').fill('30.3');await page.waitForTimeout(300);assert.equal(await card.locator('circle[aria-label$="at 30.3 seconds"]').count(),0);assert.notEqual(await card.evaluate(el=>getComputedStyle(el).backgroundColor),color);await page.waitForTimeout(250);assert.deepEqual(await page.locator('.civet-card').evaluateAll(nodes=>nodes.filter(n=>n.scrollHeight>n.clientHeight+2||n.scrollWidth>n.clientWidth+2).map(n=>({h:n.clientHeight,sh:n.scrollHeight,w:n.clientWidth,sw:n.scrollWidth}))),[]);assert.ok(await page.locator('.video-resizable-sidebar').evaluate(el=>el.scrollHeight<=el.clientHeight+2));await page.getByRole('button',{name:'Setup',exact:true}).click();await page.getByRole('button',{name:'Scan for CIVET'}).click();await page.getByRole('alert').filter({hasText:'No CIVET found'}).waitFor();assert.equal(await page.getByRole('button',{name:'1 · Relaxed baseline (5s)'}).isDisabled(),true);await page.getByRole('button',{name:'Close',exact:true}).click();await page.screenshot({path:'logs/civet-cards.png'});
await card.getByRole('button',{name:'Inspect'}).click();
const dialog=page.getByRole('dialog',{name:'CIVET contraction analysis'});await dialog.waitFor();
await dialog.getByRole('combobox').selectOption('review');
await dialog.getByText('Retrospective review (noncausal)',{exact:true}).waitFor({state:'attached'});
await dialog.getByRole('checkbox',{name:'raw',exact:true}).check();
await dialog.getByRole('checkbox',{name:'phasic',exact:true}).check();
await dialog.getByRole('button',{name:/Train 1 /}).click();
assert.ok(await dialog.locator('tbody tr').count()>3);
const peak=dialog.locator('tbody tr').first().getByRole('button');const target=await peak.textContent();await peak.click();
assert.ok(Math.abs(Number(await page.getByLabel('Test playhead').inputValue())-Number(target))<.11);
assert.ok((await dialog.getByRole('link',{name:'Export events CSV'}).getAttribute('href')).includes('mode=review'));
await page.screenshot({path:'logs/civet-analysis-desktop.png'});
await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+2));
await page.screenshot({path:'logs/civet-analysis-mobile.png'});
assert.deepEqual(errors,[]);console.log('PASS CIVET color response, readable cards, fitted sidebar, and actionable setup errors');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});

