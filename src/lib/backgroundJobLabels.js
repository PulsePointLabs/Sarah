function formatJobSourceDate(value) {
  if (!value) return "";
  const exactDate = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = exactDate
    ? new Date(Number(exactDate[1]), Number(exactDate[2]) - 1, Number(exactDate[3]))
    : new Date(value);
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function appendJobSourceDate(label, job) {
  if (job?.type !== "session_review_video") return label;
  const date = formatJobSourceDate(job?.meta?.sessionDate || job?.payload?.sessionDate || job?.result?.record?.session_date || job?.meta?.sourceGeneratedAt);
  if (!date || String(label || "").includes(date)) return label;
  return `${label} · ${date}`;
}

function isGenericAiLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === "ai analysis" || normalized === "analysis" || normalized === "ai invoke";
}

function jobReviewType(job) {
  return (
    job?.meta?.reviewType ||
    job?.meta?.review_type ||
    job?.payload?.reviewType ||
    job?.payload?.review_type ||
    job?.progress?.reviewType ||
    job?.progress?.review_type ||
    job?.result_summary?.reviewType ||
    job?.result_summary?.review_type ||
    job?.result?.reviewType ||
    job?.result?.review_type ||
    ""
  );
}

function labelFromReviewType(reviewType, { video = false } = {}) {
  const value = String(reviewType || "").toLowerCase();
  if (!value) return "";
  if (value.includes("head_to_toe") || value.includes("head-to-toe")) {
    return video ? "Head-to-Toe Anatomy Video" : "Head-to-Toe Image Review";
  }
  if (value.includes("pelvic") || value.includes("genital")) {
    return video ? "Pelvic/Genital Anatomy Video" : "Pelvic/Genital Image Review";
  }
  if (value.includes("anatomical") || value.includes("physiological")) {
    return "Anatomical & Physiological Profile";
  }
  if (value.includes("comprehensive")) {
    return "Comprehensive Physiological Profile";
  }
  return "";
}

function labelFromSource(job) {
  const source = String(job?.meta?.source || job?.payload?.source || job?.progress?.source || "").toLowerCase();
  if (!source) return "";
  if (source === "ai_video_pass") return "Cloud Sarah annotation";
  if (source === "ai_chat_findings_summary") return "Profile Q&A findings summary";
  if (source === "ai_chat_session_moment_review") return "Ask Sarah moment review";
  if (source.includes("technical") && source.includes("deep")) return "Technical Session Deep Dive";
  if (source.includes("arousal") && source.includes("timeline")) return "Arousal Timeline Analysis";
  if (source.includes("session") && source.includes("analysis")) return "AI Session Analysis";
  if (source.includes("chat") || source.includes("qa") || source.includes("q&a")) return "AI chat summary";
  return "";
}

function labelFromTextHints(job, { video = false } = {}) {
  const haystack = [
    job?.meta?.title,
    job?.meta?.label,
    job?.meta?.source,
    job?.payload?.title,
    job?.payload?.label,
    job?.payload?.source,
    job?.progress?.message,
    job?.progress?.phase,
  ].filter(Boolean).join(" ").toLowerCase();
  if (!haystack) return "";
  if (haystack.includes("head-to-toe") || haystack.includes("head to toe") || haystack.includes("head_to_toe")) {
    return video ? "Head-to-Toe Anatomy Video" : "Head-to-Toe Image Review";
  }
  if (haystack.includes("pelvic") || haystack.includes("genital")) {
    return video ? "Pelvic/Genital Anatomy Video" : "Pelvic/Genital Image Review";
  }
  return "";
}

export function backgroundJobLabel(job) {
  const reviewType = jobReviewType(job);
  const reviewLabel = labelFromReviewType(reviewType, { video: job?.type === "profile_anatomy_video" });
  if (reviewLabel) return reviewLabel;

  const hintedLabel = labelFromTextHints(job, { video: job?.type === "profile_anatomy_video" });
  if (hintedLabel) return hintedLabel;

  if (job?.type === "ai_invoke") {
    const sourceLabel = labelFromSource(job);
    if (sourceLabel) return sourceLabel;
    if (job?.meta?.title && !isGenericAiLabel(job.meta.title)) return job.meta.title;
    if (job?.meta?.label && !isGenericAiLabel(job.meta.label)) return job.meta.label;
    return "AI analysis";
  }

  if (job?.meta?.title) return appendJobSourceDate(job.meta.title, job);
  if (job?.meta?.label) return appendJobSourceDate(job.meta.label, job);
  if (job?.type === "local_vision_analyze_continuous") return "Local vision annotation";
  if (job?.type === "local_vision_analyze_window") return "Diagnostic local vision";
  if (job?.type === "local_vision_ask_video") return "Local video question";
  if (job?.type === "session_review_video") return appendJobSourceDate("Review video render", job);
  if (job?.type === "profile_anatomy_video") return "Anatomy video render";
  if (job?.type === "tts_export") return "Audio render";
  return job?.type || "Background task";
}
