export function getSessionLatestUpdateAt(session) {
  const candidates = [session?.updated_date, session?.updated_at].filter(Boolean);
  const latest = candidates
    .map((candidate) => new Date(candidate).getTime())
    .filter(Number.isFinite)
    .reduce((max, candidate) => Math.max(max, candidate), 0);

  return latest ? new Date(latest).toISOString() : null;
}

export function getSessionLatestActivityAt(session) {
  const eventTimestamps = (Array.isArray(session?.event_timeline) ? session.event_timeline : [])
    .flatMap((event) => [event?.updated_at, event?.created_at, event?.verified_at])
    .filter(Boolean);
  const candidates = [
    session?.updated_date,
    session?.updated_at,
    session?.motion_analysis_summary?.analyzed_at,
    session?.ai_analysis?._meta?.last_generated_at,
    session?.ai_analysis?._meta?.updated_at,
    session?.ai_analysis?._meta?.generated_at,
    session?.ai_session_deep_dive?._meta?.last_generated_at,
    session?.ai_session_deep_dive?._meta?.updated_at,
    session?.ai_cascade?._meta?.last_generated_at,
    session?.ai_cascade?._meta?.updated_at,
    session?.ai_no_climax?._meta?.last_generated_at,
    session?.ai_no_climax?._meta?.updated_at,
    session?.ai_timeline_narrative?._meta?.last_generated_at,
    session?.ai_timeline_narrative?._meta?.updated_at,
    session?.ai_near_climax_overview?._meta?.last_generated_at,
    session?.ai_near_climax_overview?._meta?.updated_at,
    ...eventTimestamps,
  ].filter(Boolean);

  const latest = candidates
    .map((candidate) => new Date(candidate).getTime())
    .filter(Number.isFinite)
    .reduce((max, candidate) => Math.max(max, candidate), 0);

  return latest ? new Date(latest).toISOString() : null;
}
