import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const page = fs.readFileSync(new URL('../pages/LiveCapture.jsx', import.meta.url), 'utf8');
function saveHarness() {
  let fail = true; let attempts = 0; let state = {}; const sent = [];
  const context = vm.createContext({ useCallback: f => f, bpOmronSeenRef: { current: new Set() },
    setBpCapture: f => { state = f(state); }, formatBloodPressure: () => '120/80',
    liveSession: { activeSessionId: 'current-session' },
    stampBloodPressureReadings: async () => ({ stamped: 0 }),
    ingestBloodPressureReadings: async readings => { attempts++; if (fail) throw Error('offline'); sent.push(...readings); return { readings }; },
  });
  const start = page.indexOf('  const saveOmronBloodPressureForLiveSession =');
  const end = page.indexOf('  const saveOmronReadingRef', start);
  vm.runInContext(page.slice(start, end) + '\nthis.save = saveOmronBloodPressureForLiveSession;', context);
  return { context, save: context.save, recover: () => { fail = false; }, get attempts() { return attempts; }, get state() { return state; }, sent };
}
const reading = { id: 'bp-test', external_id: 'test', measured_at: '2026-09-07T19:00:00Z', systolic_mm_hg: 120, diastolic_mm_hg: 80 };
test('failed API save can be retried; only confirmed saves are deduplicated', async () => {
  const h = saveHarness(); await assert.rejects(h.save(reading), /offline/); h.recover();
  await h.save(reading); await h.save(reading); assert.equal(h.attempts, 2);
  assert.equal(h.sent[0].session, 'current-session');
});
test('listener armed earlier calls the latest session save callback', async () => {
  const h = saveHarness(); h.recover();
  h.context.saveOmronReadingRef = { current: h.save };
  const start = page.indexOf('        onReading: (reading) => {', page.indexOf('const startOmronBloodPressureListenerForLiveSession'));
  const end = page.indexOf('        onDisconnect:', start);
  vm.runInContext('this.callback = ({'+page.slice(start, end)+'}).onReading;', h.context);
  h.context.liveSession = { activeSessionId: 'next-session' };
  await h.context.callback(reading); assert.equal(h.sent[0].session, 'next-session');
  assert.equal(h.state.sessionId, 'next-session');
});
test('native replay coalesces deliveries, retries failed saves, and acknowledges only success', async () => {
  let interval; let delivered = 0; let fail = true; const acknowledgements = []; const handlers = {};
  const native = { addListener: async (name, fn) => { handlers[name] = fn; return { remove: async () => {} }; },
    arm: async () => ({ pendingReadings: [reading, {...reading, external_id:'second'}] }),
    getState: async () => ({ pendingReadings: [reading, {...reading, external_id:'second'}] }),
    acknowledgeReading: async value => acknowledgements.push(value.externalId), disarm: async () => {} };
  const source = fs.readFileSync(new URL('../lib/omronBloodPressureBle.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function startNativeOmronListener('); const end = source.indexOf('\nfunction readStoredJson', start);
  const context = vm.createContext({ NativeOmronBloodPressure: native, nativeOmronListener: null,
    stopNativeOmronListener: async () => {}, initializeBle: async () => {}, getRememberedOmronDevice: () => ({deviceId:'cuff'}),
    setInterval: fn => { interval = fn; return 1; }, Map, Promise });
  vm.runInContext(source.slice(start,end)+'\nthis.start = startNativeOmronListener;',context);
  await context.start({onReading: async () => { delivered++; if(fail) throw Error('offline'); }, onError:()=>{}});
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(acknowledgements.length,0); assert.equal(delivered,2);
  fail=false; interval(); interval(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(delivered,4); assert.deepEqual(acknowledgements.sort(),['second','test']);
});
