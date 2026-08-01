import { useEffect } from "react";
import {
  configureNativeVoiceOverlay,
  ensureNativeVoiceOverlayRunning,
  isNativeVoiceOverlaySupported,
} from "@/lib/nativeVoiceOverlay";
import { API_BASE } from "@/lib/mobileApiBase";
import { readSttProviderPreference } from "@/lib/sttSettings";
import {
  readSarahPersonalitySettings,
  SARAH_PERSONALITY_EVENT,
} from "@/utils/sarahPersonality";
import {
  INTIMATE_REFLECTION_SETTINGS_EVENT,
  readIntimateReflectionSettings,
} from "@/lib/intimateReflectionSettings";
import {
  getTTSRuntime,
  loadTTSSettings,
  TTS_SETTINGS_EVENT,
} from "@/components/TTSButton";

export default function VoiceOverlayCoordinator() {
  useEffect(() => {
    if (!isNativeVoiceOverlaySupported()) return undefined;
    const configuration = () => {
      const ttsRuntime = getTTSRuntime(loadTTSSettings());
      return {
        apiBase: API_BASE,
        sttProvider: readSttProviderPreference(),
        personalitySettings: JSON.stringify(readSarahPersonalitySettings()),
        intimateChatSettings: JSON.stringify(readIntimateReflectionSettings()),
        ttsSettings: JSON.stringify({
          voice: "nova",
          model: ttsRuntime.model,
          speed: ttsRuntime.speed,
          format: ttsRuntime.format,
          instructions: ttsRuntime.supportsInstructions ? ttsRuntime.instructions : "",
        }),
      };
    };
    const syncConfiguration = () => {
      const next = configuration();
      configureNativeVoiceOverlay(next).catch(() => {});
      ensureNativeVoiceOverlayRunning(next).catch(() => {});
    };

    syncConfiguration();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") syncConfiguration();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener(SARAH_PERSONALITY_EVENT, syncConfiguration);
    window.addEventListener(INTIMATE_REFLECTION_SETTINGS_EVENT, syncConfiguration);
    window.addEventListener(TTS_SETTINGS_EVENT, syncConfiguration);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener(SARAH_PERSONALITY_EVENT, syncConfiguration);
      window.removeEventListener(INTIMATE_REFLECTION_SETTINGS_EVENT, syncConfiguration);
      window.removeEventListener(TTS_SETTINGS_EVENT, syncConfiguration);
    };
  }, []);

  return null;
}
