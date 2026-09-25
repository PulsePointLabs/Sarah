const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
(async () => {
  const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.route('http://127.0.0.1:5175/api/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/entities/')) return route.fulfill({ json: [] });
      if (url.includes('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' });
      return route.fulfill({ json: { ok: true, hr: { selectedSource: 'direct_h10', sourceStatus: {}, directH10: {} }, emg: {}, session: {}, settings: {}, clips: [] } });
    });
    await page.goto('http://127.0.0.1:5175/scripts/tests/fixtures/live-capture-display.html?display=telemetry');
    await page.locator('[data-telemetry-item="Current HR"]').waitFor();
    await page.locator('[data-telemetry-item="Current HR"]').click();
    await page.getByRole('toolbar', { name: 'Current HR options', exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Phase announcements', exact: true }).count(), 1);
    await page.screenshot({ path: 'logs/live-capture-display-desktop.png', fullPage: true });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: 'logs/live-capture-display-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: full Live Capture fullscreen renders, exposes direct item options and independent announcement controls, no runtime errors');
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
