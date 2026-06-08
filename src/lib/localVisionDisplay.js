const LABELS = {
  hand_genital_motion_candidate: "Possible hand/genital motion candidate",
  anatomy_visibility_change: "Possible anatomy visibility change",
  anatomy_visibility_change_candidate: "Possible anatomy visibility change",
  possible_fluid_event: "Possible fluid/state-change candidate",
  fluid_event_candidate: "Possible fluid/state-change candidate",
  body_foot_movement_candidate: "Possible body/foot movement candidate",
  foley_tool_handling_candidate: "Possible Foley/tool handling candidate",
  tubing_routing: "Possible tubing/field handling candidate",
  manual_genital_contact_motion: "Manual genital contact/motion visible",
  manual_genital_contact_motion_visible: "Manual genital contact/motion visible",
  stroking_motion_visible: "Stroking/manual stimulation",
  ejaculation_or_fluid_release_visible: "Visible fluid release",
  erection_state_visible: "Specific erection-state change",
  catheter_advancement: "Catheter advancement",
  urine_confirmation: "Urine/fluid confirmation",
  balloon_inflation: "Balloon inflation",
  statlock_securement: "StatLock/securement",
};

const NOT_CONFIRMED_LABELS = {
  "stroking/manual stimulation not confirmed": "Stroking/manual stimulation",
  "ejaculation/fluid release not confirmed": "Ejaculation/fluid release",
  "specific erection state not confirmed": "Specific erection-state change",
  "catheter advancement not confirmed": "Catheter advancement",
  "foley securement not confirmed": "Foley securement",
};

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null) return [];
  return [value].filter(Boolean);
}

