// This connection is display-only. Closing it never stops native acquisition.
export const ownsMonitoringHistory = monitor => monitor?.version === 1 && (monitor.active === true || monitor.paused === true);

export function canUseServerPrediction(monitor, hr, now = Date.now()) {
  if (!ownsMonitoringHistory(monitor) || monitor.paused || monitor.stale || monitor.error || !monitor.prediction) return false;
  const at = Number(monitor.latestAt);
  const sensorAt = freshTelemetryTimestamp(hr, null, now);
  return at > 0 && now - at <= 5000 && at <= now + 5000 && sensorAt != null && Math.abs(sensorAt - at) <= 5000;
}

export function preferLiveHrTelemetry(incoming, current, now = Date.now()) {
  const currentAt = freshTelemetryTimestamp(current, null, now);
  if (currentAt == null || incoming && incoming.source !== current?.source) return incoming;
  const incomingAt = freshTelemetryTimestamp(incoming, null, now);
  return incomingAt == null || incomingAt < currentAt ? current : incoming;
}

export function freshTelemetryTimestamp(hr, emg, now = Date.now()) {
  const value = hr?.measuredAt || hr?.receivedAt || emg?.source_at || emg?.receivedAt;
  const at = Number(value) || Date.parse(value || '');
  return Number.isFinite(at) && now - at <= 5000 && at <= now + 5000 && !hr?.quality?.stale ? at : null;
}

export function createResumableLiveStream(url, {
  EventSourceClass = EventSource, visibility = document, onResume = () => {},
} = {}) {
  const handlers = new Map();
  let current = null, stopped = false;
  const wrapper = {
    onopen: null, onerror: null,
    addEventListener(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      current?.addEventListener(name, guarded(handler, current));
    },
    resume() { if (!stopped) { connect(); onResume(); } },
    close() { stopped = true; current?.close(); visibility.removeEventListener('visibilitychange', visible); },
  };
  function guarded(handler, source) { return event => { if (!stopped && source === current) handler(event); }; }
  function connect() {
    current?.close();
    const source = new EventSourceClass(url);
    current = source;
    source.onopen = guarded(event => wrapper.onopen?.(event), source);
    source.onerror = guarded(event => wrapper.onerror?.(event), source);
    for (const [name, listeners] of handlers) for (const listener of listeners) source.addEventListener(name, guarded(listener, source));
  }
  function visible() { if (visibility.visibilityState === 'visible') wrapper.resume(); }
  visibility.addEventListener('visibilitychange', visible);
  connect();
  return wrapper;
}

export function mergeMonitoringPoints(previous, incoming) {
  const combined = new Map();
  for (const point of [...previous, ...incoming]) if (point && Number.isFinite(point.ts)) combined.set(point.ts, point);
  return [...combined.values()].sort((a, b) => a.ts - b.ts).slice(-3600);
}
