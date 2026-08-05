const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_LINUX_REMOTE_BACKENDS,
  getRemoteBackendCandidates,
  getWebBluetoothSecureContextOverrides,
  isTailscaleIpv4,
  normalizeBackendUrl,
} = require('./remote-backend.cjs');

test('normalizes API and trailing-slash URLs to the backend origin', () => {
  assert.equal(normalizeBackendUrl('https://example.test/api/'), 'https://example.test');
  assert.equal(normalizeBackendUrl('http://10.0.0.2:8787/'), 'http://10.0.0.2:8787');
  assert.equal(normalizeBackendUrl('file:///tmp/sarah'), '');
});

test('Linux uses the shared Sarah backends instead of creating a local database', () => {
  assert.deepEqual(
    getRemoteBackendCandidates({ platform: 'linux', env: {}, configText: '' }),
    [...DEFAULT_LINUX_REMOTE_BACKENDS],
  );
});

test('explicit and user-configured backends take priority and are deduplicated', () => {
  const candidates = getRemoteBackendCandidates({
    platform: 'linux',
    env: { SARAH_REMOTE_BACKEND_URLS: 'http://custom:8787/api,https://benm-desktop.tail980777.ts.net' },
    configText: 'http://custom:8787\nhttp://backup:8787',
  });
  assert.deepEqual(candidates.slice(0, 3), [
    'http://custom:8787',
    'https://benm-desktop.tail980777.ts.net',
    'http://backup:8787',
  ]);
});

test('Windows keeps its local backend unless remote mode is explicitly requested', () => {
  assert.deepEqual(getRemoteBackendCandidates({ platform: 'win32', env: {}, configText: '' }), []);
  assert.deepEqual(getRemoteBackendCandidates({
    platform: 'win32',
    env: { SARAH_REMOTE_BACKEND_URL: 'http://remote:8787/api' },
  }), ['http://remote:8787']);
});

test('SARAH_LOCAL_BACKEND disables remote companion mode', () => {
  assert.deepEqual(getRemoteBackendCandidates({
    platform: 'linux',
    env: { SARAH_LOCAL_BACKEND: '1', SARAH_REMOTE_BACKEND_URL: 'http://remote:8787' },
  }), []);
});

test('recognizes only the CGNAT range reserved for Tailscale addresses', () => {
  assert.equal(isTailscaleIpv4('100.64.0.1'), true);
  assert.equal(isTailscaleIpv4('100.127.255.254'), true);
  assert.equal(isTailscaleIpv4('100.63.255.255'), false);
  assert.equal(isTailscaleIpv4('100.128.0.1'), false);
  assert.equal(isTailscaleIpv4('192.168.0.33'), false);
});

test('limits Web Bluetooth secure-context overrides to exact Tailscale HTTP origins', () => {
  assert.deepEqual(getWebBluetoothSecureContextOverrides([
    'https://benm-desktop.tail980777.ts.net',
    'http://100.65.16.104:8787/api',
    'http://100.65.16.104:8787/',
    'http://192.168.0.33:8787',
    'https://100.65.16.104:8787',
  ]), ['http://100.65.16.104:8787']);
});
