const INTERNAL_ANATOMY_RE = /\b(?:bladder neck|prostate|internal sphincters?|urethral course|pelvic floor musculature|internal rectal structures?|internal hemorrhoids?)\b/i;
const CALLOUT_DUMP_RE = /^\s*(?:visual\s+)?callouts?\s+for\b/i;
const INCIDENTAL_OBJECT_RE = /\b(?:headphones?|bone[-\s]?conduction|room contents?|furniture|background objects?)\b/i;

export function cleanProfileImageReviewText(value = "") {
  const raw = String(value || "");
  if (!raw.trim()) return "";
  if (CALLOUT_DUMP_RE.test(raw)) return "";
  if (INCIDENTAL_OBJECT_RE.test(raw) && !/\b(?:chest strap|polar|marker|catheter|foley|device|contact|fit|visibility|occlusion)\b/i.test(raw)) return "";

  let text = raw
    .replace(/\bThis batch does not include[^.]*\.?\s*/gi, "")
    .replace(/\bThis image set does not include[^.]*\.?\s*/gi, "")
    .replace(/\bNo (?:whole-body|full-body|torso|standing|posterior|anterior|lateral|upper limb|lower limb|foot|feet)[^.]*?(?:in this batch|in this image set|were included|were provided)[^.]*\.?\s*/gi, "")
    .replace(/\bnot visible in this batch\.?\s*/gi, "")
    .replace(/\bnot provided in this batch\.?\s*/gi, "")
    .replace(/\bnot included in this batch\.?\s*/gi, "")
    .replace(/\bdeferred to (?:another|subsequent|later) batch[^.]*\.?\s*/gi, "")
    .replace(/\b(?:No|The)\s+(?:bladder neck|prostate|internal sphincters?|urethral course|pelvic floor musculature|internal rectal structures?|internal hemorrhoids?)[^.]*\.?\s*/gi, "")
    .replace(/\b(?:bladder neck|prostate|internal sphincters?|urethral course|pelvic floor musculature|internal rectal structures?|internal hemorrhoids?)[^.]*?(?:not visible|not visualized|not assessable|not assessed)[^.]*\.?\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!text || INTERNAL_ANATOMY_RE.test(text)) return "";
  if (/\bmeat(?:al|us)\b/i.test(text) && /\b(?:bright|highlight|fluid|droplet|secretion|pre[-\s]?ejaculate)\b/i.test(text)) {
    return "Small bright meatal highlight or possible fluid point; static image cannot confirm secretion.";
  }
  return text;
}

export function profileImageReviewTopicKey(value = "") {
  const text = String(value || "").toLowerCase();
  if (!text.trim()) return "";
  if (/\bcentral adip|abdominal projection|abdomen projects|abdominal contour|pannus|lower abdominal fullness|infraumbilical\b/.test(text)) return "central-adiposity";
  if (/\bshoulders?\b.*\b(level|symmetric|symmetry|asymmetry)|\b(level|symmetric)\b.*\bshoulders?\b/.test(text)) return "shoulder-symmetry";
  if (/\b(limb proportionality|limbs? appear proportionate|gross limb asymmetry|limb symmetry|bilaterally symmetric in length|lower limbs? appear symmetric)\b/.test(text)) return "limb-proportionality";
  if (/\b(follicular|erythematous papules?|papular|keratosis|inguinal|inner thigh|gluteal|perianal)\b/.test(text) && /\b(papules?|spots?|follicular|erythematous)\b/.test(text)) return "follicular-papules";
  if (/\b(chest[-\s]?strap|polar h10|heart[-\s]?rate monitor)\b/.test(text)) return "chest-strap";
  if (/\b(flaccid|foreskin|glans|penile|penis|scrotum|testes|testicular)\b/.test(text) && /\b(stable|baseline|resting|normal|symmetric|foreskin|flaccid)\b/.test(text)) return "stable-genital-baseline";
  if (/\b(raphe|perineal body|scrotal raphe|perineal raphe|midline)\b/.test(text)) return "perineal-scrotal-midline";
  if (/\bmeat(?:al|us)\b/.test(text) && /\b(bright|highlight|fluid|droplet|secretion)\b/.test(text)) return "meatal-highlight";
  if (/\b(anterior pelvic tilt|lumbar lordosis|lordotic|sagittal posture)\b/.test(text)) return "sagittal-posture";
  return text.replace(/[^a-z0-9]+/g, " ").trim().slice(0, 180);
}

