import { useMemo } from "react";
import { totalEpisodeSeconds, subjectiveProximity } from "../lib/subjectiveNearClimax.js";
import { buildPhaseEvidence, phaseBandsFromPoints } from "../lib/videoSyncPhaseEvidence.js";
const time = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
export default function SubjectiveNearClimaxEpisodes({ episodes, timelineRows, onSeekTime, onSeek, onToggle, onDelete, error, saving, onRetry }) {
  const highApproach = useMemo(() => phaseBandsFromPoints(buildPhaseEvidence(timelineRows).points).filter((b) => b.phase === "approach"), [timelineRows]);
  return <section className="space-y-3" aria-label="Subjective near-climax episodes">
    <div className="flex flex-wrap items-center gap-2">{[["near_climax", "Near climax", "N"], ["climax", "Climax", "C"]].map(([kind, label, key]) =>
      <button key={kind} type="button" onClick={() => onToggle(kind)} className="rounded border border-violet-400/40 px-3 py-2 text-xs text-violet-400">
        {episodes.some((e) => e.end_s == null && (e.kind || "near_climax") === kind) ? "End" : "Start"} {label} ({key})</button>)}
      <span className="text-xs text-muted-foreground">Your subjective markers · {error ? "Not saved" : saving ? "Saving…" : "Saved"}</span></div>
    <div className="flex flex-wrap gap-4 rounded border border-border p-3 text-sm">
      <span>Marked near climax: <b>{totalEpisodeSeconds(episodes, "near_climax").toFixed(1)}s</b></span>
      <span>Marked climax: <b>{totalEpisodeSeconds(episodes, "climax").toFixed(1)}s</b></span>
      <span>High-approach candidates: <b>{highApproach.length}</b> · {highApproach.reduce((sum, b) => sum + b.end - b.start, 0).toFixed(1)}s total</span>
    </div>
    <p className="text-xs text-muted-foreground">Marked totals include completed episodes, without counting overlaps twice. High-approach bands use the card's estimate; they are not confirmed threshold or climax.</p>
    <details className="text-xs"><summary className="cursor-pointer">High-approach / near-threshold candidate durations ({highApproach.length})</summary>
      <div className="mt-2 flex flex-wrap gap-2">{highApproach.map((b) => <button key={b.start} type="button" onClick={() => onSeekTime(b.start)} className="rounded border border-orange-400/30 p-2">
        {time(b.start)}–{time(b.end)} · {(b.end - b.start).toFixed(1)}s</button>)}</div></details>
    {error && <p role="alert" className="text-sm text-red-400">{error} <button type="button" onClick={onRetry} className="underline">Retry save</button></p>}
    {!episodes.length && <p className="text-sm text-muted-foreground">No subjective episodes yet. Press N at the start, then N again at the end.</p>}
    {episodes.map((saved) => { const e = { ...saved, proximity: subjectiveProximity(saved, episodes, saved.proximity) }; return <article key={e.id} className="flex gap-3 rounded-xl border border-violet-400/20 p-3">
      <button type="button" onClick={() => onSeek(e)} className="w-36 shrink-0 self-start" title="Jump to episode start">
        {e.thumbnail_url ? <img src={e.thumbnail_url} alt={`Episode start ${time(e.start_s)}`} className="aspect-video w-full rounded object-contain bg-black" /> : <span className="text-xs">Open start frame</span>}
        <span className="text-xs text-violet-400">{time(e.start_s)} · {e.source?.label || "Selected camera"}</span></button>
      <div className="min-w-0 flex-1 text-xs"><p className="font-semibold">{e.kind === "climax" ? "Climax" : "Near climax"} · {time(e.start_s)} → {e.end_s == null ? `Open — press ${e.kind === "climax" ? "C" : "N"} to finish` : `${time(e.end_s)} · ${e.duration_s.toFixed(1)} seconds`}</p>
        {e.telemetry && <><p className="mt-1">HR {e.telemetry.hr_start ?? "—"} → {e.telemetry.hr_end ?? "—"} bpm · range {e.telemetry.hr_min ?? "—"}–{e.telemetry.hr_max ?? "—"} · mean {e.telemetry.hr_mean ?? "—"}</p>
          <p>Median RMSSD {e.telemetry.rmssd_median_ms?.toFixed(1) ?? "—"} ms · peak approach evidence {e.telemetry.approach_peak ?? "—"}/100 · {e.telemetry.hr_sample_count} HR samples</p></>}
        {e.end_s != null && e.kind !== "climax" && <p className="mt-1 text-muted-foreground">{e.proximity ? `${e.proximity.kind} at ${time(e.proximity.time_s)}: ${e.proximity.relative_to_episode_s === 0 ? "within this episode" : `${Math.abs(e.proximity.relative_to_episode_s).toFixed(1)}s ${e.proximity.relative_to_episode_s > 0 ? "after the episode ends" : "before the episode starts"}`}.` : "No logged climax or high-approach candidate available for comparison."}</p>}
        <button type="button" onClick={() => onDelete(e.id)} className="mt-2 text-muted-foreground underline">{e.end_s == null ? "Cancel open episode" : "Remove episode"}</button>
      </div>
    </article>; })}
  </section>;
}
