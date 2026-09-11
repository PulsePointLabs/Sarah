import { useMemo, useState } from "react";
import { episodeReviewContext, slimSeriesPath, episodeClock as time, episodeDuration } from "../lib/episodeReviewContext.js";
import { PHASE_COLORS } from "../lib/videoSyncPhaseEvidence.js";

const HR_LINES = [{ key: "hr", label: "HR", color: "#14b8a6" }, { key: "smoothed", label: "Smoothed", color: "#ec4899" }, { key: "baseline", label: "Baseline", color: "#64748b", dash: true }];
const HRV_LINES = [{ key: "rmssd", label: "RMSSD", color: "#14b8a6" }, { key: "sdnn", label: "SDNN", color: "#8b5cf6" }];
const PHASE_LINES = [{ key: "approach", label: "Approach", color: "#fb7185" }, { key: "plateau", label: "Plateau", color: "#fb923c", dash: true }, { key: "recovery", label: "Release / recovery", color: "#38bdf8" }];
const display = (v) => v == null ? "—" : v.toFixed(1);

function SlimTimeline({ title, rows, lines, context, onSeek, score = false, footer }) {
  const [hover, setHover] = useState(null);
  const values = rows.flatMap((r) => lines.map((l) => r[l.key]).filter((v) => v != null && Number.isFinite(v)));
  const lo = score ? 0 : values.length ? Math.floor(Math.min(...values) - 2) : 0;
  const hi = score ? 100 : values.length ? Math.ceil(Math.max(...values) + 2) : 1;
  const x = (t) => 30 + (t - context.domain[0]) / (context.domain[1] - context.domain[0]) * 360;
  const y = (v) => 66 - (v - lo) / (hi - lo) * 51;
  const pointerTime = (event) => { const rect = event.currentTarget.getBoundingClientRect();
    return context.domain[0] + Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * 400 - 30) / 360)) * (context.domain[1] - context.domain[0]); };
  const nearest = hover == null ? null : rows.reduce((best, row) => !best || Math.abs(row.t - hover) < Math.abs(best.t - hover) ? row : best, null);
  const sample = nearest && Math.abs(nearest.t - hover) <= 1 ? nearest : null;
  return <div className="min-w-0 rounded-lg border border-white/5 bg-black/10 px-2 py-1.5">
    <div className="flex flex-wrap items-center justify-between gap-x-2 text-[9px]"><span className="font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
      <span className="flex gap-2">{lines.map((l) => <span key={l.key} style={{ color: l.color }}>{l.label}</span>)}</span></div>
    <svg viewBox="0 0 400 86" role="img" aria-label={`${title}: 30-second surrounding context; episode shaded`} className="h-[76px] w-full cursor-crosshair" preserveAspectRatio="none"
      onPointerMove={(e) => setHover(pointerTime(e))} onPointerLeave={() => setHover(null)} onClick={(e) => onSeek(pointerTime(e))}>
      <rect x={x(context.start)} y="12" width={Math.max(1, x(context.end) - x(context.start))} height="57" fill="#a78bfa" opacity=".12" />
      {[lo, hi].map((v) => <g key={v}><line x1="30" x2="390" y1={y(v)} y2={y(v)} stroke="currentColor" opacity=".08" /><text x="0" y={y(v) + 3} fontSize="8" fill="currentColor" opacity=".6">{v}</text></g>)}
      {lines.map((l) => <path key={l.key} d={slimSeriesPath(rows, l.key, x, y)} stroke={l.color} strokeWidth="1.7" strokeDasharray={l.dash ? "4 3" : undefined} fill="none" />)}
      {[context.start, context.end].map((t, i) => <line key={i} x1={x(t)} x2={x(t)} y1="12" y2="69" stroke="#c4b5fd" strokeDasharray="2 3" opacity=".8" />)}
      {hover != null && <><line x1={x(hover)} x2={x(hover)} y1="12" y2="69" stroke="currentColor" opacity=".6" />
        <text x="32" y="9" fontSize="8" fill="currentColor">{`${time(hover)} · ${sample ? lines.map((l) => `${l.label} ${display(sample[l.key])}`).join(" / ") : "No nearby sample"}`}</text></>}
      {!values.length && <text x="210" y="43" textAnchor="middle" fontSize="10" fill="currentColor" opacity=".6">No saved data in this window</text>}
      <text x="30" y="82" fontSize="8" fill="currentColor" opacity=".6">{time(context.domain[0])}</text>
      <text x="210" y="82" textAnchor="middle" fontSize="8" fill="#c4b5fd">Marked episode</text>
      <text x="390" y="82" textAnchor="end" fontSize="8" fill="currentColor" opacity=".6">{time(context.domain[1])}</text>
    </svg>
    <p className="text-[9px] text-muted-foreground">{footer}</p>
  </div>;
}

