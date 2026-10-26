import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./omronBloodPressureBle.js', import.meta.url), 'utf8');
function harness() {
  let disarms = 0;
  let arms = 0;
  let poll;
  let rejectStop = false;
  const callbacks = {};
  const storage = new Map([['pulsepoint.omronBp.device', JSON.stringify({deviceId:'test-cuff'})]]);
  let state = {listening:true, connected:true, state:'waiting_for_reading', clockStatus:'verified', pendingReadings:[]};
  const context = vm.createContext({
    registerPlugin: () => ({
      arm: async () => { arms++; return state; },
      disarm: async () => { disarms++; if (rejectStop) throw Error('stop failed'); state={...state,listening:false,connected:false,state:'stopped'}; },
      addListener: async (name, fn) => { callbacks[name]=fn; return {remove:async()=>{}}; },
      getState: async () => state,
      acknowledgeReading: async () => {},
    }),
    BleClient: {initialize:async()=>{}, disconnect:async()=>{}, requestDevice:async()=>({deviceId:'test-cuff'})},
    window: {Capacitor:{isNativePlatform:()=>true},location:{href:'https://localhost'},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}},
    URL, apiUrl:p=>`https://sarah.test/api${p}`,setInterval:fn=>{poll=fn;return 1;},clearInterval:()=>{},
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+
    '\nthis.api={start:startNativeOmronListener,stop:stopOmronBloodPressureListener,status:getOmronBloodPressureListenerState};',context);
  return {api:context.api, callbacks, get disarms(){return disarms;},get arms(){return arms;},
    poll:async()=>{poll();await new Promise(r=>setImmediate(r));},setState:value=>{state={...state,...value};}, failStop:()=>{rejectStop=true;}};
}
test('explicit Stop releases service-owned cuff after a WebView lost its handle',async()=>{
  const h=harness();await h.api.stop();assert.equal(h.disarms,1);
});
test('reattaching the same cuff does not disarm the native collector',async()=>{
  const h=harness();await h.api.start({});await h.api.start({});
  assert.equal(h.arms,2);assert.equal(h.disarms,0);await h.api.stop();assert.equal(h.disarms,1);
});
test('explicit device selection releases the existing native connection first',async()=>{
  const h=harness();await h.api.start({forceDevicePicker:true});assert.equal(h.disarms,1);await h.api.stop();
});
test('replayed historical readings never imply a live Bluetooth connection',async()=>{
  const h=harness();h.setState({connected:false,state:'waiting_for_cuff',lastDeliveredReading:{external_id:'old',measured_at:'2026-10-20T12:00:00Z'}});
  await h.api.start({onReading:async()=>{}});assert.equal(h.api.status().connected,false);await h.api.stop();
});
test('polling reflects a native disconnect or stop and ignores late polls after Stop',async()=>{
  const h=harness();await h.api.start({});assert.equal(h.api.status().connected,true);
  h.setState({connected:false,listening:false,state:'stopped'});await h.poll();
  assert.equal(h.api.status().connected,false);assert.equal(h.api.status().listening,false);
  await h.api.stop();await h.poll();assert.equal(h.api.status().listening,false);
});
test('Stop errors are visible instead of falsely claiming the cuff was released',async()=>{
  const h=harness();h.failStop();await assert.rejects(h.api.stop(),/stop failed/);
});
test('native collector cannot write the cuff clock and subscribes before a clock read',()=>{
  const native=fs.readFileSync(new URL('../../android/app/src/main/java/com/pulsepointlabs/sarah/OmronCollector.kt',import.meta.url),'utf8');
  assert.doesNotMatch(native,/writeCharacteristic\(|clock_write_requested/);
  const services=native.slice(native.indexOf('override fun onServicesDiscovered'),native.indexOf('override fun onDescriptorWrite'));
  assert.match(services,/subscribeToReadings\(connection\)/);assert.doesNotMatch(services,/checkClock\(connection\)/);
  assert.match(native,/if \(!armed \|\| scanning \|\| gatt != null/);
});
