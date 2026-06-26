import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Activity,
  ArrowLeft,
  Brain,
  Clock3,
  HeartPulse,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
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
import TTSReader from "@/components/TTSReader";
import { apiUrl } from "@/lib/mobileApiBase";

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fmtDateTime(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours
    ? `${hours}h ${minutes}m ${remainder}s`
    : `${minutes}m ${remainder}s`;
}

function fmtElapsed(seconds) {
  const total = Math.max(0, Math.round(number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function Metric({ label, value, accent = false }) {
  return (
    <div className={`min-w-0 rounded-lg border px-3 py-3 ${accent ? "border-primary/30 bg-primary/[0.08]" : "border-border bg-muted/15"}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 break-words font-mono text-xl font-bold text-foreground">{value ?? "--"}</p>
    </div>
  );
}

function Section({ title, icon: Icon, children, className = "" }) {
  return (
    <section className={`rounded-lg border border-border bg-card p-4 sm:p-5 ${className}`}>
      <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-primary">
        {Icon && <Icon className="h-4 w-4" />} {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function HeartRateChart({ rows, events }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">No heart-rate trend was included in this transfer.</p>;
  const data = rows.map((row) => ({
    ...row,
    elapsed: number(row.elapsedSeconds) || 0,
    label: fmtElapsed(row.elapsedSeconds),
    hr: number(row.heartRateBpm),
    smooth: number(row.smoothedBpm),
  }));
  const markerLabels = events.map((event) => {
    const elapsed = number(event.elapsedSeconds);
    if (elapsed == null) return null;
    return data.reduce((closest, row) => (
      Math.abs(row.elapsed - elapsed) < Math.abs(closest.elapsed - elapsed) ? row : closest
    ), data[0])?.label;
  }).filter(Boolean);
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 10, bottom: 6, left: -12 }}>
          <CartesianGrid strokeDasharray="3 4" stroke="hsl(var(--border))" opacity={0.45} />
          <XAxis dataKey="label" minTickGap={42} tick={{ fontSize: 10 }} />
          <YAxis domain={["dataMin - 8", "dataMax + 8"]} tick={{ fontSize: 10 }} width={42} />
          <Tooltip
            labelFormatter={(_label, entries = []) => entries?.[0]?.payload?.timestampUtc ? fmtDateTime(entries[0].payload.timestampUtc) : ""}
            formatter={(value, name) => [`${Math.round(Number(value))} bpm`, name === "hr" ? "Heart rate" : "Smoothed"]}
          />
          <Legend formatter={(value) => value === "hr" ? "Heart rate" : "Smoothed"} />
          {markerLabels.map((label, index) => (
            <ReferenceLine
              key={`${label}-${index}`}
              x={label}
              stroke="hsl(var(--chart-4))"
              strokeDasharray="3 3"
              ifOverflow="extendDomain"
            />
          ))}
          <Line type="linear" dataKey="hr" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="smooth" stroke="hsl(var(--chart-2))" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function BloodPressureChart({ readings }) {
  if (readings.length < 2) return null;
  const data = readings.map((reading) => ({
    ...reading,
    label: fmtDateTime(reading.timestampUtc),
    systolic: number(reading.systolic),
    diastolic: number(reading.diastolic),
    map: number(reading.meanArterialPressure),
    pulse: number(reading.pulse),
  }));
  return (
    <div className="mt-4 h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 10, bottom: 6, left: -12 }}>
          <CartesianGrid strokeDasharray="3 4" stroke="hsl(var(--border))" opacity={0.45} />
          <XAxis dataKey="label" minTickGap={60} tick={{ fontSize: 10 }} />
          <YAxis domain={["dataMin - 8", "dataMax + 8"]} tick={{ fontSize: 10 }} width={42} />
          <Tooltip formatter={(value, name) => [`${Math.round(Number(value))}${name === "pulse" ? " bpm" : " mmHg"}`, name.toUpperCase()]} />
          <Line type="monotone" dataKey="systolic" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={{ r: 3 }} />
          <Line type="monotone" dataKey="diastolic" stroke="hsl(var(--chart-2))" strokeWidth={2.5} dot={{ r: 3 }} />
          <Line type="monotone" dataKey="map" stroke="hsl(var(--chart-4))" strokeWidth={2} dot={{ r: 3 }} />
          <Line type="monotone" dataKey="pulse" stroke="hsl(var(--chart-3))" strokeDasharray="4 3" strokeWidth={2} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function AnalysisPanel({ analysis, loading, error, onRetry }) {
  if (loading) {
    return (
      <Section title="Sarah’s read" icon={Brain} className="border-primary/25 bg-primary/[0.04]">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 h-5 w-5 animate-pulse text-primary" />
          <div>
            <p className="font-semibold text-foreground">Sarah is reading the session once.</p>
            <p className="mt-1 text-sm text-muted-foreground">She’s correlating the trend, HRV quality, events, blood pressure, recovery, and capture quality. The finished read will be saved and reused.</p>
          </div>
        </div>
      </Section>
    );
  }
  if (error) {
    return (
      <Section title="Sarah’s read" icon={TriangleAlert}>
        <p className="text-sm text-destructive">{error}</p>
        <button type="button" onClick={onRetry} className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
          <RefreshCw className="h-4 w-4" /> Try again
        </button>
      </Section>
    );
  }
  if (!analysis) return null;
  return (
    <Section title="Sarah’s read" icon={Brain} className="border-primary/25 bg-primary/[0.04]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-foreground">{analysis.headline}</h2>
          <p className="mt-3 max-w-4xl text-base leading-relaxed text-foreground/90">{analysis.personal_read}</p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-md border border-primary/25 bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
          <ShieldCheck className="h-3.5 w-3.5" /> Saved analysis
        </span>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        {[
          ["Clinical summary", analysis.clinical_summary],
          ["Cardiovascular arc", analysis.cardiovascular_arc],
          ["HRV read", analysis.hrv_read],
          ["Blood pressure", analysis.blood_pressure_read],
          ["Recovery", analysis.recovery_read],
          ["Data quality", analysis.data_quality],
        ].filter(([, text]) => text).map(([title, text]) => (
          <div key={title} className="rounded-lg border border-border bg-background/35 p-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-primary">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{text}</p>
          </div>
        ))}
      </div>

      {!!analysis.notable_findings?.length && (
        <div className="mt-5">
          <h3 className="text-sm font-bold uppercase tracking-wider text-foreground">What stood out</h3>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            {analysis.notable_findings.map((finding, index) => (
              <div key={`${finding.title}-${index}`} className="rounded-lg border-l-2 border-primary bg-muted/15 p-3">
                <p className="font-semibold text-foreground">{finding.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{finding.detail}</p>
                <p className="mt-2 text-xs text-primary/85">{finding.evidence}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {!!analysis.takeaways?.length && (
        <div className="mt-5 rounded-lg border border-border bg-muted/15 p-3">
          <h3 className="text-sm font-bold uppercase tracking-wider text-foreground">Bottom line</h3>
          <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
            {analysis.takeaways.map((takeaway, index) => <li key={index}>• {takeaway}</li>)}
          </ul>
        </div>
      )}

      <p className="mt-4 text-xs text-muted-foreground">Generated {fmtDateTime(analysis.generated_at)} · cached with this transfer</p>
    </Section>
  );
}

function buildAnalysisNarration(analysis) {
  if (!analysis) return "";
  return [
    analysis.headline,
    analysis.personal_read,
    analysis.clinical_summary,
    analysis.cardiovascular_arc,
    analysis.hrv_read,
    analysis.blood_pressure_read,
    analysis.recovery_read,
    analysis.data_quality,
    ...(analysis.notable_findings || []).flatMap((finding) => [finding.title, finding.detail, finding.evidence]),
    ...(analysis.takeaways || []),
  ].filter(Boolean).join(". ");
}

export default function VitalSignsDetail() {
  const { id } = useParams();
  const [transfer, setTransfer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [error, setError] = useState("");
  const [analysisError, setAnalysisError] = useState("");

  const loadTransfer = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(apiUrl(`/sarahvs/vitals/${encodeURIComponent(id)}`), { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Could not load vital signs: ${response.status}`);
      setTransfer(data.transfer || null);
    } catch (loadError) {
      setError(loadError?.message || "Could not load this vital-sign transfer.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  const analyze = useCallback(async () => {
    setAnalysisLoading(true);
    setAnalysisError("");
    try {
      const response = await fetch(apiUrl(`/sarahvs/vitals/${encodeURIComponent(id)}/analyze`), { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Sarah’s analysis failed: ${response.status}`);
      setTransfer((current) => current ? { ...current, analysis: data.analysis } : current);
    } catch (analysisFailure) {
      setAnalysisError(analysisFailure?.message || "Sarah could not analyze this session.");
    } finally {
      setAnalysisLoading(false);
    }
  }, [id]);

  useEffect(() => { loadTransfer(); }, [loadTransfer]);
  useEffect(() => {
    if (transfer && !transfer.analysis && !analysisLoading && !analysisError) analyze();
  }, [analysisError, analysisLoading, analyze, transfer]);

  const payload = transfer?.payload || {};
  const session = payload.session || payload.latestWindow || {};
  const hr = session.heartRate || {};
  const hrv = session.hrv || {};
  const rawStreams = session.rawStreams || {};
  const events = useMemo(() => Array.isArray(payload.events) ? payload.events : Array.isArray(session.events) ? session.events : [], [payload.events, session.events]);
  const bloodPressure = useMemo(() => Array.isArray(payload.bloodPressureReadings) ? payload.bloodPressureReadings : Array.isArray(session.bloodPressureReadings) ? session.bloodPressureReadings : [], [payload.bloodPressureReadings, session.bloodPressureReadings]);
  const trend = useMemo(() => Array.isArray(payload.heartRateTrend) ? payload.heartRateTrend : [], [payload.heartRateTrend]);
  const narrationItems = useMemo(() => {
    const overview = [
      `${session.title || transfer?.latest_session_title || "Vital-sign details"}.`,
      `Session duration ${fmtDuration(session.durationSeconds)}.`,
      hr.baselineBpm != null ? `Baseline heart rate ${hr.baselineBpm} beats per minute.` : "",
      hr.averageBpm != null ? `Average heart rate ${Math.round(number(hr.averageBpm))} beats per minute.` : "",
      hr.maxBpm != null ? `Maximum heart rate ${hr.maxBpm} beats per minute.` : "",
      hr.finalBpm != null ? `Final heart rate ${hr.finalBpm} beats per minute.` : "",
      number(hrv.rmssdMs) != null ? `R M S S D ${number(hrv.rmssdMs).toFixed(1)} milliseconds.` : "",
      hrv.acceptedRrIntervals != null ? `${Number(hrv.acceptedRrIntervals).toLocaleString()} R R intervals accepted.` : "",
    ].filter(Boolean).join(" ");
    const eventNarration = events.length
      ? events.map((event) => {
        const eventHr = event.heartRateAtEvent || {};
        return [
          `At ${fmtElapsed(event.elapsedSeconds)}, ${event.label || event.type || "event"}.`,
          event.note || "",
          eventHr.currentBpm != null ? `Heart rate ${eventHr.currentBpm} beats per minute.` : "",
        ].filter(Boolean).join(" ");
      }).join(" ")
      : "No event notes were included.";
    const pressureNarration = bloodPressure.length
      ? bloodPressure.map((reading) => [
        `Blood pressure ${reading.systolic} over ${reading.diastolic}.`,
        reading.meanArterialPressure != null ? `Mean arterial pressure ${reading.meanArterialPressure}.` : "",
        reading.pulse != null ? `Pulse ${reading.pulse} beats per minute.` : "",
        reading.bodyPosition ? `Position ${reading.bodyPosition}.` : "",
        reading.notes || "",
      ].filter(Boolean).join(" ")).join(" ")
      : "No blood-pressure readings were linked.";
    return [
      { kind: "overview", text: overview },
      ...(transfer?.analysis ? [{ kind: "analysis", text: buildAnalysisNarration(transfer.analysis) }] : []),
      {
        kind: "heart",
        text: `Heart-rate timeline. ${trend.length} trend points span this session. Baseline ${hr.baselineBpm ?? "unavailable"}, average ${hr.averageBpm != null ? Math.round(number(hr.averageBpm)) : "unavailable"}, maximum ${hr.maxBpm ?? "unavailable"}, and final ${hr.finalBpm ?? "unavailable"} beats per minute.`,
      },
      { kind: "events", text: `Event timeline. ${eventNarration}` },
      { kind: "pressure", text: `Blood pressure. ${pressureNarration}` },
      {
        kind: "quality",
        text: `Capture quality. ${Number(hr.sampleCount || 0).toLocaleString()} heart-rate samples. ${rawStreams.ecg?.samplesCaptured != null ? `${Number(rawStreams.ecg.samplesCaptured).toLocaleString()} E C G samples.` : "E C G sample count unavailable."} ${hrv.contextualArtifacts ?? "Unknown number of"} contextual artifacts. ${Array.isArray(payload.connectionGaps) ? payload.connectionGaps.length : "Unknown number of"} connection gaps.`,
      },
    ];
  }, [bloodPressure, events, hr, hrv, payload.connectionGaps, rawStreams.ecg?.samplesCaptured, session.durationSeconds, session.title, transfer, trend.length]);

  if (loading) return <div className="mx-auto max-w-7xl px-4 py-8 text-sm text-muted-foreground">Loading vital-sign details…</div>;
  if (error || !transfer) return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link to="/vitals" className="inline-flex items-center gap-2 text-sm font-semibold text-primary"><ArrowLeft className="h-4 w-4" /> Vital Signs</Link>
      <p className="mt-6 text-destructive">{error || "Transfer not found."}</p>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-7xl overflow-x-hidden px-3 py-4 sm:px-6 sm:py-6">
      <header>
        <Link to="/vitals" className="inline-flex items-center gap-2 text-sm font-semibold text-primary"><ArrowLeft className="h-4 w-4" /> All vital signs</Link>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-primary"><HeartPulse className="h-5 w-5" /> SarahVS session</p>
            <h1 className="mt-2 text-3xl font-bold text-foreground">{session.title || transfer.latest_session_title || "Vital-sign details"}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {fmtDateTime(session.startedAtUtc || transfer.latest_session_started_at_utc)} · {fmtDuration(session.durationSeconds)}
              {session.status === "recording" ? " · snapshot captured while recording" : ""}
            </p>
          </div>
          <span className="rounded-md border border-primary/25 bg-primary/10 px-3 py-2 text-xs font-semibold uppercase text-primary">
            {payload.scope === "full_session_vitals_context" ? "Full session" : "Summary window"}
          </span>
        </div>
      </header>

      {(!transfer.analysis || analysisLoading || analysisError) && (
        <div className="mt-5">
          <AnalysisPanel analysis={transfer.analysis} loading={analysisLoading} error={analysisError} onRetry={analyze} />
        </div>
      )}

      <div className="mt-5">
        <TTSReader
          sessionId={`sarahvs-vitals-${transfer.id}`}
          title={`${session.title || transfer.latest_session_title || "SarahVS session"} Vital Signs`}
          sourceGeneratedAt={transfer.analysis?.generated_at || transfer.imported_at || null}
          paragraphs={narrationItems.map((item) => item.text)}
          renderParagraph={(_text, index, isActive, isBuffering) => {
            const item = narrationItems[index];
            const stateClass = isActive
              ? "rounded-lg ring-2 ring-primary/45 ring-offset-2 ring-offset-background"
              : isBuffering
                ? "rounded-lg ring-1 ring-primary/30"
                : "";
            if (item.kind === "overview") return (
              <section className={stateClass}>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  <Metric label="Baseline" value={hr.baselineBpm != null ? `${hr.baselineBpm} bpm` : "--"} />
                  <Metric label="Average" value={hr.averageBpm != null ? `${Math.round(number(hr.averageBpm))} bpm` : "--"} accent />
                  <Metric label="Maximum" value={hr.maxBpm != null ? `${hr.maxBpm} bpm` : "--"} />
                  <Metric label="Final" value={hr.finalBpm != null ? `${hr.finalBpm} bpm` : "--"} />
                  <Metric label="RMSSD" value={number(hrv.rmssdMs) != null ? `${number(hrv.rmssdMs).toFixed(1)} ms` : "--"} />
                  <Metric label="RR accepted" value={hrv.acceptedRrIntervals != null ? Number(hrv.acceptedRrIntervals).toLocaleString() : "--"} />
                </div>
              </section>
            );
            if (item.kind === "analysis") return (
              <div className={stateClass}>
                <AnalysisPanel analysis={transfer.analysis} loading={false} error="" onRetry={analyze} />
              </div>
            );
            if (item.kind === "heart") return (
              <div className={stateClass}>
                <Section title="Heart-rate timeline" icon={Activity}>
                  <p className="mb-3 text-sm text-muted-foreground">Pink is measured HR, blue is the smoothed trend, and gold markers identify documented events.</p>
                  <HeartRateChart rows={trend} events={events} />
                </Section>
              </div>
            );
            if (item.kind === "events") return (
              <div className={stateClass}>
                <Section title="Event timeline" icon={Clock3}>
                  {events.length ? (
                    <div className="max-h-[34rem] space-y-3 overflow-y-auto pr-1">
                      {events.map((event, eventIndex) => {
                        const eventHr = event.heartRateAtEvent || {};
                        return (
                          <article key={event.markerId || `${event.timestampUtc}-${eventIndex}`} className="rounded-lg border border-border bg-muted/15 p-3">
                            <div className="flex items-start justify-between gap-3">
                              <p className="font-semibold text-foreground">{event.label || event.type || "Event"}</p>
                              <span className="shrink-0 font-mono text-xs text-primary">{fmtElapsed(event.elapsedSeconds)}</span>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">{fmtDateTime(event.timestampUtc)}</p>
                            {event.note && <p className="mt-2 text-sm leading-relaxed text-foreground/90">{event.note}</p>}
                            <p className="mt-2 text-xs text-muted-foreground">HR {eventHr.currentBpm ?? "--"} · average {eventHr.averageBpmSoFar != null ? Math.round(number(eventHr.averageBpmSoFar)) : "--"} · max {eventHr.maxBpmSoFar ?? "--"}</p>
                          </article>
                        );
                      })}
                    </div>
                  ) : <p className="text-sm text-muted-foreground">No event notes were included.</p>}
                </Section>
              </div>
            );
            if (item.kind === "pressure") return (
              <div className={stateClass}>
                <Section title="Blood pressure" icon={HeartPulse}>
                  {bloodPressure.length ? (
                    <>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {bloodPressure.map((reading, readingIndex) => {
                          const sys = number(reading.systolic);
                          const dia = number(reading.diastolic);
                          const pulsePressure = sys != null && dia != null ? sys - dia : null;
                          return (
                            <article key={reading.id || readingIndex} className="rounded-lg border border-border bg-muted/15 p-3">
                              <p className="font-mono text-xl font-bold text-foreground">{sys ?? "--"}/{dia ?? "--"}</p>
                              <p className="mt-1 text-xs text-muted-foreground">MAP {reading.meanArterialPressure ?? "--"} · PP {pulsePressure ?? "--"}{reading.pulse != null ? ` · pulse ${reading.pulse}` : ""}</p>
                              <p className="mt-2 text-xs text-muted-foreground">{fmtDateTime(reading.timestampUtc)}{reading.bodyPosition ? ` · ${reading.bodyPosition}` : ""}</p>
                              {reading.notes && <p className="mt-2 text-sm text-foreground/85">{reading.notes}</p>}
                            </article>
                          );
                        })}
                      </div>
                      <BloodPressureChart readings={bloodPressure} />
                    </>
                  ) : <p className="text-sm text-muted-foreground">No blood-pressure readings were linked.</p>}
                </Section>
              </div>
            );
            return (
              <div className={stateClass}>
                <Section title="Capture quality" icon={ShieldCheck}>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Metric label="HR samples" value={hr.sampleCount != null ? Number(hr.sampleCount).toLocaleString() : "--"} />
                    <Metric label="ECG samples" value={rawStreams.ecg?.samplesCaptured != null ? Number(rawStreams.ecg.samplesCaptured).toLocaleString() : "--"} />
                    <Metric label="Artifacts" value={hrv.contextualArtifacts ?? "--"} />
                    <Metric label="Connection gaps" value={Array.isArray(payload.connectionGaps) ? payload.connectionGaps.length : "--"} />
                  </div>
                </Section>
              </div>
            );
          }}
        />
      </div>
    </div>
  );
}
