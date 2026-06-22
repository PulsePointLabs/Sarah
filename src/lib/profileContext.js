import { base44 } from "@/api/base44Client";

const PROFILER_RESULT_KEYS = [
  "head_to_toe_image_review_result",
  "head_to_toe_image_review_archive",
  "pelvic_genital_image_review_result",
  "pelvic_genital_image_review_archive",
  "anatomical_physiological_profile_result",
  "anatomical_physiological_profile_archive",
];

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

export async function loadUserProfileWithProfilerResults() {
  const [profile, latestProfilerAnalysis] = await Promise.all([
    timeoutToNull(base44.auth.me()),
    loadLatestProfilerAnalysis(),
  ]);
  if (!profile && latestProfilerAnalysis) return { id: "local-user", ...latestProfilerAnalysis };
  return mergeProfilerResultsIntoProfile(profile, latestProfilerAnalysis);
}
