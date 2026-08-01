import { useCallback, useEffect, useState } from "react";
import { Loader2, Mic, MicOff } from "lucide-react";
import {
  getNativeVoiceOverlayState,
  isNativeVoiceOverlaySupported,
  requestNativeVoiceOverlayPermission,
  setNativeVoiceOverlayEnabled,
} from "@/lib/nativeVoiceOverlay";

export default function NativeVoiceOverlayDock() {
  const supported = isNativeVoiceOverlaySupported();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      setState(await getNativeVoiceOverlayState());
    } catch {
      setState((current) => current || { enabled: false, permissionGranted: false });
    }
  }, [supported]);

  useEffect(() => {
    if (!supported) return undefined;
    refresh();
    const handleState = (event) => setState(event.detail);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("sarah:voice-overlay-state", handleState);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("sarah:voice-overlay-state", handleState);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh, supported]);

  if (!supported) return null;

  const toggle = async () => {
    setBusy(true);
    try {
      let current = state || await getNativeVoiceOverlayState();
      if (!current.permissionGranted && !current.enabled) {
        current = await requestNativeVoiceOverlayPermission();
        setState(current);
        if (!current.permissionGranted) return;
      }
      setState(await setNativeVoiceOverlayEnabled(!current.enabled));
    } finally {
      setBusy(false);
    }
  };

  const enabled = Boolean(state?.enabled);
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      className={`fixed bottom-[calc(env(safe-area-inset-bottom)+0.8rem)] left-3 z-[68] inline-flex min-h-12 items-center gap-2 rounded-full border px-4 py-2 text-sm font-bold shadow-xl backdrop-blur-md transition-colors disabled:opacity-60 ${
        enabled
          ? "border-primary/40 bg-primary text-primary-foreground"
          : "border-border bg-card/95 text-muted-foreground"
      }`}
      aria-pressed={enabled}
      aria-label={enabled ? "Disable floating Sarah microphone" : "Enable floating Sarah microphone"}
      title={enabled ? "Floating Sarah microphone is on" : "Floating Sarah microphone is off"}
    >
      {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : enabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
      <span>{enabled ? "Sarah mic on" : "Sarah mic off"}</span>
    </button>
  );
}
