import { useEffect, useMemo, useState } from "react";
import { Activity, ChevronDown, ChevronUp, Play, ShieldCheck } from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

function formatTime(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function Metric({ label, value, suffix = "" }) {
  if (value == null) return null;
  return (
    <div className="rounded-lg bg-muted/25 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-base font-semibold text-foreground">{value}{suffix}</p>
    </div>
  );
}

function qualityStyle(level) {
  if (level === "strong") return "text-emerald-400 border-emerald-400/30 bg-emerald-400/10";
  if (level === "moderate") return "text-amber-400 border-amber-400/30 bg-amber-400/10";
  return "text-rose-400 border-rose-400/30 bg-rose-400/10";
}

function SavedQualityBadge({ level }) {
  if (!level) return null;
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${qualityStyle(level)}`}>
      {level}
    </span>
  );
}

function MotionTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-xl">
      <p className="font-mono font-semibold text-foreground">{formatTime(label)}</p>
      {payload.map((entry) => (
        <p key={entry.dataKey} className="mt-1" style={{ color: entry.color }}>
          {entry.name}: {entry.value ?? 0}
        </p>
      ))}
    </div>
  );
}

export default function SavedMotionSummaryCard({ summary, onSeek, playbackTime, compact = false, chartOnly = false, focus = false }) {
  const savedSummary = summary || {};
  const peaks = Array.isArray(savedSummary.review_peaks) ? savedSummary.review_peaks : [];
  const findings = Array.isArray(savedSummary.findings) ? savedSummary.findings : [];
  const timeline = useMemo(() => (
    Array.isArray(savedSummary.derived_timeline)
      ? savedSummary.derived_timeline.map((point) => ({
        ...point,
        timeS: point.time_s,
        leftScore: point.left_lower_body_activity,
        rightScore: point.right_lower_body_activity,
        leftForefootScore: point.left_forefoot_activity,
        rightForefootScore: point.right_forefoot_activity,
        handScore: point.hand_activity,
        score: point.activity,
      }))
      : []
  ), [savedSummary.derived_timeline]);
  const hasLeft = timeline.some((point) => point.leftScore != null);
  const hasRight = timeline.some((point) => point.rightScore != null);
  const hasLeftForefoot = timeline.some((point) => point.leftForefootScore != null);
  const hasRightForefoot = timeline.some((point) => point.rightForefootScore != null);
  const hasHands = timeline.some((point) => point.handScore != null);
  const usesSingleActivity = timeline.length > 0 && !hasLeft && !hasRight && !hasHands;
  const [visibleSignals, setVisibleSignals] = useState({
    left: true,
    right: true,
    leftForefoot: false,
    rightForefoot: false,
    hands: true,
    activity: true,
  });
  const [expanded, setExpanded] = useState(chartOnly || !compact);

  useEffect(() => {
    setVisibleSignals({
      left: hasLeft,
      right: hasRight,
      leftForefoot: false,
      rightForefoot: false,
      hands: hasHands && !hasLeft && !hasRight,
      activity: usesSingleActivity,
    });
  }, [hasHands, hasLeft, hasRight, hasLeftForefoot, hasRightForefoot, usesSingleActivity, savedSummary.analyzed_at]);

  useEffect(() => {
    setExpanded(chartOnly || !compact);
  }, [chartOnly, compact, savedSummary.analyzed_at]);

  if (!summary) return null;

  if (chartOnly) {
    if (timeline.length === 0) return null;
    return (
      <div className="space-y-2 rounded-lg border border-border bg-muted/15 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Motion Activity Trace</p>
            <p className="mt-1 text-[11px] text-muted-foreground">Saved derived motion signals; click to seek a loaded local video.</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {hasLeft && (
              <label className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[10px] text-foreground">
                <input type="checkbox" checked={visibleSignals.left} onChange={(event) => setVisibleSignals((current) => ({ ...current, left: event.target.checked }))} className="h-3 w-3 accent-primary" />
                Left
              </label>
            )}
            {hasRight && (
              <label className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[10px] text-foreground">
                <input type="checkbox" checked={visibleSignals.right} onChange={(event) => setVisibleSignals((current) => ({ ...current, right: event.target.checked }))} className="h-3 w-3 accent-[#f59e0b]" />
                Right
              </label>
            )}
            {hasHands && (
              <label className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[10px] text-foreground">
                <input type="checkbox" checked={visibleSignals.hands} onChange={(event) => setVisibleSignals((current) => ({ ...current, hands: event.target.checked }))} className="h-3 w-3 accent-[#a78bfa]" />
                Hands
              </label>
            )}
            {hasLeftForefoot && (
              <label className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[10px] text-foreground">
                <input type="checkbox" checked={visibleSignals.leftForefoot} onChange={(event) => setVisibleSignals((current) => ({ ...current, leftForefoot: event.target.checked }))} className="h-3 w-3 accent-[#2dd4bf]" />
                Left forefoot
              </label>
            )}
            {hasRightForefoot && (
              <label className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[10px] text-foreground">
                <input type="checkbox" checked={visibleSignals.rightForefoot} onChange={(event) => setVisibleSignals((current) => ({ ...current, rightForefoot: event.target.checked }))} className="h-3 w-3 accent-[#fb923c]" />
                Right forefoot
              </label>
            )}
          </div>
        </div>
        <div className={`${focus ? "h-40" : "h-44"} cursor-pointer`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={timeline}
              margin={{ top: 8, right: 8, bottom: 2, left: -24 }}
              onClick={(chartData) => {
                if (Number.isFinite(Number(chartData?.activeLabel))) onSeek?.(Number(chartData.activeLabel));
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="timeS" type="number" domain={[savedSummary.window_start_s, savedSummary.window_end_s]} tickFormatter={formatTime} stroke="hsl(var(--muted-foreground))" fontSize={10} />
              <YAxis domain={[0, 100]} stroke="hsl(var(--muted-foreground))" fontSize={10} />
              <Tooltip content={<MotionTooltip />} />
              {Number.isFinite(Number(playbackTime))
                && playbackTime >= savedSummary.window_start_s
                && playbackTime <= savedSummary.window_end_s && (
                <ReferenceLine x={playbackTime} stroke="#f43f5e" strokeWidth={2} />
              )}
              {hasLeft && visibleSignals.left && <Line type="monotone" name="Left foot / leg" dataKey="leftScore" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />}
              {hasRight && visibleSignals.right && <Line type="monotone" name="Right foot / leg" dataKey="rightScore" stroke="#f59e0b" dot={false} strokeWidth={2} />}
              {hasLeftForefoot && visibleSignals.leftForefoot && <Line type="monotone" name="Left forefoot / toe region" dataKey="leftForefootScore" stroke="#2dd4bf" dot={false} strokeWidth={1.5} strokeDasharray="4 2" />}
              {hasRightForefoot && visibleSignals.rightForefoot && <Line type="monotone" name="Right forefoot / toe region" dataKey="rightForefootScore" stroke="#fb923c" dot={false} strokeWidth={1.5} strokeDasharray="4 2" />}
              {hasHands && visibleSignals.hands && <Line type="monotone" name="Hands" dataKey="handScore" stroke="#a78bfa" dot={false} strokeWidth={2} />}
              {usesSingleActivity && visibleSignals.activity && <Line type="monotone" name="Activity" dataKey="score" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />}
            </LineChart>
          </ResponsiveContainer>
        </div>
        {(savedSummary.asymmetry_summary || savedSummary.hand_movement_summary?.reliability === "moderate") && (
          <div className="grid gap-2 sm:grid-cols-4">
            <Metric label="Session Avg Left" value={savedSummary.left_lower_body_average_activity} />
            <Metric label="Session Avg Right" value={savedSummary.right_lower_body_average_activity} />
            {savedSummary.asymmetry_summary && (
              <Metric
                label="Side Balance"
                value={savedSummary.asymmetry_summary.predominantSide === "balanced"
                  || savedSummary.asymmetry_summary.predominantPct < 55
                  ? "No clear lead"
                  : `${savedSummary.asymmetry_summary.predominantSide === "left" ? "Left" : "Right"} ${savedSummary.asymmetry_summary.predominantPct}%`}
              />
            )}
            {savedSummary.hand_movement_summary?.reliability === "moderate" && (
              <Metric
                label="Session Cadence Proxy"
                value={savedSummary.hand_movement_summary.movement_cycles_per_minute_estimate}
                suffix=" cycles/min"
              />
            )}
          </div>
        )}
        {savedSummary.hand_movement_summary?.reliability === "moderate" && (
          <p className="text-[10px] text-muted-foreground">
            Session cadence proxy is derived from visible hand-movement rhythm and is not confirmed technique or force. Playback-time cadence requires a newly saved analysis with rolling cadence data.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={`rounded-xl border border-primary/20 bg-primary/[0.04] ${compact ? "p-3" : "p-4"} space-y-3`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <Activity className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Saved Motion Summary</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Reviewed media-derived evidence saved for timeline review and AI synthesis.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/[0.08] px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-primary">
            <ShieldCheck className="h-3 w-3" />
            Derived data only
          </span>
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card/50 px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            aria-expanded={expanded}
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {expanded ? "Collapse" : "Expand"}
          </button>
        </div>
      </div>

      {expanded && (
        <>
          <p className="text-[11px] text-muted-foreground">
            Window {formatTime(savedSummary.window_start_s)} to {formatTime(savedSummary.window_end_s)}
            {savedSummary.sample_rate_fps ? ` at ${savedSummary.sample_rate_fps} samples/second` : ""}.
          </p>

          {savedSummary.roi_configuration && (
            <p className="text-[11px] text-muted-foreground">
          Regions: {savedSummary.roi_configuration.layout === "pip"
            ? `upper-left inset with separate left foot / leg, right foot / leg, and primary hand/activity regions${savedSummary.forefoot_enabled ? ", plus optional forefoot / toe-region motion boxes" : ""}`
            : "full-frame tracking"}.
            </p>
          )}
          {savedSummary.left_right_orientation && (
            <p className="text-[11px] text-muted-foreground">
              Side assignment: anatomical left was mapped to {savedSummary.left_right_orientation === "anatomical_left_on_screen_right" ? "screen right" : "screen left"}.
            </p>
          )}
          {savedSummary.lower_body_tracking_method && (
            <p className="text-[11px] text-muted-foreground">
              Lower-body method: {savedSummary.lower_body_tracking_method === "regionMotion"
                ? "region motion for sole-facing visibility (not individual toe landmark recognition)"
                : "pose landmark comparison"}.
            </p>
          )}
          {!savedSummary.lower_body_tracking_method && (
            <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2 text-xs leading-relaxed text-amber-200">
              This saved result was created before region-motion tracking was recorded. It may differ substantially from a new live analysis until you save a new summary.
            </div>
          )}

          {timeline.length > 0 && (
        <div className="space-y-2 rounded-lg border border-border bg-card/40 p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Saved Activity Timeline</p>
            <div className="flex flex-wrap gap-1.5">
              {hasLeft && (
                <label className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[10px] text-foreground">
                  <input type="checkbox" checked={visibleSignals.left} onChange={(event) => setVisibleSignals((current) => ({ ...current, left: event.target.checked }))} className="h-3 w-3 accent-primary" />
                  Left
                </label>
              )}
              {hasRight && (
                <label className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[10px] text-foreground">
                  <input type="checkbox" checked={visibleSignals.right} onChange={(event) => setVisibleSignals((current) => ({ ...current, right: event.target.checked }))} className="h-3 w-3 accent-[#f59e0b]" />
                  Right
                </label>
              )}
              {hasHands && (
                <label className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[10px] text-foreground">
                  <input type="checkbox" checked={visibleSignals.hands} onChange={(event) => setVisibleSignals((current) => ({ ...current, hands: event.target.checked }))} className="h-3 w-3 accent-[#a78bfa]" />
                  Hands
                </label>
              )}
              {hasLeftForefoot && (
                <label className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[10px] text-foreground">
                  <input type="checkbox" checked={visibleSignals.leftForefoot} onChange={(event) => setVisibleSignals((current) => ({ ...current, leftForefoot: event.target.checked }))} className="h-3 w-3 accent-[#2dd4bf]" />
                  Left forefoot
                </label>
              )}
              {hasRightForefoot && (
                <label className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[10px] text-foreground">
                  <input type="checkbox" checked={visibleSignals.rightForefoot} onChange={(event) => setVisibleSignals((current) => ({ ...current, rightForefoot: event.target.checked }))} className="h-3 w-3 accent-[#fb923c]" />
                  Right forefoot
                </label>
              )}
              {usesSingleActivity && (
                <label className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[10px] text-foreground">
                  <input type="checkbox" checked={visibleSignals.activity} onChange={(event) => setVisibleSignals((current) => ({ ...current, activity: event.target.checked }))} className="h-3 w-3 accent-primary" />
                  Activity
                </label>
              )}
            </div>
          </div>
          <div className={`${compact ? "h-36" : "h-44"} cursor-pointer`}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={timeline}
                margin={{ top: 8, right: 8, bottom: 2, left: -24 }}
                onClick={(chartData) => {
                  if (Number.isFinite(Number(chartData?.activeLabel))) onSeek?.(Number(chartData.activeLabel));
                }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="timeS"
                  type="number"
                  domain={[savedSummary.window_start_s, savedSummary.window_end_s]}
                  tickFormatter={formatTime}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={10}
                />
                <YAxis domain={[0, 100]} stroke="hsl(var(--muted-foreground))" fontSize={10} />
                <Tooltip content={<MotionTooltip />} />
                {!compact && <Legend wrapperStyle={{ fontSize: 11 }} />}
                {Number.isFinite(Number(playbackTime))
                  && playbackTime >= savedSummary.window_start_s
                  && playbackTime <= savedSummary.window_end_s && (
                  <ReferenceLine x={playbackTime} stroke="#f43f5e" strokeWidth={2} />
                )}
                {hasLeft && visibleSignals.left && <Line type="monotone" name="Left foot / leg" dataKey="leftScore" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />}
                {hasRight && visibleSignals.right && <Line type="monotone" name="Right foot / leg" dataKey="rightScore" stroke="#f59e0b" dot={false} strokeWidth={2} />}
                {hasLeftForefoot && visibleSignals.leftForefoot && <Line type="monotone" name="Left forefoot / toe region" dataKey="leftForefootScore" stroke="#2dd4bf" dot={false} strokeWidth={1.5} strokeDasharray="4 2" />}
                {hasRightForefoot && visibleSignals.rightForefoot && <Line type="monotone" name="Right forefoot / toe region" dataKey="rightForefootScore" stroke="#fb923c" dot={false} strokeWidth={1.5} strokeDasharray="4 2" />}
                {hasHands && visibleSignals.hands && <Line type="monotone" name="Hands" dataKey="handScore" stroke="#a78bfa" dot={false} strokeWidth={2} />}
                {usesSingleActivity && visibleSignals.activity && <Line type="monotone" name="Activity" dataKey="score" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Click the saved trace to seek a loaded local video.
          </p>
        </div>
          )}

          {timeline.length === 0 && (
        <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          This saved analysis predates timeline persistence, so only its summary metrics and review peaks can be restored. Re-run the local analysis and save again to retain the activity chart after refresh.
        </div>
          )}

          <div className={`grid gap-2 ${compact ? "grid-cols-2" : "sm:grid-cols-3 lg:grid-cols-5"}`}>
        <div className="space-y-1">
          <Metric label={savedSummary.lower_body_tracking_method === "regionMotion" ? "Left Signal Samples" : "Left Coverage"} value={savedSummary.left_lower_body_coverage_pct} suffix="%" />
          {savedSummary.lower_body_tracking_method !== "regionMotion" && <SavedQualityBadge level={savedSummary.quality_indicators?.left_lower_body} />}
        </div>
        <div className="space-y-1">
          <Metric label={savedSummary.lower_body_tracking_method === "regionMotion" ? "Right Signal Samples" : "Right Coverage"} value={savedSummary.right_lower_body_coverage_pct} suffix="%" />
          {savedSummary.lower_body_tracking_method !== "regionMotion" && <SavedQualityBadge level={savedSummary.quality_indicators?.right_lower_body} />}
        </div>
        <div className="space-y-1">
          <Metric label="Hand Coverage" value={savedSummary.hand_coverage_pct} suffix="%" />
          <SavedQualityBadge level={savedSummary.quality_indicators?.hands} />
        </div>
        <Metric label="Left Average" value={savedSummary.left_lower_body_average_activity} />
        <Metric label="Right Average" value={savedSummary.right_lower_body_average_activity} />
        <Metric label="Left Forefoot Average" value={savedSummary.left_forefoot_average_activity} />
        <Metric label="Right Forefoot Average" value={savedSummary.right_forefoot_average_activity} />
          </div>

          {savedSummary.asymmetry_summary && (
        <div className="rounded-lg border border-border bg-card/40 p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Saved Asymmetry Summary</p>
            <span className="text-[10px] text-muted-foreground">Observational only</span>
          </div>
          <div className={`grid gap-2 ${compact ? "grid-cols-2" : "sm:grid-cols-3"}`}>
            <Metric label="Average Index" value={savedSummary.asymmetry_summary.averageIndex} />
            <Metric label="Peak Index" value={savedSummary.asymmetry_summary.peakIndex} />
            <Metric
              label="Predominance"
              value={savedSummary.asymmetry_summary.predominantSide === "balanced"
                || savedSummary.asymmetry_summary.predominantPct < 55
                ? "No clear predominance"
                : `${savedSummary.asymmetry_summary.predominantSide === "left" ? "Left" : "Right"} ${savedSummary.asymmetry_summary.predominantPct}%`}
            />
          </div>
        </div>
          )}

          {savedSummary.hand_movement_summary?.reliability === "moderate" && (
        <div className="rounded-lg border border-[#a78bfa]/30 bg-[#a78bfa]/[0.07] p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[#a78bfa]">Saved Hand Movement Rhythm Estimate</p>
            <span className="text-[10px] text-muted-foreground">Observational proxy only</span>
          </div>
          <div className={`grid gap-2 ${compact ? "grid-cols-2" : "sm:grid-cols-3"}`}>
            <Metric label="Cadence Estimate" value={savedSummary.hand_movement_summary.movement_cycles_per_minute_estimate} suffix=" cycles/min" />
            <Metric label="Pauses Of Two Seconds Or Longer" value={savedSummary.hand_movement_summary.pause_count} />
            <Metric label="Active Windows" value={savedSummary.hand_movement_summary.active_time_pct} suffix="%" />
          </div>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            {savedSummary.hand_movement_summary.method_note}
          </p>
        </div>
          )}

          {findings.length > 0 && (
        <div className="space-y-1.5">
          {findings.map((finding) => (
            <p key={finding} className="border-l-2 border-primary/35 pl-2 text-xs leading-relaxed text-foreground">
              {finding}
            </p>
          ))}
        </div>
          )}

          {peaks.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Saved Review Peaks</p>
          <div className="flex flex-wrap gap-1.5">
            {peaks.map((peak) => (
              <button
                key={peak.time_s}
                type="button"
                onClick={() => onSeek?.(peak.time_s)}
                disabled={!onSeek}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card/60 px-2 py-1 text-[10px] text-foreground transition-colors enabled:hover:border-primary/40 enabled:hover:bg-primary/[0.08] disabled:cursor-default"
              >
                <Play className="h-3 w-3 text-primary" />
                <span className="font-mono">{formatTime(peak.time_s)}</span>
                {peak.left_lower_body_activity != null && (
                  <span className="text-muted-foreground">
                    L{peak.left_lower_body_activity}/R{peak.right_lower_body_activity ?? "-"}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
          )}

          <p className="text-[10px] leading-relaxed text-muted-foreground">
            Scores are normalized within the analyzed video window. The saved chart is a compact derived activity trace; raw video, frames, and MediaPipe landmarks are not stored.
          </p>
        </>
      )}
    </div>
  );
}
