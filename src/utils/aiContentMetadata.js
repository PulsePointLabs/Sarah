import { getMotionEvidenceFreshnessKey, getMotionEvidenceSummary } from "./sessionMotionEvidence";

function stableEvidenceHash(value = "") {
  const text = String(value || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function formatGeneratedAt(value) {
  if (!value) return "Generated time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Generated time unavailable";
  return date.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function buildSessionPhaseMarkerFreshnessKey(session) {
  return [
    session?.pre_climax_offset_s ?? "",
    session?.climax_offset_s ?? "",
    session?.recovery_offset_s ?? "",
    session?.phase_markers_updated_at ?? "",
    Array.isArray(session?.event_timeline) ? session.event_timeline.length : 0,
  ].join(":");
}

export function buildSessionAIContentMeta(session, previousMeta = null, generatedAtOverride = null) {
  const generatedAt = generatedAtOverride || new Date().toISOString();
  const motion = getMotionEvidenceSummary(session);
  const phaseMarkerKey = buildSessionPhaseMarkerFreshnessKey(session);
  const evidenceFreshnessKey = [
    getMotionEvidenceFreshnessKey(session),
    phaseMarkerKey,
  ].join("||phase:");
  return {
    created_at: previousMeta?.created_at || generatedAt,
    updated_at: generatedAt,
    last_generated_at: generatedAt,
    evidence_freshness_key: evidenceFreshnessKey,
    phase_marker_freshness_key: phaseMarkerKey,
    source_phase_markers_updated_at: session?.phase_markers_updated_at || null,
    source_phase_markers_s: {
      pre_climax: session?.pre_climax_offset_s ?? null,
      climax: session?.climax_offset_s ?? null,
      recovery: session?.recovery_offset_s ?? null,
    },
    source_session_updated_at: session?.updated_date || session?.updated_at || null,
    source_motion_analyzed_at: motion.analyzedAt,
    source_motion_event_count: motion.promotedEventCount,
    source_event_count: Array.isArray(session?.event_timeline) ? session.event_timeline.length : 0,
  };
}

export function buildProfileAIContentMeta(sessions, previousMeta = null, generatedAtOverride = null) {
  const generatedAt = generatedAtOverride || new Date().toISOString();
  const values = Array.isArray(sessions) ? sessions : [];
  const freshnessKey = values.map((session) => `${session.id || ""}:${getMotionEvidenceFreshnessKey(session)}`).join("||");
  const freshnessHash = stableEvidenceHash(freshnessKey);
  const motionSessions = values.filter((session) => getMotionEvidenceSummary(session).hasAnyMotionEvidence);
  const latestSourceUpdate = values
    .map((session) => session.updated_date || session.updated_at || session.motion_analysis_summary?.analyzed_at)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  return {
    created_at: previousMeta?.created_at || generatedAt,
    updated_at: generatedAt,
    last_generated_at: generatedAt,
    evidence_freshness_hash: freshnessHash,
    evidence_freshness_key_length: freshnessKey.length,
    evidence_freshness_key_omitted: true,
    source_session_count: values.length,
    motion_evidence_session_count: motionSessions.length,
    latest_source_updated_at: latestSourceUpdate,
  };
}

export function buildGenericAIContentMeta(previousMeta = null, generatedAtOverride = null, extra = {}) {
  const generatedAt = generatedAtOverride || new Date().toISOString();
  return {
    ...extra,
    created_at: previousMeta?.created_at || generatedAt,
    updated_at: generatedAt,
    last_generated_at: generatedAt,
  };
}

export function getAIContentGeneratedAt(result) {
  return (
    result?._meta?.last_generated_at ||
    result?._meta?.updated_at ||
    result?._meta?.generated_at ||
    result?.generated_at ||
    null
  );
}

export function isSessionAIContentStale(result, session) {
  const phaseMarkerKey = buildSessionPhaseMarkerFreshnessKey(session);
  if (result?._meta?.phase_marker_freshness_key) {
    return result._meta.phase_marker_freshness_key !== phaseMarkerKey;
  }
  if (session?.phase_markers_updated_at) {
    const generatedAt = getAIContentGeneratedAt(result);
    const markerUpdatedAt = new Date(session.phase_markers_updated_at).getTime();
    const resultGeneratedAt = new Date(generatedAt || 0).getTime();
    if (Number.isFinite(markerUpdatedAt) && Number.isFinite(resultGeneratedAt) && markerUpdatedAt > resultGeneratedAt) {
      return true;
    }
  }
  return Boolean(result?._meta?.evidence_freshness_key)
    && result._meta.evidence_freshness_key !== getMotionEvidenceFreshnessKey(session);
}

export function isProfileAIContentStale(result, sessions) {
  const liveKey = (Array.isArray(sessions) ? sessions : [])
    .map((session) => `${session.id || ""}:${getMotionEvidenceFreshnessKey(session)}`)
    .join("||");
  if (result?._meta?.evidence_freshness_hash) {
    return result._meta.evidence_freshness_hash !== stableEvidenceHash(liveKey);
  }
  if (result?._meta?.evidence_freshness_key) {
    return result._meta.evidence_freshness_key !== liveKey;
  }
  return false;
}
