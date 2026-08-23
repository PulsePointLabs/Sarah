import { base44 } from "@/api/base44Client";

const PROFILER_RESULT_KEYS = [
  "anatomical_physiological_profile_result",
];

export const PROFILER_CORE_USER_FIELDS = [
  "age", "anatomical_mechanical_profile", "arousal_notes", "arousal_response_style",
  "biological_sex", "climax_sensitivity", "email", "first_name", "fitness_level",
  "full_name", "height_cm", "latest_body_composition", "max_hr", "medications",
  "preferred_stimulation", "recovery_hr_60s", "refractory_pattern", "resting_hr",
  "typical_build_duration", "weight_kg",
];

const PROFILER_RICH_USER_FIELDS = ["profile_chat_messages", "profile_qa_findings"];

const PROFILE_CONTEXT_TIMEOUT_MS = 6000;

function timeoutToNull(promise, timeoutMs = PROFILE_CONTEXT_TIMEOUT_MS) {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export function mergeProfilerResultsIntoProfile(profile, latestProfilerAnalysis) {
  if (!profile || !latestProfilerAnalysis) return profile;
  const mergedProfilerFields = {};
  for (const key of PROFILER_RESULT_KEYS) {
    if (latestProfilerAnalysis[key] !== undefined && latestProfilerAnalysis[key] !== null) {
      mergedProfilerFields[key] = latestProfilerAnalysis[key];
    }
  }
  if (!Object.keys(mergedProfilerFields).length) return profile;
  return { ...profile, ...mergedProfilerFields };
}

export async function loadLatestProfilerAnalysis() {
  try {
    const rows = await timeoutToNull(base44.entities.SessionClusterAnalysis.listFields(PROFILER_RESULT_KEYS, "-updated_date", 5));
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows.find((row) => PROFILER_RESULT_KEYS.some((key) => {
      const value = row?.[key];
      if (Array.isArray(value)) return value.length > 0;
      return value !== undefined && value !== null;
    })) || rows[0] || null;
  } catch {
    return null;
  }
}

export async function loadProfilerCoreUserProfile() {
  return timeoutToNull(base44.auth.meFields(PROFILER_CORE_USER_FIELDS));
}

export async function loadUserProfileWithProfilerResults() {
  const [profile, richProfile, latestProfilerAnalysis] = await Promise.all([
    loadProfilerCoreUserProfile(),
    timeoutToNull(base44.auth.meFields(PROFILER_RICH_USER_FIELDS)),
    loadLatestProfilerAnalysis(),
  ]);
  const mergedProfile = profile || richProfile
    ? { ...(profile || { id: "local-user" }), ...(richProfile || {}) }
    : null;
  if (!mergedProfile && latestProfilerAnalysis) return { id: "local-user", ...latestProfilerAnalysis };
  return mergeProfilerResultsIntoProfile(mergedProfile, latestProfilerAnalysis);
}
