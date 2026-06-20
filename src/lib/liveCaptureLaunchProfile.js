export const LIVE_CAPTURE_LAUNCH_PROFILE_VERSION = 1;
export const LIVE_CAPTURE_LAUNCH_PROFILE_KEY = "sarah.liveCapture.launchProfile.v1";

export const DEFAULT_LIVE_CAPTURE_LAUNCH_PROFILE = Object.freeze({
  version: LIVE_CAPTURE_LAUNCH_PROFILE_VERSION,
  captureKind: "session",
  captureMode: "full",
  hrSource: "direct_h10",
  pulsoidMode: "websocket",
  obsEnabled: true,
  telemetryOnlyFallback: true,
  emgEnabled: false,
  emgSensorConfig: "generic",
  voiceAnnotationsEnabled: false,
  livePhysiologyCuesEnabled: true,
  cueStyle: "sarah_soft",
  cueVolume: 0.28,
  cuePan: "center",
  mediaDucking: true,
  mediaLayout: "standard",
  howlEnabled: false,
  howlAutoControlEnabled: false,
  displayMode: "full",
  telemetryNoticesEnabled: true,
  heartbeatAudioEnabled: false,
  savedAt: null,
  lastSuccessfulSessionId: null,
});

const SECRET_KEYS = new Set([
  "pulsoidToken",
  "howlRemoteAccessKey",
  "remoteAccessKey",
  "apiKey",
  "token",
  "password",
]);

function storage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
}

function cleanProfile(source = {}) {
  const merged = {
    ...DEFAULT_LIVE_CAPTURE_LAUNCH_PROFILE,
    ...(source || {}),
    version: LIVE_CAPTURE_LAUNCH_PROFILE_VERSION,
  };
  for (const key of Object.keys(merged)) {
    if (SECRET_KEYS.has(key) || /token|secret|password|key/i.test(key)) {
      delete merged[key];
    }
  }
  merged.captureKind = merged.captureKind === "body_exploration" ? "body_exploration" : "session";
  merged.captureMode = String(merged.captureMode || DEFAULT_LIVE_CAPTURE_LAUNCH_PROFILE.captureMode);
  merged.hrSource = String(merged.hrSource || DEFAULT_LIVE_CAPTURE_LAUNCH_PROFILE.hrSource);
  merged.pulsoidMode = String(merged.pulsoidMode || DEFAULT_LIVE_CAPTURE_LAUNCH_PROFILE.pulsoidMode);
  merged.emgSensorConfig = String(merged.emgSensorConfig || DEFAULT_LIVE_CAPTURE_LAUNCH_PROFILE.emgSensorConfig);
  merged.cueStyle = String(merged.cueStyle || DEFAULT_LIVE_CAPTURE_LAUNCH_PROFILE.cueStyle);
  merged.cueVolume = Math.max(0, Math.min(1, Number(merged.cueVolume ?? DEFAULT_LIVE_CAPTURE_LAUNCH_PROFILE.cueVolume)));
  merged.obsEnabled = Boolean(merged.obsEnabled);
  merged.telemetryOnlyFallback = Boolean(merged.telemetryOnlyFallback);
  merged.emgEnabled = Boolean(merged.emgEnabled);
  merged.voiceAnnotationsEnabled = Boolean(merged.voiceAnnotationsEnabled);
  merged.livePhysiologyCuesEnabled = Boolean(merged.livePhysiologyCuesEnabled);
  merged.mediaDucking = Boolean(merged.mediaDucking);
  merged.howlEnabled = Boolean(merged.howlEnabled);
  merged.howlAutoControlEnabled = Boolean(merged.howlAutoControlEnabled);
  merged.telemetryNoticesEnabled = Boolean(merged.telemetryNoticesEnabled);
  merged.heartbeatAudioEnabled = Boolean(merged.heartbeatAudioEnabled);
  return merged;
}

export function readLiveCaptureLaunchProfile() {
  const store = storage();
  if (!store) return { ...DEFAULT_LIVE_CAPTURE_LAUNCH_PROFILE };
  try {
    const parsed = JSON.parse(store.getItem(LIVE_CAPTURE_LAUNCH_PROFILE_KEY) || "null");
    return cleanProfile(parsed || DEFAULT_LIVE_CAPTURE_LAUNCH_PROFILE);
  } catch {
    return { ...DEFAULT_LIVE_CAPTURE_LAUNCH_PROFILE };
  }
}

export function saveLiveCaptureLaunchProfile(profile = {}) {
  const next = cleanProfile({
    ...profile,
    savedAt: new Date().toISOString(),
  });
  const store = storage();
  if (store) store.setItem(LIVE_CAPTURE_LAUNCH_PROFILE_KEY, JSON.stringify(next));
  return next;
}

export function resetLiveCaptureLaunchProfile() {
  const store = storage();
  if (store) store.removeItem(LIVE_CAPTURE_LAUNCH_PROFILE_KEY);
  return { ...DEFAULT_LIVE_CAPTURE_LAUNCH_PROFILE };
}

export function buildLaunchProfileFromRuntime({
  captureKind,
  captureMode,
  hrSourceSettings = {},
  emgSensorConfig,
  telemetryNoticesEnabled,
  heartbeatAudioEnabled,
  howlControlForm = {},
  mediaVideo,
  cueSettings = {},
  liveSession,
} = {}) {
  return cleanProfile({
    captureKind,
    captureMode,
    hrSource: hrSourceSettings.source,
    pulsoidMode: hrSourceSettings.pulsoidMode,
    obsEnabled: true,
    telemetryOnlyFallback: true,
    emgEnabled: Boolean(emgSensorConfig && emgSensorConfig !== "generic"),
    emgSensorConfig,
    livePhysiologyCuesEnabled: cueSettings.enabled !== false,
    cueStyle: cueSettings.style || DEFAULT_LIVE_CAPTURE_LAUNCH_PROFILE.cueStyle,
    cueVolume: cueSettings.volume ?? DEFAULT_LIVE_CAPTURE_LAUNCH_PROFILE.cueVolume,
    cuePan: cueSettings.pan || DEFAULT_LIVE_CAPTURE_LAUNCH_PROFILE.cuePan,
    mediaDucking: cueSettings.mediaDucking !== false,
    mediaLayout: mediaVideo ? "loaded" : "none",
    howlEnabled: Boolean(howlControlForm.controlEnabled),
    howlAutoControlEnabled: Boolean(howlControlForm.sarahAutoEnabled),
    displayMode: captureMode,
    telemetryNoticesEnabled,
    heartbeatAudioEnabled,
    lastSuccessfulSessionId: liveSession?.activeSessionId || null,
  });
}

export function summarizeLaunchProfile(profile = {}) {
  const p = cleanProfile(profile);
  const parts = [];
  parts.push(p.hrSource === "direct_h10" ? "Direct Polar H10" : p.hrSource === "pulsoid" ? "Pulsoid" : "HeartRateOnStream");
  parts.push(p.obsEnabled ? "OBS recording enabled" : "Telemetry-only");
  parts.push(p.emgEnabled ? "EMG enabled" : "Perineal EMG optional");
  parts.push(p.livePhysiologyCuesEnabled ? "Sarah voice cues enabled" : "Sarah voice cues disabled");
  parts.push(p.captureMode === "hr" ? "Distance HR view" : "Full telemetry view");
  return parts;
}
