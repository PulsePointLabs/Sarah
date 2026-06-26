import { useCallback, useEffect, useState } from "react";
import { Activity, HeartPulse, RefreshCw, TriangleAlert } from "lucide-react";
import AppVersionBadge from "@/components/AppVersionBadge";
import { apiUrl } from "@/lib/mobileApiBase";

function fmtDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function fmtElapsed(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function fmtPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number)}%` : "--";
}

function Metric({ label, value }) {
  return (
    <div className="min-w-0 border-l-2 border-primary/25 pl-3">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-base font-bold text-foreground">{value ?? "--"}</p>
    </div>
  );
}

function TransferDetails({ transfer }) {
  const payload = transfer.payload || {};
  const session = payload.session || payload.latestWindow || {};
  const hr = session.heartRate || {};
  const hrv = session.hrv || {};
  const events = Array.isArray(payload.events) ? payload.events : Array.isArray(session.events) ? session.events : [];
  const bloodPressure = Array.isArray(payload.bloodPressureReadings)
    ? payload.bloodPressureReadings
    : Array.isArray(session.bloodPressureReadings)
      ? session.bloodPressureReadings
      : [];
  const trend = Array.isArray(payload.heartRateTrend) ? payload.heartRateTrend : [];
  const gaps = Array.isArray(payload.connectionGaps) ? payload.connectionGaps : [];
  const rawStreams = session.rawStreams || {};
  const isFullSession = payload.scope === "full_session_vitals_context";

  return (
    <article className="border-t border-border py-5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-foreground">
            {transfer.latest_session_title || session.title || "SarahVS vital-sign window"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {session.startedAtUtc ? `Started ${fmtDateTime(session.startedAtUtc)}` : `Imported ${fmtDateTime(transfer.imported_at)}`}
            {session.durationSeconds != null ? ` · ${fmtDuration(session.durationSeconds)}` : ""}
          </p>
        </div>
        <span className="border border-primary/25 bg-primary/10 px-2 py-1 text-xs font-semibold uppercase text-primary">
          {isFullSession ? "Full session" : "Summary"}
        </span>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{transfer.summary}</p>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Baseline HR" value={hr.baselineBpm != null ? `${hr.baselineBpm} bpm` : "--"} />
        <Metric label="Average HR" value={hr.averageBpm != null ? `${Math.round(Number(hr.averageBpm))} bpm` : "--"} />
        <Metric label="Maximum HR" value={hr.maxBpm != null ? `${hr.maxBpm} bpm` : "--"} />
        <Metric label="Final HR" value={hr.finalBpm != null ? `${hr.finalBpm} bpm` : "--"} />
        <Metric label="RMSSD" value={hrv.rmssdMs != null ? `${Number(hrv.rmssdMs).toFixed(1)} ms` : "--"} />
        <Metric label="RR coverage" value={fmtPercent(hrv.rrCoveragePercent)} />
      </div>

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
        <span>{Number(hr.sampleCount || 0).toLocaleString()} HR samples summarized</span>
        <span>{trend.length} HR trend points transferred</span>
        <span>{events.length} events</span>
        <span>{bloodPressure.length} BP readings</span>
        <span>{gaps.length} connection gaps</span>
      </div>

      {isFullSession && (
        <details className="mt-4 border-t border-border pt-4">
          <summary className="cursor-pointer text-sm font-bold text-primary">Session details</summary>
          <div className="mt-4 grid gap-5 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-bold uppercase text-foreground">Event timeline</h3>
              {events.length ? (
                <div className="mt-2 space-y-3">
                  {events.map((event, index) => {
                    const eventHr = event.heartRateAtEvent || {};
                    return (
                      <div key={event.markerId || `${event.timestampUtc}-${index}`} className="border-l-2 border-primary/30 pl-3">
                        <p className="text-sm font-semibold text-foreground">
                          {event.elapsedSeconds != null ? fmtElapsed(event.elapsedSeconds) : "Unknown time"} · {event.label || event.type || "Event"}
                        </p>
                        {event.note && <p className="mt-1 text-sm text-muted-foreground">{event.note}</p>}
                        <p className="mt-1 text-xs text-muted-foreground">
                          HR {eventHr.currentBpm ?? "--"} · average to event {eventHr.averageBpmSoFar != null ? Math.round(Number(eventHr.averageBpmSoFar)) : "--"} · max to event {eventHr.maxBpmSoFar ?? "--"}
                        </p>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">No event notes were included.</p>
              )}
            </div>

            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-bold uppercase text-foreground">Blood pressure</h3>
                {bloodPressure.length ? (
                  <div className="mt-2 space-y-2">
                    {bloodPressure.map((reading, index) => (
                      <div key={reading.id || index} className="border-l-2 border-primary/30 pl-3 text-sm">
                        <p className="font-semibold text-foreground">
                          {reading.systolic}/{reading.diastolic}{reading.pulse != null ? ` · pulse ${reading.pulse}` : ""}
                        </p>
                        <p className="text-muted-foreground">
                          {fmtDateTime(reading.timestampUtc)}{reading.bodyPosition ? ` · ${reading.bodyPosition}` : ""}
                        </p>
                        {reading.notes && <p className="mt-1 text-muted-foreground">{reading.notes}</p>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">No linked BP readings.</p>
                )}
              </div>

              <div>
                <h3 className="text-sm font-bold uppercase text-foreground">Capture coverage</h3>
                <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                  <Metric label="ECG" value={fmtPercent(rawStreams.ecg?.coveragePercent)} />
                  <Metric label="Movement" value={fmtPercent(rawStreams.movement?.coveragePercent)} />
                  <Metric label="RR accepted" value={hrv.acceptedRrIntervals != null ? Number(hrv.acceptedRrIntervals).toLocaleString() : "--"} />
                  <Metric label="Trend resolution" value={trend.length ? `${trend.length} points` : "--"} />
                </div>
              </div>
            </div>
          </div>
        </details>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Imported {fmtDateTime(transfer.imported_at)}{transfer.app_version ? ` · ${transfer.app_version}` : ""}
      </p>
    </article>
  );
}

export default function VitalSigns() {
  const [transfers, setTransfers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadTransfers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(apiUrl("/sarahvs/vitals/recent?limit=30"), { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `SarahVS vital signs failed: ${response.status}`);
      setTransfers(Array.isArray(data.transfers) ? data.transfers : []);
    } catch (loadError) {
      setError(loadError?.message || "Could not load SarahVS vital signs.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTransfers();
  }, [loadTransfers]);

  const fullSessionCount = transfers.filter((transfer) => transfer.payload?.scope === "full_session_vitals_context").length;

  return (
    <div className="mx-auto w-full max-w-7xl overflow-x-hidden px-3 py-4 sm:px-6 sm:py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-primary">
            <HeartPulse className="h-5 w-5" />
            <p className="text-sm font-bold uppercase tracking-wider">Vital Signs</p>
          </div>
          <h1 className="mt-2 text-3xl font-bold text-foreground">SarahVS session physiology</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Imported heart rate, HRV, blood pressure, event notes, trend context, and capture coverage from SarahVS.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadTransfers}
            disabled={loading}
            className="inline-flex items-center gap-2 bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <AppVersionBadge />
        </div>
      </header>

      <section className="mt-5 border-y border-border py-4">
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
          <span><strong className="text-foreground">{transfers.length}</strong> transfers</span>
          <span><strong className="text-foreground">{fullSessionCount}</strong> full sessions</span>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          In SarahVS, <strong className="text-foreground">Send Latest</strong> sends a compact longitudinal summary. Open a session in History and use <strong className="text-foreground">Send to Sarah</strong> to transfer its full event timeline, BP readings, HR trend, HRV, gaps, and capture coverage.
        </p>
      </section>

      {error && (
        <div className="mt-5 flex items-start gap-2 border border-destructive/35 bg-destructive/10 p-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && !transfers.length ? (
        <div className="mt-8 flex items-center gap-3 text-sm text-muted-foreground">
          <Activity className="h-5 w-5 animate-pulse text-primary" />
          Loading transferred vital signs...
        </div>
      ) : transfers.length ? (
        <section className="mt-6">
          {transfers.map((transfer) => <TransferDetails key={transfer.id} transfer={transfer} />)}
        </section>
      ) : !error ? (
        <p className="mt-8 text-sm text-muted-foreground">No SarahVS transfers have arrived yet.</p>
      ) : null}
    </div>
  );
}
