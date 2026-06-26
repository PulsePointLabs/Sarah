import { apiUrl } from "@/lib/mobileApiBase";

function fmtDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function compactNumber(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n.toFixed(digits);
}

export async function loadRecentSarahVsTransfers(limit = 6) {
  try {
    const response = await fetch(apiUrl(`/sarahvs/vitals/recent?limit=${encodeURIComponent(limit)}`), { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return [];
    return Array.isArray(data.transfers) ? data.transfers : [];
  } catch {
    return [];
  }
}

export function formatSarahVsTransfersForPrompt(transfers = []) {
  const usable = Array.isArray(transfers) ? transfers.filter(Boolean).slice(0, 6) : [];
  if (!usable.length) return "";
  const lines = usable.map((transfer, index) => {
    const latest = transfer.payload?.latestWindow || transfer.payload?.session || {};
    const hr = latest.heartRate || {};
    const hrv = latest.hrv || {};
    const bp = Array.isArray(transfer.payload?.recentBloodPressure) ? transfer.payload.recentBloodPressure[0] : null;
    const sessionBp = Array.isArray(transfer.payload?.bloodPressureReadings) ? transfer.payload.bloodPressureReadings[0] : null;
    const events = Array.isArray(transfer.payload?.events)
      ? transfer.payload.events
      : Array.isArray(latest.events)
        ? latest.events
        : [];
    const bloodPressureReadings = Array.isArray(transfer.payload?.bloodPressureReadings)
      ? transfer.payload.bloodPressureReadings
      : Array.isArray(latest.bloodPressureReadings)
        ? latest.bloodPressureReadings
        : [];
    const trend = Array.isArray(transfer.payload?.heartRateTrend) ? transfer.payload.heartRateTrend : [];
    const gaps = Array.isArray(transfer.payload?.connectionGaps) ? transfer.payload.connectionGaps : [];
    const rawStreams = latest.rawStreams || {};
    const parts = [
      `#${index + 1} ${latest.title || transfer.latest_session_title || "vitals window"}`,
      latest.startedAtUtc ? `started ${fmtDate(latest.startedAtUtc)}` : "",
      transfer.payload?.scope === "full_session_vitals_context" ? "full session transfer" : "",
      hr.baselineBpm != null ? `baseline HR ${hr.baselineBpm}` : "",
      hr.finalBpm != null ? `final HR ${hr.finalBpm}` : "",
      hr.averageBpm != null ? `avg HR ${compactNumber(hr.averageBpm)}` : "",
      hr.maxBpm != null ? `max HR ${hr.maxBpm}` : "",
      hrv.rmssdMs != null ? `RMSSD ${compactNumber(hrv.rmssdMs, 1)} ms` : "",
      events.length ? `${events.length} event notes included` : "",
      trend.length ? `${trend.length} HR trend points spanning the session` : "",
      gaps.length ? `${gaps.length} connection gaps documented` : "",
      (bp || sessionBp) ? `latest BP ${(bp || sessionBp).systolic}/${(bp || sessionBp).diastolic}${(bp || sessionBp).meanArterialPressure ? ` MAP ${(bp || sessionBp).meanArterialPressure}` : ""}` : "",
    ].filter(Boolean);
    const eventLines = events.map((event) => {
      const eventHr = event.heartRateAtEvent || {};
      const note = String(event.note || "").trim();
      const label = event.label || event.type || "Event";
      const elapsed = event.elapsedSeconds != null ? `${Math.round(Number(event.elapsedSeconds))}s` : "unknown time";
      const hrText = [
        eventHr.currentBpm != null ? `HR ${eventHr.currentBpm}` : "",
        eventHr.averageBpmSoFar != null ? `avg ${compactNumber(eventHr.averageBpmSoFar)}` : "",
        eventHr.maxBpmSoFar != null ? `max ${eventHr.maxBpmSoFar}` : "",
      ].filter(Boolean).join(", ");
      return `  - ${elapsed}: ${label}${note ? ` - ${note}` : ""}${hrText ? ` (${hrText})` : ""}`;
    });
    const bpLines = bloodPressureReadings.map((reading) => [
      `  - BP ${reading.systolic}/${reading.diastolic}`,
      reading.meanArterialPressure != null ? `MAP ${reading.meanArterialPressure}` : "",
      reading.pulse != null ? `pulse ${reading.pulse}` : "",
      reading.bodyPosition || "",
      reading.notes || "",
    ].filter(Boolean).join("; "));
    const trendLine = trend.length
      ? `  - HR trend: ${trend.map((point) => `${Math.round(Number(point.elapsedSeconds || 0))}s=${point.heartRateBpm ?? "?"}`).join(", ")}`
      : "";
    const gapLines = gaps.map((gap) => `  - Connection gap ${Math.round(Number(gap.startElapsedSeconds || 0))}s-${gap.endElapsedSeconds != null ? `${Math.round(Number(gap.endElapsedSeconds))}s` : "open"}${gap.reason ? `: ${gap.reason}` : ""}`);
    const coverageLine = transfer.payload?.scope === "full_session_vitals_context"
      ? `  - Capture coverage: ECG ${compactNumber(rawStreams.ecg?.coveragePercent, 0) || "unknown"}%; movement ${compactNumber(rawStreams.movement?.coveragePercent, 0) || "unknown"}%; RR accepted ${hrv.acceptedRrIntervals ?? "unknown"}/${hrv.totalRrIntervals ?? "unknown"}.`
      : "";
    return [
      `- ${parts.join("; ")}.`,
      ...eventLines,
      ...bpLines,
      trendLine,
      ...gapLines,
      coverageLine,
    ].filter(Boolean).join("\n");
  });
  return `RECENT SARAHVS LONGITUDINAL VITAL-SIGN CONTEXT:
These SarahVS transfers provide baseline/final-state HR, HRV, BP, event notes, and trend context across time. Full-session transfers include every event note with vital signs at that moment plus compact trend summaries. Use them as physiology context when relevant, while avoiding claims of diagnostic certainty or invented second-by-second telemetry.
${lines.join("\n")}`;
}

export async function buildSarahVsVitalsPromptContext(limit = 6) {
  return formatSarahVsTransfersForPrompt(await loadRecentSarahVsTransfers(limit));
}
