import { getMotionEvidenceFreshnessKey, getMotionEvidenceSummary } from "./sessionMotionEvidence";

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

export function buildSessionAIContentMeta(session, previousMeta = null) {
  const generatedAt = new Date().toISOString();
  const motion = getMotionEvidenceSummary(session);
  return {
    created_at: previousMeta?.created_at || generatedAt,
    updated_at: generatedAt,
    last_generated_at: generatedAt,
    evidence_freshness_key: getMotionEvidenceFreshnessKey(session),
    source_session_updated_at: session?.updated_date || session?.updated_at || null,
    source_motion_analyzed_at: motion.analyzedAt,
    source_motion_event_count: motion.promotedEventCount,
    source_event_count: Array.isArray(session?.event_timeline) ? session.event_timeline.length : 0,
  };
}

export function buildProfileAIContentMeta(sessions, previousMeta = null) {
  const generatedAt = new Date().toISOString();
  const values = Array.isArray(sessions) ? sessions : [];
  const freshnessKey = values.map((session) => `${session.id || ""}:${getMotionEvidenceFreshnessKey(session)}`).join("||");
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
    evidence_freshness_key: freshnessKey,
    source_session_count: values.length,
    motion_evidence_session_count: motionSessions.length,
    latest_source_updated_at: latestSourceUpdate,
  };
}

export function isSessionAIContentStale(result, session) {
  return Boolean(result?._meta?.evidence_freshness_key)
    && result._meta.evidence_freshness_key !== getMotionEvidenceFreshnessKey(session);
}

export function isProfileAIContentStale(result, sessions) {
  if (!result?._meta?.evidence_freshness_key) return false;
  const liveKey = (Array.isArray(sessions) ? sessions : [])
    .map((session) => `${session.id || ""}:${getMotionEvidenceFreshnessKey(session)}`)
    .join("||");
  return result._meta.evidence_freshness_key !== liveKey;
}
