import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { dataDir, liveCaptureConfig } from '../config.js';
import { ObsPeer } from './obsPeer.js';

let instance = null;
export const getObsRecordingCoordinator = () => instance;
export const setObsRecordingCoordinator = (value) => { instance = value; };

export function validateSecondarySettings(input, previous = {}) {
  const enabled = input.enabled === true;
  const raw = String(input.url ?? previous.url ?? '').trim();
  let url = '';
  if (raw) {
    const parsed = new URL(raw);
    if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      throw new Error('Use an OBS WebSocket address such as ws://second-computer:4455. Enter its password separately.');
    }
    const canonical = (value) => {
      const item = new URL(value);
      const local = new Set(['localhost', '127.0.0.1', '[::1]', os.hostname().toLowerCase(),
        ...Object.values(os.networkInterfaces()).flat().filter(Boolean).map((network) => network.address)]);
      return `${local.has(item.hostname.toLowerCase()) ? 'loopback' : item.hostname}:${item.port || '4455'}`;
    };
    if (canonical(raw) === canonical(liveCaptureConfig.hrObsWsUrl)) throw new Error('Secondary OBS must be a different OBS instance from the primary.');
    url = parsed.href;
  }
  if (enabled && !url) throw new Error('Enter the secondary OBS address before enabling it.');
  return { enabled, url, password: input.clearPassword ? '' : input.password || previous.password || '' };
}

