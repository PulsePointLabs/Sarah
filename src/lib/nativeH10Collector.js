import { registerPlugin } from '@capacitor/core';

const plugin = registerPlugin('SarahH10');
const callbacks = new Map();
let listener;
const bytes = (value) => Uint8Array.from(value.match(/.{2}/g) || [], (part) => parseInt(part, 16));

// Same notification/write interface as BleClient; only H10 uses this service-owned connection.
export const NativeH10 = {
  async configure(options) {
    if (!listener) listener = await plugin.addListener('packet', (event) => {
      const data = bytes(event.value);
      const view = new DataView(data.buffer);
      view.receivedAt = event.receivedAt;
      callbacks.get(event.characteristic)?.(view);
    });
    return plugin.configure(options);
  },
  connect(deviceId) { return plugin.connect({ deviceId }); },
  disconnect() { callbacks.clear(); return plugin.disconnect(); },
  status() { return plugin.status(); },
  async startNotifications(deviceId, service, characteristic, callback) {
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
