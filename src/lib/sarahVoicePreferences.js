import { base44 } from "@/api/base44Client";
import { getTTSRuntime, loadTTSSettings, saveTTSSettings, TTS_SETTINGS_KEY } from "@/components/TTSButton";
import {
  readSarahPersonalitySettings,
  saveSarahPersonalitySettings,
  SARAH_PERSONALITY_STORAGE_KEY,
} from "@/utils/sarahPersonality";

const pendingKey = "sarah.voice-preferences.pending";
let operation = Promise.resolve();

function inOrder(work) {
  const next = operation.then(work);
  operation = next.catch(() => {});
  return next;
}

function pendingPreferences() {
  try {
    return JSON.parse(localStorage.getItem(pendingKey) || "{}") || {};
  } catch {
    return {};
  }
}

function applyPreferences(profile) {
  if (profile.tts && JSON.stringify(profile.tts) !== localStorage.getItem(TTS_SETTINGS_KEY)) {
    saveTTSSettings(profile.tts);
  }
  if (profile.personality && JSON.stringify(profile.personality) !== localStorage.getItem(SARAH_PERSONALITY_STORAGE_KEY)) {
    saveSarahPersonalitySettings(profile.personality);
  }
}

async function sendPending() {
  const pending = pendingPreferences();
  if (!Object.keys(pending).length) return null;
  const profile = await base44.auth.updateVoicePreferences(pending);
  localStorage.removeItem(pendingKey);
  return profile;
}

export function refreshSarahVoicePreferences({ seed = false } = {}) {
  return inOrder(async () => {
    let profile = await sendPending() || await base44.auth.voicePreferences();
    if (seed) {
      const saved = {};
      if (!profile.tts && localStorage.getItem(TTS_SETTINGS_KEY)) saved.tts = loadTTSSettings();
      if (!profile.personality && localStorage.getItem(SARAH_PERSONALITY_STORAGE_KEY)) {
        saved.personality = readSarahPersonalitySettings();
      }
      if (Object.keys(saved).length) profile = await base44.auth.updateVoicePreferences(saved, { seed: true });
    }
    applyPreferences(profile);
  });
}

export function syncSavedSarahVoicePreferences(changes) {
  return inOrder(async () => {
    localStorage.setItem(pendingKey, JSON.stringify({ ...pendingPreferences(), ...changes }));
    applyPreferences(changes);
    applyPreferences(await sendPending());
  });
}

export async function getSyncedSarahTTSRuntime() {
  // Existing clients and offline playback can still use their saved local preferences.
  await refreshSarahVoicePreferences().catch(() => {});
  return getTTSRuntime();
}