export class ObsRecordingCoordinator {
  constructor({ primary, onChange = () => {}, directory = path.join(dataDir, 'obs-recording'), peerFactory = (options) => new ObsPeer(options) }) {
    Object.assign(this, { primary, onChange, directory, peerFactory });
    this.settings = { enabled: false, url: '', password: '' };
    this.secondary = { connected: false, recording: false, paused: false, error: '' };
    this.run = null;
    this.inflight = new Map();
    try { this.settings = validateSecondarySettings(JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'))); } catch { /* Optional until configured. */ }
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(directory, 'latest.json'), 'utf8'));
      if (/^[a-f0-9-]{36}$/i.test(saved.id) && saved.primary && saved.secondary && Array.isArray(saved.warnings)) {
        this.run = saved; this.restoredRun = true; this.followStartRunId = saved.id;
      }
    } catch { /* No previous coordinated recording. */ }
  }
  start() {
    this.connectSecondary();
    this.pollTimer = setInterval(() => this.poll().catch(() => {}), 2000);
    this.pollTimer.unref?.();
    return this;
  }
  close() { clearInterval(this.pollTimer); this.peer?.close(); }
  publicSettings() { const { enabled, url, password } = this.settings; return { enabled, url, passwordSaved: Boolean(password) }; }
  snapshot() {
    return { settings: this.publicSettings(), primary: this.primary.status(), secondary: { ...this.secondary, connected: Boolean(this.peer?.ready) }, run: this.run };
  }
  changed() {
    const snapshot = this.snapshot();
    const signature = JSON.stringify(snapshot);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    if (this.run) {
      try {
        fs.mkdirSync(this.directory, { recursive: true });
        for (const name of [`${this.run.id}.json`, 'latest.json']) {
          const target = path.join(this.directory, name);
          fs.writeFileSync(`${target}.tmp`, JSON.stringify(this.run, null, 2), { mode: 0o600 });
          fs.renameSync(`${target}.tmp`, target);
        }
      } catch {
        const warning = 'Recorder timing metadata could not be saved on the Sarah server.';
        if (!this.run.warnings.includes(warning)) this.run.warnings.push(warning);
      }
    }
    this.onChange(snapshot);
  }
  save(input) {
    if (this.primary.status().recording || this.secondary.recording || this.inflight.size) throw new Error('Stop both recordings before changing the secondary OBS connection.');
    this.settings = validateSecondarySettings(input, this.settings);
    fs.mkdirSync(this.directory, { recursive: true });
    const target = path.join(this.directory, 'settings.json');
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(this.settings), { mode: 0o600 });
    fs.renameSync(`${target}.tmp`, target);
    this.connectSecondary(); this.changed();
    return this.snapshot();
  }
  connectSecondary() {
    this.peer?.close(); this.peer = null;
    this.secondary = { connected: false, recording: false, paused: false, error: '' };
    if (!this.settings.enabled) return;
    this.peer = this.peerFactory({ ...this.settings,
      onChange: () => {
        this.secondary.error = this.peer?.error || '';
        this.changed();
        if (this.peer?.ready) this.poll().catch(() => {});
      },
      onEvent: (type, data) => { if (type === 'RecordStateChanged') this.secondaryEvent(data); },
    });
    this.peer.connect();
  }
  begin(origin) {
    if (this.run && !this.run.primary?.stoppedAt && !this.run.failedStart && !this.run.reconciledInactiveAt) return;
    this.run = { id: randomUUID(), origin, requestedAt: new Date().toISOString(), secondaryUrl: this.settings.url,
      primary: {}, secondary: {}, timing: null, warnings: [] };
    this.changed();
  }
  warn(message) {
    this.secondary.error = message;
    if (this.run && !this.run.warnings.includes(message)) this.run.warnings.push(message);
    this.changed();
  }
  once(key, operation) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const promise = Promise.resolve().then(operation).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
  async secondaryCommand(action) {
    if (!this.settings.enabled) return {};
    return this.once(`secondary:${action}`, async () => {
      if (!this.peer?.ready) throw new Error('Secondary OBS is unavailable; the primary recording remains independent.');
      const before = await this.peer.request('GetRecordStatus');
      if (action === 'StartRecord' && before.outputActive) {
        this.secondary.recording = true;
        if (this.run && !this.run.secondary.startedAt) this.warn('Secondary OBS was already recording; its beginning is not synchronized to this session.');
        return {};
      }
      if (action === 'StopRecord' && !before.outputActive) return {};
      if (action === 'PauseRecord' && (!before.outputActive || before.outputPaused)) return {};
      if (action === 'ResumeRecord' && (!before.outputActive || !before.outputPaused)) return {};
      const result = await this.peer.request(action);
      if (result.outputPath && this.run) this.run.secondary.outputPath = result.outputPath;
      await this.poll(); this.changed();
      return result;
    });
  }
  startRecording() {
    return this.once('start', async () => {
      if (this.primary.status().recording) return {};
      if (!this.settings.enabled) return this.primary.request('StartRecord');
      this.begin('sarah');
      // Preflight both endpoints first. Then issue both StartRecord commands without
      // waiting for either request's network response or recording-start event.
      const secondaryStatus = this.settings.enabled && this.peer?.ready
        ? await this.peer.request('GetRecordStatus').catch((error) => { this.warn(error.message); return null; }) : null;
      if (!this.primary.status().identified) { this.run.failedStart = true; this.changed(); throw new Error('Primary OBS is not ready'); }
      this.followStartRunId = this.run.id;
      const primary = this.primary.request('StartRecord');
      const secondary = this.settings.enabled && secondaryStatus && !secondaryStatus.outputActive
        ? this.once('secondary:StartRecord', () => this.peer.request('StartRecord'))
        : Promise.resolve();
      if (this.settings.enabled && !secondaryStatus) this.warn('Secondary OBS is unavailable; only the primary was started.');
      if (secondaryStatus?.outputActive) this.warn('Secondary OBS was already recording; its beginning is not synchronized to this session.');
      const results = await Promise.allSettled([primary, secondary]);
      if (results[1].status === 'rejected') this.warn(results[1].reason.message);
      if (results[0].status === 'rejected') { this.run.failedStart = true; this.changed(); throw results[0].reason; }
      await this.poll(); this.changed();
      return results[0].value;
    });
  }
  stopRecording() {
    return this.once('stop', async () => {
      if (!this.settings.enabled) return this.primary.request('StopRecord');
      const results = await Promise.allSettled([this.primary.request('StopRecord'), this.secondaryCommand('StopRecord')]);
      if (results[1].status === 'rejected') this.warn(results[1].reason.message);
      if (results[0].status === 'rejected') throw results[0].reason;
      if (this.run) this.run.primary.outputPath = results[0].value?.outputPath || this.run.primary.outputPath;
      this.changed(); return results[0].value;
    });
  }
  primaryEvent(data) {
    if (!this.settings.enabled) return;
    const state = String(data.outputState || '');
    if (state.endsWith('_STARTING') || state.endsWith('_STARTED')) {
      this.begin('primary_obs');
      if (state.endsWith('_STARTED')) this.run.primary.startedAt ||= new Date().toISOString();
      if (!this.inflight.has('start') && this.followStartRunId !== this.run.id) {
        this.followStartRunId = this.run.id;
        this.secondaryCommand('StartRecord').catch((error) => this.warn(error.message));
      }
    } else if (state.endsWith('_STOPPING') || state.endsWith('_STOPPED')) {
      if (this.run && state.endsWith('_STOPPED')) {
        this.run.primary.stoppedAt = new Date().toISOString();
        this.run.primary.outputPath = data.outputPath || this.run.primary.outputPath;
      }
      this.secondaryCommand('StopRecord').catch((error) => this.warn(error.message));
    } else if (state.endsWith('_PAUSED') || state.endsWith('_RESUMED')) {
      this.secondaryCommand(state.endsWith('_PAUSED') ? 'PauseRecord' : 'ResumeRecord').catch((error) => this.warn(error.message));
    }
    this.changed();
  }
  secondaryEvent(data) {
    const state = String(data.outputState || '');
    if (state.endsWith('_STARTED')) { this.secondary.recording = true; if (this.run) this.run.secondary.startedAt ||= new Date().toISOString(); }
    if (state.endsWith('_STOPPED')) {
      this.secondary.recording = false;
      if (this.run) Object.assign(this.run.secondary, { stoppedAt: new Date().toISOString(), outputPath: data.outputPath });
      if (this.primary.status().recording && !this.inflight.has('stop') && !this.inflight.has('secondary:StopRecord')) this.warn('Secondary OBS stopped while the primary is still recording.');
    }
    if (state.endsWith('_PAUSED')) this.secondary.paused = true;
    if (state.endsWith('_RESUMED')) this.secondary.paused = false;
    this.changed();
  }
  async poll() {
    if (this.polling || !this.settings.enabled || !this.peer?.ready) return;
    this.polling = true;
    try {
      const sample = async (request) => {
        const before = Date.now(); const data = await request('GetRecordStatus'); const after = Date.now();
        return { ...data, estimatedStartMs: (before + after) / 2 - Number(data.outputDuration || 0), uncertaintyMs: (after - before) / 2 };
      };
      const [primary, secondary] = await Promise.allSettled([sample(this.primary.request), sample((type) => this.peer.request(type))]);
      if (this.restoredRun && primary.status === 'fulfilled') {
        if (!primary.value.outputActive && this.run && !this.run.primary.stoppedAt) this.run.reconciledInactiveAt = new Date().toISOString();
        this.restoredRun = false;
      }
      if (secondary.status === 'fulfilled') {
        this.secondary.recording = secondary.value.outputActive;
        this.secondary.paused = secondary.value.outputPaused;
        this.secondary.error = '';
      } else {
        this.secondary.error = secondary.reason.message;
      }
      if (this.run && !this.run.timing && primary.status === 'fulfilled' && secondary.status === 'fulfilled'
        && primary.value.outputActive && secondary.value.outputActive && !primary.value.outputPaused && !secondary.value.outputPaused) {
        this.run.timing = { estimatedStartDifferenceMs: Math.round(secondary.value.estimatedStartMs - primary.value.estimatedStartMs),
          networkUncertaintyMs: Math.ceil(primary.value.uncertaintyMs + secondary.value.uncertaintyMs),
          method: 'obs_output_duration_network_midpoint', frameAlignmentVerified: false };
      }
      this.changed();
    } finally { this.polling = false; }
  }
}
