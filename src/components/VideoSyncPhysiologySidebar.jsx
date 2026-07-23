import { useMemo } from "react";
import { Activity, Gauge, HeartPulse, ShieldCheck, Wind } from "lucide-react";
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

const positiveOrNull = (value) => {
  const parsed = numberOrNull(value);
  return parsed != null && parsed > 0 ? parsed : null;
};

function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function humanize(value, fallback = "Unavailable") {
  const text = String(value || "").trim();
  if (!text) return fallback;
  return text.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function evidenceScore(row = {}) {
  return (
    (positiveOrNull(row.hr) != null ? 1 : 0)
    + (String(row.rr_intervals_ms || "").trim() ? 5 : 0)
    + (positiveOrNull(row.hrv_rmssd_ms) != null ? 4 : 0)
    + (positiveOrNull(row.respiration_bpm) != null ? 4 : 0)
    + (positiveOrNull(row.motion_peak_dynamic_mg) != null ? 3 : 0)
    + (numberOrNull(row.signal_confidence_score) != null ? 1 : 0)
  );
}

function nearestEvidenceRow(rows, seconds) {
  if (!rows.length) return null;
  const distance = (row) => Math.abs(Number(row.time_offset_s) - seconds);
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(rows[middle].time_offset_s) < seconds) low = middle + 1;
    else high = middle;
  }
  const closestCandidates = [rows[low - 1], rows[low]].filter(Boolean);
  const closestDistance = Math.min(...closestCandidates.map(distance));
  const nearby = [];
  for (let index = low - 1; index >= 0; index -= 1) {
    if (distance(rows[index]) > closestDistance + 0.75) break;
    nearby.push(rows[index]);
  }
  for (let index = low; index < rows.length; index += 1) {
    if (distance(rows[index]) > closestDistance + 0.75) break;
    nearby.push(rows[index]);
  }
  return nearby.reduce((best, row) => {
    const scoreDifference = evidenceScore(row) - evidenceScore(best);
    if (scoreDifference !== 0) return scoreDifference > 0 ? row : best;
    return distance(row) < distance(best) ? row : best;
  }, nearby[0]);
}