export default function EpisodeReviewCard({ episode: e, timelineRows, phaseModel, onSeek, onDelete }) {
  const context = useMemo(() => episodeReviewContext(e, timelineRows, phaseModel.points), [e, timelineRows, phaseModel]);
  const peakRecovery = context.phases.filter((p) => p.t >= e.start_s && p.recovery != null).reduce((max, p) => Math.max(max, p.recovery), 0);
  const hasRecovery = context.phases.some((p) => p.t >= e.start_s && p.recovery != null);
  const phaseAtEnd = context.phases.filter((p) => p.t <= context.end).at(-1)?.phase;
  const seek = (t) => onSeek({ ...e, start_s: t });
  return <article className="overflow-hidden rounded-2xl border border-violet-400/20 bg-gradient-to-r from-violet-500/[0.055] to-card p-3" style={{ contentVisibility: "auto", containIntrinsicSize: "260px" }}>
    <div className="grid gap-3 sm:grid-cols-[144px_minmax(0,1fr)]">
      <button type="button" onClick={() => onSeek(e)} className="group relative self-start overflow-hidden rounded-xl bg-black" title="Jump to episode start">
        {e.thumbnail_url ? <img src={e.thumbnail_url} alt={`Episode start ${time(e.start_s)}`} className="aspect-video w-full object-contain" loading="lazy" /> : <span className="block p-6 text-xs">Open start frame</span>}
        <span className="block bg-violet-950/40 px-2 py-1 text-[10px] text-violet-300">▶ {time(e.start_s)} · {e.source?.label || "Selected camera"}</span>
      </button>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: e.kind === "climax" ? "#e879f9" : PHASE_COLORS[phaseAtEnd] || "#a78bfa" }} />
          <h3 className="text-sm font-semibold">{e.kind === "climax" ? "Climax" : "Near climax"}</h3>
          <span className="text-xs text-muted-foreground">{time(e.start_s)} → {e.end_s == null ? `Open · ${e.kind === "climax" ? "C" : "N"} to finish` : time(e.end_s)}</span>
          {e.end_s != null && <span className="rounded-full bg-violet-400/10 px-2 py-0.5 font-mono text-xs text-violet-300">{episodeDuration(e.duration_s)}</span>}
          <button type="button" onClick={() => onDelete(e.id)} className="ml-auto text-[10px] text-muted-foreground hover:text-red-400">{e.end_s == null ? "Cancel" : "Remove"}</button></div>
        <div className="my-2 flex flex-wrap gap-2 text-[11px]">
          {[["HR", `${e.telemetry?.hr_start ?? "—"} → ${e.telemetry?.hr_end ?? "—"} bpm`], ["RMSSD", `${display(e.telemetry?.rmssd_median_ms)} ms`],
            ["Approach peak", `${e.telemetry?.approach_peak ?? "—"}/100`], ["Release / recovery peak", `${hasRecovery ? peakRecovery : "—"}/100`]].map(([label, text]) =>
            <span key={label} className="rounded-lg border border-white/5 bg-background/40 px-2 py-1"><span className="mr-1.5 text-muted-foreground">{label}</span><b className="font-mono">{text}</b></span>)}
        </div>
        <div className="grid gap-2 lg:grid-cols-3">
          <SlimTimeline title="Cardiac · bpm" rows={context.samples} lines={HR_LINES} context={context} onSeek={seek}
            footer={`Median before ${display(context.before.hr)} · during ${display(context.during.hr)} · after ${display(context.after.hr)}`} />
          <SlimTimeline title="Autonomic · ms" rows={context.samples} lines={HRV_LINES} context={context} onSeek={seek}
            footer={`RMSSD before ${display(context.before.rmssd)} · during ${display(context.during.rmssd)} · after ${display(context.after.rmssd)}`} />
          <SlimTimeline title="Approach & recovery · /100" rows={context.phases} lines={PHASE_LINES} context={context} onSeek={seek} score
            footer="Same Full Telemetry estimates · 30s either side" />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <span>{e.proximity && e.kind !== "climax" ? `${e.proximity.kind}: ${e.proximity.relative_to_episode_s === 0 ? "within this episode" : `${episodeDuration(Math.abs(e.proximity.relative_to_episode_s))} ${e.proximity.relative_to_episode_s > 0 ? "after this episode" : "before this episode"}`}` : "Subjective marker"}</span>
          <span className="flex gap-3">{[["Before", context.domain[0]], ["Start", context.start], ["End", context.end], ["After", context.domain[1]]].map(([label, t]) =>
            <button key={label} type="button" onClick={() => seek(t)} className="hover:text-primary">{label} ↗</button>)}</span>
        </div>
      </div>
    </div>
  </article>;
}
