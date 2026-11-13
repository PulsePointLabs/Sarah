import { isNativeSarah } from './phoneTelemetry.js';

// Phone Bluetooth is independent of which Sarah page or recording mode is open.
// A user can still explicitly choose the traditional server Bluetooth path.
export function usesNativeCivet() {
  if (!isNativeSarah()) return false;
  try { return localStorage.getItem('sarah.civet.source') !== 'server'; }
  catch { return true; }
}
export function selectCivetSource(source) {
  if (!['phone', 'server'].includes(source)) throw Error('Choose phone or server acquisition.');
  if (isNativeSarah()) localStorage.setItem('sarah.civet.source', source);
}
