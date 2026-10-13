const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
(async () => {
  const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-gpu'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:5175/scripts/tests/fixtures/civet-live-monitor.html');
    const wide = page.locator('#wide'), compact = page.locator('#compact');
    await wide.getByLabel('Pressure card view').waitFor();
    assert.equal(await wide.locator('svg').getAttribute('data-window-seconds'), '8');
    assert.match(await wide.innerText(), /Current hold/);
    for (const layout of ['balanced', 'focus', 'session', 'waveform', 'rhythm']) {
      await wide.getByLabel('Pressure card view').selectOption(layout);
      await compact.getByLabel('Pressure card view').selectOption(layout);
      assert.deepEqual(await page.locator('.civet-monitor').evaluateAll(cards => cards.filter(card => card.scrollWidth > card.clientWidth + 2 || card.scrollHeight > card.clientHeight + 2).map(card => card.className)), []);
      assert.equal(await compact.locator('svg').isVisible(), true);
    }
    await page.getByRole('button', { name: 'quiet', exact: true }).click();
    assert.equal(await wide.locator('svg').getAttribute('data-window-seconds'), '20');
    await page.getByRole('button', { name: 'pulses', exact: true }).click();
    assert.equal(await wide.locator('svg').getAttribute('data-window-seconds'), '8');
    await wide.getByRole('button', { name: 'Auto zoom: on' }).click();
    assert.equal(await wide.locator('svg').getAttribute('data-window-seconds'), '20');
    await wide.getByLabel('Pressure card view').selectOption('balanced');
    assert.match(await wide.innerText(), /Last completed pulse/);
    await page.getByRole('button', { name: 'missing', exact: true }).click();
    assert.match(await wide.innerText(), /Signal lost/);
    assert.match(await wide.locator('.civet-reading-primary').innerText(), /—/);
    assert.ok((await wide.locator('svg path').getAttribute('d')).length > 0);
    await wide.getByRole('button', { name: 'Details', exact: true }).click();
    await page.getByRole('dialog', { name: 'Pressure signal details' }).waitFor();
    await page.keyboard.press('Escape');
    await wide.getByRole('button', { name: 'Expand' }).click();
    const expanded = page.locator('.civet-live-expanded');
    assert.equal(await expanded.getByRole('button', { name: 'Auto zoom: off' }).count(), 1);
    await expanded.getByLabel('Pressure card view').selectOption('focus');
    assert.equal(await wide.getByLabel('Pressure card view').inputValue(), 'focus');
    await page.keyboard.press('Escape');
    await page.reload();
    assert.equal(await wide.getByLabel('Pressure card view').inputValue(), 'focus');
    assert.equal(await wide.getByRole('button', { name: 'Auto zoom: off' }).count(), 1);
    await wide.screenshot({ path: 'logs/civet-live-monitor-installed-design.png' });
    assert.deepEqual(errors, []);
    console.log('PASS live pressure views, readable fit, automatic zoom, override, missing signal, expansion and saved preferences');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
