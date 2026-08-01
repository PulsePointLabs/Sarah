import { useCallback, useEffect, useState } from "react";
import { Mic2, ShieldCheck } from "lucide-react";
import {
  getNativeVoiceOverlayState,
  isNativeVoiceOverlaySupported,
  requestNativeVoiceOverlayPermission,
  setNativeVoiceOverlayEnabled,
} from "@/lib/nativeVoiceOverlay";

export default function VoiceOverlaySettingsPanel() {
  const supported = isNativeVoiceOverlaySupported();
  const [state, setState] = useState({
    native: supported,
    permissionGranted: false,
    enabled: false,
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      setState(await getNativeVoiceOverlayState());
    } catch (error) {
      setMessage(error?.message || "Could not read floating microphone status.");
    }
  }, [supported]);

  useEffect(() => {
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
  }, [refresh]);

  const requestPermission = async () => {
    setBusy(true);
    setMessage("Enable Display over other apps for Sarah, then return here.");
    try {
      await requestNativeVoiceOverlayPermission();
    } catch (error) {
      setMessage(error?.message || "Could not open Android overlay permission.");
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async () => {
    setBusy(true);
    setMessage("");
    try {
      const next = await setNativeVoiceOverlayEnabled(!state.enabled);
      setState(next);
      setMessage(next.enabled
        ? "Floating microphone enabled. Drag the bubble anywhere; tap it to talk with Sarah."
        : "Floating microphone disabled.");
    } catch (error) {
      setMessage(error?.message || "Could not update the floating microphone.");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <div className="flex items-center gap-2 text-primary">
            <Mic2 className="h-4 w-4" />
            <h2 className="text-sm font-bold uppercase tracking-wider">Floating Chat Microphone</h2>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Android only. Shows a draggable microphone over other apps. Tap it anywhere, speak naturally, then pause;
            Sarah transcribes, adds both turns to Profile Chat, and reads her response without pulling Sarah into the foreground.
          </p>
        </div>
        {supported && state.permissionGranted && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-700">
            <ShieldCheck className="h-3.5 w-3.5" />
            Overlay permission granted
          </span>
        )}
      </div>

      {!supported ? (
        <p className="mt-4 rounded-lg bg-muted/25 px-3 py-3 text-sm text-muted-foreground">
          Configure this option in the Sarah APK. Desktop and browser builds keep using the normal in-app microphone.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!state.permissionGranted && (
            <button
              type="button"
              disabled={busy}
              onClick={requestPermission}
              className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              Allow display over other apps
            </button>
          )}
          <button
            type="button"
            disabled={busy || !state.permissionGranted}
            onClick={toggleEnabled}
            className={`rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50 ${
              state.enabled ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"
            }`}
          >
            {state.enabled ? "Disable floating microphone" : "Enable floating microphone"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={refresh}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground disabled:opacity-50"
          >
            Refresh status
          </button>
        </div>
      )}
      {message && <p className="mt-3 text-xs font-semibold text-foreground">{message}</p>}
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Purple is idle, pulsing red is recording, blue is processing, and green is Sarah speaking. The microphone is acquired
        only after a tap and released before transcription, so other dictation apps remain free while the bubble is idle.
        Closing Sarah removes the bubble without forgetting your choice. If it was enabled, Sarah restores it on the next app launch.
        The notification&apos;s Stop action disables it immediately.
      </p>
    </section>
  );
}
