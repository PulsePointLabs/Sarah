// Run Vite on port 5175 first. Override SARAH_TEST_URL or PLAYWRIGHT_MODULE as needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-dual-monitor-'));
  let browser;
  try {
    const video = path.join(temp, 'test.mp4');
    execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=navy:s=640x360:r=30','-t','120','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-y',video]);
    browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const base = process.env.SARAH_TEST_URL || 'http://127.0.0.1:5175';
    const writes = [], errors = [];
    await context.route(`${base}/api/**`, async route => {
      if (route.request().method() === 'PATCH') writes.push(route.request().postDataJSON());
      await route.fulfill({ json: [] });
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/scripts/tests/fixtures/dual-monitor.html`);
    await page.locator('input[type=file]').first().setInputFiles(video);
    await page.getByRole('button', {name:'Full Telemetry',exact:true}).click();
    const opened = context.waitForEvent('page');
    await page.getByRole('button', {name:'Dual monitors',exact:true}).click();
    const monitor = await opened; monitor.on('pageerror', e => errors.push(e.message));
    await monitor.getByRole('button', {name:'Annotate (S)'}).waitFor();
    await page.keyboard.press('h'); assert.equal(await page.getByRole('button',{name:'Hide controls (H)',exact:true}).isVisible(),false);
    await page.keyboard.press('h'); assert.equal(await page.getByRole('button',{name:'Hide controls (H)',exact:true}).isVisible(),true);
    const seek = async time => {
      await page.locator('video:visible').first().evaluate((v,t)=>{v.currentTime=t;v.dispatchEvent(new Event('timeupdate'));},time);
      await monitor.getByText(`Telemetry | 0:${time}`).waitFor();
      await page.waitForFunction(()=>[...document.querySelectorAll("video")].some(v=>v.offsetWidth && !v.seeking && v.readyState>=2));
    };
    await seek(30); await monitor.keyboard.press('n'); await monitor.getByRole('button',{name:'End near climax (N)',exact:true}).waitFor();
    await seek(40); await monitor.keyboard.press('n'); await monitor.getByRole('button',{name:'Start near climax (N)',exact:true}).waitFor();
    assert.ok(writes.some(w=>w.subjective_near_climax_episodes?.some(e=>e.start_s===30 && e.end_s===40)));
    await monitor.keyboard.press('c');await monitor.getByRole('button',{name:'End climax (C)',exact:true}).waitFor();
    await seek(45);await monitor.keyboard.press('c');await monitor.getByRole('button',{name:'Start climax (C)',exact:true}).waitFor();
    const handle=monitor.getByRole('slider',{name:'Near climax start',exact:true}).first();
    const box=await handle.boundingBox(); await monitor.mouse.move(box.x+box.width/2,box.y+15);await monitor.mouse.down();await monitor.mouse.move(box.x+box.width/2+30,box.y+15,{steps:4});await monitor.mouse.up();
    assert.ok(Number(await handle.getAttribute('aria-valuenow'))>15);
    for(const height of [900,720]) {
      await monitor.setViewportSize({width:1280,height});await monitor.waitForTimeout(200);
      assert.ok(await monitor.evaluate(()=>document.body.scrollHeight<=innerHeight && document.body.scrollWidth<=innerWidth));
    }
    await monitor.getByRole('button',{name:'Annotate (S)'}).click();await monitor.getByRole('dialog').waitFor();
    await monitor.close();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'Dual monitors',exact:true}).waitFor();
    assert.deepEqual(errors,[]);
    console.log('PASS: dual windows, H controls, shared seek, N/C save, boundary drag, annotation dialog, 720/900px layout and close recovery. All API writes mocked.');
  } finally { await browser?.close(); fs.rmSync(temp,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
