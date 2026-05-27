import { useEffect, useMemo, useState } from "react";
import { Activity, ChevronDown, ChevronUp, Footprints, Play, ShieldCheck } from "lucide-react";
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
import SideBalanceGauge from "./SideBalanceGauge";

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

function confidenceStyle(level) {
  if (level === "moderate") return "text-emerald-400 border-emerald-400/30 bg-emerald-400/10";
  if (level === "low") return "text-amber-400 border-amber-400/30 bg-amber-400/10";
  return "text-rose-400 border-rose-400/30 bg-rose-400/10";
}

function SavedConfidenceBadge({ level }) {
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${confidenceStyle(level)}`}>
      {level || "weak"}
    </span>
  );
}

function patternAccent(count) {
  if ((Number(count) || 0) >= 12) return "border-rose-400/25 bg-rose-400/[0.06]";
  if ((Number(count) || 0) >= 4) return "border-amber-400/25 bg-amber-400/[0.05]";
  return "border-border bg-muted/15";
}

function PatternMetric({ label, value }) {
  return (
    <div className={`rounded-lg border p-1 ${patternAccent(value)}`}>
      <Metric label={label} value={value} />
    </div>
  );
}

function clusterPeaks(peaks, nearbyWindowS = 6) {
  return peaks.reduce((clusters, peak) => {
    const previous = clusters[clusters.length - 1];
    if (previous && Number(peak.time_s) - Number(previous[previous.length - 1].time_s) <= nearbyWindowS) {
      previous.push(peak);
    } else {
      clusters.push([peak]);
    }
    return clusters;
  }, []);
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

function addSmoothedSignals(points, windowSize = 4) {
  return points.map((point, index) => {
    const window = points.slice(Math.max(0, index - windowSize + 1), index + 1);
    const average = (key) => {
      const values = window.map((entry) => Number(entry[key])).filter(Number.isFinite);
      return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    };
    return {
      ...point,
      leftSmooth: average("leftScore"),
      rightSmooth: average("rightScore"),
      leftForefootSmooth: average("leftForefootScore"),
      rightForefootSmooth: average("rightForefootScore"),
      handSmooth: average("handScore"),
      activitySmooth: average("score"),
    };
  });
}

export default function SavedMotionSummaryCard({
  summary,
  onSeek,
  playbackTime,
  compact = false,
  chartOnly = false,
  focus = false,
  showBalanceGauge = true,
  interactionLabel = "Feet/leg and hand signals aligned to playback; click the timeline to seek the loaded video.",
}) {
  const savedSummary = summary || {};
  const peaks = Array.isArray(savedSummary.review_peaks) ? savedSummary.review_peaks : [];
  const findings = Array.isArray(savedSummary.findings) ? savedSummary.findings : [];
  const lowerBodyPatterns = savedSummary.lower_body_pattern_summary;
  const postureSummary = savedSummary.lower_body_posture_summary;
  const handBehaviorSummary = savedSummary.hand_behavior_summary;
  const manualGeometryCards = useMemo(() => {
    const cards = [];
    if ((Number(savedSummary.manual_foot_landmark_geometry?.marked_count) || 0) > 0) {
      cards.push({
        key: "summary",
        label: "Saved manual foot geometry",
        geometry: savedSummary.manual_foot_landmark_geometry,
        landmarks: savedSummary.manual_foot_landmarks,
      });
    }
    (Array.isArray(savedSummary.region_segments) ? savedSummary.region_segments : []).forEach((segment) => {
      if ((Number(segment.manual_foot_landmark_geometry?.marked_count) || 0) > 0) {
        cards.push({
          key: segment.id || `${segment.start_time_s}-${segment.label}`,
          label: segment.label || `Position ${formatTime(segment.start_time_s)}`,
          timeS: segment.start_time_s,
          geometry: segment.manual_foot_landmark_geometry,
          landmarks: segment.manual_foot_landmarks,
        });
      }
    });
    return cards;
  }, [savedSummary.manual_foot_landmark_geometry, savedSummary.manual_foot_landmarks, savedSummary.region_segments]);
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
  const cadenceTimeline = useMemo(() => (
    Array.isArray(savedSummary.hand_cadence_timeline)
      ? savedSummary.hand_cadence_timeline.map((point) => ({
        ...point,
        timeS: point.time_s,
        cadence: point.movement_cycles_per_minute_estimate,
      }))
      : []
  ), [savedSummary.hand_cadence_timeline]);
  const playbackPoint = useMemo(() => {
    if (!timeline.length || !Number.isFinite(Number(playbackTime))) return null;
    return timeline.reduce((nearest, point) => (
      Math.abs(Number(point.timeS) - Number(playbackTime)) < Math.abs(Number(nearest.timeS) - Number(playbackTime))
        ? point
        : nearest
    ), timeline[0]);
  }, [playbackTime, timeline]);
  const playbackCadence = useMemo(() => {
    if (!cadenceTimeline.length || !Number.isFinite(Number(playbackTime))) return null;
    return cadenceTimeline.reduce((nearest, point) => (
      Math.abs(Number(point.timeS) - Number(playbackTime)) < Math.abs(Number(nearest.timeS) - Number(playbackTime))
        ? point
        : nearest
    ), cadenceTimeline[0]);
  }, [cadenceTimeline, playbackTime]);
  const playbackSideTotal = Number(playbackPoint?.leftScore || 0) + Number(playbackPoint?.rightScore || 0);
  const playbackSideIndex = playbackSideTotal > 0
    ? (Number(playbackPoint.leftScore || 0) - Number(playbackPoint.rightScore || 0)) / playbackSideTotal
    : null;
  const playbackSideLabel = playbackSideIndex == null
    ? "--"
    : Math.abs(playbackSideIndex) <= 0.1
      ? "Similar"
      : `${playbackSideIndex > 0 ? "Left" : "Right"} higher`;
  const [visibleSignals, setVisibleSignals] = useState({
    left: true,
    right: true,
    leftForefoot: false,
    rightForefoot: false,
    hands: true,
    activity: true,
  });
  const [displayMode, setDisplayMode] = useState("smoothed");
  const [expanded, setExpanded] = useState(chartOnly || !compact);
  const [expandedPeakClusters, setExpandedPeakClusters] = useState([]);
  const chartTimeline = useMemo(() => addSmoothedSignals(timeline), [timeline]);
  const peakClusters = useMemo(() => clusterPeaks(peaks), [peaks]);

  useEffect(() => {
    setVisibleSignals({
      left: hasLeft,
      right: hasRight,
      leftForefoot: false,
      rightForefoot: false,
      hands: hasHands,
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
            <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Movement And Hand Activity Timeline</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{interactionLabel}</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {["raw", "smoothed", "both"].map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setDisplayMode(mode)}
                className={`rounded-full border px-2 py-1 text-[10px] capitalize ${displayMode === mode ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
              >
                {mode}
              </button>
            ))}
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
              data={chartTimeline}
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
              {hasLeft && (displayMode === "raw" || displayMode === "both") && <Line type="monotone" name="Left foot / leg raw" dataKey="leftScore" stroke="hsl(var(--primary))" strokeOpacity={visibleSignals.left ? (displayMode === "both" ? 0.32 : 1) : 0.12} dot={false} strokeWidth={displayMode === "both" ? 1 : 2} />}
              {hasLeft && (displayMode === "smoothed" || displayMode === "both") && <Line type="monotone" name="Left foot / leg" dataKey="leftSmooth" stroke="hsl(var(--primary))" strokeOpacity={visibleSignals.left ? 1 : 0.12} dot={false} strokeWidth={2} />}
              {hasRight && (displayMode === "raw" || displayMode === "both") && <Line type="monotone" name="Right foot / leg raw" dataKey="rightScore" stroke="#f59e0b" strokeOpacity={visibleSignals.right ? (displayMode === "both" ? 0.32 : 1) : 0.12} dot={false} strokeWidth={displayMode === "both" ? 1 : 2} />}
              {hasRight && (displayMode === "smoothed" || displayMode === "both") && <Line type="monotone" name="Right foot / leg" dataKey="rightSmooth" stroke="#f59e0b" strokeOpacity={visibleSignals.right ? 1 : 0.12} dot={false} strokeWidth={2} />}
              {hasLeftForefoot && (displayMode === "raw" || displayMode === "both") && <Line type="monotone" name="Left forefoot raw" dataKey="leftForefootScore" stroke="#2dd4bf" strokeOpacity={visibleSignals.leftForefoot ? 0.45 : 0.1} dot={false} strokeWidth={1} strokeDasharray="4 2" />}
              {hasLeftForefoot && (displayMode === "smoothed" || displayMode === "both") && <Line type="monotone" name="Left forefoot / toe region" dataKey="leftForefootSmooth" stroke="#2dd4bf" strokeOpacity={visibleSignals.leftForefoot ? 1 : 0.1} dot={false} strokeWidth={1.5} strokeDasharray="4 2" />}
              {hasRightForefoot && (displayMode === "raw" || displayMode === "both") && <Line type="monotone" name="Right forefoot raw" dataKey="rightForefootScore" stroke="#fb923c" strokeOpacity={visibleSignals.rightForefoot ? 0.45 : 0.1} dot={false} strokeWidth={1} strokeDasharray="4 2" />}
              {hasRightForefoot && (displayMode === "smoothed" || displayMode === "both") && <Line type="monotone" name="Right forefoot / toe region" dataKey="rightForefootSmooth" stroke="#fb923c" strokeOpacity={visibleSignals.rightForefoot ? 1 : 0.1} dot={false} strokeWidth={1.5} strokeDasharray="4 2" />}
              {hasHands && (displayMode === "raw" || displayMode === "both") && <Line type="monotone" name="Hands raw" dataKey="handScore" stroke="#a78bfa" strokeOpacity={visibleSignals.hands ? (displayMode === "both" ? 0.32 : 1) : 0.12} dot={false} strokeWidth={displayMode === "both" ? 1 : 2} />}
              {hasHands && (displayMode === "smoothed" || displayMode === "both") && <Line type="monotone" name="Hands" dataKey="handSmooth" stroke="#a78bfa" strokeOpacity={visibleSignals.hands ? 1 : 0.12} dot={false} strokeWidth={2} />}
              {usesSingleActivity && (displayMode === "raw" || displayMode === "both") && <Line type="monotone" name="Activity raw" dataKey="score" stroke="hsl(var(--primary))" strokeOpacity={visibleSignals.activity ? (displayMode === "both" ? 0.32 : 1) : 0.12} dot={false} strokeWidth={displayMode === "both" ? 1 : 2} />}
              {usesSingleActivity && (displayMode === "smoothed" || displayMode === "both") && <Line type="monotone" name="Activity" dataKey="activitySmooth" stroke="hsl(var(--primary))" strokeOpacity={visibleSignals.activity ? 1 : 0.12} dot={false} strokeWidth={2} />}
            </LineChart>
          </ResponsiveContainer>
        </div>
        {showBalanceGauge && hasLeft && hasRight && (
          <SideBalanceGauge left={playbackPoint?.leftScore} right={playbackPoint?.rightScore} />
        )}
        {(hasLeft || hasRight || hasHands) && (
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
            {hasLeft && <Metric label="Left Now" value={playbackPoint?.leftScore ?? "--"} />}
            {hasRight && <Metric label="Right Now" value={playbackPoint?.rightScore ?? "--"} />}
            {hasHands && <Metric label="Hands Now" value={playbackPoint?.handScore ?? "--"} />}
            {hasLeft && hasRight && <Metric label="Balance Now" value={playbackSideLabel} />}
          </div>
        )}
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
          <>
            {cadenceTimeline.length > 0 ? (
              <div className="space-y-2 rounded-lg border border-[#a78bfa]/25 bg-[#a78bfa]/[0.05] p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-[#a78bfa]">Rolling Hand Cadence Proxy</p>
                  <p className="font-mono text-[11px] font-semibold text-[#c4b5fd]">
                    {playbackCadence?.cadence != null ? `${playbackCadence.cadence} cycles/min now` : ""}
                  </p>
                </div>
                <div className="h-24 cursor-pointer">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={cadenceTimeline}
                      margin={{ top: 6, right: 8, bottom: 2, left: -24 }}
                      onClick={(chartData) => {
                        if (Number.isFinite(Number(chartData?.activeLabel))) onSeek?.(Number(chartData.activeLabel));
                      }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="timeS" type="number" domain={[savedSummary.window_start_s, savedSummary.window_end_s]} tickFormatter={formatTime} stroke="hsl(var(--muted-foreground))" fontSize={10} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} />
                      <Tooltip content={<MotionTooltip />} />
                      {Number.isFinite(Number(playbackTime))
                        && playbackTime >= savedSummary.window_start_s
                        && playbackTime <= savedSummary.window_end_s && (
                        <ReferenceLine x={playbackTime} stroke="#f43f5e" strokeWidth={2} />
                      )}
                      <Line type="monotone" name="Cadence proxy" dataKey="cadence" stroke="#a78bfa" dot={false} strokeWidth={2} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ) : (
              <p className="rounded-lg border border-[#a78bfa]/20 bg-[#a78bfa]/[0.05] px-2.5 py-2 text-[10px] text-muted-foreground">
                This saved analysis predates rolling cadence storage. Re-run motion analysis and save the result to show cadence aligned with playback.
              </p>
            )}
            <p className="text-[10px] text-muted-foreground">
              Cadence is derived from visible hand-movement rhythm and is not confirmed technique or force.
            </p>
          </>
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
          {Array.isArray(savedSummary.region_segments) && savedSummary.region_segments.length > 0 && (
            <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-100">
              <p className="font-semibold">
                {savedSummary.region_segments.length} position-specific tracking region set{savedSummary.region_segments.length === 1 ? "" : "s"} saved.
              </p>
              <p className="mt-1 text-amber-100/80">
                Values near marked position-change boundaries may reflect framing or rectangle changes. Confirm apparent shifts against the video before interpreting them as body movement.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {savedSummary.region_segments.map((segment) => (
                  <button
                    key={segment.id}
                    type="button"
                    onClick={() => onSeek?.(segment.start_time_s)}
                    disabled={!onSeek}
                    className="rounded-md border border-amber-400/20 bg-card/50 px-2 py-1 font-mono text-[10px] text-amber-100 enabled:hover:border-amber-400/45 disabled:cursor-default"
                  >
                    {formatTime(segment.start_time_s)} {segment.label || "Position change"}
                  </button>
                ))}
              </div>
            </div>
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

          {manualGeometryCards.length > 0 && (
            <div className="rounded-lg border border-[#38bdf8]/25 bg-[#38bdf8]/[0.05] p-2.5 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[#7dd3fc]">Manual Foot Landmark Geometry</p>
                <span className="text-[10px] text-muted-foreground">User-placed visual landmarks</span>
              </div>
              <div className={`grid gap-2 ${compact ? "grid-cols-1" : "md:grid-cols-2"}`}>
                {manualGeometryCards.map((entry) => (
                  <div key={entry.key} className="rounded-lg border border-[#38bdf8]/15 bg-card/60 p-2.5 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-foreground">{entry.label}</p>
                      {entry.timeS != null && (
                        <button
                          type="button"
                          onClick={() => onSeek?.(entry.timeS)}
                          disabled={!onSeek}
                          className="inline-flex items-center gap-1 rounded-md border border-[#38bdf8]/25 bg-[#38bdf8]/[0.06] px-2 py-1 font-mono text-[10px] text-[#bae6fd] enabled:hover:border-[#38bdf8]/45 disabled:cursor-default"
                        >
                          <Play className="h-3 w-3" />
                          {formatTime(entry.timeS)}
                        </button>
                      )}
                    </div>
                    <div className={`grid gap-2 ${compact ? "grid-cols-2" : "grid-cols-2 xl:grid-cols-4"}`}>
                      <Metric label="Marked" value={`${entry.geometry.marked_count}/${entry.geometry.expected_count || 6}`} />
                      <Metric label="Fan Angle" value={entry.geometry.fan_angle_deg} suffix="°" />
                      <Metric label="Toe Gap" value={entry.geometry.toe_gap_normalized} />
                      <Metric label="Heel Gap" value={entry.geometry.heel_gap_normalized} />
                      <Metric label="Left Axis" value={entry.geometry.left_axis_deg} suffix="°" />
                      <Metric label="Right Axis" value={entry.geometry.right_axis_deg} suffix="°" />
                      <Metric label="Left Planted Proxy" value={entry.geometry.left_planted_proxy} />
                      <Metric label="Right Planted Proxy" value={entry.geometry.right_planted_proxy} />
                    </div>
                    <p className="text-[10px] leading-relaxed text-muted-foreground">
                      Manual landmarks describe visible frame geometry only. Use with the saved video frame for foot spread, axis, toe/heel spacing, and planted/neutral review; do not treat as force, pressure, intent, or physiological cause.
                    </p>
                  </div>
                ))}
              </div>
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
          {showBalanceGauge && hasLeft && hasRight && (
            <SideBalanceGauge left={playbackPoint?.leftScore} right={playbackPoint?.rightScore} />
          )}
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

          {lowerBodyPatterns && (
        <div className="rounded-lg border border-border bg-card/40 p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Saved Lower-Body Pattern Proxies</p>
            <span className="text-[10px] text-muted-foreground">Review candidates only</span>
          </div>
          <div className={`grid gap-2 ${compact ? "grid-cols-2" : "sm:grid-cols-4"}`}>
            <PatternMetric label="Movement Bursts" value={lowerBodyPatterns.movement_burst_count} />
            <PatternMetric label="Oscillatory / Shudder-Like" value={lowerBodyPatterns.oscillatory_candidate_count} />
            <PatternMetric label="Sustained Elevations" value={lowerBodyPatterns.sustained_activity_shift_count} />
            <PatternMetric label="Side Divergences" value={lowerBodyPatterns.left_right_divergence_count} />
          </div>
          {[...(lowerBodyPatterns.oscillatory_candidates || []), ...(lowerBodyPatterns.divergence_candidates || [])].length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {[...(lowerBodyPatterns.oscillatory_candidates || []), ...(lowerBodyPatterns.divergence_candidates || [])]
                .sort((a, b) => a.time_s - b.time_s)
                .slice(0, 8)
                .map((candidate) => (
                  <button
                    key={`${candidate.type}-${candidate.time_s}`}
                    type="button"
                    onClick={() => onSeek?.(candidate.time_s)}
                    disabled={!onSeek}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card/60 px-2 py-1 text-[10px] text-foreground transition-colors enabled:hover:border-primary/40 enabled:hover:bg-primary/[0.08] disabled:cursor-default"
                  >
                    <Play className="h-3 w-3 text-primary" />
                    <span className="font-mono">{formatTime(candidate.time_s)}</span>
                    <span className="text-muted-foreground">
                      {candidate.type === "oscillatory_candidate"
                        ? "shudder-like"
                        : `${candidate.predominant_side || "side"} divergence`}
                    </span>
                  </button>
                ))}
            </div>
          )}
          <p className="text-[10px] leading-relaxed text-muted-foreground">{lowerBodyPatterns.method_note}</p>
        </div>
          )}

          {postureSummary && (
        <div className="rounded-lg border border-primary/20 bg-primary/[0.04] p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Saved Calibrated Foot Appearance Matching</p>
            <span className="text-[10px] text-muted-foreground">{postureSummary.coverage_pct}% sampled frame coverage</span>
          </div>
          {postureSummary.posture_candidates?.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {postureSummary.posture_candidates.slice(0, 10).map((candidate) => (
                <div
                  key={`${candidate.posture}-${candidate.time_s}`}
                  className="flex items-center gap-2 rounded-lg border border-primary/20 bg-card/60 p-2"
                >
                  <div className="flex h-11 w-12 shrink-0 flex-col items-center justify-center rounded-md border border-dashed border-border bg-muted/15 text-muted-foreground">
                    <Footprints className="h-3.5 w-3.5" />
                    <span className="text-[8px] uppercase">Preview</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onSeek?.(candidate.time_s)}
                    disabled={!onSeek}
                    className="min-w-0 flex-1 text-left enabled:hover:text-primary disabled:cursor-default"
                  >
                    <span className="inline-flex items-center gap-1 font-mono text-[10px] font-semibold text-primary">
                      <Play className="h-3 w-3" />{formatTime(candidate.time_s)}
                    </span>
                    <span className="block truncate text-[10px] text-foreground">{candidate.posture_phrase}</span>
                    <span className="mt-1 flex items-center gap-1">
                      <SavedConfidenceBadge level={candidate.confidence} />
                      {candidate.supporting_frames && <span className="text-[9px] text-muted-foreground">{candidate.supporting_frames} frames</span>}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {postureSummary.status === "references_needed"
                ? "Foot-region image samples were captured, but named reference moments were not available for a calibrated posture comparison."
                : "No sustained calibrated posture matches were saved from this run."}
            </p>
          )}
          <p className="text-[10px] leading-relaxed text-muted-foreground">{postureSummary.method_note}</p>
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

          {handBehaviorSummary && (
        <div className="rounded-lg border border-[#a78bfa]/30 bg-[#a78bfa]/[0.07] p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[#a78bfa]">Saved Calibrated Hand Behavior Matching</p>
            <span className="text-[10px] text-muted-foreground">Stroke-like proxy only</span>
          </div>
          {handBehaviorSummary.status === "calibrated_matching_available" ? (
            <>
              <div className={`grid gap-2 ${compact ? "grid-cols-2" : "sm:grid-cols-2"}`}>
                <Metric label="Stroke-Like Windows" value={handBehaviorSummary.stroke_like_window_count} />
                <Metric label="Matched Analyzed Time" value={handBehaviorSummary.stroke_like_time_pct} suffix="%" />
              </div>
              {handBehaviorSummary.stroke_like_windows?.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {handBehaviorSummary.stroke_like_windows.slice(0, 12).map((window) => (
                    <button
                      key={`${window.start_time_s}-${window.end_time_s}`}
                      type="button"
                      onClick={() => onSeek?.(window.start_time_s)}
                      disabled={!onSeek}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[#a78bfa]/25 bg-card/60 px-2 py-1 text-[10px] text-foreground enabled:hover:border-[#a78bfa]/50 disabled:cursor-default"
                    >
                      <Play className="h-3 w-3 text-[#a78bfa]" />
                      <span className="font-mono">{formatTime(window.start_time_s)}-{formatTime(window.end_time_s)}</span>
                      <SavedConfidenceBadge level={window.confidence} />
                      {window.cadence_proxy != null && <span className="text-muted-foreground">{window.cadence_proxy}/min</span>}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">{handBehaviorSummary.method_note}</p>
          )}
          {handBehaviorSummary.status === "calibrated_matching_available" && (
            <p className="text-[10px] leading-relaxed text-muted-foreground">{handBehaviorSummary.method_note}</p>
          )}
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
            {peakClusters.map((cluster, clusterIndex) => {
              if (cluster.length === 1) {
                const peak = cluster[0];
                return (
                  <button
                    key={peak.time_s}
                    type="button"
                    onClick={() => onSeek?.(peak.time_s)}
                    disabled={!onSeek}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card/60 px-2 py-1 text-[10px] text-foreground transition-colors enabled:hover:border-primary/40 enabled:hover:bg-primary/[0.08] disabled:cursor-default"
                  >
                    <Play className="h-3 w-3 text-primary" />
                    <span className="font-mono">{formatTime(peak.time_s)}</span>
                    {peak.left_lower_body_activity != null && <span className="text-muted-foreground">L{peak.left_lower_body_activity}/R{peak.right_lower_body_activity ?? "-"}</span>}
                  </button>
                );
              }
              const expandedCluster = expandedPeakClusters.includes(clusterIndex);
              return (
                <div key={`${cluster[0].time_s}-${cluster[cluster.length - 1].time_s}`} className="rounded-md border border-primary/20 bg-primary/[0.05] p-1">
                  <button
                    type="button"
                    onClick={() => {
                      onSeek?.(cluster[0].time_s);
                      setExpandedPeakClusters((current) => current.includes(clusterIndex)
                        ? current.filter((value) => value !== clusterIndex)
                        : [...current, clusterIndex]);
                    }}
                    className="inline-flex items-center gap-1.5 px-1 text-[10px] text-foreground"
                  >
                    <Play className="h-3 w-3 text-primary" />
                    <span className="font-mono">{formatTime(cluster[0].time_s)}-{formatTime(cluster[cluster.length - 1].time_s)}</span>
                    <span className="text-muted-foreground">cluster</span>
                    <span className="text-primary">{cluster.length} peaks</span>
                  </button>
                  {expandedCluster && (
                    <div className="mt-1 flex flex-wrap gap-1 border-t border-border pt-1">
                      {cluster.map((peak) => (
                        <button key={peak.time_s} type="button" onClick={() => onSeek?.(peak.time_s)} disabled={!onSeek} className="rounded border border-border px-1.5 py-0.5 text-[9px] disabled:cursor-default">
                          {formatTime(peak.time_s)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
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
