import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile(new URL('../../src/lib/nativeH10Collector.js', import.meta.url), 'utf8');
let packetListener;
let subscriptions = 0;
let listeners = 0;
const plugin = {
  addListener: async (_event, callback) => { listeners++; packetListener = callback; return { remove() {} }; },
  notifications: async () => { subscriptions++; },
  disconnect: async () => {},
};
const context = { registerPlugin: () => plugin };
vm.runInNewContext(source.replace(/^import .*;\r?\n/m, '').replace('export const NativeH10', 'globalThis.NativeH10'), context);
const bridge = context.NativeH10;
const received = [];
const remove = await bridge.observe('hr', (view) => received.push([view.getUint8(1), view.receivedAt]));
packetListener({ characteristic: 'hr', value: '005A', receivedAt: 1234 });
assert.deepEqual(received, [[90, 1234]]);
assert.equal(subscriptions, 0, 'restored service observation never resets BLE subscriptions');
remove();
packetListener({ characteristic: 'hr', value: '005B', receivedAt: 1235 });
assert.equal(received.length, 1, 'unmounted page detaches its callback');
await bridge.startNotifications('device', 'service', 'hr', (view) => received.push([view.getUint8(1), view.receivedAt]));
assert.equal(listeners, 1, 'one bridge listener survives page re-entry');
packetListener({ characteristic: 'hr', value: '005C', receivedAt: 1236 });
assert.deepEqual(received[1], [92, 1236]);
await bridge.disconnect();
packetListener({ characteristic: 'hr', value: '005D', receivedAt: 1237 });
assert.equal(received.length, 2);
console.log('PASS: restored-service observer, original timestamps, unmount cleanup, reconnect, no duplicate bridge listeners');
