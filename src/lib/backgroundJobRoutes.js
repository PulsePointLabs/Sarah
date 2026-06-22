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

function sessionAnalysisHash(job) {
  const analysisField = String(job?.meta?.analysisField || job?.payload?.analysisField || "");
  const label = String(job?.meta?.label || job?.payload?.label || "").toLowerCase();
  if (analysisField === "ai_session_deep_dive" || label.includes("technical")) return "session-ai-technical";
  if (analysisField === "ai_analysis" || label.includes("session analysis")) return "session-ai-companion";
  return "";
}

function profilerHash(job) {
  const reviewType = String(job?.meta?.reviewType || job?.payload?.reviewType || "");
  const sessionId = String(job?.meta?.sessionId || job?.payload?.sessionId || "");
  const label = String(job?.meta?.label || job?.meta?.title || job?.payload?.label || job?.payload?.title || "").toLowerCase();
  if (reviewType === "profile_head_to_toe_image_review" || label.includes("head-to-toe") || label.includes("head to toe")) {
    return "profiler-head-to-toe";
  }
  if (reviewType === "profile_pelvic_genital_image_review" || label.includes("pelvic") || label.includes("genital")) {
    return "profiler-pelvic-genital";
  }
  if (sessionId === "profiler_ai_profile") return "profiler-ai-profile";
  if (sessionId === "profiler_anatomical_physiological_profile") return "profiler-anatomical-profile";
  if (sessionId === "profiler_stim_methods") return "profiler-stimulation-methods";
  if (sessionId === "profiler_near_climax") return "profiler-near-climax";
  if (job?.type === "profile_anatomy_video") return reviewType === "profile_pelvic_genital_image_review" ? "profiler-pelvic-genital-video" : "profiler-head-to-toe-video";
  return "";
}

export function backgroundJobRoute(job) {
  const explicitRoute = normalizeRoute(job?.meta?.route);
  if (explicitRoute) return explicitRoute;

  const sessionId = job?.meta?.sessionId;
  if (PROFILER_SESSION_TARGETS.has(sessionId) || job?.meta?.source === "Profiler") {
    const hash = profilerHash(job);
    return hash ? `/profiler#${hash}` : "/profiler";
  }

  if (sessionId) {
    const hash = sessionAnalysisHash(job);
    return `/sessions/${encodeURIComponent(sessionId)}${hash ? `#${hash}` : ""}`;
  }
  if (job?.type === "profile_anatomy_video") {
    const hash = profilerHash(job);
    return hash ? `/profiler#${hash}` : "/profiler";
  }
  if (job?.type === "session_review_video") {
    const recordType = String(job?.meta?.recordType || job?.payload?.recordType || "");
    const reviewType = String(job?.meta?.reviewType || job?.payload?.reviewType || "");
    const label = String(job?.meta?.analysisTitle || job?.meta?.title || job?.payload?.title || "").toLowerCase();
    const id = job?.meta?.sessionId || job?.payload?.sessionId;
    if (id && recordType === "body_exploration") return `/exploration/${encodeURIComponent(id)}#exploration-ai-video`;
    if (id) {
      const hash = reviewType === "session_technical_deep_dive" || label.includes("technical")
        ? "session-ai-video-technical"
        : "session-ai-video-companion";
      return `/sessions/${encodeURIComponent(id)}#${hash}`;
    }
    return "/library";
  }
  if (job?.type === "tts_export") return "/library";
  if (job?.type === "ai_invoke") return "/sessions";
  return "";
}
