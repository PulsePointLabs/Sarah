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
    const wav=Buffer.alloc(1644);wav.write('RIFF');wav.writeUInt32LE(1636,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);
    let preparation;
    await page.route('**/api/**', route => {
      if(route.request().url().includes('/src/'))return route.continue();
      if(route.request().url().endsWith('/live-cues/prepare')){preparation=route.request().postDataJSON();return route.fulfill({json:{clips:preparation.clips.map(c=>({...c,url:'/live-cues/test.wav'}))}});}
      if(route.request().url().endsWith('/live-cues/test.wav'))return route.fulfill({contentType:'audio/wav',body:wav});
      return route.fulfill({json:[]});
    });
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
    await page.getByRole('button',{name:'Phase voice off',exact:true}).click();
    await page.getByLabel('Phase voice options').click();
    const test=page.getByRole('button',{name:'Test playback voice',exact:true});
    await test.click();
    await page.getByRole('status').filter({hasText:'Voice ready.'}).waitFor();
    assert.equal(preparation.clips.length,7);
    assert.ok(preparation.clips.some(c=>c.text==='Climax candidate.'));
    assert.ok(!('sessionId' in preparation));
    await page.getByRole('slider',{name:'Playback phase voice volume'}).fill('0');
    assert.equal(JSON.parse(await page.evaluate(()=>localStorage.getItem('sarah.videoSync.phaseVoice.v1'))).volume,0);
    await page.getByRole('button',{name:'Phase voice on',exact:true}).click();
    assert.deepEqual(errors,[]);
    console.log('PASS playback voice toggle, fixed-phrase audio preparation/decoding, test playback and independent persisted settings');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
