import { useState, useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { serverUrl } from "@/lib/mobileApiBase";
import { Brain, Activity, AlertCircle, Zap, TrendingUp, Heart, Lightbulb, User, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, RefreshCw, History, Image as ImageIcon, Upload, X } from "lucide-react";
import TTSReader from "../components/TTSReader";
import AIOutputReader from "../components/AIOutputReader";
import { normalizeJournalEntry } from "@/lib/journalEntry";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ANATOMICAL_REFERENCE_FOCUS_RULE, buildAIGroundingContext, buildOptionalFirstNameToneCue, PERSONALIZED_ANATOMY_OUTPUT_RULE } from "@/lib/aiGrounding";
import { listBackgroundJobs, startBackgroundJob, waitForBackgroundJob } from "@/lib/backgroundJobs";
import { SESSION_CONTEXT_GROUNDING_RULE, sessionContextEvidenceText, sessionContextFactorLabels } from "@/lib/sessionContext";
import { getManualStimulationPauseResumeEvents, getMotionEvidenceSummary, summarizeMotionEvidenceCoverage } from "@/utils/sessionMotionEvidence";
import { buildProfileAIContentMeta, formatGeneratedAt, isProfileAIContentStale } from "@/utils/aiContentMetadata";
import { splitSentencesPreservingDecimals } from "@/utils/aiTextRepair";
import { buildLongitudinalHrvEvidence, RR_HRV_INTERPRETATION_RULES } from "@/utils/hrvEvidence";
import { buildProfileQaFindingCards, makeProfileQaEntry, normalizeProfileQaFindings } from "@/lib/profileQa";
import {
  cleanProfileImageReviewText,
  cleanupProfileImageReviewResult,
} from "@/lib/profileImageReviewCleanup";
import {
  buildBodyExplorationVideoPassDigest,
  buildBodyExplorationVisualEvidenceDigest,
  buildSessionVideoPassDigest,
  buildSessionVisualEvidenceDigest,
  normalizeBodyExplorationVideoPassFindings,
  normalizeBodyExplorationVisualEvidence,
  normalizeSessionVideoPassFindings,
  normalizeSessionVisualEvidence,
} from "@/lib/visualEvidence";

// ── helpers ────────────────────────────────────────────────────────────────────

function fmtSec(s) {
  if (s == null) return "—";
  const v = Math.round(Math.abs(s));
  return v >= 60 ? `${Math.floor(v / 60)}m${v % 60}s` : `${v}s`;
}

function briefText(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const PROFILE_ARCHIVE_LIMIT = 30;
const PROFILE_IMAGE_REVIEW_MAX_TOKENS = 16000;
const PROFILE_IMAGE_REVIEW_BATCH_SIZE = 5;
const PROFILE_IMAGE_ID_REPAIR_VERSION = 1;
const PROFILE_IMAGE_EVIDENCE_LAYER_RULE = `
PROFILE IMAGE EVIDENCE LAYER RULE:
- Keep the existing detailed A&P style, but keep evidence layers distinct.
- Treat each finding as one of three evidence buckets: Current batch direct evidence, Prior saved evidence, or Profile/context only.
- If a finding is visible in the images uploaded/rechecked for this run, identify it as directly visible/current evidence in the relevant section.
- If a finding is not directly reassessed in the current images but is documented in saved profile/prior Sarah evidence, say "Not directly assessed in this batch; carried forward from prior saved evidence." Use this sparingly and only when the distinction matters.
- If a finding comes only from user profile or historical context, label it as profile/context rather than visual evidence.
- Direct visual evidence means only what is visible in the currently reviewed/reloaded images. Use wording such as "visible", "appears", "is seen", "no visible", or "not visible in this frame/image set".
- Profile or prior-evidence reconciliation means comparison with saved profile metrics, prior reviewed images, saved Q&A findings, or session evidence. Use wording such as "consistent with prior documentation", "aligns with saved profile findings", or "supports a previous observation".
- Interpretation or clinical-functional relevance must be marked as interpretation. Use "may be relevant to", "is compatible with", "could contribute to", or "may reflect"; do not state it as direct visual fact.
- Avoid "confirms" unless the current reviewed image directly confirms the specific claim.
- A small clear/bright droplet at or near the meatus may be described as visible fluid. Reconcile separately with prior saved pre-ejaculate or urethral secretion findings. Do not claim continuous output unless the image sequence directly shows continuity.
- Do not state "parasympathetic secretory state" as a visual fact. If relevant, say profile context may be compatible with prior reported secretory patterns.
- For partially visible Hegar/dilator/device/catheter views, describe the visible part and relationship only. Say "No insertion is visible in this frame" rather than "the device is not inserted" unless the full relationship is visible.
- For Foley absence, say "No Foley catheter is visible in these reviewed images" rather than "No Foley was present" unless the image set fully covers the relevant anatomy and period.
- For tissue/safety observations, say "No visible irritation, fissuring, discoloration, or tissue stress is apparent in these images" rather than broad claims that no tissue stress exists.
- For close-up pelvic/genital images, do not label the view as standing, upright, or anatomical-position unless the image actually shows weight-bearing stance or enough whole-body context to establish that posture. If only a close-up pelvis/genitals/table field is visible, use "close-up pelvic/genital view", "table-position view", "lithotomy-adjacent view", or "position not fully assessable from this close-up".
- For annotated callouts, do not mark meatus, meatal fluid, urethral fluid, device insertion, Foley presence/absence, or fine tissue margins as high confidence unless the pin/box is on the visible structure and the surrounding prose states the visibility limits. If uncertain, label it possible/uncertain rather than visible/high.
- Profiler baseline data can support anatomy/profile context, but dynamic video events still require video frame/time evidence. Static image findings do not prove stroking, erection-state change during a session, ejaculation/fluid release, Foley advancement, securement, urine confirmation, or body/foot tension events.
`;

const PROFILE_IMAGE_VISIBLE_FINDINGS_FIRST_RULE = `
PROFILE IMAGE VISIBLE-FINDINGS-FIRST RULE:
- Lead with what is directly visible and useful. Ben wants the point: concrete body/anatomy/posture/tissue observations before caveats.
- Do not fill sections with repeated "not visible", "not assessable", "deferred", or "cannot be assessed" paragraphs for every absent body region.
- Mention limitations only when they materially change confidence, prevent a specific requested claim, or define the practical reference value of the review.
- If a section has little direct visual evidence, keep it short and move on instead of inventorying every missing region.
- Treat absence of concerning visible findings as a positive visual observation when relevant, for example no obvious lesion, swelling, asymmetry, device, or tissue stress visible.
- For audio quality, avoid repeating the same finding in the callout and the prose section. Use callouts as short anchors; use section prose for synthesis.
- Do not include process narration about batches, final synthesis, recovered output, paid requests, cloud requests, image counts, or review mechanics in the user-facing review unless it is essential.
`;

const PROFILE_IMAGE_INSIGHT_EFFICIENCY_RULE = `
PROFILE IMAGE INSIGHT-EFFICIENCY RULE:
Core goal: maximize insight per token, not words per report. Sarah should stay warm, clinical, evidence-based, and anatomically useful, but shorter, less repetitive, and more confidence-calibrated.

BASELINE VS NEW FINDINGS:
- Treat stable anatomy as baseline information. Before documenting any finding, ask whether it has already been documented with high confidence and appears unchanged. If yes, briefly say it remains stable from baseline and do not regenerate the full description.
- Spend detail only on newly visible structures, changed findings, improved image coverage, healing/progression, new posture findings, new skin findings, or newly visible anatomical regions.
- Do not turn stable anatomy into a fresh discovery every report. Stable scrotal anatomy, stable perineal raphe, stable central adiposity, and stable follicular papules should be summarized once unless something changed.

DEDUPLICATION:
- A unique finding should generally be described once. Do not repeat the same finding in Head-to-Toe, Skin, Habitus, Pelvic, Summary, and callouts.
- Do not paste callout text again into narrative sections. Use callouts as visual anchors; use narrative sections for synthesis.
- Use short cross-references such as "stable from prior baseline", "covered in the pelvic section", or "summarized under skin findings" instead of repeating paragraphs.
- Convert repeated findings into "stable baseline finding" language during synthesis and final output.

CONFIDENCE CALIBRATION:
- Use and preserve the confidence levels: observed, likely, possible, and not assessable. Do not upgrade a possible finding later in the report.
- Avoid assumptions about fluids, secretions, device use, physiological state, or activity outside the image.
- For ambiguous meatal highlights, say "small bright meatal highlight or possible fluid point; static image cannot confirm secretion." Do not write "consistent with pre-ejaculate" unless a sequence or explicit context supports it.

INTERNAL ANATOMY RULE:
- External photography cannot assess bladder neck, prostate, internal sphincters, urethral course, pelvic floor musculature, or internal rectal structures.
- Do not inventory internal anatomy as missing. Do not write "bladder neck not visualized", "prostate not visualized", or similar boilerplate.
- Use one concise boundary only when needed: "Review is limited to externally visible anatomy."

POSTURE RULES:
- Resolve contradictions. Do not describe both reduced lumbar lordosis and increased lumbar lordosis unless you explicitly reconcile view, posture, or gravity differences.
- Prefer cautious contour language: "body contour suggests mild anterior pelvic tilt" or "standing lateral view is compatible with..." when landmarks are not directly visible.
- Do not claim ASIS, pubic symphysis, iliac crest position, or other hidden bony landmarks unless directly visible.

SKIN RULES:
- Consolidate recurring skin findings once by distribution and character. Example: "Scattered follicular-appearing erythematous papules are present across bilateral inguinal folds, proximal inner thighs, and adjacent gluteal/perianal skin."
- Highlight change, progression, improvement, irritation, ulceration, crusting, vesicles, fissuring, tissue stress, or a new lesion. If unchanged, mark stable baseline.

PELVIC / GENITAL / PERINEAL RULES:
- Consolidate by structure. Report each structure once unless a new angle reveals a genuinely new observation.
- Do not repeatedly rediscover normal anatomy such as scrotal raphe, perineal raphe, foreskin state, or stable scrotal symmetry.
- Perianal review may cover pigmentation, symmetry, anal verge appearance, external hemorrhoids, fissures, skin tags, ulceration, and irritation. Do not assess internal hemorrhoids, prostate, or rectum beyond the visible opening.
- Track meaningful coverage states only: flaccid foreskin covering glans, flaccid foreskin retracted, erect foreskin covering glans, erect foreskin retracted, ventral view, scrotum elevated during arousal, and perineal/perianal view. Missing states belong only in Coverage Gaps.

INCIDENTAL OBJECT RULE:
- Ignore headphones, furniture, room contents, clothing, and random background objects unless they directly affect anatomical visibility, physiology, telemetry interpretation, device fit, tissue state, or safety interpretation.
- Do not spend report tokens clinically describing bone-conduction headphones or room setup.

HEAD-TO-TOE SCOPING:
- Focus on overall body composition, posture, symmetry, stance, musculoskeletal/foot mechanics, consolidated skin findings, and notable visible changes.
- Avoid detailed genital or perineal repetition in Head-to-Toe. Use one brief pelvis/genital visibility note when relevant, then leave detail to the Pelvic review.

PELVIC/GENITAL REVIEW SCOPING:
- Focus on visible external pelvic, genital, perineal, and perianal anatomy; tissue health; surface findings; coverage states; symmetry; and meaningful changes from baseline.
- Do not use the pelvic review to repeat whole-body habitus or posture unless it directly affects pelvic visibility or tissue interpretation.

COST AND OUTPUT DISCIPLINE:
- Generate: new findings, changed findings, stable baseline summary, significant findings, and coverage gaps.
- Avoid: entire historical narrative, repeated anatomy descriptions, repeated confidence statements, repeated callout text, source/provenance/process narration, and internal anatomy boilerplate.
- Do not add source/provenance/process sections to satisfy these rules. Apply them inside the existing anatomy-centered sections.
`;

const PROFILE_IMAGE_CUMULATIVE_SCOPE_RULE = `
CUMULATIVE PROFILE REVIEW SCOPE:
- This artifact is a full cumulative profile assessment, not a one-time review of only the newest or directly attached images.
- Treat directly attached/reloaded images as the current visual re-check subset. Use them to update, correct, and enrich the saved profile baseline.
- The scope of the user-facing review is the whole cumulative evidence base: current direct image subset, saved Profile Q&A findings, prior Sarah visual reviews, session/body-exploration visual evidence, entered profile metrics, and relevant saved context.
- Do not open the review with "based on five images", "based on X images", "these five images", "the recent images", or similar narrow framing.
- Good scope wording: "This cumulative review integrates saved profile-reference images, prior visual findings, entered measurements, and the directly rechecked views from this run."
- If exact image counts are useful, mention them only as evidence-method detail, not as the scope of the whole analysis.
`;

function chunkArray(items = [], size = 5) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function avg(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function fmtAvg(value, digits = 1) {
  return value == null ? "—" : Number(value).toFixed(digits).replace(/\.0$/, "");
}

const SESSION_DATE_TIME_ZONE = "America/New_York";

function sessionDateKey(value) {
  if (!value) return null;
  const text = String(value).trim();
  const localCalendarMatch = text.match(/^(\d{4}-\d{2}-\d{2})(?:$|T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/);
  if (localCalendarMatch) return localCalendarMatch[1];

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text.slice(0, 10) || null;
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: SESSION_DATE_TIME_ZONE,
  }).format(parsed);
}

function fmtNarrativeDate(value) {
  const raw = sessionDateKey(value);
  if (!raw) return "unknown date";
  const [year, month, day] = raw.split("-").map(Number);
  if (!year || !month || !day) return String(value);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function naturalizeSpokenDates(value) {
  return String(value || "").replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (match, year, month, day) => (
    fmtNarrativeDate(`${year}-${month}-${day}`) || match
  ));
}

function cleanImageReviewProse(value) {
  const cleaned = naturalizeSpokenDates(value)
    .replace(/\bimg[_-]?0*(\d+)\b/gi, (_match, number) => `image ${Number(number) || number}`)
    .replace(/\bImage\s+\d+\s*(?:\([^)]+\))?\s*:\s*/gi, "")
    .replace(/\b(?:IMG|VID|PXL|DSC|Photo|Screenshot)[-_ ]?\d{4,}\b/gi, "the referenced view")
    .replace(/\bThis batch does not include[^.]*\.?\s*/gi, "")
    .replace(/\bThis image set does not include[^.]*\.?\s*/gi, "")
    .replace(/\bNo (?:whole-body|full-body|torso|standing|posterior|anterior|lateral|upper limb|lower limb|foot|feet)[^.]*?(?:in this batch|in this image set|were included|were provided)[^.]*\.?\s*/gi, "")
    .replace(/\bAll\s+\d+\s+rechecked saved\/direct views are captured in\b/gi, "Reviewed saved/direct views include")
    .replace(/\bposition not fully assessable from this close-up\.?\s*/gi, "")
    .replace(/\bwhole-body standing posture is not established by this frame\.?\s*/gi, "")
    .replace(/\bposture labels are intentionally conservative for close-up pelvic views\.?\s*/gi, "")
    .replace(/\bnot visible in this batch\.?\s*/gi, "")
    .replace(/\bnot visible in this image set\.?\s*/gi, "")
    .replace(/\bcannot be assessed from these close-up pelvic views\.?\s*/gi, "")
    .replace(/\b(?:bladder neck|prostate|internal sphincters?|urethral course|pelvic floor musculature|internal rectal structures?|internal hemorrhoids?) (?:is|are|was|were)?\s*(?:not )?(?:visible|visualized|assessable|assessed)[^.]*\.?\s*/gi, "")
    .replace(/\b(?:No|The)\s+(?:bladder neck|prostate|internal sphincters?|urethral course|pelvic floor musculature|internal rectal structures?|internal hemorrhoids?)[^.]*\.?\s*/gi, "")
    .replace(/\bNo [^.]{0,80} assessment is possible from this batch\.?\s*/gi, "")
    .replace(/\b\d{7,}\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleanProfileImageReviewText(cleaned);
}

function recoveredBatchImageScopeLabel(batchSet = {}) {
  const reusedCount = Number(batchSet?.reused_saved_image_count || 0);
  const imageCount = Number(batchSet?.image_count || batchSet?.reviewed_images?.length || 0);
  if (reusedCount > 0) return `${reusedCount} rechecked saved/direct view${reusedCount === 1 ? "" : "s"}`;
  if (imageCount > 0) return `${imageCount} rechecked saved/direct view${imageCount === 1 ? "" : "s"}`;
  return "the rechecked saved/direct views";
}

function sanitizeRecoveredBatchScopeText(value, batchSet = {}) {
  if (typeof value !== "string") return value;
  const scopeLabel = recoveredBatchImageScopeLabel(batchSet);
  const hasNoFreshImages = Number(batchSet?.fresh_image_count || 0) === 0;
  let text = value;

  text = text
    .replace(/\bbased\s+on\s+(?:only\s+)?(?:the\s+)?(?:five|5|\d+)\s+(?:new|fresh|recent|newest)?\s*images?\b/gi, `grounded in ${scopeLabel}`)
    .replace(/\b(?:only\s+)?(?:the\s+)?(?:five|5|\d+)\s+(?:new|fresh|recent|newest)\s+images?\b/gi, scopeLabel)
    .replace(/\bthese\s+(?:five|5|\d+)\s+images?\b/gi, "these rechecked saved/direct views")
    .replace(/\bthe\s+(?:five|5|\d+)\s+images?\b/gi, "the rechecked saved/direct views")
    .replace(/\b(?:five|5)\s+images?\b/gi, scopeLabel)
    .replace(/\bnewest\s+image\s+set\b/gi, "rechecked saved/direct image set")
    .replace(/\brecent\s+images?\b/gi, "rechecked saved/direct images");

  if (hasNoFreshImages) {
    text = text
      .replace(/\bfresh\s+images?\b/gi, "rechecked saved/direct images")
      .replace(/\bnew\s+images?\b/gi, "rechecked saved/direct images")
      .replace(/\bnewly\s+attached\s+images?\b/gi, "rechecked saved/direct images")
      .replace(/\battached\s+images?\b/gi, "rechecked saved/direct images");
  }

  return text.replace(/\s{2,}/g, " ").trim();
}

function sanitizeRecoveredBatchResult(value, batchSet = {}) {
  if (typeof value === "string") return sanitizeRecoveredBatchScopeText(value, batchSet);
  if (Array.isArray(value)) return value.map((item) => sanitizeRecoveredBatchResult(item, batchSet));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeRecoveredBatchResult(item, batchSet)]),
  );
}

function isCloseUpPelvicImageText(value = "") {
  const text = String(value || "").toLowerCase();
  const closePelvic = /(close-up|close up|pelvic|genital|glans|meatus|meatal|foreskin|shaft|scrot|perine|perianal|anal verge|pubic)/i.test(text);
  const fullBody = /(full body|full-body|whole body|whole-body|head-to-toe|head to toe|crown to feet|feet visible|standing full)/i.test(text);
  return closePelvic && !fullBody;
}

function sanitizeImagePositionClaims(image = {}) {
  const combined = [image.view_label, image.body_position, image.coverage, image.visibility_notes].filter(Boolean).join(" ");
  let cleanedImage = image;
  if (/close[- ]up/i.test(combined) && /perine|scrotal[- ]base|anal verge/i.test(combined)) {
    const soften = (value = "") => String(value || "")
      .replace(/\bflaccid\s+shaft\s+base\b/gi, "possible superior shaft-base/scrotal-base edge")
      .replace(/\bshaft\s+base\b/gi, "possible superior shaft-base/scrotal-base edge")
      .replace(/\bventral\s+shaft\s+surface\b/gi, "superior genital-edge surface")
      .replace(/\bshaft\s+surface\b/gi, "superior genital-edge surface");
    cleanedImage = {
      ...cleanedImage,
      view_label: soften(cleanedImage.view_label),
      coverage: soften(cleanedImage.coverage),
      visibility_notes: soften(cleanedImage.visibility_notes),
    };
  }
  if (!isCloseUpPelvicImageText(combined)) return cleanedImage;
  const postureAsserted = /(standing|upright|facing camera|legs slightly apart|anatomical position)/i.test(combined);
  if (!postureAsserted) return cleanedImage;
  return {
    ...cleanedImage,
    view_label: cleanedImage.view_label
      ? cleanedImage.view_label
        .replace(/\bstanding\s+anterior\s+/i, "")
        .replace(/\bupright\s+/i, "")
        .replace(/\bfacing camera\s*/i, "")
        .replace(/^close-up/i, "Close-up")
      : "Close-up pelvic/genital view",
    body_position: "Close-up pelvic/genital reference view; whole-body standing posture is not established by this frame.",
    visibility_notes: [
      cleanedImage.visibility_notes,
      "Posture labels are intentionally conservative for close-up pelvic views.",
    ].filter(Boolean).join(" "),
  };
}

function isHighRiskMicroFinding(value = "") {
  return /(meatus|meatal|urethral|aperture|fluid droplet|droplet|pre[- ]?ejaculate|secretion|h[ae]gar|dilator|insert(?:ed|ion)?|foley|catheter)/i.test(String(value || ""));
}

function softenHighRiskFindingText(value = "") {
  return String(value || "")
    .replace(/\bclearly visible\b/gi, "reported as visible")
    .replace(/\bfully exposed\b/gi, "reported as exposed")
    .replace(/\bis visible\b/gi, "may be visible")
    .replace(/\bare visible\b/gi, "may be visible");
}

function sanitizeImageRegionFinding(finding = {}) {
  if (finding?.user_correction?.text) return finding;
  const combined = [finding.label, finding.finding, finding.region].filter(Boolean).join(" ");
  let cleanedFinding = finding;
  if (/close[- ]up|perine|scrotal[- ]base|anal verge/i.test(combined)) {
    const soften = (value = "") => String(value || "")
      .replace(/\bflaccid\s+shaft\s+base\b/gi, "possible superior shaft-base/scrotal-base edge")
      .replace(/\bshaft\s+base\b/gi, "possible superior shaft-base/scrotal-base edge")
      .replace(/\bventral\s+shaft\s+surface\b/gi, "superior genital-edge surface")
      .replace(/\bshaft\s+surface\b/gi, "superior genital-edge surface");
    cleanedFinding = {
      ...cleanedFinding,
      label: soften(cleanedFinding.label),
      finding: soften(cleanedFinding.finding),
      region: soften(cleanedFinding.region),
    };
  }
  if (!isHighRiskMicroFinding(combined)) return cleanedFinding;
  const limitations = Array.isArray(cleanedFinding.limitations) ? [...cleanedFinding.limitations] : [];
  limitations.push("Small-structure/device/fluid callout: verify directly against the displayed image before treating as confirmed.");
  const label = /^possible\b/i.test(cleanedFinding.label || "")
    ? cleanedFinding.label
    : `Possible ${String(cleanedFinding.label || cleanedFinding.region || "visual detail").replace(/^possible\s+/i, "")}`;
  return {
    ...cleanedFinding,
    label,
    finding: softenHighRiskFindingText(cleanedFinding.finding || ""),
    confidence: /high/i.test(cleanedFinding.confidence || "") ? "verify visually" : (cleanedFinding.confidence || "verify visually"),
    evidence_level: cleanedFinding.evidence_level || "needs_visual_verification",
    limitations: [...new Set(limitations.filter(Boolean))],
  };
}

function calmSpokenHeading(label) {
  return `Section: ${String(label || "").replace(/&/g, "and").toLowerCase()}.`;
}

function renderSentenceHighlightedText(text, activeSentenceIdx = -1, onSentenceClick) {
  const sentences = splitSentencesPreservingDecimals(text);
  return sentences.map((sentence, index) => (
    <span
      key={`${index}-${sentence.slice(0, 24)}`}
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        onSentenceClick?.(index);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onSentenceClick?.(index);
      }}
      className={`rounded-sm px-0.5 transition-colors ${activeSentenceIdx === index ? "bg-primary/20 text-foreground" : "hover:bg-muted/40"}`}
    >
      {sentence}{index < sentences.length - 1 ? " " : ""}
    </span>
  ));
}

const SESSION_DATE_GROUNDING_RULE = `
SESSION DATE GROUNDING RULE:
- A date attached to a session below is the recorded date that session occurred, normalized to the America/New_York local calendar date.
- When referencing a specific session, use that recorded session date only.
- Never replace a session occurrence date with the date an entry was created, updated, analyzed, regenerated, or exported.
- If a date is mentioned in prose, speak it naturally, such as "May 14, 2026", rather than reading an ISO date.
`;

const MOTION_EVIDENCE_PRECEDENCE_RULE = `
MOVEMENT EVIDENCE PRECEDENCE RULE (apply only when saved media-derived motion evidence exists):
- For visible movement interpretation, prioritize saved MediaPipe-derived motion telemetry over vague or conflicting movement-only notes.
- Media-derived evidence may support observational synthesis of lower-body movement timing, left/right activity comparison, asymmetry, forefoot or toe-region activity proxies, hand-movement cadence proxy, provisional hand-activity gap/resumption candidates, movement clustering, and confidence or reliability limitations.
- User-verified motion-derived events have been visually reviewed and may be treated as stronger observational evidence than unverified motion-derived events. They remain observational evidence only and do not establish intent, force, neurological mechanism, or physiological cause.
- For stimulation pause/resume timing and pause duration, explicit manually entered timeline events tagged stimulation_paused or stimulation_resumed take priority. Treat motion-derived hand pause/resume candidates as secondary corroboration because hand visibility and tracking may be imperfect.
- If manual stimulation pause/resume entries are absent, describe motion pause/resume evidence only as observed hand-activity gap or resumption candidates, not confirmed stimulation timing.
- Manual notes remain valuable when they contribute context that motion telemetry cannot know, including repositioning, method or grip change, breathing changes, interruption, subjective sensation, threshold behavior explicitly noted by the person, or environmental context.
- Treat older vague movement-only notes such as "feet moving," "toes twitching," "left foot active," "bilateral tremors," or "hand moving faster" as secondary when saved motion telemetry addresses the same visible behavior.
- If saved telemetry conflicts with vague manual movement notes, characterize visible movement from telemetry and preserve the manual note only as subjective or contextual history unless it adds distinct information.
- Motion evidence remains observational only. Do not infer intent, arousal phase, muscle force, neurological mechanism, autonomic cause, or physiological cause from motion alone.
- A cadence estimate is a visible hand-movement rhythm proxy, not confirmed stroke speed, technique, force, or stimulation intensity.
`;

function buildProfileEvidenceDigest(sessions) {
  const withHr = sessions.filter((s) => s.avg_hr || s.max_hr || s.hr_at_climax);
  const climaxSessions = sessions.filter((s) => !s.no_climax && s.climax_offset_s != null);
  const favorites = sessions.filter((s) => s.is_favorite).length;
  const motionCoverage = summarizeMotionEvidenceCoverage(sessions);
  const topRated = [...sessions]
    .sort((a, b) => ((b.satisfaction || 0) + (b.intensity || 0)) - ((a.satisfaction || 0) + (a.intensity || 0)))
    .slice(0, 5)
    .map((s) => `${sessionDateKey(s.date) || "unknown"} S${s.satisfaction ?? "?"}/I${s.intensity ?? "?"}, ${[...(s.methods || []), ...(s.custom_methods || [])].filter(Boolean).slice(0, 4).join("+") || "no method"}, maxHR ${s.max_hr || "?"}`)
    .join(" | ");

  const methodMap = new Map();
  for (const s of sessions) {
    const methods = [...(s.methods || []), ...(s.custom_methods || [])].filter(Boolean);
    for (const method of methods) {
      const key = String(method).toLowerCase();
      const row = methodMap.get(key) || { label: method, count: 0, satisfaction: [], intensity: [], maxHr: [] };
      row.count += 1;
      row.satisfaction.push(s.satisfaction);
      row.intensity.push(s.intensity);
      row.maxHr.push(s.max_hr);
      methodMap.set(key, row);
    }
  }
  const methodStats = [...methodMap.values()]
    .sort((a, b) => b.count - a.count || (avg(b.satisfaction) || 0) - (avg(a.satisfaction) || 0))
    .slice(0, 8)
    .map((m) => `${m.label}: n${m.count}, sat ${fmtAvg(avg(m.satisfaction))}, intensity ${fmtAvg(avg(m.intensity))}, maxHR ${fmtAvg(avg(m.maxHr), 0)}`)
    .join(" | ");

  // FULL_AI_SESSION_CONTEXT_EXPOSURE_V1
  const structuredContextLines = sessions
    .map((s) => {
      const context = sessionContextEvidenceText(s);
      return context ? `${sessionDateKey(s.date) || "unknown"}: ${context}` : null;
    })
    .filter(Boolean);

  const contextMap = new Map();
  for (const s of sessions) {
    for (const raw of [...sessionContextFactorLabels(s), s.build_type].filter(Boolean)) {
      const key = String(raw).toLowerCase();
      const row = contextMap.get(key) || { label: raw, count: 0, satisfaction: [], intensity: [] };
      row.count += 1;
      row.satisfaction.push(s.satisfaction);
      row.intensity.push(s.intensity);
      contextMap.set(key, row);
    }
  }
  const contextStats = [...contextMap.values()]
    .filter((c) => c.count >= 2)
    .sort((a, b) => (avg(b.satisfaction) || 0) - (avg(a.satisfaction) || 0))
    .slice(0, 8)
    .map((c) => `${c.label}: n${c.count}, sat ${fmtAvg(avg(c.satisfaction))}, intensity ${fmtAvg(avg(c.intensity))}`)
    .join(" | ");

  return [
    `Coverage: ${sessions.length} sessions, ${withHr.length} with HR, ${climaxSessions.length} with climax timing, ${favorites} favorites, ${sessions.filter((s) => s.no_climax).length} no-climax sessions.`,
    motionCoverage.any ? `Motion evidence is available for ${motionCoverage.any} sessions: ${motionCoverage.saved} with saved motion telemetry, ${motionCoverage.promoted} with promoted motion-derived timeline events, and ${motionCoverage.both} with both. Saved telemetry counts as motion evidence even when no reviewed finding has been promoted. Treat movement evidence as observational, not mechanism; activity scores are normalized within each analyzed window and are not absolute magnitudes across recordings.` : null,
    `HR: avg session HR ${fmtAvg(avg(sessions.map((s) => s.avg_hr)), 0)}, avg max HR ${fmtAvg(avg(sessions.map((s) => s.max_hr)), 0)}, avg HR at climax ${fmtAvg(avg(sessions.map((s) => s.hr_at_climax)), 0)}.`,
    `Ratings: avg satisfaction ${fmtAvg(avg(sessions.map((s) => s.satisfaction)))}, avg intensity ${fmtAvg(avg(sessions.map((s) => s.intensity)))}, avg build quality ${fmtAvg(avg(sessions.map((s) => s.build_quality)))}.`,
    topRated ? `Highest-rated evidence: ${topRated}` : null,
    methodStats ? `Method patterns: ${methodStats}` : null,
    contextStats ? `Context patterns: ${contextStats}` : null,
    structuredContextLines.length
      ? `Structured context evidence is available for ${structuredContextLines.length} sessions. Use it where relevant for context sensitivity, but do not treat it as causal by itself: ${structuredContextLines.slice(0, 30).join(" | ")}${structuredContextLines.length > 30 ? " | additional context-bearing sessions omitted from this compact digest but still present in the session-by-session evidence lines" : ""}`
      : null,
  ].filter(Boolean).join("\n");
}

function normalizeAIProfileResult(raw) {
  const parsed = raw?.response ?? raw;
  if (!parsed) return null;
  if (typeof parsed === "string") {
    return { profile_overview: parsed, arousal_physiology: [], stimulation_profile: [], climax_and_recovery: [], contextual_sensitivities: [], discomfort_and_edge_cases: [], behavioral_tendencies: [], optimization_recommendations: [] };
  }
  if (parsed.raw && typeof parsed.raw === "string") {
    return { profile_overview: parsed.raw, arousal_physiology: [], stimulation_profile: [], climax_and_recovery: [], contextual_sensitivities: [], discomfort_and_edge_cases: [], behavioral_tendencies: [], optimization_recommendations: [] };
  }
  return parsed;
}

function normalizeAnatomicalProfileResult(raw) {
  const parsed = raw?.response ?? raw;
  if (!parsed) return null;
  if (typeof parsed === "string") {
    return { overview: parsed };
  }
  if (parsed.raw && typeof parsed.raw === "string") {
    return { overview: parsed.raw };
  }
  return parsed;
}

function normalizeImageReviewAnnotations(raw = {}) {
  const annotationImages = Array.isArray(raw.annotated_images) ? raw.annotated_images : [];
  const regionFindings = Array.isArray(raw.image_region_findings) ? raw.image_region_findings : [];
  const normalizePercentCoordinate = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const percent = number > 0 && number <= 1 ? number * 100 : number;
    return Math.max(0, Math.min(100, percent));
  };
  return {
    annotated_images: annotationImages
      .map((image, index) => ({
        image_id: String(image?.image_id || `img_${String(index + 1).padStart(3, "0")}`),
        view_label: String(image?.view_label || image?.label || "").trim(),
        body_position: String(image?.body_position || "").trim(),
        coverage: String(image?.coverage || "").trim(),
        visibility_notes: String(image?.visibility_notes || "").trim(),
        major_regions_visible: Array.isArray(image?.major_regions_visible)
          ? image.major_regions_visible.map((item) => String(item || "").trim()).filter(Boolean)
          : [],
      }))
      .filter((image) => image.image_id),
    image_region_findings: regionFindings
      .map((finding, index) => {
        const pin = finding?.pin && typeof finding.pin === "object"
          ? {
            x: normalizePercentCoordinate(finding.pin.x),
            y: normalizePercentCoordinate(finding.pin.y),
          }
          : null;
        const box = finding?.box && typeof finding.box === "object"
          ? {
            x: normalizePercentCoordinate(finding.box.x),
            y: normalizePercentCoordinate(finding.box.y),
            width: normalizePercentCoordinate(finding.box.width),
            height: normalizePercentCoordinate(finding.box.height),
          }
          : null;
        return {
          finding_id: String(finding?.finding_id || `finding_${String(index + 1).padStart(3, "0")}`),
          image_id: String(finding?.image_id || "").trim(),
          section_key: String(finding?.section_key || "").trim(),
          region: String(finding?.region || "").trim(),
          label: String(finding?.label || finding?.region || "Visible finding").trim(),
          finding: String(finding?.finding || finding?.summary || "").trim(),
          confidence: String(finding?.confidence || "uncertain").trim(),
          visibility: String(finding?.visibility || "").trim(),
          evidence_level: String(finding?.evidence_level || "").trim(),
          limitations: Array.isArray(finding?.limitations)
            ? finding.limitations.map((item) => String(item || "").trim()).filter(Boolean)
            : [],
          pin: pin?.x != null && pin?.y != null ? pin : null,
          box: box?.x != null && box?.y != null && box?.width != null && box?.height != null ? box : null,
        };
      })
      .filter((finding) => finding.image_id && (finding.finding || finding.region || finding.label)),
  };
}

