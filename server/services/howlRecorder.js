import { randomUUID } from 'node:crypto';
import { normalizeHowlTelemetrySample } from './howlTelemetry.js';

// Read-only collector. Never issues stimulation commands. Dependencies are injected
// so session rollover and connection loss can be tested without a physical device.
export function createHowlRecorder({ getSession, readStatus, save, now = Date.now }) {
  let busy = false, sessionId = null, fingerprint = null, lastSaved = 0, connected = null;
  let previousObserved = null, previousPlayer = null;
  return async function tick() {
    if (busy) return;
    const session = getSession();
    if (!session?.id || !Number.isFinite(Date.parse(session.startedAt))) { sessionId = null; fingerprint = null; connected = null; previousObserved = null; previousPlayer = null; return; }
    if (session.id !== sessionId) { sessionId = session.id; fingerprint = null; lastSaved = 0; connected = null; previousObserved = null; previousPlayer = null; }
    busy = true;
    const requestedAt = now();
    try {
      const raw = await readStatus();
      if (!raw || getSession()?.id !== session.id) return;
      const at = now();
      const sample = normalizeHowlTelemetrySample({ ...raw, session: session.id, measured_at: new Date(at).toISOString() });
      // Player position is sampled with snapshots but does not create an event on every tick.
      const state = { ...sample.raw, player: sample.raw?.player ? { ...sample.raw.player, position: undefined } : undefined };
      delete state.session; delete state.measured_at;
      const nextFingerprint = JSON.stringify(state);
      const elapsed = previousObserved == null ? 0 : (at-previousObserved)/1000;
      const expectedPosition = Number(previousPlayer?.position) + (previousPlayer?.playing ? elapsed : 0);
      const seeked = previousPlayer?.position != null && raw.player?.position != null
        && Math.abs(Number(raw.player.position)-expectedPosition) > Math.max(1, elapsed);
      const changed = fingerprint !== nextFingerprint || seeked;
      if (changed || !connected || at - lastSaved >= 5000) {
        save({ ...sample, time_offset_s: Math.max(0, (at - Date.parse(session.startedAt)) / 1000),
          origin: 'howl_status_observed', connection_state: 'connected',
          is_change: changed || !connected, observation_started_at: new Date(requestedAt).toISOString(),
          previous_observed_at: previousObserved == null ? null : new Date(previousObserved).toISOString(),
          timing_basis: 'desktop_receipt', polling_interval_ms: 500 });
        fingerprint = nextFingerprint; lastSaved = at;
      }
      connected = true; previousObserved = at; previousPlayer = raw.player;
    } catch {
      if (connected !== false && getSession()?.id === session.id) {
        const at = now();
        save({ id: randomUUID(), session: session.id, source: 'howl', measured_at: new Date(at).toISOString(),
          time_offset_s: Math.max(0, (at - Date.parse(session.startedAt)) / 1000),
          origin: 'howl_status_observed', connection_state: 'disconnected', is_change: true });
      }
      connected = false;
    } finally { busy = false; }
  };
}
