import { cuffReceiptSince, summarizeOmronConnection } from "../lib/omronCuffStatus.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const page = fs.readFileSync(new URL('../pages/LiveCapture.jsx', import.meta.url), 'utf8');
function saveHarness() {
  let fail = true; let attempts = 0; let state = {}; const sent = [];
  const context = vm.createContext({ cuffReceiptSince, bpCaptureOpenedAtRef: {current:0}, useCallback: f => f, bpOmronSeenRef: { current: new Set() },
    setBpCapture: f => { state = f(state); }, formatBloodPressure: () => '120/80',
    liveSession: { active:true, activeSessionId: 'current-session' }, bpSessionKeyRef: {current:'current-session'}, readingIsInActiveSession:()=>true,
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
  h.context.liveSession = { active:true, activeSessionId: 'next-session' }; h.context.bpSessionKeyRef.current='next-session';
  await h.context.callback(reading); assert.equal(h.sent[0].session, 'next-session');
  assert.equal(h.state.sessionId, 'next-session');
});

test('a replay from outside the recording is saved without relabeling current-session telemetry', async () => {
  const h=saveHarness();h.recover();h.context.readingIsInActiveSession=()=>false;
  await h.save(reading);
  assert.equal(h.sent[0].session,undefined);
  assert.equal(h.state.lastReading,undefined);
  assert.match(h.state.message,/BP history/);
});

test('an in-flight BP save cannot repopulate a different session after a transition', async () => {
  const h=saveHarness();let resolve;
  h.context.ingestBloodPressureReadings=()=>new Promise(done=>{resolve=done;});
  const saving=h.save(reading);h.context.bpSessionKeyRef.current='next-session';
  resolve({readings:[reading]});await saving;
  assert.equal(h.state.lastReading,undefined);
  assert.equal(h.state.sessionId,undefined);
});
test('native replay coalesces deliveries, retries failed saves, and acknowledges only success', async () => {
  let interval; let configured; let delivered = 0; let fail = true; const acknowledgements = []; const handlers = {}; const held = [];
  const pending = [reading, {...reading, external_id:"second"}, {...reading, external_id:"old-invalid", measured_at:"-0001-11-28T05:00:00Z"}];
  const native = { addListener: async (name, fn) => { handlers[name] = fn; return { remove: async () => {} }; },
    arm: async options => { configured = options; return { pendingReadings: pending }; },
    getState: async () => ({ pendingReadings: pending }),
    acknowledgeReading: async value => acknowledgements.push(value.externalId), disarm: async () => {} };
  const source = fs.readFileSync(new URL('../lib/omronBloodPressureBle.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function startNativeOmronListener('); const end = source.indexOf('\nfunction readStoredJson', start);
  const context = vm.createContext({ NativeOmronBloodPressure: native, nativeOmronListener: null,
    stopNativeOmronListener: async () => {}, initializeBle: async () => {}, getRememberedOmronDevice: () => ({deviceId:'cuff'}),
    setInterval: fn => { interval = fn; return 1; }, Map, Promise, URL,
    apiUrl: path => `https://sarah.test/api${path}`, window: { location: { href: 'https://localhost' } } });
  vm.runInContext(source.slice(start,end)+'\nthis.start = startNativeOmronListener;',context);
  await context.start({onReading: async () => { delivered++; if(fail) throw Error('offline'); }, onError:()=>{}, onHeldReading: r => held.push(r)});
  assert.equal(configured.endpoint, 'https://sarah.test/api/blood-pressure/ingest');
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(acknowledgements.length,0); assert.equal(delivered,2);
  fail=false; interval(); interval(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(delivered,4); assert.deepEqual(acknowledgements.sort(),['second','test']);
  assert.equal(held.length, 1); assert.equal(held[0].external_id, 'old-invalid');
});

test('automatic database refresh does not clear cuff save error or change controls while armed', async () => {
  let state = { status: 'error', error: 'offline', lastReading: reading, message: 'Retry pending', permissionGranted: true };
  const original = state;
  const context = vm.createContext({ useCallback: f => f, bpSyncInFlightRef: {current:false}, bpOmronListening:true,
    liveSession:{active:true,activeSessionId:'session'}, bpSessionKeyRef:{current:'session'}, setBpCapture:f=>{state=f(state);},
    getBloodPressureStatus:async()=>({native:true,permissionGranted:false}), listRecentBloodPressure:async()=>({readings:[]}),
    stampBloodPressureReadings:async()=>({stamped:0,latest:null}) });
  const start=page.indexOf('  const syncBloodPressureForLiveSession =');
  const end=page.indexOf('  const saveOmronBloodPressureForLiveSession',start);
  vm.runInContext(page.slice(start,end)+'\nthis.sync=syncBloodPressureForLiveSession;',context);
  for(let i=0;i<6;i++) await context.sync({manual:false});
  assert.equal(state,original);
});

test('recreated WebView receives a reading already uploaded by native background delivery', async () => {
  const source = fs.readFileSync(new URL('../lib/omronBloodPressureBle.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function startNativeOmronListener(');
  const end = source.indexOf('\nfunction readStoredJson', start);
  const received = [], ack = [];
  const context = vm.createContext({
    NativeOmronBloodPressure: {
      addListener: async () => ({ remove: async () => {} }),
      arm: async () => ({ pendingReadings: [], lastDeliveredReading: reading }),
      acknowledgeReading: async value => ack.push(value.externalId),
    },
    nativeOmronListener: null, stopNativeOmronListener: async () => {}, initializeBle: async () => {},
    getRememberedOmronDevice: () => ({ deviceId: 'cuff' }), setInterval: () => 1,
    Map, Promise, URL, apiUrl: path => `https://sarah.test/api${path}`,
    window: { location: { href: 'https://localhost' } },
  });
  vm.runInContext(source.slice(start, end) + '\nthis.start = startNativeOmronListener;', context);
  await context.start({ onReading: value => received.push(value) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [reading]);
  assert.deepEqual(ack, ['test']);
});

test('clock warnings do not replace the actual Bluetooth connection and delivery status', () => {
  assert.equal(summarizeOmronConnection({listening:true, connected:true, clockStatus:'failed', clockMessage:'Pair again'}), 'Cuff connected. Ready for a reading.');
  assert.match(summarizeOmronConnection({listening:true, connected:false}), /Waiting for cuff/);
  assert.match(summarizeOmronConnection({listening:true, connected:true, deliveryError:'HTTP 503',pendingReadings:[reading]}), /Reading saved on phone/);
});

test('copyable cuff diagnostics omit readings, delivery URLs and device addresses', async () => {
  const source=fs.readFileSync(new URL('../lib/omronBloodPressureBle.js',import.meta.url),'utf8');
  const context=vm.createContext({canUseNativeOmronListener:()=>true,NativeOmronBloodPressure:{getState:async()=>({
    listening:true,connected:true,clockStatus:'failed',clockMessage:'Clock read failed',deviceId:'PRIVATE',endpoint:'PRIVATE',
    pendingReadings:[reading],lastDeliveredReading:reading,diagnostics:[{event:'clock_read',status:5}]
  })}});
  vm.runInContext(source.slice(source.indexOf('export async function getOmronConnectionDiagnostics')).replace('export ','')+'\nthis.get=getOmronConnectionDiagnostics;',context);
  const result=await context.get();assert.equal(result.clockStatus,undefined);
  for(const key of ['deviceId','endpoint','pendingReadings','lastDeliveredReading'])assert.equal(result[key],undefined);
  assert.equal(result.diagnostics[0].status,5);
});

test('fresh test readings are visible without assigning them to a session', async () => {
  const h=saveHarness();h.recover();h.context.readingIsInActiveSession=()=>false;
  const received={...reading,received_at:'2026-10-26T06:00:00Z'};
  await h.save(received);assert.equal(h.state.lastCuffReceipt,received);
  assert.equal(h.state.lastReading,undefined);assert.equal(h.sent[0].session,undefined);
});
test('a historical native replay cannot look like a new test reading', async () => {
  const h=saveHarness();h.recover();h.context.bpCaptureOpenedAtRef.current=Date.parse('2026-10-26T06:00:00Z');
  h.context.readingIsInActiveSession=()=>false;
  await h.save({...reading,received_at:'2026-10-25T06:00:00Z'});
  assert.equal(h.state.lastCuffReceipt,undefined);assert.equal(h.state.lastReading,undefined);
});