function titleCase(value = "") {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function labelKey(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[/-]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_");
}

function asNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function msRange(item = {}) {
  const start = asNumber(item.start_ms ?? item.startMs ?? item.time_ms ?? item.timeMs, 0);
  const end = asNumber(item.end_ms ?? item.endMs ?? item.start_ms ?? item.startMs ?? item.time_ms ?? item.timeMs, start);
  return { start_ms: start, end_ms: Math.max(start, end) };
}

function formatMsClock(ms) {
  const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function confidenceLabel(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "uncertain";
  if (n >= 0.8) return "high";
  if (n >= 0.6) return "moderate";
  return "low";
}

function basisText(item = {}, fallback = "") {
  const raw = String(
    item.summary ||
    item.basis ||
    item.reason ||
    item.rejection_reason ||
    (Array.isArray(item.reasons) ? item.reasons.join("; ") : "") ||
    fallback ||
    ""
  ).replace(/\s+/g, " ").trim();
  if (/CV candidate remained plausible, but Qwen did not confirm a gated event/i.test(raw)) {
    return "Local CV flagged this as a plausible motion window, but Qwen did not return enough specific visible evidence to pass the confirmation gate.";
  }
  return raw;
}

export function humanizeLocalVisionLabel(value = "") {
  const key = labelKey(value);
  return LABELS[key] || titleCase(key || "Local visual evidence");
}

export function localVisionVerdict(result = {}) {
  const confirmed = asArray(result.actionable_findings).length || asArray(result.timeline_events).length;
  const candidates = asArray(result.strong_candidates).length;
  const notConfirmed = asArray(result.not_confirmed).length || asArray(result.forbidden_or_not_visible).length;
  if (confirmed > 0) {
    return {
      key: "useful_confirmed_evidence",
      label: "Useful confirmed evidence",
      text: "Local vision promoted confirmed visual findings. These can be used as local visual facts in Session Analysis.",
    };
  }
  if (candidates > 0) {
    return {
      key: "useful_candidate_evidence",
      label: "Useful candidate evidence",
      text: "Local vision found possible activity windows, but none passed confirmation gates. Treat these as review targets and limitations, not facts.",
    };
  }
  if (notConfirmed > 0) {
    return {
      key: "insufficient_local_visual_evidence",
      label: "Insufficient local visual evidence",
      text: "Local vision checked important items but did not find enough visible evidence to promote a confirmed event.",
    };
  }
  return {
    key: "insufficient_local_visual_evidence",
    label: "Insufficient local visual evidence",
    text: "Local vision completed without confirmed events or strong candidate windows.",
  };
}

export function compactFrameRefs(refs = [], limit = 4) {
  const unique = [...new Set(asArray(refs).map((ref) => String(ref).trim()).filter(Boolean))];
  if (!unique.length) return "";
  if (unique.length <= limit) return unique.join(", ");
  return `${unique.slice(0, limit).join(", ")}, plus ${unique.length - limit} more`;
}

export function localVisionFailureReason(item = {}, fallback = "") {
  const text = String(item.reason || item.basis || item.rejection_reason || fallback || "").replace(/\s+/g, " ").trim();
  if (text) return text;
  const type = String(item.type || item.label || item.claim || "").toLowerCase();
  if (type.includes("stroking") || type.includes("hand_genital")) return "Candidate windows did not pass the repeated visible motion gate.";
  if (type.includes("fluid") || type.includes("ejaculation")) return "No visible fluid release or new visible fluid passed confirmation gates.";
  if (type.includes("erection") || type.includes("genital")) return "Genital visibility was not sufficient for a specific state call.";
  if (type.includes("securement") || type.includes("statlock")) return "No visible securement device or adhesive anchor passed confirmation gates.";
  if (type.includes("advancement") || type.includes("catheter")) return "No visible tip or frame-to-frame advancement evidence passed confirmation gates.";
  return "Gate threshold was not met; this does not mean the event did not happen.";
}

export function displayCandidate(candidate = {}) {
  const label = humanizeLocalVisionLabel(candidate.label || candidate.type || candidate.candidate_type);
  const refs = compactFrameRefs(candidate.frame_refs || candidate.evidence_refs);
  const roiLabel = candidate.roi?.label || candidate.roi_label || candidate.roiLabel || "";
  return {
    label,
    status: "Strong candidate, not visually confirmed",
    confidence: Number(candidate.confidence ?? candidate.score ?? 0),
    reason: localVisionFailureReason(candidate, Array.isArray(candidate.reasons) ? candidate.reasons.join("; ") : ""),
    frameRefs: refs,
    roiText: roiLabel ? `ROI contributed: ${roiLabel}` : "",
  };
}

export function displayNotConfirmed(item = {}) {
  const raw = typeof item === "string" ? item : item.label || item.claim || item.type || "";
  const normalized = String(raw || "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  const label = NOT_CONFIRMED_LABELS[normalized.toLowerCase()] || titleCase(normalized || "Not visually confirmed");
  const refs = compactFrameRefs(item.frame_refs_checked || item.frame_refs || item.evidence_refs);
  return {
    label,
    status: "Not visually confirmed",
    reason: localVisionFailureReason(typeof item === "string" ? { label: item } : item),
    frameRefs: refs,
  };
}

export function localVisionSummaryCounts(result = {}) {
  return {
    confirmed: asArray(result.actionable_findings).length || asArray(result.timeline_events).length,
    candidates: asArray(result.strong_candidates).length,
    notConfirmed: asArray(result.not_confirmed).length || asArray(result.forbidden_or_not_visible).length,
  };
}

export function formatLocalVisionRange(item = {}) {
  const range = msRange(item);
  return `${formatMsClock(range.start_ms)}-${formatMsClock(range.end_ms)}`;
}

export function buildSarahLocalAnnotationCard(item = {}, options = {}) {
  const status = options.status || item.status || "candidate_not_confirmed";
  const previous = options.previous || null;
  const range = msRange(item);
  const label = humanizeLocalVisionLabel(item.label || item.event_type || item.type || item.candidate_type || item.claim);
  const refs = asArray(item.frame_refs || item.evidence_refs || item.frame_refs_checked || item.evidenceFrames);
  const compactRefs = compactFrameRefs(refs, 6);
  const confirmed = status === "confirmed";
  const notConfirmed = status === "not_confirmed" || status === "rejected" || status === "unresolved";
  const candidate = !confirmed && !notConfirmed;
  const evidenceType = confirmed ? "visual_evidence" : notConfirmed ? "limitation" : "visual_candidate";
  const confidence = item.confidence ?? item.score;
  const evidence = basisText(
    item,
    confirmed
      ? "Confirmed by local visual gates with supporting frame evidence."
      : candidate
        ? "Candidate window detected by local CV/Qwen review, but confirmation gates were not met."
        : "Checked by local vision, but not enough visible evidence was available for confirmation."
  );
  const limitation = confirmed
    ? "Use as a local visual fact only for the visible claim described here; do not infer subjective state or intent from this card alone."
    : localVisionFailureReason(item, evidence);
  const changeFromPrior = previous && (range.start_ms !== previous.start_ms || range.end_ms !== previous.end_ms)
    ? `Compared with the prior reviewed window (${previous.timestamp_range || formatLocalVisionRange(previous)}), this window stays in the same candidate family rather than adding a newly confirmed visual event.`
    : "First listed local review window for this run; no earlier local card is available for comparison.";
  const findingRow = {
    label,
    confidence_label: candidate ? `${confidenceLabel(confidence)} candidate strength` : confidenceLabel(confidence),
    detail: evidence,
    status: confirmed ? "confirmed" : candidate ? "candidate" : "not_visually_confirmed",
    frame_refs: refs,
  };
  const draftEvent = confirmed || candidate
    ? {
      timestamp: formatMsClock(range.start_ms),
      note: `${label}: ${confirmed ? "confirmed by local visual evidence" : "candidate, not visually confirmed"}.${compactRefs ? ` Evidence frames: ${compactRefs}.` : ""}`,
      evidence_type: confirmed ? "visual_evidence" : "visual_candidate",
    }
    : null;

  return {
    id: item.event_id || item.finding_id || item.candidate_id || item.label || `${status}-${range.start_ms}-${range.end_ms}`,
    timestamp_range: formatLocalVisionRange(item),
    start_ms: range.start_ms,
    end_ms: range.end_ms,
    title: label,
    window_summary: confirmed
      ? `${formatLocalVisionRange(item)} - ${label}. ${evidence}`
      : candidate
        ? `${formatLocalVisionRange(item)} - ${label}. ${evidence} Status: strong candidate, not visually confirmed.`
        : `${formatLocalVisionRange(item)} - ${label}. ${limitation}`,
    summary: confirmed
      ? `${label}. Local visual gates promoted this as a confirmed finding.`
      : candidate
        ? `${label}. Strong local-CV candidate, not visually confirmed by Qwen.`
        : `${label}. Not visually confirmed.`,
    visible_evidence: evidence,
    change_from_prior: changeFromPrior,
    confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : null,
    confidence_label: candidate ? `${confidenceLabel(confidence)} candidate strength` : confidenceLabel(confidence),
    limitation,
    status: confirmed ? "confirmed_visual_finding" : candidate ? "strong_candidate_not_confirmed" : "not_visually_confirmed",
    evidence_type: evidenceType,
    event_tags: [
      "local_vision",
      evidenceType,
      confirmed ? "confirmed" : candidate ? "candidate_not_confirmed" : "not_visually_confirmed",
      item.type || item.event_type || item.candidate_type || null,
    ].filter(Boolean),
    frame_refs: refs,
    frame_refs_text: compactRefs,
    finding_rows: [findingRow],
    draft_video_sync_events: draftEvent ? [draftEvent] : [],
  };
}

export function buildSarahLocalAnnotationCards(result = {}) {
  const sortStart = (item = {}) => {
    const value = item.start_ms ?? item.startMs ?? item.time_ms ?? item.timeMs;
    return Number.isFinite(Number(value)) ? Number(value) : Number.MAX_SAFE_INTEGER;
  };
  const rows = [
    ...asArray(result.actionable_findings).map((item) => ({ item, status: "confirmed" })),
    ...asArray(result.timeline_events).map((item) => ({ item, status: "confirmed" })),
    ...asArray(result.strong_candidates).map((item) => ({ item, status: "candidate_not_confirmed" })),
    ...asArray(result.not_confirmed).map((item) => ({ item, status: "not_confirmed" })),
  ]
    .filter(({ item }) => item)
    .sort((a, b) => sortStart(a.item) - sortStart(b.item));
  const seen = new Set();
  const cards = [];
  for (const row of rows) {
    const card = buildSarahLocalAnnotationCard(row.item, {
      status: row.status,
      previous: cards[cards.length - 1],
    });
    const key = `${card.status}|${card.start_ms}|${card.end_ms}|${card.title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push(card);
  }
  return cards;
}