function normalizeImageReviewResult(raw) {
  const parsed = normalizeAnatomicalProfileResult(raw);
  if (!parsed) return null;
  const scopeSanitized = parsed?._meta?.local_batch_assembled
    ? sanitizeRecoveredBatchResult(parsed, parsed?._meta)
    : parsed;
  const normalized = {
    ...scopeSanitized,
    ...normalizeImageReviewAnnotations(scopeSanitized),
  };
  const cleaned = { ...normalized };
  if (cleaned.overview) cleaned.overview = cleanImageReviewProse(cleaned.overview);
  if (cleaned.summary_card && typeof cleaned.summary_card === "object") {
    cleaned.summary_card = {
      baseline_quality: cleanImageReviewProse(cleaned.summary_card.baseline_quality || ""),
      coverage: cleanImageReviewProse(cleaned.summary_card.coverage || ""),
      primary_reference_value: Array.isArray(cleaned.summary_card.primary_reference_value)
        ? cleaned.summary_card.primary_reference_value.map((item) => cleanImageReviewProse(item)).filter(Boolean)
        : [],
      key_direct_findings: Array.isArray(cleaned.summary_card.key_direct_findings)
        ? cleaned.summary_card.key_direct_findings.map((item) => cleanImageReviewProse(item)).filter(Boolean)
        : [],
      key_limitations: Array.isArray(cleaned.summary_card.key_limitations)
        ? cleaned.summary_card.key_limitations.map((item) => cleanImageReviewProse(item)).filter(Boolean)
        : [],
      evidence_note: cleanImageReviewProse(cleaned.summary_card.evidence_note || ""),
    };
  }
  for (const section of [
    ...HEAD_TO_TOE_IMAGE_REVIEW_CONFIG.sections,
    ...PELVIC_GENITAL_IMAGE_REVIEW_CONFIG.sections,
  ]) {
    if (!Array.isArray(cleaned[section.key])) continue;
    cleaned[section.key] = cleaned[section.key]
      .map((item) => cleanImageReviewProse(item))
      .filter(Boolean);
  }
  cleaned.annotated_images = (cleaned.annotated_images || []).map((image) => sanitizeImagePositionClaims({
    ...image,
    view_label: cleanImageReviewProse(image.view_label || ""),
    body_position: cleanImageReviewProse(image.body_position || ""),
    coverage: cleanImageReviewProse(image.coverage || ""),
    visibility_notes: cleanImageReviewProse(image.visibility_notes || ""),
  }));
  cleaned.image_region_findings = (cleaned.image_region_findings || []).map((finding) => sanitizeImageRegionFinding({
    ...finding,
    label: cleanImageReviewProse(finding.label || ""),
    finding: cleanImageReviewProse(finding.finding || ""),
    region: cleanImageReviewProse(finding.region || ""),
  }));
  return cleanupProfileImageReviewResult(cleaned, {
    sections: [
      ...HEAD_TO_TOE_IMAGE_REVIEW_CONFIG.sections,
      ...PELVIC_GENITAL_IMAGE_REVIEW_CONFIG.sections,
    ],
  });
}

function remapBatchLocalImageIds(result, reviewedImages = []) {
  if (!result || !Array.isArray(reviewedImages) || !reviewedImages.length) return result;
  const refs = reviewedImages.filter((image) => image?.image_id);
  if (!refs.length) return result;
  const validIds = new Set(refs.map((image) => image.image_id));
  const mapImageId = (imageId) => {
    const raw = String(imageId || "").trim();
    if (!raw || validIds.has(raw)) return raw;
    const match = raw.match(/^img_(\d{1,3})$/i);
    const localIndex = match ? Number(match[1]) - 1 : -1;
    return refs[localIndex]?.image_id || raw;
  };
  return {
    ...result,
    annotated_images: Array.isArray(result.annotated_images)
      ? result.annotated_images.map((image) => ({ ...image, image_id: mapImageId(image.image_id) }))
      : result.annotated_images,
    image_region_findings: Array.isArray(result.image_region_findings)
      ? result.image_region_findings.map((finding) => ({ ...finding, image_id: mapImageId(finding.image_id) }))
      : result.image_region_findings,
  };
}

function aiErrorMessage(error) {
  const raw = error?.data?.error || error?.message || String(error || "Analysis failed");
  try {
    const parsed = JSON.parse(raw);
    const nested = parsed?.error?.message || parsed?.message || parsed?.error;
    if (nested) return nested;
  } catch {
    // use raw text below
  }
  return raw;
}

async function saveClusterAnalysisPatch(patch, sessionCount) {
  const existing = await base44.entities.SessionClusterAnalysis.list("-updated_date", 1);
  if (existing[0]) {
    await base44.entities.SessionClusterAnalysis.update(existing[0].id, {
      ...patch,
      ...(sessionCount != null ? { session_count: sessionCount } : {}),
    });
    return;
  }
  await base44.entities.SessionClusterAnalysis.create({
    ...patch,
    ...(sessionCount != null ? { session_count: sessionCount } : {}),
  });
}

function profileArchiveId(kind, result) {
  const generated = result?._meta?.last_generated_at || result?._meta?.updated_at || new Date().toISOString();
  const sourceCount = result?._meta?.source_session_count ?? "unknown";
  return `${kind}-${generated}-${sourceCount}`;
}

function buildProfileArchiveEntry(kind, label, result) {
  const meta = result?._meta || {};
  const generatedAt = meta.last_generated_at || meta.updated_at || new Date().toISOString();
  return {
    id: profileArchiveId(kind, result),
    kind,
    label,
    archived_at: new Date().toISOString(),
    generated_at: generatedAt,
    source_session_count: meta.source_session_count ?? null,
    motion_evidence_session_count: meta.motion_evidence_session_count ?? null,
    source_signature: meta.source_signature || "",
    result,
  };
}

function mergeProfileArchive(existingArchive = [], entry) {
  const archive = Array.isArray(existingArchive) ? existingArchive : [];
  return [
    entry,
    ...archive.filter((item) => item?.id !== entry.id && item?.generated_at !== entry.generated_at),
  ].slice(0, PROFILE_ARCHIVE_LIMIT);
}

async function saveProfileResultWithArchive({
  resultKey,
  archiveKey,
  kind,
  label,
  result,
  sessionCount,
}) {
  const existing = await base44.entities.SessionClusterAnalysis.list("-updated_date", 1);
  const entry = buildProfileArchiveEntry(kind, label, result);
  const archive = mergeProfileArchive(existing[0]?.[archiveKey], entry);
  const patch = {
    [resultKey]: result,
    [archiveKey]: archive,
    ...(sessionCount != null ? { session_count: sessionCount } : {}),
  };
  if (existing[0]) {
    await base44.entities.SessionClusterAnalysis.update(existing[0].id, patch);
  } else {
    await base44.entities.SessionClusterAnalysis.create(patch);
  }
  return archive;
}

async function runProfilerAIJob(payload, label, onProgress, options = {}) {
  const startedJob = await startProfilerAIJob(payload, label, options);
  onProgress?.(startedJob);
  const completedJob = await waitProfilerAIJob(startedJob, onProgress);
  return completedJob.result;
}

async function startProfilerAIJob(payload, label, options = {}) {
  return startBackgroundJob("ai_invoke", { ...payload, label }, {
    source: "Profiler",
    route: "/ai-profiler",
    label,
    priority: options.priority ?? 0,
    ...options.meta,
  });
}

async function startProfileImageReviewFullJob(payload, label, options = {}) {
  return startBackgroundJob("profile_image_review_full", { ...payload, label }, {
    source: "Profiler",
    route: "/ai-profiler",
    label,
    priority: options.priority ?? 45,
    ...options.meta,
  });
}

async function waitProfilerAIJob(job, onProgress) {
  return waitForBackgroundJob(job.id, {
    intervalMs: 1200,
    onProgress,
  });
}

function completedAt(job) {
  return job?.finishedAt || job?.updatedAt || job?.createdAt || null;
}

function isNewerCompletedJob(job, savedResult) {
  if (job?.status !== "complete") return false;
  const jobTime = new Date(completedAt(job) || 0).getTime();
  const savedTime = new Date(savedResult?._meta?.last_generated_at || savedResult?._meta?.updated_at || 0).getTime();
  return Number.isFinite(jobTime) && jobTime > (Number.isFinite(savedTime) ? savedTime : 0);
}

