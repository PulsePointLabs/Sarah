import { useEffect, useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Activity, Crosshair, Gauge, HeartPulse, Radio, ShieldCheck, Sparkles, Wind } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const numberOrNull = (value) => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function median(values) {
  const sorted = values.map(numberOrNull).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function average(values) {
  const usable = values.map(numberOrNull).filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function maximum(values) {
  const usable = values.map(numberOrNull).filter(Number.isFinite);
  return usable.length ? Math.max(...usable) : null;
}

function validPositive(value) {
  const parsed = numberOrNull(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function rowReliability(row) {
  const hr = validPositive(row.hr);
  const rr = String(row.rr_intervals_ms || "").trim();
  const hrv = validPositive(row.hrv_rmssd_ms);
  const respiration = validPositive(row.respiration_bpm);
  const motion = validPositive(row.motion_peak_dynamic_mg);
  const pmdScore = numberOrNull(row.signal_confidence_score);
  const core = hr != null ? Math.min(100, 60 + (rr ? 25 : 0) + (hrv != null ? 15 : 0)) : 0;
  const multimodal = Math.min(100, Math.max(
    pmdScore != null && row.signal_confidence_level !== "unavailable" ? pmdScore : 0,
    (respiration != null ? 50 : 0) + (motion != null ? 35 : 0),
  ));
  return { core, multimodal };
}

function nearestTimelineRow(rows, seconds) {
  if (!rows.length) return null;
  return rows.reduce((nearest, row) => (
    Math.abs(Number(row.time_offset_s) - seconds) < Math.abs(Number(nearest.time_offset_s) - seconds)
      ? row
      : nearest
  ), rows[0]);
}

function Metric({ icon: Icon, label, value, detail, tone = "text-primary" }) {
  return (
    <div className="rounded-xl border border-border bg-muted/15 p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className={`h-3.5 w-3.5 ${tone}`} /> {label}
      </div>
      <p className={`mt-2 font-mono text-xl font-bold ${tone}`}>{value}</p>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}

function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function TimelineChart({ rows, lines, inspectionTime, onInspectionTimeChange, rightAxis = false }) {
  return (
    <div className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={rows}
          margin={{ top: 8, right: rightAxis ? 16 : 6, bottom: 0, left: -22 }}
          onClick={(event) => {
            if (Number.isFinite(Number(event?.activeLabel))) onInspectionTimeChange?.(Number(event.activeLabel));
          }}
        >
          <CartesianGrid strokeDasharray="3 3" opacity={0.16} />
          <XAxis dataKey="time_offset_s" type="number" domain={["dataMin", "dataMax"]} tickFormatter={formatTime} tick={{ fontSize: 9 }} />
          <YAxis yAxisId="left" tick={{ fontSize: 9 }} domain={["auto", "auto"]} />
          {rightAxis && <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 9 }} domain={["auto", "auto"]} />}
          <Tooltip
            labelFormatter={(value) => `Time ${formatTime(value)}`}
            formatter={(value, name) => [Number(value).toFixed(1), lines.find((line) => line.key === name)?.label || name]}
            contentStyle={{ fontSize: 11 }}
            labelStyle={{ color: "#111827", fontWeight: 600 }}
          />
          {Number.isFinite(Number(inspectionTime)) && <ReferenceLine yAxisId="left" x={Number(inspectionTime)} stroke="#f43f5e" strokeDasharray="3 2" />}
          {lines.map((line) => (
            <Line
              key={line.key}
              yAxisId={line.axis || "left"}
              type="monotone"
              dataKey={line.key}
              name={line.key}
              stroke={line.color}
              strokeWidth={line.width || 2}
              strokeDasharray={line.dash}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function PhysiologyTimelineCharts({ session = {}, timelineRows = [], inspectionTime, onInspectionTimeChange }) {
  const [localReplayTime, setLocalReplayTime] = useState(0);
  const [historicalSessions, setHistoricalSessions] = useState([]);
  const isBodyExploration = session?.capture_kind === "body_exploration" || session?.standalone_body_exploration;
  const capturePreflight = session?.capture_preflight || null;

  useEffect(() => {
    let active = true;
    const entity = isBodyExploration ? base44.entities.BodyExploration : base44.entities.Session;
    entity.listFields(
      ["id", "date", "avg_hr", "max_hr", "duration_minutes", "capture_kind", "standalone_body_exploration"],
      "-date",
      24,
    ).then((rows) => {
      if (active) setHistoricalSessions((rows || []).filter((row) => row.id !== session?.id));
    }).catch(() => {
      if (active) setHistoricalSessions([]);
    });
    return () => {
      active = false;
    };
  }, [isBodyExploration, session?.id]);
  const chartRows = useMemo(() => {
    const stride = Math.max(1, Math.ceil(timelineRows.length / 900));
    return timelineRows.filter((_row, index) => index % stride === 0).map((row) => ({
      ...row,
      time_offset_s: numberOrNull(row.time_offset_s),
      respiration_bpm: numberOrNull(row.respiration_bpm),
      motion_dynamic_rms_mg: numberOrNull(row.motion_dynamic_rms_mg),
      motion_peak_dynamic_mg: numberOrNull(row.motion_peak_dynamic_mg),
      signal_confidence_score: numberOrNull(row.signal_confidence_score),
      orientation_change_degrees: numberOrNull(row.orientation_change_degrees),
      recovery_drop_30_bpm: numberOrNull(row.recovery_drop_30_bpm),
      recovery_drop_60_bpm: numberOrNull(row.recovery_drop_60_bpm),
      recovery_drop_90_bpm: numberOrNull(row.recovery_drop_90_bpm),
      response_latency_seconds: numberOrNull(row.response_latency_seconds),
      reliability_core: rowReliability(row).core,
      reliability_multimodal: rowReliability(row).multimodal,
    })).filter((row) => row.time_offset_s != null);
  }, [timelineRows]);

  const hasRespiration = chartRows.some((row) => Number(row.respiration_bpm) > 0);
  const hasMotion = chartRows.some((row) => Number(row.motion_dynamic_rms_mg) > 0 || Number(row.motion_peak_dynamic_mg) > 0);
  const hasRecovery = chartRows.some((row) => row.recovery_drop_30_bpm != null || row.recovery_drop_60_bpm != null || row.recovery_drop_90_bpm != null);
  const hasResponseLatency = chartRows.some((row) => row.response_latency_seconds != null);
  const hasSignal = chartRows.some((row) => row.signal_confidence_score != null && row.signal_confidence_level !== "unavailable");
  const hasPosition = chartRows.some((row) => row.orientation_change_degrees != null);
  const hrvMedian = median(timelineRows.map((row) => row.hrv_rmssd_ms));
  const respirationAverage = average(timelineRows.map((row) => Number(row.respiration_bpm) > 0 ? row.respiration_bpm : null));
  const motionPeak = maximum(timelineRows.map((row) => Number(row.motion_peak_dynamic_mg) > 0 ? row.motion_peak_dynamic_mg : null));
  const recoveryPeak = maximum(timelineRows.flatMap((row) => [row.recovery_drop_30_bpm, row.recovery_drop_60_bpm, row.recovery_drop_90_bpm]));
  const unavailableReason = !hasMotion && !hasRespiration
    ? "No H10 PMD sensor samples were saved"
    : [...timelineRows].reverse().find((row) => row.respiration_unavailable_reason)?.respiration_unavailable_reason;
  const breathHolds = timelineRows.filter((row) => row.possible_breath_hold === true || String(row.possible_breath_hold).toLowerCase() === "true").length;
  const maxTime = chartRows.length ? Number(chartRows[chartRows.length - 1].time_offset_s) || 0 : 0;
  const replayTime = Number.isFinite(Number(inspectionTime)) ? Number(inspectionTime) : localReplayTime;
  const inspectedRow = nearestTimelineRow(chartRows, replayTime);
  const inspectedReliability = inspectedRow ? rowReliability(inspectedRow) : { core: 0, multimodal: 0 };
  const coreCoverage = chartRows.length
    ? Math.round(chartRows.filter((row) => row.reliability_core >= 80).length / chartRows.length * 100)
    : 0;
  const multimodalCoverage = chartRows.length
    ? Math.round(chartRows.filter((row) => row.reliability_multimodal >= 50).length / chartRows.length * 100)
    : 0;
  const hrValues = timelineRows.map((row) => validPositive(row.hr)).filter(Number.isFinite);
  const baselineHr = median(hrValues.slice(0, Math.max(10, Math.round(hrValues.length * 0.12))));
  const peakHr = maximum(hrValues);
  const earlyHrv = median(timelineRows.slice(0, Math.max(10, Math.round(timelineRows.length * 0.2))).map((row) => row.hrv_rmssd_ms));
  const lowHrv = median(timelineRows.map((row) => row.hrv_rmssd_ms).filter((value) => validPositive(value) != null).sort((a, b) => a - b).slice(0, Math.max(5, Math.round(timelineRows.length * 0.15))));
  const responseLoad = baselineHr != null && peakHr != null ? peakHr - baselineHr : null;
  const hrvSuppression = earlyHrv != null && lowHrv != null && earlyHrv > 0
    ? Math.max(0, Math.min(100, ((earlyHrv - lowHrv) / earlyHrv) * 100))
    : null;
  const historicalResponseRows = historicalSessions
    .map((row) => {
      const avgHr = validPositive(row.avg_hr);
      const maxHr = validPositive(row.max_hr);
      return avgHr != null && maxHr != null ? { avgHr, maxHr, load: Math.max(0, maxHr - avgHr) } : null;
    })
    .filter(Boolean);
  const historicalTypicalAvg = average(historicalResponseRows.map((row) => row.avgHr));
  const historicalTypicalPeak = average(historicalResponseRows.map((row) => row.maxHr));
  const currentAverageHr = average(hrValues);
  const peakVsHistory = peakHr != null && historicalTypicalPeak != null ? peakHr - historicalTypicalPeak : null;
  const setReplayTime = (seconds) => {
    const next = Math.max(0, Math.min(maxTime, Number(seconds) || 0));
    setLocalReplayTime(next);
    onInspectionTimeChange?.(next);
  };

  if (!timelineRows.length) return null;

  return (
    <div className="space-y-3">
      <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
        <Metric icon={HeartPulse} label="Median RMSSD" value={hrvMedian != null ? `${hrvMedian.toFixed(1)} ms` : "--"} detail={hrvMedian != null ? "RR-derived autonomic variability" : "No usable RR-derived HRV saved"} tone="text-teal-500" />
        <Metric icon={Wind} label="Respiration" value={respirationAverage != null ? `${respirationAverage.toFixed(1)}/min` : "--"} detail={hasRespiration ? `${breathHolds} possible hold samples` : unavailableReason || "Chest sensor stream was not recorded"} tone="text-sky-500" />
        <Metric icon={Activity} label="Chest Motion" value={motionPeak != null ? `${motionPeak.toFixed(0)} mg` : "--"} detail={hasMotion ? "Peak dynamic H10 acceleration" : "H10 accelerometer was unavailable"} tone="text-amber-500" />
        <Metric icon={Gauge} label="Recovery Drop" value={recoveryPeak != null ? `${recoveryPeak.toFixed(0)} bpm` : "--"} detail={hasRecovery ? "Largest saved 30/60/90-second drop" : "No sustained recovery window saved"} tone="text-rose-500" />
      </div>

      <details className="rounded-xl border border-primary/20 bg-primary/5 p-3">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Physiology Replay & Evidence Inspector</summary>
        <p className="mt-1 text-[10px] text-muted-foreground">Scrub the saved session clock to inspect what was measured, estimated, or unavailable at that exact moment.</p>
        <input
          type="range"
          min="0"
          max={Math.max(1, maxTime)}
          step="0.5"
          value={Math.min(replayTime, Math.max(1, maxTime))}
          onChange={(event) => setReplayTime(event.target.value)}
          className="mt-3 w-full accent-primary"
          aria-label="Physiology replay time"
        />
        <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
          <span>0:00</span>
          <span className="font-semibold text-primary">{formatTime(replayTime)}</span>
          <span>{formatTime(maxTime)}</span>
        </div>
        {inspectedRow && (
          <div className="mt-3 grid gap-2 grid-cols-2 lg:grid-cols-4">
            <Metric icon={HeartPulse} label="Heart Rate" value={validPositive(inspectedRow.hr) != null ? `${Math.round(Number(inspectedRow.hr))} bpm` : "--"} detail={String(inspectedRow.hr_source || "source unavailable").replaceAll("_", " ")} tone="text-rose-500" />
            <Metric icon={Activity} label="RR / HRV" value={validPositive(inspectedRow.hrv_rmssd_ms) != null ? `${Number(inspectedRow.hrv_rmssd_ms).toFixed(1)} ms` : "--"} detail={inspectedRow.rr_intervals_ms ? `${String(inspectedRow.hrv_quality || "unknown")} quality RR evidence` : "No RR intervals saved at this moment"} tone="text-teal-500" />
            <Metric icon={Wind} label="Respiration" value={validPositive(inspectedRow.respiration_bpm) != null ? `${Number(inspectedRow.respiration_bpm).toFixed(1)}/min` : "--"} detail={validPositive(inspectedRow.respiration_bpm) != null ? `${String(inspectedRow.respiration_source || "estimated").replaceAll("_", " ")} · ${inspectedRow.respiration_confidence || "limited"} confidence` : `Unavailable: ${String(inspectedRow.respiration_unavailable_reason || "no respiratory evidence").replaceAll("_", " ")}`} tone="text-sky-500" />
            <Metric icon={ShieldCheck} label="Evidence Reliability" value={`${inspectedReliability.core}% core`} detail={`${inspectedReliability.multimodal}% multimodal · zero means unavailable, not absent physiology`} tone="text-emerald-500" />
          </div>
        )}
        {capturePreflight && (
          <div className="mt-3 rounded-lg border border-border bg-background/70 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Capture-start preflight</p>
              <span className="font-mono text-[10px] text-muted-foreground">
                {capturePreflight.capturedAt ? new Date(capturePreflight.capturedAt).toLocaleTimeString() : "time unavailable"}
              </span>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["HR", capturePreflight.hr?.available ? "measured" : "unavailable", capturePreflight.hr?.source],
                ["RR / HRV", capturePreflight.rrHrv?.available ? "measured" : "unavailable", capturePreflight.rrHrv?.quality],
                ["Raw ECG / motion", capturePreflight.rawH10?.available ? "measured" : "unavailable", capturePreflight.rawH10?.message],
                ["Respiration", capturePreflight.respiration?.available ? "estimated" : "unavailable", capturePreflight.respiration?.source || capturePreflight.respiration?.reason],
              ].map(([label, value, detail]) => (
                <div key={label} className="rounded-md border border-border bg-muted/20 px-2 py-1.5">
                  <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
                  <p className="mt-0.5 text-xs font-semibold text-foreground">{value}</p>
                  {detail && <p className="mt-0.5 line-clamp-2 text-[9px] text-muted-foreground">{String(detail).replaceAll("_", " ")}</p>}
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground">
              Saved at session start. “Unavailable” means Sarah did not receive that channel; it never means zero breathing or zero movement.
            </p>
          </div>
        )}
      </details>

      <details className="rounded-xl border border-border bg-muted/10 p-3">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Reliability Timeline</summary>
        <p className="mt-1 text-[10px] text-muted-foreground">Core reliability scores HR plus RR/HRV. Multimodal reliability separately scores respiration, motion, position, and raw PMD evidence.</p>
        <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-600">{coreCoverage}% core coverage</span>
          <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-sky-600">{multimodalCoverage}% multimodal coverage</span>
        </div>
        <TimelineChart
          rows={chartRows}
          inspectionTime={replayTime}
          onInspectionTimeChange={setReplayTime}
          lines={[
            { key: "reliability_core", label: "Core HR/RR reliability", color: "#10b981" },
            { key: "reliability_multimodal", label: "Multimodal reliability", color: "#0ea5e9", dash: "4 2" },
          ]}
        />
      </details>

      <details className="rounded-xl border border-border bg-muted/10 p-3">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Personal Response Model</summary>
        <p className="mt-1 text-[10px] text-muted-foreground">A transparent response profile compared with prior same-type recordings. It summarizes saved evidence; it does not invent missing sensor channels.</p>
        <div className="mt-3 grid gap-2 grid-cols-2 lg:grid-cols-4">
          <Metric icon={Gauge} label="Cardiac Load" value={responseLoad != null ? `+${responseLoad.toFixed(0)} bpm` : "--"} detail={baselineHr != null && peakHr != null ? `Approx. baseline ${baselineHr.toFixed(0)} · peak ${peakHr.toFixed(0)}` : "Insufficient HR evidence"} tone="text-rose-500" />
          <Metric icon={Sparkles} label="HRV Compression" value={hrvSuppression != null ? `${hrvSuppression.toFixed(0)}%` : "--"} detail={hrvSuppression != null ? "Early RMSSD compared with the session's lower-RMSSD windows" : "Insufficient RR-derived HRV"} tone="text-violet-500" />
          <Metric icon={Crosshair} label="Personal Baseline" value={historicalTypicalPeak != null ? `${historicalTypicalPeak.toFixed(0)} peak` : "--"} detail={historicalResponseRows.length ? `${historicalResponseRows.length} prior ${isBodyExploration ? "exploration" : "session"} records · typical avg ${historicalTypicalAvg.toFixed(0)} bpm` : "No prior same-type records with summary HR"} tone="text-amber-500" />
          <Metric icon={ShieldCheck} label="Current vs Typical" value={peakVsHistory != null ? `${peakVsHistory >= 0 ? "+" : ""}${peakVsHistory.toFixed(0)} bpm` : `${coreCoverage}%`} detail={peakVsHistory != null ? `Current avg ${currentAverageHr?.toFixed(0) || "--"} · current peak ${peakHr?.toFixed(0) || "--"} · ${coreCoverage}% core coverage` : `${timelineRows.length.toLocaleString()} rows · ${multimodalCoverage}% with additional sensor evidence`} tone="text-emerald-500" />
        </div>
      </details>

      {(hasRespiration || hasMotion) && (
        <details className="rounded-xl border border-border bg-muted/10 p-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Respiration & Chest Motion</summary>
          <p className="mt-1 text-[10px] text-muted-foreground">Respiratory estimate and dynamic H10 acceleration aligned to the saved session clock.</p>
          <TimelineChart
            rows={chartRows}
            inspectionTime={inspectionTime}
            onInspectionTimeChange={onInspectionTimeChange}
            rightAxis={hasRespiration && hasMotion}
            lines={[
              ...(hasRespiration ? [{ key: "respiration_bpm", label: "Respiration / min", color: "#0ea5e9" }] : []),
              ...(hasMotion ? [
                { key: "motion_dynamic_rms_mg", label: "Motion RMS mg", color: "#f59e0b", axis: hasRespiration ? "right" : "left" },
                { key: "motion_peak_dynamic_mg", label: "Motion peak mg", color: "#fb7185", axis: hasRespiration ? "right" : "left", dash: "4 2", width: 1.4 },
              ] : []),
            ]}
          />
        </details>
      )}

      {(hasRecovery || hasResponseLatency) && (
        <details className="rounded-xl border border-border bg-muted/10 p-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Recovery & Response</summary>
          <p className="mt-1 text-[10px] text-muted-foreground">Saved post-peak heart-rate drops and marked-response latency.</p>
          <TimelineChart
            rows={chartRows}
            inspectionTime={inspectionTime}
            onInspectionTimeChange={onInspectionTimeChange}
            rightAxis={hasRecovery && hasResponseLatency}
            lines={[
              ...(hasRecovery ? [
                { key: "recovery_drop_30_bpm", label: "30 sec drop", color: "#fb7185" },
                { key: "recovery_drop_60_bpm", label: "60 sec drop", color: "#a855f7" },
                { key: "recovery_drop_90_bpm", label: "90 sec drop", color: "#14b8a6" },
              ] : []),
              ...(hasResponseLatency ? [{ key: "response_latency_seconds", label: "Response latency sec", color: "#f59e0b", axis: hasRecovery ? "right" : "left", dash: "4 2" }] : []),
            ]}
          />
        </details>
      )}

      {(hasSignal || hasPosition) && (
        <details className="rounded-xl border border-border bg-muted/10 p-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Signal Quality & Position</summary>
          <p className="mt-1 text-[10px] text-muted-foreground">Use this trace to distinguish physiological changes from strap movement or orientation shifts.</p>
          <TimelineChart
            rows={chartRows}
            inspectionTime={inspectionTime}
            onInspectionTimeChange={onInspectionTimeChange}
            rightAxis={hasSignal && hasPosition}
            lines={[
              ...(hasSignal ? [{ key: "signal_confidence_score", label: "Signal confidence", color: "#22c55e" }] : []),
              ...(hasPosition ? [{ key: "orientation_change_degrees", label: "Orientation change degrees", color: "#a855f7", axis: hasSignal ? "right" : "left" }] : []),
            ]}
          />
        </details>
      )}

      {!hasRespiration && !hasMotion && !hasRecovery && !hasResponseLatency && !hasSignal && !hasPosition && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/10 p-3 text-xs text-muted-foreground">
          <Radio className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p>HR and RR-derived HRV were saved. Additional H10 sensor channels were unavailable for this capture, so no empty physiology charts are shown.</p>
        </div>
      )}
    </div>
  );
}