function MetricCard({ icon: Icon, label, value, unit, detail, tone }) {
  return (
    <div className="rounded-xl border border-border bg-background/70 p-3 shadow-sm">
      <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        <Icon className={`h-3.5 w-3.5 ${tone}`} />
        {label}
      </div>
      <p className={`mt-2 font-mono text-xl font-bold leading-none ${tone}`}>
        {value}
        {unit && value !== "--" && <span className="ml-1 text-[10px] font-semibold">{unit}</span>}
      </p>
      <p className="mt-2 min-h-7 text-[9px] leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}

function TrendChart({ rows, lines, playheadS, xDomain, onSeek, rightAxis = false }) {
  return (
    <div className="h-40 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={rows}
          margin={{ top: 8, right: rightAxis ? 12 : 4, bottom: 0, left: -24 }}
          onClick={(event) => {
            if (Number.isFinite(Number(event?.activeLabel))) onSeek?.(Number(event.activeLabel));
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.35} />
          <XAxis
            dataKey="t"
            type="number"
            domain={xDomain}
            allowDataOverflow
            tickFormatter={formatTime}
            tick={{ fontSize: 8 }}
            tickCount={6}
          />
          <YAxis yAxisId="left" domain={["auto", "auto"]} tick={{ fontSize: 8 }} />
          {rightAxis && (
            <YAxis
              yAxisId="right"
              orientation="right"
              domain={["auto", "auto"]}
              tick={{ fontSize: 8 }}
            />
          )}
          <Tooltip
            labelFormatter={(value) => `Time ${formatTime(value)}`}
            formatter={(value, key) => {
              const line = lines.find((candidate) => candidate.key === key);
              return [Number(value).toFixed(line?.decimals ?? 0), line?.label || key];
            }}
            contentStyle={{ fontSize: 10, borderRadius: 10 }}
          />
          <ReferenceLine
            yAxisId="left"
            x={playheadS}
            stroke="hsl(var(--foreground))"
            strokeWidth={1.5}
            strokeDasharray="3 2"
          />
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

export default function VideoSyncPhysiologySidebar({
  timelineRows = [],
  playheadS = 0,
  xDomain,
  zoomWindow,
  onZoomWindowChange,
  onSeek,
}) {
  const normalizedRows = useMemo(() => timelineRows
    .map((row) => ({
      ...row,
      t: numberOrNull(row.time_offset_s),
      hr: positiveOrNull(row.hr),
      smoothed: positiveOrNull(row.hr_smoothed),
      baseline: positiveOrNull(row.baseline_hr),
      rmssd: positiveOrNull(row.hrv_rmssd_ms),
      sdnn: positiveOrNull(row.hrv_sdnn_ms),
      respiration: positiveOrNull(row.respiration_bpm),
      motion: positiveOrNull(row.motion_dynamic_rms_mg) || positiveOrNull(row.motion_peak_dynamic_mg),
    }))
    .filter((row) => row.t != null)
    .sort((left, right) => left.t - right.t), [timelineRows]);
  const visibleRows = useMemo(() => normalizedRows.filter(
    (row) => row.t >= xDomain[0] - 5 && row.t <= xDomain[1] + 5,
  ), [normalizedRows, xDomain]);
  const current = useMemo(
    () => nearestEvidenceRow(normalizedRows, playheadS),
    [normalizedRows, playheadS],
  );
  const currentTime = numberOrNull(current?.time_offset_s);
  const sampleDistance = currentTime == null ? null : Math.abs(currentTime - playheadS);
  const hr = positiveOrNull(current?.hr);
  const rmssd = positiveOrNull(current?.hrv_rmssd_ms);
  const respiration = positiveOrNull(current?.respiration_bpm);
  const motion = positiveOrNull(current?.motion_dynamic_rms_mg)
    || positiveOrNull(current?.motion_peak_dynamic_mg);
  const rrAvailable = Boolean(String(current?.rr_intervals_ms || "").trim());
  const coreReliability = hr == null ? 0 : Math.min(100, 60 + (rrAvailable ? 25 : 0) + (rmssd != null ? 15 : 0));
  const multimodalReliability = Math.min(100, Math.max(
    current?.signal_confidence_level !== "unavailable"
      ? numberOrNull(current?.signal_confidence_score) || 0
      : 0,
    (respiration != null ? 50 : 0) + (motion != null ? 35 : 0),
  ));
  const hasAutonomic = useMemo(
    () => normalizedRows.some((row) => row.rmssd != null || row.sdnn != null),
    [normalizedRows],
  );
  const hasRespirationMotion = useMemo(
    () => normalizedRows.some((row) => row.respiration != null || row.motion != null),
    [normalizedRows],
  );

  return (
    <section className="space-y-3 rounded-2xl border border-primary/15 bg-gradient-to-b from-primary/[0.055] via-card to-card p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
            <Gauge className="h-3.5 w-3.5" />
            Physiology At Playhead
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Saved telemetry synchronized to {formatTime(playheadS)}
            {sampleDistance != null && sampleDistance >= 2 ? ` · nearest sample ${sampleDistance.toFixed(1)}s away` : ""}
          </p>
        </div>
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.08] px-2 py-1 text-right">
          <p className="text-[8px] font-semibold uppercase tracking-wider text-emerald-600">Core evidence</p>
          <p className="font-mono text-sm font-bold text-emerald-600">{coreReliability}%</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <MetricCard
          icon={HeartPulse}
          label="Heart Rate"
          value={hr != null ? Math.round(hr) : "--"}
          unit="bpm"
          detail={hr != null ? humanize(current?.hr_source, "Saved HR sample") : "No HR sample near this playhead"}
          tone="text-rose-500"
        />
        <MetricCard
          icon={Activity}
          label="RMSSD"
          value={rmssd != null ? rmssd.toFixed(1) : "--"}
          unit="ms"
          detail={rmssd != null ? `${humanize(current?.hrv_quality, "RR-derived")} variability` : "No RR-derived HRV at this moment"}
          tone="text-teal-500"
        />
        <MetricCard
          icon={Wind}
          label="Respiration"
          value={respiration != null ? respiration.toFixed(1) : "--"}
          unit="/min"
          detail={respiration != null
            ? `${humanize(current?.respiration_source)} · ${humanize(current?.respiration_confidence)}`
            : humanize(current?.respiration_unavailable_reason, "No respiratory evidence recorded")}
          tone="text-sky-500"
        />
        <MetricCard
          icon={Activity}
          label="Chest Motion"
          value={motion != null ? Math.round(motion) : "--"}
          unit="mg"
          detail={motion != null
            ? `${humanize(current?.motion_class)} · dynamic H10 acceleration`
            : "No H10 accelerometer evidence recorded"}
          tone="text-amber-500"
        />
      </div>

      <div className="grid grid-cols-2 gap-2 text-[9px]">
        <div className="rounded-lg border border-border bg-muted/20 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold uppercase tracking-wider text-muted-foreground">RR / HRV</span>
            <span className={rrAvailable ? "text-teal-500" : "text-muted-foreground"}>
              {rrAvailable ? "Available" : "Unavailable"}
            </span>
          </div>
        </div>
        <div className="rounded-lg border border-border bg-muted/20 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold uppercase tracking-wider text-muted-foreground">Multimodal</span>
            <span className={multimodalReliability ? "text-amber-500" : "text-muted-foreground"}>
              {multimodalReliability ? `${multimodalReliability}%` : "Unavailable"}
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Window</span>
        {[30, 60, 120, 300].map((windowSeconds) => (
          <button
            key={windowSeconds}
            type="button"
            onClick={() => onZoomWindowChange(windowSeconds)}
            className={`rounded-md px-2 py-1 text-[9px] font-semibold transition-colors ${
              zoomWindow === windowSeconds
                ? "bg-primary text-primary-foreground"
                : "border border-border bg-background text-muted-foreground hover:text-foreground"
            }`}
          >
            {windowSeconds < 60 ? `${windowSeconds}s` : `${windowSeconds / 60}m`}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-background/60 p-2.5">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Cardiac Trend</p>
          <div className="flex gap-2 text-[8px]">
            <span className="text-primary">HR</span>
            <span className="text-pink-500">Smoothed</span>
            <span className="text-slate-500">Baseline</span>
          </div>
        </div>
        <TrendChart
          rows={visibleRows}
          lines={[
            { key: "hr", label: "HR", color: "hsl(var(--primary))" },
            { key: "smoothed", label: "Smoothed", color: "#ec4899", width: 1.5 },
            { key: "baseline", label: "Baseline", color: "#64748b", width: 1.25, dash: "4 3" },
          ]}
          playheadS={playheadS}
          xDomain={xDomain}
          onSeek={onSeek}
        />
      </div>

      {hasAutonomic && (
        <div className="rounded-xl border border-border bg-background/60 p-2.5">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Autonomic Trend</p>
            <div className="flex gap-2 text-[8px]">
              <span className="text-teal-500">RMSSD</span>
              <span className="text-violet-500">SDNN</span>
            </div>
          </div>
          <TrendChart
            rows={visibleRows}
            lines={[
              { key: "rmssd", label: "RMSSD", color: "#14b8a6", decimals: 1 },
              { key: "sdnn", label: "SDNN", color: "#8b5cf6", decimals: 1 },
            ]}
            playheadS={playheadS}
            xDomain={xDomain}
            onSeek={onSeek}
          />
        </div>
      )}

      {hasRespirationMotion ? (
        <div className="rounded-xl border border-border bg-background/60 p-2.5">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Respiration & Motion</p>
            <div className="flex gap-2 text-[8px]">
              <span className="text-sky-500">Breaths/min</span>
              <span className="text-amber-500">Motion mg</span>
            </div>
          </div>
          <TrendChart
            rows={visibleRows}
            lines={[
              { key: "respiration", label: "Respiration", color: "#0ea5e9", decimals: 1 },
              { key: "motion", label: "Chest motion", color: "#f59e0b", axis: "right" },
            ]}
            playheadS={playheadS}
            xDomain={xDomain}
            onSeek={onSeek}
            rightAxis
          />
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border bg-muted/15 p-3">
          <p className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            Raw Sensor Evidence
          </p>
          <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
            This recording contains no saved H10 accelerometer or respiratory estimate. Sarah leaves these channels blank rather than inventing movement or breathing.
          </p>
        </div>
      )}
    </section>
  );
}