function evidenceRank(value = "") {
  const text = String(value || "").toLowerCase();
  if (/\b(current batch|directly observed|direct visual|visible in (?:the )?(?:current|uploaded|attached|fresh)|this run)\b/.test(text)) return 3;
  if (/\b(prior saved|saved evidence|prior baseline|stable from prior baseline|carried forward)\b/.test(text)) return 2;
  if (/\b(profile|context only|historical context)\b/.test(text)) return 1;
  return 0;
}

function findingQualityScore(value = "") {
  const text = String(value || "");
  let score = Math.min(4, Math.floor(text.length / 45));
  if (/\bwithout obvious\b|\bno visible\b|\bbroadly\b|\bdistribution\b|\bstatic image cannot confirm\b/i.test(text)) score += 2;
  if (/\bpossible\b|\blikely\b|\bdirectly observed\b|\bstable from prior baseline\b/i.test(text)) score += 1;
  if (text.length < 28) score -= 2;
  return score;
}

function isLowValueMissingCoverage(value = "", coverage = {}) {
  const text = String(value || "").toLowerCase();
  if (!/\b(?:missing|needed|need|request|not visible|not included|not available|coverage gap|optional)\b/.test(text)) return false;
  if (coverage.hasWholeBody && /\b(whole-body|whole body|full-body|full body|head-to-toe|standing anterior|standing posterior|standing lateral|anterior whole-body|posterior whole-body|lateral whole-body)\b/.test(text)) return true;
  if (coverage.hasFeet && /\b(feet|foot|toe|toes)\b/.test(text) && !/\b(dedicated|close-up|gait)\b/.test(text)) return true;
  if (coverage.hasHands && /\b(hands?|upper limbs?)\b/.test(text) && !/\b(dedicated|close-up)\b/.test(text)) return true;
  if (coverage.hasPelvic && /\b(pelvic|genital|perineal|scrotal|penile)\b/.test(text) && !/\b(state|erect|ventral|dedicated|specific)\b/.test(text)) return true;
  return false;
}

export function inferProfileImageCoverage(result = {}) {
  const chunks = [];
  const add = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) value.forEach(add);
    else if (typeof value === "object") Object.values(value).forEach(add);
    else chunks.push(String(value));
  };
  add(result.annotated_images);
  add(result.image_region_findings);
  add(result.coverage_map);
  add(result.summary_card?.coverage);
  const text = chunks.join(" ").toLowerCase();
  return {
    hasWholeBody: /\b(whole-body|whole body|full-body|full body|head-to-toe|head to toe|standing|anterior view|posterior view|lateral view|supine full)\b/.test(text),
    hasFeet: /\b(feet|foot|toe|toes|heel|ankle)\b/.test(text),
    hasHands: /\b(hands?|forearms?|upper limbs?)\b/.test(text),
    hasPelvic: /\b(pelvic|genital|penis|penile|scrot|testes|perineal|perianal|anal verge)\b/.test(text),
  };
}

