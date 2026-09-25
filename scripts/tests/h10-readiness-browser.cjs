const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
(async () => {
  const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${process.env.SARAH_TEST_URL || 'http://127.0.0.1:5175'}/scripts/tests/fixtures/h10-readiness.html`);
    await page.getByRole('alert').waitFor();
    assert.ok((await page.getByRole('alert').innerText()).includes('HTTP 400'));
    const reconnect = page.getByRole('button', { name: 'Reconnect H10', exact: true });
    assert.ok((await reconnect.boundingBox()).height >= 44);
    await reconnect.click();
    await page.getByText('Reconnect attempts: 1').waitFor();
    for (const width of [360, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no horizontal overflow at ${width}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'logs/h10-mobile-recovery.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: visible error without setup navigation, touch-sized reconnect action, 360/390/768px layout');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
