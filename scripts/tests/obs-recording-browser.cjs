const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
(async () => {
  const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [], writes = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let snapshot = { settings: { enabled: false, url: '', passwordSaved: false }, primary: { connected: true, identified: true, recording: false }, secondary: { connected: false, recording: false }, run: null };
    await context.route('**/api/obs-recording**', async (route) => {
      const request = route.request();
      if (request.method() === 'PUT') {
        const body = request.postDataJSON(); writes.push(body);
        snapshot.settings = { enabled: body.enabled, url: body.url, passwordSaved: Boolean(body.password) };
        snapshot.secondary.connected = body.enabled;
      }
      await route.fulfill({ json: snapshot });
    });
    const base = process.env.SARAH_TEST_URL || 'http://127.0.0.1:5175';
    await page.goto(`${base}/scripts/tests/fixtures/obs-recording.html`);
    await page.getByText('Primary · Ready', { exact: true }).waitFor();
    await page.getByText('Secondary camera recorder setup', { exact: true }).click();
    await page.getByLabel('Record with secondary OBS').check();
    await page.getByLabel('Secondary OBS address', { exact: true }).fill('ws://second-computer:4455');
    await page.getByLabel('Secondary OBS password', { exact: true }).fill('fake-password');
    assert.equal(await page.getByLabel('Secondary OBS password', { exact: true }).getAttribute('type'), 'password');
    await page.getByRole('button', { name: 'Save connection' }).click();
    await page.getByText('Secondary · Ready', { exact: true }).waitFor();
    assert.equal(writes[0].password, 'fake-password');
    assert.equal(await page.getByLabel('Secondary OBS password', { exact: true }).inputValue(), '');
    await page.getByRole('button', { name: 'Check connection' }).click();
    await page.getByText('Secondary OBS responded. No recording was started.').waitFor();
    snapshot = { ...snapshot, primary: { ...snapshot.primary, recording: true }, secondary: { connected: true, recording: true },
      run: { warnings: [], timing: { estimatedStartDifferenceMs: 24, networkUncertaintyMs: 3 }, primary: {}, secondary: {} } };
    await page.getByText('Secondary · Recording', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save connection' }).isDisabled(), true);
    await page.getByText(/frame alignment not measured/).waitFor();
    await page.screenshot({ path: 'logs/obs-recording-ui.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 850 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log('PASS: setup, password handling, read-only connection check, recording lock, timing labels, mobile layout');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
