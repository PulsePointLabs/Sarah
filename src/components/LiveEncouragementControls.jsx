import { Volume2 } from "lucide-react";
import { liveCuePlaybackMessage } from "@/lib/liveCueAudioReadiness";

export default function LiveEncouragementControls({ enabled, volume, audioState, status, playback, onToggle, onTest, onVolume }) {
  const message = !enabled ? "Encouragement is off on this device."
    : volume === 0 ? liveCuePlaybackMessage("muted")
    : status.phase === "error" ? status.message
    : audioState !== "running" ? "Tap Test voice to enable and check audio on this device."
    : status.phase === "preparing" ? status.message
    : playback?.ok === false ? liveCuePlaybackMessage(playback.reason)
    : status.phase === "ready" ? "Voice ready. Automatic cues follow supported telemetry changes."
    : "Tap Test voice to preload and check Sarah's voice.";

  return (
    <section className="rounded-xl border border-border bg-card p-3" aria-label="Sarah encouragement audio">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-sm font-semibold"><Volume2 className="h-4 w-4" /> Sarah encouragement</span>
        <button type="button" onClick={onToggle} aria-pressed={enabled} className="rounded-lg border border-border px-3 py-2 text-sm">{enabled ? "On" : "Off"}</button>
        <label className="flex items-center gap-2 text-sm">
          Volume
          <input type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => onVolume(Number(event.target.value))} aria-label="Sarah encouragement volume" className="w-28 accent-primary" />
          <span className="w-10 tabular-nums">{Math.round(volume * 100)}%</span>
        </label>
        <button type="button" onClick={onTest} disabled={!enabled || status.phase === "preparing"} className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{status.phase === "preparing" ? "Preparing voice…" : "Test voice"}</button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground" role="status">{message}</p>
    </section>
  );
}
