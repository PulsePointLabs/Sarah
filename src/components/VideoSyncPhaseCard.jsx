import { useMemo, useState } from "react";
import { buildPhaseEvidence, phaseEvidenceAt, PHASE_LABELS, savedPhaseMarkers } from "../lib/videoSyncPhaseEvidence.js";

const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const signed = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
const COLORS = { unavailable: "#64748b", warming: "#64748b", baseline: "#22c55e", build: "#eab308",
  plateau: "#f97316", approach: "#ef4444", recovery: "#38bdf8" };

export default function VideoSyncPhaseCard({ timelineRows, session, playheadS, xDomain, onSeek }) {
  const [colorCue, setColorCue] = useState(true);
  const model = useMemo(() => buildPhaseEvidence(timelineRows), [timelineRows]);
  const markers = useMemo(() => savedPhaseMarkers(session), [session]);
  const current = phaseEvidenceAt(model.points, playheadS);
  const start = xDomain?.[0] ?? Math.max(0, playheadS - 60);
  const end = Math.max(start + 1, xDomain?.[1] ?? playheadS + 60);
  const x = (t) => 28 + (t - start) / (end - start) * 364;
  const visible = model.points.filter((p) => p.t >= start && p.t <= end);
  const path = (key) => {
    let move = true;
    return visible.map((p) => {
      if (p[key] == null) { move = true; return ""; }
      const command = `${move ? "M" : "L"}${x(p.t).toFixed(2)},${(88 - p[key] * 0.75).toFixed(2)}`;
      move = false; return command;
    }).join(" ");
  };
  const elapsedMoments = model.moments.filter((m) => m.detectedAt <= playheadS);
  const moments = elapsedMoments.filter((m) => m.t >= start && m.t <= end);
  const previous = elapsedMoments.at(-1);
  const latestMarker = markers.filter((m) => m.t <= playheadS).at(-1);
  const color = COLORS[current.phase];
  return (
    <section aria-label="Phase evidence at playhead" className="relative flex h-[clamp(180px,28svh,240px)] shrink-0 flex-col rounded-xl border p-2 transition-colors duration-300"
      style={{ borderColor: color, backgroundColor: colorCue ? `${color}22` : "transparent" }}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-bold uppercase tracking-wider">Build · Plateau · Recovery</h3>
        <button type="button" aria-pressed={colorCue} onClick={() => setColorCue(!colorCue)}
          className="rounded border border-border px-1.5 py-0.5 text-[9px]">Color cue {colorCue ? "on" : "off"}</button>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <div><p className="text-sm font-bold">{PHASE_LABELS[current.phase]}</p>
          <p className="text-[9px] text-muted-foreground">{clock(playheadS)} · {current.compression != null ? "HR + usable RR-HRV" : "HR only / HRV reference unavailable"}</p></div>
        <div className="text-right"><p className="font-mono text-2xl font-bold leading-none">{current.approach ?? "—"}<span className="text-xs text-muted-foreground">/100</span></p>
          <p className="text-[9px]">Approach evidence</p></div>
      </div>
      <div className="mt-1 grid grid-cols-3 gap-1 text-center text-[10px]">
        <span>Plateau <b>{current.plateau ?? "—"}</b></span><span>Recovery <b>{current.recovery ?? "—"}</b></span>
        <span>HR Δ <b>{current.delta != null ? signed(current.delta) : "—"}</b> bpm</span>
      </div>
      <svg viewBox="0 0 400 108" role="img" aria-label="Approach, plateau, and recovery evidence over session time; use the time slider to seek"
        className="mt-1 block min-h-0 w-full flex-1 cursor-crosshair" preserveAspectRatio="none"
        onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect();
          onSeek(start + Math.max(0, Math.min(1, ((event.clientX - bounds.left) / bounds.width * 400 - 28) / 364)) * (end - start)); }}>
        {[0, 50, 100].map((n) => <g key={n}><line x1="28" x2="392" y1={88 - n * .75} y2={88 - n * .75} stroke="currentColor" opacity=".12" />
          <text x="2" y={91 - n * .75} fill="currentColor" fontSize="9">{n}</text></g>)}
        <path d={path("plateau")} fill="none" stroke="#fb923c" strokeWidth="1.4" strokeDasharray="4 3" />
        <path d={path("recovery")} fill="none" stroke="#38bdf8" strokeWidth="2" />
        <path d={path("approach")} fill="none" stroke="#fb7185" strokeWidth="2.3" />
        {markers.filter((m) => m.t >= start && m.t <= end).map((m) => <g key={m.label}><title>{`${m.label} · ${clock(m.t)}`}</title>
          <line x1={x(m.t)} x2={x(m.t)} y1="12" y2="88" stroke="#c4b5fd" strokeDasharray="2 3" /></g>)}
        {moments.map((m, i) => <circle key={i} cx={x(m.t)} cy="9" r="3" fill={COLORS[m.kind] || "#fb7185"}><title>{`${m.label} · ${clock(m.t)}`}</title></circle>)}
        {playheadS >= start && playheadS <= end && <line x1={x(playheadS)} x2={x(playheadS)} y1="4" y2="90" stroke="currentColor" strokeWidth="1.5" />}
        <text x="28" y="104" fontSize="9" fill="currentColor">{clock(start)}</text>
        <text x="392" y="104" textAnchor="end" fontSize="9" fill="currentColor">{clock(end)}</text>
      </svg>
      <div className="flex justify-between gap-1 text-[9px]"><span className="text-rose-400">Approach</span>
        <span className="text-orange-400">Plateau --</span><span className="text-sky-400">Recovery</span><span className="text-violet-300">Logged markers ⋮</span></div>
      <input type="range" aria-label="Seek phase evidence timeline" min={start} max={end} step="0.1"
        value={Math.max(start, Math.min(end, playheadS))} onChange={(e) => onSeek(Number(e.target.value))} className="mt-1 h-2 w-full accent-teal-500" />
      <details className="mt-1 shrink-0 text-[10px]"><summary className="cursor-pointer">Evidence & key moments</summary>
        <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-[40svh] overflow-y-auto rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl">
        <p className="text-[9px] text-muted-foreground">Review heuristic, not a calibrated climax probability. Scores follow saved samples.</p>
        {current.reason && <p className="mt-1">{current.reason}</p>}
        {previous && <button type="button" onClick={() => onSeek(previous.t)} className="mt-1 text-left text-primary underline">
          Latest cue: {previous.label} · {clock(previous.t)}</button>}
        {current.slope != null && <p className="mt-1">HR trend {signed(current.slope)} bpm/30s · elevated for {Math.round(current.dwell)}s · drop from recent peak {current.drop.toFixed(1)} bpm.</p>}
        <p>{current.hrvUsable ? `RMSSD ${current.rmssd.toFixed(1)} ms${current.reference ? `; prior reference ${current.reference.toFixed(1)} ms` : "; gathering prior reference"}.` : "No usable moderate/high-quality HRV reference; approach is capped at 60."}</p>
        {current.contributions && <p>Approach contributions: HR elevation {Math.round(current.contributions.elevation)}/45; rising HR {Math.round(current.contributions.rise)}/20;
          elevated duration {Math.round(current.contributions.dwell)}/10; HRV compression {Math.round(current.contributions.hrv)}/25. Peak decline reduces approach.</p>}
        <p className="mt-1">Phases require 3s persistence; initial warm-up 10s. Gaps over 5s reset evidence. HR and HRV share a cardiac source; movement, breathing and visual findings are not scored here.</p>
        {latestMarker && <p className="mt-1 text-violet-300">{latestMarker.label} at {clock(latestMarker.t)} — recorded separately, never used to boost the score.</p>}
        <p className="mt-1">All key moments observed through this playhead ({elapsedMoments.length}):</p>
        <div className="mt-1 flex flex-wrap gap-1">{elapsedMoments.map((m, i) => <button key={i} type="button" onClick={() => onSeek(m.t)}
          className="rounded border border-border px-1.5 py-1">{clock(m.t)} · {m.label}</button>)}</div>
        </div>
      </details>
    </section>
  );
}
