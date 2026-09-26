const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
(async () => {
  const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => route.request().url().includes('/src/') ? route.continue() : route.fulfill({ json: [] }));
    await page.goto('http://127.0.0.1:5175/scripts/tests/fixtures/video-sidebar-resize.html');
    const video = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d'); context.fillStyle = '#156e75'; context.fillRect(0, 0, 640, 360);
      const stream = canvas.captureStream(10), recorder = new MediaRecorder(stream), chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const done = new Promise(resolve => recorder.onstop = resolve);
      recorder.start(); context.fillStyle = '#156e75'; context.fillRect(0, 0, 640, 360); context.fillStyle = 'white'; context.fillRect(100, 100, 440, 160); await new Promise(resolve => setTimeout(resolve, 300)); recorder.stop(); await done;
      stream.getTracks().forEach(track => track.stop());
      return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
    });
    await page.locator('input[type="file"][accept*="video"]').first().setInputFiles({ name: 'fixture.webm', mimeType: 'video/webm', buffer: Buffer.from(video) });
    await page.getByRole('button', { name: 'Full Telemetry', exact: true }).click();
    const phase = page.locator('[data-video-section="phase"]'); await phase.waitFor();
    const handle = page.getByRole('separator', { name: 'Resize Phase evidence height', exact: true });
    await handle.scrollIntoViewIfNeeded();
    const before = await phase.boundingBox();
    const fontBefore = await phase.locator('h3').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    await handle.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    assert.ok((await phase.boundingBox()).height > before.height);
    await page.waitForTimeout(100);
    assert.ok(await phase.locator('h3').evaluate(el => parseFloat(getComputedStyle(el).fontSize)) > fontBefore);
    await page.keyboard.press('Home');
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowUp');
    assert.ok((await phase.boundingBox()).height >= 224);
    await handle.scrollIntoViewIfNeeded();
    const grip = await handle.boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 5); await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 85, { steps: 5 }); await page.mouse.up();
    assert.ok((await phase.boundingBox()).height >= 280, 'pointer resize grows the section');
    const widthHandle = page.getByRole('separator', { name: 'Resize telemetry sidebar', exact: true });
    await widthHandle.focus(); await page.keyboard.press('Home');
    assert.equal(await widthHandle.getAttribute('aria-valuenow'), '440');
    const clipped = await page.locator('.video-resizable-content').evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 2 || node.scrollHeight > node.clientHeight + 2).map(node => node.parentElement.dataset.videoSection));
    assert.deepEqual(clipped, [], 'minimum width and heights do not clip section contents');
    const sidebar = page.locator('.video-resizable-sidebar');
    assert.ok(await sidebar.evaluate(el => el.scrollHeight <= el.clientHeight + 2), 'sidebar never scrolls');
    const tops = await page.locator('[data-video-section=metrics] .grid > div').evaluateAll(nodes => nodes.map(el => Math.round(el.getBoundingClientRect().top)));
    assert.equal(new Set(tops).size, 1, 'vital signs stay in one row');
    assert.equal(await page.getByRole('button', { name: 'Fill video display', exact: true }).count(), 0);
    const fullVideo = page.locator('video').filter({ visible: true });
    assert.equal(await fullVideo.first().evaluate(el => getComputedStyle(el).objectFit), 'contain');
    await widthHandle.focus(); await page.keyboard.press('End');
    assert.equal(await fullVideo.first().evaluate(el => getComputedStyle(el).objectFit), 'contain');
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'logs/video-sidebar-resize.png', fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    assert.equal(await page.getByRole('separator', { name: 'Resize telemetry sidebar', exact: true }).count(), 0);
    const narrowClips = await page.locator('.video-resizable-content').evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 2 || node.scrollHeight > node.clientHeight + 2).map(node => node.parentElement.dataset.videoSection));
    assert.deepEqual(narrowClips, [], 'stacked narrow-screen sections remain readable without clipping');
    for (const button of await page.locator('.video-section-tabs button').all()) {
      await button.click(); await page.waitForTimeout(100);
      assert.deepEqual(await page.locator('.video-resizable-content').evaluateAll(nodes => nodes.filter(n => n.scrollHeight > n.clientHeight + 2 || n.scrollWidth > n.clientWidth + 2).map(n => n.parentElement.dataset.videoSection)), [], 'compact section content fits');
      assert.ok(await sidebar.evaluate(el => el.scrollHeight <= el.clientHeight + 2), 'compact sidebar cannot scroll');
    }
    assert.deepEqual(errors, []);
    console.log('PASS: actual Video Sync section resizing, minimum sizes, responsive text, sidebar limits, and uncropped video, single-row metrics, and no sidebar scrolling');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
