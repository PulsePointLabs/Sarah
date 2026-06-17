import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertTriangle, Crosshair, RotateCcw } from "lucide-react";
import { useChartZoom } from "@/hooks/useChartZoom";
import { summarizePerinealEmg } from "@/utils/perinealEmgSummary";

const EVENT_COLORS = {
  light: "#38bdf8",
  moderate: "#22c55e",
  strong: "#f97316",
  sustained: "#eab308",
  possible_artifact: "#f43f5e",
};

const LEGEND_ITEMS = [
  ["light", "Light"],
  ["moderate", "Moderate"],
  ["strong", "Strong"],
  ["sustained", "Sustained"],
  ["possible_artifact", "Artifact"],
];

function fmtMmSs(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "--";
  if (value >= 60) return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
  return `${value.toFixed(value < 10 ? 1 : 0)}s`;
}

function formatPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n)}%` : "--";
}

function contractionTypeLabel(type) {
  if (type === "possible_artifact") return "Possible artifact";
  if (type === "sustained") return "Sustained hold";
  return `${String(type || "moderate").slice(0, 1).toUpperCase()}${String(type || "moderate").slice(1)}`;
}

function metricTiles(summary) {
  const strongest = summary.strongestEvent;
  const longest = summary.longestHoldEvent;
  return [
    { label: "Total", value: summary.total },
    { label: "Light", value: summary.byType.light || 0 },
    { label: "Moderate", value: summary.byType.moderate || 0 },
    { label: "Strong", value: summary.byType.strong || 0 },
    { label: "Holds", value: summary.byType.sustained || 0 },
    { label: "Artifacts", value: summary.possibleArtifactCount || 0 },
    { label: "Strongest", value: strongest ? formatPct(strongest.peak_pct) : "--", detail: summary.strongestEventTypeLabel },
    { label: "Longest", value: longest ? formatDuration(longest.duration_s) : "--", detail: longest ? contractionTypeLabel(longest.contraction_type) : null },
    { label: "Avg duration", value: summary.averageDurationSeconds != null ? formatDuration(summary.averageDurationSeconds) : "--" },
    { label: "Active time", value: formatDuration(summary.totalActiveSeconds || 0) },
  ];
}

function MetricTile({ label, value, detail }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card px-3 py-2">
      <p className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 truncate font-mono text-base font-semibold text-foreground sm:text-lg">{value}</p>
      {detail && <p className="mt-0.5 truncate text-[10px] font-medium text-muted-foreground">{detail}</p>}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-semibold text-muted-foreground">
      {LEGEND_ITEMS.map(([type, label]) => (
        <span key={type} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: EVENT_COLORS[type] }} />
          {label}
        </span>
      ))}
    </div>
  );
}

function graphRowsFromEmg(emgRows = []) {
  return (emgRows || [])
    .map((row) => {
      const t = Number(row.time_s);
      const level = Number(row.level_pct ?? row.left_pct);
      if (!Number.isFinite(t) || !Number.isFinite(level)) return null;
      return {
        time_s: t,
        level_pct: Math.max(0, Math.min(100, level)),
      };
    })
    .filter(Boolean);
}

function eventGraphRows(events = []) {
  return (events || [])
    .map((event) => {
      const t = Number(event.peak_time_s ?? event.time_s);
      const level = Number(event.peak_pct ?? 0);
      if (!Number.isFinite(t)) return null;
      return { time_s: t, level_pct: Math.max(0, Math.min(100, level)) };
    })
    .filter(Boolean);
}

export default function PerinealEmgPanel({
  session,
  summary: providedSummary,
  emgRows = [],
  inspectionTime,
  onInspectionTimeChange,
}) {
  const summary = useMemo(() => providedSummary || summarizePerinealEmg(session), [providedSummary, session]);
  const graphRows = useMemo(() => {
    const rows = graphRowsFromEmg(emgRows);
    if (rows.length) return rows;
    return eventGraphRows(summary.events);
  }, [emgRows, summary.events]);

  const minTime = graphRows.length ? Math.min(...graphRows.map((row) => row.time_s), ...summary.events.map((event) => Number(event.time_s ?? event.peak_time_s) || 0)) : 0;
  const maxTime = graphRows.length ? Math.max(...graphRows.map((row) => row.time_s), ...summary.events.map((event) => Number(event.time_s ?? event.peak_time_s) || 0)) : 1;
  const { zoomDomain, resetZoom, isSelecting, selectRange, chartProps, wrapperProps } = useChartZoom(minTime, maxTime);
  const xDomain = zoomDomain ? [zoomDomain.x1, zoomDomain.x2] : [minTime, maxTime];
  const displayRows = useMemo(() => {
    if (!zoomDomain) return graphRows;
    return graphRows.filter((row) => row.time_s >= zoomDomain.x1 && row.time_s <= zoomDomain.x2);
  }, [graphRows, zoomDomain]);
  const visibleEvents = useMemo(() => (
    summary.events.filter((event) => {
      const t = Number(event.time_s ?? event.peak_time_s);
      if (!Number.isFinite(t)) return false;
      return !zoomDomain || (t >= zoomDomain.x1 && t <= zoomDomain.x2);
    })
  ), [summary.events, zoomDomain]);
  const tableEvents = useMemo(() => summary.events.slice(0, 16), [summary.events]);

  if (!summary.hasPerinealEvents && !summary.hasPerinealSetup) return null;

  const qualityTone = summary.qualityDisplayLabel === "High Confidence"
    ? "border-primary/30 bg-primary/10 text-primary"
    : summary.qualityDisplayLabel === "Artifact Heavy"
      ? "border-amber-400/30 bg-amber-400/10 text-amber-300"
      : summary.qualityDisplayLabel === "Mixed / review"
        ? "border-sky-400/30 bg-sky-400/10 text-sky-300"
        : "border-border bg-muted/30 text-muted-foreground";

  return (
    <section className="rounded-xl border border-primary/25 bg-primary/[0.04] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Perineal EMG</h3>
          <p className="mt-1 max-w-3xl text-sm font-medium text-foreground">{summary.storySentence}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Detected perineal EMG activation is aligned with the same inspection cursor as HR and HRV.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {zoomDomain && (
            <button
              type="button"
              onClick={resetZoom}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] font-semibold text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="h-3 w-3" />
              Reset zoom
            </button>
          )}
          <span className={`rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${qualityTone}`}>
            {summary.qualityDisplayLabel}
          </span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {metricTiles(summary).map((tile) => <MetricTile key={tile.label} {...tile} />)}
      </div>

      {summary.possibleArtifactCount > 0 && (
        <div className="mt-3 flex gap-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            {summary.possibleArtifactCount} possible artifact marker{summary.possibleArtifactCount === 1 ? "" : "s"} detected. Treat those as cough/glute/adductor or contact-noise candidates unless other evidence supports true pelvic-floor activation.
          </p>
        </div>
      )}

      {graphRows.length > 0 && (
        <div className="mt-4 rounded-lg border border-border bg-card p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Perineal EMG Timeline</p>
            <span className="text-[10px] text-muted-foreground">Drag across the graph to zoom. Click to move the shared inspection cursor.</span>
            <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-rose-400">
              <Crosshair className="h-3 w-3" />
              {fmtMmSs(inspectionTime)}
            </span>
          </div>
          <div className="mb-2">
            <Legend />
          </div>
          <div className="h-44" {...wrapperProps}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={displayRows}
                margin={{ top: 4, right: 8, bottom: 0, left: -24 }}
                onClick={(data) => {
                  if (Number.isFinite(Number(data?.activeLabel))) onInspectionTimeChange?.(Number(data.activeLabel));
                }}
                {...chartProps}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="time_s"
                  type="number"
                  domain={xDomain}
                  tick={{ fontSize: 9 }}
                  tickFormatter={fmtMmSs}
                />
                <YAxis domain={[0, 100]} tick={{ fontSize: 9 }} unit="%" />
                <Tooltip
                  labelFormatter={(value) => fmtMmSs(value)}
                  formatter={(value) => [`${Math.round(Number(value))}%`, "Perineal EMG"]}
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                {isSelecting && selectRange && (
                  <ReferenceArea x1={selectRange.x1} x2={selectRange.x2} strokeOpacity={0.2} fill="hsl(var(--primary))" fillOpacity={0.16} />
                )}
                {Number.isFinite(Number(inspectionTime)) && (
                  <ReferenceLine x={Number(inspectionTime)} stroke="#f43f5e" strokeWidth={1.5} strokeDasharray="3 2" />
                )}
                {visibleEvents.map((event) => {
                  const t = Number(event.time_s ?? event.peak_time_s);
                  const color = EVENT_COLORS[event.contraction_type] || EVENT_COLORS.moderate;
                  return (
                    <ReferenceLine
                      key={event.id}
                      x={t}
                      stroke={color}
                      strokeWidth={event.contraction_type === "possible_artifact" ? 1.5 : 2}
                      strokeDasharray={event.contraction_type === "possible_artifact" ? "1 3" : "2 2"}
                      label={{ value: contractionTypeLabel(event.contraction_type), fontSize: 8, fill: color, position: "top" }}
                    />
                  );
                })}
                <Line
                  type="monotone"
                  dataKey="level_pct"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 3 }}
                  connectNulls
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {summary.hasPerinealEvents ? (
        <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
          <div className="grid grid-cols-[3.75rem_minmax(0,1fr)_3.25rem_3.25rem_3.75rem] gap-2 border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:grid-cols-[4.5rem_1fr_4rem_4rem_5rem]">
            <span>Time</span>
            <span>Type</span>
            <span>Dur.</span>
            <span>Peak</span>
            <span>Conf.</span>
          </div>
          <div className="divide-y divide-border">
            {tableEvents.map((event) => (
              <button
                key={event.id}
                type="button"
                onClick={() => onInspectionTimeChange?.(Number(event.peak_time_s ?? event.time_s))}
                className="grid w-full grid-cols-[3.75rem_minmax(0,1fr)_3.25rem_3.25rem_3.75rem] gap-2 px-3 py-2 text-left text-xs hover:bg-muted/30 sm:grid-cols-[4.5rem_1fr_4rem_4rem_5rem]"
              >
                <span className="font-mono text-muted-foreground">{fmtMmSs(event.peak_time_s ?? event.time_s)}</span>
                <span className="min-w-0 font-medium text-foreground">
                  <span className="block truncate">{contractionTypeLabel(event.contraction_type)}</span>
                  {event.contraction_type === "possible_artifact" && (
                    <span className="mt-0.5 inline-flex rounded-full border border-amber-400/25 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300">
                      Artifact
                    </span>
                  )}
                </span>
                <span className="font-mono text-muted-foreground">{formatDuration(event.duration_s)}</span>
                <span className="font-mono text-muted-foreground">{formatPct(event.peak_pct)}</span>
                <span className="text-muted-foreground">{event.confidence_label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-3 rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          No detected perineal contractions are saved in this session timeline yet. If you ran the protocol, confirm Live Capture was recording and Perineal Body EMG mode was selected.
        </p>
      )}
    </section>
  );
}
