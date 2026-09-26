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
    let calibration = null;
    let connected = false;
    await page.route('http://127.0.0.1:5175/api/**', async (route) => {
      const url = route.request().url();
      if (url.endsWith('/emg/ports')) return route.fulfill({ json: { ports: [{ port: 'COM7', label: 'Arduino test' }] } });
      if (url.endsWith('/emg/helper/start')) { connected = true; return route.fulfill({ json: { running: true } }); }
      if (url.endsWith('/emg/calibration-command')) { calibration = { id: 'fixture-cal', status: 'applied' }; return route.fulfill({ json: { id: 'fixture-cal', status: 'queued' } }); }
      if (url.endsWith('/emg/helper')) return route.fulfill({ json: { running: connected, telemetry: { lastSourceAt: connected ? new Date().toISOString() : null, latestTelemetry: { left_pct: 42, right_pct: 23 }, calibrationCommandStatus: calibration } } });
      if (url.includes('/entities/')) return route.fulfill({ json: [] });
      if (url.includes('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' });
      return route.fulfill({ json: { ok: true, hr: { selectedSource: 'direct_h10', sourceStatus: {}, directH10: {}, latestTelemetry: { source: 'direct_h10', hr: 124, baseline: 85, rr: [820, 825], hrv: { rmssd: 42 }, received_at: new Date().toISOString() } }, emg: {}, session: { active: true, activeSessionId: 'fixture', startedAt: new Date(Date.now() - 125000).toISOString() }, settings: {}, clips: [] } });
    });
    await page.goto('http://127.0.0.1:5175/scripts/tests/fixtures/live-capture-display.html?display=telemetry');
    await page.locator('[data-telemetry-item="metric:Current HR"]').waitFor();
    await page.locator('[data-telemetry-item="metric:Current HR"]').click();
    await page.getByRole('toolbar', { name: 'Current HR options', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.mouse.move(50, 15);
    await page.getByRole('region', { name: 'Phase announcements', exact: true }).waitFor();
    await page.mouse.move(700, 900);
    const assertFits = async () => {
      await page.waitForTimeout(300);
      const issues = await page.locator('[data-testid="viewport-telemetry-grid"]').evaluate(grid => {
        const bounds = grid.getBoundingClientRect();
        const items = [...grid.querySelectorAll('[data-telemetry-item]')];
        return items.flatMap(item => {
          const r = item.getBoundingClientRect(), content = item.querySelector('.telemetry-fit-body');
          const b = content.getBoundingClientRect();
          return r.bottom > bounds.bottom + 2 || r.right > bounds.right + 2 || b.right > r.right + 2 || b.bottom > r.bottom + 2
            ? [item.dataset.telemetryItem] : [];
        });
      });
      assert.deepEqual(issues, [], 'all cards and their contents stay inside the viewport');
    };
    await assertFits();
    await page.locator('[data-telemetry-item="threshold"]').click();
    await page.getByRole('button', { name: 'Taller', exact: true }).click();
    await page.getByRole('button', { name: 'Wider', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await assertFits();
    await page.screenshot({ path: 'logs/live-capture-display-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await assertFits();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: 'logs/live-capture-display-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Telemetry controls', exact: true }).click();
    await page.getByRole('button', { name: 'Connect EMG', exact: true }).click();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText('Receiving live EMG', { exact: true }).waitFor();
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Capture', exact: true }).click();
      await page.getByText(`Calibration · Step ${i + 2} of 4`, { exact: true }).waitFor();
    }
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Calibration · Saved', { exact: true }).waitFor();
    assert.equal(await page.getByRole('meter', { name: 'Sensor 1 signal' }).getAttribute('value'), '42');
    await page.screenshot({ path: 'logs/emg-setup-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: full Live Capture fullscreen renders, exposes direct item options and independent announcement controls, no runtime errors');
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
