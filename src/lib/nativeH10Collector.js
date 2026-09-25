import { registerPlugin } from '@capacitor/core';

const plugin = registerPlugin('SarahH10');
const callbacks = new Map();
let listener;
const bytes = (value) => Uint8Array.from(value.match(/.{2}/g) || [], (part) => parseInt(part, 16));

function observePackets() {
  // A restored service can already be collecting when a fresh WebView opens.
  // Subscribe even when no new connect/configure operation is necessary.
  if (!listener) listener = plugin.addListener('packet', (event) => {
    const data = bytes(event.value);
    const view = new DataView(data.buffer);
    view.receivedAt = event.receivedAt;
    callbacks.get(event.characteristic)?.(view);
  }).catch((error) => { listener = null; throw error; });
  return listener;
}

// Same notification/write interface as BleClient; only H10 uses this service-owned connection.
export const NativeH10 = {
  async configure(options) {
    await observePackets();
    return plugin.configure(options);
  },
  connect(deviceId) { return plugin.connect({ deviceId }); },
  disconnect() { callbacks.clear(); return plugin.disconnect(); },
  status() { return plugin.status(); },
  async observe(characteristic, callback) {
    await observePackets();
    callbacks.set(characteristic, callback);
    return () => { if (callbacks.get(characteristic) === callback) callbacks.delete(characteristic); };
  },
  async startNotifications(deviceId, service, characteristic, callback) {
    await observePackets();
    callbacks.set(characteristic, callback);
    return plugin.notifications({ service, characteristic, enabled: true });
  },
  async stopNotifications(deviceId, service, characteristic) {
    callbacks.delete(characteristic);
    return plugin.notifications({ service, characteristic, enabled: false });
  },
  write(deviceId, service, characteristic, value, options = {}) {
    const data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return plugin.write({ value: [...data].map((v) => v.toString(16).padStart(2, '0')).join(''), timeout: options.timeout || 12000 });
  },
};
