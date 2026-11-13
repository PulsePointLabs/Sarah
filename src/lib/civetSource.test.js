import test from 'node:test';
import assert from 'node:assert/strict';
import { usesNativeCivet, selectCivetSource } from './civetSource.js';
import { setPhoneAcquisition } from './phoneTelemetry.js';
test('APK CIVET acquisition works in full Sarah and standalone, with explicit server fallback',()=>{
  const values=new Map();globalThis.localStorage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
  globalThis.window={Capacitor:{isNativePlatform:()=>true}};
  try{
    setPhoneAcquisition(false);assert.equal(usesNativeCivet(),true);
    setPhoneAcquisition(true);assert.equal(usesNativeCivet(),true);
    selectCivetSource('server');assert.equal(usesNativeCivet(),false);
    selectCivetSource('phone');assert.equal(usesNativeCivet(),true);
    window.Capacitor.isNativePlatform=()=>false;assert.equal(usesNativeCivet(),false);
  }finally{delete globalThis.window;delete globalThis.localStorage;setPhoneAcquisition(false);}
});