export function dedupeProfileImageReviewItems(items = [], {
  limit = 14,
  coverage = {},
  suppressMissingCovered = true,
} = {}) {
  const byTopic = new Map();
  const order = [];
  for (const item of items) {
    const text = cleanProfileImageReviewText(item);
    if (!text) continue;
    if (suppressMissingCovered && isLowValueMissingCoverage(text, coverage)) continue;
    const key = profileImageReviewTopicKey(text);
    if (!key) continue;
    const existing = byTopic.get(key);
    if (!existing) {
      byTopic.set(key, text);
      order.push(key);
      continue;
    }
    const existingRank = evidenceRank(existing);
    const nextRank = evidenceRank(text);
    if (
      nextRank > existingRank ||
      (nextRank === existingRank && findingQualityScore(text) > findingQualityScore(existing)) ||
      (nextRank === existingRank && findingQualityScore(text) === findingQualityScore(existing) && text.length < existing.length && text.length > 40)
    ) {
      byTopic.set(key, text);
    }
  }
  return order.map((key) => byTopic.get(key)).filter(Boolean).slice(0, limit);
}

export function cleanupProfileImageReviewResult(result = {}, { sections = [] } = {}) {
  if (!result || typeof result !== "object") return result;
  const cleaned = { ...result };
  const coverage = inferProfileImageCoverage(cleaned);
  cleaned.overview = cleanProfileImageReviewText(cleaned.overview || "");

  if (cleaned.summary_card && typeof cleaned.summary_card === "object") {
    cleaned.summary_card = {
      ...cleaned.summary_card,
      baseline_quality: cleanProfileImageReviewText(cleaned.summary_card.baseline_quality || ""),
      coverage: cleanProfileImageReviewText(cleaned.summary_card.coverage || ""),
      primary_reference_value: dedupeProfileImageReviewItems(cleaned.summary_card.primary_reference_value || [], { limit: 6, coverage }),
      key_direct_findings: dedupeProfileImageReviewItems(cleaned.summary_card.key_direct_findings || [], { limit: 8, coverage }),
      key_limitations: dedupeProfileImageReviewItems(cleaned.summary_card.key_limitations || [], { limit: 4, coverage }),
      evidence_note: cleanProfileImageReviewText(cleaned.summary_card.evidence_note || ""),
    };
  }

  for (const section of sections) {
    if (!Array.isArray(cleaned[section.key])) continue;
    const sectionLimit = /coverage_map|significant_findings/i.test(section.key) ? 8 : /missing|optional|gap|limit/i.test(section.key) ? 5 : 10;
    cleaned[section.key] = dedupeProfileImageReviewItems(cleaned[section.key], {
      limit: sectionLimit,
      coverage,
      suppressMissingCovered: true,
    });
  }

  cleaned.annotated_images = Array.isArray(cleaned.annotated_images)
    ? cleaned.annotated_images.map((image) => ({
      ...image,
      view_label: cleanProfileImageReviewText(image.view_label || ""),
      body_position: cleanProfileImageReviewText(image.body_position || ""),
      coverage: cleanProfileImageReviewText(image.coverage || ""),
      visibility_notes: cleanProfileImageReviewText(image.visibility_notes || ""),
    }))
    : [];
  cleaned.image_region_findings = Array.isArray(cleaned.image_region_findings)
    ? dedupeImageRegionFindings(cleaned.image_region_findings)
    : [];
  return cleaned;
}

export function dedupeImageRegionFindings(findings = []) {
  const byTopic = new Map();
  const order = [];
  for (const finding of findings) {
    const text = cleanProfileImageReviewText(finding?.finding || "");
    const label = cleanProfileImageReviewText(finding?.label || finding?.region || "");
    if (!text && !label) continue;
    const key = `${finding?.section_key || ""}:${profileImageReviewTopicKey(`${label}. ${text}`)}`;
    if (!byTopic.has(key)) order.push(key);
    const existing = byTopic.get(key);
    const next = { ...finding, label, finding: text, region: cleanProfileImageReviewText(finding?.region || "") };
    if (!existing || evidenceRank(text) > evidenceRank(existing.finding || "") || text.length < String(existing.finding || "").length) {
      byTopic.set(key, next);
    }
  }
  return order.map((key) => byTopic.get(key)).filter(Boolean);
}
