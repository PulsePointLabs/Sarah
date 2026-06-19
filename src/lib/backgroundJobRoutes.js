const PROFILER_SESSION_TARGETS = new Set([
  "profiler_ai_profile",
  "profiler_anatomical_physiological_profile",
  "profiler_near_climax",
  "profiler_stim_methods",
]);

function normalizeRoute(route) {
  if (!route || typeof route !== "string") return "";
  const normalized = route.startsWith("/") ? route : `/${route}`;
  if (normalized === "/ai-profiler") return "/profiler";
  return normalized;
}

export function backgroundJobRoute(job) {
  const explicitRoute = normalizeRoute(job?.meta?.route);
  if (explicitRoute) return explicitRoute;

  const sessionId = job?.meta?.sessionId;
  if (PROFILER_SESSION_TARGETS.has(sessionId) || job?.meta?.source === "Profiler") {
    return "/profiler";
  }

  if (sessionId) return `/sessions/${encodeURIComponent(sessionId)}`;
  if (job?.type === "profile_anatomy_video") return "/profiler";
  if (job?.type === "session_review_video") return "/library";
  if (job?.type === "tts_export") return "/library";
  if (job?.type === "ai_invoke") return "/sessions";
  return "";
}
