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
    const latest = transfer.payload?.latestWindow || {};
    const hr = latest.heartRate || {};
    const hrv = latest.hrv || {};
    const bp = Array.isArray(transfer.payload?.recentBloodPressure) ? transfer.payload.recentBloodPressure[0] : null;
    const parts = [
      `#${index + 1} ${latest.title || transfer.latest_session_title || "vitals window"}`,
      latest.startedAtUtc ? `started ${fmtDate(latest.startedAtUtc)}` : "",
      hr.baselineBpm != null ? `baseline HR ${hr.baselineBpm}` : "",
      hr.finalBpm != null ? `final HR ${hr.finalBpm}` : "",
      hr.averageBpm != null ? `avg HR ${compactNumber(hr.averageBpm)}` : "",
      hr.maxBpm != null ? `max HR ${hr.maxBpm}` : "",
      hrv.rmssdMs != null ? `RMSSD ${compactNumber(hrv.rmssdMs, 1)} ms` : "",
      bp ? `latest BP ${bp.systolic}/${bp.diastolic}${bp.meanArterialPressure ? ` MAP ${bp.meanArterialPressure}` : ""}` : "",
    ].filter(Boolean);
    return `- ${parts.join("; ")}.`;
  });
  return `RECENT SARAHVS LONGITUDINAL VITAL-SIGN CONTEXT:
These are compact SarahVS transfers for baseline, final-state, HRV, BP, symptom/exercise/substance/recovery trend context across time. Use them as background physiology when relevant. Do not treat them as raw session evidence or invent exact second-by-second telemetry.
${lines.join("\n")}`;
}

export async function buildSarahVsVitalsPromptContext(limit = 6) {
  return formatSarahVsTransfersForPrompt(await loadRecentSarahVsTransfers(limit));
}
