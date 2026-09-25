const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
(async () => {
  const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.clock.install();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    let prepareCount = 0;
    await page.route('**/api/live-cues/**', async (route) => {
      if (route.request().url().endsWith('/live-cues/prepare')) {
        prepareCount++;
        const body = route.request().postDataJSON();
        assert.equal(body.ttsProvider, 'local');
        assert.equal(body.clips.length, 6);
        await route.fulfill({ json: { clips: body.clips.map((c) => ({ ...c, url: '/live-cues/audio/mock.wav' })) } });
      } else await route.fulfill({ contentType: 'audio/wav', body: Buffer.alloc(44) });
    });
    await page.goto('http://127.0.0.1:5175/scripts/tests/fixtures/telemetry-editing.html');
    const hr = page.locator('[data-telemetry-item="Current HR"]');
    await hr.click();
    await page.getByRole('toolbar', { name: 'Current HR options', exact: true }).waitFor();
    const width = (await hr.boundingBox()).width;
    await page.getByRole('button', { name: 'Wider', exact: true }).click();
    assert.ok((await hr.boundingBox()).width > width);
    await page.getByRole('button', { name: 'Later →', exact: true }).click();
    assert.equal(await page.locator('[data-telemetry-item="Vitals"] [data-telemetry-item]').first().getAttribute('data-telemetry-item'), 'RMSSD');
    await page.reload();
    assert.ok((await hr.boundingBox()).width > width, 'size persists');
    assert.equal(await page.locator('[data-telemetry-item="Vitals"] [data-telemetry-item]').first().getAttribute('data-telemetry-item'), 'RMSSD');
    const trend = page.locator('[data-telemetry-item="Trend"]');
    await trend.click();
    const start = await page.getByRole('button', { name: 'Drag Trend to move', exact: true }).boundingBox();
    const target = await page.locator('[data-telemetry-item="Phase"]').boundingBox();
    await page.mouse.move(start.x + 20, start.y + 20); await page.mouse.down();
    await page.mouse.move(target.x + 50, target.y + 50, { steps: 5 }); await page.mouse.up();
    assert.ok((await trend.boundingBox()).x > (await page.locator('[data-telemetry-item="Phase"]').boundingBox()).x, 'pointer drag changes visible panel order');
    const resize = await page.getByRole('button', { name: 'Drag to resize Trend', exact: true }).boundingBox();
    const oldHeight = (await trend.boundingBox()).height;
    await page.mouse.move(resize.x + 20, resize.y + 20); await page.mouse.down();
    await page.mouse.move(resize.x + 20, resize.y + 100, { steps: 4 }); await page.mouse.up();
    assert.ok((await trend.boundingBox()).height > oldHeight, 'corner resize changes panel height');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await hr.click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const touchHandle = page.getByRole('button', { name: 'Drag to resize Current HR', exact: true });
    await touchHandle.scrollIntoViewIfNeeded();
    const touchBox = await touchHandle.boundingBox();
    const beforeTouch = (await hr.boundingBox()).height;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchBox.x + 10, y: touchBox.y + 10 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchBox.x + 10, y: touchBox.y + 100 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.ok((await hr.boundingBox()).height > beforeTouch, 'real browser touch gesture resizes a vital card');
    await page.screenshot({ path: 'logs/telemetry-editing-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const controls = page.getByRole('region', { name: 'Phase announcements', exact: true });
    const prepared = page.waitForResponse((response) => response.url().endsWith('/live-cues/prepare'));
    await controls.getByRole('button', { name: 'Off', exact: true }).click();
    await prepared;
    await page.waitForFunction(() => document.querySelector('[aria-label="Test phase announcement"]')?.textContent === 'Test announcement');
    await page.waitForFunction(() => document.querySelector('[aria-label="Phase announcements"]')?.textContent.includes('Listening for'));
    assert.equal(prepareCount, 1);
    await page.clock.runFor(13500);
    assert.equal(await page.evaluate(() => window.playedAnnouncements), 1, 'automatic phase audio works with encouragement off');
    await page.clock.runFor(35000);
    assert.equal(await page.evaluate(() => window.playedAnnouncements), 1, 'unchanged phase is not repeated');
    await controls.getByRole('button', { name: 'On', exact: true }).click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pulsepoint.phaseAnnouncements.v1')).enabled), false);
    assert.deepEqual(errors, []);
    console.log('PASS: direct selection, move, pointer resize, saved metric layout, mobile controls, independent phase audio and no repeat');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
