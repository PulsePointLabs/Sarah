const DEFAULT_LINUX_REMOTE_BACKENDS = Object.freeze([
  'https://benm-desktop.tail980777.ts.net',
  'http://100.65.16.104:8787',
  'http://192.168.0.33:8787',
]);

function normalizeBackendUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  const withoutApi = trimmed.replace(/\/api$/i, '');
  try {
    const parsed = new URL(withoutApi);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function splitBackendUrls(value) {
  return String(value || '')
    .split(/[\r\n,]+/)
    .map(normalizeBackendUrl)
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getRemoteBackendCandidates({
  platform = process.platform,
  env = process.env,
  configText = '',
} = {}) {
  if (String(env.SARAH_LOCAL_BACKEND || '').trim() === '1') return [];

  const explicit = [
    ...splitBackendUrls(env.SARAH_REMOTE_BACKEND_URLS),
    ...splitBackendUrls(env.SARAH_REMOTE_BACKEND_URL),
    ...splitBackendUrls(configText),
  ];

  if (platform !== 'linux' && explicit.length === 0) return [];
  return unique([
    ...explicit,
    ...(platform === 'linux' ? DEFAULT_LINUX_REMOTE_BACKENDS : []),
  ]);
}

module.exports = {
  DEFAULT_LINUX_REMOTE_BACKENDS,
  getRemoteBackendCandidates,
  normalizeBackendUrl,
  splitBackendUrls,
};
