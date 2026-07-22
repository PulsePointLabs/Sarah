import { useMemo } from "react";
import { Activity, Gauge, HeartPulse, Radio, Wind } from "lucide-react";
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

export default function PhysiologyTimelineCharts({ timelineRows = [], inspectionTime, onInspectionTimeChange }) {
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
    })).filter((row) => row.time_offset_s != null);
  }, [timelineRows]);

  const hasRespiration = chartRows.some((row) => row.respiration_bpm != null);
  const hasMotion = chartRows.some((row) => row.motion_dynamic_rms_mg != null || row.motion_peak_dynamic_mg != null);
  const hasRecovery = chartRows.some((row) => row.recovery_drop_30_bpm != null || row.recovery_drop_60_bpm != null || row.recovery_drop_90_bpm != null);
  const hasResponseLatency = chartRows.some((row) => row.response_latency_seconds != null);
  const hasSignal = chartRows.some((row) => row.signal_confidence_score != null && row.signal_confidence_level !== "unavailable");
  const hasPosition = chartRows.some((row) => row.orientation_change_degrees != null);
  const hrvMedian = median(timelineRows.map((row) => row.hrv_rmssd_ms));
  const respirationAverage = average(timelineRows.map((row) => row.respiration_bpm));
  const motionPeak = maximum(timelineRows.map((row) => row.motion_peak_dynamic_mg));
  const recoveryPeak = maximum(timelineRows.flatMap((row) => [row.recovery_drop_30_bpm, row.recovery_drop_60_bpm, row.recovery_drop_90_bpm]));
  const unavailableReason = !hasMotion && !hasRespiration
    ? "No H10 PMD sensor samples were saved"
    : [...timelineRows].reverse().find((row) => row.respiration_unavailable_reason)?.respiration_unavailable_reason;
  const breathHolds = timelineRows.filter((row) => row.possible_breath_hold === true || String(row.possible_breath_hold).toLowerCase() === "true").length;

  if (!timelineRows.length) return null;

  return (
    <div className="space-y-3">
      <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
        <Metric icon={HeartPulse} label="Median RMSSD" value={hrvMedian != null ? `${hrvMedian.toFixed(1)} ms` : "--"} detail={hrvMedian != null ? "RR-derived autonomic variability" : "No usable RR-derived HRV saved"} tone="text-teal-500" />
        <Metric icon={Wind} label="Respiration" value={respirationAverage != null ? `${respirationAverage.toFixed(1)}/min` : "--"} detail={hasRespiration ? `${breathHolds} possible hold samples` : unavailableReason || "Chest sensor stream was not recorded"} tone="text-sky-500" />
        <Metric icon={Activity} label="Chest Motion" value={motionPeak != null ? `${motionPeak.toFixed(0)} mg` : "--"} detail={hasMotion ? "Peak dynamic H10 acceleration" : "H10 accelerometer was unavailable"} tone="text-amber-500" />
        <Metric icon={Gauge} label="Recovery Drop" value={recoveryPeak != null ? `${recoveryPeak.toFixed(0)} bpm` : "--"} detail={hasRecovery ? "Largest saved 30/60/90-second drop" : "No sustained recovery window saved"} tone="text-rose-500" />
      </div>

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