function ProfilerJobStatus({ job, fallback }) {
  if (!job && !fallback) return null;
  const progress = job?.progress || {};
  const total = Number(progress.total || 0);
  const current = Number(progress.current || 0);
  const pct = job?.status === "complete"
    ? 100
    : total > 0
      ? Math.max(8, Math.min(100, Math.round((current / total) * 100)))
      : 18;
  const label = progress.message || fallback || "Working in the background…";

  return (
    <div className="rounded-lg border border-primary/25 bg-primary/8 px-3 py-3 text-xs">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-foreground">{label}</p>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10px] uppercase text-primary">
              {job?.status || "starting"}{progress.phase ? ` / ${progress.phase}` : ""}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
            {job?.id && <span>Job {String(job.id).slice(0, 8)}</span>}
            {job?.priority != null && <span>Priority {job.priority}</span>}
            {progress.model && <span>Model {progress.model}</span>}
            <span>You can leave this page while it finishes.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfilerPanelLoadingStatus({ items = [] }) {
  const activeItems = items.filter((item) => item && item.active);
  if (!activeItems.length) return null;
  return (
    <div className="rounded-lg border border-blue-400/25 bg-blue-500/10 px-3 py-3 text-xs">
      <div className="flex items-center gap-2 font-semibold text-blue-100">
        <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-blue-300 border-t-transparent" />
        Preparing this analysis panel
      </div>
      <div className="mt-2 grid gap-1.5">
        {activeItems.map((item) => (
          <div key={item.label} className="flex items-start justify-between gap-3 rounded-md bg-background/35 px-2 py-1.5">
            <span className="text-blue-50">{item.label}</span>
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-blue-200">{item.status || "loading"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function compactSessionLine(s) {
  const methods = [...(s.methods || []), ...(s.custom_methods || [])].filter(Boolean).slice(0, 5).join(", ") || "none";
  const structuredContext = sessionContextEvidenceText(s);
  const substances = Array.isArray(s.substances) ? s.substances : [s.substances].filter(Boolean);
  const context = structuredContext || [s.mood, s.environment, s.build_type, ...substances].filter(Boolean).join(", ") || "no context";
  const markers = [
    s.pre_climax_offset_s != null ? `pre ${fmtSec(s.pre_climax_offset_s)}` : null,
    s.climax_offset_s != null ? `climax ${fmtSec(s.climax_offset_s)}` : s.no_climax ? "no climax" : null,
    s.recovery_offset_s != null ? `recovery ${fmtSec(s.recovery_offset_s)}` : null,
  ].filter(Boolean).join("; ");
  const hr = [
    s.avg_hr ? `avg ${s.avg_hr}` : null,
    s.max_hr ? `max ${s.max_hr}` : null,
    s.hr_at_climax ? `climax ${s.hr_at_climax}` : null,
  ].filter(Boolean).join("/");
  const events = (s.event_timeline || [])
    .slice(0, 4)
    .map((e) => `${fmtSec(e.time_s)}${e.source === "motion_derived" ? ` [motion-derived observation${e.verification_status === "reviewed_verified" ? ", user-verified" : e.verification_status === "reviewed_adjusted" ? ", user-reviewed and adjusted" : ", unverified"}]` : ""} ${briefText(e.note, 70)}`)
    .join(" | ");
  const manualPauseResumeEvents = getManualStimulationPauseResumeEvents(s)
    .map((event) => `${fmtSec(event.time_s)} ${(Array.isArray(event.category) ? event.category : [event.category]).includes("stimulation_paused") ? "stimulation paused" : "stimulation resumed"}`)
    .join(" | ");
  const motion = s.motion_analysis_summary;
  const motionSummary = getMotionEvidenceSummary(s);
  const motionQuality = motion?.quality_indicators
    ? [
      motion.quality_indicators.left_lower_body ? `left quality ${motion.quality_indicators.left_lower_body}` : null,
      motion.quality_indicators.right_lower_body ? `right quality ${motion.quality_indicators.right_lower_body}` : null,
      motion.quality_indicators.hands ? `hand quality ${motion.quality_indicators.hands}` : null,
    ].filter(Boolean).join(", ")
    : null;
  const motionEvidence = motionSummary.hasAnyMotionEvidence
    ? `media motion ${[
      motionSummary.hasSavedTelemetry && !motionSummary.hasPromotedEvents ? "saved telemetry available; no promoted findings yet" : null,
      !motionSummary.hasSavedTelemetry && motionSummary.hasPromotedEvents ? "promoted motion-derived findings available without saved telemetry summary" : null,
      motionSummary.hasSavedTelemetry && motionSummary.hasPromotedEvents ? "saved telemetry plus promoted findings available" : null,
      motion?.left_lower_body_average_activity != null ? `left ${motion.left_lower_body_average_activity}` : null,
      motion?.right_lower_body_average_activity != null ? `right ${motion.right_lower_body_average_activity}` : null,
      motion?.left_forefoot_average_activity != null ? `left forefoot/toe-region ${motion.left_forefoot_average_activity}` : null,
      motion?.right_forefoot_average_activity != null ? `right forefoot/toe-region ${motion.right_forefoot_average_activity}` : null,
      motion?.hand_average_activity != null ? `hands ${motion.hand_average_activity}` : null,
      motionSummary.footGeometryTrackingSummary?.status === "marker_tracking_available" || motionSummary.footGeometryTrackingSummary?.status === "limited_marker_tracking"
        ? `continuous foot geometry tracking ${motionSummary.footGeometryTrackingSummary.coverage_pct}% coverage; average fan ${motionSummary.footGeometryTrackingSummary.average_fan_angle_deg ?? "?"}°, toe gap ${motionSummary.footGeometryTrackingSummary.average_toe_gap_normalized ?? "?"}, heel gap ${motionSummary.footGeometryTrackingSummary.average_heel_gap_normalized ?? "?"}; interpret as visual trend evidence for foot spread/fanning over time, not just one saved frame`
        : null,
      motion?.asymmetry_summary
        ? `asymmetry average index ${motion.asymmetry_summary.averageIndex}, peak ${motion.asymmetry_summary.peakIndex}, ${motion.asymmetry_summary.predominantSide === "balanced" ? "no clear side predominance" : `${motion.asymmetry_summary.predominantSide} predominance in ${motion.asymmetry_summary.predominantPct}% of active paired windows`}`
        : null,
      motion?.hand_movement_summary?.reliability === "moderate" && motion.hand_movement_summary.movement_cycles_per_minute_estimate != null
        ? `estimated hand-movement cadence ${motion.hand_movement_summary.movement_cycles_per_minute_estimate} movement cycles/min with ${motion.hand_movement_summary.pause_count} pauses of at least two seconds (observational proxy, not confirmed stroke speed)`
        : null,
      motionQuality ? `confidence/reliability ${motionQuality}` : null,
      (motion?.findings || []).length
        ? briefText(motion.findings.filter((finding) => !finding.startsWith("Repeated hand-movement oscillations support")).join(" "), 140)
        : null,
      motionSummary.promotedEventCount ? `${motionSummary.promotedEventCount} promoted motion-derived events` : null,
    ].filter(Boolean).join(", ")}`
    : null;
  return [
    `${sessionDateKey(s.date) || "unknown"}: ${s.duration_minutes || "?"}m`,
    `methods ${methods}`,
    `ratings I${s.intensity ?? "?"}/S${s.satisfaction ?? "?"}/build${s.build_quality ?? "?"}`,
    `HR ${hr || "none"}`,
    `markers ${markers || "none"}`,
    `context ${context}`,
    s.discomfort ? `discomfort ${briefText(s.discomfort, 90)}` : null,
    s.unusual_sensations ? `sensations ${briefText(s.unusual_sensations, 90)}` : null,
    s.notes ? `notes ${briefText(s.notes, 120)}` : null,
    events ? `events ${events}` : null,
    manualPauseResumeEvents ? `manual stimulation pause/resume timing (primary for pause interpretation) ${manualPauseResumeEvents}` : null,
    motionEvidence,
  ].filter(Boolean).join("; ");
}

function compactAnatomicalSessionLine(s) {
  return compactSessionLine(s).replace(
    String(sessionDateKey(s.date) || "unknown"),
    fmtNarrativeDate(s.date),
  );
}

function CompactError({ message }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

// Import-equivalent: NCE keyword list for note corroboration (mirrored from NearClimaxEvents)
const NCE_KEYWORDS = [
  "tension", "tense", "tight", "tighten", "clench", "grip",
  "foot", "feet", "plant", "planting", "toe", "curl",
  "throb", "pulse", "pulsing", "twitch", "spasm",
  "edge", "edg", "near", "almost", "close", "threshold",
  "pressure", "build", "buildup", "surge", "wave", "rush",
  "intense", "intensity", "strong", "overwhelming",
  "breath", "breathing", "gasp", "hold",
  "shiver", "shak", "tremble",
];

function scoreEventNoteCorroboration(eventStartS, eventEndS, sessionEvents) {
  if (!sessionEvents || sessionEvents.length === 0) return 0;
  const windowS = 45;
  let score = 0;
  for (const ev of sessionEvents) {
    const t = Number(ev.time_s);
    if (t < eventStartS - windowS || t > eventEndS + windowS) continue;
    const dist = Math.max(0, Math.min(Math.abs(t - eventStartS), Math.abs(t - eventEndS)));
    const proximityWeight = dist < 15 ? 2 : 1;
    const note = (ev.note || "").toLowerCase();
    const cats = Array.isArray(ev.category) ? ev.category : [ev.category].filter(Boolean);
    if (cats.some(c => ["physical", "sensation"].includes(c))) score += 1 * proximityWeight;
    for (const kw of NCE_KEYWORDS) {
      if (note.includes(kw)) { score += 2 * proximityWeight; break; }
    }
  }
  return score;
}

// Detect near-climax events: sustained HR elevations (not brief spikes) before the pre-climax marker.
// Uses event note corroboration for confidence scoring.
function detectNearClimaxEvents(rows, climaxOffsetS, preClimaxOffsetS, sessionEvents = []) {
  if (!rows || rows.length < 10) return [];

  const smoothed = rows.map((r, i) => {
    const win = rows.slice(Math.max(0, i - 3), i + 4);
    const avg = win.reduce((a, w) => a + Number(w.hr), 0) / win.length;
    return { t: Number(r.time_offset_s), hr: avg };
  });

  const excludeStart = climaxOffsetS != null
    ? (preClimaxOffsetS != null
        ? Math.min(preClimaxOffsetS, climaxOffsetS - 60)
        : climaxOffsetS - 90)
    : Infinity;

  const allHRs = smoothed.filter(p => p.t < excludeStart).map(p => p.hr);
  if (allHRs.length < 10) return [];
  const sessionMinHR = Math.min(...allHRs);
  const sessionMaxHR = Math.max(...allHRs);
  const sessionHRRange = sessionMaxHR - sessionMinHR;

  const MIN_RISE_BPM = Math.max(7, sessionHRRange * 0.13);
  const MAX_RISE_BPM = sessionHRRange * 0.78;
  const RISE_WINDOW_S = 120;
  const SUSTAINED_THRESHOLD_S = 20;
  const SUSTAINED_TOLERANCE = 5;
  const DROP_BPM = Math.max(5, MIN_RISE_BPM * 0.55);
  const SEARCH_DROP_S = 150;
  const MIN_DURATION_S = 25;
  const MAX_DURATION_S = 300;
  const COOLDOWN_S = 30;
  const MIN_CONFIDENCE = 2;

  const events = [];
  let lastEventEnd = -Infinity;
  let i = 0;

  while (i < smoothed.length - 5) {
    const { t: t0, hr: hr0 } = smoothed[i];
    if (t0 < lastEventEnd + COOLDOWN_S) { i++; continue; }
    if (t0 >= excludeStart) break;

    let peakIdx = i;
    let peakHr = hr0;
    for (let j = i + 1; j < smoothed.length; j++) {
      if (smoothed[j].t - t0 > RISE_WINDOW_S) break;
      if (smoothed[j].t >= excludeStart) break;
      if (smoothed[j].hr > peakHr) { peakHr = smoothed[j].hr; peakIdx = j; }
    }

    const rise = peakHr - hr0;
    if (rise < MIN_RISE_BPM || rise > MAX_RISE_BPM || peakIdx === i) { i++; continue; }

    const peakTime = smoothed[peakIdx].t;

    // Require sustained elevation — not just a momentary spike
    let sustainedEndIdx = peakIdx;
    for (let j = peakIdx + 1; j < smoothed.length; j++) {
      if (smoothed[j].t - peakTime > 90) break;
      if (smoothed[j].hr >= peakHr - SUSTAINED_TOLERANCE) sustainedEndIdx = j;
    }
    const sustainedDuration = smoothed[sustainedEndIdx].t - peakTime;
    if (sustainedDuration < SUSTAINED_THRESHOLD_S) { i = peakIdx + 1; continue; }

    let dropIdx = -1;
    for (let j = sustainedEndIdx + 1; j < smoothed.length; j++) {
      if (smoothed[j].t - peakTime > SEARCH_DROP_S) break;
      if (smoothed[j].hr <= peakHr - DROP_BPM) { dropIdx = j; break; }
    }
    if (dropIdx === -1) { i = peakIdx + 1; continue; }

    const eventDuration = smoothed[dropIdx].t - t0;
    if (eventDuration < MIN_DURATION_S || eventDuration > MAX_DURATION_S) { i++; continue; }
    if (peakHr >= sessionMaxHR * 0.96) { i = dropIdx + 1; continue; }

    const noteScore = scoreEventNoteCorroboration(t0, smoothed[dropIdx].t, sessionEvents);
    const hrConfidence = Math.min(4, Math.floor((rise / MIN_RISE_BPM - 1) * 2) + Math.floor(sustainedDuration / 20));
    const totalConfidence = hrConfidence + noteScore;
    if (totalConfidence < MIN_CONFIDENCE) { i++; continue; }

    events.push({
      start_offset_s: t0,
      peak_offset_s: peakTime,
      end_offset_s: smoothed[dropIdx].t,
      base_hr: Math.round(hr0),
      peak_hr: Math.round(peakHr),
      rise_bpm: Math.round(rise),
      sustained_s: Math.round(sustainedDuration),
      duration_s: Math.round(eventDuration),
      confidence: Math.min(10, totalConfidence),
      note_corroborated: noteScore > 0,
    });

    lastEventEnd = smoothed[dropIdx].t;
    i = dropIdx + 1;
  }

  return events;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionCard({ icon, title, color, children, defaultCollapsed = false }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <button
        className="w-full flex items-center justify-between gap-1.5 text-left"
        onClick={() => setCollapsed(v => !v)}
      >
        <h3 className="text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color }}>
          {icon}{title}
        </h3>
        {collapsed
          ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
          : <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>
      {!collapsed && children}
    </div>
  );
}

function profileArchivePreview(entry) {
  const result = entry?.result || {};
  const firstArrayText = [
    result.arousal_physiology,
    result.constitutional_and_systemic_context,
    result.pelvic_and_external_anatomy,
    result.stimulation_profile,
  ].find((items) => Array.isArray(items) && items.length)?.[0];
  return briefText(result.profile_overview || result.overview || firstArrayText || "No preview available for this archived run.", 320);
}

function profileArchiveGeneratedLabel(entry) {
  return entry?.generated_at ? formatGeneratedAt(entry.generated_at) : "Unknown generation time";
}

function isCurrentArchiveEntry(entry, currentResult) {
  const currentGenerated = currentResult?._meta?.last_generated_at || currentResult?._meta?.updated_at || "";
  return Boolean(currentGenerated && entry?.generated_at === currentGenerated);
}

function ProfileArchiveList({ title = "Profile Run Archive", archive = [], currentResult, onViewRun }) {
  if (!archive.length) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
            <History className="h-3.5 w-3.5" /> {title}
          </h4>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Saved profiler runs for longitudinal review. Latest {PROFILE_ARCHIVE_LIMIT} are retained.
          </p>
        </div>
        <Badge variant="secondary" className="text-[10px]">{archive.length} saved</Badge>
      </div>
      <div className="mt-3 space-y-2">
        {archive.map((entry) => {
          const current = isCurrentArchiveEntry(entry, currentResult);
          return (
            <details key={entry.id || entry.generated_at} className="rounded-lg border border-border bg-background/60 px-3 py-2">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold text-foreground">
                    {profileArchiveGeneratedLabel(entry)}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">
                    {entry.source_session_count ?? "?"} source sessions
                    {entry.motion_evidence_session_count != null ? ` · ${entry.motion_evidence_session_count} with motion evidence` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {current && <Badge variant="outline" className="text-[10px]">Current</Badge>}
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </span>
              </summary>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{profileArchivePreview(entry)}</p>
              <div className="mt-2 flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => onViewRun?.(entry.result)}
                >
                  View This Run
                </Button>
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function imageFileToPayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const base64 = dataUrl.replace(/^data:[^;]+;base64,/, "");
      resolve({
        id: `${file.name}-${file.size}-${file.lastModified}`,
        filename: file.name,
        file,
        media_type: file.type || "image/jpeg",
        data: base64,
        previewUrl: dataUrl,
        upload_note: "",
        size: file.size,
        lastModified: file.lastModified,
      });
    };
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function stripDataUrl(value) {
  return String(value || "").replace(/^data:[^;]+;base64,/, "");
}

function normalizeMediaType(value = "") {
  const mediaType = String(value || "").trim();
  if (mediaType.startsWith("image/")) return mediaType;
  return "image/jpeg";
}

function scoreSavedProfileImageGroup({ message, replyText = "", purpose = "general" }) {
  const text = `${message?.text || ""} ${replyText}`.toLowerCase();
  if (!text.trim()) return 0;

  const countMatches = (terms) => terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
  const headToToePositive = [
    "full-body", "full body", "whole-body", "whole body", "head-to-toe", "head to toe",
    "standing", "anterior", "posterior", "lateral", "front view", "back view", "side view",
    "baseline set", "body baseline", "body-reference", "body reference", "posture", "alignment",
    "habitus", "torso", "abdomen", "chest", "shoulder", "build", "table position",
  ];
  const headToToeNegative = [
    "close-up", "pelvic", "perineal", "perianal", "genital", "glans", "meatus", "foreskin",
    "scrotal", "catheter", "foley", "sounding", "dilator", "urethral", "lithotomy",
  ];
  const pelvicPositive = [
    "pelvic", "perineal", "perianal", "genital", "glans", "meatus", "foreskin", "shaft",
    "scrotal", "scrotum", "anus", "anal", "catheter", "foley", "sounding", "dilator",
    "urethral", "lithotomy", "table-position", "table position",
  ];
  const pelvicNegative = ["full-body", "full body", "whole-body", "whole body", "standing views"];

  if (purpose === "head_to_toe_body_reference") {
    return countMatches(headToToePositive) * 4 - countMatches(headToToeNegative) * 3;
  }
  if (purpose === "pelvic_genital") {
    return countMatches(pelvicPositive) * 4 - countMatches(pelvicNegative) * 2;
  }
  return 0;
}

function collectSavedProfileImageAttachments(userProfile, { limit = 5, purpose = "general" } = {}) {
  const messages = Array.isArray(userProfile?.profile_chat_messages) ? userProfile.profile_chat_messages : [];
  const seen = new Set();
  const items = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    const attachments = Array.isArray(message?.imageAttachments) ? message.imageAttachments : [];
    const imageAttachments = attachments.filter((attachment) => !attachment?.sourceVideo);
    if (!imageAttachments.length) continue;
    const reply = messages.slice(messageIndex + 1).find((candidate) => candidate?.role !== "user" && String(candidate?.text || "").trim());
    const replyText = String(reply?.text || "");
    const groupScore = scoreSavedProfileImageGroup({ message, replyText, purpose });
    const createdAt = imageAttachments.map((attachment) => attachment.createdAt).filter(Boolean).sort().at(-1) || "";
    for (const attachment of imageAttachments) {
      if (attachment?.sourceVideo) continue;
      const url = attachment.previewUrl || attachment.storagePath || "";
      if (!url) continue;
      const key = attachment.storagePath || attachment.previewUrl || attachment.id || attachment.filename;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push({
        id: attachment.id || key,
        filename: attachment.filename || "saved-profile-image.jpg",
        media_type: normalizeMediaType(attachment.mimeType || attachment.media_type),
        url,
        saved_at: attachment.createdAt || message.createdAt || null,
        source: "saved_profile_qa_attachment",
        selection_score: groupScore,
        selection_context: purpose,
        selection_group_created_at: createdAt,
      });
    }
  }

  const byRelevance = [...items]
    .sort((a, b) => {
      if (b.selection_score !== a.selection_score) return b.selection_score - a.selection_score;
      return (Date.parse(b.saved_at || b.selection_group_created_at || 0) || 0) - (Date.parse(a.saved_at || a.selection_group_created_at || 0) || 0);
    });
  const byRecency = [...items]
    .sort((a, b) => (Date.parse(b.saved_at || b.selection_group_created_at || 0) || 0) - (Date.parse(a.saved_at || a.selection_group_created_at || 0) || 0));

  // Build a coverage-aware pool instead of letting one older high-scoring
  // image set monopolize the review. New saved uploads and strongly relevant
  // older references should both make it into the final batched synthesis.
  const mixed = [];
  const add = (attachment) => {
    if (!attachment) return;
    const key = attachment.storagePath || attachment.url || attachment.id || attachment.filename;
    if (!key || mixed.some((item) => (item.storagePath || item.url || item.id || item.filename) === key)) return;
    mixed.push(attachment);
  };
  const recentQuota = Math.min(byRecency.length, Math.max(3, Math.ceil(limit * 0.35)));
  byRecency.slice(0, recentQuota).forEach(add);
  byRelevance.forEach(add);
  byRecency.forEach(add);
  return mixed.slice(0, limit);
}

async function savedAttachmentToPayload(attachment) {
  const url = serverUrl(attachment.url);
  if (!url) throw new Error(`Saved image ${attachment.filename || ""} has no reusable URL.`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load saved image ${attachment.filename || url}.`);
  const blob = await response.blob();
  const mediaType = normalizeMediaType(blob.type || attachment.media_type);
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error(`Could not read saved image ${attachment.filename || url}.`));
    reader.readAsDataURL(blob);
  });
  return {
    id: attachment.id || `${attachment.filename}-${attachment.saved_at || ""}`,
    filename: attachment.filename || "saved-profile-image.jpg",
    media_type: mediaType,
    data: stripDataUrl(dataUrl),
    previewUrl: dataUrl,
    storagePath: attachment.url || "",
    source: attachment.source || "saved_profile_qa_attachment",
    saved_at: attachment.saved_at || null,
  };
}

function compactProfileJsonValue(value) {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() ? value.trim() : null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.map(compactProfileJsonValue).filter((item) => item != null);
    return items.length ? items : null;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, entryValue]) => [key, compactProfileJsonValue(entryValue)])
      .filter(([, entryValue]) => entryValue != null);
    return entries.length ? Object.fromEntries(entries) : null;
  }
  return null;
}

function buildExistingVisualEvidenceDigest({ sessions = [], bodyExplorations = [] }) {
  const sortedSessions = [...(sessions || [])]
    .sort((a, b) => new Date(b.date || b.created_date || 0) - new Date(a.date || a.created_date || 0));
  const sortedExplorations = [...(bodyExplorations || [])]
    .sort((a, b) => new Date(b.date || b.created_date || 0) - new Date(a.date || a.created_date || 0));

  const sessionVisualEntryCount = sortedSessions.reduce((count, session) => count + normalizeSessionVisualEvidence(session).length, 0);
  const sessionVideoPassCount = sortedSessions.reduce((count, session) => count + normalizeSessionVideoPassFindings(session).length, 0);
  const explorationVisualEntryCount = sortedExplorations.reduce((count, exploration) => count + normalizeBodyExplorationVisualEvidence(exploration).length, 0);
  const explorationVideoPassCount = sortedExplorations.reduce((count, exploration) => count + normalizeBodyExplorationVideoPassFindings(exploration).length, 0);

  const sessionBlocks = sortedSessions
    .flatMap((session) => [
      buildSessionVisualEvidenceDigest(session, { limit: 4 }),
      buildSessionVideoPassDigest(session, { limit: 4, findingsPerCard: 3, eventsPerCard: 2 }),
    ])
    .filter(Boolean)
    .slice(0, 80);
  const explorationBlocks = sortedExplorations
    .flatMap((exploration) => [
      buildBodyExplorationVisualEvidenceDigest(exploration, { limit: 4 }),
      buildBodyExplorationVideoPassDigest(exploration, { limit: 4, findingsPerCard: 3, eventsPerCard: 2 }),
    ])
    .filter(Boolean)
    .slice(0, 60);

  return {
    counts: {
      session_visual_entries: sessionVisualEntryCount,
      session_video_passes: sessionVideoPassCount,
      body_exploration_visual_entries: explorationVisualEntryCount,
      body_exploration_video_passes: explorationVideoPassCount,
    },
    hasAny: Boolean(sessionVisualEntryCount || sessionVideoPassCount || explorationVisualEntryCount || explorationVideoPassCount),
    text: `
EXISTING UPLOADED / REVIEWED VISUAL EVIDENCE:
- Session Sarah visual-review entries: ${sessionVisualEntryCount}.
- Session Sarah video-pass finding cards: ${sessionVideoPassCount}.
- Body exploration Sarah visual-review entries: ${explorationVisualEntryCount}.
- Body exploration Sarah video-pass finding cards: ${explorationVideoPassCount}.
- Treat these as previously reviewed evidence from uploaded images, uploaded/sampled video frames, and AI video passes. Do not claim to be directly viewing the original media again unless fresh images are attached in this run.

SESSION VISUAL / VIDEO EVIDENCE DIGEST:
${sessionBlocks.length ? sessionBlocks.join("\n\n") : "- No saved session visual/video evidence digest available."}

BODY EXPLORATION VISUAL / VIDEO EVIDENCE DIGEST:
${explorationBlocks.length ? explorationBlocks.join("\n\n") : "- No saved body exploration visual/video evidence digest available."}
`,
  };
}

function buildProfileImageReviewContext({ userProfile, sessions = [], bodyExplorations = [] }) {
  const qaEntries = normalizeProfileQaFindings(userProfile?.profile_qa_findings);
  const qaCards = buildProfileQaFindingCards(userProfile?.profile_qa_findings, userProfile?.first_name).slice(0, 45);
  const visualEvidence = buildExistingVisualEvidenceDigest({ sessions, bodyExplorations });
  const reusableProfileImages = collectSavedProfileImageAttachments(userProfile, { limit: 20, purpose: "pelvic_genital" });
  const compactMetrics = compactProfileJsonValue({
    anatomical_mechanical_profile: userProfile?.anatomical_mechanical_profile,
    profile_notes: userProfile?.profile_notes || userProfile?.notes,
    age: userProfile?.age,
    sex: userProfile?.sex,
    height: userProfile?.height,
    weight: userProfile?.weight,
    medications: userProfile?.medications,
    medical_context: userProfile?.medical_context,
    physiology_notes: userProfile?.physiology_notes,
  });
  const sortedSessions = [...(sessions || [])]
    .sort((a, b) => new Date(b.date || b.created_date || 0) - new Date(a.date || a.created_date || 0));
  const sessionLines = sortedSessions.slice(0, 45).map(compactAnatomicalSessionLine).filter(Boolean);
  const evidenceDigest = sortedSessions.length ? naturalizeSpokenDates(buildProfileEvidenceDigest(sortedSessions)) : "";

  return `
PROFILE IMAGE REVIEW SOURCE CONTEXT:
- If fresh images are attached in this run, use them as the primary source for directly visible anatomy, position, tissue state, and image-limited observations.
- If no fresh images are attached, make existing saved evidence the primary evidence base: saved Profile Q&A visual reviews, reusable saved Profile Q&A image attachments when available, session image/video findings, body-exploration image/video findings, entered profile metrics, and session evidence.
- Use saved Q&A findings, reusable saved media, entered profile metrics, and session/body-exploration evidence as first-class profile evidence. Reconcile them with fresh images when present instead of ignoring them.
- If saved context conflicts with fresh images or with another saved visual review, state the mismatch and explain which source is stronger for that claim.
- Do not let profile history make you overcall something that is not visible.
- Output priority: say what can be seen first. Do not spend the review cataloging absent regions unless that absence directly changes confidence or next-image planning.

REUSABLE SAVED PROFILE Q&A IMAGE ATTACHMENTS:
- Saved non-video Profile Q&A image attachments available for reuse: ${reusableProfileImages.length}.
${reusableProfileImages.length ? reusableProfileImages.slice(0, 12).map((image, index) => `- Reference view ${reviewImageLetter(index)}${image.saved_at ? ` saved ${formatGeneratedAt(image.saved_at)}` : ""}.`).join("\n") : "- None reusable from saved chat messages."}

SAVED PROFILE Q&A FINDINGS (${qaEntries.length} entries; showing up to ${qaCards.length} deduplicated findings):
${qaCards.length ? qaCards.map((card, index) => `${index + 1}. ${card.finding} (${card.sourceLabel}, ${card.timestamp})`).join("\n") : "- None saved."}

ENTERED PROFILE METRICS AND NOTES:
${compactMetrics ? JSON.stringify(compactMetrics, null, 2) : "- None saved."}

SESSION EVIDENCE SUMMARY (${sortedSessions.length} sessions loaded):
${evidenceDigest || "- No session evidence loaded."}

SELECTED SESSION-BY-SESSION ANATOMICAL / PHYSIOLOGICAL EVIDENCE:
${sessionLines.length ? sessionLines.join("\n") : "- No session-level anatomical evidence available."}

${visualEvidence.text}
`;
}

function buildHeadToToeImageReviewContext({
  userProfile,
  sessions = [],
  bodyExplorations = [],
  hasFreshImages = false,
  hasReusedSavedImages = false,
}) {
  const visualEvidence = buildExistingVisualEvidenceDigest({ sessions, bodyExplorations });
  const qaEntries = normalizeProfileQaFindings(userProfile?.profile_qa_findings);
  const qaCards = buildProfileQaFindingCards(userProfile?.profile_qa_findings, userProfile?.first_name).slice(0, 36);
  const reusableProfileImages = collectSavedProfileImageAttachments(userProfile, { limit: 20, purpose: "head_to_toe_body_reference" });
  const compactMetrics = compactProfileJsonValue({
    age: userProfile?.age,
    sex: userProfile?.sex,
    height: userProfile?.height,
    weight: userProfile?.weight,
    fitness_level: userProfile?.fitness_level,
    profile_notes: userProfile?.profile_notes || userProfile?.notes,
    medical_context: userProfile?.medical_context,
    physiology_notes: userProfile?.physiology_notes,
  });

  return `
HEAD-TO-TOE BODY REFERENCE SOURCE CONTEXT:
- Fresh images attached in this run: ${hasFreshImages ? "yes" : "no"}.
- Saved Profile Q&A images reloaded in this run: ${hasReusedSavedImages ? "yes" : "no"}.
- Use fresh attached images, when present, as the primary source for directly visible whole-body anatomy, posture, habitus, alignment, skin/surface findings, and reference quality.
- If saved Profile Q&A images were reloaded, review them directly as saved/reused body-reference evidence. Do not act as if prior photos are absent.
- If no image payload is attached, use saved Profile Q&A visual findings and saved media-review digests as previously reviewed evidence. Do not reduce them to "nothing available."
- Saved profile metrics may provide limited context for age, height, weight, general fitness/body context, or known non-visual limitations, but they do not create visible findings.
- Existing reviewed visual evidence is allowed as evidence when it directly describes whole-body, torso, abdomen, posture, limb, foot, skin/surface, habitus, symmetry, or body-reference visibility.
- Do not mine saved evidence for a long pelvic, device-fit, urethral, stimulation, ejaculation, session chronology, or foot-arousal-history narrative in this head-to-toe artifact.
- If saved evidence is mostly pelvic, genital, device, foot-camera, or session-specific, keep that material brief and state the head-to-toe limits. If saved/reused images actually show body regions, assess those regions instead of saying no reference exists.
- Genital/pelvic findings may be mentioned only briefly as a visible body region when fresh head-to-toe/body-reference images show them. Detailed meatal, catheter, sound/dilator, Foley, urethral accommodation, genital measurement, device-fit, arousal-state, ejaculation, or stimulation-mechanics material belongs in the dedicated pelvic/genital review, not here.
- Foot and lower-limb observations should be anatomical reference observations only: resting posture, toe/foot alignment, symmetry, visible swelling/deformity, skin/surface findings, or image limitations. Do not turn session foot-camera motion history into arousal/climax physiology in this artifact.
- Avoid dates, session names, event sequences, device sizes, sensory maps, stimulation techniques, and previously reviewed close-up genital chronology unless they are needed to explain why a region cannot be assessed in the head-to-toe reference.
- Output priority: say what can be seen first. Do not spend the review cataloging absent regions unless that absence directly changes confidence or next-image planning.

REUSABLE SAVED PROFILE Q&A IMAGE ATTACHMENTS:
- Saved non-video Profile Q&A image attachments available for reuse: ${reusableProfileImages.length}.
${reusableProfileImages.length ? reusableProfileImages.slice(0, 12).map((image, index) => `- Reference view ${reviewImageLetter(index)}${image.saved_at ? ` saved ${formatGeneratedAt(image.saved_at)}` : ""}.`).join("\n") : "- None reusable from saved chat messages."}

SAVED PROFILE Q&A FINDINGS (${qaEntries.length} entries; showing up to ${qaCards.length} deduplicated findings):
${qaCards.length ? qaCards.map((card, index) => `${index + 1}. ${card.finding} (${card.sourceLabel}, ${card.timestamp})`).join("\n") : "- None saved."}

ENTERED GENERAL PROFILE CONTEXT:
${compactMetrics ? JSON.stringify(compactMetrics, null, 2) : "- None saved."}

EXISTING REVIEWED VISUAL EVIDENCE DIGEST:
- Session visual-review entries: ${visualEvidence.counts.session_visual_entries}.
- Session video-pass finding cards: ${visualEvidence.counts.session_video_passes}.
- Body exploration visual-review entries: ${visualEvidence.counts.body_exploration_visual_entries}.
- Body exploration video-pass finding cards: ${visualEvidence.counts.body_exploration_video_passes}.

${visualEvidence.text}
`;
}

function reviewImageLetter(index) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const safe = Math.max(0, Number(index) || 0);
  if (safe < alphabet.length) return alphabet[safe];
  return `${alphabet[safe % alphabet.length]}${Math.floor(safe / alphabet.length) + 1}`;
}

function buildImageReviewReferences(images = []) {
  return images.map((image, index) => ({
    image_id: image.image_id || `img_${String(index + 1).padStart(3, "0")}`,
    display_label: image.display_label || `Reference view ${reviewImageLetter(index)}`,
    source: image.source || "fresh_upload",
    preview_url: image.storagePath || image.file_url || image.url || "",
    media_type: image.media_type || "image/jpeg",
    upload_note: String(image.upload_note || "").trim(),
  }));
}

async function prepareFreshImageForReview(image, index, { onProgress, total = 0 } = {}) {
  let storagePath = image.storagePath || image.file_url || image.url || "";
  if (!storagePath && image.file) {
    onProgress?.({
      status: "preparing",
      progress: {
        phase: "saving_images",
        current: index + 1,
        total,
        message: `Saving reference image ${index + 1} for inline review...`,
      },
    });
    const upload = await base44.integrations.Core.UploadFile({ file: image.file });
    storagePath = upload?.file_url || upload?.url || "";
  }
  if (!storagePath) {
    throw new Error(`Could not save a reusable preview for ${image.filename || `reference image ${index + 1}`}.`);
  }
  return {
    ...image,
    filename: image.filename || `profile-reference-${index + 1}.jpg`,
    media_type: normalizeMediaType(image.media_type),
    data: image.data,
    storagePath,
    url: storagePath,
    previewUrl: image.previewUrl || storagePath,
    source: "fresh_upload",
    upload_note: String(image.upload_note || "").trim(),
  };
}

function buildImageReviewMeta(images = [], sessions = [], previousMeta = null, evidenceCounts = {}, generatedAtOverride = null, reviewedImageOverride = null, countOverrides = {}) {
  const freshImages = images.filter((image) => image.source !== "saved_profile_qa_attachment");
  const reusedImages = images.filter((image) => image.source === "saved_profile_qa_attachment");
  const reviewedImages = Array.isArray(reviewedImageOverride) && reviewedImageOverride.length
    ? reviewedImageOverride
    : buildImageReviewReferences(images);
  return {
    ...buildProfileAIContentMeta(sessions, previousMeta, generatedAtOverride),
    fresh_image_count: countOverrides.fresh_image_count ?? freshImages.length,
    reused_saved_image_count: countOverrides.reused_saved_image_count ?? reusedImages.length,
    image_count: countOverrides.image_count ?? (images.length || reviewedImages.length),
    image_filenames: images.map((image) => image.filename).filter(Boolean),
    reused_saved_image_filenames: reusedImages.map((image) => image.filename).filter(Boolean),
    reviewed_images: reviewedImages,
    source_kind: "profile_image_review",
    existing_visual_evidence_counts: evidenceCounts,
  };
}

function profileReviewResultSections(config) {
  return config.sections || [];
}

function isHeadToToeReviewConfig(config = {}) {
  return config.kind === "profile_head_to_toe_image_review";
}

function imageReviewReferencePromptLines(images = []) {
  const refs = buildImageReviewReferences(images);
  if (!refs.length) return "- No directly attached images in this run.";
  return refs.map((ref) => (
    `- ${ref.image_id}: ${ref.display_label}${ref.upload_note ? `. User note: ${briefText(ref.upload_note, 240)}` : ""}. Infer the anatomical view from the image content; do not use uploaded filenames, camera-roll numbers, or storage IDs in the user-facing review.`
  )).join("\n");
}

function profileImageReviewResponseSchema(config) {
  return {
    type: "object",
    properties: {
      overview: { type: "string" },
      summary_card: {
        type: "object",
        properties: {
          baseline_quality: { type: "string" },
          coverage: { type: "string" },
          primary_reference_value: { type: "array", items: { type: "string" } },
          key_direct_findings: { type: "array", items: { type: "string" } },
          key_limitations: { type: "array", items: { type: "string" } },
          evidence_note: { type: "string" },
        },
      },
      ...Object.fromEntries(profileReviewResultSections(config).map((section) => [section.key, { type: "array", items: { type: "string" } }])),
      annotated_images: {
        type: "array",
        items: {
          type: "object",
          properties: {
            image_id: { type: "string" },
            view_label: { type: "string" },
            body_position: { type: "string" },
            coverage: { type: "string" },
            visibility_notes: { type: "string" },
            major_regions_visible: { type: "array", items: { type: "string" } },
          },
          required: ["image_id", "view_label", "coverage", "visibility_notes"],
        },
      },
      image_region_findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            finding_id: { type: "string" },
            image_id: { type: "string" },
            section_key: { type: "string" },
            region: { type: "string" },
            label: { type: "string" },
            finding: { type: "string" },
            confidence: { type: "string" },
            visibility: { type: "string" },
            evidence_level: { type: "string" },
            limitations: { type: "array", items: { type: "string" } },
            pin: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
              },
            },
            box: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
              },
            },
          },
          required: ["finding_id", "image_id", "region", "label", "finding", "confidence"],
        },
      },
    },
    required: ["overview", ...profileReviewResultSections(config).filter((section) => section.required !== false).map((section) => section.key)],
  };
}

function compactImageReviewForSynthesis(result, index = 0) {
  const sections = [
    ...HEAD_TO_TOE_IMAGE_REVIEW_CONFIG.sections,
    ...PELVIC_GENITAL_IMAGE_REVIEW_CONFIG.sections,
  ];
  const compactList = (items = [], limit = 4, maxChars = 700) => (
    Array.isArray(items)
      ? items.slice(0, limit).map((item) => briefText(item, maxChars)).filter(Boolean)
      : []
  );
  const compactSummary = result?.summary_card && typeof result.summary_card === "object"
    ? {
      baseline_quality: briefText(result.summary_card.baseline_quality || "", 500),
      coverage: briefText(result.summary_card.coverage || "", 500),
      primary_reference_value: compactList(result.summary_card.primary_reference_value, 4, 420),
      key_direct_findings: compactList(result.summary_card.key_direct_findings, 6, 420),
      key_limitations: compactList(result.summary_card.key_limitations, 5, 360),
      evidence_note: briefText(result.summary_card.evidence_note || "", 500),
    }
    : null;
  return {
    batch: index + 1,
    overview: briefText(result?.overview || "", 900),
    summary_card: compactSummary,
    sections: Object.fromEntries(sections
      .filter((section) => Array.isArray(result?.[section.key]) && result[section.key].length)
      .map((section) => [section.key, compactList(result[section.key], 3, 650)])),
    annotated_images: Array.isArray(result?.annotated_images)
      ? result.annotated_images.slice(0, 20).map((image) => ({
        image_id: image.image_id,
        view_label: briefText(image.view_label || "", 180),
        body_position: briefText(image.body_position || "", 180),
        coverage: briefText(image.coverage || "", 260),
        visibility_notes: briefText(image.visibility_notes || "", 300),
        major_regions_visible: Array.isArray(image.major_regions_visible)
          ? image.major_regions_visible.slice(0, 8)
          : [],
      }))
      : [],
    image_region_findings: Array.isArray(result?.image_region_findings)
      ? result.image_region_findings.slice(0, 20).map((finding) => ({
        finding_id: finding.finding_id,
        image_id: finding.image_id,
        section_key: finding.section_key,
        region: briefText(finding.region || "", 120),
        label: briefText(finding.label || "", 180),
        finding: briefText(finding.finding || "", 520),
        confidence: finding.confidence,
        visibility: briefText(finding.visibility || "", 120),
        evidence_level: briefText(finding.evidence_level || "", 160),
        limitations: compactList(finding.limitations, 3, 180),
        pin: finding.pin,
        box: finding.box,
      }))
      : [],
  };
}

function mergeImageReviewBatchArtifacts(synthesizedResult, batchResults = []) {
  const result = synthesizedResult || {};
  const batchAnnotated = batchResults.flatMap((item) => Array.isArray(item?.annotated_images) ? item.annotated_images : []);
  const batchFindings = batchResults.flatMap((item) => Array.isArray(item?.image_region_findings) ? item.image_region_findings : []);
  return {
    ...result,
    annotated_images: result.annotated_images?.length ? result.annotated_images : batchAnnotated,
    image_region_findings: result.image_region_findings?.length ? result.image_region_findings : batchFindings,
  };
}

function isLowValueAbsentRegionParagraph(value = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return true;
  const lower = text.toLowerCase();
  const isPositiveAbsence =
    /\bno\s+(?:obvious|visible|apparent)\s+(?:lesions?|fissur|rash|bruis|swelling|asymmetry|deformity|irritation|discoloration|tissue stress|catheter|foley|device|mass|edema|hernia bulge)/i.test(text) ||
    /\bappears\s+(?:healthy|symmetric|broadly uniform|normal)\b/i.test(text);
  if (isPositiveAbsence) return false;
  const absenceLanguage = /\b(?:not visible|not assessable|cannot be assessed|cannot be fully assessed|deferred to|not available|not present in this batch|not provided in this batch|not included in this batch|no .*views? (?:are|is) present|missing .*views?|major limitation|must be deferred)\b/i.test(text);
  if (!absenceLanguage) return false;
  const usefulVisibleClaim = /\b(?:is visible|are visible|appears|show|shows|clearly visible|consistent with|scattered|level|symmetric|flat on floor|projects|flaccid|foreskin|raphe|perineal|scrot|abdomen|feet|shoulders|spine|skin)\b/i.test(text);
  const absentRegionInventory = /\b(?:head|neck|thorax|chest|upper limb|lower limb|lower leg|feet|foot|toe|torso|shoulder|spine|whole-body|standing|full-limb|skin surface findings|musculoskeletal|posture|alignment|body habitus)\b/i.test(text);
  return absentRegionInventory && !usefulVisibleClaim;
}

function uniqueReviewItems(items = [], limit = 14, maxChars = 900, batchSet = null) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const text = cleanImageReviewProse(batchSet ? sanitizeRecoveredBatchScopeText(item, batchSet) : item);
    if (!text || /^batch\s+\d+\s+of\s+\d+/i.test(text) || /^this is batch\s+\d+/i.test(text)) continue;
    if (/\bthis\s+batch\s+does\s+not\s+include\b/i.test(String(item || ""))) continue;
    if (/\bthis\s+image\s+set\s+does\s+not\s+include\b/i.test(String(item || ""))) continue;
    if (/\b(?:these|the)\s+images?\s+(?:have|has)\s+not\s+been\s+(?:provided|included|attached)\s+in\s+this\s+batch\b/i.test(text)) continue;
    if (/\b(?:not\s+provided|not\s+included|not\s+attached)\s+in\s+this\s+batch\b/i.test(text)) continue;
    if (isLowValueAbsentRegionParagraph(text)) continue;
    const key = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 180);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(briefText(text, maxChars));
    if (out.length >= limit) break;
  }
  return out;
}

function buildBatchAssembledImageReview(config, batchResults = [], batchSet = {}) {
  const sections = profileReviewResultSections(config);
  const directFindings = uniqueReviewItems(batchResults.flatMap((item) => item?.summary_card?.key_direct_findings || []), 10, 520, batchSet);
  const referenceValue = uniqueReviewItems(batchResults.flatMap((item) => item?.summary_card?.primary_reference_value || []), 8, 460, batchSet);
  const limitations = uniqueReviewItems(batchResults.flatMap((item) => item?.summary_card?.key_limitations || []), 4, 360, batchSet);
  const coverage = uniqueReviewItems(batchResults.map((item) => item?.summary_card?.coverage || item?.overview), 4, 520, batchSet).join(" ");
  const headToToe = isHeadToToeReviewConfig(config);
  const annotatedByKey = new Map();
  for (const image of batchResults.flatMap((item) => Array.isArray(item?.annotated_images) ? item.annotated_images : [])) {
    const key = image?.image_id || `${image?.view_label || ""}-${annotatedByKey.size}`;
    if (!annotatedByKey.has(key)) annotatedByKey.set(key, sanitizeImagePositionClaims(image));
  }
  const findingsByKey = new Map();
  for (const finding of batchResults.flatMap((item) => Array.isArray(item?.image_region_findings) ? item.image_region_findings : [])) {
    const key = finding?.finding_id || `${finding?.image_id || ""}-${finding?.label || ""}-${findingsByKey.size}`;
    if (!findingsByKey.has(key)) findingsByKey.set(key, sanitizeImageRegionFinding(finding));
  }

  const result = {
    overview: headToToe
      ? "Cumulative head-to-toe anatomy review integrating the available full-body, regional, pelvic, and saved profile photo evidence into one body-centered summary."
      : `${config.shortTitle} visible anatomy review.`,
    summary_card: {
      baseline_quality: headToToe ? "" : uniqueReviewItems(batchResults.map((item) => item?.summary_card?.baseline_quality), 2, 420, batchSet).join(" ") || "Recovered from completed Sarah image-review batches.",
      coverage: headToToe ? "" : coverage || `${batchSet.image_count || batchSet.reviewed_images?.length || "Multiple"} saved/direct profile-reference views were reviewed across completed batches.`,
      primary_reference_value: headToToe ? [] : referenceValue,
      key_direct_findings: directFindings,
      key_limitations: headToToe ? [] : limitations,
      evidence_note: "",
    },
    annotated_images: Array.from(annotatedByKey.values()),
    image_region_findings: Array.from(findingsByKey.values()),
  };

  for (const section of sections) {
    const sectionLimit = /missing|optional|request|limit/i.test(section.key) ? 5 : 14;
    const sourceKeys = headToToe
      ? {
        pelvic_genital_perineal_anatomy: ["pelvic_genital_perineal_anatomy", "region_specific_anatomical_findings"],
        missing_items_optional_image_requests: ["missing_items_optional_image_requests", "suggested_next_reference_images"],
      }[section.key] || [section.key]
      : [section.key];
    const rawSectionItems = batchResults.flatMap((item) => sourceKeys.flatMap((key) => Array.isArray(item?.[key]) ? item[key] : []));
    const items = uniqueReviewItems(rawSectionItems, sectionLimit, 950, batchSet);
    if (headToToe && !items.length) {
      result[section.key] = [];
      continue;
    }
    result[section.key] = items.length
      ? items
      : [/missing|optional|request|limit/i.test(section.key)
        ? "No additional material limitation was preserved from the completed batch findings beyond the confidence notes already attached to specific observations."
        : `No distinct recovered batch paragraph was available for ${section.label.toLowerCase()}; see the visible findings and annotated image callouts.`];
  }
  const scopedResult = sanitizeRecoveredBatchResult(result, batchSet);
  return normalizeImageReviewResult(scopedResult) || scopedResult;
}

function confidenceLabel(value = "") {
  const text = String(value || "").replace(/_/g, " ").trim();
  return text || "uncertain";
}

function sectionLabelForKey(sections = [], key = "") {
  return sections.find((section) => section.key === key)?.label || String(key || "").replace(/_/g, " ");
}

function useContainedImageRect() {
  const containerRef = useRef(null);
  const [naturalSize, setNaturalSize] = useState(null);
  const [containerSize, setContainerSize] = useState(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;
    const updateSize = () => {
      const rect = node.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const getRect = (fitMode = "contain") => {
    const cw = containerSize?.width || 0;
    const ch = containerSize?.height || 0;
    const nw = naturalSize?.width || 0;
    const nh = naturalSize?.height || 0;
    if (!cw || !ch || !nw || !nh) return null;
    const scale = fitMode === "cover"
      ? Math.max(cw / nw, ch / nh)
      : Math.min(cw / nw, ch / nh);
    const width = nw * scale;
    const height = nh * scale;
    return {
      left: (cw - width) / 2,
      top: (ch - height) / 2,
      width,
      height,
    };
  };

  return { containerRef, getRect, setNaturalSize };
}

function imagePointStyle(rect, pin) {
  if (!rect || pin?.x == null || pin?.y == null) return { left: `${pin?.x || 0}%`, top: `${pin?.y || 0}%` };
  const x = rect.left + (Number(pin.x) / 100) * rect.width;
  const y = rect.top + (Number(pin.y) / 100) * rect.height;
  const markerRadius = 12;
  return {
    left: `${Math.max(markerRadius, Math.min(rect.left + rect.width - markerRadius, x))}px`,
    top: `${Math.max(markerRadius, Math.min(rect.top + rect.height - markerRadius, y))}px`,
  };
}

function imageBoxStyle(rect, box) {
  if (!rect || !box) {
    return {
      left: `${box?.x || 0}%`,
      top: `${box?.y || 0}%`,
      width: `${box?.width || 0}%`,
      height: `${box?.height || 0}%`,
    };
  }
  return {
    left: `${rect.left + (Number(box.x) / 100) * rect.width}px`,
    top: `${rect.top + (Number(box.y) / 100) * rect.height}px`,
    width: `${(Number(box.width) / 100) * rect.width}px`,
    height: `${(Number(box.height) / 100) * rect.height}px`,
  };
}

function AnnotatedImageStage({
  image,
  pinnedFindings = [],
  boxedFindings = [],
  unavailableText = "Image preview is not available for this saved run.",
  className = "relative aspect-[4/3] bg-black",
  imageClassName = "",
  fitMode = "contain",
  onClick = null,
}) {
  const { containerRef, getRect, setNaturalSize } = useContainedImageRect();
  const rect = getRect(fitMode);
  const imageUrl = image?.preview_url ? serverUrl(image.preview_url) : "";

  return (
    <div
      ref={containerRef}
      className={`${className} ${onClick ? "cursor-zoom-in" : ""}`}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      } : undefined}
      onKeyDown={onClick ? (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onClick();
      } : undefined}
      title={onClick ? "Open annotated image viewer" : undefined}
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={image.display_label || "Reviewed anatomy reference"}
          className={`absolute ${imageClassName}`}
          style={rect ? {
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          } : { inset: 0, width: "100%", height: "100%" }}
          loading="lazy"
          onLoad={(event) => {
            const img = event.currentTarget;
            setNaturalSize({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
          }}
        />
      ) : (
        <div className="flex h-full min-h-36 items-center justify-center px-4 text-center text-sm leading-relaxed text-foreground/85 dark:text-white/85">
          {unavailableText}
        </div>
      )}
      {pinnedFindings.map((finding, index) => (
        <div
          key={`${finding.finding_id}-pin`}
          className="absolute z-10 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/80 bg-primary text-[10px] font-bold text-primary-foreground shadow-lg"
          style={imagePointStyle(rect, finding.pin)}
          title={finding.label}
        >
          {index + 1}
        </div>
      ))}
      {boxedFindings.map((finding) => (
        <div
          key={`${finding.finding_id}-box`}
          className="absolute z-10 rounded border-2 border-primary/80 bg-primary/10"
          style={imageBoxStyle(rect, finding.box)}
          title={finding.label}
        />
      ))}
    </div>
  );
}

function ProfileImageSummaryCard({ summary, color = "hsl(var(--primary))", lean = false }) {
  if (!summary || typeof summary !== "object") return null;
  const direct = Array.isArray(summary.key_direct_findings) ? summary.key_direct_findings.filter(Boolean) : [];
  const reference = lean ? [] : Array.isArray(summary.primary_reference_value) ? summary.primary_reference_value.filter(Boolean) : [];
  const limitations = lean ? [] : Array.isArray(summary.key_limitations) ? summary.key_limitations.filter(Boolean) : [];
  const coverage = lean ? "" : summary.coverage;
  const evidenceNote = lean ? "" : summary.evidence_note;
  const baselineQuality = lean ? "" : summary.baseline_quality;
  if (!baselineQuality && !coverage && !direct.length && !reference.length && !limitations.length && !evidenceNote) return null;
  return (
    <div className="rounded-xl border border-border bg-card/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color }}>{lean ? "Key Visible Findings" : "Evidence Summary"}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {lean ? "Trimmed to the visible anatomy findings that matter for this review." : "Direct visual findings are kept separate from saved profile context and interpretation."}
          </p>
        </div>
        {baselineQuality && (
          <Badge variant="outline" className="text-[10px]">{baselineQuality}</Badge>
        )}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {coverage && (
          <div className="rounded-lg border border-border bg-background/60 p-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Coverage</p>
            <p className="mt-1 text-xs leading-relaxed text-foreground">{coverage}</p>
          </div>
        )}
        {evidenceNote && (
          <div className="rounded-lg border border-border bg-background/60 p-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Evidence Note</p>
            <p className="mt-1 text-xs leading-relaxed text-foreground">{evidenceNote}</p>
          </div>
        )}
      </div>
      {[["Primary reference value", reference], ["Key direct findings", direct], ["Key limitations", limitations]].map(([label, values]) => (
        values.length ? (
          <div key={label} className="mt-2 rounded-lg border border-border bg-background/60 p-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {values.slice(0, 8).map((item) => (
                <span key={item} className="rounded-full border border-border bg-muted/20 px-2 py-1 text-[11px] text-foreground/90">
                  {item}
                </span>
              ))}
            </div>
          </div>
        ) : null
      ))}
    </div>
  );
}

function profileImageById(result, imageId, transientImages = []) {
  const reviewed = Array.isArray(result?._meta?.reviewed_images) ? result._meta.reviewed_images : [];
  const annotated = Array.isArray(result?.annotated_images) ? result.annotated_images : [];
  const transient = transientImages.map((image, index) => ({
    image_id: image.image_id || `img_${String(index + 1).padStart(3, "0")}`,
    preview_url: image.previewUrl || "",
    display_label: image.display_label || `Reference view ${reviewImageLetter(index)}`,
  }));
  const image = reviewed.find((item) => item.image_id === imageId) || {};
  const annotation = annotated.find((item) => item.image_id === imageId) || {};
  const transientImage = transient.find((item) => item.image_id === imageId) || {};
  const previewUrl = image.preview_url || transientImage.preview_url || annotation.preview_url || "";
  return {
    ...transientImage,
    ...annotation,
    ...image,
    preview_url: previewUrl,
    display_label: annotation.view_label || image.display_label || transientImage.display_label || "Reviewed view",
    body_position: annotation.body_position || image.body_position || transientImage.body_position || "",
    coverage: annotation.coverage || image.coverage || transientImage.coverage || "",
    visibility_notes: annotation.visibility_notes || image.visibility_notes || transientImage.visibility_notes || "",
    major_regions_visible: annotation.major_regions_visible || image.major_regions_visible || transientImage.major_regions_visible || [],
  };
}

function ImageAnnotationBoard({ result, sections = [], color = "hsl(var(--primary))", transientImages = [] }) {
  const findings = Array.isArray(result?.image_region_findings) ? result.image_region_findings : [];
  const annotated = Array.isArray(result?.annotated_images) ? result.annotated_images : [];
  const reviewed = Array.isArray(result?._meta?.reviewed_images) ? result._meta.reviewed_images : [];
  const imageIds = [...new Set([
    ...reviewed.map((image) => image.image_id).filter(Boolean),
    ...annotated.map((image) => image.image_id).filter(Boolean),
    ...findings.map((finding) => finding.image_id).filter(Boolean),
  ])];

  if (!imageIds.length && !findings.length) return null;

  return (
    <div className="rounded-xl border border-border bg-muted/10 p-3 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider" style={{ color }}>
            <ImageIcon className="h-3.5 w-3.5" /> Annotated Anatomy Reference
          </h4>
          <p className="mt-1 text-sm leading-relaxed text-foreground/85 dark:text-white/85">
            Sarah-linked body-region findings. Pins are approximate visual anchors, not measurement-grade anatomy marks.
          </p>
        </div>
        <Badge variant="outline" className="text-[10px]">{findings.length} region finding{findings.length === 1 ? "" : "s"}</Badge>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {imageIds.map((imageId) => {
          const image = profileImageById(result, imageId, transientImages);
          const imageFindings = findings.filter((finding) => finding.image_id === imageId);
          const pinnedFindings = imageFindings.filter((finding) => finding.pin?.x != null && finding.pin?.y != null);
          const boxedFindings = imageFindings.filter((finding) => finding.box);
          return (
            <div key={imageId} className="overflow-hidden rounded-lg border border-border bg-card/80">
              <AnnotatedImageStage
                image={image}
                pinnedFindings={pinnedFindings}
                boxedFindings={boxedFindings}
                unavailableText="Image preview is not available for this saved run. Re-run with saved or fresh images to attach view previews."
                className="relative h-72 min-h-72 overflow-hidden bg-black sm:h-80 lg:aspect-[4/3] lg:h-auto lg:min-h-0"
                fitMode="cover"
              />
              <div className="space-y-2 p-3">
                <div>
                  <p className="text-base font-semibold leading-snug text-foreground dark:text-white">{image.display_label || "Reviewed view"}</p>
                  {(image.body_position || image.coverage || image.visibility_notes) && (
                    <p className="mt-2 text-sm leading-relaxed text-foreground/90 dark:text-white/90">
                      {[image.body_position, image.coverage, image.visibility_notes].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  {Array.isArray(image.major_regions_visible) && image.major_regions_visible.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {image.major_regions_visible.slice(0, 8).map((region) => (
                        <Badge key={region} variant="secondary" className="text-[10px]">{region}</Badge>
                      ))}
                    </div>
                  )}
                </div>
                {imageFindings.length > 0 ? (
                  <div className="space-y-2">
                    {imageFindings.map((finding, index) => (
                      <div key={finding.finding_id} className="rounded-lg border border-border bg-background/70 p-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {finding.pin && (
                            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
                              {index + 1}
                            </span>
                          )}
                          <span className="text-base font-semibold leading-snug text-foreground dark:text-white">{finding.label || finding.region || "Visible finding"}</span>
                          <Badge variant="outline" className="h-5 text-[10px]">{confidenceLabel(finding.confidence)}</Badge>
                          {finding.evidence_level && (
                            <Badge variant="secondary" className="h-5 text-[10px]">{confidenceLabel(finding.evidence_level)}</Badge>
                          )}
                          {finding.section_key && (
                            <Badge variant="secondary" className="h-5 text-[10px]">{sectionLabelForKey(sections, finding.section_key)}</Badge>
                          )}
                        </div>
                        {finding.finding && (
                          <p className="mt-2 text-[0.95rem] leading-relaxed text-foreground/90 dark:text-white/90">{finding.finding}</p>
                        )}
                        {finding.limitations?.length > 0 && (
                          <p className="mt-2 text-sm leading-relaxed text-foreground/80 dark:text-white/80">
                            Limits: {finding.limitations.join("; ")}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm leading-relaxed text-foreground/85 dark:text-white/85">No region-specific callouts were returned for this view.</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FindingCorrectionControl({ finding, onCorrectFinding, onRemoveFinding }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const correction = finding?.user_correction;
  const correctedText = correction?.text || "";

  const save = async (event) => {
    event?.preventDefault();
    event?.stopPropagation();
    const trimmed = text.trim();
    if (!trimmed || !onCorrectFinding) return;
    setSaving(true);
    setError("");
    try {
      await onCorrectFinding(finding, trimmed);
      setText("");
      setOpen(false);
    } catch (err) {
      setError(err?.message || "Could not save this clarification.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (event) => {
    event?.preventDefault();
    event?.stopPropagation();
    if (!onRemoveFinding) return;
    const ok = window.confirm("Remove this incorrect callout from the review?");
    if (!ok) return;
    setRemoving(true);
    setError("");
    try {
      await onRemoveFinding(finding);
    } catch (err) {
      setError(err?.message || "Could not remove this callout.");
      setRemoving(false);
    }
  };

  return (
    <div className="mt-2 rounded-md border border-border bg-background/60 p-2">
      {correctedText && (
        <p className="text-xs leading-relaxed text-emerald-200">
          <span className="font-semibold text-emerald-300">User clarification:</span> {correctedText}
        </p>
      )}
      {open ? (
        <div className="mt-2 space-y-2" onClick={(event) => event.stopPropagation()}>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={2}
            placeholder='Example: This is a shadow, not a device.'
            className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs leading-relaxed text-foreground outline-none focus:border-primary"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" className="h-7 text-xs" onClick={save} disabled={saving || !text.trim()}>
              {saving ? "Saving..." : "Save clarification"}
            </Button>
            <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              setError("");
            }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
              setText(correctedText || "");
            }}
          >
            {correctedText ? "Edit clarification" : "Clarify / correct"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 border-destructive/40 text-xs text-destructive hover:bg-destructive/10"
            onClick={remove}
            disabled={removing}
          >
            {removing ? "Removing..." : "Remove callout"}
          </Button>
        </div>
      )}
    </div>
  );
}

function imageDisplayNumber(imageId = "") {
  const match = String(imageId || "").match(/^img[_-]?0*(\d+)$/i);
  return match ? `image ${Number(match[1])}` : "image";
}

function ProfileImageLightbox({
  result,
  imageIds = [],
  selectedImageId,
  onSelectImageId,
  onClose,
  sections = [],
  color = "hsl(var(--primary))",
  transientImages = [],
  onCorrectFinding = null,
  onRemoveFinding = null,
}) {
  const findings = Array.isArray(result?.image_region_findings) ? result.image_region_findings : [];
  const selectedIndex = Math.max(0, imageIds.indexOf(selectedImageId));
  const imageId = imageIds[selectedIndex] || selectedImageId;
  const image = profileImageById(result, imageId, transientImages);
  const imageFindings = findings.filter((finding) => finding.image_id === imageId);
  const pinnedFindings = imageFindings.filter((finding) => finding.pin?.x != null && finding.pin?.y != null);
  const boxedFindings = imageFindings.filter((finding) => finding.box);
  const hasPrev = selectedIndex > 0;
  const hasNext = selectedIndex >= 0 && selectedIndex < imageIds.length - 1;
  const goPrev = () => {
    if (!imageIds.length) return;
    const nextIndex = hasPrev ? selectedIndex - 1 : imageIds.length - 1;
    onSelectImageId?.(imageIds[nextIndex]);
  };
  const goNext = () => {
    if (!imageIds.length) return;
    const nextIndex = hasNext ? selectedIndex + 1 : 0;
    onSelectImageId?.(imageIds[nextIndex]);
  };

  useEffect(() => {
    if (!selectedImageId) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose?.();
      if (event.key === "ArrowLeft") goPrev();
      if (event.key === "ArrowRight") goNext();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedImageId, selectedIndex, imageIds.join("|")]);

  if (!selectedImageId || !imageId) return null;

  return (
    <div className="fixed inset-0 z-[120] bg-background/95 backdrop-blur-sm">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-card/90 px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color }}>
              Annotated Image Viewer
            </p>
            <p className="truncate text-sm font-semibold text-foreground">
              {imageDisplayNumber(imageId)}{image.display_label ? ` - ${image.display_label}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant="outline" className="h-6 text-[10px]">
              {selectedIndex + 1}/{imageIds.length}
            </Badge>
            <Button type="button" size="sm" variant="outline" onClick={goPrev} className="h-8 w-8 p-0" title="Previous image">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={goNext} className="h-8 w-8 p-0" title="Next image">
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onClose} className="h-8 w-8 p-0" title="Close viewer">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
          <div className="min-h-[58vh] rounded-lg border border-border bg-black lg:min-h-0">
            <AnnotatedImageStage
              image={image}
              pinnedFindings={pinnedFindings}
              boxedFindings={boxedFindings}
              unavailableText="Image preview unavailable for this saved run."
              className="relative h-[62vh] min-h-[360px] bg-black lg:h-full"
            />
          </div>

          <div className="min-h-0 space-y-3 overflow-y-auto rounded-lg border border-border bg-card/90 p-3">
            <div>
              <p className="text-base font-semibold leading-snug text-foreground">{image.display_label || "Reviewed view"}</p>
              {(image.body_position || image.coverage || image.visibility_notes) && (
                <p className="mt-2 text-sm leading-relaxed text-foreground/85">
                  {[image.body_position, image.coverage, image.visibility_notes].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className="text-[10px]">{imageFindings.length} linked note{imageFindings.length === 1 ? "" : "s"}</Badge>
              <Badge variant="secondary" className="text-[10px]">{pinnedFindings.length} pin{pinnedFindings.length === 1 ? "" : "s"}</Badge>
              {boxedFindings.length > 0 && <Badge variant="secondary" className="text-[10px]">{boxedFindings.length} box{boxedFindings.length === 1 ? "" : "es"}</Badge>}
            </div>

            {imageFindings.length ? (
              <div className="space-y-2">
                {imageFindings.map((finding) => {
                  const markerIndex = pinnedFindings.findIndex((item) => item.finding_id === finding.finding_id);
                  return (
                    <div key={`${finding.finding_id}-lightbox`} className="rounded-lg border border-border bg-background/70 p-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {markerIndex >= 0 && (
                          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
                            {markerIndex + 1}
                          </span>
                        )}
                        <span className="text-sm font-semibold leading-snug text-foreground">{finding.label || finding.region || "Visible finding"}</span>
                        <Badge variant="outline" className="h-5 text-[10px]">{confidenceLabel(finding.confidence)}</Badge>
                        {finding.section_key && (
                          <Badge variant="secondary" className="h-5 text-[10px]">{sectionLabelForKey(sections, finding.section_key)}</Badge>
                        )}
                      </div>
                      {finding.finding && (
                        <p className="mt-2 text-sm leading-relaxed text-foreground/90">{finding.finding}</p>
                      )}
                      {finding.limitations?.length > 0 && (
                        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                          Limits: {finding.limitations.join("; ")}
                        </p>
                      )}
                      <FindingCorrectionControl finding={finding} onCorrectFinding={onCorrectFinding} onRemoveFinding={onRemoveFinding} />
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="rounded-lg border border-border bg-background/70 p-3 text-sm text-muted-foreground">
                No linked notes were returned for this view.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function InlineImageEvidence({ result, sectionKey, sections = [], color = "hsl(var(--primary))", transientImages = [], onOpenImage = null, onCorrectFinding = null, onRemoveFinding = null }) {
  const findings = Array.isArray(result?.image_region_findings)
    ? result.image_region_findings.filter((finding) => finding.section_key === sectionKey)
    : [];
  if (!findings.length) return null;

  const imageIds = [...new Set(findings.map((finding) => finding.image_id).filter(Boolean))].slice(0, 3);
  const sectionLabel = sectionLabelForKey(sections, sectionKey);

  return (
    <div className="my-2 rounded-xl border border-border bg-card/70 p-2.5 sm:p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider" style={{ color }}>
          <ImageIcon className="h-3.5 w-3.5" /> Visual reference for {sectionLabel}
        </p>
        <Badge variant="outline" className="h-5 text-[10px]">{findings.length} callout{findings.length === 1 ? "" : "s"}</Badge>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {imageIds.map((imageId) => {
          const image = profileImageById(result, imageId, transientImages);
          const imageFindings = findings.filter((finding) => finding.image_id === imageId).slice(0, 4);
          const pinnedFindings = imageFindings.filter((finding) => finding.pin?.x != null && finding.pin?.y != null);
          return (
            <div key={`${sectionKey}-${imageId}`} className="overflow-hidden rounded-lg border border-border bg-background/70">
              <div className="grid gap-2 xl:grid-cols-[minmax(260px,0.95fr)_1fr]">
                <AnnotatedImageStage
                  image={image}
                  pinnedFindings={pinnedFindings}
                  unavailableText="Image preview unavailable for this saved run."
                  className="relative h-64 min-h-64 overflow-hidden bg-black sm:h-72 xl:h-full xl:min-h-full"
                  fitMode="cover"
                  onClick={onOpenImage ? () => onOpenImage(imageId) : null}
                />
                <div className="space-y-2 p-2.5">
                  <div>
                    <p className="text-base font-semibold leading-snug text-foreground dark:text-white">{image.display_label || "Reviewed view"}</p>
                    {(image.body_position || image.coverage || image.visibility_notes) && (
                      <p className="mt-2 text-sm leading-relaxed text-foreground/90 dark:text-white/90">
                        {[image.body_position, image.coverage, image.visibility_notes].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    {imageFindings.map((finding, index) => (
                      <div key={`${finding.finding_id}-inline`} className="rounded-md border border-border bg-muted/20 p-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {finding.pin && (
                            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
                              {index + 1}
                            </span>
                          )}
                      <span className="text-base font-semibold leading-snug text-foreground dark:text-white">{finding.label || finding.region || "Visible finding"}</span>
                      <Badge variant="outline" className="h-5 text-[10px]">{confidenceLabel(finding.confidence)}</Badge>
                      {finding.evidence_level && (
                        <Badge variant="secondary" className="h-5 text-[10px]">{confidenceLabel(finding.evidence_level)}</Badge>
                      )}
                    </div>
                        {finding.finding && (
                          <p className="mt-2 text-[0.95rem] leading-relaxed text-foreground/90 dark:text-white/90">{finding.finding}</p>
                        )}
                        <FindingCorrectionControl finding={finding} onCorrectFinding={onCorrectFinding} onRemoveFinding={onRemoveFinding} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function imageCalloutNarrationParagraphs(result, sectionKey, transientImages = []) {
  const findings = Array.isArray(result?.image_region_findings)
    ? result.image_region_findings.filter((finding) => finding.section_key === sectionKey)
    : [];
  if (!findings.length) return [];

  const byImage = new Map();
  for (const finding of findings) {
    const imageId = finding.image_id || "unknown";
    if (!byImage.has(imageId)) byImage.set(imageId, []);
    byImage.get(imageId).push(finding);
  }

  const paragraphs = [];
  for (const [imageId, imageFindings] of byImage.entries()) {
    const image = profileImageById(result, imageId, transientImages);
    const imageContext = image?.display_label || image?.view_label || "Reviewed view";
    const callouts = imageFindings.slice(0, 4).map((finding, index) => {
      const label = finding.label || finding.region || `Callout ${index + 1}`;
      const confidence = confidenceLabel(finding.confidence);
      const qualifier = /possible|uncertain|low/i.test(confidence) ? `${confidence}. ` : "";
      return `${index + 1}. ${label}. ${qualifier}${finding.finding || ""}`.trim();
    }).filter(Boolean);
    if (callouts.length) {
      paragraphs.push(cleanImageReviewProse(naturalizeSpokenDates(`${imageContext}. ${callouts.join(" ")}`)));
    }
  }
  return paragraphs;
}

const HEAD_TO_TOE_IMAGE_REVIEW_CONFIG = {
  title: "Head-to-Toe Image Review",
  shortTitle: "Head-to-Toe",
  kind: "profile_head_to_toe_image_review",
  resultKey: "head_to_toe_image_review_result",
  archiveKey: "head_to_toe_image_review_archive",
  ttsSessionId: "profile-head-to-toe-image-review",
  contextScope: "head_to_toe_body_reference",
  maxImages: 20,
  icon: <ImageIcon className="w-4 h-4" />,
  color: "hsl(var(--chart-4))",
  purpose: "Whole-body anatomical reference review in anatomical position, standing, prone, supine, seated, or supported positioning.",
  helper: "Review saved whole-body/profile evidence from Q&A, sessions, body exploration, entered metrics, and prior Sarah media reviews. Fresh images are optional add-on evidence for posture, alignment, body habitus, skin/surface findings, body symmetry, and reference quality.",
  emptyText: "Review Existing Evidence uses saved profile/body-reference findings first. Add anatomical-position/body-reference images only when you want to expand the reference set; pelvic/session-specific evidence will stay limited here.",
  reviewInstructions: `
HEAD-TO-TOE REVIEW SCOPE:
- Produce one cumulative, body-centered head-to-toe anatomy review. The output should read like the final useful review, not a process note.
- Make the review easy to listen to as downloaded audio: top-to-bottom flow, minimal repetition, short clear paragraphs, and no duplicate callout/prose narration.
- Prioritize what is visible. Do not narrate every absent or limited body region. Put genuinely useful missing-image requests only at the end.
- Include pelvic, genital, perineal, anal/perianal, pubic/inguinal, and lower abdominal anatomy when those findings are supported by saved or attached profile photo evidence.
- Use all available saved visual evidence as first-class evidence: direct uploads in this run, reusable saved Profile Q&A image attachments, saved Profile Q&A visual findings, prior Sarah visual reviews, session/body-exploration visual evidence, and entered profile metrics where they help reconcile visible findings.
- Never write "these images have not been provided in this batch", "not visible in this batch", "deferred to another batch", or equivalent batch-amnesia wording. If a body region has prior saved visual evidence, use that evidence. If a region truly has no evidence anywhere in the cumulative profile, mention it only at the very end as an optional image request.
- Do not write provenance, batch, timeout, recovery, payment, cloud request, "assembled from", or "this batch" language in the user-facing review.
- Do not make Image Set Overview, Reference Value for PulsePoint, or Limitations the main output. Omit process sections entirely. Mention missing coverage only at the very end under optional image requests.
- Preserve anatomical detail, posture discussion, habitus description, body symmetry assessment, musculoskeletal observations, skin/surface findings, and pelvic anatomy.
- Use the environment only as brief context for lighting quality, camera angle, image completeness, visibility limitations, posture/reference setup, or support surfaces that directly affect body position.
- Do not write a room inventory. Do not identify, speculate about, or side-investigate incidental objects, pocket contents, phone outlines, equipment, screen details, clutter, waistband shapes, or holster/device prints unless they directly affect body visibility, positioning, safety of interpretation, image quality, or frame/reference context.
- If an incidental object is visible but not clinically/image-review relevant, ignore it.
- Keep the language clinical, neutral, practical, and anatomically literate. Adult anatomy and nudity are in scope when present, but the review must not become erotic or moralizing.
- Separate visible findings from interpretation. Do not infer psychology, arousal, pain, function, dominance, intent, or session state from static posture alone.
- If nudity or genital anatomy is visible, describe only clinically relevant visibility, position, symmetry, skin/surface findings, resting state, and limitations. Use cautious terms such as flaccid, partial erection, erection, obscured, or uncertain only when visually assessable.
- Do not use this head-to-toe review to summarize catheter, urethral, sound/dilator, Foley, sleeve, stimulation, ejaculation, arousal progression, foot-camera arousal recruitment, device-fit, or genital measurement history. Those belong in the pelvic/genital or session analysis artifacts.
- If fresh images are absent, still use saved profile/body-reference image evidence and saved Q&A visual findings. Do not imply the profile has no images when saved images or reviewed findings exist.
- Compare visible whole-body findings against saved Q&A findings, prior sessions, and entered metrics only where they help reconcile body reference evidence. Do not let profile context override fresh image evidence.
- Organize the output using these body-centered sections:
  1. Coverage Map: one concise top-to-bottom map of what is covered well, partially covered, newly improved, and what remains useful to photograph. Do not include source/provenance mechanics.
  2. Significant Findings: the most meaningful new, changed, or high-value stable findings. Use "stable baseline finding" for unchanged repeated anatomy.
  3. Overall Body Overview: general frame/build, proportionality, visible muscularity, adipose distribution, broad symmetry, and stance/positioning that can actually be seen.
  4. Posture & Alignment: visible head/neck, shoulder height, thoracic/lumbar contour, pelvic posture if visible, knee/ankle alignment, foot angle/stance, and anterior/posterior/lateral differences.
  5. Body Habitus & Soft Tissue: torso contour, abdominal contour, chest/upper-body contour if visible, limb soft tissue distribution, muscular definition, central versus peripheral adipose distribution where visible.
  6. Skin & Surface Findings: consolidated visible skin findings and meaningful changes only. Summarize stable repeated papules once by distribution. Do not invent skin findings.
  7. Musculoskeletal / Limb Findings: upper limbs, forearms/hands, thighs/lower legs, feet/toes, symmetry, muscle bulk, joint alignment, swelling/deformity, resting foot/toe posture, and functional implications only when directly supported by visible evidence.
  8. Pelvic, Genital & Perineal Anatomy: brief head-to-toe-level pelvic visibility summary only. Do not repeat the detailed pelvic/genital review.
  9. Region-Specific Head-to-Toe Findings: head/neck, shoulders/upper back, chest/torso, abdomen, pelvis, upper limbs/hands, lower limbs/feet in anatomical order. Keep it concise and visible-finding centered.
  10. Missing Items / Optional Image Requests: only the useful remaining photo requests or missing coverage items. Keep this at the end.
- Every claim must be based on visible image evidence unless explicitly marked as profile/context interpretation. Prefer "appears", "is visible", "is consistent with", or "not visible in this specific view" over stronger wording, but do not overuse caveats.
`,
  sections: [
    { key: "coverage_map", label: "Coverage Map", color: "hsl(var(--chart-1))" },
    { key: "significant_findings", label: "Significant Findings", color: "hsl(var(--primary))" },
    { key: "overall_body_overview", label: "Overall Body Overview", color: "hsl(var(--chart-4))" },
    { key: "posture_alignment", label: "Posture & Alignment", color: "hsl(var(--chart-2))" },
    { key: "body_habitus_soft_tissue", label: "Body Habitus & Soft Tissue", color: "hsl(var(--primary))" },
    { key: "skin_surface_findings", label: "Skin & Surface Findings", color: "hsl(var(--chart-3))" },
    { key: "musculoskeletal_and_limb_findings", label: "Musculoskeletal, Limb, Hand & Foot Findings", color: "hsl(var(--chart-5))" },
    { key: "pelvic_genital_perineal_anatomy", label: "Pelvic, Genital & Perineal Anatomy", color: "hsl(var(--chart-2))" },
    { key: "region_specific_anatomical_findings", label: "Region-Specific Head-to-Toe Findings", color: "hsl(var(--chart-2))" },
    { key: "missing_items_optional_image_requests", label: "Missing Items / Optional Image Requests", color: "hsl(var(--muted-foreground))", required: false },
  ],
};

const PELVIC_GENITAL_IMAGE_REVIEW_CONFIG = {
  title: "Pelvic & Genital Image Review",
  shortTitle: "Pelvic/Genital",
  kind: "profile_pelvic_genital_image_review",
  resultKey: "pelvic_genital_image_review_result",
  archiveKey: "pelvic_genital_image_review_archive",
  ttsSessionId: "profile-pelvic-genital-image-review",
  maxImages: 20,
  icon: <User className="w-4 h-4" />,
  color: "hsl(var(--chart-2))",
  purpose: "Detailed pelvis, external genital, anal/perianal, glans/meatus/foreskin, scrotal/perineal, tissue-state, physiology, and visible device-fit context review grounded in supplied photos and video clips.",
  helper: "Review saved pelvic/genital visual evidence from Q&A photos, sessions, body exploration, entered measurements, and prior Sarah media reviews. Saved evidence is the default; fresh focused images are optional add-on evidence.",
  emptyText: "Click Review Existing Evidence to reuse saved Profile Q&A image evidence and synthesize saved pelvic/genital findings. Add focused images only when you want to add new evidence to the existing profile.",
  reviewInstructions: `
PELVIC / GENITAL REVIEW SCOPE:
- Anchor this output in supplied and previously reviewed visual evidence from photos and video clips. Stay with anatomy, physiology, visible tissue state, state-dependent changes, device fit, and confidence limits that matter.
- Make the review easy to listen to as downloaded audio: lead with visible pelvic/genital/perineal findings, use natural paragraph flow, avoid duplicate callout/prose wording, and keep caveats brief.
- Do not open with source details, evidence-scope logistics, batch/source/rechecked-image explanations, or provenance. Start with actual pelvic/genital/perineal anatomy.
- Do not narrate every absent structure, device, or limitation. Mention absence only when it is itself the relevant finding or materially changes interpretation.
- Focus the anatomy-by-region section on shaft, glans, foreskin/retraction state, meatus, frenulum/frenular remnant, scrotum/testes, perineum/pelvic floor, anus/perianal region/anal verge when visible, and lower abdomen/groin only when it helps interpret the pelvic/genital evidence.
- Include anal/perianal anatomy when it is visible or previously reviewed, especially where it matters for rectal stimulation context, perineal mechanics, tissue state, safety, or device/contact fit. If anal/perianal evidence is absent or limited, say that once only if it materially affects interpretation.
- Do not make feet, lower-leg posture, hand positioning, or stimulation techniques standalone topics in this pelvic/genital artifact. Mention hands, feet, or technique only when they directly affect visibility, scale, occlusion, pelvic positioning, contact mechanics, device fit, or safety interpretation.
- If catheters, urethral sounds, anal devices, rectal stimulation equipment, sleeves, markers, stickers, lubricant, or medical/procedural supplies are visible, describe their visible position, contact zone, fit, and tissue interaction cautiously. Do not invent insertion depth, advancement, discomfort, sensation, or procedure stage unless image evidence or saved context directly supports it.
- Compare visible findings with entered measurements, Foley/sound/device profile fields, prior Q&A findings, and session/video evidence. Use this to explain continuity or mismatch while keeping the output centered on visual anatomy and physiology.
- Organize the review as a pelvic/genital reference artifact: coverage map, significant findings, anatomy by region, state-dependent changes, device/contact mechanics, tissue state and safety observations, measurement reconciliation, and the small set of limitations or optional evidence gaps that actually matter.
- Coverage Map should list meaningful visible states only: flaccid foreskin covering glans, flaccid foreskin retracted, erect foreskin covering glans, erect foreskin retracted, ventral view, scrotum elevated during arousal, perineal/perianal view, and any newly improved angle. Put missing states only in optional evidence gaps.
- Significant Findings should lead with new, changed, or high-value stable baseline findings. Do not re-describe every stable structure.
- Lead with visible pelvic/genital/perineal findings. Do not turn missing regions or absent devices into the dominant narrative unless that absence is the direct finding being checked.
- Keep the language anatomical and practical. Do not eroticize the review or write arousal-focused prose.
`,
  sections: [
    { key: "coverage_map", label: "Coverage Map", color: "hsl(var(--chart-1))" },
    { key: "significant_findings", label: "Significant Findings", color: "hsl(var(--primary))" },
    { key: "anatomy_by_region", label: "Anatomy by Region", color: "hsl(var(--primary))" },
    { key: "state_dependent_changes", label: "State-Dependent Changes", color: "hsl(var(--chart-4))" },
    { key: "device_and_stimulation_mechanics", label: "Device & Contact Mechanics", color: "hsl(var(--chart-1))" },
    { key: "tissue_state_and_safety_observations", label: "Tissue State & Safety Observations", color: "hsl(var(--chart-3))" },
    { key: "measurement_reconciliation", label: "Measurement Reconciliation", color: "hsl(var(--chart-5))" },
    { key: "limitations_and_optional_evidence_gaps", label: "Limitations & Optional Evidence Gaps", color: "hsl(var(--muted-foreground))", required: false },
  ],
};

function ProfileImageReviewPanel({
  config,
  sessions = [],
  bodyExplorations = [],
  userProfile,
  refreshUserProfile,
  profileLoading = false,
  evidenceLoading = false,
}) {
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [jobStatus, setJobStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [archive, setArchive] = useState([]);
  const [error, setError] = useState("");
  const [recoverableBatchSet, setRecoverableBatchSet] = useState(null);
  const [latestAttemptStatus, setLatestAttemptStatus] = useState(null);
  const [availableCompletedReviewJob, setAvailableCompletedReviewJob] = useState(null);
  const [selectedProfilerImageId, setSelectedProfilerImageId] = useState(null);
  const [includeImageCalloutsInTts, setIncludeImageCalloutsInTts] = useState(() => {
    try {
      return window.localStorage.getItem("pulsepoint_profile_image_tts_callouts") === "true";
    } catch {
      return false;
    }
  });
  const autoRecoveredBatchSetRef = useRef("");

  useEffect(() => {
    try {
      window.localStorage.setItem("pulsepoint_profile_image_tts_callouts", includeImageCalloutsInTts ? "true" : "false");
    } catch {
      // Ignore storage failures; the toggle still works for the current render.
    }
  }, [includeImageCalloutsInTts]);

  useEffect(() => {
    base44.entities.SessionClusterAnalysis.list("-updated_date", 1).then((rows) => {
      if (rows[0]?.[config.resultKey]) {
        const loadedResult = normalizeImageReviewResult(rows[0][config.resultKey]) || rows[0][config.resultKey];
        setResult(loadedResult);
        if (loadedResult?._meta?.latest_attempt_status) setLatestAttemptStatus(loadedResult._meta.latest_attempt_status);
      }
      if (Array.isArray(rows[0]?.[config.archiveKey])) {
        setArchive(rows[0][config.archiveKey].map((entry) => ({
          ...entry,
          result: normalizeImageReviewResult(entry.result) || entry.result,
        })));
      }
    });
  }, [config.archiveKey, config.resultKey]);

  const jobLabel = `AI Profiler: ${config.title}`;

  const storeCompletedReviewJob = async (completedJob, sourceImages = []) => {
    const parsed = normalizeImageReviewResult(completedJob?.result);
    if (!parsed?.overview) throw new Error("Sarah returned an empty image review.");
    const visualEvidence = buildExistingVisualEvidenceDigest({ sessions, bodyExplorations });
    const storedResult = {
      ...parsed,
      _meta: buildImageReviewMeta(
        sourceImages,
        sessions,
        result?._meta,
        visualEvidence.counts,
        completedAt(completedJob),
        completedJob?.meta?.reviewed_images,
        {
          fresh_image_count: completedJob?.meta?.fresh_image_count,
          reused_saved_image_count: completedJob?.meta?.reused_saved_image_count,
          image_count: completedJob?.meta?.image_count,
        },
      ),
    };
    if (parsed?._background_attempt_status) {
      storedResult._meta.latest_attempt_status = parsed._background_attempt_status;
      setLatestAttemptStatus(parsed._background_attempt_status);
    }
    setResult(storedResult);
    const nextArchive = await saveProfileResultWithArchive({
      resultKey: config.resultKey,
      archiveKey: config.archiveKey,
      kind: config.kind,
      label: config.title,
      result: storedResult,
      sessionCount: sessions.length,
    });
    setArchive(nextArchive);
    return storedResult;
  };

  useEffect(() => {
    let cancelled = false;
    if (profileLoading || evidenceLoading || !userProfile) return undefined;

    const jobTime = (job) => new Date(completedAt(job) || job?.updatedAt || job?.createdAt || 0).getTime() || 0;
    const isMatchingReviewJob = (job) => {
      const label = String(job?.meta?.label || "");
      return job?.meta?.reviewType === config.kind ||
        label === jobLabel ||
        label.startsWith(`${jobLabel} `);
    };
    const looksLikePartialBatchResult = (job) => {
      const overview = String(job?.result?.overview || "");
      const evidenceNote = String(job?.result?.summary_card?.evidence_note || "");
      return /^Batch\s+\d+\s+of\s+\d+/i.test(overview.trim()) ||
        /^This batch/i.test(overview.trim()) ||
        /\bbatch review\b/i.test(evidenceNote);
    };
    const isFinalOrSingleReviewJob = (job) => {
      if (!isMatchingReviewJob(job)) return false;
      if (looksLikePartialBatchResult(job)) return false;
      if (job?.meta?.synthesis) return true;
      if (job?.meta?.batch) return false;
      return job?.meta?.reviewType === config.kind || job?.meta?.label === jobLabel;
    };
    const isFailedFinalReviewJob = (job) => (
      isMatchingReviewJob(job) &&
      (job?.status === "error" || job?.status === "cancelled") &&
      (
        job?.type === "profile_image_review_full" ||
        job?.meta?.full_background_review ||
        job?.meta?.synthesis ||
        (!job?.meta?.batch && String(job?.meta?.label || "").includes("final synthesis"))
      )
    );
    const finalSynthesisFailureStatus = (job, batchSet = null) => ({
      state: "latest_final_synthesis_failed",
      timestamp: job?.finishedAt || job?.updatedAt || new Date().toISOString(),
      error_message: job?.error || job?.progress?.message || job?.status || "Final synthesis failed.",
      synthesis_stage: job?.progress?.phase || "final_synthesis",
      batch_reviews_completed: Boolean(batchSet?.batches?.length),
      batch_count: batchSet?.total || job?.meta?.batch_count || null,
      older_saved_review_showing: Boolean(result),
      latest_batch_findings_available: Boolean(batchSet?.batches?.length),
      job_id: job?.id || null,
    });
    const newestFirst = (a, b) => jobTime(b) - jobTime(a);
    const describeIncompleteBatchedReview = (completedJobs) => {
      const partials = (completedJobs || [])
        .filter(isMatchingReviewJob)
        .filter((job) => job?.meta?.batch || looksLikePartialBatchResult(job))
        .filter((job) => Number(job?.meta?.batch_count || 0) > 1)
        .sort(newestFirst);
      const newestPartial = partials[0];
      if (!newestPartial || !isNewerCompletedJob(newestPartial, result)) return false;
      const total = Number(newestPartial.meta?.batch_count || 0);
      const newestTime = jobTime(newestPartial);
      const latestBatchOne = partials
        .filter((job) => Number(job?.meta?.batch || 0) === 1)
        .filter((job) => jobTime(job) <= newestTime)
        .sort(newestFirst)[0];
      const runStart = latestBatchOne ? jobTime(latestBatchOne) : newestTime;
      const runPartials = partials.filter((job) => jobTime(job) >= runStart && jobTime(job) <= newestTime);
      const completedBatches = new Set(runPartials.map((job) => Number(job?.meta?.batch || 0)).filter(Boolean));
      const done = completedBatches.size || Number(newestPartial.meta?.batch || 0) || 1;
      setJobStatus(newestPartial);
      setError(`Latest ${config.title.toLowerCase()} review has ${done}/${total} completed batches available. PulsePoint will auto-assemble the completed batch set once all batches are finished; leave the desktop backend running and reopen this page to recover progress.`);
      return true;
    };
    const findRecoverableBatchSet = (completedJobs = []) => {
      const partials = (completedJobs || [])
        .filter(isMatchingReviewJob)
        .filter((job) => job?.status === "complete")
        .filter((job) => Number(job?.meta?.batch || 0) > 0 && Number(job?.meta?.batch_count || 0) > 1)
        .sort(newestFirst);
      const finalBatch = partials.find((job) => Number(job?.meta?.batch || 0) === Number(job?.meta?.batch_count || 0));
      if (!finalBatch) return null;
      const total = Number(finalBatch.meta?.batch_count || 0);
      const finalTime = jobTime(finalBatch);
      const batchOne = partials
        .filter((job) => Number(job?.meta?.batch || 0) === 1)
        .filter((job) => Number(job?.meta?.batch_count || 0) === total)
        .filter((job) => jobTime(job) <= finalTime)
        .sort(newestFirst)[0];
      const startTime = batchOne ? jobTime(batchOne) : 0;
      const runJobs = partials
        .filter((job) => Number(job?.meta?.batch_count || 0) === total)
        .filter((job) => jobTime(job) >= startTime && jobTime(job) <= finalTime)
        .sort((a, b) => Number(a?.meta?.batch || 0) - Number(b?.meta?.batch || 0));
      const byBatch = new Map();
      for (const job of runJobs) {
        const batchNumber = Number(job?.meta?.batch || 0);
        if (!byBatch.has(batchNumber) || jobTime(job) > jobTime(byBatch.get(batchNumber))) {
          byBatch.set(batchNumber, job);
        }
      }
      const batches = Array.from({ length: total }, (_, index) => byBatch.get(index + 1));
      if (batches.some((job) => !job?.result?.overview)) return null;
      const reviewedImages = batches.flatMap((job) => Array.isArray(job?.meta?.reviewed_images) ? job.meta.reviewed_images : []);
      const latestFailedFinal = null;
      return {
        total,
        batches,
        reviewed_images: reviewedImages,
        fresh_image_count: Math.max(...batches.map((job) => Number(job?.meta?.fresh_image_count || 0)), 0),
        reused_saved_image_count: Math.max(...batches.map((job) => Number(job?.meta?.reused_saved_image_count || 0)), 0),
        image_count: Math.max(...batches.map((job) => Number(job?.meta?.full_review_image_count || job?.meta?.image_count || 0)), reviewedImages.length),
        startedAt: batchOne?.createdAt || batches[0]?.createdAt,
        finishedAt: finalBatch.finishedAt || finalBatch.updatedAt,
        latestFailedFinal,
      };
    };

    const refreshRecoverableState = async () => {
      try {
        const activeFullData = await listBackgroundJobs({
          type: "profile_image_review_full",
          status: "queued,running",
          metaSource: "Profiler",
          limit: 20,
        });
        if (cancelled) return;
        const activeFullJob = (activeFullData.jobs || [])
          .filter(isMatchingReviewJob)
          .sort(newestFirst)[0];
        if (activeFullJob) {
          setJobStatus(activeFullJob);
          setLoading(true);
          setError(`Full ${config.shortTitle} review is running in the desktop background. You can leave this page and reopen it later.`);
          return;
        }

        const completedAiData = await listBackgroundJobs({
          type: "ai_invoke",
          status: "complete",
          metaSource: "Profiler",
          limit: 50,
        });
        const completedFullData = await listBackgroundJobs({
          type: "profile_image_review_full",
          status: "complete",
          metaSource: "Profiler",
          limit: 20,
        });
        if (cancelled) return;
        const completedJobs = [
          ...(completedFullData.jobs || []),
          ...(completedAiData.jobs || []),
        ];
        const recoverable = findRecoverableBatchSet(completedJobs);
        setRecoverableBatchSet(recoverable);
        if (
          recoverable?.batches?.length &&
          isNewerCompletedJob(recoverable.batches[recoverable.batches.length - 1], result) &&
          autoRecoveredBatchSetRef.current !== `${config.kind}:${recoverable.startedAt || ""}:${recoverable.finishedAt || ""}`
        ) {
          autoRecoveredBatchSetRef.current = `${config.kind}:${recoverable.startedAt || ""}:${recoverable.finishedAt || ""}`;
          const batchParsedResults = recoverable.batches
            .map((batchJob) => remapBatchLocalImageIds(
              normalizeImageReviewResult(batchJob?.result),
              batchJob?.meta?.reviewed_images || [],
            ))
            .filter((item) => item?.overview);
          if (batchParsedResults.length === recoverable.batches.length) {
            await saveBatchAssembledReview(
              batchParsedResults,
              "Auto-saved the completed Sarah batch findings after the page reconnected. No extra Claude synthesis request was made.",
              recoverable,
              {
                state: "batch_reviews_auto_saved_after_reconnect",
                timestamp: new Date().toISOString(),
                synthesis_stage: "local_batch_assembly_after_reconnect",
                batch_reviews_completed: true,
                older_saved_review_showing: false,
                latest_batch_findings_available: true,
                batch_count: recoverable.total || batchParsedResults.length,
                final_synthesis_attempted: false,
              },
              { showErrorNotice: false, keepRecoverableBatchSet: true },
            );
            return;
          }
        }
        const job = completedJobs
          .filter(isFinalOrSingleReviewJob)
          .sort(newestFirst)[0];
        if (!job || !isNewerCompletedJob(job, result)) {
          setAvailableCompletedReviewJob(null);
          const failedAiData = await listBackgroundJobs({
            type: "ai_invoke",
            status: "error,cancelled",
            metaSource: "Profiler",
            limit: 50,
          });
          const failedFullData = await listBackgroundJobs({
            type: "profile_image_review_full",
            status: "error,cancelled",
            metaSource: "Profiler",
            limit: 20,
          });
          if (cancelled) return;
          const failedFinal = [
            ...(failedFullData.jobs || []),
            ...(failedAiData.jobs || []),
          ]
            .filter(isFailedFinalReviewJob)
            .sort(newestFirst)[0];
          if (failedFinal && isNewerCompletedJob({ ...failedFinal, status: "complete" }, result)) {
            const failedStatus = finalSynthesisFailureStatus(failedFinal, recoverable);
            setJobStatus(failedFinal);
            setRecoverableBatchSet(recoverable);
            setLatestAttemptStatus(failedStatus);
            setError(recoverable?.batches?.length
              ? `Latest ${config.title.toLowerCase()} final synthesis failed, but completed batch findings are available. Press Show Latest Findings to display them.`
              : `Latest ${config.title.toLowerCase()} final synthesis failed: ${failedFinal.error || failedFinal.progress?.message || failedFinal.status}.`);
            return;
          }
          describeIncompleteBatchedReview(completedJobs);
          return;
        }

        if (job && isNewerCompletedJob(job, result)) {
          if (job.type === "profile_image_review_full" || job?.meta?.full_background_review) {
            setJobStatus(job);
            await storeCompletedReviewJob(job, []);
            setAvailableCompletedReviewJob(null);
            setRecoverableBatchSet(null);
            setLatestAttemptStatus(job.result?._background_attempt_status || null);
            setError("");
            setLoading(false);
            return;
          }
          if (result?._meta?.local_batch_assembled) {
            setAvailableCompletedReviewJob(null);
            setError("");
            return;
          }
          setJobStatus(job);
          setAvailableCompletedReviewJob(job);
          setRecoverableBatchSet(null);
          setLatestAttemptStatus(null);
          setError("A newer completed Profiler review is available. Press the main review button if you want to refresh the displayed output.");
        }
      } catch (err) {
        if (!cancelled) console.warn(`${config.title} background state refresh skipped:`, err);
      }
    };

    refreshRecoverableState();
    const interval = window.setInterval(refreshRecoverableState, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [config.kind, config.title, evidenceLoading, jobLabel, profileLoading, result, sessions.length, userProfile]);

  const handleImageFiles = async (event) => {
    const files = Array.from(event.target.files || []).filter((file) => file.type?.startsWith("image/"));
    event.target.value = "";
    if (!files.length) return;
    setError("");
    try {
      const loaded = await Promise.all(files.map(imageFileToPayload));
      setImages((current) => [...current, ...loaded].slice(0, config.maxImages || 8));
    } catch (err) {
      setError(err?.message || "Could not read one of the selected images.");
    }
  };

  const removeImage = (id) => {
    setImages((current) => current.filter((image) => image.id !== id));
  };

  const updateImageNote = (id, upload_note) => {
    setImages((current) => current.map((image) => (
      image.id === id ? { ...image, upload_note } : image
    )));
  };

  const saveImageFindingClarification = async (finding, correctionText) => {
    const trimmed = String(correctionText || "").trim();
    if (!trimmed) throw new Error("Enter a clarification first.");
    if (!result || !finding?.finding_id) throw new Error("This callout is not available to correct.");
    const correctedAt = new Date().toISOString();
    const originalFinding = finding.original_finding || finding.finding || "";
    const originalLabel = finding.original_label || finding.label || finding.region || "Image callout";
    const correctionRecord = {
      corrected_at: correctedAt,
      text: trimmed,
      finding_id: finding.finding_id,
      image_id: finding.image_id || "",
      section_key: finding.section_key || "",
      original_label: originalLabel,
      original_finding: originalFinding,
    };
    const nextResult = {
      ...result,
      image_region_findings: (Array.isArray(result.image_region_findings) ? result.image_region_findings : []).map((item) => {
        if (item.finding_id !== finding.finding_id) return item;
        return {
          ...item,
          original_label: item.original_label || item.label || item.region || "",
          original_finding: item.original_finding || item.finding || "",
          label: `Corrected: ${originalLabel}`,
          finding: `User clarification: ${trimmed}`,
          confidence: "user corrected",
          evidence_level: "user clarification",
          limitations: [
            ...new Set([
              ...(Array.isArray(item.limitations) ? item.limitations : []),
              "Original Sarah callout corrected by user.",
            ]),
          ],
          user_correction: correctionRecord,
        };
      }),
      _meta: {
        ...(result._meta || {}),
        updated_at: correctedAt,
        image_clarifications: [
          correctionRecord,
          ...(Array.isArray(result._meta?.image_clarifications) ? result._meta.image_clarifications : [])
            .filter((item) => item?.finding_id !== finding.finding_id),
        ].slice(0, 80),
      },
    };
    setResult(nextResult);
    const nextArchive = await saveProfileResultWithArchive({
      resultKey: config.resultKey,
      archiveKey: config.archiveKey,
      kind: config.kind,
      label: config.title,
      result: nextResult,
      sessionCount: sessions.length,
    });
    setArchive(nextArchive);

    const currentProfile = (await refreshUserProfile?.().catch(() => null)) || userProfile;
    const existingEntries = normalizeProfileQaFindings(currentProfile?.profile_qa_findings);
    const correctionEntry = makeProfileQaEntry(`Image clarification for ${config.title}: ${trimmed}`, {
      source: "profile_sarah_image_review",
      persistence_status: "confirmed_user_correction",
      needs_review: false,
      image_count: 1,
      structured_findings: [{
        type: "image_callout_correction",
        review_type: config.kind,
        image_id: finding.image_id || "",
        finding_id: finding.finding_id,
        original_label: originalLabel,
        original_finding: originalFinding,
        correction: trimmed,
      }],
      media_context: {
        review_type: config.kind,
        review_label: config.title,
        image_id: finding.image_id || "",
        finding_id: finding.finding_id,
      },
    });
    await base44.auth.updateMe({
      profile_qa_findings: [
        correctionEntry,
        ...existingEntries.filter((entry) => entry?.id !== correctionEntry.id),
      ].slice(0, 250),
    });
    await refreshUserProfile?.().catch(() => null);
  };

  const removeImageFindingCallout = async (finding) => {
    if (!result || !finding?.finding_id) throw new Error("This callout is not available to remove.");
    const removedAt = new Date().toISOString();
    const removedRecord = {
      removed_at: removedAt,
      finding_id: finding.finding_id,
      image_id: finding.image_id || "",
      section_key: finding.section_key || "",
      original_label: finding.original_label || finding.label || finding.region || "Image callout",
      original_finding: finding.original_finding || finding.finding || "",
      reason: "Removed by user as incorrect.",
    };
    const nextResult = {
      ...result,
      image_region_findings: (Array.isArray(result.image_region_findings) ? result.image_region_findings : [])
        .filter((item) => item.finding_id !== finding.finding_id),
      _meta: {
        ...(result._meta || {}),
        updated_at: removedAt,
        removed_image_callouts: [
          removedRecord,
          ...(Array.isArray(result._meta?.removed_image_callouts) ? result._meta.removed_image_callouts : [])
            .filter((item) => item?.finding_id !== finding.finding_id),
        ].slice(0, 80),
        image_clarifications: (Array.isArray(result._meta?.image_clarifications) ? result._meta.image_clarifications : [])
          .filter((item) => item?.finding_id !== finding.finding_id),
      },
    };
    setResult(nextResult);
    const nextArchive = await saveProfileResultWithArchive({
      resultKey: config.resultKey,
      archiveKey: config.archiveKey,
      kind: config.kind,
      label: config.title,
      result: nextResult,
      sessionCount: sessions.length,
    });
    setArchive(nextArchive);

    const currentProfile = (await refreshUserProfile?.().catch(() => null)) || userProfile;
    const existingEntries = normalizeProfileQaFindings(currentProfile?.profile_qa_findings);
    const removalEntry = makeProfileQaEntry(`Image callout removed from ${config.title}: ${removedRecord.original_label} was marked incorrect by the user. Original claim: ${removedRecord.original_finding || "No original claim text saved."}`, {
      source: "profile_sarah_image_review",
      persistence_status: "confirmed_user_correction",
      needs_review: false,
      image_count: 1,
      structured_findings: [{
        type: "image_callout_removed",
        review_type: config.kind,
        image_id: finding.image_id || "",
        finding_id: finding.finding_id,
        original_label: removedRecord.original_label,
        original_finding: removedRecord.original_finding,
        correction: "User removed this callout as incorrect.",
      }],
      media_context: {
        review_type: config.kind,
        review_label: config.title,
        image_id: finding.image_id || "",
        finding_id: finding.finding_id,
      },
    });
    await base44.auth.updateMe({
      profile_qa_findings: [
        removalEntry,
        ...existingEntries.filter((entry) => entry?.id !== removalEntry.id),
      ].slice(0, 250),
    });
    await refreshUserProfile?.().catch(() => null);
  };

  const saveBatchAssembledReview = async (batchParsedResults, note = "", batchSetOverride = null, attemptStatusOverride = null, options = {}) => {
    if (!batchParsedResults?.length) throw new Error("No completed batch outputs are available to assemble.");
    const batchSet = batchSetOverride || recoverableBatchSet || {};
    const visualEvidence = buildExistingVisualEvidenceDigest({ sessions, bodyExplorations });
    const assembled = buildBatchAssembledImageReview(config, batchParsedResults, batchSet);
    const storedResult = {
      ...assembled,
      _meta: buildImageReviewMeta([], sessions, result?._meta, visualEvidence.counts, new Date().toISOString(), batchSet?.reviewed_images || [], {
        fresh_image_count: batchSet?.fresh_image_count || 0,
        reused_saved_image_count: batchSet?.reused_saved_image_count || 0,
        image_count: batchSet?.image_count || batchSet?.reviewed_images?.length || 0,
      }),
    };
    storedResult._meta.recovered_from_batches = true;
    storedResult._meta.local_batch_assembled = true;
    storedResult._meta.image_id_repair_version = PROFILE_IMAGE_ID_REPAIR_VERSION;
    storedResult._meta.latest_attempt_status = attemptStatusOverride || {
      state: "batch_reviews_saved_as_current_review",
      timestamp: new Date().toISOString(),
      synthesis_stage: "local_batch_assembly",
      batch_reviews_completed: true,
      older_saved_review_showing: false,
      latest_batch_findings_available: true,
      batch_count: batchSet?.total || batchParsedResults.length,
      final_synthesis_required: false,
    };
    setResult(storedResult);
    setLatestAttemptStatus(storedResult._meta.latest_attempt_status);
    const nextArchive = await saveProfileResultWithArchive({
      resultKey: config.resultKey,
      archiveKey: config.archiveKey,
      kind: config.kind,
      label: config.title,
      result: storedResult,
      sessionCount: sessions.length,
    });
    setArchive(nextArchive);
    if (options.keepRecoverableBatchSet !== true) {
      setRecoverableBatchSet(null);
    }
    if (options.showErrorNotice === false) {
      setError("");
    } else {
      setError(note || "Final synthesis timed out, so PulsePoint assembled and saved the completed Sarah batch reviews locally.");
    }
    return storedResult;
  };

  const assembleCompletedBatches = async () => {
    if (!recoverableBatchSet?.batches?.length) {
      setError("No complete batch set is available to assemble yet.");
      return;
    }
    setLoading(true);
    setError("");
    setJobStatus({
      status: "running",
      progress: {
        phase: "assembling",
        current: 2,
        total: 3,
        message: `Assembling ${recoverableBatchSet.total}/${recoverableBatchSet.total} completed Sarah batches locally...`,
      },
    });
    try {
      const batchParsedResults = recoverableBatchSet.batches
        .map((job) => remapBatchLocalImageIds(
          normalizeImageReviewResult(job?.result),
          job?.meta?.reviewed_images || [],
        ))
        .filter((item) => item?.overview);
      await saveBatchAssembledReview(batchParsedResults, "Saved a recovered review assembled from completed Sarah batch outputs. No additional Claude synthesis request was made.");
    } catch (err) {
      console.error(`${config.title} local batch assembly failed:`, err);
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const hasRecoverableDisplayRepair = recoverableBatchSet?.batches?.length > 0 &&
    result?._meta?.local_batch_assembled &&
    result?._meta?.image_id_repair_version !== PROFILE_IMAGE_ID_REPAIR_VERSION;
  const hasRecoverableUnshownBatchSet = recoverableBatchSet?.batches?.length > 0 && !result?._meta?.local_batch_assembled;
  const handlePrimaryReviewAction = async () => {
    if (availableCompletedReviewJob) {
      setLoading(true);
      setError("");
      try {
        await storeCompletedReviewJob(availableCompletedReviewJob, []);
        setAvailableCompletedReviewJob(null);
      } catch (err) {
        console.error(`${config.title} saved completed review display failed:`, err);
        setError(aiErrorMessage(err));
      } finally {
        setLoading(false);
      }
      return;
    }
    if (hasRecoverableUnshownBatchSet || hasRecoverableDisplayRepair) return assembleCompletedBatches();
    return analyze();
  };

  const recoverFinalSynthesis = async () => {
    if (!recoverableBatchSet?.batches?.length) {
      setError("No complete batch set is available to recover yet.");
      return;
    }
    setLoading(true);
    setError("");
    setJobStatus({
      status: "starting",
      progress: {
        phase: "recovering",
        current: 0,
        total: 3,
        message: `Recovering ${config.shortTitle} from ${recoverableBatchSet.total}/${recoverableBatchSet.total} completed batches...`,
      },
    });
    let batchParsedResults = [];
    try {
      const reviewUserProfile = (await refreshUserProfile?.().catch(() => null)) || userProfile;
      const isHeadToToeBodyReference = config.contextScope === "head_to_toe_body_reference";
      batchParsedResults = recoverableBatchSet.batches
        .map((job) => remapBatchLocalImageIds(
          normalizeImageReviewResult(job?.result),
          job?.meta?.reviewed_images || [],
        ))
        .filter((item) => item?.overview);
      if (!batchParsedResults.length) throw new Error("Completed batch results could not be reloaded for recovery.");

      const visualEvidence = buildExistingVisualEvidenceDigest({ sessions, bodyExplorations });
      const groundingContext = isHeadToToeBodyReference ? "" : buildAIGroundingContext(reviewUserProfile);
      const imageReviewContext = isHeadToToeBodyReference
        ? buildHeadToToeImageReviewContext({
          userProfile: reviewUserProfile,
          sessions,
          bodyExplorations,
          hasFreshImages: Number(recoverableBatchSet.fresh_image_count || 0) > 0,
          hasReusedSavedImages: Number(recoverableBatchSet.reused_saved_image_count || 0) > 0,
        })
        : buildProfileImageReviewContext({ userProfile: reviewUserProfile, sessions, bodyExplorations });
      const firstNameToneCue = buildOptionalFirstNameToneCue(reviewUserProfile, { prioritizeProfileTone: true });
      const anatomicalFocusRule = isHeadToToeBodyReference ? "" : ANATOMICAL_REFERENCE_FOCUS_RULE;
      const sessionGroundingRule = isHeadToToeBodyReference ? "" : SESSION_CONTEXT_GROUNDING_RULE;
      const responseSchema = profileImageReviewResponseSchema(config);
      const raw = await runProfilerAIJob({
        model: "claude_sonnet_4_6",
        max_tokens: PROFILE_IMAGE_REVIEW_MAX_TOKENS,
        attempts: 3,
        prompt: `You are Sarah, recovering the final PulsePoint profile image review from completed image-review batch JSON.

Review type: ${config.title}
Review purpose: ${config.purpose}
Recovery source: ${recoverableBatchSet.total} completed image-review batches from the previous run.
Directly rechecked image subset across recovered batches: ${recoverableBatchSet.image_count || recoverableBatchSet.reviewed_images?.length || "unknown"}.

No fresh images are attached to this recovery pass because the direct visual re-check already succeeded in the batch passes. Treat the recovered batch JSON below as directly reviewed visual evidence, then integrate it with saved profile/session context. Produce ONE final cumulative user-facing review, not a batch-by-batch report and not a review limited to the image subset.

${groundingContext}
${imageReviewContext}
${anatomicalFocusRule}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${sessionGroundingRule}
${PROFILE_IMAGE_EVIDENCE_LAYER_RULE}
${PROFILE_IMAGE_VISIBLE_FINDINGS_FIRST_RULE}
${PROFILE_IMAGE_INSIGHT_EFFICIENCY_RULE}
${PROFILE_IMAGE_CUMULATIVE_SCOPE_RULE}

RECOVERY SYNTHESIS RULES:
- Do not mention filenames, camera-roll IDs, storage IDs, raw image numbers, job IDs, or batch job IDs.
- Do not say only five images were reviewed, and do not frame the whole artifact as "based on X images." The recovered batches are a direct visual re-check subset inside a cumulative profile review.
- Do not let any one batch dominate the final review. Synthesize all recovered batch results plus saved profile/session context into one whole-profile analysis.
- Treat fresh images from the recovered run as additive updates to the saved baseline, not as a reset of prior anatomical/profile evidence.
- Preserve direct visual evidence versus profile-context reconciliation versus interpretation.
- Keep the output clinically rich, practical, non-erotic, and TTS-ready.
- Preserve useful annotated_images and image_region_findings using image_id values from the recovered batch results.

${config.reviewInstructions}

Recovered compact batch review JSON:
${JSON.stringify(batchParsedResults.map(compactImageReviewForSynthesis), null, 2)}`,
        response_json_schema: responseSchema,
      }, `${jobLabel} recovered final synthesis`, setJobStatus, {
        priority: 35,
        meta: {
          reviewType: config.kind,
          batch_count: recoverableBatchSet.total,
          reviewed_images: recoverableBatchSet.reviewed_images || [],
          image_count: recoverableBatchSet.image_count || recoverableBatchSet.reviewed_images?.length || 0,
          fresh_image_count: recoverableBatchSet.fresh_image_count || 0,
          reused_saved_image_count: recoverableBatchSet.reused_saved_image_count || 0,
          synthesis: true,
          recovered_from_batches: true,
        },
      });

      const parsed = mergeImageReviewBatchArtifacts(
        normalizeImageReviewResult(typeof raw === "string" ? JSON.parse(raw) : raw),
        batchParsedResults,
      );
      if (!parsed?.overview) throw new Error("Sarah returned an empty recovered image review.");
      const storedResult = {
        ...parsed,
        _meta: buildImageReviewMeta([], sessions, result?._meta, visualEvidence.counts, null, recoverableBatchSet.reviewed_images || [], {
          fresh_image_count: recoverableBatchSet.fresh_image_count || 0,
          reused_saved_image_count: recoverableBatchSet.reused_saved_image_count || 0,
          image_count: recoverableBatchSet.image_count || recoverableBatchSet.reviewed_images?.length || 0,
        }),
      };
      storedResult._meta.recovered_from_batches = true;
      storedResult._meta.latest_attempt_status = {
        ...(latestAttemptStatus || {}),
        state: "retry_final_synthesis_succeeded",
        timestamp: new Date().toISOString(),
        synthesis_stage: "recovered_final_synthesis",
        batch_reviews_completed: true,
        older_saved_review_showing: false,
        latest_batch_findings_available: true,
      };
      setResult(storedResult);
      const nextArchive = await saveProfileResultWithArchive({
        resultKey: config.resultKey,
        archiveKey: config.archiveKey,
        kind: config.kind,
        label: config.title,
        result: storedResult,
        sessionCount: sessions.length,
      });
      setArchive(nextArchive);
      setRecoverableBatchSet(null);
    } catch (err) {
      console.error(`${config.title} recovery failed:`, err);
      if (/timed out|timeout|request timed out/i.test(err?.message || "") && batchParsedResults.length) {
        try {
          await saveBatchAssembledReview(batchParsedResults, "Final Sarah synthesis timed out again, so PulsePoint assembled and saved the completed Sarah batch reviews locally.");
          return;
        } catch (assembleError) {
          console.error(`${config.title} timeout fallback assembly failed:`, assembleError);
        }
      }
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const analyze = async () => {
    setLoading(true);
    setLatestAttemptStatus(null);
    setJobStatus({
      status: "starting",
      progress: {
        phase: "building",
        current: 0,
        total: 3,
        message: `Preparing ${config.shortTitle} review for the background queue...`,
      },
    });
    setError("");
    let batchParsedResults = [];
    let activeBatchSet = null;
    try {
      const reviewUserProfile = (await refreshUserProfile?.().catch(() => null)) || userProfile;
      const isHeadToToeBodyReference = config.contextScope === "head_to_toe_body_reference";
      const visualEvidence = buildExistingVisualEvidenceDigest({ sessions, bodyExplorations });
      const maxReviewImages = config.maxImages || 5;
      const allSavedAttachments = collectSavedProfileImageAttachments(reviewUserProfile, {
        limit: maxReviewImages,
        purpose: isHeadToToeBodyReference ? "head_to_toe_body_reference" : "pelvic_genital",
      });
      const savedReserve = images.length > 0 && allSavedAttachments.length > 0
        ? Math.min(allSavedAttachments.length, Math.max(4, Math.ceil(maxReviewImages * 0.35)))
        : allSavedAttachments.length;
      const freshLimit = images.length > 0
        ? Math.max(1, maxReviewImages - savedReserve)
        : 0;
      const freshSourceImages = images
        .filter((image) => image.media_type && image.data)
        .slice(0, freshLimit || maxReviewImages);
      const freshImagePayload = [];
      for (let imageIndex = 0; imageIndex < freshSourceImages.length; imageIndex += 1) {
        freshImagePayload.push(await prepareFreshImageForReview(freshSourceImages[imageIndex], imageIndex, {
          total: freshSourceImages.length,
          onProgress: setJobStatus,
        }));
      }
      let reusedSavedImages = [];
      let savedImageLoadWarning = "";
      const savedImageSlots = Math.max(0, maxReviewImages - freshImagePayload.length);
      if (savedImageSlots > 0) {
        const savedAttachments = allSavedAttachments.slice(0, savedImageSlots);
        const loaded = [];
        for (const attachment of savedAttachments) {
          try {
            loaded.push(await savedAttachmentToPayload(attachment));
          } catch (savedImageError) {
            savedImageLoadWarning = savedImageError?.message || "Some saved Profile Q&A images could not be reloaded.";
          }
        }
        reusedSavedImages = loaded.slice(0, savedImageSlots);
      }
      const imagePayload = [...freshImagePayload, ...reusedSavedImages]
        .slice(0, maxReviewImages)
        .map((image, index) => ({
          ...image,
          image_id: image.image_id || `img_${String(index + 1).padStart(3, "0")}`,
          display_label: image.display_label || `Reference view ${reviewImageLetter(index)}`,
        }));
      const hasFreshImages = freshImagePayload.length > 0;
      const hasImagePayload = imagePayload.length > 0;
      const hasReusedSavedImages = reusedSavedImages.length > 0;
      const groundingContext = isHeadToToeBodyReference ? "" : buildAIGroundingContext(reviewUserProfile);
      const imageReviewContext = isHeadToToeBodyReference
        ? buildHeadToToeImageReviewContext({ userProfile: reviewUserProfile, sessions, bodyExplorations, hasFreshImages, hasReusedSavedImages })
        : buildProfileImageReviewContext({ userProfile: reviewUserProfile, sessions, bodyExplorations });
      const firstNameToneCue = buildOptionalFirstNameToneCue(reviewUserProfile, { prioritizeProfileTone: true });
      const anatomicalFocusRule = isHeadToToeBodyReference ? "" : ANATOMICAL_REFERENCE_FOCUS_RULE;
      const sessionGroundingRule = isHeadToToeBodyReference ? "" : SESSION_CONTEXT_GROUNDING_RULE;
      const imagePresenceRules = hasImagePayload
        ? hasFreshImages && hasReusedSavedImages
          ? `COMBINED IMAGE REVIEW DIRECTIVE - HIGHEST PRIORITY:
- ${freshImagePayload.length} fresh image${freshImagePayload.length === 1 ? " is" : "s are"} attached as new direct visual evidence.
- ${reusedSavedImages.length} saved Profile Q&A image${reusedSavedImages.length === 1 ? " has" : "s have"} also been reloaded and attached as direct saved visual evidence.
- Review the complete attached image set as one combined profile-reference set. Fresh images enhance and update the existing profile; they do not replace the saved baseline.
- Do not say prior photos are unavailable, that direct re-examination is not occurring, or that the review is based only on the newest images.
- Reconcile fresh images, reused saved images, saved Profile Q&A findings, prior Sarah visual reviews, session/body-exploration evidence, and entered measurements into one coherent whole-picture analysis.`
          : hasReusedSavedImages
            ? `SAVED IMAGE REUSE DIRECTIVE - HIGHEST PRIORITY:
- ${imagePayload.length} saved Profile Q&A image${imagePayload.length === 1 ? " has" : "s have"} been reloaded and attached to this request.
- Review these saved images directly as reused profile evidence. They are not new uploads, but they are available to inspect in this run.
- Do not say the prior photos are unavailable or that direct image review is not occurring.
- Reconcile these saved images with saved Profile Q&A findings, prior Sarah visual reviews, session/body-exploration evidence, and entered measurements.`
            : `FRESH IMAGE DIRECTIVE - HIGHEST PRIORITY:
- ${imagePayload.length} fresh image${imagePayload.length === 1 ? " is" : "s are"} attached to this request and included in the model message.
- Review those attached image${imagePayload.length === 1 ? "" : "s"} directly as new direct visual evidence, but do not let them replace the saved baseline.
- Do not say "no fresh images are attached", "no fresh images are available", or "direct re-examination is not occurring."
- Existing saved evidence remains active evidence. Treat fresh uploads as additive evidence that can refine, extend, or correct the existing profile, not as a standalone replacement review.`
        : `SAVED EVIDENCE DIRECTIVE:
- No fresh or reusable saved image payload is attached to this request.
- Use previously reviewed/saved Profile Q&A visual findings, session/body-exploration visual findings, entered metrics, and saved media digests as the evidence base.
- Say "saved reviewed evidence" or "previously reviewed evidence" instead of implying the profile has no images.
- Do not frame additional photos as required; list them only as optional ways to improve coverage.`;
      const reviewedImageRefs = buildImageReviewReferences(imagePayload);
      const responseSchema = profileImageReviewResponseSchema(config);
      let raw;
      if (imagePayload.length > 0) {
        const imageBatches = chunkArray(imagePayload, PROFILE_IMAGE_REVIEW_BATCH_SIZE);
        const batchRequests = imageBatches.map((batchImages, batchIndex) => ({
          model: "claude_sonnet_4_6",
          max_tokens: PROFILE_IMAGE_REVIEW_MAX_TOKENS,
          attempts: 3,
          images: batchImages.map((image) => ({
            filename: `${image.image_id || "profile_reference"}.jpg`,
            media_type: image.media_type,
            data: image.data,
          })),
          prompt: `You are Sarah, performing one batch of a larger PulsePoint profile image review.

Review type: ${config.title}
Review purpose: ${config.purpose}
Batch: ${batchIndex + 1} of ${imageBatches.length}
Images in this batch: ${batchImages.length}
Total images in full review: ${imagePayload.length}
Attached fresh image count in full review: ${freshImagePayload.length}.
Attached reused saved image count in full review: ${reusedSavedImages.length}.
${savedImageLoadWarning ? `Saved image reuse warning: ${savedImageLoadWarning}` : ""}

${groundingContext}
${imageReviewContext}
${imagePresenceRules}
${anatomicalFocusRule}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${sessionGroundingRule}
${PROFILE_IMAGE_EVIDENCE_LAYER_RULE}
${PROFILE_IMAGE_VISIBLE_FINDINGS_FIRST_RULE}
${PROFILE_IMAGE_INSIGHT_EFFICIENCY_RULE}
${PROFILE_IMAGE_CUMULATIVE_SCOPE_RULE}

This is a batch review, not the final user-facing synthesis. Analyze only the attached images in this batch as direct visual evidence, while preserving the image_id values exactly. Do not mention filenames, storage IDs, camera-roll IDs, or raw image numbers. Do not claim that images outside this batch were inspected in this batch. Keep view labels anatomical and practical.

${config.reviewInstructions}

Attached image reference IDs for this batch:
${imageReviewReferencePromptLines(batchImages)}

USER IMAGE NOTE RULES:
- User notes on attached images are context for orientation, focus, or comparison. Use them to guide attention, but do not quote them verbatim unless the wording itself matters.
- If a user note identifies a target area, check that area directly and report the visible finding, not the note as evidence by itself.

ANNOTATED IMAGE OUTPUT RULES:
- Return annotated_images and image_region_findings for directly reviewed images in this batch.
- Use image_id values exactly as listed above.
- Do not call close-up pelvic/genital/table-position frames standing or upright unless the image itself establishes weight-bearing standing posture.
- In close-up perineal or scrotal-base views, do not label shaft, glans, or ventral shaft surface as visible unless that anatomy is clearly in frame. If only the superior edge or scrotal-base transition is visible, say possible superior shaft-base/scrotal-base edge and mark the limitation.
- For tiny structures or ambiguous findings such as meatus, meatal fluid/droplet, urethral fluid, device insertion, catheter/Foley presence, or fine tissue margins, use possible/uncertain unless the structure is unambiguous at the pin or box location.
- Keep paragraphs complete and TTS-ready. Return structured JSON only.`,
          response_json_schema: responseSchema,
        }));
        const synthesisRequest = {
          model: "claude_sonnet_4_6",
          max_tokens: PROFILE_IMAGE_REVIEW_MAX_TOKENS,
          attempts: 3,
          response_json_schema: responseSchema,
          promptPrefix: `You are Sarah, synthesizing a final PulsePoint profile image review from completed image-review batch JSON.

Review type: ${config.title}
Review purpose: ${config.purpose}
Directly rechecked image subset across batches: ${imagePayload.length}
Batch count: ${imageBatches.length}

No fresh images are attached to this synthesis pass because the direct visual re-check already occurred in the batch passes. Treat the batch JSON below as directly reviewed visual evidence, then integrate it with saved profile/session context. Produce ONE final cumulative user-facing review, not a batch-by-batch report and not a review limited to the image subset.

${groundingContext}
${imageReviewContext}
${anatomicalFocusRule}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${sessionGroundingRule}
${PROFILE_IMAGE_EVIDENCE_LAYER_RULE}
${PROFILE_IMAGE_VISIBLE_FINDINGS_FIRST_RULE}
${PROFILE_IMAGE_INSIGHT_EFFICIENCY_RULE}
${PROFILE_IMAGE_CUMULATIVE_SCOPE_RULE}

SYNTHESIS RULES:
- Do not mention filenames, camera-roll IDs, storage IDs, or raw image numbers.
- Do not say only five images were reviewed, and do not frame the whole artifact as "based on ${imagePayload.length} images." The direct image subset contains ${imagePayload.length} images across ${imageBatches.length} batches, but the review scope is the cumulative saved profile evidence base.
- Do not let the newest batch dominate the final review. Synthesize all batch results plus saved profile/session context into one whole-profile analysis.
- Treat fresh images as additive updates to the saved baseline, not as a reset of prior anatomical/profile evidence.
- Integrate the views naturally into the anatomy sections.
- Preserve direct visual evidence versus profile-context reconciliation versus interpretation.
- Keep the output clinically rich, practical, non-erotic, and TTS-ready.
- Preserve useful annotated_images and image_region_findings using image_id values from the batch results.

${config.reviewInstructions}

Batch review JSON:`,
          promptSuffix: "",
        };
        const startedFullJob = await startProfileImageReviewFullJob({
          mode: "batch",
          reviewType: config.kind,
          reviewTitle: config.title,
          sections: profileReviewResultSections(config),
          batchRequests,
          synthesisRequest,
          fallbackOverview: `${config.shortTitle} visible anatomy review.`,
        }, jobLabel, {
          priority: 50,
          meta: {
            reviewType: config.kind,
            reviewed_images: reviewedImageRefs,
            image_count: imagePayload.length,
            fresh_image_count: freshImagePayload.length,
            reused_saved_image_count: reusedSavedImages.length,
            full_background_review: true,
          },
        });
        setJobStatus({
          ...startedFullJob,
          progress: {
            ...(startedFullJob.progress || {}),
            phase: "queued",
            current: 0,
            total: imageBatches.length + 1,
            message: `Queued full ${config.shortTitle} review as one priority backend job. You can leave this page; reopen later to recover the completed output.`,
          },
        });
        setLoading(false);
        setError("");
        return;
        setJobStatus({
          status: "running",
          progress: {
            phase: "batching",
            current: 0,
            total: imageBatches.length + 1,
            message: `Queueing ${imagePayload.length} images in ${imageBatches.length} server-side batches. Keep the app open until all batches are queued; after that the desktop backend can continue the work.`,
          },
        });

        const batchJobs = [];
        for (let batchIndex = 0; batchIndex < imageBatches.length; batchIndex += 1) {
          const batchImages = imageBatches[batchIndex];
          const batchLabel = `${jobLabel} batch ${batchIndex + 1}/${imageBatches.length}`;
          const startedBatchJob = await startProfilerAIJob({
            model: "claude_sonnet_4_6",
            max_tokens: PROFILE_IMAGE_REVIEW_MAX_TOKENS,
            attempts: 3,
            images: batchImages.map((image) => ({
              filename: `${image.image_id || "profile_reference"}.jpg`,
              media_type: image.media_type,
              data: image.data,
            })),
            prompt: `You are Sarah, performing one batch of a larger PulsePoint profile image review.

Review type: ${config.title}
Review purpose: ${config.purpose}
Batch: ${batchIndex + 1} of ${imageBatches.length}
Images in this batch: ${batchImages.length}
Total images in full review: ${imagePayload.length}
Attached fresh image count in full review: ${freshImagePayload.length}.
Attached reused saved image count in full review: ${reusedSavedImages.length}.
${savedImageLoadWarning ? `Saved image reuse warning: ${savedImageLoadWarning}` : ""}

${groundingContext}
${imageReviewContext}
${imagePresenceRules}
${anatomicalFocusRule}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${sessionGroundingRule}
${PROFILE_IMAGE_EVIDENCE_LAYER_RULE}
${PROFILE_IMAGE_VISIBLE_FINDINGS_FIRST_RULE}
${PROFILE_IMAGE_INSIGHT_EFFICIENCY_RULE}
${PROFILE_IMAGE_CUMULATIVE_SCOPE_RULE}

This is a batch review, not the final user-facing synthesis. Analyze only the attached images in this batch as direct visual evidence, while preserving the image_id values exactly. Do not mention filenames, storage IDs, camera-roll IDs, or raw image numbers. Do not claim that images outside this batch were inspected in this batch. Keep view labels anatomical and practical.

${config.reviewInstructions}

Attached image reference IDs for this batch:
${imageReviewReferencePromptLines(batchImages)}

USER IMAGE NOTE RULES:
- User notes on attached images are context for orientation, focus, or comparison. Use them to guide attention, but do not quote them verbatim unless the wording itself matters.
- If a user note identifies a target area, check that area directly and report the visible finding, not the note as evidence by itself.

ANNOTATED IMAGE OUTPUT RULES:
- Return annotated_images and image_region_findings for directly reviewed images in this batch.
- Use image_id values exactly as listed above.
- Do not call close-up pelvic/genital/table-position frames standing or upright unless the image itself establishes weight-bearing standing posture.
- In close-up perineal or scrotal-base views, do not label shaft, glans, or ventral shaft surface as visible unless that anatomy is clearly in frame. If only the superior edge or scrotal-base transition is visible, say possible superior shaft-base/scrotal-base edge and mark the limitation.
- For tiny structures or ambiguous findings such as meatus, meatal fluid/droplet, urethral fluid, device insertion, catheter/Foley presence, or fine tissue margins, use possible/uncertain unless the structure is unambiguous at the pin or box location.
- Keep paragraphs complete and TTS-ready. Return structured JSON only.`,
            response_json_schema: responseSchema,
          }, batchLabel, {
            priority: 30,
            meta: {
              reviewType: config.kind,
              batch: batchIndex + 1,
              batch_count: imageBatches.length,
              reviewed_images: buildImageReviewReferences(batchImages),
              image_count: batchImages.length,
              full_review_image_count: imagePayload.length,
              fresh_image_count: freshImagePayload.length,
              reused_saved_image_count: reusedSavedImages.length,
            },
          });
          batchJobs.push({ job: startedBatchJob, batchIndex, batchImages, batchLabel });
          setJobStatus({
            ...startedBatchJob,
            progress: {
              ...(startedBatchJob.progress || {}),
              phase: "batch_queued",
              current: batchIndex + 1,
              total: imageBatches.length,
              message: `Queued ${batchIndex + 1}/${imageBatches.length} ${config.shortTitle} image batches. Server jobs can continue if Android backgrounds the app.`,
            },
          });
        }

        for (const batchJob of batchJobs) {
          const { job, batchIndex, batchImages } = batchJob;
          const completedBatchJob = await waitProfilerAIJob(job, (nextJob) => {
            setJobStatus({
              ...nextJob,
              progress: {
                ...(nextJob.progress || {}),
                batch_current: batchIndex + 1,
                batch_total: imageBatches.length,
              },
            });
          });
          const batchReviewedImages = buildImageReviewReferences(batchImages);
          const batchParsed = remapBatchLocalImageIds(
            normalizeImageReviewResult(typeof completedBatchJob.result === "string" ? JSON.parse(completedBatchJob.result) : completedBatchJob.result),
            batchReviewedImages,
          );
          if (batchParsed?.overview) batchParsedResults.push(batchParsed);
        }

        if (!batchParsedResults.length) throw new Error("Sarah returned empty image review batches.");
        activeBatchSet = {
          total: imageBatches.length,
          batches: batchParsedResults.map((batchResult, index) => ({
            id: `current-batch-${index + 1}`,
            status: "complete",
            result: batchResult,
            meta: {
              batch: index + 1,
              batch_count: imageBatches.length,
              reviewed_images: buildImageReviewReferences(imageBatches[index] || []),
            },
          })),
          reviewed_images: reviewedImageRefs,
          fresh_image_count: freshImagePayload.length,
          reused_saved_image_count: reusedSavedImages.length,
          image_count: imagePayload.length,
          final_synthesis_attempted: false,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
        await saveBatchAssembledReview(
          batchParsedResults,
          "Batch reviews completed and were saved as the current review. Final synthesis is available as an optional retry without rerunning image review.",
          activeBatchSet,
          {
            state: "batch_reviews_saved_without_final_synthesis",
            timestamp: new Date().toISOString(),
            synthesis_stage: "batch_level_review_complete",
            batch_reviews_completed: true,
            older_saved_review_showing: false,
            latest_batch_findings_available: true,
            batch_count: imageBatches.length,
            final_synthesis_attempted: false,
          },
          { showErrorNotice: false, keepRecoverableBatchSet: true },
        );
        setRecoverableBatchSet(activeBatchSet);
        setLoading(false);
        setJobStatus({
          status: "complete",
          progress: {
            phase: "complete",
            current: imageBatches.length + 1,
            total: imageBatches.length + 1,
            message: `${config.shortTitle} batch review complete. Saved assembled batch findings; final synthesis is optional.`,
          },
        });
        return;
        raw = await runProfilerAIJob({
          model: "claude_sonnet_4_6",
          max_tokens: PROFILE_IMAGE_REVIEW_MAX_TOKENS,
          attempts: 3,
          prompt: `You are Sarah, synthesizing a final PulsePoint profile image review from completed image-review batch JSON.

Review type: ${config.title}
Review purpose: ${config.purpose}
Directly rechecked image subset across batches: ${imagePayload.length}
Batch count: ${batchParsedResults.length}

No fresh images are attached to this synthesis pass because the direct visual re-check already occurred in the batch passes. Treat the batch JSON below as directly reviewed visual evidence, then integrate it with saved profile/session context. Produce ONE final cumulative user-facing review, not a batch-by-batch report and not a review limited to the image subset.

${groundingContext}
${imageReviewContext}
${anatomicalFocusRule}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${sessionGroundingRule}
${PROFILE_IMAGE_EVIDENCE_LAYER_RULE}
${PROFILE_IMAGE_VISIBLE_FINDINGS_FIRST_RULE}
${PROFILE_IMAGE_INSIGHT_EFFICIENCY_RULE}
${PROFILE_IMAGE_CUMULATIVE_SCOPE_RULE}

SYNTHESIS RULES:
- Do not mention filenames, camera-roll IDs, storage IDs, or raw image numbers.
- Do not say only five images were reviewed, and do not frame the whole artifact as "based on ${imagePayload.length} images." The direct image subset contains ${imagePayload.length} images across ${batchParsedResults.length} batches, but the review scope is the cumulative saved profile evidence base.
- Do not let the newest batch dominate the final review. Synthesize all batch results plus saved profile/session context into one whole-profile analysis.
- Treat fresh images as additive updates to the saved baseline, not as a reset of prior anatomical/profile evidence.
- Integrate the views naturally into the anatomy sections.
- Preserve direct visual evidence versus profile-context reconciliation versus interpretation.
- Keep the output clinically rich, practical, non-erotic, and TTS-ready.
- Preserve useful annotated_images and image_region_findings using image_id values from the batch results.

${config.reviewInstructions}

Batch review JSON:
${JSON.stringify(batchParsedResults.map(compactImageReviewForSynthesis), null, 2)}`,
          response_json_schema: responseSchema,
        }, `${jobLabel} final synthesis`, setJobStatus, {
          priority: 30,
          meta: {
            reviewType: config.kind,
            batch_count: imageBatches.length,
            reviewed_images: reviewedImageRefs,
            image_count: imagePayload.length,
            fresh_image_count: freshImagePayload.length,
            reused_saved_image_count: reusedSavedImages.length,
            synthesis: true,
          },
        });
      } else {
        const singlePrompt = `You are Sarah, performing a dedicated profile image review for PulsePoint.

Review type: ${config.title}
Review purpose: ${config.purpose}
Attached fresh image count: ${freshImagePayload.length}.
Attached reused saved image count: ${reusedSavedImages.length}.
${savedImageLoadWarning ? `Saved image reuse warning: ${savedImageLoadWarning}` : ""}

${groundingContext}
${imageReviewContext}
${imagePresenceRules}
${anatomicalFocusRule}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${sessionGroundingRule}
${PROFILE_IMAGE_EVIDENCE_LAYER_RULE}
${PROFILE_IMAGE_VISIBLE_FINDINGS_FIRST_RULE}
${PROFILE_IMAGE_INSIGHT_EFFICIENCY_RULE}
${PROFILE_IMAGE_CUMULATIVE_SCOPE_RULE}

IMAGE REVIEW RULES:
- Treat these as consensual private profile-reference images for anatomical and physiological review.
- If fresh images are attached to this request, analyze what is visible in those images as new direct evidence, then integrate it into the existing saved profile/image evidence. Do not make the newest image set the whole story unless it is the only evidence available.
- If saved Profile Q&A images are reloaded into this request, analyze them directly as saved/reused visual evidence and reconcile them with saved findings.
- If no image payload is attached, analyze the existing uploaded/reviewed evidence from Q&A, sessions, body exploration sessions, entered metrics, and saved media findings. Say "previously reviewed evidence" rather than implying the profile has no images.
- Produce a whole-picture cumulative review: current attached images, reloaded saved images, saved Profile Q&A findings, prior Sarah visual reviews, session/body-exploration evidence, and entered profile metrics should enhance one another instead of replacing one another.
- Use existing Q&A findings, entered profile metrics, and session/video/body-exploration evidence as context, not as permission to invent visible findings.
- Keep this artifact focused on anatomical/media-reference evidence. Do not expand into broad personal history, psychological backstory, reclaiming/history framing, whole-life meaning, or session optimization unless it directly explains a visible anatomical, mechanical, device-fit, safety, or session-specific physiological finding.
- Do not eroticize the image or write arousal-focused prose.
- Do not infer identity, diagnosis, pathology, intent, pain, force, or sexual activity.
- If image quality, angle, lighting, posture, tissue state, cropping, or camera distortion limits confidence, say so clearly.
- Use anatomical terminology naturally and clinically.
- Write directly to the person using "you" and "your".
- Separate direct visual observations from cautious profile implications.
- Prefer specific observations over generic filler.
- Preserve uncertainty, but keep it lean. Use "appears", "is visible", "may reflect", or "not visible in this specific view" where appropriate.
- Do not mention uploaded filenames, storage IDs, camera roll numbers, or raw image numbers in the user-facing review.
- When distinguishing views, use plain view labels such as anterior standing view, posterior standing view, lateral view, table-position view, close-up pelvic view, or saved image set.
- Do not write paragraphs that begin "Image 1", "Image 2", or a filename. Integrate the views into the anatomy sections naturally.

${config.reviewInstructions}

Return a detailed structured review. Keep each paragraph TTS-ready: complete sentences, no markdown bullets, no clipped fragments.

Fresh uploaded images attached for this run:
${freshImagePayload.length ? `- ${freshImagePayload.length} fresh image${freshImagePayload.length === 1 ? "" : "s"} attached. Use plain view labels in the review, not filenames.` : "- None."}

Reused saved Profile Q&A images attached for this run:
${hasReusedSavedImages ? `- ${reusedSavedImages.length} saved image${reusedSavedImages.length === 1 ? "" : "s"} reloaded. Use plain view labels in the review, not filenames.` : "- None attached. Use saved reviewed findings and entered metrics."}

Attached image reference IDs for structured callouts:
${imageReviewReferencePromptLines(imagePayload)}

USER IMAGE NOTE RULES:
- User notes on attached images are context for orientation, focus, or comparison. Use them to guide attention, but do not quote them verbatim unless the wording itself matters.
- If a user note identifies a target area, check that area directly and report the visible finding, not the note as evidence by itself.

ANNOTATED IMAGE OUTPUT RULES:
- Also return annotated_images and image_region_findings when direct image payload is attached.
- Use image_id values exactly as listed above.
- Use natural clinical view labels such as anterior standing view, right lateral standing view, posterior standing view, supine/table-position view, lithotomy pelvic view, close-up pelvic view, perineal view, or genital close-up.
- Do not call a close-up pelvic/genital/table-position frame "standing" or "upright" unless the image itself establishes weight-bearing standing posture. If posture is ambiguous, say position not fully assessable from this close-up.
- Do not put filenames, storage IDs, camera roll IDs, or raw image numbers in annotated_images, image_region_findings, or the prose review.
- image_region_findings should be concise, clinically useful callouts linked to the same sections used in the prose.
- In close-up perineal or scrotal-base views, do not label shaft, glans, or ventral shaft surface as visible unless that anatomy is clearly in frame. If only the superior edge or scrotal-base transition is visible, say possible superior shaft-base/scrotal-base edge and mark the limitation.
- For pin and box coordinates, use approximate percentages from zero to one hundred with origin at the top-left of the displayed image. Only include pin or box when the location is reasonably clear; otherwise omit that field.
- Callouts should stay anatomical and evidence-grounded: body region, visible posture/alignment, habitus/soft tissue, skin/surface finding, tissue state, visibility limitation, or clinical reference value.
- For tiny structures or ambiguous findings such as meatus, meatal fluid/droplet, urethral fluid, device insertion, catheter/Foley presence, or fine tissue margins, use possible/uncertain unless the structure is unambiguous at the pin or box location.
- For genital/pelvic regions, use neutral anatomical terms and do not infer arousal, pleasure, pain, intent, or function unless directly visible and relevant.`;
        const startedFullJob = await startProfileImageReviewFullJob({
          mode: "single",
          reviewType: config.kind,
          reviewTitle: config.title,
          sections: profileReviewResultSections(config),
          singleRequest: {
            model: "claude_sonnet_4_6",
            max_tokens: PROFILE_IMAGE_REVIEW_MAX_TOKENS,
            attempts: 3,
            ...(imagePayload.length ? {
              images: imagePayload.map((image) => ({
                filename: `${image.image_id || "profile_reference"}.jpg`,
                media_type: image.media_type,
                data: image.data,
              })),
            } : {}),
            prompt: singlePrompt,
            response_json_schema: responseSchema,
          },
        }, jobLabel, {
          priority: 50,
          meta: {
            reviewType: config.kind,
            reviewed_images: reviewedImageRefs,
            fresh_image_count: freshImagePayload.length,
            reused_saved_image_count: reusedSavedImages.length,
            image_count: imagePayload.length,
            full_background_review: true,
          },
        });
        setJobStatus({
          ...startedFullJob,
          progress: {
            ...(startedFullJob.progress || {}),
            phase: "queued",
            current: 0,
            total: 1,
            message: `Queued full ${config.shortTitle} review as one priority backend job. You can leave this page; reopen later to recover the completed output.`,
          },
        });
        setLoading(false);
        setError("");
        return;
        raw = await runProfilerAIJob({
        model: "claude_sonnet_4_6",
        max_tokens: PROFILE_IMAGE_REVIEW_MAX_TOKENS,
        attempts: 3,
        ...(imagePayload.length ? {
          images: imagePayload.map((image) => ({
            filename: `${image.image_id || "profile_reference"}.jpg`,
            media_type: image.media_type,
            data: image.data,
          })),
        } : {}),
        prompt: `You are Sarah, performing a dedicated profile image review for PulsePoint.

Review type: ${config.title}
Review purpose: ${config.purpose}
Attached fresh image count: ${freshImagePayload.length}.
Attached reused saved image count: ${reusedSavedImages.length}.
${savedImageLoadWarning ? `Saved image reuse warning: ${savedImageLoadWarning}` : ""}

${groundingContext}
${imageReviewContext}
${imagePresenceRules}
${anatomicalFocusRule}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${sessionGroundingRule}
${PROFILE_IMAGE_EVIDENCE_LAYER_RULE}
${PROFILE_IMAGE_VISIBLE_FINDINGS_FIRST_RULE}
${PROFILE_IMAGE_INSIGHT_EFFICIENCY_RULE}
${PROFILE_IMAGE_CUMULATIVE_SCOPE_RULE}

IMAGE REVIEW RULES:
- Treat these as consensual private profile-reference images for anatomical and physiological review.
- If fresh images are attached to this request, analyze what is visible in those images as new direct evidence, then integrate it into the existing saved profile/image evidence. Do not make the newest image set the whole story unless it is the only evidence available.
- If saved Profile Q&A images are reloaded into this request, analyze them directly as saved/reused visual evidence and reconcile them with saved findings.
- If no image payload is attached, analyze the existing uploaded/reviewed evidence from Q&A, sessions, body exploration sessions, entered metrics, and saved media findings. Say "previously reviewed evidence" rather than implying the profile has no images.
- Produce a whole-picture cumulative review: current attached images, reloaded saved images, saved Profile Q&A findings, prior Sarah visual reviews, session/body-exploration evidence, and entered profile metrics should enhance one another instead of replacing one another.
- Use existing Q&A findings, entered profile metrics, and session/video/body-exploration evidence as context, not as permission to invent visible findings.
- Keep this artifact focused on anatomical/media-reference evidence. Do not expand into broad personal history, psychological backstory, reclaiming/history framing, whole-life meaning, or session optimization unless it directly explains a visible anatomical, mechanical, device-fit, safety, or session-specific physiological finding.
- Do not eroticize the image or write arousal-focused prose.
- Do not infer identity, diagnosis, pathology, intent, pain, force, or sexual activity.
- If image quality, angle, lighting, posture, tissue state, cropping, or camera distortion limits confidence, say so clearly.
- Use anatomical terminology naturally and clinically.
- Write directly to the person using "you" and "your".
- Separate direct visual observations from cautious profile implications.
- Prefer specific observations over generic filler.
- Preserve uncertainty, but keep it lean. Use "appears", "is visible", "may reflect", or "not visible in this specific view" where appropriate.
- Do not mention uploaded filenames, storage IDs, camera roll numbers, or raw image numbers in the user-facing review.
- When distinguishing views, use plain view labels such as anterior standing view, posterior standing view, lateral view, table-position view, close-up pelvic view, or saved image set.
- Do not write paragraphs that begin "Image 1", "Image 2", or a filename. Integrate the views into the anatomy sections naturally.

${config.reviewInstructions}

Return a detailed structured review. Keep each paragraph TTS-ready: complete sentences, no markdown bullets, no clipped fragments.

Fresh uploaded images attached for this run:
${freshImagePayload.length ? `- ${freshImagePayload.length} fresh image${freshImagePayload.length === 1 ? "" : "s"} attached. Use plain view labels in the review, not filenames.` : "- None."}

Reused saved Profile Q&A images attached for this run:
${hasReusedSavedImages ? `- ${reusedSavedImages.length} saved image${reusedSavedImages.length === 1 ? "" : "s"} reloaded. Use plain view labels in the review, not filenames.` : "- None attached. Use saved reviewed findings and entered metrics."}

Attached image reference IDs for structured callouts:
${imageReviewReferencePromptLines(imagePayload)}

USER IMAGE NOTE RULES:
- User notes on attached images are context for orientation, focus, or comparison. Use them to guide attention, but do not quote them verbatim unless the wording itself matters.
- If a user note identifies a target area, check that area directly and report the visible finding, not the note as evidence by itself.

ANNOTATED IMAGE OUTPUT RULES:
- Also return annotated_images and image_region_findings when direct image payload is attached.
- Use image_id values exactly as listed above.
- Use natural clinical view labels such as anterior standing view, right lateral standing view, posterior standing view, supine/table-position view, lithotomy pelvic view, close-up pelvic view, perineal view, or genital close-up.
- Do not call a close-up pelvic/genital/table-position frame "standing" or "upright" unless the image itself establishes weight-bearing standing posture. If posture is ambiguous, say position not fully assessable from this close-up.
- Do not put filenames, storage IDs, camera roll IDs, or raw image numbers in annotated_images, image_region_findings, or the prose review.
- image_region_findings should be concise, clinically useful callouts linked to the same sections used in the prose.
- In close-up perineal or scrotal-base views, do not label shaft, glans, or ventral shaft surface as visible unless that anatomy is clearly in frame. If only the superior edge or scrotal-base transition is visible, say possible superior shaft-base/scrotal-base edge and mark the limitation.
- For pin and box coordinates, use approximate percentages from zero to one hundred with origin at the top-left of the displayed image. Only include pin or box when the location is reasonably clear; otherwise omit that field.
- Callouts should stay anatomical and evidence-grounded: body region, visible posture/alignment, habitus/soft tissue, skin/surface finding, tissue state, visibility limitation, or clinical reference value.
- For tiny structures or ambiguous findings such as meatus, meatal fluid/droplet, urethral fluid, device insertion, catheter/Foley presence, or fine tissue margins, use possible/uncertain unless the structure is unambiguous at the pin or box location.
- For genital/pelvic regions, use neutral anatomical terms and do not infer arousal, pleasure, pain, intent, or function unless directly visible and relevant.`,
        response_json_schema: {
          type: "object",
          properties: {
            overview: { type: "string" },
            summary_card: {
              type: "object",
              properties: {
                baseline_quality: { type: "string" },
                coverage: { type: "string" },
                primary_reference_value: { type: "array", items: { type: "string" } },
                key_direct_findings: { type: "array", items: { type: "string" } },
                key_limitations: { type: "array", items: { type: "string" } },
                evidence_note: { type: "string" },
              },
            },
            ...Object.fromEntries(profileReviewResultSections(config).map((section) => [section.key, { type: "array", items: { type: "string" } }])),
            annotated_images: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  image_id: { type: "string" },
                  view_label: { type: "string" },
                  body_position: { type: "string" },
                  coverage: { type: "string" },
                  visibility_notes: { type: "string" },
                  major_regions_visible: { type: "array", items: { type: "string" } },
                },
                required: ["image_id", "view_label", "coverage", "visibility_notes"],
              },
            },
            image_region_findings: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  finding_id: { type: "string" },
                  image_id: { type: "string" },
                  section_key: { type: "string" },
                  region: { type: "string" },
                  label: { type: "string" },
                  finding: { type: "string" },
                  confidence: { type: "string" },
                  visibility: { type: "string" },
                  evidence_level: { type: "string" },
                  limitations: { type: "array", items: { type: "string" } },
                  pin: {
                    type: "object",
                    properties: {
                      x: { type: "number" },
                      y: { type: "number" },
                    },
                  },
                  box: {
                    type: "object",
                    properties: {
                      x: { type: "number" },
                      y: { type: "number" },
                      width: { type: "number" },
                      height: { type: "number" },
                    },
                  },
                },
                required: ["finding_id", "image_id", "region", "label", "finding", "confidence"],
              },
            },
          },
          required: ["overview", ...profileReviewResultSections(config).filter((section) => section.required !== false).map((section) => section.key)],
        },
      }, jobLabel, setJobStatus, {
        priority: 30,
        meta: {
          reviewType: config.kind,
          reviewed_images: reviewedImageRefs,
          fresh_image_count: freshImagePayload.length,
          reused_saved_image_count: reusedSavedImages.length,
          image_count: imagePayload.length,
        },
      });
      }
      const parsed = mergeImageReviewBatchArtifacts(
        normalizeImageReviewResult(typeof raw === "string" ? JSON.parse(raw) : raw),
        batchParsedResults,
      );
      if (!parsed?.overview) throw new Error("Sarah returned an empty image review.");
      const storedResult = {
        ...parsed,
        _meta: buildImageReviewMeta(imagePayload, sessions, result?._meta, visualEvidence.counts, null, null, {
          fresh_image_count: freshImagePayload.length,
          reused_saved_image_count: reusedSavedImages.length,
          image_count: imagePayload.length,
        }),
      };
      setResult(storedResult);
      const nextArchive = await saveProfileResultWithArchive({
        resultKey: config.resultKey,
        archiveKey: config.archiveKey,
        kind: config.kind,
        label: config.title,
        result: storedResult,
        sessionCount: sessions.length,
      });
      setArchive(nextArchive);
    } catch (err) {
      console.error(`${config.title} failed:`, err);
      if (/timed out|timeout|request timed out/i.test(err?.message || "") && batchParsedResults.length) {
        try {
          setLatestAttemptStatus({
            state: "latest_final_synthesis_failed",
            timestamp: new Date().toISOString(),
            error_message: err?.message || "Final synthesis timed out.",
            synthesis_stage: "final_synthesis",
            batch_reviews_completed: true,
            batch_count: activeBatchSet?.total || batchParsedResults.length,
            older_saved_review_showing: Boolean(result),
            latest_batch_findings_available: true,
          });
          await saveBatchAssembledReview(
            batchParsedResults,
            "Batch reviews completed, but final synthesis timed out. PulsePoint saved the latest batch findings as an interim review without rerunning image review.",
            activeBatchSet,
          );
          return;
        } catch (assembleError) {
          console.error(`${config.title} immediate timeout fallback assembly failed:`, assembleError);
        }
      }
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const sections = profileReviewResultSections(config);
  const visualEvidence = buildExistingVisualEvidenceDigest({ sessions, bodyExplorations });
  const existingEvidenceCount = Object.values(visualEvidence.counts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const reusableProfileAttachments = collectSavedProfileImageAttachments(userProfile, {
    limit: 99,
    purpose: config.contextScope === "head_to_toe_body_reference" ? "head_to_toe_body_reference" : "pelvic_genital",
  });
  const fallbackReferenceImages = reusableProfileAttachments.map((attachment, index) => ({
    image_id: `img_${String(index + 1).padStart(3, "0")}`,
    previewUrl: attachment.url,
    storagePath: attachment.url,
    display_label: `Saved Profile Q&A view ${reviewImageLetter(index)}`,
    source: "saved_profile_qa_attachment",
  }));
  const hasPersistedReviewedImages = Array.isArray(result?._meta?.reviewed_images) && result._meta.reviewed_images.length > 0;
  const inlineReferenceImages = hasPersistedReviewedImages ? images : [...images, ...fallbackReferenceImages];
  const lightboxImageIds = result ? [...new Set([
    ...(Array.isArray(result?._meta?.reviewed_images) ? result._meta.reviewed_images.map((image) => image.image_id).filter(Boolean) : []),
    ...(Array.isArray(result?.annotated_images) ? result.annotated_images.map((image) => image.image_id).filter(Boolean) : []),
    ...(Array.isArray(result?.image_region_findings) ? result.image_region_findings.map((finding) => finding.image_id).filter(Boolean) : []),
  ])] : [];
  const paragraphs = [];
  const paragraphMeta = [];
  if (result) {
    paragraphs.push(calmSpokenHeading(config.title));
    paragraphMeta.push({ type: "title", color: config.color, displayLabel: config.title });
    for (const section of sections) {
      if ((result[section.key] || []).length) {
        paragraphs.push(calmSpokenHeading(section.label));
        paragraphMeta.push({ type: "section-title", section, displayLabel: section.label });
        if (includeImageCalloutsInTts) {
          for (const calloutParagraph of imageCalloutNarrationParagraphs(result, section.key, inlineReferenceImages)) {
            paragraphs.push(calloutParagraph);
            paragraphMeta.push({ type: "visual-callout", section });
          }
        }
      }
      for (const finding of (result[section.key] || [])) {
        paragraphs.push(naturalizeSpokenDates(finding));
        paragraphMeta.push({ type: "section", section });
      }
    }
  }

  return (
    <SectionCard icon={config.icon} title={config.title} color={config.color} defaultCollapsed={true}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">{config.helper}</p>
          <div className="flex shrink-0 flex-wrap gap-2">
            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted/60">
              <Upload className="h-3.5 w-3.5" /> Add Images
              <input type="file" accept="image/*" multiple className="hidden" onChange={handleImageFiles} />
            </label>
            <Button size="sm" onClick={handlePrimaryReviewAction} disabled={loading || profileLoading || evidenceLoading || !userProfile} className="h-8 gap-1.5 text-xs">
              {loading
                ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />Reviewing...</>
                : <><ImageIcon className="h-3.5 w-3.5" />{hasRecoverableDisplayRepair ? "Refresh Findings" : (availableCompletedReviewJob || hasRecoverableUnshownBatchSet) ? "Show Latest Findings" : images.length ? (result ? "Re-review Images" : "Review Images") : (result ? "Re-review Evidence" : "Review Existing Evidence")}</>}
            </Button>
          </div>
        </div>

        {result && (
          <label className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={includeImageCalloutsInTts}
              onChange={(event) => setIncludeImageCalloutsInTts(event.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            <span>
              Include visual callouts in TTS/audio
              <span className="ml-1 text-muted-foreground">Screen callouts stay visible either way.</span>
            </span>
          </label>
        )}

        <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
          <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{existingEvidenceCount} saved visual/video evidence items</Badge>
          <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
            {reusableProfileAttachments.length} relevant reusable Profile Q&A images
          </Badge>
          <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{sessions.length} sessions loaded</Badge>
          {bodyExplorations.length > 0 && (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{bodyExplorations.length} body exploration sessions loaded</Badge>
          )}
          {images.length > 0 && (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{images.length} fresh image{images.length === 1 ? "" : "s"} selected</Badge>
          )}
          {recoverableBatchSet?.batches?.length > 0 && !result?._meta?.local_batch_assembled && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              {recoverableBatchSet.total}/{recoverableBatchSet.total} batches recoverable
            </Badge>
          )}
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">Priority background queue</Badge>
        </div>

        {recoverableBatchSet?.batches?.length > 0 && !result?._meta?.local_batch_assembled && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-50">
            {result?._meta?.local_batch_assembled
              ? "Batch reviews completed and are saved as the current review. The main review button will run a fresh review only when you ask for it."
              : latestAttemptStatus?.state === "batch_reviews_saved_without_final_synthesis"
                ? "Batch reviews completed and were saved as the current review. The main review button will run a fresh review only when you ask for it."
              : "Batch reviews completed, but the final rewrite did not finish. Press the main review button once to show the latest completed findings without rerunning image review."}
          </div>
        )}

        {(latestAttemptStatus || recoverableBatchSet?.batches?.length > 0) && !result?._meta?.local_batch_assembled && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-50">
            <p className="font-semibold uppercase tracking-wider">Latest Attempt Status</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div className="rounded-md border border-amber-300/20 bg-background/40 px-2 py-1.5">
                <p className="text-[10px] uppercase tracking-wider text-amber-100/80">Final Synthesis</p>
                <p>{result?._meta?.local_batch_assembled
                  ? "Current batch-assembled review is saved."
                  : latestAttemptStatus?.state === "batch_reviews_saved_without_final_synthesis"
                    ? "Not needed for current output; completed batch findings are saved."
                  : latestAttemptStatus?.error_message
                    ? `Failed: ${latestAttemptStatus.error_message}`
                    : "Completed batch findings can be shown from the main review button."}</p>
              </div>
              <div className="rounded-md border border-amber-300/20 bg-background/40 px-2 py-1.5">
                <p className="text-[10px] uppercase tracking-wider text-amber-100/80">Current Display</p>
                <p>{result?._meta?.local_batch_assembled
                  ? "Showing recovered latest batch findings assembled locally."
                  : result
                    ? "Showing previous final synthesis until retry or local assembly succeeds."
                    : "No previous final synthesis is available yet."}</p>
              </div>
              <div className="rounded-md border border-amber-300/20 bg-background/40 px-2 py-1.5">
                <p className="text-[10px] uppercase tracking-wider text-amber-100/80">Latest Batch Findings</p>
                <p>{recoverableBatchSet?.batches?.length ? `${recoverableBatchSet.total}/${recoverableBatchSet.total} completed batches available.` : "No completed batch set loaded."}</p>
              </div>
              <div className="rounded-md border border-amber-300/20 bg-background/40 px-2 py-1.5">
                <p className="text-[10px] uppercase tracking-wider text-amber-100/80">Next Action</p>
                <p>{result?._meta?.local_batch_assembled
                  ? "Use the main review button only when you want to run a fresh review."
                  : latestAttemptStatus?.state === "batch_reviews_saved_without_final_synthesis"
                  ? "The current batch-assembled review is already saved."
                  : "Press the main review button once to show the latest completed findings."}</p>
              </div>
            </div>
          </div>
        )}

        {result && (
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
            <span>{result?._meta?.last_generated_at ? `Generated ${formatGeneratedAt(result._meta.last_generated_at)}` : "Generated time unavailable"}</span>
            <span>Fresh images added this run: {result?._meta?.fresh_image_count ?? 0}</span>
            <span>Saved image views rechecked: {result?._meta?.reused_saved_image_count ?? 0}</span>
            {Array.isArray(result?._meta?.reviewed_images) && result._meta.reviewed_images.length > 0 && (
              <span>{result._meta.reviewed_images.length} direct view{result._meta.reviewed_images.length === 1 ? "" : "s"} linked into cumulative review</span>
            )}
          </div>
        )}

        {!result && (
          <ProfilerPanelLoadingStatus
            items={[
              { active: profileLoading, label: "Saved profile context", status: "loading" },
              { active: evidenceLoading, label: "Session and body-exploration evidence", status: "loading" },
            ]}
          />
        )}

        {!result && !profileLoading && !images.length && (
          <p className="text-xs text-muted-foreground">{config.emptyText}</p>
        )}

        {!result && images.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Fresh image files will be saved locally before review so the annotated evidence cards can show the referenced views after reload.
          </p>
        ) : !result && reusableProfileAttachments.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            No fresh images selected. This review will reuse the most relevant saved Profile Q&A images when they can be reloaded, then synthesize saved visual findings and profile evidence.
          </p>
        ) : null}

        {!result && !images.length && reusableProfileAttachments.length === 0 && existingEvidenceCount > 0 && (
          <p className="text-xs text-muted-foreground">
            Saved visual findings are available, but no reusable Profile Q&A image files were found in saved chat attachments.
          </p>
        )}

        {images.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {images.map((image) => (
              <div key={image.id} className="overflow-hidden rounded-lg border border-border bg-muted/20">
                <div className="relative aspect-[4/3] bg-black">
                  <img src={image.previewUrl} alt={image.filename} className="h-full w-full object-contain" />
                  <button
                    type="button"
                    onClick={() => removeImage(image.id)}
                    className="absolute right-1 top-1 rounded-full bg-background/85 p-1 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${image.filename}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="truncate px-2 py-1.5 text-[10px] text-muted-foreground">{image.filename}</p>
                <div className="border-t border-border px-2 py-2">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Image note
                  </label>
                  <textarea
                    value={image.upload_note || ""}
                    onChange={(event) => updateImageNote(image.id, event.target.value)}
                    rows={3}
                    placeholder="Optional context for Sarah: view, posture, scar/focus, what to compare..."
                    className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs leading-relaxed text-foreground outline-none focus:border-primary"
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        <CompactError message={error} />

        {loading && (
          <ProfilerJobStatus
            job={jobStatus}
            fallback={`${config.shortTitle} review is running in the background queue...`}
          />
        )}

        {result && (
          <TTSReader
            sessionId={config.ttsSessionId}
            title={config.title}
            sourceGeneratedAt={result?._meta?.last_generated_at}
            paragraphs={paragraphs}
            renderParagraph={(text, idx, isActive, _isBuffering, activeSentenceIdx, startFromSentence) => {
              const meta = paragraphMeta[idx];
              if (!meta) return null;
              if (meta.type === "title" || meta.type === "section-title") {
                const color = meta.section?.color || meta.color || config.color;
                const heading = (
                  <p
                    className="mt-4 border-t border-border pt-3 text-xs font-semibold transition-colors"
                    style={{ color, background: isActive ? `${color}18` : "transparent" }}
                  >
                    {meta.displayLabel || text}
                  </p>
                );
                if (meta.type === "section-title" && meta.section?.key) {
                  return (
                    <>
                      {heading}
                      <InlineImageEvidence
                        result={result}
                        sectionKey={meta.section.key}
                        sections={sections}
                        color={color}
                        transientImages={inlineReferenceImages}
                        onOpenImage={setSelectedProfilerImageId}
                        onCorrectFinding={saveImageFindingClarification}
                        onRemoveFinding={removeImageFindingCallout}
                      />
                    </>
                  );
                }
                return (
                  heading
                );
              }
              if (meta.type === "overview") {
                return (
                  <p
                    className="text-base font-medium leading-relaxed border-l-2 pl-3 py-1 transition-all duration-200 rounded-r-md text-foreground"
                    style={{
                      borderColor: isActive ? config.color : `${config.color}99`,
                      background: isActive ? `${config.color}18` : "transparent",
                    }}
                  >
                    {renderSentenceHighlightedText(text, activeSentenceIdx, startFromSentence)}
                  </p>
                );
              }
              const { section } = meta;
              if (meta.type === "visual-callout") {
                return (
                  <p
                    className="rounded-md border border-border bg-muted/25 px-3 py-2 text-sm leading-relaxed transition-all duration-200"
                    style={{
                      borderColor: isActive ? section.color : "hsl(var(--border))",
                      background: isActive ? `${section.color}18` : undefined,
                    }}
                  >
                    {renderSentenceHighlightedText(text, activeSentenceIdx, startFromSentence)}
                  </p>
                );
              }
              return (
                <p
                  className="border-l-2 pl-3 py-1 text-sm leading-relaxed transition-all duration-200 rounded-r-md"
                  style={{
                    borderColor: isActive ? section.color : `${section.color}66`,
                    background: isActive ? `${section.color}18` : "transparent",
                  }}
                >
                  {renderSentenceHighlightedText(text, activeSentenceIdx, startFromSentence)}
                </p>
              );
            }}
          />
        )}

        <ProfileImageLightbox
          result={result}
          imageIds={lightboxImageIds}
          selectedImageId={selectedProfilerImageId}
          onSelectImageId={setSelectedProfilerImageId}
          onClose={() => setSelectedProfilerImageId(null)}
          sections={sections}
          color={config.color}
          transientImages={inlineReferenceImages}
          onCorrectFinding={saveImageFindingClarification}
          onRemoveFinding={removeImageFindingCallout}
        />

        <ProfileArchiveList
          title={`${config.shortTitle} Run Archive`}
          archive={archive}
          currentResult={result}
          onViewRun={(archivedResult) => archivedResult && setResult(normalizeImageReviewResult(archivedResult) || archivedResult)}
        />
      </div>
    </SectionCard>
  );
}

function AIProfilePanel({ sessions, userProfile, journals, evidenceLoading = false }) {
  const [loading, setLoading] = useState(false);
  const [jobStatus, setJobStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [archive, setArchive] = useState([]);
  const [error, setError] = useState("");
  const profileStale = isProfileAIContentStale(result, sessions);

  useEffect(() => {
    base44.entities.SessionClusterAnalysis.list("-updated_date", 1).then((rows) => {
      if (rows[0]?.result) setResult(rows[0].result);
      if (Array.isArray(rows[0]?.profile_result_archive)) setArchive(rows[0].profile_result_archive);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (evidenceLoading) return undefined;

    const reconnect = async () => {
      try {
        const activeData = await listBackgroundJobs({
          type: "ai_invoke",
          status: "queued,running",
          metaSource: "Profiler",
          limit: 12,
        });
        if (cancelled) return;
        let job = (activeData.jobs || []).find((item) => item.meta?.label === "AI Profiler: Comprehensive Profile");
        if (!job) {
          const completedData = await listBackgroundJobs({
            type: "ai_invoke",
            status: "complete",
            metaSource: "Profiler",
            limit: 12,
          });
          if (cancelled) return;
          job = (completedData.jobs || []).find((item) => item.meta?.label === "AI Profiler: Comprehensive Profile");
        }
        if (!job) return;
        if (job.status === "complete" && !isNewerCompletedJob(job, result)) return;

        setJobStatus(job);
        setLoading(job.status !== "complete");
        const completedJob = job.status === "complete"
          ? job
          : await waitForBackgroundJob(job.id, {
            intervalMs: 1200,
            onProgress: (nextJob) => {
              if (!cancelled) setJobStatus(nextJob);
            },
          });
        if (cancelled) return;
        if (!isNewerCompletedJob(completedJob, result)) return;

        const parsed = normalizeAIProfileResult(completedJob.result);
        if (!parsed?.profile_overview && !parsed?.arousal_physiology?.length) return;
        const storedResult = {
          ...parsed,
          _meta: buildProfileAIContentMeta(sessions, result?._meta, completedAt(completedJob)),
        };
        setResult(storedResult);
        const nextArchive = await saveProfileResultWithArchive({
          resultKey: "result",
          archiveKey: "profile_result_archive",
          kind: "comprehensive_profile",
          label: "Comprehensive Physiological Profile",
          result: storedResult,
          sessionCount: sessions.length,
        });
        if (!cancelled) setArchive(nextArchive);
      } catch (err) {
        if (!cancelled) console.warn("AI profile reconnect skipped:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    reconnect();
    return () => {
      cancelled = true;
    };
  }, [evidenceLoading, result, sessions.length]);

  const analyze = async () => {
    setLoading(true);
    setJobStatus({
      status: "starting",
      progress: {
        phase: "building",
        current: 0,
        total: 3,
        message: "Preparing the cross-session profile for background analysis…",
      },
    });
    setResult(null);
    setError("");

    try {
    const sortedSessions = [...sessions].sort((a, b) => new Date(b.date) - new Date(a.date));
    const sessionSummaries = sortedSessions.map(compactSessionLine).join("\n");
    const evidenceDigest = buildProfileEvidenceDigest(sortedSessions);
    const groundingContext = buildAIGroundingContext(userProfile);
    const firstNameToneCue = buildOptionalFirstNameToneCue(userProfile, { prioritizeProfileTone: true });

    const profileContext = userProfile ? `
USER PROFILE & NOTES:
Age: ${userProfile.age || "—"} | Fitness: ${userProfile.fitness_level || "—"} | Resting HR: ${userProfile.resting_hr || "—"} bpm | Max HR: ${userProfile.max_hr || "—"} bpm
Arousal style: ${userProfile.arousal_response_style || "—"} | Build duration: ${userProfile.typical_build_duration || "—"} | Climax sensitivity: ${userProfile.climax_sensitivity || "—"}
Preferred stimulation: ${(userProfile.preferred_stimulation || []).join(", ") || "—"}
Refractory pattern: ${userProfile.refractory_pattern || "—"}
Medications/conditions: ${userProfile.medications || "none noted"}
Arousal notes: ${userProfile.arousal_notes || "none"}
` : "";

    // Build journal context from all available journal entries
  const normalizedJournals = (journals || []).map((j) => ({ ...j, ai_journal: normalizeJournalEntry(j.ai_journal) }));
  const journalContext = normalizedJournals.length > 0 ? `

SESSION JOURNALS (${Math.min(normalizedJournals.length, 8)} recent entries — subjective post-session reflections):
${normalizedJournals.slice(0, 8).map((j) => {
  const ai = j.ai_journal;
  const date = fmtNarrativeDate(j.session_date);
  if (!ai && !j.voice_transcript) return null;
  return `[Session ${date}]:
${ai?.emotional_reflection ? `  Emotional: ${briefText(ai.emotional_reflection, 220)}` : ""}
${ai?.physiological_observations ? `  Physiological: ${briefText(ai.physiological_observations, 220)}` : ""}
${ai?.insights ? `  Insights: ${briefText(ai.insights, 220)}` : ""}
${ai?.next_session_intentions ? `  Intentions: ${briefText(ai.next_session_intentions, 180)}` : ""}
${j.voice_transcript && !ai ? `  Notes: ${briefText(j.voice_transcript, 220)}` : ""}`.trim();
}).filter(Boolean).join("\n\n")}

Use the journals to surface recurring emotional themes, evolving insights, and subjective experiences that the raw session metrics alone cannot reveal. Note where the person's own reflections align with or diverge from the physiological data.` : "";

    const res = await runProfilerAIJob({
      model: "claude_sonnet_4_6",
      temperature: 0.5,
      prompt: `You are an expert physiological and sexual response analyst. Based on ${sessions.length} recorded sessions and profile notes, generate a comprehensive, deeply personal physiological and arousal profile. Write directly to the person — use "you" and "your" throughout, as if speaking to them personally.

${groundingContext}
${SESSION_CONTEXT_GROUNDING_RULE}
SESSION CONTEXT PROFILE RULE:
- Structured session context is longitudinal evidence. Use it in the AI Profiler wherever it helps explain recurring contextual sensitivities, session clusters, outliers, recovery differences, build quality differences, or preparation effects.
- Context should qualify, explain, or contextualize the core findings. Do not let hydration, fatigue, food state, cannabis, alcohol, privacy/interruption risk, mental state, environment, or preparation replace the central analysis of observable arousal physiology, stimulation response, anatomy or device interaction, motion evidence, climax mechanics, and recovery behavior.
- Integrate context outside the contextual_sensitivities section only when it clearly modifies one of those core body/mechanics observations.
- Distinguish repeated association, plausible modifier, single-session anecdote, and unproven causal explanation. Do not rank a contextual factor as important unless repeated session evidence supports that weighting.
- Never upgrade logged context into proof of causation. Use language like "appears associated with", "may have shaped", or "is repeatedly present in sessions where..." unless the evidence is direct and repeated.

AI PROFILER PRIORITY RULE:
- Prioritize directly observed sexual and physiological mechanics first: arousal build shape, stimulation method response, erection quality, glans/shaft/foreskin dynamics, urethral or device-fit observations, prostatic/perineal involvement, ejaculatory characteristics, foot/lower-body motion telemetry, climax timing, and recovery pattern.
- Structured context such as hydration, fatigue, cannabis, alcohol, food state, preparation, privacy/interruption risk, mental state, and environment should qualify, explain, or contextualize those observations. Do not let context replace the core body/mechanics analysis.
- Do not lead recommendations with contextual variables unless repeated session evidence clearly shows they outweigh method response, anatomy, telemetry, climax/recovery mechanics, or direct session observations.
- Avoid overstating context as causal. Prefer "appears associated with", "may have shaped", "is repeatedly present in sessions where", or "could help explain this pattern".
- Be especially careful with alcohol: do not frame alcohol as beneficial, neutral, or performance-enhancing unless the evidence directly and repeatedly supports that narrow claim. If alcohol is present but hard to isolate from fatigue, cannabis, mood, or environment, say that clearly.
- Hydration, THC/cannabis, fatigue, preparation, and environment are important modifiers, but they are seasoning, not the steak. The profile should still primarily be about the person's observable arousal physiology, stimulation response, anatomy/device interaction, motion evidence, climax mechanics, and recovery behavior.
${SESSION_DATE_GROUNDING_RULE}
${MOTION_EVIDENCE_PRECEDENCE_RULE}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}

CRITICAL FOR TEXT-TO-SPEECH QUALITY:
- Write all times as words: "ten minutes and thirty seconds" not "10:30"
- Spell out all numbers as words (e.g., "ten beats per minute" not "10 bpm")
- Write in conversational, sentence-based prose with natural pauses
- Use short sentences and simple grammar optimized for audio readability
- Avoid jargon—explain concepts clearly as if speaking aloud
- Use commas and periods to create natural speech cadence
${profileContext}${journalContext}
SESSION DATA SUMMARY (${sessions.length} total sessions; compacted to preserve full coverage without exceeding rate limits):
${evidenceDigest}

SESSION-BY-SESSION EVIDENCE:
${sessionSummaries}

Generate a rich, holistic profile. Your job is NOT to restate what was already logged — the person already knows what they did. Instead, offer your own interpretations, inferences, hypotheses, and conclusions drawn FROM the data. Go beyond the surface. Make observations they may not have noticed themselves. Point out cross-session patterns, contradictions, and surprising findings. Be willing to form opinions when the evidence supports them, and calibrate certainty using the evidence rules above.

For this longitudinal profile, preserve the warm, personalized interpretive voice while keeping certainty honest:
- Repeated response patterns may be described with strong narrative confidence when telemetry, session behavior, and the person's notes point the same way.
- Mechanism-level explanations about nerves, hormones, tissue adaptation, anatomy, or psychology must stay qualified unless directly supported by the available evidence.
- When the person's own hypothesis appears in notes, identify it as their hypothesis or a plausible interpretation rather than silently upgrading it into fact.
- Recommendations should follow demonstrated session patterns first; avoid turning a single evocative session or an attractive theory into a firm protocol.
- When populated structured anatomical or functional mechanical profile fields are relevant, incorporate erect dimensions, glans or foreskin context, meatal or urethral dimensions, accommodation or device-fit observations, and functional response observations into the synthesis. Use them to deepen interpretation of supported session findings involving stimulation mechanics, fit, pressure distribution, sensitivity, device interaction, or repeated response patterns; do not force mention of measurements where unrelated or use them to invent causal mechanisms.

MECHANISTIC DISCIPLINE:
Describing repeated patterns is preferred over inventing internal mechanisms.
Allowed phrasing includes "your body repeatedly shows", "this pattern appears consistent with", and "your data suggests".
Use caution with autonomic nervous system explanations, cardiovascular gating claims, endocrine explanations, neurological localization, and muscle imbalance claims.
Mechanistic explanations should only be used when directly supported by strong repeated evidence or clearly framed as exploratory hypotheses.
Prefer pattern description over mechanistic storytelling.

PERSONALITY PROTECTION:
Do NOT flatten the narrative voice into sterile clinical reporting.
The person values emotionally resonant interpretation and psychologically meaningful synthesis.
The profiler should feel intelligent, warm, highly familiar, insightful, and human.
Avoid robotic medical documentation tone.
Strong interpretive phrasing is welcome when supported by repeated evidence.

PATTERN VS EXPLANATION CHECK:
Before presenting a conclusion, ask whether it describes what repeatedly happens or why you think it happens.
Descriptions of repeated patterns are preferred.
Explanations of why require caution and evidence-calibrated language.

SUBSTANCE INTERPRETATION:
User-reported effects of THC, alcohol, nicotine, or other modifiers should be treated as individualized observations unless objectively confirmed.
Do not convert the person's beliefs into universal physiological facts.
Prefer wording like "you consistently report improved recovery with THC" over "THC improves parasympathetic recovery".

CONFIDENT INTERPRETATION:
When a pattern is strongly repeated across telemetry, notes, interviews, and journal entries, confident narrative interpretation is appropriate.
Examples include "your body repeatedly builds in waves", "this has become a recognizable signature", and "your left foot serves as a reliable escalation marker" when the evidence supports them.
Do not weaken clearly supported repeated observations with excessive hedging.

Cover these areas:

1. AROUSAL PHYSIOLOGY: Interpret the shape and character of their arousal response — don't just describe the HR numbers. Prioritize repeated patterns in acceleration, plateau behavior, peaks, and recovery slope, then explain what those patterns may suggest only where the evidence earns it. Form a view on what type of physiological responder they appear to be without inventing hidden autonomic or cardiovascular mechanisms.

2. STIMULATION PROFILE: Don't list what methods they used — interpret what the outcomes reveal about their body's actual preferences. Which method combinations appear to produce synergistic effects vs. diminishing returns? What does the pattern of their best vs. worst sessions suggest about their sensitivity and saturation points?

3. CLIMAX & RECOVERY PATTERNS: Go beyond describing duration and volume — interpret the repeated shape of their climax and recovery data, the cues that reliably accompany release, and what recovery slope contributes to the pattern. Discuss neuromuscular, ejaculatory-threshold, autonomic, or refractory explanations only when directly supported or clearly framed as exploratory hypotheses.

4. CONTEXTUAL SENSITIVITIES: Identify contextual factors that repeatedly appear to modify the person's core physiology or session mechanics. Don't just list factors. Separate repeated associations from plausible modifiers, single-session anecdotes, and unproven causal explanations. Keep this section subordinate to the primary body/mechanics profile unless the repeated evidence clearly shows context is the dominant driver.

5. DISCOMFORT & PHYSIOLOGICAL EDGE CASES: Interpret what recurring discomfort or unusual sensations may suggest anatomically — consider urethral, prostatic, pelvic floor, and neurovascular context given their specific methods. Discuss tissue adaptation, nerve sensitization, or structural factors only as evidence-linked possibilities when the data supports that level of interpretation. Be specific, not generic.

6. BEHAVIORAL & AROUSAL TENDENCIES: Look for observable patterns in build style, pause/resume moments, event timelines, and the person's own subjective notes. Do not infer motives, anxiety, control strategies, or intentional edging unless explicitly logged. Focus on how observable behavior and physiology relate to outcomes.

7. PERSONAL OPTIMIZATION RECOMMENDATIONS: Give specific, useful recommendations — not generic advice. Lead with method, anatomy/device interaction, telemetry, climax/recovery mechanics, and direct session observations. Use contextual variables as supporting modifiers unless repeated evidence clearly shows they outweigh the body/mechanics pattern. Reference their actual data patterns and explain the physiological or behavioral reasoning behind each suggestion. Make the boldest recommendations only where repeated evidence earns them.

Be warm, direct, insightful, and willing to state conclusions when the evidence earns them. Ground everything in their data but go well beyond restating it.`,
      response_json_schema: {
        type: "object",
        properties: {
          profile_overview: { type: "string" },
          arousal_physiology: { type: "array", items: { type: "string" } },
          stimulation_profile: { type: "array", items: { type: "string" } },
          climax_and_recovery: { type: "array", items: { type: "string" } },
          contextual_sensitivities: { type: "array", items: { type: "string" } },
          discomfort_and_edge_cases: { type: "array", items: { type: "string" } },
          behavioral_tendencies: { type: "array", items: { type: "string" } },
          optimization_recommendations: { type: "array", items: { type: "string" } },
        },
        required: ["profile_overview", "arousal_physiology", "stimulation_profile", "climax_and_recovery", "contextual_sensitivities", "behavioral_tendencies", "optimization_recommendations"],
      },
      max_tokens: 8192,
    }, "AI Profiler: Comprehensive Profile", setJobStatus, {
      priority: 20,
      meta: {
        reviewType: "comprehensive_profile",
        session_count: sessions.length,
      },
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const parsed = normalizeAIProfileResult(raw);
    if (!parsed?.profile_overview && !parsed?.arousal_physiology?.length) {
      throw new Error("Claude returned an empty profile response. Try again in a minute; the rate limit may still be cooling down.");
    }
    const storedResult = {
      ...parsed,
      _meta: buildProfileAIContentMeta(sessions, result?._meta),
    };
    setResult(storedResult);

    const nextArchive = await saveProfileResultWithArchive({
      resultKey: "result",
      archiveKey: "profile_result_archive",
      kind: "comprehensive_profile",
      label: "Comprehensive Physiological Profile",
      result: storedResult,
      sessionCount: sessions.length,
    });
    setArchive(nextArchive);
    } catch (err) {
      console.error("AI profile generation failed:", err);
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const SECTIONS = [
    { key: "arousal_physiology", label: "Arousal Physiology", icon: <Heart className="w-3.5 h-3.5" />, color: "hsl(var(--chart-3))" },
    { key: "stimulation_profile", label: "Stimulation Profile", icon: <Zap className="w-3.5 h-3.5" />, color: "hsl(var(--primary))" },
    { key: "climax_and_recovery", label: "Climax & Recovery", icon: <TrendingUp className="w-3.5 h-3.5" />, color: "hsl(var(--chart-2))" },
    { key: "contextual_sensitivities", label: "Contextual Sensitivities", icon: <Activity className="w-3.5 h-3.5" />, color: "hsl(var(--chart-4))" },
    { key: "discomfort_and_edge_cases", label: "Discomfort & Edge Cases", icon: <AlertCircle className="w-3.5 h-3.5" />, color: "hsl(var(--destructive))" },
    { key: "behavioral_tendencies", label: "Behavioral Tendencies", icon: <User className="w-3.5 h-3.5" />, color: "hsl(var(--accent))" },
    { key: "optimization_recommendations", label: "Optimization Recommendations", icon: <Lightbulb className="w-3.5 h-3.5" />, color: "hsl(var(--chart-1))" },
  ];

  // Build flat paragraph list for TTSReader
  const paras = [];
  const paraMeta = [];
  if (result) {
    if (result.profile_overview) { paras.push(result.profile_overview); paraMeta.push({ type: "overview" }); }
    for (const sec of SECTIONS) {
      for (const item of (result[sec.key] || [])) {
        paras.push(item);
        paraMeta.push({ type: "section", sec });
      }
    }
  }

  return (
    <SectionCard icon={<Brain className="w-4 h-4" />} title="Comprehensive Physiological Profile" color="hsl(var(--primary))" defaultCollapsed={true}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          AI-generated personal physiological & arousal profile based on all sessions, event timelines, and profile notes.
        </p>
        <Button size="sm" onClick={analyze} disabled={loading || evidenceLoading || sessions.length < 2} className="h-7 text-xs gap-1.5 shrink-0 ml-2">
          {loading
            ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Profiling…</>
            : <><Brain className="w-3 h-3" />{result ? "Re-generate" : "Generate Profile"}</>}
        </Button>
      </div>

      {result && (
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          <span>{result?._meta?.last_generated_at ? `Generated ${formatGeneratedAt(result._meta.last_generated_at)}` : "Generated time unavailable"}</span>
          <span>Source sessions: {result?._meta?.source_session_count ?? sessions.length}</span>
          <span>Motion evidence sessions: {result?._meta?.motion_evidence_session_count ?? summarizeMotionEvidenceCoverage(sessions).any}</span>
          {profileStale && (
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-semibold text-amber-300">
              May be stale - newer saved evidence exists
            </span>
          )}
        </div>
      )}

      {!result && (
        <ProfilerPanelLoadingStatus
          items={[
            { active: evidenceLoading, label: "Session evidence and saved findings", status: "loading" },
          ]}
        />
      )}

      {!evidenceLoading && sessions.length < 2 && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" /> Need at least 2 sessions to generate a profile.
        </p>
      )}

      <CompactError message={error} />

      {loading && (
        <ProfilerJobStatus
          job={jobStatus}
          fallback="The full profile is running in the background…"
        />
      )}

      {!result && !loading && !evidenceLoading && sessions.length >= 2 && (
        <p className="text-xs text-muted-foreground">
          Click Generate Profile to create your comprehensive physiological and arousal profile. Uses Claude Sonnet.
        </p>
      )}

      {result && (
        <TTSReader
          sessionId="profiler_ai_profile"
          title="AI Physiological Profile"
          sourceGeneratedAt={result?._meta?.last_generated_at}
          paragraphs={paras}
          renderParagraph={(text, idx, isActive, _isBuffering, activeSentenceIdx, startFromSentence) => {
            const meta = paraMeta[idx];
            if (!meta) return null;

            if (meta.type === "overview") {
              return (
                <p className={`text-base font-medium leading-relaxed border-l-2 pl-3 py-1 transition-all duration-200 rounded-r-md ${isActive ? "border-primary bg-primary/10 text-foreground" : "border-primary/50 text-foreground"}`}>
                  {meta.displayLabel || text}
                </p>
              );
            }

            const { sec } = meta;
            // Check if first item in section → render section header
            const firstInSection = paras.findIndex((_, i) => paraMeta[i]?.type === "section" && paraMeta[i]?.sec?.key === sec.key) === idx;

            return (
              <div>
                {firstInSection && (
                  <p className="text-xs font-semibold flex items-center gap-1.5 mt-4 mb-1.5 pt-3 border-t border-border" style={{ color: sec.color }}>
                    {sec.icon}{sec.label}
                  </p>
                )}
                <li
                  className="text-sm pl-3 border-l-2 py-1 leading-relaxed list-none transition-all duration-200 rounded-r-md"
                  style={{
                    borderColor: isActive ? sec.color : sec.color + "55",
                    background: isActive ? sec.color + "18" : "transparent",
                    color: "hsl(var(--foreground))",
                  }}
                >
                  {renderSentenceHighlightedText(text, activeSentenceIdx, startFromSentence)}
                </li>
              </div>
            );
          }}
        />
      )}

      <ProfileArchiveList
        title="Comprehensive Profile Run Archive"
        archive={archive}
        currentResult={result}
        onViewRun={(archivedResult) => archivedResult && setResult(archivedResult)}
      />
    </SectionCard>
  );
}

function AnatomicalPhysiologicalProfilePanel({
  sessions,
  allTimelines = {},
  userProfile,
  profileLoading = false,
  evidenceLoading = false,
  timelineLoading = false,
}) {
  const [loading, setLoading] = useState(false);
  const [jobStatus, setJobStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [archive, setArchive] = useState([]);
  const [error, setError] = useState("");
  const profileStale = isProfileAIContentStale(result, sessions);

  useEffect(() => {
    base44.entities.SessionClusterAnalysis.list("-updated_date", 1).then((rows) => {
      if (rows[0]?.anatomical_physiological_profile_result) {
        setResult(rows[0].anatomical_physiological_profile_result);
      }
      if (Array.isArray(rows[0]?.anatomical_physiological_profile_archive)) {
        setArchive(rows[0].anatomical_physiological_profile_archive);
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (evidenceLoading) return undefined;

    const reconnect = async () => {
      try {
        const activeData = await listBackgroundJobs({
          type: "ai_invoke",
          status: "queued,running",
          metaSource: "Profiler",
          limit: 12,
        });
        if (cancelled) return;
        let job = (activeData.jobs || []).find((item) => item.meta?.label === "AI Profiler: Anatomical & Physiological Profile");
        if (!job) {
          const completedData = await listBackgroundJobs({
            type: "ai_invoke",
            status: "complete",
            metaSource: "Profiler",
            limit: 12,
          });
          if (cancelled) return;
          job = (completedData.jobs || []).find((item) => item.meta?.label === "AI Profiler: Anatomical & Physiological Profile");
        }
        if (!job) return;
        if (job.status === "complete" && !isNewerCompletedJob(job, result)) return;

        setJobStatus(job);
        setLoading(job.status !== "complete");
        const completedJob = job.status === "complete"
          ? job
          : await waitForBackgroundJob(job.id, {
            intervalMs: 1200,
            onProgress: (nextJob) => {
              if (!cancelled) setJobStatus(nextJob);
            },
          });
        if (cancelled) return;
        if (!isNewerCompletedJob(completedJob, result)) return;

        const parsed = normalizeAnatomicalProfileResult(completedJob.result);
        if (!parsed?.overview) return;
        const storedResult = {
          ...parsed,
          _meta: buildProfileAIContentMeta(sessions, result?._meta, completedAt(completedJob)),
        };
        setResult(storedResult);
        const nextArchive = await saveProfileResultWithArchive({
          resultKey: "anatomical_physiological_profile_result",
          archiveKey: "anatomical_physiological_profile_archive",
          kind: "anatomical_physiological_profile",
          label: "Anatomical & Physiological Profile",
          result: storedResult,
          sessionCount: sessions.length,
        });
        if (!cancelled) setArchive(nextArchive);
      } catch (err) {
        if (!cancelled) console.warn("Anatomical physiological profile reconnect skipped:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    reconnect();
    return () => {
      cancelled = true;
    };
  }, [evidenceLoading, result, sessions.length]);

  const analyze = async () => {
    setLoading(true);
    setResult(null);
    setError("");
    setJobStatus({
      status: "starting",
      progress: {
        phase: "building",
        current: 0,
        total: 3,
        message: "Preparing anatomical and physiological context for background synthesis...",
      },
    });

    try {
      const sortedSessions = [...sessions].sort((a, b) => new Date(b.date) - new Date(a.date));
      const evidenceDigest = naturalizeSpokenDates(buildProfileEvidenceDigest(sortedSessions));
      const sessionSummaries = sortedSessions.slice(0, 80).map(compactAnatomicalSessionLine).join("\n");
      const longitudinalHrvEvidence = buildLongitudinalHrvEvidence(sortedSessions, allTimelines);
      const groundingContext = buildAIGroundingContext(userProfile);
      const firstNameToneCue = buildOptionalFirstNameToneCue(userProfile, { prioritizeProfileTone: true });

      const raw = await runProfilerAIJob({
        model: "claude_sonnet_4_6",
        prompt: `You are producing an Anatomical & Physiological Profile for one person. Create a detailed, evidence-grounded synthesis using only populated saved profile fields and supported patterns in the session data. This is distinct from a narrative arousal profile: its purpose is to explain relevant constitutional, anatomical, functional-mechanical, and instrumentation context.

${groundingContext}
${SESSION_CONTEXT_GROUNDING_RULE}
${SESSION_DATE_GROUNDING_RULE}
${MOTION_EVIDENCE_PRECEDENCE_RULE}
${ANATOMICAL_REFERENCE_FOCUS_RULE}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${longitudinalHrvEvidence ? RR_HRV_INTERPRETATION_RULES : ""}

SYNTHESIS REQUIREMENTS:
- Begin with a compact whole-body overview, then expand only where the provided evidence supports detail.
- Write every part of the response directly to the person in second person, including the opening overview. Do not open with "Ben is," "the person is," "the user is," or any other third-person framing.
- Separate directly entered anatomical observations from repeated session-linked findings and from cautious interpretations.
- Consider constitutional/body habitus, cardiovascular/autonomic, respiratory, neurological/sensory, musculoskeletal/biomechanical, and endocrine/metabolic context only when those data were provided.
- Use psychological, personal-history, or broad longitudinal context only where it directly explains anatomy, visible mechanics, device interaction, safety/risk-control observations, or session-specific physiology. Do not turn this A&P artifact into a broad arousal biography or life-history synthesis.
- When usable RR-derived HRV exists, use repeated within-session build, climax, or recovery changes to deepen the cardiovascular and autonomic context without treating session HRV as a resting baseline or diagnostic measure.
- When populated, integrate static resting or flaccid anatomy, static erect anatomy, dynamic transition findings, glans or foreskin context, meatal structure, urethral accommodation, fit or tolerance, pressure distribution, device interaction, instrumentation compatibility or limitations, and repeated functional response observations.
- Use anatomical dimensions analytically, such as when dynamic expansion, fit variability, accommodation, pressure distribution, stimulation mechanics, or session findings make them relevant. Do not recite measurements without purpose.
- Genital or pelvic detail is optional and must be proportional to its relevance in the entered data and session evidence.
- Do not invent unsupported anatomy or physiology, infer diagnoses, make deterministic mechanism claims, or produce erotic commentary.
- Explicitly identify limitations and missing data where they constrain interpretation.
- Write for natural spoken delivery as well as reading: use flowing complete sentences, avoid clipped data-dump phrasing, and retain all meaningful supported findings.
- Whenever referencing a session date, spell it out in natural narration (for example, "May 4, 2026"), never use ISO formatting such as "2026-05-04".

SESSION EVIDENCE SUMMARY (${sessions.length} sessions):
${evidenceDigest}

${longitudinalHrvEvidence ? `RR-DERIVED HRV EVIDENCE:
${JSON.stringify(longitudinalHrvEvidence, null, 2)}

Use this evidence in the cardiovascular and autonomic context only where it adds a supported within-session or repeated cross-session pattern. Do not force HRV into the synthesis when the quality, coverage, or number of sessions is insufficient.

` : ""}
SELECTED SESSION-BY-SESSION EVIDENCE:
${sessionSummaries || "No session evidence is available; rely only on populated profile entries."}

Write directly to the person in clear, clinically grounded language. Favor meaningful synthesis over measurement recital. Before returning, check the overview and every section for third-person references and rewrite them into natural "you" and "your" language.`,
        response_json_schema: {
          type: "object",
          properties: {
            overview: { type: "string" },
            constitutional_and_systemic_context: { type: "array", items: { type: "string" } },
            cardiovascular_and_autonomic_context: { type: "array", items: { type: "string" } },
            sensory_and_biomechanical_context: { type: "array", items: { type: "string" } },
            pelvic_and_external_anatomy: { type: "array", items: { type: "string" } },
            dynamic_anatomical_function: { type: "array", items: { type: "string" } },
            instrumentation_and_fit_findings: { type: "array", items: { type: "string" } },
            session_linked_interpretations: { type: "array", items: { type: "string" } },
            limitations_and_data_gaps: { type: "array", items: { type: "string" } },
          },
          required: ["overview", "limitations_and_data_gaps"],
        },
      }, "AI Profiler: Anatomical & Physiological Profile", setJobStatus, {
        priority: 20,
        meta: {
          reviewType: "anatomical_physiological_profile",
          session_count: sessions.length,
        },
      });

      const parsed = normalizeAnatomicalProfileResult(typeof raw === "string" ? JSON.parse(raw) : raw);
      if (!parsed?.overview) throw new Error("Claude returned an empty anatomical and physiological profile.");
      const storedResult = {
        ...parsed,
        _meta: buildProfileAIContentMeta(sessions, result?._meta),
      };
      setResult(storedResult);
      const nextArchive = await saveProfileResultWithArchive({
        resultKey: "anatomical_physiological_profile_result",
        archiveKey: "anatomical_physiological_profile_archive",
        kind: "anatomical_physiological_profile",
        label: "Anatomical & Physiological Profile",
        result: storedResult,
        sessionCount: sessions.length,
      });
      setArchive(nextArchive);
    } catch (err) {
      console.error("Anatomical physiological profile generation failed:", err);
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const sections = [
    { key: "constitutional_and_systemic_context", label: "Constitutional & Systemic Context", color: "hsl(var(--primary))" },
    { key: "cardiovascular_and_autonomic_context", label: "Cardiovascular & Autonomic Context", color: "hsl(var(--chart-3))" },
    { key: "sensory_and_biomechanical_context", label: "Sensory & Biomechanical Context", color: "hsl(var(--chart-2))" },
    { key: "pelvic_and_external_anatomy", label: "Pelvic & External Anatomy", color: "hsl(var(--accent))" },
    { key: "dynamic_anatomical_function", label: "Dynamic Anatomical Function", color: "hsl(var(--chart-4))" },
    { key: "instrumentation_and_fit_findings", label: "Instrumentation & Fit", color: "hsl(var(--primary))" },
    { key: "session_linked_interpretations", label: "Session-Linked Interpretations", color: "hsl(var(--chart-3))" },
    { key: "limitations_and_data_gaps", label: "Limitations & Data Gaps", color: "hsl(var(--muted-foreground))" },
  ];

  const paragraphs = [];
  const paragraphMeta = [];
  if (result) {
    paragraphs.push(calmSpokenHeading("Anatomical and Physiological Profile"));
    paragraphMeta.push({ type: "title", color: "hsl(var(--chart-2))", displayLabel: "Anatomical and Physiological Profile" });
    if (result.overview) {
      paragraphs.push(naturalizeSpokenDates(result.overview));
      paragraphMeta.push({ type: "overview" });
    }
    for (const section of sections) {
      if ((result[section.key] || []).length) {
        paragraphs.push(calmSpokenHeading(section.label));
        paragraphMeta.push({ type: "section-title", section, displayLabel: section.label });
      }
      for (const finding of (result[section.key] || [])) {
        paragraphs.push(naturalizeSpokenDates(finding));
        paragraphMeta.push({ type: "section", section });
      }
    }
  }

  return (
    <SectionCard icon={<Activity className="w-4 h-4" />} title="Anatomical & Physiological Profile" color="hsl(var(--chart-2))" defaultCollapsed={true}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Evidence-grounded anatomy, dynamic function, fit, and instrumentation synthesis from your optional profile data and supported session findings.
        </p>
        <Button size="sm" onClick={analyze} disabled={loading || profileLoading || evidenceLoading || timelineLoading || !userProfile} className="h-7 text-xs gap-1.5 shrink-0">
          {loading
            ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Synthesizing...</>
            : <><Activity className="w-3 h-3" />{result ? "Re-generate" : "Generate A&P"}</>}
        </Button>
      </div>

      {result && (
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          <span>{result?._meta?.last_generated_at ? `Generated ${formatGeneratedAt(result._meta.last_generated_at)}` : "Generated time unavailable"}</span>
          <span>Source sessions: {result?._meta?.source_session_count ?? sessions.length}</span>
          <span>Motion evidence sessions: {result?._meta?.motion_evidence_session_count ?? summarizeMotionEvidenceCoverage(sessions).any}</span>
          {profileStale && (
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-semibold text-amber-300">
              May be stale - newer saved evidence exists
            </span>
          )}
        </div>
      )}

      <CompactError message={error} />
      {loading && <ProfilerJobStatus job={jobStatus} fallback="The anatomical and physiological profile is running in the background..." />}
      {!result && !loading && (
        <ProfilerPanelLoadingStatus
          items={[
            { active: profileLoading, label: "Saved profile context", status: "loading" },
            { active: evidenceLoading, label: "Session and body-exploration evidence", status: "loading" },
            { active: timelineLoading, label: "Heart-rate timelines", status: "loading" },
          ]}
        />
      )}
      {!result && !loading && !profileLoading && !evidenceLoading && !timelineLoading && (
        <p className="text-xs text-muted-foreground">
          Populate any relevant optional Profile fields, then generate this dedicated A&P synthesis. Unpopulated details will not be inferred.
        </p>
      )}
      {result && (
        <TTSReader
          sessionId="profiler_anatomical_physiological_profile"
          title="Anatomical and Physiological Profile"
          sourceGeneratedAt={result?._meta?.last_generated_at}
          paragraphs={paragraphs}
          renderParagraph={(text, idx, isActive, isBuffering, activeSentenceIdx, startFromSentence) => {
            const meta = paragraphMeta[idx];
            if (!meta) return null;

            if (meta.type === "title" || meta.type === "section-title") {
              const color = meta.section?.color || meta.color || "hsl(var(--chart-2))";
              return (
                <p
                  className="mt-4 border-t border-border pt-3 text-xs font-semibold transition-colors"
                  style={{
                    color,
                    background: isActive ? `${color}18` : "transparent",
                  }}
                >
                  {meta.displayLabel || text}
                </p>
              );
            }

            if (meta.type === "overview") {
              return (
                <p
                  className="text-base font-medium leading-relaxed border-l-2 pl-3 py-1 transition-all duration-200 rounded-r-md text-foreground"
                  style={{
                    borderColor: isActive ? "hsl(var(--chart-2))" : "hsl(var(--chart-2) / 0.6)",
                    background: isActive ? "hsl(var(--chart-2) / 0.1)" : "transparent",
                  }}
                >
                  {renderSentenceHighlightedText(text, activeSentenceIdx, startFromSentence)}
                </p>
              );
            }

            const { section } = meta;

            return (
              <div>
                <p
                  className="border-l-2 pl-3 py-1 text-sm leading-relaxed transition-all duration-200 rounded-r-md"
                  style={{
                    borderColor: isActive ? section.color : section.color + "66",
                    background: isActive ? section.color + "18" : "transparent",
                  }}
                >
                  {renderSentenceHighlightedText(text, activeSentenceIdx, startFromSentence)}
                </p>
              </div>
            );
          }}
        />
      )}

      <ProfileArchiveList
        title="A&P Profile Run Archive"
        archive={archive}
        currentResult={result}
        onViewRun={(archivedResult) => archivedResult && setResult(archivedResult)}
      />
    </SectionCard>
  );
}

function NearClimaxPanel({ sessions, allTimelines, userProfile, timelineLoading = false }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [eventStats, setEventStats] = useState(null);
  const [jobStatus, setJobStatus] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    base44.entities.SessionClusterAnalysis.list("-updated_date", 1).then((rows) => {
      if (rows[0]?.near_climax_result) {
        setResult(rows[0].near_climax_result);
      }
    });
  }, []);

  const analyze = async () => {
    setLoading(true);
    setResult(null);
    setError("");
    setJobStatus({
      status: "starting",
      progress: {
        phase: "building",
        current: 0,
        total: 3,
        message: "Preparing near-climax event analysis for the background queue..."
      }
    });

    try {
    // Detect events across all sessions with HR data
    const sessionEvents = [];
    for (const session of sessions) {
      const rows = allTimelines[session.id] || [];
      if (rows.length < 10) continue;
      const events = detectNearClimaxEvents(rows, session.climax_offset_s, session.pre_climax_offset_s, session.event_timeline || []);
      if (events.length > 0) {
        sessionEvents.push({
          date: sessionDateKey(session.date),
          session_duration_s: Math.round(Math.max(...rows.map((r) => Number(r.time_offset_s)))),
          climax_offset_s: session.climax_offset_s,
          methods: session.methods,
          intensity: session.intensity,
          near_climax_events: events.slice(0, 4),
          event_count: events.length,
          total_time_in_events_s: Math.round(events.reduce((a, e) => a + e.duration_s, 0)),
          avg_rise_bpm: Math.round(events.reduce((a, e) => a + e.rise_bpm, 0) / events.length),
          max_peak_hr: Math.max(...events.map((e) => e.peak_hr))
        });
      }
    }

    const totalEvents = sessionEvents.reduce((a, s) => a + s.event_count, 0);
    const stats = {
      sessions_with_events: sessionEvents.length,
      total_events: totalEvents,
      avg_events_per_session: sessionEvents.length ? (totalEvents / sessionEvents.length).toFixed(1) : 0
    };
    setEventStats(stats);
    const groundingContext = buildAIGroundingContext(userProfile);

    const res = await runProfilerAIJob({
      model: "claude_sonnet_4_6",
      prompt: `You are a physiological research assistant analyzing near-climax events detected in heart rate data from sexual response sessions. Write directly to the person — use "you" and "your" throughout, as if speaking to them personally.

${groundingContext}
${SESSION_DATE_GROUNDING_RULE}

CRITICAL FOR TEXT-TO-SPEECH QUALITY:
- Write all times as words: "ten minutes and thirty seconds" not "10:30"
- Spell out all numbers as words (e.g., "ten beats per minute" not "10 bpm")
- Write in conversational, sentence-based prose with natural pauses
- Use short sentences and simple grammar optimized for audio readability

A "near-climax event" is defined as: an erratic yet somewhat sustained climb in heart rate (eight or more beats per minute rise within forty-five seconds), followed by a notable drop — similar in shape to the climax cascade (ever-increasing HR with an apex and fall) but not as sustained. These events occur outside of the actual climax window.

Detected event data across ${sessionEvents.length} sessions (out of ${sessions.length} total):
${sessionEvents.slice(0, 12).map((s) => `${fmtNarrativeDate(s.date)}: ${s.event_count} events, ${fmtSec(s.total_time_in_events_s)} total, avg rise ${s.avg_rise_bpm} bpm, max peak ${s.max_peak_hr} bpm, methods ${(s.methods || []).join(", ") || "none"}, climax ${fmtSec(s.climax_offset_s)}. Events: ${s.near_climax_events.map((e) => `${fmtSec(e.start_offset_s)}-${fmtSec(e.end_offset_s)}, peak ${e.peak_hr}, rise ${e.rise_bpm}, confidence ${e.confidence}`).join(" | ")}`).join("\n")}

Provide a rich, interpretive narrative analysis. Focus on:
1. What these events physiologically represent for you — are they arousal plateaus, stimulation intensity peaks, parasympathetic interruptions, explicitly logged arousal control, or something else?
2. How frequently they occur and what that suggests about your physiological response pattern.
3. Which session contexts (methods, duration, time-in-session) seem to trigger more of these events for you.
4. What role they likely play in your overall arousal arc — do they precede stronger or weaker climax events for you?
5. Recommendations for how you can leverage or manage these events to optimize your session outcomes.

Be interpretive, insightful, and speak directly to the person. Reference specific sessions where notable.`,
      response_json_schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          physiological_interpretation: { type: "string" },
          pattern_analysis: { type: "array", items: { type: "string" } },
          contextual_triggers: { type: "array", items: { type: "string" } },
          role_in_arousal_arc: { type: "string" },
          recommendations: { type: "array", items: { type: "string" } }
        },
        required: ["summary", "physiological_interpretation", "pattern_analysis", "contextual_triggers", "role_in_arousal_arc", "recommendations"]
      }
    }, "AI Profiler: Near-Climax Event Analysis", setJobStatus, {
      priority: 15,
      meta: {
        reviewType: "near_climax_events",
        session_count: sessions.length,
        sessions_with_events: sessionEvents.length,
        event_count: totalEvents,
      },
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const parsed = raw?.response ?? raw;
    setResult(parsed);

    // Save to entity
    const existing = await base44.entities.SessionClusterAnalysis.list("-updated_date", 1);
    if (existing[0]) {
      await base44.entities.SessionClusterAnalysis.update(existing[0].id, { near_climax_result: { ...parsed, _stats: stats, _session_events: sessionEvents } });
    } else {
      await base44.entities.SessionClusterAnalysis.create({ near_climax_result: { ...parsed, _stats: stats, _session_events: sessionEvents } });
    }
    } catch (err) {
      console.error("Near-climax analysis failed:", err);
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const savedStats = result?._stats;
  const savedSessionEvents = result?._session_events;
  const displayStats = eventStats || savedStats;
  const displaySessionEvents = savedSessionEvents;

  return (
    <SectionCard icon={<Zap className="w-4 h-4" />} title="Near-Climax Event Analysis" color="hsl(var(--chart-3))" defaultCollapsed={true}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Detects erratic HR spikes & reversals that resemble — but don't complete — a climax cascade.</p>
        <Button size="sm" onClick={analyze} disabled={loading || timelineLoading} className="h-7 text-xs gap-1.5 shrink-0">
          {loading ?
            <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</> :
            <><Brain className="w-3 h-3" />{result ? "Re-run" : "Analyze"}</>}
        </Button>
      </div>

      {!result && (
        <ProfilerPanelLoadingStatus
          items={[
            { active: timelineLoading, label: "Heart-rate timelines", status: "loading" },
          ]}
        />
      )}

      <CompactError message={error} />
      {loading && (
        <ProfilerJobStatus
          job={jobStatus}
          fallback="Near-climax event analysis is running in the background queue..."
        />
      )}

      {displayStats &&
      <div className="grid grid-cols-3 gap-2">
          {[
        ["Sessions w/ Events", displayStats.sessions_with_events],
        ["Total Events", displayStats.total_events],
        ["Avg per Session", displayStats.avg_events_per_session]].
        map(([l, v]) =>
        <div key={l} className="bg-muted/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold font-mono">{v}</p>
              <p className="text-[9px] text-muted-foreground">{l}</p>
            </div>
        )}
        </div>
      }

      {displaySessionEvents?.length > 0 &&
      <div className="space-y-1.5">
          <p className="text-[10px] text-muted-foreground uppercase font-semibold">Per Session</p>
          {displaySessionEvents.map((s, i) =>
        <div key={i} className="flex flex-wrap items-center gap-2 text-[10px]">
              <span className="font-mono text-muted-foreground w-14 shrink-0">{s.date}</span>
              <Badge variant="outline" className="text-[9px] h-4 px-1">{s.event_count} events</Badge>
              <Badge variant="outline" className="text-[9px] h-4 px-1">{fmtSec(s.total_time_in_events_s)} total</Badge>
              <Badge variant="outline" className="text-[9px] h-4 px-1">+{s.avg_rise_bpm} bpm avg rise</Badge>
            </div>
        )}
        </div>
      }

      {result && (() => {
        const SECTIONS = [
          { key: "physiological_interpretation", label: "Physiological Interpretation", single: true, color: "hsl(var(--chart-3))" },
          { key: "pattern_analysis", label: "Pattern Analysis", color: "hsl(var(--primary))" },
          { key: "contextual_triggers", label: "Contextual Triggers", color: "hsl(var(--chart-4))" },
          { key: "role_in_arousal_arc", label: "Role in Arousal Arc", single: true, color: "hsl(var(--chart-2))" },
          { key: "recommendations", label: "Recommendations", color: "hsl(var(--accent))" },
        ];

        const paras = [];
        const paraMeta = [];
        if (result.summary) { paras.push(result.summary); paraMeta.push({ type: "summary" }); }
        for (const sec of SECTIONS) {
          if (sec.single) {
            if (result[sec.key]) { paras.push(result[sec.key]); paraMeta.push({ type: "section", sec, first: true }); }
          } else {
            (result[sec.key] || []).forEach((item, itemIdx) => {
              paras.push(item);
              paraMeta.push({ type: "section", sec, first: itemIdx === 0 });
            });
          }
        }

        return (
          <AIOutputReader
            sessionId="profiler_near_climax"
            title="Near-Climax Event Analysis"
            paragraphs={paras}
            summaryColor="hsl(var(--chart-3))"
            paragraphMeta={paraMeta}
          />
        );
      })()}
    </SectionCard>);

}

function StimulationMethodsPanel({ sessions, userProfile, evidenceLoading = false }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [jobStatus, setJobStatus] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    base44.entities.SessionClusterAnalysis.list("-updated_date", 1).then((rows) => {
      if (rows[0]?.stimulation_methods_result) setResult(rows[0].stimulation_methods_result);
    });
  }, []);

  const analyze = async () => {
    setLoading(true);
    setResult(null);
    setError("");
    setJobStatus({
      status: "starting",
      progress: {
        phase: "building",
        current: 0,
        total: 3,
        message: "Preparing stimulation methods analysis for the background queue..."
      }
    });

    try {
    // Build per-method aggregates
    const methodMap = {};
    for (const s of sessions) {
      const methods = [...(s.methods || []), ...(s.custom_methods || [])];
      for (const m of methods) {
        if (!methodMap[m]) methodMap[m] = [];
        methodMap[m].push(s);
      }
    }

    // Compute quick stats per method
    const methodStats = Object.entries(methodMap).map(([method, sessionList]) => {
      const withClimax = sessionList.filter(s => !s.no_climax);
      const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 : null;
      const examples = [...sessionList]
        .sort((a, b) => ((b.satisfaction || 0) - (a.satisfaction || 0)) || ((b.intensity || 0) - (a.intensity || 0)))
        .slice(0, 4)
        .map(compactSessionLine);
      return {
        method,
        session_count: sessionList.length,
        climax_rate_pct: sessionList.length ? Math.round((withClimax.length / sessionList.length) * 100) : 0,
        avg_intensity: avg(sessionList.map(s => s.intensity).filter(Boolean)),
        avg_satisfaction: avg(sessionList.map(s => s.satisfaction).filter(Boolean)),
        avg_build_quality: avg(sessionList.map(s => s.build_quality).filter(Boolean)),
        avg_max_hr: avg(sessionList.map(s => s.max_hr).filter(Boolean)),
        avg_hr_at_climax: avg(withClimax.map(s => s.hr_at_climax).filter(Boolean)),
        discomfort_rate_pct: Math.round((sessionList.filter(s => s.discomfort_entries?.length).length / sessionList.length) * 100),
        common_combos: [...new Set(sessionList.flatMap(s => [...(s.methods || []), ...(s.custom_methods || [])].filter(x => x !== method)))].slice(0, 5),
        examples,
      };
    }).sort((a, b) => b.session_count - a.session_count);

    const profileContext = userProfile ? `USER PROFILE: Arousal style: ${userProfile.arousal_response_style || "—"} | Preferred stimulation: ${(userProfile.preferred_stimulation || []).join(", ") || "—"} | Climax sensitivity: ${userProfile.climax_sensitivity || "—"} | Arousal notes: ${userProfile.arousal_notes || "none"}` : "";
    const groundingContext = buildAIGroundingContext(userProfile);

    const res = await runProfilerAIJob({
      model: "claude_sonnet_4_6",
      prompt: `You are a physiological research analyst specializing in sexual response and stimulation science. Analyze how different stimulation methods affect this person's sensations and physiology based on their session data. Write directly to the person — use "you" and "your" throughout.

${groundingContext}

CRITICAL FOR TEXT-TO-SPEECH QUALITY:
- Write all times as words: "ten minutes" not "10m"
- Spell out all numbers as words (e.g., "eight out of ten" not "8/10", "seventy-two beats per minute" not "72 bpm")
- Write in conversational prose with natural pauses — no bullet points or markdown
- Short sentences optimized for audio readability
${profileContext}

METHOD PERFORMANCE DATA (${sessions.length} sessions across ${methodStats.length} methods):
${methodStats.map((m) => [
  `${m.method}: ${m.session_count} sessions, ${m.climax_rate_pct}% climax, avg intensity ${m.avg_intensity ?? "?"}, avg satisfaction ${m.avg_satisfaction ?? "?"}, avg build ${m.avg_build_quality ?? "?"}, avg max HR ${m.avg_max_hr ?? "?"}, discomfort ${m.discomfort_rate_pct}%, common combos ${m.common_combos.join(", ") || "none"}.`,
  `Best examples: ${m.examples.join(" || ")}`,
].join("\n")).join("\n\n")}

Provide a deep, interpretive analysis. Do NOT simply restate the numbers — interpret what they reveal about this person's physiology, nerve response, and arousal dynamics. Be direct, opinionated, and specific.

Cover these areas:
1. METHOD EFFECTIVENESS PROFILE: For each method with meaningful data, form a clear opinion on its role — primary driver, arousal amplifier, or plateau extender? Rank them by their apparent physiological impact, not just by session count.
2. PHYSIOLOGICAL EFFECTS BY METHOD: How does each method seem to engage different physiological pathways? Reference HR patterns, build quality, and climax metrics. Which methods drive the strongest autonomic activation? Which tend toward sensory saturation?
3. COMBINATION EFFECTS: What method combinations appear in the best sessions vs. worst? Are there synergistic pairings you can identify from the data? Are any combinations associated with discomfort or diminishing returns?
4. AROUSAL & CLIMAX FINDINGS: Across all methods, what patterns emerge about how this person's body responds? Note anything surprising — unexpected correlations, methods that seem to punch above their weight, or methods associated with no-climax sessions.
5. DISCOMFORT & SENSITIVITY PATTERNS: Which methods correlate with discomfort entries and unusual sensations? What does this suggest about tissue sensitivity, nerve thresholds, or technique factors?
6. PERSONALIZED RECOMMENDATIONS: Give specific, actionable suggestions based on this exact data. Be bold and direct.

Each section should be 2-4 sentences of flowing, TTS-ready prose.`,
      response_json_schema: {
        type: "object",
        properties: {
          overview: { type: "string" },
          method_effectiveness: { type: "array", items: { type: "string" } },
          physiological_effects: { type: "array", items: { type: "string" } },
          combination_effects: { type: "array", items: { type: "string" } },
          arousal_and_climax_findings: { type: "array", items: { type: "string" } },
          discomfort_and_sensitivity: { type: "array", items: { type: "string" } },
          recommendations: { type: "array", items: { type: "string" } },
        },
        required: ["overview", "method_effectiveness", "physiological_effects", "combination_effects", "arousal_and_climax_findings", "recommendations"],
      },
    }, "AI Profiler: Stimulation Methods Analysis", setJobStatus, {
      priority: 15,
      meta: {
        reviewType: "stimulation_methods",
        session_count: sessions.length,
        method_count: methodStats.length,
      },
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const parsed = { ...raw?.response ?? raw, _method_stats: methodStats.map(m => ({ method: m.method, session_count: m.session_count, climax_rate_pct: m.climax_rate_pct, avg_satisfaction: m.avg_satisfaction, avg_intensity: m.avg_intensity, discomfort_rate_pct: m.discomfort_rate_pct })) };
    setResult(parsed);

    const existing = await base44.entities.SessionClusterAnalysis.list("-updated_date", 1);
    if (existing[0]) {
      await base44.entities.SessionClusterAnalysis.update(existing[0].id, { stimulation_methods_result: parsed });
    } else {
      await base44.entities.SessionClusterAnalysis.create({ stimulation_methods_result: parsed });
    }
    } catch (err) {
      console.error("Stimulation methods analysis failed:", err);
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const SECTIONS = [
    { key: "method_effectiveness", label: "Method Effectiveness", color: "hsl(var(--primary))" },
    { key: "physiological_effects", label: "Physiological Effects", color: "hsl(var(--chart-3))" },
    { key: "combination_effects", label: "Combination Effects", color: "hsl(var(--chart-2))" },
    { key: "arousal_and_climax_findings", label: "Arousal & Climax Findings", color: "hsl(var(--chart-4))" },
    { key: "discomfort_and_sensitivity", label: "Discomfort & Sensitivity", color: "hsl(var(--destructive))" },
    { key: "recommendations", label: "Recommendations", color: "hsl(var(--accent))" },
  ];

  const methodStats = result?._method_stats || [];

  const paras = [];
  const paraMeta = [];
  if (result) {
    if (result.overview) { paras.push(result.overview); paraMeta.push({ type: "overview" }); }
    for (const sec of SECTIONS) {
      (result[sec.key] || []).forEach((item, itemIdx) => {
        paras.push(item);
        paraMeta.push({ type: "section", sec, first: itemIdx === 0 });
      });
    }
  }

  return (
    <SectionCard icon={<Zap className="w-4 h-4" />} title="Stimulation Methods Analysis" color="hsl(var(--primary))" defaultCollapsed={true}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          How each stimulation method affects your physiology, arousal, and climax outcomes across sessions.
        </p>
        <Button size="sm" onClick={analyze} disabled={loading || evidenceLoading || sessions.length < 2} className="h-7 text-xs gap-1.5 shrink-0 ml-2">
          {loading
            ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</>
            : <><Brain className="w-3 h-3" />{result ? "Re-generate" : "Analyze Methods"}</>}
        </Button>
      </div>

      {!result && (
        <ProfilerPanelLoadingStatus
          items={[
            { active: evidenceLoading, label: "Session evidence for method comparison", status: "loading" },
          ]}
        />
      )}

      {!evidenceLoading && sessions.length < 2 && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" /> Need at least 2 sessions to analyze.
        </p>
      )}

      {/* Method stats grid */}
      {methodStats.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Method Overview</p>
          <div className="grid gap-2">
            {methodStats.map((m) => (
              <div key={m.method} className="flex flex-wrap items-center gap-2 bg-muted/40 rounded-lg px-3 py-2">
                <span className="text-xs font-semibold text-foreground min-w-[120px]">{m.method}</span>
                <Badge variant="outline" className="text-[9px] h-4 px-1">{m.session_count} sessions</Badge>
                <Badge variant="outline" className="text-[9px] h-4 px-1">{m.climax_rate_pct}% climax</Badge>
                {m.avg_satisfaction != null && <Badge variant="outline" className="text-[9px] h-4 px-1">sat {m.avg_satisfaction}/10</Badge>}
                {m.avg_intensity != null && <Badge variant="outline" className="text-[9px] h-4 px-1">int {m.avg_intensity}/10</Badge>}
                {m.discomfort_rate_pct > 0 && <Badge variant="outline" className="text-[9px] h-4 px-1 text-destructive border-destructive/40">{m.discomfort_rate_pct}% discomfort</Badge>}
              </div>
            ))}
          </div>
        </div>
      )}

      {!result && !loading && !evidenceLoading && sessions.length >= 2 && (
        <p className="text-xs text-muted-foreground">Click Analyze Methods to generate a deep physiological interpretation of each stimulation method. Uses Claude Sonnet.</p>
      )}

      <CompactError message={error} />
      {loading && (
        <ProfilerJobStatus
          job={jobStatus}
          fallback="Stimulation methods analysis is running in the background queue..."
        />
      )}

      {result && (
        <AIOutputReader
          sessionId="profiler_stim_methods"
          title="Stimulation Methods Analysis"
          paragraphs={paras}
          paragraphMeta={paraMeta}
        />
      )}
    </SectionCard>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function Profiler() {
  const [sessions, setSessions] = useState([]);
  const [bodyExplorations, setBodyExplorations] = useState([]);
  const [allTimelines, setAllTimelines] = useState({});
  const [userProfile, setUserProfile] = useState(null);
  const [journals, setJournals] = useState([]);
  const [sessionEvidenceLoading, setSessionEvidenceLoading] = useState(true);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [profileContextLoading, setProfileContextLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [refreshingEvidence, setRefreshingEvidence] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSessionEvidenceLoading(true);
    setTimelineLoading(true);
    setLoadError("");
    setAllTimelines({});

    const loadSessionsAndTimelines = async () => {
      try {
        const [all, explorations] = await Promise.all([
          base44.entities.Session.list("-date", 300),
          base44.entities.BodyExploration.list("-date", 150).catch(() => []),
        ]);
        if (cancelled) return;
        setSessions(all);
        setBodyExplorations(explorations || []);
        setSessionEvidenceLoading(false);

        // HR timelines are useful for secondary analysis, but should never block the saved profile UI.
        const withData = all.filter((session) => session.climax_offset_s != null || session.avg_hr != null);
        const BATCH = 5;
        for (let i = 0; i < withData.length; i += BATCH) {
          const chunk = withData.slice(i, i + BATCH);
          const results = await Promise.all(
            chunk.map((session) =>
              base44.entities.HeartRateTimeline.filter({ session: session.id }, "time_offset_s", 5000).then((rows) => [session.id, rows])
            )
          );
          if (cancelled) return;
          setAllTimelines((current) => {
            const next = { ...current };
            results.forEach(([sessionId, rows]) => {
              if (rows.length > 0) next[sessionId] = rows;
            });
            return next;
          });
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error?.message || "Could not load current profiler evidence.");
          setSessionEvidenceLoading(false);
        }
      } finally {
        if (!cancelled) setTimelineLoading(false);
      }
    };

    loadSessionsAndTimelines();
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  useEffect(() => {
    let cancelled = false;
    setProfileContextLoading(true);
    base44.auth.me()
      .then((me) => {
        if (!cancelled) setUserProfile(me);
      })
      .catch(() => {
        if (!cancelled) setUserProfile(null);
      })
      .finally(() => {
        if (!cancelled) setProfileContextLoading(false);
      });
    base44.entities.Journal.list("-session_date", 300)
      .then((rows) => {
        if (!cancelled) setJournals(rows);
      })
      .catch(() => {
        if (!cancelled) setJournals([]);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  const refreshEvidence = async () => {
    setRefreshingEvidence(true);
    setLoadError("");
    try {
      const [all, explorations] = await Promise.all([
        base44.entities.Session.list("-date", 300),
        base44.entities.BodyExploration.list("-date", 150).catch(() => []),
      ]);
      setSessions(all);
      setBodyExplorations(explorations || []);
    } catch (error) {
      setLoadError(error?.message || "Could not refresh current profiler evidence.");
    } finally {
      setRefreshingEvidence(false);
    }
  };

  const refreshUserProfileContext = async () => {
    const me = await base44.auth.me();
    setUserProfile(me);
    return me;
  };

  return (
    <div className="px-4 py-6 pb-24 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">AI Profiler</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {sessionEvidenceLoading
              ? "Loading saved session evidence..."
              : `${sessions.length} sessions · ${bodyExplorations.length} explorations · ${timelineLoading ? "loading HR timelines" : `${Object.keys(allTimelines).length} with HR data`} · ${summarizeMotionEvidenceCoverage(sessions).any} with motion evidence`}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={refreshEvidence} disabled={refreshingEvidence} className="gap-1.5 text-xs">
          <RefreshCw className={`h-3.5 w-3.5 ${refreshingEvidence ? "animate-spin" : ""}`} />
          {refreshingEvidence ? "Refreshing evidence..." : "Refresh evidence"}
        </Button>
      </div>

      {loadError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3">
          <p className="text-sm text-destructive">{loadError}</p>
          <Button size="sm" variant="outline" onClick={() => setLoadAttempt((attempt) => attempt + 1)} className="h-8 text-xs">
            Retry loading evidence
          </Button>
        </div>
      )}

      <AIProfilePanel sessions={sessions} userProfile={userProfile} journals={journals} evidenceLoading={sessionEvidenceLoading} />
      <AnatomicalPhysiologicalProfilePanel
        sessions={sessions}
        allTimelines={allTimelines}
        userProfile={userProfile}
        profileLoading={profileContextLoading}
        evidenceLoading={sessionEvidenceLoading}
        timelineLoading={timelineLoading}
      />
      <ProfileImageReviewPanel
        config={HEAD_TO_TOE_IMAGE_REVIEW_CONFIG}
        sessions={sessions}
        bodyExplorations={bodyExplorations}
        userProfile={userProfile}
        refreshUserProfile={refreshUserProfileContext}
        profileLoading={profileContextLoading}
        evidenceLoading={sessionEvidenceLoading}
      />
      <ProfileImageReviewPanel
        config={PELVIC_GENITAL_IMAGE_REVIEW_CONFIG}
        sessions={sessions}
        bodyExplorations={bodyExplorations}
        userProfile={userProfile}
        refreshUserProfile={refreshUserProfileContext}
        profileLoading={profileContextLoading}
        evidenceLoading={sessionEvidenceLoading}
      />
      <StimulationMethodsPanel sessions={sessions} userProfile={userProfile} evidenceLoading={sessionEvidenceLoading} />
      <NearClimaxPanel sessions={sessions} allTimelines={allTimelines} userProfile={userProfile} timelineLoading={timelineLoading} />
    </div>
  );
}
