import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function runtime(native){
  const context=vm.createContext({registerPlugin:()=>({}),window:{Capacitor:{isNativePlatform:()=>native}}});
  const source=fs.readFileSync(new URL('./phoneTelemetry.js',import.meta.url),'utf8');
  vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nthis.api={isPhoneAcquisition,isNativeSarah,setPhoneAcquisition};',context);
  return context.api;
}
test('Android starts in normal Sarah mode and standalone acquisition is opt-in',()=>{
  const app=runtime(true);
  assert.equal(app.isNativeSarah(),true);
  assert.equal(app.isPhoneAcquisition(),false);
  app.setPhoneAcquisition(true);assert.equal(app.isPhoneAcquisition(),true);
  app.setPhoneAcquisition(false);assert.equal(app.isPhoneAcquisition(),false);
  assert.equal(app.isNativeSarah(),true,'native display support is independent of acquisition mode');
});
test('Chrome and EXE stay on the server workflow',()=>{
  const app=runtime(false);
  assert.equal(app.isPhoneAcquisition(),false);
  app.setPhoneAcquisition(true);assert.equal(app.isPhoneAcquisition(),false);
});
