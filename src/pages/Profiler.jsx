import { useState, useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { serverUrl } from "@/lib/mobileApiBase";
import { downloadOrSaveUrl } from "@/lib/nativeFileSaver";
import { readWatermarkSettings } from "@/lib/watermarkSettings";
import { videoPosterDataUrl } from "@/lib/videoPoster";
import { Brain, Activity, AlertCircle, Zap, TrendingUp, Heart, Lightbulb, User, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, RefreshCw, History, Film, Image as ImageIcon, Upload, X, Download, Loader2, Video } from "lucide-react";
import TTSReader from "../components/TTSReader";
import AIOutputReader from "../components/AIOutputReader";
import { normalizeJournalEntry } from "@/lib/journalEntry";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ANATOMICAL_REFERENCE_FOCUS_RULE, buildAIGroundingContext, buildOptionalFirstNameToneCue, PERSONALIZED_ANATOMY_OUTPUT_RULE, SARAH_APP_OVERLAY_TELEMETRY_RULE } from "@/lib/aiGrounding";
import { loadLatestProfilerAnalysis, loadUserProfileWithProfilerResults, mergeProfilerResultsIntoProfile } from "@/lib/profileContext";
import { getBackgroundJob, listBackgroundJobs, startBackgroundJob, waitForBackgroundJob } from "@/lib/backgroundJobs";
import { friendlyJobErrorMessage, providerErrorCategory } from "@/lib/jobErrorMessages";
import { SESSION_CONTEXT_GROUNDING_RULE, sessionContextEvidenceText, sessionContextFactorLabels } from "@/lib/sessionContext";
import { getManualStimulationPauseResumeEvents, getMotionEvidenceSummary, summarizeMotionEvidenceCoverage } from "@/utils/sessionMotionEvidence";
import { buildProfileAIContentMeta, formatGeneratedAt, isProfileAIContentStale } from "@/utils/aiContentMetadata";
import { splitSentencesPreservingDecimals } from "@/utils/aiTextRepair";
import { buildLongitudinalHrvEvidence, RR_HRV_INTERPRETATION_RULES } from "@/utils/hrvEvidence";
import { buildProfileQaFindingCards, makeProfileQaEntry, normalizeProfileQaFindings } from "@/lib/profileQa";
import { buildAudioChapterBundle } from "@/lib/audioChapters";
import { cleanTextForSpeech, getTTSRuntime, loadTTSSettings, prepareTTSInput, splitIntoChunks, TTS_CHUNK_TARGET_CHARS } from "@/components/TTSButton";
import {
  ANATOMY_REVIEW_ASSIGNMENT_CONTRACT,
  cleanProfileImageReviewText,
  cleanupProfileImageReviewResult,
  profileImageReviewTopicKey,
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

function trailingTtsContext(text, maxChars = 320) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  return cleaned.length > maxChars ? cleaned.slice(-maxChars) : cleaned;
}

function buildProfilerVideoChunks(paragraphs = []) {
  const chunks = [];
  const combinedParagraphs = [];
  let current = "";

  const pushCurrent = () => {
    const cleaned = current.trim();
    if (cleaned) combinedParagraphs.push(cleaned);
    current = "";
  };

  paragraphs.forEach((paragraph) => {
    const cleaned = cleanTextForSpeech(paragraph);
    if (!cleaned) return;
    const next = current ? `${current}\n\n${cleaned}` : cleaned;
    if (current && next.length > TTS_CHUNK_TARGET_CHARS) pushCurrent();
    if (cleaned.length > TTS_CHUNK_TARGET_CHARS) {
      splitIntoChunks(cleaned, TTS_CHUNK_TARGET_CHARS).forEach((part) => {
        const partText = part.trim();
        if (partText) combinedParagraphs.push(partText);
      });
      return;
    }
    current = current ? `${current}\n\n${cleaned}` : cleaned;
  });
  pushCurrent();

  let previousText = "";
  combinedParagraphs.forEach((part) => {
    const text = prepareTTSInput(part);
    if (!text) return;
    chunks.push({
      text,
      previousContext: trailingTtsContext(previousText),
    });
    previousText = previousText ? `${previousText} ${part}` : part;
  });
  return chunks;
}

function profileVideoFilename(title = "Profile Anatomy Video") {
  return `${String(title || "Profile Anatomy Video")
    .replace(/^AI\s+/i, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "Profile-Anatomy-Video"}.mp4`;
}

const PROFILE_ARCHIVE_LIMIT = 30;
const PROFILE_IMAGE_REVIEW_MAX_TOKENS = 16000;
const PROFILE_IMAGE_REVIEW_BATCH_SIZE = 5;
const PROFILE_IMAGE_ID_REPAIR_VERSION = 1;
const PROFILE_OBSERVATION_PRODUCT_RULE = `
PROFILE OBSERVATION PRODUCT RULE - HIGHEST PRIORITY:
- The person is the subject. The upload is only new evidence entering the library.
- Use the full saved anatomical evidence library when reasoning: images, videos, sampled frames, annotations, prior Sarah reviews, measurements, Q&A findings, session/body-exploration evidence, and telemetry-linked evidence.
- The user-facing review should describe the current body/anatomy picture. Do not narrate evidence bookkeeping, database state, confidence accumulation, batch mechanics, source reconciliation, prior corrections, or invalidated findings unless Ben explicitly asks for that audit trail.
- Default mode is OBSERVE, not defend or prove. Write what is seen and what has meaningfully changed. Stop there.
- Corrections silently update the current truth. Never remind the reader about previous mistakes, invalidated scars/findings, or left/right correction history in the review text.
- Comparison mode is allowed only for meaningful change: healing, bruising, swelling, lesion/wound evolution, new asymmetry, device/tissue change, or explicit user request. Otherwise describe current findings only.
- Avoid database phrases in final prose: "evidence record", "prior documentation", "strongly established", "confidence accumulation", "baseline establishment", "current batch", "current pass", "image subset", "rechecked saved/direct views", "invalidated", "correction", and "remains consistent with prior".
- Good output: "The catheter exits centrally from the meatus and the surrounding tissue appears healthy." Bad output: "This remains consistent with the strongly established catheter accommodation baseline."
`;
const PROFILE_IMAGE_EVIDENCE_LAYER_RULE = `
PROFILE IMAGE EVIDENCE LAYER RULE:
- Keep evidence layers distinct internally, but do not turn them into the product.
- Treat each finding as direct visual evidence, saved visual/profile evidence, or cautious interpretation while reasoning. In final prose, write the observation rather than the evidence bucket unless the source materially changes the meaning.
- If a finding is visible in the newest upload, describe it as visible now.
- If a finding is not freshly visible but is already part of the saved anatomical graph, include the current anatomical truth briefly without saying the region was absent from this upload.
- If a finding comes only from profile/history, use it sparingly and only when useful to understand the person.
- Direct visual evidence means only what is visible in reviewed images/frames. Use wording such as "visible", "appears", "is seen", or "no visible" when it helps.
- Profile or saved-evidence reconciliation should stay behind the scenes unless there is a meaningful change. Do not overuse "consistent with" or "consistently".
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
- Write like an experienced anatomical observer, not a database export. Short present-tense observations are better than long proof paragraphs.
`;

const PROFILE_VIDEO_FRAME_EVIDENCE_RULE = `
PROFILE VIDEO FRAME EVIDENCE RULE:
- Uploaded videos are represented to Sarah as sampled still frames with source-video timing metadata.
- Treat same-video sampled frames as sequence evidence for visible posture change, gait phase, device/contact position changes, or ruler/measurement alignment only when the sampled frames show it.
- Do not claim full continuous video review, exact timing between unsampled moments, insertion depth, force, pain, intent, or completed device/procedure steps unless the sampled frames and user note directly support it.
- For gait or movement, describe visible mechanics cautiously: stance, stride phase, weight shift, limb alignment, foot placement, balance, and asymmetry visible across frames.
- For ruler/measurement videos, reconcile only visible ruler alignment and scale relationship. Do not invent exact measurements from unclear or oblique frames.
`;

const PROFILE_IMAGE_INSIGHT_EFFICIENCY_RULE = `
PROFILE IMAGE INSIGHT-EFFICIENCY RULE:
Core goal: maximize organized anatomical value per paragraph, not produce a shorter report. Sarah should stay warm, clinical, evidence-based, anatomically useful, less repetitive, and confidence-calibrated while preserving comprehensive coverage.

BASELINE VS NEW FINDINGS:
- Treat stable anatomy as part of the current body map. Before documenting any finding, ask whether the reader needs detail now. If it appears unchanged, summarize the current appearance briefly without narrating how it was established.
- Spend detail only on newly visible structures, changed findings, improved image coverage, healing/progression, new posture findings, new skin findings, or newly visible anatomical regions.
- Do not turn stable anatomy into a fresh discovery every report. Stable scrotal anatomy, stable perineal raphe, stable central adiposity, and stable follicular papules should be summarized once unless something changed.

DEDUPLICATION:
- A unique finding should generally be described once. Do not repeat the same finding in Head-to-Toe, Skin, Habitus, Pelvic, Summary, and callouts.
- Do not paste callout text again into narrative sections. Use callouts as visual anchors; use narrative sections for synthesis.
- Use short cross-references such as "details belong in the pelvic section" or "summarized under skin findings" instead of repeating paragraphs.
- Convert repeated findings into concise current-observation language during synthesis and final output.

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
- Generate: comprehensive current anatomical assessment, stable baseline findings, new findings, changed findings, active findings, significant findings, and coverage gaps.
- Avoid: entire historical narrative, repeated anatomy descriptions, repeated confidence statements, repeated callout text, source/provenance/process narration, correction chatter, and internal anatomy boilerplate.
- Do not add source/provenance/process sections to satisfy these rules. Apply them inside the existing anatomy-centered sections.
`;

const PROFILE_IMAGE_CUMULATIVE_SCOPE_RULE = `
CUMULATIVE PROFILE REVIEW SCOPE:
- This artifact is a full profile assessment of Ben, not a one-time review of only the newest or directly attached images.
- Treat directly attached/reloaded images as new evidence objects. Use them to update, correct, and enrich the saved anatomical graph.
- The scope of the user-facing review is the person across the whole cumulative evidence base: direct images, saved Profile Q&A findings, prior Sarah visual reviews, session/body-exploration visual evidence, entered profile metrics, and relevant saved context.
- Do not open the review with "based on five images", "based on X images", "these five images", "the recent images", or similar narrow framing.
- Do not use pass-scoped language in the user-facing review. Banned phrases include "this pass", "current pass", "recent photos", "newest photos", "current image subset", "image subset", "not represented in this pass", and "not visible in this pass".
- If scope must be mentioned, say it briefly: "This review reflects the current saved anatomical profile with the newest evidence folded in."
- If exact image counts are useful, mention them only as evidence-method detail, not as the scope of the whole analysis.
`;

const PROFILE_IMAGE_COMPLETE_MAP_RULE = `
COMPLETE BODY MAP + CHANGE LAYER RULE - HIGHEST PRIORITY:
- Ben expects each Head-to-Toe or Pelvic/Genital review to preserve the whole established anatomical picture, not to replace it with only the newest image subset.
- For every required section, write the best current cumulative understanding first, then layer new, changed, newly rechecked, or newly contradicted findings on top.
- Do not make "not visible in this image subset" the main content of a region if saved evidence exists. Instead, describe the current anatomical picture and add a short visibility note only if it affects confidence.
- Do not degrade established findings into absence just because the newest photos do not cover that region. A region can be "stable from established baseline" without being directly rephotographed today.
- Never write a section whose main content is "Not represented in this pass", "Not visible in this pass", "Not directly reassessed in this pass", "Stable from prior established baseline", or "Baseline carried forward." Those are implementation notes, not an assessment.
- If a required region has saved evidence, the section must summarize the actual finding in plain anatomical language. Example: "Neck contour appears unremarkable with no saved finding of mass, asymmetry, or skin concern." Do not stop at saying the region was absent from the latest photos.
- If a required region has no evidence anywhere in the cumulative library, say "No established baseline yet for this region" and move on. Do not describe that as a current-pass limitation.
- New/current images are change detection and quality improvement evidence. They should update the cumulative map, not narrow the report's scope.
- Each section should answer two questions in this order: "What is the current body/anatomy picture here?" and then "What, if anything, is new, changing, or better documented?"
- Avoid producing a patch-note report. The reader should come away with one coherent head-to-toe or pelvic/genital profile plus a clear sense of what changed.
- Avoid long absence inventories. If a body region has no useful evidence at all, use one concise sentence. If it has prior evidence, summarize that prior baseline instead of saying only that it is not visible now.
`;

const PROFILE_IMAGE_COMPREHENSIVE_EXAM_RULE = `
COMPREHENSIVE MULTIDISCIPLINARY PHYSICAL EXAM RULE - HIGHEST PRIORITY:
- The Head-to-Toe Review and Pelvic/Genital Review are longitudinal visual anatomy documentation products. Their job is to answer: "What does this person look like today in the requested anatomical scope?"
- Do not convert the report into a novelty detector, wound tracker, change log, or "most interesting finding" summary.
- Anatomical completeness outranks novelty. Every configured anatomical section should receive meaningful attention when evidence exists, even when the finding is normal, stable, or unchanged.
- Head-to-Toe should read like one combined physical examination written by primary care, dermatology, orthopedics, physical therapy, vascular medicine, general surgery, urology, and wound care.
- Pelvic/Genital should read like a focused external pelvic/genital/perineal examination written by urology plus primary care, with gynecology-style structure and tissue-health discipline when anatomy makes that lens relevant. Use the person's documented/visible anatomy rather than forcing a sex-specific template.
- Executive Summary must describe the whole requested anatomical scope first: overall appearance, body habitus or regional contour, posture where relevant, skin overview, major scars, major active findings, extremity or regional overview, notable anatomical characteristics, and important interval changes.
- Executive Summary must not become a pathology spotlight. A healing wound, catheter, mole, scar, edema episode, or isolated lesion may be mentioned once if clinically important, but it must not dominate the summary.
- Separate baseline findings from active findings. Baseline findings include body habitus, posture, stable skin distribution, scars, anatomical characteristics, and long-term observations. Active findings include healing wound, edema, bruising, catheterization state, new lesions, irritation, and interval changes.
- Put findings in their anatomical home. Document a dog bite in Abdomen/Skin, a hernia repair scar in Abdomen/Pelvis, edema in Lower Limbs/Feet, genital visibility in Genitals/Perineum, and posture in Posture & Alignment. Do not reintroduce the same finding repeatedly in unrelated sections.
- For Pelvic/Genital, put findings in their structure-specific home: pubic mound/lower abdomen, inguinal folds/groin skin, penis/shaft, foreskin, glans/meatus, scrotum/testes, perineum, anal/perianal region, buttocks/gluteal skin, device/contact findings, tissue health, and measurement reconciliation. Do not let catheter/device status dominate sections where it is not the main anatomical subject.
- Preserve richness by organizing detail, not deleting detail. Use concise synthesis for stable findings and deeper description for regions with active findings, improved coverage, or meaningful clinical relevance.
- Evidence notes and callouts may support the report, but the main clinical assessment should not read like pasted raw evidence notes.
- If a region has no established evidence anywhere, state that once in that region. Do not let missing coverage replace meaningful assessment of represented regions.
`;

const PROFILE_IMAGE_INCREMENTAL_EVIDENCE_RULE = `
LONGITUDINAL EVIDENCE / CREDIT DISCIPLINE RULE - HIGHEST PRIORITY:
- Sarah is building a longitudinal anatomical record. Do not rediscover stable anatomy during every review.
- Use the established evidence records below as memory. Treat directly attached images as a change-detection pass against that baseline.
- Step 1: identify which anatomical regions are actually visible in the current images.
- Step 2: compare visible regions against established evidence records.
- Step 3: spend detailed analysis only on new anatomy, changed anatomy, suspected pathology, contradicted evidence, substantially better image quality, meaningful longitudinal progression, or a user-requested detailed re-review.
- If stable anatomy is unchanged, summarize it briefly. Good: "Previously established genital and perineal baseline remains stable; no significant change detected."
- Do not spend meaningful output budget repeatedly proving that the perineal raphe, foreskin, glans, scrotum, anal baseline, or flaccid genital baseline still exists once established.
- High-priority changes: new or changing scars, new lesions, mole changes, edema, bruising, surgical changes, skin changes, weight/body-composition progression, respiratory pattern changes, and postural changes.
- Medium-priority changes: muscle development, symmetry, pelvic alignment, stance, limb/foot morphology, and posture profile.
- Low-priority repeats: normal raphe visibility, unchanged foreskin coverage, unchanged glans/scrotal appearance, unchanged anal verge, unchanged buttock/perineal baseline.
- Visual callouts should represent the best evidence ever obtained or the newest image showing meaningful change. Do not create a new callout only because another identical view exists.
- Prefer evidence quality over recency. New images should be promoted to callouts when they improve coverage, clarify uncertainty, contradict baseline, or show change.
- If no meaningful change is visible, keep the final report comprehensive but organized: describe the current whole-body baseline, then say plainly where no meaningful interval change is evident. Do not become vague or omit major represented regions just because they are stable.
- Each new or updated evidence finding should preserve confidence, first observed date, last confirmed date, source images, and evidence strength when possible.
`;

const PROFILE_IMAGE_LEFT_RIGHT_ORIENTATION_RULE = `
ANATOMICAL LEFT / RIGHT ORIENTATION RULE - HIGH PRIORITY:
- Use anatomical left/right, meaning the subject's own left and right, not viewer-left/viewer-right.
- For anterior or front-facing photos where the person is facing the camera, the image's screen-left side is the subject's anatomical right, and the image's screen-right side is the subject's anatomical left.
- For posterior or back-facing photos where the person's back faces the camera, screen-left is the subject's anatomical left, and screen-right is the subject's anatomical right.
- For true lateral views, label the visible side only when the side is clear from the image, user note, or saved context. Otherwise say lateral view without assigning left or right.
- Preserve anatomical identity across poses and camera angles. A bruise, mole, scar, catheter/tubing position, pelvic finding, genital finding, or skin mark on the person's anatomical right remains right-sided when they move from supine to standing, turn toward the camera, rotate, or appear in a different crop. Do not relabel the same physical finding left/right just because it moves to the opposite side of the screen.
- When reconciling multiple views, track stable landmarks such as the umbilicus, sternum, pubic mound, inguinal creases, thighs, known scars, moles, bruises, catheter exit angle, and user-labeled side notes. Use those landmarks to preserve side identity before assigning a new left/right label.
- For supine, foot-of-table, overhead, mirrored, rotated, composite, close-cropped pelvic/genital, or partial abdomen views, assume screen position may be misleading. If the same finding appears in another orientation, keep the anatomical label from the clearest labeled view unless stronger landmarks prove otherwise.
- For mirror/reflection images, rotated images, close crops, or unclear orientation, do not guess anatomical side. Use "screen-left", "screen-right", "one side", or "the opposite side" and mark side assignment uncertain.
- User image notes such as "facing camera", "right side scar", "left lateral", or "posterior view" are orientation context and should guide anatomical side labeling when consistent with the visible image.
- Do not convert viewer-side observations into anatomical left/right unless the view orientation is clear. If there is any doubt, preserve uncertainty rather than assigning the wrong side.
`;

const PROFILE_IMAGE_REVIEW_RULE_BUNDLE = [
  ANATOMY_REVIEW_ASSIGNMENT_CONTRACT,
  PROFILE_IMAGE_EVIDENCE_LAYER_RULE,
  PROFILE_IMAGE_VISIBLE_FINDINGS_FIRST_RULE,
  PROFILE_VIDEO_FRAME_EVIDENCE_RULE,
  PROFILE_IMAGE_INSIGHT_EFFICIENCY_RULE,
  PROFILE_IMAGE_CUMULATIVE_SCOPE_RULE,
  PROFILE_IMAGE_COMPLETE_MAP_RULE,
  PROFILE_IMAGE_COMPREHENSIVE_EXAM_RULE,
  PROFILE_IMAGE_INCREMENTAL_EVIDENCE_RULE,
  PROFILE_IMAGE_LEFT_RIGHT_ORIENTATION_RULE,
].join("\n\n");

const EVIDENCE_STRENGTH_ORDER = ["provisional", "baseline", "established", "strongly_established"];
const STRONGLY_ESTABLISHED_EVIDENCE_KEYS = new Set([
  "perineal_raphe",
  "foreskin_mobility",
  "flaccid_genital_baseline",
  "anal_baseline",
  "scrotal_baseline",
  "glans_baseline",
  "meatal_baseline",
]);
const ESTABLISHED_EVIDENCE_KEYS = new Set([
  "right_inguinal_scar",
  "abdominal_mole",
  "left_abdominal_scar",
]);
const BASELINE_EVIDENCE_KEYS = new Set([
  "shoulder_alignment",
  "posture_profile",
  "foot_morphology",
  "central_adiposity",
  "skin_papules",
]);

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
    .replace(/\[object Object\]/gi, "")
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
  const nonPelvicRegion = /(foot|feet|toe|toes|ankle|heel|lower leg|calf|knee|thigh|abdomen|abdominal|chest|shoulder|back|neck|face|head)/i.test(text);
  const fullBody = /(full body|full-body|whole body|whole-body|head-to-toe|head to toe|crown to feet|feet visible|standing full)/i.test(text);
  return closePelvic && !fullBody && !nonPelvicRegion;
}

function inferAnatomyViewLabel(image = {}) {
  const combined = [image.view_label, image.body_position, image.coverage, image.visibility_notes, ...(Array.isArray(image.major_regions_visible) ? image.major_regions_visible : [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const label = String(image.view_label || "");
  if (!/close-up pelvic\/genital reference view|whole-body standing posture is not established|posture labels are intentionally conservative/i.test([image.body_position, image.visibility_notes, label].filter(Boolean).join(" "))) {
    return image;
  }
  const cleanMeta = (value = "") => String(value || "")
    .replace(/\bclose-up pelvic\/genital reference view;\s*/gi, "")
    .replace(/\bclose-up pelvic\/genital reference view\.?\s*/gi, "")
    .replace(/\bwhole-body standing posture is not established by this frame\.?\s*/gi, "")
    .replace(/\bposture labels are intentionally conservative for close-up pelvic views\.?\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  let inferredLabel = "";
  if (/\b(feet|foot|toes?|ankles?|heels?)\b/.test(combined)) inferredLabel = "Foot and ankle reference view";
  else if (/\b(lower leg|calf|knee|thigh|lower limb)\b/.test(combined)) inferredLabel = "Lower-limb reference view";
  else if (/\b(abdomen|abdominal|flank|umbilicus|bite wound)\b/.test(combined)) inferredLabel = "Abdominal reference view";
  else if (/\b(chest|shoulder|back|neck|face|head)\b/.test(combined)) inferredLabel = "Body-reference view";
  return {
    ...image,
    view_label: inferredLabel || cleanMeta(image.view_label) || "Reviewed anatomy view",
    body_position: cleanMeta(image.body_position),
    coverage: cleanMeta(image.coverage),
    visibility_notes: cleanMeta(image.visibility_notes),
  };
}

function sanitizeImagePositionClaims(image = {}) {
  image = inferAnatomyViewLabel(image);
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

const PELVIC_GENITAL_REVIEW_KIND = "profile_pelvic_genital_image_review";
const PELVIC_GENITAL_SCOPE_SECTION_KEYS = new Set([
  "executive_summary",
  "pubic_mound_lower_abdomen",
  "inguinal_folds_groin_skin",
  "penis",
  "foreskin",
  "glans_meatus",
  "scrotum_testes",
  "perineum",
  "anal_opening_perianal_region",
  "buttocks_gluteal_skin",
  "device_contact_findings",
  "tissue_health_safety_observations",
  "measurement_reconciliation",
  "limitations_future_coverage",
]);
const PELVIC_GENITAL_STRONGLY_POSITIVE_RE = /\b(pubic|inguinal|groin|genital|genitals|penis|penile|shaft|foreskin|glans|meatus|meatal|urethra|urethral|scrotum|scrotal|testes|testicle|perineum|perineal|anal|anus|perianal|buttock|gluteal|foley|catheter|statlock|rectal|prostate|pelvic)\b/i;
const PELVIC_GENITAL_FORBIDDEN_EVIDENCE_RE = /\b(foot|feet|toe|toes|ankle|ankles|heel|heels|dorsal foot|plantar|lower leg|lower legs|lower limb|lower limbs|lower extremity|lower extremities|calf|calves|shin|shins|knee|knees|malleolar|ankle edema|foot edema|lower-leg edema|lower limb edema|lower-limb edema|lower extremity edema|lower-extremity edema|venous engorgement|dog bite|bite wound|dog nip|bite zone|abdominal bite|abdominal wound|standing abdominal view|right lateral abdominal|right lateral lower abdominal|abdomen bite|abdominal bruise|ecchymosis|ecchymotic|yellow-green bruise|puncture point)\b/i;
const PELVIC_GENITAL_NEGATED_SCOPE_RE = /\b(no|not|without|absent|lacks|lack)\s+(?:visible\s+|direct\s+|clear\s+|obvious\s+|discernible\s+|meaningful\s+){0,4}(?:pubic|inguinal|groin|genital|pelvic|penis|penile|glans|meatus|scrotum|perineum|anal|perianal|foley|catheter)\b/i;
const HEAD_TO_TOE_BODY_REGION_BUCKETS = [
  { key: "head_face", label: "head and face", quota: 4, re: /\b(head|face|facial|forehead|scalp|hair|temple|eye|eyes|eyebrow|eyebrows|glasses|nose|nasal|cheek|cheeks|ear|ears|mouth|lips|chin|jaw|beard|moustache|mustache)\b/i },
  { key: "neck", label: "neck", quota: 3, re: /\b(neck|cervical|throat|nape)\b/i },
  { key: "shoulders_upper_back", label: "shoulders and upper back", quota: 4, re: /\b(shoulder|shoulders|upper back|thoracic|scapula|scapular|trapezius|posterior trunk|back view)\b/i },
  { key: "chest", label: "chest", quota: 4, re: /\b(chest|pectoral|pectorals|nipple|nipples|sternum|rib|ribs|thorax|anterior trunk)\b/i },
  { key: "abdomen", label: "abdomen", quota: 4, re: /\b(abdomen|abdominal|belly|umbilicus|navel|pannus|flank|waist|hernia|bruise|ecchymosis)\b/i },
  { key: "pelvis_pubic_region", label: "pelvis and pubic region", quota: 3, re: /\b(pelvis|pelvic|pubic|suprapubic|inguinal|groin|hip|hips)\b/i },
  { key: "upper_limbs_hands", label: "upper limbs and hands", quota: 4, re: /\b(arm|arms|upper limb|upper limbs|elbow|elbows|forearm|forearms|wrist|wrists|hand|hands|finger|fingers|thumb|thumbs)\b/i },
  { key: "lower_limbs", label: "lower limbs", quota: 4, re: /\b(leg|legs|lower limb|lower limbs|thigh|thighs|knee|knees|calf|calves|shin|shins|ankle|ankles|edema|varicos|standing)\b/i },
  { key: "feet_toes", label: "feet and toes", quota: 4, re: /\b(foot|feet|toe|toes|heel|heels|plantar|dorsal foot|arches|arch|malleolar)\b/i },
  { key: "posture_alignment", label: "posture and alignment", quota: 5, re: /\b(full[-\s]?body|whole[-\s]?body|head[-\s]?to[-\s]?toe|standing|anterior|posterior|lateral|front view|back view|side view|posture|alignment|symmetry|habit(?:us)?|body reference|body-reference|baseline set)\b/i },
  { key: "skin_summary", label: "skin surface", quota: 4, re: /\b(skin|lesion|lesions|rash|papule|papules|follicular|folliculitis|redness|erythema|scar|scars|mark|marks|bruise|bruising|ecchymosis|wound|bite|pigmentation|color)\b/i },
];
const HEAD_TO_TOE_PELVIC_CLOSEUP_RE = /\b(close-up|closeup|pelvic close|genital close|perineal close|perianal close|glans close|meatus close|foley|catheter|lithotomy|sounding|dilator)\b/i;

function compactEvidenceText(...parts) {
  const seen = new WeakSet();
  const meaningfulObjectKeys = [
    "display_label",
    "view_label",
    "body_position",
    "coverage",
    "visibility_notes",
    "upload_note",
    "selection_prompt",
    "selection_review_context",
    "source",
    "filename",
    "title",
    "label",
    "region",
    "finding",
    "description",
    "summary",
    "note",
    "purpose",
    "limitations",
    "major_regions_visible",
  ];
  const collect = (part) => {
    if (part == null || part === false) return [];
    if (typeof part === "string" || typeof part === "number" || typeof part === "boolean") {
      const text = String(part).replace(/\[object Object\]/gi, "").trim();
      return text ? [text] : [];
    }
    if (Array.isArray(part)) return part.flatMap(collect);
    if (typeof part === "object") {
      if (seen.has(part)) return [];
      seen.add(part);
      const selected = meaningfulObjectKeys.flatMap((key) => collect(part[key]));
      if (selected.length) return selected;
      return Object.values(part)
        .filter((value) => value == null || typeof value !== "object" || Array.isArray(value))
        .flatMap(collect);
    }
    return [];
  };
  return parts.flatMap(collect).map((part) => String(part || "").trim()).filter(Boolean).join(" ");
}

function inferHeadToToeCoverageTags(...parts) {
  const text = compactEvidenceText(...parts);
  if (!text.trim()) return [];
  return HEAD_TO_TOE_BODY_REGION_BUCKETS
    .filter((bucket) => bucket.re.test(text))
    .map((bucket) => bucket.key);
}

function headToToeCoverageLabels(tags = []) {
  const set = new Set(Array.isArray(tags) ? tags : []);
  return HEAD_TO_TOE_BODY_REGION_BUCKETS
    .filter((bucket) => set.has(bucket.key))
    .map((bucket) => bucket.label);
}

function headToToeAttachmentCoverageTags(attachment = {}) {
  return inferHeadToToeCoverageTags(
    attachment.display_label,
    attachment.filename,
    attachment.body_position,
    attachment.coverage,
    attachment.visibility_notes,
    attachment.major_regions_visible,
    attachment.selection_tags,
    attachment.selection_prompt,
    attachment.selection_review_context,
    attachment.source_video?.note,
    attachment.source_video?.purpose,
  );
}

function isPelvicGenitalReviewResult(result = null, config = null) {
  if (config?.kind === PELVIC_GENITAL_REVIEW_KIND) return true;
  if (result?._meta?.reviewType === PELVIC_GENITAL_REVIEW_KIND) return true;
  return [
    "pubic_mound_lower_abdomen",
    "inguinal_folds_groin_skin",
    "penis",
    "foreskin",
    "glans_meatus",
    "scrotum_testes",
    "perineum",
    "anal_opening_perianal_region",
  ].some((key) => Array.isArray(result?.[key]));
}

function pelvicGenitalImageEvidenceText(result, imageId, transientImages = [], finding = null) {
  const image = imageId ? rawProfileImageById(result, imageId, transientImages) : {};
  const annotation = Array.isArray(result?.annotated_images)
    ? result.annotated_images.find((item) => item?.image_id === imageId) || {}
    : {};
  const sourceText = compactEvidenceText(
    image?.display_label,
    image?.body_position,
    image?.coverage,
    image?.visibility_notes,
    image?.major_regions_visible,
    image?.upload_note,
    image?.source_video?.note,
    image?.source_video?.purpose,
  );
  const sourceHasScopeSignal = sourceText.trim() && (
    isPelvicGenitalTextOutOfScope(sourceText) ||
    PELVIC_GENITAL_STRONGLY_POSITIVE_RE.test(sourceText)
  );
  return compactEvidenceText(
    sourceText,
    sourceHasScopeSignal ? "" : annotation.view_label,
    sourceHasScopeSignal ? "" : annotation.body_position,
    sourceHasScopeSignal ? "" : annotation.coverage,
    sourceHasScopeSignal ? "" : annotation.visibility_notes,
    sourceHasScopeSignal ? [] : annotation.major_regions_visible,
    image?.display_label,
    image?.body_position,
    image?.coverage,
    image?.visibility_notes,
    image?.major_regions_visible,
    finding?.section_key,
    finding?.region,
    finding?.label,
    finding?.finding,
    finding?.limitations,
  );
}

function isPelvicGenitalTextOutOfScope(text = "") {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  if (PELVIC_GENITAL_NEGATED_SCOPE_RE.test(raw)) return true;
  return PELVIC_GENITAL_FORBIDDEN_EVIDENCE_RE.test(raw);
}

function isPelvicGenitalFindingInScope(result, finding, transientImages = []) {
  if (!finding || !PELVIC_GENITAL_SCOPE_SECTION_KEYS.has(String(finding.section_key || ""))) return true;
  const evidenceText = pelvicGenitalImageEvidenceText(result, finding.image_id, transientImages, finding);
  if (!evidenceText.trim()) return true;
  if (isPelvicGenitalTextOutOfScope(evidenceText)) return false;
  return PELVIC_GENITAL_STRONGLY_POSITIVE_RE.test(evidenceText);
}

function removePelvicGenitalOutOfScopeSentences(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const chunks = raw.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [raw];
  const kept = chunks
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk && !isPelvicGenitalTextOutOfScope(chunk));
  return kept.join(" ").trim();
}

function cleanPelvicGenitalScopeProseItem(item = "") {
  const cleaned = removePelvicGenitalOutOfScopeSentences(item);
  if (!cleaned || isPelvicGenitalTextOutOfScope(cleaned)) return "";
  return cleaned;
}

function scopePelvicGenitalImageReviewResult(result = {}) {
  if (!result || typeof result !== "object") return result;
  const next = { ...result };
  if (next.overview) next.overview = cleanPelvicGenitalScopeProseItem(next.overview);
  if (next.summary_card && typeof next.summary_card === "object") {
    next.summary_card = {
      ...next.summary_card,
      coverage: cleanPelvicGenitalScopeProseItem(next.summary_card.coverage || ""),
      evidence_note: cleanPelvicGenitalScopeProseItem(next.summary_card.evidence_note || ""),
      primary_reference_value: Array.isArray(next.summary_card.primary_reference_value)
        ? next.summary_card.primary_reference_value.map(cleanPelvicGenitalScopeProseItem).filter(Boolean)
        : [],
      key_direct_findings: Array.isArray(next.summary_card.key_direct_findings)
        ? next.summary_card.key_direct_findings.map(cleanPelvicGenitalScopeProseItem).filter(Boolean)
        : [],
      key_limitations: Array.isArray(next.summary_card.key_limitations)
        ? next.summary_card.key_limitations.map(cleanPelvicGenitalScopeProseItem).filter(Boolean)
        : [],
    };
  }
  for (const sectionKey of PELVIC_GENITAL_SCOPE_SECTION_KEYS) {
    if (!Array.isArray(next[sectionKey])) continue;
    next[sectionKey] = next[sectionKey].map(cleanPelvicGenitalScopeProseItem).filter(Boolean);
  }
  const scopedFindings = Array.isArray(next.image_region_findings)
    ? next.image_region_findings.filter((finding) => isPelvicGenitalFindingInScope(next, finding, []))
    : [];
  const scopedFindingImageIds = new Set(scopedFindings.map((finding) => finding.image_id).filter(Boolean));
  next.image_region_findings = scopedFindings;
  next.annotated_images = Array.isArray(next.annotated_images)
    ? next.annotated_images.filter((image) => {
      const text = compactEvidenceText(
        image.view_label,
        image.body_position,
        image.coverage,
        image.visibility_notes,
        image.major_regions_visible,
      );
      if (scopedFindingImageIds.has(image.image_id)) return true;
      if (isPelvicGenitalTextOutOfScope(text)) return false;
      return PELVIC_GENITAL_STRONGLY_POSITIVE_RE.test(text);
    })
    : [];
  next.anatomical_evidence_records = Array.isArray(next.anatomical_evidence_records)
    ? next.anatomical_evidence_records.filter((record) => {
      const text = compactEvidenceText(
        record.key,
        record.label,
        record.region,
        record.summary,
        record.source_images,
      );
      if (isPelvicGenitalTextOutOfScope(text)) return false;
      return PELVIC_GENITAL_STRONGLY_POSITIVE_RE.test(text);
    })
    : [];
  return next;
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

function normalizeImageReviewResult(raw, config = null) {
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
  cleaned.anatomical_evidence_records = Array.isArray(cleaned.anatomical_evidence_records)
    ? mergeAnatomicalEvidenceRecords(cleaned.anatomical_evidence_records, [])
    : [];
  const reviewScoped = isPelvicGenitalReviewResult(cleaned, config)
    ? scopePelvicGenitalImageReviewResult(cleaned)
    : cleaned;
  return cleanupProfileImageReviewResult(reviewScoped, {
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
  return friendlyJobErrorMessage(error);
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

function archiveEntryResult(entryOrResult) {
  return entryOrResult?.result || entryOrResult || null;
}

function isFinalSynthesisFallbackResult(result) {
  const status = result?._background_attempt_status || result?._meta?.latest_attempt_status;
  const state = String(status?.state || "");
  return Boolean(
    status?.final_synthesis_attempted &&
    status?.batch_reviews_completed &&
    /final_synthesis_failed|failed_batch_findings_preserved/i.test(state)
  );
}

function isInterimLocalImageReview(result) {
  return Boolean(result?._meta?.local_batch_assembled || isFinalSynthesisFallbackResult(result));
}

function latestUsableArchiveResult(archive = []) {
  return (Array.isArray(archive) ? archive : [])
    .map((entry) => archiveEntryResult(entry))
    .filter((entryResult) => entryResult?.overview && !isInterimLocalImageReview(entryResult))
    .sort((a, b) => new Date(b?._meta?.last_generated_at || b?._meta?.updated_at || 0) - new Date(a?._meta?.last_generated_at || a?._meta?.updated_at || 0))[0] || null;
}

function cumulativeReviewResultCandidates({ result, archive, userProfile, config } = {}) {
  const candidates = [
    result,
    userProfile?.[config?.resultKey],
    ...(Array.isArray(archive) ? archive.map((entry) => archiveEntryResult(entry)) : []),
  ];
  const seen = new Set();
  return candidates
    .map((candidate) => normalizeImageReviewResult(candidate, config))
    .filter((candidate) => candidate?.overview && !isInterimLocalImageReview(candidate))
    .filter((candidate) => {
      const key = [
        candidate?._meta?.last_generated_at,
        candidate?._meta?.updated_at,
        candidate?.overview?.slice?.(0, 80),
      ].filter(Boolean).join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(b?._meta?.last_generated_at || b?._meta?.updated_at || 0) - new Date(a?._meta?.last_generated_at || a?._meta?.updated_at || 0));
}

function selectCumulativeBaselineResult({ result, archive, userProfile, config } = {}) {
  return cumulativeReviewResultCandidates({ result, archive, userProfile, config })[0] || latestUsableArchiveResult(archive);
}

function aggregateCumulativeAnatomyEvidence({ result, archive, userProfile, config } = {}) {
  const candidates = cumulativeReviewResultCandidates({ result, archive, userProfile, config });
  const records = candidates.flatMap((candidate) => existingAnatomicalEvidenceRecordsForPrompt(candidate));
  return mergeAnatomicalEvidenceRecords(records, []);
}

function sectionItemsFromCumulativeResults(candidates = [], sectionKey, limit = 8) {
  const seen = new Set();
  const items = [];
  for (const candidate of candidates) {
    const sectionItems = Array.isArray(candidate?.[sectionKey]) ? candidate[sectionKey] : [];
    for (const item of sectionItems) {
      const text = cleanProfileImageReviewText(item);
      if (!text) continue;
      if (isLowValueAbsentRegionParagraph(text)) continue;
      const key = profileImageReviewTopicKey(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(text);
      if (items.length >= limit) return items;
    }
  }
  return items;
}

function formatCanonicalAnatomyPacketForPrompt({ result, archive, userProfile, config } = {}) {
  const candidates = cumulativeReviewResultCandidates({ result, archive, userProfile, config });
  const records = aggregateCumulativeAnatomyEvidence({ result, archive, userProfile, config });
  if (!candidates.length && !records.length) {
    return `CANONICAL CUMULATIVE ANATOMY PACKET:
- No final cumulative profile review is available yet. Build the first full profile from all saved evidence available in this run.
- Even without a prior final review, the output must still be a full ${config?.shortTitle || "anatomy"} profile, not a report about only the newest upload.`;
  }

  const lines = [
    `CANONICAL CUMULATIVE ANATOMY PACKET - PRIMARY WRITING SOURCE:`,
    `- Write the ${config?.shortTitle || "anatomy"} review from this packet as the current profile of Ben.`,
    `- Treat newest uploaded/reloaded images as update evidence only. They may update relevant sections, but they must not become the structure or scope of the report.`,
    `- Do not mention absent regions from the newest upload when this packet already contains usable cumulative evidence for that region.`,
    `- Do not copy source/provenance/callout wording. Convert packet items into clean anatomical observations.`,
    `- Prior final review candidates available: ${candidates.length}. Aggregated anatomical evidence records: ${records.length}.`,
  ];

  const latestOverview = cleanProfileImageReviewText(candidates[0]?.overview || "");
  if (latestOverview) lines.push(`Current profile overview seed: ${briefText(latestOverview, 900)}`);

  for (const section of profileReviewResultSections(config)) {
    const items = sectionItemsFromCumulativeResults(candidates, section.key, 5);
    if (!items.length) continue;
    lines.push(`${section.label}:`);
    for (const item of items) lines.push(`- ${briefText(item, 420)}`);
  }

  if (records.length) {
    lines.push(`Aggregated anatomical evidence records:`);
    for (const record of records.slice(0, 32)) {
      lines.push(`- ${record.label || record.key}: ${briefText(record.summary || record.region || "", 260)}`);
    }
  }

  return lines.join("\n");
}

function formatCumulativeBaselineReviewForPrompt(result = null, config = {}) {
  const normalized = normalizeImageReviewResult(result, config);
  if (!normalized?.overview) {
    return "CURRENT CUMULATIVE BASELINE REVIEW:\n- No prior final cumulative review is available yet. Establish the baseline from all saved evidence available in this run.";
  }
  const cleanBaselineText = (value) => cleanProfileImageReviewText(value || "");
  const overview = cleanBaselineText(normalized.overview) || "Prior cumulative review exists, but its overview did not contain reusable anatomical baseline text.";
  const lines = [
    `CURRENT CUMULATIVE BASELINE REVIEW - TREAT AS THE ESTABLISHED MAP TO UPDATE, NOT AS TEXT TO REPEAT VERBATIM:`,
    `Overview: ${briefText(overview, 900)}`,
    `Do not copy pass-scoped placeholders from older output. If older sections say only that a region was not represented in a pass, ignore that phrasing and rebuild the section from saved evidence plus profile context.`,
  ];
  for (const section of profileReviewResultSections(config)) {
    const items = Array.isArray(normalized[section.key])
      ? normalized[section.key].map(cleanBaselineText).filter(Boolean)
      : [];
    if (!items.length) continue;
    lines.push(`${section.label}:`);
    for (const item of items.slice(0, 4)) {
      lines.push(`- ${briefText(item, 420)}`);
    }
  }
  return lines.join("\n");
}

function mergeProfileArchive(existingArchive = [], entry) {
  const archive = Array.isArray(existingArchive) ? existingArchive : [];
  return [
    entry,
    ...archive.filter((item) => item?.id !== entry.id && item?.generated_at !== entry.generated_at),
  ].slice(0, PROFILE_ARCHIVE_LIMIT);
}

function stableProfilerHash(value = "") {
  const text = String(value || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function compactProfileReviewMetaForStorage(meta = {}) {
  if (!meta || typeof meta !== "object") return meta;
  const next = { ...meta };
  const freshnessKey = typeof next.evidence_freshness_key === "string" ? next.evidence_freshness_key : "";
  if (freshnessKey.length > 2000) {
    next.evidence_freshness_hash = next.evidence_freshness_hash || stableProfilerHash(freshnessKey);
    next.evidence_freshness_key_length = freshnessKey.length;
    next.evidence_freshness_key_omitted = true;
    delete next.evidence_freshness_key;
  }
  return next;
}

function compactProfileReviewResultForStorage(result) {
  if (!result || typeof result !== "object") return result;
  if (!result._meta || typeof result._meta !== "object") return result;
  return {
    ...result,
    _meta: compactProfileReviewMetaForStorage(result._meta),
  };
}

function compactProfileArchiveForStorage(archive = []) {
  return (Array.isArray(archive) ? archive : []).map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    if (!entry.result) return entry;
    return {
      ...entry,
      result: compactProfileReviewResultForStorage(entry.result),
    };
  });
}

function firstProfilerRowWithField(rows = [], field) {
  return (Array.isArray(rows) ? rows : []).find((row) => {
    const value = row?.[field];
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null;
  }) || null;
}

async function loadLatestProfileReviewResultField(field) {
  const rows = await base44.entities.SessionClusterAnalysis.listFields([field], "-updated_date", 5);
  return firstProfilerRowWithField(rows, field);
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
  const storedResult = compactProfileReviewResultForStorage(result);
  const entry = buildProfileArchiveEntry(kind, label, storedResult);
  const archive = compactProfileArchiveForStorage(mergeProfileArchive(existing[0]?.[archiveKey], entry));
  const patch = {
    [resultKey]: storedResult,
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
  const reviewType = options.meta?.reviewType || payload?.reviewType || "";
  const route = reviewType === "profile_head_to_toe_image_review"
    ? "/profiler#profiler-head-to-toe"
    : reviewType === "profile_pelvic_genital_image_review"
      ? "/profiler#profiler-pelvic-genital"
      : options.meta?.sessionId === "profiler_anatomical_physiological_profile"
        ? "/profiler#profiler-anatomical-profile"
        : options.meta?.sessionId === "profiler_stim_methods"
          ? "/profiler#profiler-stimulation-methods"
          : options.meta?.sessionId === "profiler_near_climax"
            ? "/profiler#profiler-near-climax"
            : "/profiler#profiler-ai-profile";
  return startBackgroundJob("ai_invoke", { ...payload, label }, {
    source: "Profiler",
    route,
    label,
    priority: options.priority ?? 0,
    ...options.meta,
  });
}

async function startProfileImageReviewFullJob(payload, label, options = {}) {
  const reviewType = options.meta?.reviewType || payload?.reviewType || "";
  const route = reviewType === "profile_pelvic_genital_image_review"
    ? "/profiler#profiler-pelvic-genital"
    : "/profiler#profiler-head-to-toe";
  return startBackgroundJob("profile_image_review_full", { ...payload, label }, {
    source: "Profiler",
    route,
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

async function loadFullBackgroundJob(job) {
  if (!job?.id) return job;
  if (job.result !== undefined) return job;
  if (!["complete", "error", "cancelled"].includes(job.status) && !job.hasResult) return job;
  try {
    return await getBackgroundJob(job.id);
  } catch {
    return job;
  }
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

function profilerJobMetaValue(job, key) {
  return job?.meta?.[key]
    ?? job?.payload?.[key]
    ?? job?.result?._meta?.[key]
    ?? job?.result?.meta?.[key]
    ?? null;
}

function profilerJobReviewType(job) {
  return String(
    profilerJobMetaValue(job, "reviewType")
      || profilerJobMetaValue(job, "kind")
      || ""
  );
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
    <div className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-3 text-xs text-sky-950 shadow-sm">
      <div className="flex items-center gap-2 font-semibold text-sky-900">
        <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-sky-600 border-t-transparent" />
        Preparing this analysis panel
      </div>
      <div className="mt-2 grid gap-1.5">
        {activeItems.map((item) => (
          <div key={item.label} className="flex items-start justify-between gap-3 rounded-md border border-sky-200 bg-white px-2 py-1.5">
            <span className="font-medium text-sky-950">{item.label}</span>
            <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wide text-sky-800">{item.status || "loading"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProfileImageReviewInlineStatus({ items = [], color = "hsl(var(--primary))" }) {
  const visibleItems = items.filter((item) => item && item.active);
  if (!visibleItems.length) return null;
  const primary = visibleItems[0];
  const secondaryCount = Math.max(0, visibleItems.length - 1);
  return (
    <div className="rounded-xl border border-border bg-card/70 px-3 py-3 text-xs shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold text-foreground">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
          {primary?.headline || "Profiler status"}
        </p>
        {visibleItems.some((item) => item.loading) && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-1 font-mono text-[10px] uppercase text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            working
          </span>
        )}
      </div>
      <div className="mt-2 rounded-lg border border-border bg-background/70 px-2.5 py-2">
        <p className="font-semibold text-foreground">{primary.label}</p>
        {primary.detail && <p className="mt-0.5 leading-relaxed text-muted-foreground">{primary.detail}</p>}
        {secondaryCount > 0 && (
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {secondaryCount} other background check{secondaryCount === 1 ? "" : "s"} also active.
          </p>
        )}
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
  const result = archiveEntryResult(entry) || {};
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
  const [open, setOpen] = useState(false);
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
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">{archive.length} saved</Badge>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[10px]"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {open ? "Hide runs" : "Show runs"}
          </Button>
        </div>
      </div>
      {!open && (
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
          Archive is collapsed to keep the current review tools and video controls easy to reach.
        </p>
      )}
      {open && <div className="mt-3 space-y-2">
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
                  onClick={() => onViewRun?.(entry)}
                >
                  View This Run
                </Button>
              </div>
            </details>
          );
        })}
      </div>}
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

function dataUrlToFile(dataUrl, filename, mimeType = "image/jpeg") {
  const binary = atob(stripDataUrl(dataUrl));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], filename, { type: mimeType });
}

function formatVideoTimestamp(seconds = 0) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const tenths = Math.round((safe - Math.floor(safe)) * 10);
  return minutes ? `${minutes}:${String(wholeSeconds).padStart(2, "0")}${tenths ? `.${tenths}` : ""}` : `${wholeSeconds}${tenths ? `.${tenths}` : ""}s`;
}

function formatFileSize(bytes = 0) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function anatomyVideoFromJob(job = {}) {
  const result = job?.result && typeof job.result === "object" ? job.result : null;
  if (result?.file_url) return result;
  const summary = job?.result_summary && typeof job.result_summary === "object" ? job.result_summary : null;
  if (summary?.file_url) {
    return {
      ok: true,
      jobId: job.id,
      file_url: summary.file_url,
      filename: summary.filename,
      size: summary.size,
      duration_seconds: summary.duration_seconds,
      created_at: summary.created_at || job.finishedAt || job.updatedAt || job.createdAt,
      render_version: summary.render_version,
      watermark_enabled: summary.watermark_enabled,
      audio_reused: summary.audio_reused,
      mime_type: summary.mime_type,
    };
  }
  const progress = job?.progress && typeof job.progress === "object" ? job.progress : null;
  if (progress?.result_file_url) {
    return {
      ok: true,
      jobId: job.id,
      file_url: progress.result_file_url,
      filename: progress.result_filename,
      size: progress.result_size,
      duration_seconds: progress.result_duration_seconds,
      created_at: progress.result_created_at || job.finishedAt || job.updatedAt || job.createdAt,
    };
  }
  return null;
}

function formatVideoCreatedAt(value) {
  if (!value) return "";
  try {
    return formatGeneratedAt(value);
  } catch {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
}

function seekProfilerVideo(video, time) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("error", handleError);
    };
    const handleSeeked = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Could not sample this video."));
    };
    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("error", handleError);
    video.currentTime = time;
  });
}

async function sampleProfilerVideoFrames({ file, label, maxFrames = PROFILER_VIDEO_SAMPLE_COUNT }) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  const loaded = new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error("Could not load this video for sampling."));
  });
  video.src = url;
  try {
    await loaded;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const frameCount = Math.max(1, Math.min(maxFrames, PROFILER_VIDEO_SAMPLE_COUNT));
    const width = Math.min(960, video.videoWidth || 960);
    const height = Math.max(1, Math.round(width * ((video.videoHeight || 540) / (video.videoWidth || 960))));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const frames = [];
    for (let index = 0; index < frameCount; index += 1) {
      const ratio = frameCount === 1 ? 0.5 : index / (frameCount - 1);
      const time = duration > 0 ? Math.min(duration, Math.max(0, duration * ratio)) : 0;
      await seekProfilerVideo(video, time);
      ctx.drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.84);
      const safeLabel = String(label || file.name || "profile-video").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 52);
      const filename = `${safeLabel}-frame-${String(index + 1).padStart(2, "0")}.jpg`;
      frames.push({
        dataUrl,
        filename,
        file: dataUrlToFile(dataUrl, filename, "image/jpeg"),
        time,
        duration,
        frameIndex: index + 1,
        frameCount,
      });
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const PROFILER_UPLOAD_QUEUE_LIMIT = 40;
const PROFILER_IMAGE_SAVE_TIMEOUT_MS = 90000;
const PROFILER_IMAGE_RELOAD_TIMEOUT_MS = 30000;
const PROFILER_VIDEO_SAVE_TIMEOUT_MS = 180000;
const PROFILER_VIDEO_SAMPLE_COUNT = 12;
const PROFILER_VIDEO_UPLOAD_LIMIT = 4;

function profilerUploadQueueKey(kind = "profile") {
  return `pulsepoint_profiler_upload_queue_${kind}`;
}

function serializeProfilerUploadQueue(images = []) {
  return images
    .filter((image) => {
      const path = image?.storagePath || image?.url || "";
      return path && !String(path).startsWith("data:");
    })
    .map((image) => ({
      id: image.id,
      filename: image.filename,
      media_type: image.media_type || "image/jpeg",
      storagePath: image.storagePath || image.url || "",
      url: image.url || image.storagePath || "",
      previewUrl: image.storagePath || image.url || "",
      upload_note: image.upload_note || "",
      size: image.size || 0,
      lastModified: image.lastModified || 0,
      source: image.source || "fresh_upload",
    }))
    .slice(0, PROFILER_UPLOAD_QUEUE_LIMIT);
}

function restoreProfilerUploadQueue(kind) {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(profilerUploadQueueKey(kind)) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((image) => image?.storagePath || image?.url || image?.previewUrl)
      .map((image, index) => {
        const storagePath = image.storagePath || image.url || image.previewUrl || "";
        return {
          ...image,
          id: image.id || `${kind}-restored-${index}-${storagePath}`,
          media_type: normalizeMediaType(image.media_type),
          storagePath,
          url: image.url || storagePath,
          previewUrl: serverUrl(image.previewUrl || storagePath),
          source: "fresh_upload",
          upload_note: String(image.upload_note || "").trim(),
        };
      });
  } catch {
    return [];
  }
}

function persistProfilerUploadQueue(kind, images = []) {
  if (typeof window === "undefined") return;
  try {
    const serializable = serializeProfilerUploadQueue(images);
    if (!serializable.length) window.localStorage.removeItem(profilerUploadQueueKey(kind));
    else window.localStorage.setItem(profilerUploadQueueKey(kind), JSON.stringify(serializable));
  } catch {
    // Upload queue persistence is best-effort; active in-memory images still work.
  }
}

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

async function fetchWithTimeout(url, ms, message) {
  const controller = new AbortController();
  let timeoutId;
  try {
    timeoutId = window.setTimeout(() => controller.abort(), ms);
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(message);
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function readBlobAsDataUrl(blob, label = "image", timeoutMs = PROFILER_IMAGE_RELOAD_TIMEOUT_MS) {
  return withTimeout(new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${label}.`));
    reader.readAsDataURL(blob);
  }), timeoutMs, `${label} did not finish decoding within ${Math.round(timeoutMs / 1000)} seconds.`);
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
    "head", "face", "facial", "glasses", "nose", "neck", "upper back", "arms", "hands",
    "legs", "feet", "toes", "skin", "bruise", "scar",
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
    const coverageBonus = inferHeadToToeCoverageTags(text).length * 3;
    const broadBodyBonus = /\b(full[-\s]?body|whole[-\s]?body|head[-\s]?to[-\s]?toe|standing|anterior|posterior|lateral)\b/i.test(text) ? 8 : 0;
    const closeupPenalty = HEAD_TO_TOE_PELVIC_CLOSEUP_RE.test(text) ? 6 : 0;
    return countMatches(headToToePositive) * 4 + coverageBonus + broadBodyBonus - countMatches(headToToeNegative) * 2 - closeupPenalty;
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
      const selectionPrompt = briefText(String(message?.text || ""), 420);
      const selectionReviewContext = briefText(replyText, 900);
      const scopeText = compactEvidenceText(
        attachment.filename,
        selectionPrompt,
        selectionReviewContext,
      );
      const selectionTags = purpose === "head_to_toe_body_reference"
        ? inferHeadToToeCoverageTags(scopeText)
        : [];
      if (purpose === "pelvic_genital") {
        if (isPelvicGenitalTextOutOfScope(scopeText)) continue;
        if (!PELVIC_GENITAL_STRONGLY_POSITIVE_RE.test(scopeText)) continue;
      }
      items.push({
        id: attachment.id || key,
        filename: attachment.filename || "saved-profile-image.jpg",
        media_type: normalizeMediaType(attachment.mimeType || attachment.media_type),
        url,
        saved_at: attachment.createdAt || message.createdAt || null,
        source: "saved_profile_qa_attachment",
        selection_score: groupScore,
        selection_context: purpose,
        selection_prompt: selectionPrompt,
        selection_review_context: selectionReviewContext,
        selection_group_created_at: createdAt,
        selection_tags: selectionTags,
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

  if (purpose === "head_to_toe_body_reference") {
    return selectBalancedHeadToToeAttachments(items, limit);
  }

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

function collectSavedProfileImageAttachmentContexts(userProfile) {
  const messages = Array.isArray(userProfile?.profile_chat_messages) ? userProfile.profile_chat_messages : [];
  const seen = new Set();
  const items = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    const attachments = Array.isArray(message?.imageAttachments) ? message.imageAttachments : [];
    const imageAttachments = attachments.filter((attachment) => !attachment?.sourceVideo);
    if (!imageAttachments.length) continue;
    const reply = messages.slice(messageIndex + 1).find((candidate) => candidate?.role !== "user" && String(candidate?.text || "").trim());
    const selectionPrompt = briefText(String(message?.text || ""), 420);
    const selectionReviewContext = briefText(String(reply?.text || ""), 900);
    for (const attachment of imageAttachments) {
      const url = attachment.previewUrl || attachment.storagePath || "";
      if (!url) continue;
      const key = attachment.storagePath || attachment.previewUrl || attachment.id || attachment.filename;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push({
        id: attachment.id || key,
        filename: attachment.filename || "saved-profile-image.jpg",
        url,
        saved_at: attachment.createdAt || message.createdAt || null,
        source: "saved_profile_qa_context",
        selection_prompt: selectionPrompt,
        selection_review_context: selectionReviewContext,
      });
    }
  }

  return items;
}

function evidenceUrlKey(value = "") {
  return String(value || "").trim().replace(/^https?:\/\/[^/]+/i, "");
}

function savedProfileContextMapByUrl(contexts = []) {
  const map = new Map();
  for (const context of Array.isArray(contexts) ? contexts : []) {
    const key = evidenceUrlKey(context?.url);
    if (!key || map.has(key)) continue;
    map.set(key, context);
  }
  return map;
}

function savedEvidenceAttachmentScopeText(attachment = {}) {
  return compactEvidenceText(
    attachment.display_label,
    attachment.filename,
    attachment.body_position,
    attachment.coverage,
    attachment.visibility_notes,
    attachment.major_regions_visible,
    attachment.selection_prompt,
    attachment.selection_review_context,
    attachment.source_video?.note,
    attachment.source_video?.purpose,
  );
}

function savedEvidenceAttachmentInScope(attachment, { purpose = "general", sourceContextByUrl = new Map() } = {}) {
  if (purpose !== "pelvic_genital") return true;
  const sourceContext = sourceContextByUrl.get(evidenceUrlKey(attachment?.url || attachment?.previewUrl || attachment?.storagePath));
  const sourceContextText = compactEvidenceText(
    sourceContext?.selection_prompt,
    sourceContext?.selection_review_context,
    sourceContext?.coverage,
    sourceContext?.upload_note,
  );
  if (sourceContextText.trim()) {
    if (isPelvicGenitalTextOutOfScope(sourceContextText)) return false;
    if (!PELVIC_GENITAL_STRONGLY_POSITIVE_RE.test(sourceContextText)) return false;
  }
  const scopeText = savedEvidenceAttachmentScopeText(attachment);
  if (isPelvicGenitalTextOutOfScope(scopeText)) return false;
  return PELVIC_GENITAL_STRONGLY_POSITIVE_RE.test(sourceContextText || scopeText);
}

function reviewedProfileImageAttachmentsFromResult(result, {
  prefix = "profile_review",
  purpose = "general",
  sourceContextByUrl = new Map(),
  generatedAt = "",
} = {}) {
  const reviewed = Array.isArray(result?._meta?.reviewed_images) ? result._meta.reviewed_images : [];
  const annotated = Array.isArray(result?.annotated_images) ? result.annotated_images : [];
  return reviewed
    .map((image, index) => {
      const originalId = image?.image_id || `img_${index + 1}`;
      const annotation = annotated.find((item) => item?.image_id === originalId) || {};
      const url = image?.preview_url || image?.previewUrl || annotation?.preview_url || annotation?.previewUrl || "";
      const majorRegions = Array.isArray(annotation?.major_regions_visible)
        ? annotation.major_regions_visible
        : [];
      const coverage = cleanImageReviewProse([
        annotation.view_label,
        annotation.body_position,
        annotation.coverage,
        annotation.visibility_notes,
        majorRegions.join(", "),
        image.upload_note,
        image.source_video?.note,
        image.source_video?.purpose,
      ].filter(Boolean).join(". "));
      const selectionTags = purpose === "head_to_toe_body_reference"
        ? inferHeadToToeCoverageTags(
          annotation.view_label,
          annotation.body_position,
          coverage,
          majorRegions,
          image.display_label,
          image.upload_note,
          image.source_video?.note,
          image.source_video?.purpose,
        )
        : [];
      return {
        id: `${prefix}_${String(originalId).replace(/[^a-z0-9_-]+/gi, "_")}_${index + 1}`,
        filename: image.filename || `${prefix}-${String(index + 1).padStart(3, "0")}.jpg`,
        media_type: normalizeMediaType(image.media_type),
        url,
        saved_at: generatedAt || result?._meta?.generated_at || result?._meta?.last_generated_at || null,
        source: image.source_video ? "profile_review_video_frame" : "profile_review_image",
        display_label: annotation.view_label || image.display_label || `Saved profile review view ${reviewImageLetter(index)}`,
        body_position: annotation.body_position || "",
        coverage,
        visibility_notes: annotation.visibility_notes || "",
        major_regions_visible: majorRegions,
        selection_score: purpose === "pelvic_genital"
          ? (PELVIC_GENITAL_STRONGLY_POSITIVE_RE.test(coverage) ? 30 : 0)
          : 15,
        selection_context: purpose,
        selection_prompt: annotation.view_label || image.display_label || "",
        selection_review_context: coverage,
        selection_tags: selectionTags,
        source_video: image.source_video || null,
      };
    })
    .filter((attachment) => attachment.url && savedEvidenceAttachmentInScope(attachment, { purpose, sourceContextByUrl }));
}

function collectSavedProfileReviewImageAttachments({
  result,
  archive,
  userProfile,
  config,
  limit = 20,
  purpose = "general",
  savedProfileContexts = [],
} = {}) {
  const sourceContextByUrl = savedProfileContextMapByUrl(savedProfileContexts);
  const candidates = [];
  const addResult = (candidate, prefix, generatedAt = "") => {
    if (!candidate || typeof candidate !== "object") return;
    candidates.push(...reviewedProfileImageAttachmentsFromResult(candidate, {
      prefix,
      purpose,
      sourceContextByUrl,
      generatedAt,
    }));
  };

  addResult(result, "current_profile_review");
  addResult(userProfile?.[config?.resultKey], `saved_${config?.resultKey || "profile_review"}`);
  (Array.isArray(archive) ? archive : []).forEach((entry, index) => {
    const archivedResult = archiveEntryResult(entry);
    addResult(
      archivedResult,
      `archive_${index + 1}_${config?.archiveKey || "profile_review"}`,
      entry?.generated_at || entry?.created_at || entry?.updated_at || "",
    );
  });
  (Array.isArray(userProfile?.[config?.archiveKey]) ? userProfile[config.archiveKey] : []).forEach((entry, index) => {
    const archivedResult = archiveEntryResult(entry);
    addResult(
      archivedResult,
      `saved_archive_${index + 1}_${config?.archiveKey || "profile_review"}`,
      entry?.generated_at || entry?.created_at || entry?.updated_at || "",
    );
  });

  const seen = new Set();
  return candidates
    .sort((a, b) => {
      if (b.selection_score !== a.selection_score) return b.selection_score - a.selection_score;
      return (Date.parse(b.saved_at || 0) || 0) - (Date.parse(a.saved_at || 0) || 0);
    })
    .filter((attachment) => {
      const key = evidenceUrlKey(attachment.url);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function collectBodyExplorationFrameAttachments(bodyExplorations = [], { limit = 20, purpose = "general" } = {}) {
  const rows = [...(Array.isArray(bodyExplorations) ? bodyExplorations : [])]
    .sort((a, b) => new Date(b.date || b.created_date || 0) - new Date(a.date || a.created_date || 0));
  const candidates = [];
  for (const exploration of rows) {
    const cards = Array.isArray(exploration?.ai_body_exploration?._video_pass_findings)
      ? exploration.ai_body_exploration._video_pass_findings
      : [];
    cards.forEach((card, cardIndex) => {
      const findings = Array.isArray(card?.findings) ? card.findings : [];
      const draftEvents = Array.isArray(card?.draft_events) ? card.draft_events : [];
      const cardText = compactEvidenceText(
        card?.label,
        card?.summary,
        findings.join(" "),
        draftEvents.map((event) => event?.note).filter(Boolean).join(" "),
        card?.source_video?.label,
        card?.source_video?.filename,
      );
      const frameUrl = card?.clip?.thumbnail_url
        || card?.sampled_frames?.[Math.floor((card?.sampled_frames?.length || 1) / 2)]?.url
        || card?.sampled_frames?.[0]?.url
        || "";
      if (!frameUrl) return;
      const attachment = {
        id: `body_exploration_frame_${exploration.id || "unknown"}_${card.id || cardIndex}`,
        filename: `body-exploration-${String(candidates.length + 1).padStart(3, "0")}.jpg`,
        media_type: "image/jpeg",
        url: frameUrl,
        saved_at: card?.saved_at || exploration?.date || exploration?.created_date || null,
        source: "body_exploration_video_frame",
        display_label: card?.label || "Body exploration sampled frame",
        coverage: cleanImageReviewProse(cardText),
        visibility_notes: cleanImageReviewProse(card?.summary || ""),
        selection_score: purpose === "pelvic_genital"
          ? (PELVIC_GENITAL_STRONGLY_POSITIVE_RE.test(cardText) ? 20 : 0)
          : 8,
        selection_context: purpose,
        selection_prompt: card?.label || "",
        selection_review_context: cleanImageReviewProse(cardText),
        selection_tags: purpose === "head_to_toe_body_reference"
          ? inferHeadToToeCoverageTags(cardText)
          : [],
        source_video: {
          video_id: card?.source_video?.id || "",
          note: card?.summary || "",
          purpose: "body exploration sampled video frame",
          frame_time_seconds: card?.clip?.start_s ?? card?.sampled_frames?.[0]?.recordTimeSeconds ?? null,
          start_s: card?.clip?.start_s ?? null,
          end_s: card?.clip?.end_s ?? null,
        },
      };
      if (!savedEvidenceAttachmentInScope(attachment, { purpose })) return;
      candidates.push(attachment);
    });
  }
  const seen = new Set();
  return candidates
    .sort((a, b) => {
      if (b.selection_score !== a.selection_score) return b.selection_score - a.selection_score;
      return (Date.parse(b.saved_at || 0) || 0) - (Date.parse(a.saved_at || 0) || 0);
    })
    .filter((attachment) => {
      const key = evidenceUrlKey(attachment.url);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function mergeSavedReviewImageCandidates(candidateGroups = [], limit = 20) {
  const merged = [];
  const seen = new Set();
  const groups = candidateGroups
    .map((group) => (Array.isArray(group) ? group : []))
    .filter((group) => group.length);
  const maxLength = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < maxLength; index += 1) {
    for (const group of groups) {
      const attachment = group[index];
      if (!attachment) continue;
      const key = savedAttachmentDedupeKey(attachment);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(attachment);
      if (merged.length >= limit) return merged;
    }
  }
  return merged;
}

function savedAttachmentDedupeKey(attachment = {}) {
  return evidenceUrlKey(attachment.url || attachment.previewUrl || attachment.storagePath)
    || String(attachment.id || attachment.filename || "").trim();
}

function headToToeAttachmentRank(attachment = {}) {
  const tags = headToToeAttachmentCoverageTags(attachment);
  const tagScore = tags.length * 10;
  const savedAt = Date.parse(attachment.saved_at || attachment.selection_group_created_at || 0) || 0;
  const recencyScore = savedAt ? Math.min(12, savedAt / 100000000000) : 0;
  const sourceScore = attachment.source === "profile_review_image" || attachment.source === "profile_review_video_frame"
    ? 10
    : attachment.source === "body_exploration_video_frame"
      ? 8
      : 5;
  const text = savedEvidenceAttachmentScopeText(attachment);
  const closeupPenalty = HEAD_TO_TOE_PELVIC_CLOSEUP_RE.test(text) ? 10 : 0;
  return (Number(attachment.selection_score) || 0) + tagScore + sourceScore + recencyScore - closeupPenalty;
}

function selectBalancedHeadToToeAttachments(attachments = [], limit = 20) {
  const candidates = [];
  const seen = new Set();
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const key = savedAttachmentDedupeKey(attachment);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const tags = headToToeAttachmentCoverageTags(attachment);
    candidates.push({
      ...attachment,
      selection_tags: tags,
      selection_score: Number(attachment.selection_score) || 0,
      _headToToeRank: headToToeAttachmentRank({ ...attachment, selection_tags: tags }),
    });
  }
  if (!candidates.length || limit <= 0) return [];

  const selected = [];
  const selectedKeys = new Set();
  const add = (attachment) => {
    const key = savedAttachmentDedupeKey(attachment);
    if (!key || selectedKeys.has(key) || selected.length >= limit) return false;
    selectedKeys.add(key);
    selected.push(attachment);
    return true;
  };
  const ranked = [...candidates].sort((a, b) => {
    if (b._headToToeRank !== a._headToToeRank) return b._headToToeRank - a._headToToeRank;
    return (Date.parse(b.saved_at || b.selection_group_created_at || 0) || 0) - (Date.parse(a.saved_at || a.selection_group_created_at || 0) || 0);
  });

  for (const bucket of HEAD_TO_TOE_BODY_REGION_BUCKETS) {
    const bucketCandidates = ranked.filter((attachment) => attachment.selection_tags?.includes(bucket.key));
    for (const attachment of bucketCandidates.slice(0, bucket.quota)) add(attachment);
  }

  ranked.forEach(add);
  return selected.slice(0, limit).map(({ _headToToeRank, ...attachment }) => attachment);
}

function selectSavedAttachmentsForReview(attachments = [], limit = 20, purpose = "general") {
  if (purpose === "head_to_toe_body_reference") {
    return selectBalancedHeadToToeAttachments(attachments, limit);
  }
  return (Array.isArray(attachments) ? attachments : []).slice(0, limit);
}

async function savedAttachmentToPayload(attachment) {
  const url = serverUrl(attachment.url);
  if (!url) throw new Error(`Saved image ${attachment.filename || ""} has no reusable URL.`);
  const label = attachment.display_label || attachment.filename || "saved image";
  const response = await fetchWithTimeout(
    url,
    PROFILER_IMAGE_RELOAD_TIMEOUT_MS,
    `${label} did not finish loading within ${Math.round(PROFILER_IMAGE_RELOAD_TIMEOUT_MS / 1000)} seconds.`,
  );
  if (!response.ok) throw new Error(`Could not load saved image ${attachment.filename || url}.`);
  const blob = await withTimeout(
    response.blob(),
    PROFILER_IMAGE_RELOAD_TIMEOUT_MS,
    `${label} did not finish reading within ${Math.round(PROFILER_IMAGE_RELOAD_TIMEOUT_MS / 1000)} seconds.`,
  );
  const mediaType = normalizeMediaType(blob.type || attachment.media_type);
  const dataUrl = await readBlobAsDataUrl(blob, label);
  return {
    id: attachment.id || `${attachment.filename}-${attachment.saved_at || ""}`,
    filename: attachment.filename || "saved-profile-image.jpg",
    media_type: mediaType,
    data: stripDataUrl(dataUrl),
    previewUrl: dataUrl,
    storagePath: attachment.url || "",
    display_label: attachment.display_label || attachment.filename || "saved profile evidence image",
    upload_note: cleanImageReviewProse([
      attachment.display_label,
      attachment.coverage,
      attachment.visibility_notes,
      Array.isArray(attachment.major_regions_visible) ? attachment.major_regions_visible.join(", ") : "",
      attachment.selection_prompt,
      attachment.selection_review_context,
    ].filter(Boolean).join(". ")),
    coverage: cleanImageReviewProse([
      attachment.display_label,
      attachment.coverage,
      attachment.visibility_notes,
      Array.isArray(attachment.major_regions_visible) ? attachment.major_regions_visible.join(", ") : "",
      attachment.selection_prompt,
      attachment.selection_review_context,
    ].filter(Boolean).join(". ")),
    source: attachment.source || "saved_profile_qa_attachment",
    saved_at: attachment.saved_at || null,
    selection_tags: headToToeAttachmentCoverageTags(attachment),
  };
}

function savedAttachmentToImageRef(attachment, index = 0) {
  const sourceUrl = attachment.url || attachment.file_url || attachment.preview_url || attachment.storagePath || "";
  if (!sourceUrl) throw new Error(`Saved image ${attachment.filename || ""} has no reusable URL.`);
  const label = attachment.display_label || attachment.filename || `saved profile evidence image ${index + 1}`;
  const contextText = cleanImageReviewProse([
    label,
    attachment.coverage,
    attachment.visibility_notes,
    Array.isArray(attachment.major_regions_visible) ? attachment.major_regions_visible.join(", ") : "",
    attachment.selection_prompt,
    attachment.selection_review_context,
  ].filter(Boolean).join(". "));
  return {
    id: attachment.id || `${attachment.filename || "saved-image"}-${attachment.saved_at || index}`,
    filename: attachment.filename || `saved-profile-image-${index + 1}.jpg`,
    media_type: normalizeMediaType(attachment.media_type || attachment.mimeType),
    url: sourceUrl,
    file_url: attachment.file_url || sourceUrl,
    preview_url: attachment.preview_url || sourceUrl,
    storagePath: sourceUrl,
    display_label: label,
    upload_note: contextText,
    coverage: contextText,
    source: attachment.source || "saved_profile_qa_attachment",
    saved_at: attachment.saved_at || null,
    selection_tags: headToToeAttachmentCoverageTags(attachment),
    server_image_ref: true,
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

function latestProfileReviewSourceUpdatedAt({ sessions = [], bodyExplorations = [], userProfile = null } = {}) {
  return [
    ...(Array.isArray(sessions) ? sessions : []),
    ...(Array.isArray(bodyExplorations) ? bodyExplorations : []),
    userProfile,
  ]
    .filter(Boolean)
    .map((source) => source.updated_date || source.updated_at || source.created_date || source.createdAt || null)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0] || 0;
}

function isProfileImageReviewSourceStale(result, { sessions = [], bodyExplorations = [], userProfile = null } = {}) {
  const generatedAt = new Date(result?._meta?.last_generated_at || result?._meta?.updated_at || 0).getTime();
  if (!Number.isFinite(generatedAt) || generatedAt <= 0) return false;
  const latestSourceUpdatedAt = latestProfileReviewSourceUpdatedAt({ sessions, bodyExplorations, userProfile });
  return latestSourceUpdatedAt > generatedAt + 1000;
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
- The current cumulative profile is the primary subject. Fresh images, when attached, are new evidence/delta inputs that update relevant anatomical sections.
- Existing saved evidence is first-class evidence: saved Profile Q&A visual reviews, reusable saved Profile Q&A image attachments when available, session image/video findings, body-exploration image/video findings, entered profile metrics, and session evidence.
- Use saved Q&A findings, reusable saved media, entered profile metrics, and session/body-exploration evidence as the standing anatomy library. Reconcile fresh images with that library instead of replacing it.
- Clinical assessment priority: direct saved/reloaded images, prior Sarah media reviews, session/body-exploration visuals, and structured profile/session evidence are the main sources. Profile Q&A can fill context gaps, but it should not become the whole review or outweigh directly visible findings.
- Write the report like a clinician moving through the relevant anatomy and saying the current findings as she goes. Do not let one question, dog bite/bruise story, batch upload, or recent device close-up become the organizing focus unless Ben explicitly asks for that narrow follow-up.
- If saved context conflicts with fresh images or with another saved visual review, state the mismatch and explain which source is stronger for that claim.
- Do not let profile history make you overcall something that is not visible.
- Output priority: describe the current anatomy profile first. Mention fresh/reloaded image visibility only where it changes or sharpens the current profile.

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
- This Head-to-Toe output must read like the current complete body-reference chart, not a report about only the attached/reloaded images.
- Use fresh attached images, when present, as new update evidence for directly visible whole-body anatomy, posture, habitus, alignment, skin/surface findings, and reference quality. Do not make them the whole report.
- If saved Profile Q&A images were reloaded, review them directly as saved/reused body-reference evidence. Do not act as if prior photos are absent.
- If no image payload is attached, use saved Profile Q&A visual findings and saved media-review digests as previously reviewed evidence. Do not reduce them to "nothing available."
- Clinical assessment priority: direct saved/reloaded images, prior Sarah media reviews, session/body-exploration visuals, and structured profile/session evidence are the main sources. Profile Q&A can fill context gaps, but it should not become the whole review or outweigh directly visible findings.
- Write the report like a clinician moving head-to-toe and saying the current findings as she goes. Do not let one question, dog bite/bruise story, batch upload, or recent close-up become the organizing focus unless Ben explicitly asks for that narrow follow-up.
- For regions not covered by the newest/reloaded images, summarize the best established baseline from saved profile findings and prior reviewed evidence. Do not write "not represented in this pass" or equivalent wording.
- Saved profile metrics may provide limited context for age, height, weight, general fitness/body context, or known non-visual limitations, but they do not create visible findings.
- Existing reviewed visual evidence is allowed as evidence when it directly describes whole-body, torso, abdomen, posture, limb, foot, skin/surface, habitus, symmetry, or body-reference visibility.
- Do not mine saved evidence for a long pelvic, device-fit, urethral, stimulation, ejaculation, session chronology, or foot-arousal-history narrative in this head-to-toe artifact.
- If saved evidence is mostly pelvic, genital, device, foot-camera, or session-specific, keep that material brief and state the head-to-toe limits. If saved/reused images actually show body regions, assess those regions instead of saying no reference exists.
- Genital/pelvic findings may be mentioned only briefly as a visible body region when fresh head-to-toe/body-reference images show them. Detailed meatal, catheter, sound/dilator, Foley, urethral accommodation, genital measurement, device-fit, arousal-state, ejaculation, or stimulation-mechanics material belongs in the dedicated pelvic/genital review, not here.
- Foot and lower-limb observations should be anatomical reference observations only: resting posture, toe/foot alignment, symmetry, visible swelling/deformity, skin/surface findings, or image limitations. Do not turn session foot-camera motion history into arousal/climax physiology in this artifact.
- Avoid dates, session names, event sequences, device sizes, sensory maps, stimulation techniques, and previously reviewed close-up genital chronology unless they are needed to explain why a region cannot be assessed in the head-to-toe reference.
- Output priority: describe the current complete body-reference profile first. Mention newest/reloaded view coverage only where it changes confidence, reveals a meaningful update, or supports next-image planning.

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
    coverage: String(image.coverage || "").trim(),
    selection_tags: Array.isArray(image.selection_tags) ? image.selection_tags : inferHeadToToeCoverageTags(image.coverage, image.upload_note, image.display_label),
    source_video: image.sourceVideo ? {
      video_id: image.sourceVideo.videoId || image.sourceVideo.id || "",
      frame_index: image.sourceVideo.frameIndex || null,
      frame_count: image.sourceVideo.frameCount || null,
      frame_time_seconds: image.sourceVideo.frameTimeSeconds ?? null,
      duration_seconds: image.sourceVideo.durationSeconds ?? null,
      purpose: image.sourceVideo.purpose || "",
      note: image.sourceVideo.note || "",
    } : null,
  }));
}

async function prepareFreshImageForReview(image, index, { onProgress, total = 0 } = {}) {
  let storagePath = image.storagePath || image.file_url || image.url || "";
  let data = image.data || "";
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
  if (!data) {
    onProgress?.({
      status: "preparing",
      progress: {
        phase: "loading_images",
        current: index + 1,
        total,
        message: `Loading saved reference image ${index + 1} for Sarah...`,
      },
    });
    const response = await fetchWithTimeout(
      serverUrl(storagePath),
      PROFILER_IMAGE_RELOAD_TIMEOUT_MS,
      `${image.filename || `Reference image ${index + 1}`} did not finish loading within ${Math.round(PROFILER_IMAGE_RELOAD_TIMEOUT_MS / 1000)} seconds.`,
    );
    if (!response.ok) throw new Error(`Could not reload ${image.filename || `reference image ${index + 1}`}.`);
    const blob = await withTimeout(
      response.blob(),
      PROFILER_IMAGE_RELOAD_TIMEOUT_MS,
      `${image.filename || `Reference image ${index + 1}`} did not finish reading within ${Math.round(PROFILER_IMAGE_RELOAD_TIMEOUT_MS / 1000)} seconds.`,
    );
    data = stripDataUrl(await readBlobAsDataUrl(blob, image.filename || `reference image ${index + 1}`));
  }
  return {
    ...image,
    filename: image.filename || `profile-reference-${index + 1}.jpg`,
    media_type: normalizeMediaType(image.media_type),
    data,
    storagePath,
    url: storagePath,
    previewUrl: image.previewUrl || serverUrl(storagePath),
    source: "fresh_upload",
    upload_note: String(image.upload_note || "").trim(),
  };
}

function buildImageReviewMeta(images = [], sessions = [], previousMeta = null, evidenceCounts = {}, generatedAtOverride = null, reviewedImageOverride = null, countOverrides = {}) {
  const freshImages = images.filter((image) => image.source === "fresh_upload");
  const reusedImages = images.filter((image) => image.source !== "fresh_upload");
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

function buildImageReviewMetaWithEvidence({
  images = [],
  sessions = [],
  previousResult = null,
  currentResult = null,
  evidenceCounts = {},
  generatedAtOverride = null,
  reviewedImageOverride = null,
  countOverrides = {},
} = {}) {
  const meta = buildImageReviewMeta(
    images,
    sessions,
    previousResult?._meta,
    evidenceCounts,
    generatedAtOverride,
    reviewedImageOverride,
    countOverrides,
  );
  return {
    ...meta,
    anatomical_evidence_records: buildAnatomicalEvidenceRecords({
      previousResult,
      currentResult,
      generatedAt: meta.generated_at || meta.last_generated_at || generatedAtOverride || new Date().toISOString(),
    }),
  };
}

function compareEvidenceStrength(a = "provisional", b = "provisional") {
  return EVIDENCE_STRENGTH_ORDER.indexOf(a) - EVIDENCE_STRENGTH_ORDER.indexOf(b);
}

function strongerEvidenceStrength(a = "provisional", b = "provisional") {
  return compareEvidenceStrength(a, b) >= 0 ? a : b;
}

function normalizedEvidenceImageRefs(items = []) {
  return [...new Set((Array.isArray(items) ? items : [])
    .map((item) => {
      if (!item) return "";
      if (typeof item === "string") return item;
      return item.image_id || item.display_label || item.filename || "";
    })
    .map((item) => String(item || "").trim())
    .filter(Boolean))]
    .slice(0, 12);
}

function inferAnatomicalEvidenceKey(value = "") {
  const text = String(value || "").toLowerCase();
  if (/\bperineal\s+raphe\b|\bmidline\s+raphe\b.*\bperine/i.test(text)) return "perineal_raphe";
  if (/\bscrotal\s+raphe\b|\bscrotum\b|\btestes?\b|\bhemiscrotum\b/i.test(text)) return "scrotal_baseline";
  if (/\bforeskin\b|\bprepuce\b|\bretract(?:ed|ion|able|s)?\b/i.test(text)) return "foreskin_mobility";
  if (/\bglans\b/i.test(text)) return "glans_baseline";
  if (/\bmeatus\b|\bmeatal\b/i.test(text)) return "meatal_baseline";
  if (/\bflaccid\b.*\b(?:penis|shaft|genital)|\bpenis\b.*\bflaccid\b/i.test(text)) return "flaccid_genital_baseline";
  if (/\banal\b|\bperianal\b|\banal verge\b|\banal opening\b/i.test(text)) return "anal_baseline";
  if (/\bright\s+inguinal\s+scar\b|\bhernia\s+repair\s+scar\b/i.test(text)) return "right_inguinal_scar";
  if (/\bleft\s+abdominal\s+scar\b/i.test(text)) return "left_abdominal_scar";
  if (/\babdominal\s+(?:mole|nevus|naevus|pigmented)\b|\btorso\b.*\bpigmented\b/i.test(text)) return "abdominal_mole";
  if (/\bshoulder\b.*\b(?:level|symmetr|asymmetr|alignment)\b/i.test(text)) return "shoulder_alignment";
  if (/\bposture\b|\bkyphosis\b|\blordosis\b|\bpelvic\s+tilt\b|\bforward\s+head\b/i.test(text)) return "posture_profile";
  if (/\bfoot\b|\bfeet\b|\btoe\b|\btoes\b|\barch\b|\bheel\b/i.test(text)) return "foot_morphology";
  if (/\babdomen\b|\babdominal\b|\bpannus\b|\bcentral\s+adip/i.test(text)) return "central_adiposity";
  if (/\bpapules?\b|\bfollicul|\bkeratosis\b|\berythematous\b.*\b(?:spots?|papules?)\b/i.test(text)) return "skin_papules";
  return "";
}

function defaultEvidenceStrengthForKey(key, confidence = "", confirmations = 1) {
  const highConfidence = /\bhigh\b/i.test(String(confidence || ""));
  if (STRONGLY_ESTABLISHED_EVIDENCE_KEYS.has(key) && (highConfidence || confirmations >= 2)) return "strongly_established";
  if (ESTABLISHED_EVIDENCE_KEYS.has(key) && (highConfidence || confirmations >= 2)) return "established";
  if (BASELINE_EVIDENCE_KEYS.has(key)) return confirmations >= 2 || highConfidence ? "baseline" : "provisional";
  if (highConfidence && confirmations >= 2) return "baseline";
  return "provisional";
}

function normalizeAnatomicalEvidenceRecord(record = {}, fallbackDate = null) {
  const text = [
    record.key,
    record.label,
    record.region,
    record.summary,
    record.finding,
  ].filter(Boolean).join(" ");
  const key = String(record.key || inferAnatomicalEvidenceKey(text) || "").trim();
  if (!key) return null;
  const confidence = String(record.confidence || "moderate").trim();
  const sourceImages = normalizedEvidenceImageRefs(record.source_images || record.sourceImages || []);
  const confirmations = Math.max(1, Number(record.confirmations || record.confirmation_count || sourceImages.length || 1));
  const evidenceStrength = EVIDENCE_STRENGTH_ORDER.includes(record.evidence_strength)
    ? record.evidence_strength
    : defaultEvidenceStrengthForKey(key, confidence, confirmations);
  return {
    key,
    label: briefText(record.label || record.region || key.replace(/_/g, " "), 120),
    region: briefText(record.region || record.section_key || "", 120),
    summary: briefText(cleanImageReviewProse(record.summary || record.finding || record.description || ""), 360),
    confidence,
    first_observed_date: sessionDateKey(record.first_observed_date || record.firstObservedDate || fallbackDate) || fallbackDate || "",
    last_confirmed_date: sessionDateKey(record.last_confirmed_date || record.lastConfirmedDate || fallbackDate) || fallbackDate || "",
    source_images: sourceImages,
    evidence_strength: evidenceStrength,
    confirmations,
  };
}

function evidenceRecordFromFinding(finding = {}, generatedAt = null) {
  const combined = [
    finding.section_key,
    finding.region,
    finding.label,
    finding.finding,
    finding.evidence_level,
  ].filter(Boolean).join(" ");
  const key = inferAnatomicalEvidenceKey(combined);
  if (!key) return null;
  return normalizeAnatomicalEvidenceRecord({
    key,
    label: finding.label || finding.region,
    region: finding.region || finding.section_key,
    summary: finding.finding,
    confidence: finding.confidence || "moderate",
    first_observed_date: generatedAt,
    last_confirmed_date: generatedAt,
    source_images: finding.image_id ? [finding.image_id] : [],
    confirmations: 1,
  }, generatedAt);
}

function mergeAnatomicalEvidenceRecords(existingRecords = [], newRecords = []) {
  const byKey = new Map();
  for (const raw of [...existingRecords, ...newRecords]) {
    const record = normalizeAnatomicalEvidenceRecord(raw);
    if (!record) continue;
    const existing = byKey.get(record.key);
    if (!existing) {
      byKey.set(record.key, record);
      continue;
    }
    const confirmations = Math.max(1, Number(existing.confirmations || 1) + Number(record.confirmations || 1));
    const sourceImages = normalizedEvidenceImageRefs([...(existing.source_images || []), ...(record.source_images || [])]);
    byKey.set(record.key, {
      ...existing,
      label: existing.label || record.label,
      region: existing.region || record.region,
      summary: record.summary || existing.summary,
      confidence: /\bhigh\b/i.test(record.confidence || "") ? record.confidence : existing.confidence,
      first_observed_date: [existing.first_observed_date, record.first_observed_date].filter(Boolean).sort()[0] || "",
      last_confirmed_date: [existing.last_confirmed_date, record.last_confirmed_date].filter(Boolean).sort().slice(-1)[0] || "",
      source_images: sourceImages,
      evidence_strength: strongerEvidenceStrength(
        defaultEvidenceStrengthForKey(record.key, record.confidence, confirmations),
        strongerEvidenceStrength(existing.evidence_strength, record.evidence_strength),
      ),
      confirmations,
    });
  }
  return [...byKey.values()]
    .sort((a, b) => compareEvidenceStrength(b.evidence_strength, a.evidence_strength) || String(a.key).localeCompare(String(b.key)))
    .slice(0, 80);
}

function buildAnatomicalEvidenceRecords({ previousResult = null, currentResult = null, generatedAt = null } = {}) {
  const previousRecords = Array.isArray(previousResult?._meta?.anatomical_evidence_records)
    ? previousResult._meta.anatomical_evidence_records
    : [];
  const previousGeneratedAt = previousResult?._meta?.generated_at || previousResult?._meta?.last_generated_at || generatedAt;
  const previousDerivedRecords = previousRecords.length
    ? []
    : (Array.isArray(previousResult?.image_region_findings)
      ? previousResult.image_region_findings.map((finding) => evidenceRecordFromFinding(finding, previousGeneratedAt)).filter(Boolean)
      : []);
  const currentRecords = Array.isArray(currentResult?.image_region_findings)
    ? currentResult.image_region_findings.map((finding) => evidenceRecordFromFinding(finding, generatedAt)).filter(Boolean)
    : [];
  const modelRecords = Array.isArray(currentResult?.anatomical_evidence_records)
    ? currentResult.anatomical_evidence_records
    : [];
  return mergeAnatomicalEvidenceRecords([...previousRecords, ...previousDerivedRecords], [...modelRecords, ...currentRecords]);
}

function existingAnatomicalEvidenceRecordsForPrompt(result = null) {
  if (Array.isArray(result?._meta?.anatomical_evidence_records) && result._meta.anatomical_evidence_records.length) {
    return result._meta.anatomical_evidence_records;
  }
  return buildAnatomicalEvidenceRecords({
    currentResult: result,
    generatedAt: result?._meta?.generated_at || result?._meta?.last_generated_at || null,
  });
}

function formatIncrementalEvidenceRecordsForPrompt(records = [], { limit = 28 } = {}) {
  const normalized = mergeAnatomicalEvidenceRecords(records, []);
  if (!normalized.length) {
    return "ESTABLISHED ANATOMICAL EVIDENCE RECORDS:\n- None stored yet. This review may establish baseline findings, but should still avoid repetition.";
  }
  const lines = normalized.slice(0, limit).map((record) => (
    `- ${record.label || record.key}: ${record.evidence_strength}; confidence ${record.confidence}; first observed ${record.first_observed_date || "unknown"}; last confirmed ${record.last_confirmed_date || "unknown"}; source images ${record.source_images?.length ? record.source_images.join(", ") : "not linked"}${record.summary ? `. ${briefText(record.summary, 260)}` : ""}`
  ));
  return `ESTABLISHED ANATOMICAL EVIDENCE RECORDS:\n${lines.join("\n")}`;
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
  return refs.map((ref) => {
    const video = ref.source_video;
    const videoContext = video
      ? ` Sampled video frame ${video.frame_index || "?"}/${video.frame_count || "?"}${video.frame_time_seconds != null ? ` at ${formatVideoTimestamp(video.frame_time_seconds)}` : ""}${video.duration_seconds ? ` of a ${formatVideoTimestamp(video.duration_seconds)} uploaded video` : " from an uploaded video"}. Use same-video frame sequences cautiously for visible motion, gait, measurement, or device-position changes; do not claim full continuous video review beyond sampled frames.`
      : "";
    const coverageHint = headToToeCoverageLabels(ref.selection_tags).join(", ");
    const coverageContext = coverageHint || ref.coverage
      ? `. Coverage hints from saved evidence: ${briefText([coverageHint, ref.coverage].filter(Boolean).join(". "), 260)}`
      : "";
    return `- ${ref.image_id}: ${ref.display_label}${videoContext}${ref.upload_note ? `. User note: ${briefText(ref.upload_note, 240)}` : ""}${coverageContext}. Infer the anatomical view from the image content; do not use uploaded filenames, camera-roll numbers, or storage IDs in the user-facing review.`;
  }).join("\n");
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
      anatomical_evidence_records: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            label: { type: "string" },
            region: { type: "string" },
            summary: { type: "string" },
            confidence: { type: "string" },
            first_observed_date: { type: "string" },
            last_confirmed_date: { type: "string" },
            source_images: { type: "array", items: { type: "string" } },
            evidence_strength: { type: "string" },
            confirmations: { type: "number" },
          },
          required: ["key", "label", "confidence", "evidence_strength"],
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
    anatomical_evidence_records: Array.isArray(result?.anatomical_evidence_records)
      ? mergeAnatomicalEvidenceRecords(result.anatomical_evidence_records, []).slice(0, 16).map((record) => ({
        key: record.key,
        label: briefText(record.label || "", 120),
        region: briefText(record.region || "", 120),
        summary: briefText(record.summary || "", 260),
        confidence: record.confidence,
        first_observed_date: record.first_observed_date,
        last_confirmed_date: record.last_confirmed_date,
        source_images: normalizedEvidenceImageRefs(record.source_images),
        evidence_strength: record.evidence_strength,
        confirmations: record.confirmations,
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
  className = "relative aspect-[4/3] overflow-hidden bg-muted/20",
  imageClassName = "",
  fitMode = "contain",
  onClick = null,
}) {
  const { containerRef, getRect, setNaturalSize } = useContainedImageRect();
  const rect = getRect(fitMode);
  const imageUrl = image?.preview_url ? serverUrl(image.preview_url) : "";
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl]);

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
      {imageUrl && !imageFailed ? (
        <img
          src={imageUrl}
          alt={image.display_label || "Reviewed anatomy reference"}
          className={`absolute z-[1] object-contain ${imageClassName}`}
          decoding="async"
          style={rect ? {
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          } : { inset: 0, width: "100%", height: "100%" }}
          onLoad={(event) => {
            const img = event.currentTarget;
            setNaturalSize({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
          }}
          onError={() => {
            setImageFailed(true);
          }}
        />
      ) : (
        <div className="flex h-full min-h-36 items-center justify-center bg-muted/20 px-4 text-center text-sm leading-relaxed text-foreground/85 dark:text-white/85">
          {imageFailed ? "Image preview could not load from the local server." : unavailableText}
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

function rawProfileImageById(result, imageId, transientImages = []) {
  const reviewed = Array.isArray(result?._meta?.reviewed_images) ? result._meta.reviewed_images : [];
  const transient = transientImages.map((image, index) => ({
    image_id: image.image_id || `img_${String(index + 1).padStart(3, "0")}`,
    preview_url: image.previewUrl || image.preview_url || image.storagePath || "",
    display_label: image.display_label || `Reference view ${reviewImageLetter(index)}`,
    body_position: image.body_position || "",
    coverage: image.coverage || image.upload_note || "",
    visibility_notes: image.visibility_notes || "",
    major_regions_visible: image.major_regions_visible || image.regions || [],
    upload_note: image.upload_note || "",
    source_video: image.source_video || null,
    source: image.source || "",
  }));
  const image = reviewed.find((item) => item.image_id === imageId) || {};
  const imageUrl = image.preview_url || image.storagePath || image.url || "";
  const transientImage = transient.find((item) => (
    item.image_id === imageId ||
    (imageUrl && item.preview_url === imageUrl)
  )) || {};
  const previewUrl = imageUrl || transientImage.preview_url || "";
  return {
    ...transientImage,
    ...image,
    preview_url: previewUrl,
    display_label: image.display_label || transientImage.display_label || "Reviewed view",
    body_position: image.body_position || transientImage.body_position || "",
    coverage: image.coverage || image.upload_note || transientImage.coverage || "",
    visibility_notes: image.visibility_notes || transientImage.visibility_notes || "",
    major_regions_visible: image.major_regions_visible || transientImage.major_regions_visible || [],
    upload_note: image.upload_note || transientImage.upload_note || "",
    source_video: image.source_video || transientImage.source_video || null,
    source: image.source || transientImage.source || "",
  };
}

function profileImageById(result, imageId, transientImages = []) {
  const reviewed = Array.isArray(result?._meta?.reviewed_images) ? result._meta.reviewed_images : [];
  const annotated = Array.isArray(result?.annotated_images) ? result.annotated_images : [];
  const transient = transientImages.map((image, index) => ({
    image_id: image.image_id || `img_${String(index + 1).padStart(3, "0")}`,
    preview_url: image.previewUrl || image.preview_url || image.storagePath || "",
    display_label: image.display_label || `Reference view ${reviewImageLetter(index)}`,
    body_position: image.body_position || "",
    coverage: image.coverage || image.upload_note || "",
    visibility_notes: image.visibility_notes || "",
    major_regions_visible: image.major_regions_visible || image.regions || [],
    upload_note: image.upload_note || "",
    source_video: image.source_video || null,
    source: image.source || "",
  }));
  const image = reviewed.find((item) => item.image_id === imageId) || {};
  const annotation = annotated.find((item) => item.image_id === imageId) || {};
  const imageUrl = image.preview_url || image.storagePath || image.url || "";
  const transientImage = transient.find((item) => (
    item.image_id === imageId ||
    (imageUrl && item.preview_url === imageUrl)
  )) || {};
  const previewUrl = imageUrl || transientImage.preview_url || annotation.preview_url || "";
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
  const pelvicScoped = isPelvicGenitalReviewResult(result);
  const findings = Array.isArray(result?.image_region_findings)
    ? result.image_region_findings.filter((finding) => !pelvicScoped || isPelvicGenitalFindingInScope(result, finding, transientImages))
    : [];
  const annotated = Array.isArray(result?.annotated_images) ? result.annotated_images : [];
  const reviewed = Array.isArray(result?._meta?.reviewed_images) ? result._meta.reviewed_images : [];
  const imageIds = [...new Set([
    ...(pelvicScoped ? [] : reviewed.map((image) => image.image_id).filter(Boolean)),
    ...annotated
      .map((image) => image.image_id)
      .filter((imageId) => {
        if (!imageId) return false;
        if (!pelvicScoped) return true;
        const text = pelvicGenitalImageEvidenceText(result, imageId, transientImages, null);
        return !isPelvicGenitalTextOutOfScope(text) && PELVIC_GENITAL_STRONGLY_POSITIVE_RE.test(text);
      }),
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

      <div className="grid gap-3 xl:grid-cols-2">
        {imageIds.map((imageId) => {
          const image = pelvicScoped
            ? rawProfileImageById(result, imageId, transientImages)
            : profileImageById(result, imageId, transientImages);
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
                className="relative aspect-[4/3] overflow-hidden bg-muted/20"
                fitMode="contain"
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
  const pelvicScoped = isPelvicGenitalReviewResult(result);
  const findings = Array.isArray(result?.image_region_findings)
    ? result.image_region_findings.filter((finding) => !pelvicScoped || isPelvicGenitalFindingInScope(result, finding, transientImages))
    : [];
  const selectedIndex = Math.max(0, imageIds.indexOf(selectedImageId));
  const imageId = imageIds[selectedIndex] || selectedImageId;
  const image = pelvicScoped
    ? rawProfileImageById(result, imageId, transientImages)
    : profileImageById(result, imageId, transientImages);
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

const PROCEDURAL_IMAGE_CONTEXT_RE = /\b(foley|catheter|dwell|meatus|meatal|urethral|gloved|sterile|drape|insertion|post-placement|procedure|field|tube|tubing|drainage|collection bag|statlock|device)\b/i;
const CLINICAL_REFERENCE_IMAGE_CONTEXT_RE = /\b(standing|anterior|posterior|lateral|front view|side view|back view|supine|prone|seated|whole[-\s]?body|full[-\s]?body|head[-\s]?to[-\s]?toe|torso|abdomen|abdominal|pelvis|pelvic|pubic|inguinal|groin|reference|baseline|anatomical|clinical)\b/i;
const SECTION_REFERENCE_HINTS = {
  head_face: /\b(head|face|facial|scalp|hair|forehead|eye|eyes|nose|cheek|mouth|chin|jaw)\b/i,
  neck: /\b(neck|cervical|throat|nape)\b/i,
  shoulders_upper_back: /\b(shoulder|upper back|thoracic|scapula|back view|posterior trunk)\b/i,
  chest: /\b(chest|pectoral|sternum|rib|thorax|anterior trunk)\b/i,
  abdomen: /\b(abdomen|abdominal|belly|umbilicus|navel|pannus|flank|waist|scar|hernia|bruise|ecchymosis)\b/i,
  pelvis_pubic_region: /\b(pelvis|pelvic|pubic|suprapubic|inguinal|groin|hip|hips|lower abdomen|abdominal)\b/i,
  genitals_perineum: /\b(genital|genitals|penis|penile|pubic|perineum|perineal|scrotum|glans|meatus)\b/i,
  buttocks_perianal_region: /\b(buttock|buttocks|gluteal|perianal|anal|anus)\b/i,
  upper_limbs_hands: /\b(arm|arms|upper limb|elbow|forearm|wrist|hand|hands|finger|thumb)\b/i,
  lower_limbs: /\b(leg|legs|lower limb|thigh|knee|calf|shin|ankle|standing)\b/i,
  feet_toes: /\b(foot|feet|toe|toes|heel|plantar|dorsal foot|arch|malleolar)\b/i,
  posture_alignment: /\b(standing|whole[-\s]?body|full[-\s]?body|head[-\s]?to[-\s]?toe|anterior|posterior|lateral|posture|alignment|symmetry|baseline)\b/i,
  skin_summary: /\b(skin|lesion|rash|redness|erythema|scar|bruise|wound|bite|pigmentation|mark)\b/i,
  pubic_mound_lower_abdomen: /\b(pubic|pubic mound|suprapubic|lower abdomen|abdominal|inguinal|groin|pelvis|pelvic|scar)\b/i,
  inguinal_folds_groin_skin: /\b(inguinal|groin|crease|fold|pelvic|pubic)\b/i,
  penis: /\b(penis|penile|shaft|foreskin|glans|meatus)\b/i,
  foreskin: /\b(foreskin|prepuce|glans|penile)\b/i,
  glans_meatus: /\b(glans|meatus|meatal|urethral|catheter|foley)\b/i,
  scrotum_testes: /\b(scrotum|scrotal|testes|testicle|testicular)\b/i,
  perineum: /\b(perineum|perineal|anal|scrotal base)\b/i,
  anal_opening_perianal_region: /\b(anal|anus|perianal|rectal)\b/i,
  buttocks_gluteal_skin: /\b(buttocks|gluteal|glute)\b/i,
  device_contact_findings: /\b(device|foley|catheter|tube|tubing|statlock|contact|meatus|urethral)\b/i,
  tissue_health_safety_observations: /\b(tissue|skin|irritation|redness|erythema|lesion|wound|swelling|edema|moisture|drainage)\b/i,
  measurement_reconciliation: /\b(measurement|measure|ruler|diameter|length|circumference)\b/i,
};

function inlineEvidenceImageText(result, imageId, transientImages = [], pelvicScoped = false) {
  const image = pelvicScoped
    ? rawProfileImageById(result, imageId, transientImages)
    : profileImageById(result, imageId, transientImages);
  const rawImage = rawProfileImageById(result, imageId, transientImages);
  const annotation = Array.isArray(result?.annotated_images)
    ? result.annotated_images.find((item) => item?.image_id === imageId) || {}
    : {};
  return compactEvidenceText(
    image?.display_label,
    image?.body_position,
    image?.coverage,
    image?.visibility_notes,
    image?.major_regions_visible,
    image?.upload_note,
    rawImage?.display_label,
    rawImage?.body_position,
    rawImage?.coverage,
    rawImage?.visibility_notes,
    rawImage?.major_regions_visible,
    rawImage?.upload_note,
    rawImage?.source,
    rawImage?.source_video?.note,
    rawImage?.source_video?.purpose,
    annotation?.view_label,
    annotation?.coverage,
    annotation?.visibility_notes,
    annotation?.major_regions_visible,
  );
}

function inlineEvidenceImageScore(result, imageId, sectionKey, findingsForImage = [], transientImages = [], pelvicScoped = false) {
  const image = pelvicScoped
    ? rawProfileImageById(result, imageId, transientImages)
    : profileImageById(result, imageId, transientImages);
  if (!image?.preview_url) return -10000;
  const text = inlineEvidenceImageText(result, imageId, transientImages, pelvicScoped);
  const sectionHint = SECTION_REFERENCE_HINTS[sectionKey];
  let score = findingsForImage.length * 70;
  if (sectionHint?.test(text)) score += 90;
  if (CLINICAL_REFERENCE_IMAGE_CONTEXT_RE.test(text)) score += 35;
  if (/\b(reference|baseline|anatomical|clinical|profile)\b/i.test(text)) score += 30;
  if (/\b(saved_profile_qa|body[-_\s]?exploration|profile_review_archive)\b/i.test(text)) score += 12;
  if (PROCEDURAL_IMAGE_CONTEXT_RE.test(text)) {
    if (sectionKey === "device_contact_findings" || sectionKey === "glans_meatus") score += 20;
    else if (sectionKey === "pubic_mound_lower_abdomen" || sectionKey === "pelvis_pubic_region") score -= 95;
    else score -= pelvicScoped ? 45 : 80;
  }
  if (pelvicScoped && isPelvicGenitalTextOutOfScope(text)) score -= 200;
  return score;
}

function priorInlineEvidenceImageUseCounts(result, sectionKey, sections = []) {
  const counts = new Map();
  const sectionKeys = Array.isArray(sections) ? sections.map((section) => section?.key).filter(Boolean) : [];
  const currentIndex = sectionKeys.indexOf(sectionKey);
  if (currentIndex <= 0) return counts;
  const priorKeys = new Set(sectionKeys.slice(0, currentIndex));
  const allFindings = Array.isArray(result?.image_region_findings) ? result.image_region_findings : [];
  for (const finding of allFindings) {
    if (!finding?.image_id || !priorKeys.has(finding.section_key)) continue;
    counts.set(finding.image_id, (counts.get(finding.image_id) || 0) + 1);
  }
  return counts;
}

function selectInlineEvidenceImageIds(result, sectionKey, findings = [], transientImages = [], pelvicScoped = false, sections = []) {
  const reviewed = Array.isArray(result?._meta?.reviewed_images) ? result._meta.reviewed_images : [];
  const annotated = Array.isArray(result?.annotated_images) ? result.annotated_images : [];
  const priorUseCounts = priorInlineEvidenceImageUseCounts(result, sectionKey, sections);
  const candidates = [
    ...findings.map((finding) => finding.image_id),
    ...reviewed.map((image) => image.image_id),
    ...annotated.map((image) => image.image_id),
    ...transientImages.map((image, index) => image.image_id || `img_${String(index + 1).padStart(3, "0")}`),
  ].filter(Boolean);
  const uniqueIds = [...new Set(candidates)];
  const scored = uniqueIds
    .map((imageId) => {
      const imageFindings = findings.filter((finding) => finding.image_id === imageId);
      const score = inlineEvidenceImageScore(result, imageId, sectionKey, imageFindings, transientImages, pelvicScoped);
      const priorUseCount = priorUseCounts.get(imageId) || 0;
      return {
        imageId,
        score,
        adjustedScore: score - priorUseCount * 120,
        hasFinding: imageFindings.length > 0,
        priorUseCount,
      };
    })
    .filter((item) => item.score > -10000)
    .sort((a, b) => {
      if (b.adjustedScore !== a.adjustedScore) return b.adjustedScore - a.adjustedScore;
      if (b.score !== a.score) return b.score - a.score;
      return Number(b.hasFinding) - Number(a.hasFinding);
    });
  const withFindings = scored.filter((item) => item.hasFinding);
  const bestWithFindings = withFindings.filter((item) => item.score > 0).slice(0, 2);
  const fallbackWithFindings = withFindings.slice(0, 2);
  const best = scored.filter((item) => item.score > 0).slice(0, 2);
  const selected = bestWithFindings.length ? bestWithFindings : fallbackWithFindings.length ? fallbackWithFindings : best;
  const selectedIds = new Set(selected.map((item) => item.imageId));
  if (selected.length === 1 && selected[0].priorUseCount > 0) {
    const alternate = best.find((item) => !selectedIds.has(item.imageId));
    if (alternate) selected.push(alternate);
  }
  return selected.map((item) => item.imageId);
}

function InlineImageEvidence({ result, sectionKey, sections = [], color = "hsl(var(--primary))", transientImages = [], onOpenImage = null, onCorrectFinding = null, onRemoveFinding = null }) {
  const pelvicScoped = isPelvicGenitalReviewResult(result);
  const findings = Array.isArray(result?.image_region_findings)
    ? result.image_region_findings.filter((finding) => finding.section_key === sectionKey && (!pelvicScoped || isPelvicGenitalFindingInScope(result, finding, transientImages)))
    : [];
  if (!findings.length) return null;

  const imageIds = selectInlineEvidenceImageIds(result, sectionKey, findings, transientImages, pelvicScoped, sections);
  if (!imageIds.length) return null;
  const sectionLabel = sectionLabelForKey(sections, sectionKey);

  return (
    <div className="my-4 rounded-xl border border-border bg-card/80 p-2.5 shadow-sm sm:p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-1 py-1">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider" style={{ color }}>
          <ImageIcon className="h-3.5 w-3.5" /> Evidence for {sectionLabel}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="h-5 text-[10px]">{findings.length} linked note{findings.length === 1 ? "" : "s"}</Badge>
          <Badge variant="secondary" className="h-5 text-[10px]">{imageIds.length} visible view{imageIds.length === 1 ? "" : "s"}</Badge>
        </span>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {imageIds.map((imageId) => {
          const image = pelvicScoped
            ? rawProfileImageById(result, imageId, transientImages)
            : profileImageById(result, imageId, transientImages);
          const imageFindings = findings.filter((finding) => finding.image_id === imageId).slice(0, 4);
          const pinnedFindings = imageFindings.filter((finding) => finding.pin?.x != null && finding.pin?.y != null);
          return (
            <div key={`${sectionKey}-${imageId}`} className="overflow-hidden rounded-lg border border-border bg-background shadow-sm">
              <div className="grid gap-0">
                <AnnotatedImageStage
                  image={image}
                  pinnedFindings={pinnedFindings}
                  unavailableText="Image preview unavailable for this saved run."
                  className="relative aspect-[4/3] overflow-hidden bg-muted/20"
                  fitMode="contain"
                  onClick={onOpenImage ? () => onOpenImage(imageId) : null}
                />
                <div className="space-y-2 p-3">
                  <div>
                    <p className="text-sm font-semibold leading-snug text-foreground dark:text-white">{image.display_label || "Reviewed view"}</p>
                    {(image.body_position || image.coverage || image.visibility_notes) && (
                      <p className="mt-1.5 line-clamp-4 text-xs leading-relaxed text-muted-foreground">
                        {[image.body_position, image.coverage, image.visibility_notes].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    {imageFindings.length > 0 ? imageFindings.map((finding, index) => (
                      <div key={`${finding.finding_id}-inline`} className="rounded-md border border-border bg-muted/20 p-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {finding.pin && (
                            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
                              {index + 1}
                            </span>
                          )}
                      <span className="text-sm font-semibold leading-snug text-foreground dark:text-white">{finding.label || finding.region || "Visible finding"}</span>
                      <Badge variant="outline" className="h-5 text-[10px]">{confidenceLabel(finding.confidence)}</Badge>
                      {finding.evidence_level && (
                        <Badge variant="secondary" className="h-5 text-[10px]">{confidenceLabel(finding.evidence_level)}</Badge>
                      )}
                    </div>
                        {finding.finding && (
                          <p className="mt-1.5 text-xs leading-relaxed text-foreground/90 dark:text-white/90">{finding.finding}</p>
                        )}
                        <FindingCorrectionControl finding={finding} onCorrectFinding={onCorrectFinding} onRemoveFinding={onRemoveFinding} />
                      </div>
                    )) : (
                      <p className="rounded-md border border-border bg-muted/20 p-3 text-sm leading-relaxed text-muted-foreground">
                        Reference view selected for this section. Sarah did not attach a separate pinned note to this exact image.
                      </p>
                    )}
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
  const pelvicScoped = isPelvicGenitalReviewResult(result);
  const findings = Array.isArray(result?.image_region_findings)
    ? result.image_region_findings.filter((finding) => finding.section_key === sectionKey && (!pelvicScoped || isPelvicGenitalFindingInScope(result, finding, transientImages)))
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
    const image = pelvicScoped
      ? rawProfileImageById(result, imageId, transientImages)
      : profileImageById(result, imageId, transientImages);
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
  maxImages: 30,
  libraryImageLimit: 60,
  icon: <ImageIcon className="w-4 h-4" />,
  color: "hsl(var(--chart-4))",
  purpose: "Whole-body anatomical reference review in anatomical position, standing, prone, supine, seated, or supported positioning.",
  helper: "Review saved whole-body/profile evidence from Q&A, sessions, body exploration, entered metrics, and prior Sarah media reviews. Fresh images or videos are optional add-on evidence for posture, gait, alignment, body habitus, skin/surface findings, body symmetry, and reference quality.",
  emptyText: "Review Existing Evidence uses the saved body-reference library first, including prior reviewed images, reusable frames, body-exploration evidence, sessions, and Profile Q&A as supporting context. Add fresh images or videos only when you want to expand the library.",
  reviewInstructions: `
HEAD-TO-TOE REVIEW SCOPE:
- Produce one cumulative anatomical profile of Ben. This is not a batch report, image audit, provenance report, or process note.
- Start with anatomy. Do not open with source details, image counts, batch status, timeout/recovery language, payment/cloud language, or "assembled from" language.
- Make the review easy to listen to as downloaded audio: top-to-bottom flow, minimal repetition, short clear paragraphs, and no duplicate callout/prose narration.
- Prioritize observations: visible anatomy, posture, symmetry, skin findings, and meaningful changes. Default mode is observe, not defend or prove.
- This is a comprehensive current physical-appearance exam, not a novelty report. Answer "what does this person look like today from head to toe?" before answering "what changed?"
- Preserve anatomical coverage. Head, face, neck, shoulders, upper back, chest, abdomen, pelvis, genitals/perineum, buttocks/perianal region, upper extremities, lower extremities, feet, posture, and skin all matter.
- Distinguish stable baseline findings from active findings. Baseline includes body habitus, posture, skin distribution, scars, stable anatomy, and long-term observations. Active includes wounds, bruising, edema, catheter/device state, new lesions, irritation, or interval change.
- Novel findings should be documented thoroughly in their anatomical section, then stop. Do not let a wound, scar, catheter, mole, edema episode, or isolated lesion become the organizing theme of unrelated sections.
- Write short present-tense findings. Good: "Mild bilateral ankle swelling. Small follicular papules on the lower legs. Skin otherwise appears healthy." Avoid paragraphs that explain why the database believes the finding.
- Use all available reviewed evidence as cumulative evidence. Do not frame findings around "this batch", "prior batch", "subsequent batch", "image set", "rechecked saved/direct views", or image numbers.
- Treat this like a clinician performing a full head-to-toe exam from the saved library. Move region by region and say the current findings as you go.
- Do not let a single question, bruise story, dog bite, batch upload, or recent close-up become the organizing theme of the report. Put those items in the relevant anatomical section only if they matter clinically.
- Profile Q&A is supporting context only. Direct saved images, prior media reviews, session visuals, body-exploration frames, and entered clinical/profile data outrank Q&A when forming the body map.
- Preserve the full established head-to-toe picture every run. The newest images are the update layer, not the whole report.
- If a section has saved evidence but no direct fresh view, summarize the current anatomical finding in one useful sentence only if it adds value. Do not write only "not visible", "not represented in this pass", "stable from prior established baseline", or "baseline carried forward."
- If a section is not present in the directly reloaded image subset but saved profile/context evidence indicates that region exists elsewhere, do not say the current evidence library has no direct images. Say only that it was not directly rechecked in this subset, then use established evidence cautiously.
- If a section has no established evidence anywhere after checking the saved context and established evidence records, write "No established baseline yet for this region" once. Do not describe that as a failure of the current pass.
- When a current image shows a meaningful update, describe the update in relation to the existing body map. Example: "The right lateral abdominal bite zone is now in yellow-green bruise resolution, while the rest of the established abdominal baseline remains unchanged."
- Do not mention prior corrections, invalidated findings, evidence conflicts, confidence accumulation, or historical mistakes unless Ben explicitly asks for an audit trail.
- Comparison should appear only when it adds value: healing, bruising, swelling, wound/lesion evolution, a new finding, or an explicit comparison request.
- Do not write camera-location descriptions, room/environment commentary, ECG/chest strap commentary, headphones commentary, foot-camera commentary, table-paper commentary, or duplicate visual-reference/callout dumps.
- Ignore incidental objects unless they directly affect anatomical visibility, tissue safety, or device-contact interpretation.
- Keep the language clinical, neutral, practical, and anatomically literate. Adult anatomy and nudity are in scope when present, but the review must not become erotic or moralizing.
- Separate visible findings from interpretation. Do not infer psychology, arousal, pain, function, dominance, intent, or session state from static posture alone.
- If nudity or genital anatomy is visible, keep Head-to-Toe genital/perineal discussion brief. Detailed pelvic/genital anatomy belongs in the dedicated Pelvic/Genital review.
- Do not summarize catheter, urethral, sound/dilator, Foley, sleeve, stimulation, ejaculation, arousal progression, foot-camera arousal recruitment, or genital measurement history in Head-to-Toe.
- Compare visible whole-body findings against saved Q&A findings, prior sessions, and entered metrics only where they help reconcile body reference evidence. Do not let profile context override fresh image evidence.
- Organize the output exactly as a top-to-bottom anatomical profile:
  1. Executive Summary: 6 to 12 bullets maximum. Describe the whole physical picture first: overall appearance, body habitus, posture, skin overview, major scars, extremity overview, notable anatomical characteristics, major active findings, and important interval changes.
  2. Head & Face: hair, face, glasses only if relevant to body profile, visible skin findings, symmetry if visible.
  3. Neck: contour, posture, visible masses or asymmetry if any.
  4. Shoulders & Upper Back: shoulder level/symmetry, thoracic posture, visible skin findings.
  5. Chest: chest contour, pectoral soft tissue, nipples if relevant, visible skin findings. Ignore ECG/chest strap unless explicitly requested.
  6. Abdomen: abdominal contour, central adiposity or pannus, umbilicus, scars, lesions, hernia bulges if visible.
  7. Pelvis / Pubic Region: pubic mound, pubic hair distribution, inguinal creases, scars such as hernia repair scar if visible. Do not deep-dive genital anatomy here.
  8. Genitals / Perineum: brief summary only; details belong in Pelvic/Genital review.
  9. Buttocks / Perianal Region: gluteal contour and visible perianal skin only when represented.
  10. Upper Limbs & Hands: symmetry, soft tissue bulk, hand/finger findings if visible.
  11. Lower Limbs: thigh/calf symmetry, knee alignment, edema, varicosities, skin findings if visible.
  12. Feet & Toes: resting foot posture, toe alignment, visible deformity or swelling. Avoid dynamic gait claims from still images.
  13. Posture & Alignment: concise cumulative summary; avoid contradictory lumbar/pelvic statements and hidden bony landmark claims.
  14. Skin Summary: consolidated skin findings only. Do not repeat them by image.
  15. Limitations / Useful Future Coverage: only truly useful missing views. Do not request views already adequately represented.
- Every claim must be based on visible image evidence unless explicitly marked as profile/context interpretation. Prefer calibrated wording such as "appears", "is visible", "aligns with", "matches", or "not visible in this specific view" over stronger wording, but do not overuse caveats.
`,
  sections: [
    { key: "executive_summary", label: "Executive Summary", color: "hsl(var(--primary))" },
    { key: "head_face", label: "Head & Face", color: "hsl(var(--chart-1))" },
    { key: "neck", label: "Neck", color: "hsl(var(--chart-1))" },
    { key: "shoulders_upper_back", label: "Shoulders & Upper Back", color: "hsl(var(--chart-2))" },
    { key: "chest", label: "Chest", color: "hsl(var(--chart-2))" },
    { key: "abdomen", label: "Abdomen", color: "hsl(var(--chart-4))" },
    { key: "pelvis_pubic_region", label: "Pelvis / Pubic Region", color: "hsl(var(--chart-4))" },
    { key: "genitals_perineum", label: "Genitals / Perineum", color: "hsl(var(--chart-5))" },
    { key: "buttocks_perianal_region", label: "Buttocks / Perianal Region", color: "hsl(var(--chart-5))" },
    { key: "upper_limbs_hands", label: "Upper Limbs & Hands", color: "hsl(var(--chart-3))" },
    { key: "lower_limbs", label: "Lower Limbs", color: "hsl(var(--chart-3))" },
    { key: "feet_toes", label: "Feet & Toes", color: "hsl(var(--chart-3))" },
    { key: "posture_alignment", label: "Posture & Alignment", color: "hsl(var(--chart-2))" },
    { key: "skin_summary", label: "Skin Summary", color: "hsl(var(--chart-3))" },
    { key: "limitations_future_coverage", label: "Limitations / Useful Future Coverage", color: "hsl(var(--muted-foreground))", required: false },
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
  libraryImageLimit: 60,
  icon: <User className="w-4 h-4" />,
  color: "hsl(var(--chart-2))",
  purpose: "Detailed pelvis, external genital, anal/perianal, glans/meatus/foreskin, scrotal/perineal, tissue-state, physiology, and visible device-fit context review grounded in supplied photos and video clips.",
  helper: "Review saved pelvic/genital visual evidence from Q&A photos/videos, sessions, body exploration, entered measurements, and prior Sarah media reviews. Saved evidence is the default; fresh focused images or videos are optional add-on evidence.",
  emptyText: "Click Review Existing Evidence to synthesize the saved pelvic/genital library: prior reviewed images, reusable frames, body-exploration evidence, sessions, and Profile Q&A as supporting context. Add focused images or videos only when you want to expand the library.",
  reviewInstructions: `
PELVIC / GENITAL REVIEW SCOPE:
- Produce one cumulative pelvic/genital/perineal anatomical profile of Ben. This is not a batch report, image audit, source report, or process note.
- Start with actual pelvic/genital/perineal findings. Do not open with source details, image counts, evidence-scope logistics, batch/source/rechecked-image explanations, or provenance.
- Make the review easy to listen to as downloaded audio: natural anatomical flow, minimal repetition, short paragraphs, and no duplicate callout/prose wording.
- Default mode is observe, not defend or prove. Describe visible anatomy, visible findings, meaningful changes, and tissue/device relationships. Stop there.
- This is a comprehensive focused external pelvic/genital/perineal exam, not a device report, catheter report, novelty detector, or change log.
- Use the appropriate clinical lens for the visible/documented anatomy: urology plus primary care by default, and gynecology-style structure/tissue-health discipline when the person's anatomy makes that relevant. Do not force a sex-specific template that does not match the anatomy.
- Preserve structure-by-structure coverage. Pubic mound/lower abdomen, inguinal folds/groin skin, penis/shaft, foreskin, glans/meatus, scrotum/testes, perineum, anal/perianal region, buttocks/gluteal skin, visible tissue health, device/contact findings, and measurement reconciliation all matter when evidence exists.
- Distinguish stable baseline anatomy from active findings. Baseline includes stable structure, contour, symmetry, hair distribution, pigmentation, scars, and long-term tissue appearance. Active findings include irritation, wound/lesion change, swelling, edema, bruising, catheter/device state, moisture/fluid uncertainty, and interval changes.
- Novel or active findings should be documented thoroughly in their structure-specific section, then not repeatedly reintroduced elsewhere unless a later section adds new clinically meaningful detail.
- Good: "The catheter exits centrally from the meatus." "The glans appears healthy." "The scrotum appears symmetric." Bad: "This remains consistent with the strongly established glans baseline."
- Use all available reviewed evidence cumulatively. Do not write "this batch", "prior batch", "subsequent batch", "rechecked saved/direct views", or image-number narration.
- Treat this like a clinician performing a complete pelvic/genital/perineal exam from the saved visual library. Move structure by structure and state the current findings as you go.
- Do not let a single recent device close-up, Q&A prompt, session note, or batch upload become the whole review. High-detail saved images should support structure-specific findings such as glans, meatus, foreskin, shaft, scrotum/testes, perineum, and perianal skin when those structures are discussed.
- Profile Q&A is supporting context only. Direct saved images, prior media reviews, body-exploration frames, session visuals/videos, and entered clinical/profile data outrank Q&A when forming the clinical overview.
- Device/Foley discipline: mention Foley catheter, tubing, statlock, urethral device contact, or device-fit findings only in the sections where they materially explain visible anatomy or tissue/device relationship. Do not keep returning to Foley as the organizing theme when the section is about penile base, pubic region, shaft, glans, scrotum, perineum, or perianal anatomy.
- Preserve the full established pelvic/genital/perineal picture every run. Fresh focused images, session visuals, and body-exploration visuals are update layers on top of the cumulative baseline, not replacements for it.
- Each anatomical section should state the current anatomical finding, then note what is new or meaningfully changed when relevant. Do not collapse the report into only the newest Foley/device or close-up finding.
- If a region is not freshly visible but has saved evidence, summarize the actual finding briefly only if it adds value. Do not write "not represented in this pass", "stable from prior established baseline", or "baseline carried forward" as section content.
- If a pelvic/genital region has no established evidence anywhere, say "No established baseline yet for this region" once. Do not describe that as a current-pass limitation.
- Do not mention prior corrections, invalidated findings, evidence conflicts, confidence accumulation, or historical mistakes unless Ben explicitly asks for an audit trail.
- Comparison should appear only when it adds value: tissue change, healing, irritation, swelling, device-fit change, lesion/wound evolution, or an explicit comparison request.
- Do not narrate camera locations, room setup, table paper, ECG/chest strap, headphones, foot cameras, or incidental background objects.
- Do not narrate every absent structure, device, or limitation. Mention absence only when it is materially relevant.
- Focus on pubic mound/lower abdomen, inguinal folds/groin skin, penis, foreskin, glans/meatus, scrotum/testes, perineum, anal/perianal region, gluteal skin, visible tissue health, and relevant device/contact findings.
- HARD SCOPE BOUNDARY: this pelvic/genital review must not include foot, ankle, toe, lower-leg, lower-extremity, knee, calf, lower-limb edema, lower-extremity edema, venous, dog-bite, abdominal wound, abdominal bruise, or non-pelvic skin follow-up findings. Those belong only in the head-to-toe review.
- Pubic mound/lower abdomen means the immediate suprapubic/pubic-base region. Do not use right lateral abdominal wound or general abdomen images as pelvic/genital evidence.
- Inguinal folds/groin skin means actual groin, inguinal fold, pubic, inner-thigh, penile-base, or scrotal-base evidence. Never attach feet, ankles, lower legs, or standing foot comparison views to this section.
- For annotated_images and image_region_findings, include only images where pelvic/genital/perineal/anal/pubic/groin anatomy or relevant device contact is actually visible. If an image says no genital/pelvic anatomy is visible, do not create a pelvic/genital callout for it.
- If a saved image contains no relevant pelvic/genital anatomy, ignore it for this review even if it exists in the wider evidence library.
- Include anal/perianal anatomy when visible: pigmentation, anal verge appearance, symmetry, resting closure/gaping/prolapse if visible, external hemorrhoids, fissures, skin tags, ulceration, bleeding, crusting, and relevant hair distribution.
- Do not assess internal hemorrhoids, prostate, bladder neck, internal sphincters, pelvic floor musculature, internal urethral course, or internal rectal structures.
- Do not make feet, lower-leg posture, hand positioning, or stimulation techniques standalone topics in this pelvic/genital artifact. Mention hands, feet, or technique only when they directly affect visibility, scale, occlusion, pelvic positioning, contact mechanics, device fit, or safety interpretation.
- If catheters, urethral sounds, anal devices, rectal stimulation equipment, sleeves, markers, stickers, lubricant, or medical/procedural supplies are visible, describe their visible position, contact zone, fit, and tissue interaction cautiously. Do not invent insertion depth, advancement, discomfort, sensation, or procedure stage unless image evidence or saved context directly supports it.
- Use user-provided upload context to avoid bad assumptions. If context says fresh from shower, sweat, or no lubricant, do not call moisture lubricant. If context says documentation photo, do not infer active stimulation.
- Bright meatal points remain uncertain unless clearly visible: "small bright meatal highlight or possible fluid point; static image cannot confirm secretion."
- Measurements should be reconciled only when meaningful. Use: "Visually compatible with entered measurement, but not independently measurable from this image."
- Organize the review exactly by anatomy:
  1. Executive Summary: 6 to 12 bullets maximum. Describe the whole focused pelvic/genital picture first: regional contour, visible tissue health, structure coverage, major stable anatomy, device/contact state if present, and important active or interval findings.
  2. Pubic Mound & Lower Abdomen: adipose fullness, pubic hair distribution, lower abdominal overhang, inguinal visibility, visible scars or hernia bulges.
  3. Inguinal Folds & Groin Skin: scars, follicular papules/friction irritation, redness, lesions, swelling, fissures if visible.
  4. Penis: resting/flaccid appearance, shaft contour/symmetry, curvature if visible, erect or partial erect state if available, meatus only if visible.
  5. Foreskin: coverage pattern, visually supported retraction, tissue appearance, visible scarring/phimotic banding if present.
  6. Glans & Meatus: glans color/texture, meatal orientation/shape if visible, uncertain bright point wording.
  7. Scrotum & Testes: size/shape, bilateral fullness/symmetry, rugosity/pigmentation, visible swelling/masses/lesions if present.
  8. Perineum: perineal body appearance, skin integrity, neutral surface sheen/moisture language.
  9. Anal Opening & Perianal Region: visible external anal/perianal findings only.
  10. Buttocks / Gluteal Skin: contour, spread, skin lesions, pressure marks, irritation if visible.
  11. Device / Contact Findings: only relevant anatomy/tissue-safety contact findings.
  12. Tissue Health / Safety Observations: concise visible tissue integrity summary.
  13. Measurement Reconciliation: meaningful measurement notes only.
  14. Limitations / Future Useful Coverage: only truly useful missing states/views; do not list views already represented.
- Keep the language anatomical and practical. Do not eroticize the review or write arousal-focused prose.
`,
  sections: [
    { key: "executive_summary", label: "Executive Summary", color: "hsl(var(--primary))" },
    { key: "pubic_mound_lower_abdomen", label: "Pubic Mound & Lower Abdomen", color: "hsl(var(--chart-1))" },
    { key: "inguinal_folds_groin_skin", label: "Inguinal Folds & Groin Skin", color: "hsl(var(--chart-3))" },
    { key: "penis", label: "Penis", color: "hsl(var(--chart-2))" },
    { key: "foreskin", label: "Foreskin", color: "hsl(var(--chart-2))" },
    { key: "glans_meatus", label: "Glans & Meatus", color: "hsl(var(--chart-2))" },
    { key: "scrotum_testes", label: "Scrotum & Testes", color: "hsl(var(--chart-2))" },
    { key: "perineum", label: "Perineum", color: "hsl(var(--chart-4))" },
    { key: "anal_opening_perianal_region", label: "Anal Opening & Perianal Region", color: "hsl(var(--chart-4))" },
    { key: "buttocks_gluteal_skin", label: "Buttocks / Gluteal Skin", color: "hsl(var(--chart-5))" },
    { key: "device_contact_findings", label: "Device / Contact Findings", color: "hsl(var(--chart-1))" },
    { key: "tissue_health_safety_observations", label: "Tissue Health / Safety Observations", color: "hsl(var(--chart-3))" },
    { key: "measurement_reconciliation", label: "Measurement Reconciliation", color: "hsl(var(--chart-5))" },
    { key: "limitations_future_coverage", label: "Limitations / Future Useful Coverage", color: "hsl(var(--muted-foreground))", required: false },
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
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [jobStatus, setJobStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [archive, setArchive] = useState([]);
  const [error, setError] = useState("");
  const [recoverableBatchSet, setRecoverableBatchSet] = useState(null);
  const [latestAttemptStatus, setLatestAttemptStatus] = useState(null);
  const [availableCompletedReviewJob, setAvailableCompletedReviewJob] = useState(null);
  const [selectedProfilerImageId, setSelectedProfilerImageId] = useState(null);
  const [viewingArchiveRunId, setViewingArchiveRunId] = useState("");
  const [anatomyVideo, setAnatomyVideo] = useState(null);
  const [anatomyVideoStatus, setAnatomyVideoStatus] = useState({ type: "", message: "" });
  const [activeAnatomyVideoJobId, setActiveAnatomyVideoJobId] = useState("");
  const [imageUploadStatus, setImageUploadStatus] = useState(null);
  const [videoUploadStatus, setVideoUploadStatus] = useState(null);
  const [includeImageCalloutsInTts, setIncludeImageCalloutsInTts] = useState(() => {
    try {
      return window.localStorage.getItem("pulsepoint_profile_image_tts_callouts_v2") === "true";
    } catch {
      return false;
    }
  });
  const autoRecoveredBatchSetRef = useRef("");
  const anatomyVideoJobStorageKey = `sarah_profiler_anatomy_video_job_${config.kind}`;

  useEffect(() => {
    try {
      window.localStorage.setItem("pulsepoint_profile_image_tts_callouts_v2", includeImageCalloutsInTts ? "true" : "false");
    } catch {
      // Ignore storage failures; the toggle still works for the current render.
    }
  }, [includeImageCalloutsInTts]);

  useEffect(() => {
    const restored = restoreProfilerUploadQueue(config.kind);
    if (!restored.length) return;
    setImages((current) => current.length ? current : restored.slice(0, config.maxImages || PROFILER_UPLOAD_QUEUE_LIMIT));
  }, [config.kind, config.maxImages]);

  useEffect(() => {
    persistProfilerUploadQueue(config.kind, images);
  }, [config.kind, images]);

  useEffect(() => {
    let cancelled = false;
    loadLatestProfileReviewResultField(config.resultKey).then((resultRow) => {
      if (cancelled) return;
      if (resultRow?.[config.resultKey]) {
        const loadedResult = normalizeImageReviewResult(resultRow[config.resultKey], config) || resultRow[config.resultKey];
        setResult(loadedResult);
        if (loadedResult?._meta?.latest_attempt_status) setLatestAttemptStatus(loadedResult._meta.latest_attempt_status);
      }
    }).catch((err) => {
      console.warn(`${config.title} saved result load skipped:`, err);
    });
    loadLatestProfileReviewResultField(config.archiveKey).then((archiveRow) => {
      if (cancelled) return;
      if (Array.isArray(archiveRow?.[config.archiveKey])) {
        setArchive(archiveRow[config.archiveKey].map((entry) => ({
          ...entry,
          result: normalizeImageReviewResult(entry.result, config) || entry.result,
        })));
      }
    }).catch((err) => {
      console.warn(`${config.title} saved result load skipped:`, err);
    });
    return () => {
      cancelled = true;
    };
  }, [config.archiveKey, config.resultKey]);

  useEffect(() => {
    const profileResult = userProfile?.[config.resultKey];
    if (!profileResult) return;
    const loadedResult = normalizeImageReviewResult(profileResult, config) || profileResult;
    if (!loadedResult?.overview) return;
    setResult((current) => current?.overview ? current : loadedResult);
    if (loadedResult?._meta?.latest_attempt_status) setLatestAttemptStatus(loadedResult._meta.latest_attempt_status);
  }, [config.resultKey, userProfile]);

  const jobLabel = `AI Profiler: ${config.title}`;

  const storeCompletedReviewJob = async (completedJob, sourceImages = []) => {
    const parsed = normalizeImageReviewResult(completedJob?.result, config);
    if (!parsed?.overview) throw new Error("Sarah returned an empty image review.");
    const reviewedImages = completedJob?.meta?.reviewed_images
      || completedJob?.payload?.reviewed_images
      || completedJob?.result?._meta?.reviewed_images
      || [];
    const jobFreshImageCount = profilerJobMetaValue(completedJob, "fresh_image_count");
    const jobReusedSavedImageCount = profilerJobMetaValue(completedJob, "reused_saved_image_count");
    const jobImageCount = profilerJobMetaValue(completedJob, "image_count")
      ?? profilerJobMetaValue(completedJob, "full_review_image_count");
    const fallbackStatus = isFinalSynthesisFallbackResult(parsed)
      ? parsed._background_attempt_status || {
        state: "final_synthesis_failed_batch_findings_preserved",
        timestamp: completedAt(completedJob) || new Date().toISOString(),
        batch_reviews_completed: true,
        final_synthesis_attempted: true,
      }
      : null;
    if (fallbackStatus) {
      setLatestAttemptStatus(fallbackStatus);
    }
    const visualEvidence = buildExistingVisualEvidenceDigest({ sessions, bodyExplorations });
    const storedResult = {
      ...parsed,
      _meta: buildImageReviewMetaWithEvidence({
        images: sourceImages,
        sessions,
        previousResult: result,
        currentResult: parsed,
        evidenceCounts: visualEvidence.counts,
        generatedAtOverride: completedAt(completedJob),
        reviewedImageOverride: reviewedImages,
        countOverrides: {
          fresh_image_count: jobFreshImageCount,
          reused_saved_image_count: jobReusedSavedImageCount,
          image_count: jobImageCount,
        },
      }),
    };
    storedResult._meta.reviewType = config.kind;
    storedResult._meta.source_job_id = completedJob?.id || completedJob?.jobId || null;
    storedResult._meta.source_job_completed_at = completedAt(completedJob);
    if (fallbackStatus) {
      storedResult._meta.latest_attempt_status = fallbackStatus;
      storedResult._meta.recovered_from_batches = true;
      storedResult._meta.local_batch_assembled = true;
      storedResult._meta.result_kind = "recovered_batch_draft";
      storedResult._meta.final_synthesis_failed = true;
    }
    if (parsed?._background_attempt_status) {
      storedResult._meta.latest_attempt_status = parsed._background_attempt_status;
      setLatestAttemptStatus(parsed._background_attempt_status);
      if (parsed._background_attempt_status?.batch_reviews_completed && parsed._background_attempt_status?.final_synthesis_attempted !== false) {
        storedResult._meta.recovered_from_batches = true;
        storedResult._meta.local_batch_assembled = true;
        storedResult._meta.result_kind = "recovered_batch_draft";
      }
    }
    if (parsed?._meta?.recovered_from_batches) storedResult._meta.recovered_from_batches = true;
    if (parsed?._meta?.local_batch_assembled) {
      storedResult._meta.local_batch_assembled = true;
      storedResult._meta.result_kind = parsed?._meta?.result_kind || "recovered_batch_draft";
    }
    setResult(storedResult);
    setViewingArchiveRunId("");
    const nextArchive = await saveProfileResultWithArchive({
      resultKey: config.resultKey,
      archiveKey: config.archiveKey,
      kind: config.kind,
      label: config.title,
      result: storedResult,
      sessionCount: sessions.length,
    });
    setArchive(nextArchive);
    if (fallbackStatus) {
      setJobStatus(completedJob);
      setError(`Latest ${config.title.toLowerCase()} completed and is now displayed as recovered batch findings. Final cumulative synthesis timed out, so rerun later when you want the polished synthesis pass.`);
    }
    return storedResult;
  };

  useEffect(() => {
    let cancelled = false;
    if (!userProfile && !result) return undefined;

    const jobTime = (job) => new Date(completedAt(job) || job?.updatedAt || job?.createdAt || 0).getTime() || 0;
    const isMatchingReviewJob = (job) => {
      const label = String(job?.meta?.label || job?.payload?.label || job?.result?._meta?.label || "");
      const reviewType = profilerJobReviewType(job);
      const reviewTitle = String(job?.meta?.reviewTitle || job?.payload?.reviewTitle || "").toLowerCase();
      return reviewType === config.kind ||
        reviewTitle === config.title.toLowerCase() ||
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
      return profilerJobReviewType(job) === config.kind || job?.meta?.label === jobLabel || job?.payload?.label === jobLabel;
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
      setError(`Latest ${config.title.toLowerCase()} review has ${done}/${total} completed batches available. Sarah will auto-assemble the completed batch set once all batches are finished; leave the desktop backend running and reopen this page to recover progress.`);
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
    const findCheckpointBatchSet = (jobs = []) => {
      const candidates = (jobs || [])
        .filter(isMatchingReviewJob)
        .filter((job) => Array.isArray(job?.progress?.completed_batch_results))
        .filter((job) => job.progress.completed_batch_results.length > 0)
        .sort(newestFirst);
      const job = candidates[0];
      if (!job) return null;
      const completedResults = job.progress.completed_batch_results.filter(Boolean);
      const completed = completedResults.length;
      const expectedTotal = Number(job.progress?.batch_total || job.meta?.batch_count || completed || 0);
      const reviewedImages = Array.isArray(job?.meta?.reviewed_images) ? job.meta.reviewed_images : [];
      return {
        total: completed,
        expectedTotal: expectedTotal || completed,
        partial: expectedTotal > completed,
        batches: completedResults.map((result, index) => ({
          id: `${job.id || "checkpoint"}:batch-${index + 1}`,
          status: "complete",
          result,
          meta: {
            ...(job.meta || {}),
            batch: index + 1,
            batch_count: expectedTotal || completed,
            reviewed_images: reviewedImages,
          },
          createdAt: job.startedAt || job.createdAt,
          updatedAt: job.updatedAt,
          finishedAt: job.updatedAt,
        })),
        reviewed_images: reviewedImages,
        fresh_image_count: Number(job.meta?.fresh_image_count || 0),
        reused_saved_image_count: Number(job.meta?.reused_saved_image_count || 0),
        image_count: Number(job.meta?.full_review_image_count || job.meta?.image_count || reviewedImages.length || 0),
        startedAt: job.startedAt || job.createdAt,
        finishedAt: job.updatedAt || job.finishedAt,
        latestFailedFinal: job,
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
          limit: 100,
        });
        if (cancelled) return;
        const completedJobs = [
          ...(completedFullData.jobs || []),
          ...(completedAiData.jobs || []),
        ];
        const completedJobsWithResults = await Promise.all(completedJobs.map((job) => (
          isMatchingReviewJob(job) ? loadFullBackgroundJob(job) : job
        )));
        if (cancelled) return;
        const recoverable = findRecoverableBatchSet(completedJobsWithResults);
        setRecoverableBatchSet(recoverable);
        if (
          recoverable?.batches?.length &&
          isNewerCompletedJob(recoverable.batches[recoverable.batches.length - 1], result) &&
          autoRecoveredBatchSetRef.current !== `${config.kind}:${recoverable.startedAt || ""}:${recoverable.finishedAt || ""}`
        ) {
          autoRecoveredBatchSetRef.current = `${config.kind}:${recoverable.startedAt || ""}:${recoverable.finishedAt || ""}`;
          setLatestAttemptStatus({
            state: "batch_reviews_recoverable_after_reconnect",
            timestamp: new Date().toISOString(),
            synthesis_stage: "waiting_for_final_synthesis",
            batch_reviews_completed: true,
            older_saved_review_showing: Boolean(result),
            latest_batch_findings_available: true,
            batch_count: recoverable.total || recoverable.batches.length,
            final_synthesis_attempted: false,
          });
        }
        const job = completedJobsWithResults
          .filter(isFinalOrSingleReviewJob)
          .sort(newestFirst)[0];
        if (!job || (result && !isNewerCompletedJob(job, result))) {
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
            limit: 100,
          });
          if (cancelled) return;
          const failedFinal = [
            ...(failedFullData.jobs || []),
            ...(failedAiData.jobs || []),
          ]
            .filter(isFailedFinalReviewJob)
            .sort(newestFirst)[0];
          const checkpointRecoverable = findCheckpointBatchSet([
            ...(failedFullData.jobs || []),
            ...(failedAiData.jobs || []),
          ]);
          const activeRecoverable = recoverable || checkpointRecoverable;
          if (failedFinal && isNewerCompletedJob({ ...failedFinal, status: "complete" }, result)) {
            const failedStatus = finalSynthesisFailureStatus(failedFinal, activeRecoverable);
            setJobStatus(failedFinal);
            setRecoverableBatchSet(activeRecoverable);
            setLatestAttemptStatus(failedStatus);
            setError(activeRecoverable?.batches?.length
              ? `Latest ${config.title.toLowerCase()} review stopped, but ${activeRecoverable.batches.length}/${activeRecoverable.expectedTotal || activeRecoverable.total} completed batch findings are preserved. Press Show Latest Findings to display them.`
              : `Latest ${config.title.toLowerCase()} review stopped: ${aiErrorMessage({
                message: failedFinal.error || failedFinal.progress?.message || failedFinal.status,
                data: { error: failedFinal.error || failedFinal.progress?.message },
              })}`);
            return;
          }
          describeIncompleteBatchedReview(completedJobsWithResults);
          return;
        }

        if (job && (!result || isNewerCompletedJob(job, result))) {
          if (viewingArchiveRunId) {
            setAvailableCompletedReviewJob(await loadFullBackgroundJob(job));
            setError("Viewing an archived profiler run. A newer completed review is available, but Sarah will not switch away until you ask.");
            return;
          }
          if (job.type === "profile_image_review_full" || job?.meta?.full_background_review) {
            setJobStatus(job);
            const fullJob = await loadFullBackgroundJob(job);
            await storeCompletedReviewJob(fullJob, []);
            setAvailableCompletedReviewJob(null);
            setRecoverableBatchSet(null);
            setLatestAttemptStatus(fullJob.result?._background_attempt_status || null);
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
          const fullJob = await loadFullBackgroundJob(job);
          await storeCompletedReviewJob(fullJob, []);
          setRecoverableBatchSet(null);
          setLatestAttemptStatus(null);
          setAvailableCompletedReviewJob(null);
          setError("");
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
  }, [config.kind, config.title, evidenceLoading, jobLabel, profileLoading, result, sessions.length, userProfile, viewingArchiveRunId]);

  useEffect(() => {
    let cancelled = false;
    const sourceGeneratedAt = result?._meta?.last_generated_at || result?._meta?.updated_at || "";
    if (!sourceGeneratedAt) return undefined;

    const reconnectProfileVideo = async () => {
      try {
        if (!anatomyVideo?.file_url && !activeAnatomyVideoJobId) {
          setAnatomyVideoStatus({
            type: "checking",
            message: "Checking saved background renders for this Profiler review...",
          });
        }
        let storedJobId = "";
        try {
          storedJobId = window.localStorage.getItem(anatomyVideoJobStorageKey) || "";
        } catch {
          storedJobId = "";
        }
        const jobs = await listBackgroundJobs({
          type: "profile_anatomy_video",
          status: "queued,running,complete",
          metaSource: "Profiler",
          limit: 50,
        });
        if (cancelled) return;
        const sortedReviewJobs = (jobs.jobs || [])
          .filter((job) => profilerJobReviewType(job) === config.kind)
          .sort((a, b) => String(b.finishedAt || b.updatedAt || b.createdAt || "").localeCompare(String(a.finishedAt || a.updatedAt || a.createdAt || "")));
        const matching = sortedReviewJobs.find((job) => storedJobId && job.id === storedJobId)
          || sortedReviewJobs.find((job) => (
          String(job?.meta?.sourceGeneratedAt || job?.payload?.sourceGeneratedAt || "") === String(sourceGeneratedAt)
        )) || sortedReviewJobs.find((job) => job.status === "complete" && anatomyVideoFromJob(job)?.file_url) || sortedReviewJobs[0];
        if (!matching) {
          setAnatomyVideoStatus({
            type: "idle",
            message: "No saved anatomy video is linked to this review yet. Use Build anatomy video to start one; once the desktop backend accepts it, you can leave this page.",
          });
          return;
        }
        const fullMatching = matching.hasResult && !matching.result ? await getBackgroundJob(matching.id) : matching;
        if (cancelled) return;
        const videoResult = anatomyVideoFromJob(fullMatching);
        if (fullMatching.status === "complete" && videoResult?.file_url) {
          setActiveAnatomyVideoJobId("");
          try {
            if (storedJobId === fullMatching.id) window.localStorage.removeItem(anatomyVideoJobStorageKey);
          } catch {
            // Ignore storage cleanup failures.
          }
          const exactSourceMatch = String(fullMatching?.meta?.sourceGeneratedAt || fullMatching?.payload?.sourceGeneratedAt || "") === String(sourceGeneratedAt);
          setAnatomyVideo(videoResult);
          setAnatomyVideoStatus({
            type: "ok",
            message: exactSourceMatch
              ? "Anatomy video ready. The player below is the completed MP4."
              : "Latest saved anatomy video ready. This may have been rendered from a previous version of the review text.",
          });
        } else if (fullMatching.status === "queued" || fullMatching.status === "running") {
          setActiveAnatomyVideoJobId(fullMatching.id);
          setAnatomyVideoStatus({
            type: "working",
            message: fullMatching.progress?.message || "Queued on the desktop backend. You can background the app; Sarah will keep rendering.",
          });
        } else if (fullMatching.status === "complete") {
          setAnatomyVideoStatus({
            type: "idle",
            message: "The latest anatomy video job is marked complete, but no MP4 output is attached to it. Open Settings & Status to inspect the completed job.",
          });
        }
      } catch (err) {
        if (!cancelled) console.warn("Profile anatomy video reconnect skipped:", err);
      }
    };

    reconnectProfileVideo();
    const interval = window.setInterval(reconnectProfileVideo, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeAnatomyVideoJobId, anatomyVideo?.file_url, anatomyVideoJobStorageKey, config.kind, result?._meta?.last_generated_at, result?._meta?.updated_at]);

  const handleImageFiles = async (event) => {
    const files = Array.from(event.target.files || []).filter((file) => file.type?.startsWith("image/"));
    event.target.value = "";
    if (!files.length) return;
    setError("");
    setAvailableCompletedReviewJob(null);
    setRecoverableBatchSet(null);
    setLatestAttemptStatus(null);
    try {
      const maxImages = config.maxImages || 8;
      const selectedFiles = files.slice(0, maxImages);
      const pending = selectedFiles.map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}`,
        filename: file.name,
        file,
        media_type: file.type || "image/jpeg",
        previewUrl: URL.createObjectURL(file),
        upload_note: "",
        size: file.size,
        lastModified: file.lastModified,
        source: "fresh_upload",
        upload_status: "saving",
      }));
      setImages((current) => [...current, ...pending].slice(0, maxImages));
      setImageUploadStatus({
        current: 0,
        total: pending.length,
        message: `Saving ${pending.length} selected image${pending.length === 1 ? "" : "s"} for Head-to-Toe review...`,
      });

      for (let index = 0; index < pending.length; index += 1) {
        const pendingImage = pending[index];
        try {
          setImageUploadStatus({
            current: index + 1,
            total: pending.length,
            message: `Saving image ${index + 1}/${pending.length}...`,
          });
          const loaded = await imageFileToPayload(pendingImage.file);
          const saved = await withTimeout(
            prepareFreshImageForReview({ ...pendingImage, ...loaded, upload_status: "saving" }, index, {
              total: pending.length,
              onProgress: setJobStatus,
            }),
            PROFILER_IMAGE_SAVE_TIMEOUT_MS,
            `Image ${index + 1} did not finish saving within ${Math.round(PROFILER_IMAGE_SAVE_TIMEOUT_MS / 1000)} seconds. Remove it and try that photo again.`,
          );
          setImages((current) => current.map((image) => (
            image.id === pendingImage.id ? { ...saved, id: pendingImage.id, upload_status: "saved" } : image
          )).slice(0, maxImages));
        } catch (imageError) {
          setImages((current) => current.map((image) => (
            image.id === pendingImage.id
              ? { ...image, upload_status: "error", upload_error: imageError?.message || "Could not save image." }
              : image
          )));
        }
      }
      setImageUploadStatus({
        current: pending.length,
        total: pending.length,
        message: `Finished image save pass. Saved images are safe to use; any Error badges need reselecting.`,
      });
      if (files.length > maxImages) {
        setError(`Using the first ${maxImages} images for this review. Remove a few and add others if you want to swap coverage.`);
      }
    } catch (err) {
      setError(err?.message || "Could not read one of the selected images.");
    } finally {
      window.setTimeout(() => setImageUploadStatus(null), 3500);
    }
  };

  const handleVideoFiles = async (event) => {
    const files = Array.from(event.target.files || []).filter((file) => file.type?.startsWith("video/"));
    event.target.value = "";
    if (!files.length) return;
    setError("");
    setAvailableCompletedReviewJob(null);
    setRecoverableBatchSet(null);
    setLatestAttemptStatus(null);

    const maxImages = config.maxImages || 8;
    let remainingFrameSlots = Math.max(0, maxImages - images.length);
    if (remainingFrameSlots <= 0) {
      setError(`This review already has ${maxImages} selected review frames/images. Remove a few before adding video evidence.`);
      return;
    }

    const selectedFiles = files.slice(0, PROFILER_VIDEO_UPLOAD_LIMIT);
    const pendingVideos = selectedFiles.map((file) => {
      const id = `video-${file.name}-${file.size}-${file.lastModified}`;
      return {
        id,
        filename: file.name,
        file,
        media_type: file.type || "video/mp4",
        previewUrl: URL.createObjectURL(file),
        upload_note: "",
        size: file.size,
        lastModified: file.lastModified,
        source: "fresh_video_upload",
        upload_status: "saving",
        storagePath: "",
        sampledFrameCount: 0,
      };
    });
    setVideos((current) => [...current, ...pendingVideos].slice(0, PROFILER_VIDEO_UPLOAD_LIMIT));
    setVideoUploadStatus({
      current: 0,
      total: pendingVideos.length,
      message: `Saving and sampling ${pendingVideos.length} selected video${pendingVideos.length === 1 ? "" : "s"}...`,
    });

    for (let index = 0; index < pendingVideos.length; index += 1) {
      const pendingVideo = pendingVideos[index];
      try {
        setVideoUploadStatus({
          current: index + 1,
          total: pendingVideos.length,
          message: `Uploading video ${index + 1}/${pendingVideos.length}...`,
        });
        const upload = await withTimeout(
          base44.integrations.Core.UploadFile({ file: pendingVideo.file }),
          PROFILER_VIDEO_SAVE_TIMEOUT_MS,
          `Video ${index + 1} did not finish saving within ${Math.round(PROFILER_VIDEO_SAVE_TIMEOUT_MS / 1000)} seconds.`,
        );
        const storagePath = upload?.file_url || upload?.url || "";
        if (!storagePath) throw new Error(`Could not save ${pendingVideo.filename || `video ${index + 1}`}.`);

        const maxFrames = Math.min(PROFILER_VIDEO_SAMPLE_COUNT, remainingFrameSlots);
        if (maxFrames <= 0) {
          setVideos((current) => current.map((video) => (
            video.id === pendingVideo.id
              ? { ...video, storagePath, url: storagePath, upload_status: "saved", sampledFrameCount: 0, upload_error: "Video saved, but no review-frame slots were available." }
              : video
          )));
          continue;
        }

        setVideoUploadStatus({
          current: index + 1,
          total: pendingVideos.length,
          message: `Sampling video ${index + 1}/${pendingVideos.length} into review frames...`,
        });
        const frames = await sampleProfilerVideoFrames({
          file: pendingVideo.file,
          label: pendingVideo.filename,
          maxFrames,
        });

        const savedFrames = [];
        for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
          const frame = frames[frameIndex];
          const frameImage = {
            id: `${pendingVideo.id}-frame-${frame.frameIndex}`,
            filename: frame.filename,
            file: frame.file,
            media_type: "image/jpeg",
            data: stripDataUrl(frame.dataUrl),
            previewUrl: frame.dataUrl,
            upload_note: `Sampled frame ${frame.frameIndex}/${frame.frameCount} from uploaded video evidence at ${formatVideoTimestamp(frame.time)}.${pendingVideo.upload_note ? ` ${pendingVideo.upload_note}` : ""}`,
            size: frame.file.size,
            lastModified: pendingVideo.lastModified,
            source: "fresh_video_frame",
            upload_status: "saving",
            sourceVideo: {
              videoId: pendingVideo.id,
              storagePath,
              frameIndex: frame.frameIndex,
              frameCount: frame.frameCount,
              frameTimeSeconds: Number(frame.time.toFixed(2)),
              durationSeconds: Number(frame.duration.toFixed(2)),
              purpose: config.title,
              note: pendingVideo.upload_note || "",
            },
          };
          const saved = await prepareFreshImageForReview(frameImage, frameIndex, {
            total: frames.length,
            onProgress: setJobStatus,
          });
          savedFrames.push({ ...saved, id: frameImage.id, upload_status: "saved" });
        }

        remainingFrameSlots = Math.max(0, remainingFrameSlots - savedFrames.length);
        setImages((current) => [...current, ...savedFrames].slice(0, maxImages));
        setVideos((current) => current.map((video) => (
          video.id === pendingVideo.id
            ? {
                ...video,
                storagePath,
                url: storagePath,
                previewUrl: serverUrl(storagePath) || video.previewUrl,
                upload_status: "saved",
                sampledFrameCount: savedFrames.length,
                durationSeconds: savedFrames[0]?.sourceVideo?.durationSeconds || null,
              }
            : video
        )));
      } catch (videoError) {
        setVideos((current) => current.map((video) => (
          video.id === pendingVideo.id
            ? { ...video, upload_status: "error", upload_error: videoError?.message || "Could not save or sample video." }
            : video
        )));
      }
    }

    setVideoUploadStatus({
      current: pendingVideos.length,
      total: pendingVideos.length,
      message: `Finished video save/sampling pass. Saved videos are previewable; sampled frames are ready for Sarah.`,
    });
    if (files.length > PROFILER_VIDEO_UPLOAD_LIMIT) {
      setError(`Using the first ${PROFILER_VIDEO_UPLOAD_LIMIT} videos. Add the rest after this pass if needed.`);
    }
    window.setTimeout(() => setVideoUploadStatus(null), 4500);
  };

  const removeImage = (id) => {
    setImages((current) => current.filter((image) => image.id !== id));
  };

  const removeVideo = (id) => {
    setVideos((current) => {
      const target = current.find((video) => video.id === id);
      if (target?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(target.previewUrl);
      return current.filter((video) => video.id !== id);
    });
    setImages((current) => current.filter((image) => image.sourceVideo?.videoId !== id));
  };

  const updateImageNote = (id, upload_note) => {
    setImages((current) => current.map((image) => (
      image.id === id ? { ...image, upload_note } : image
    )));
  };

  const updateVideoNote = (id, upload_note) => {
    const note = String(upload_note || "");
    setVideos((current) => current.map((video) => (
      video.id === id ? { ...video, upload_note: note } : video
    )));
    setImages((current) => current.map((image) => {
      if (image.sourceVideo?.videoId !== id) return image;
      return {
        ...image,
        upload_note: `Sampled frame ${image.sourceVideo.frameIndex || "?"}/${image.sourceVideo.frameCount || "?"} from uploaded video evidence${image.sourceVideo.frameTimeSeconds != null ? ` at ${formatVideoTimestamp(image.sourceVideo.frameTimeSeconds)}` : ""}.${note ? ` ${note}` : ""}`,
        sourceVideo: {
          ...image.sourceVideo,
          note,
        },
      };
    }));
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
    const removedEvidenceKey = inferAnatomicalEvidenceKey([
      finding.section_key,
      finding.region,
      finding.label,
      finding.finding,
    ].filter(Boolean).join(" "));
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
        anatomical_evidence_records: removedEvidenceKey
          ? (Array.isArray(result._meta?.anatomical_evidence_records) ? result._meta.anatomical_evidence_records : [])
            .filter((item) => item?.key !== removedEvidenceKey)
          : result._meta?.anatomical_evidence_records,
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
      _meta: buildImageReviewMetaWithEvidence({
        images: [],
        sessions,
        previousResult: result,
        currentResult: assembled,
        evidenceCounts: visualEvidence.counts,
        generatedAtOverride: new Date().toISOString(),
        reviewedImageOverride: batchSet?.reviewed_images || [],
        countOverrides: {
          fresh_image_count: batchSet?.fresh_image_count || 0,
          reused_saved_image_count: batchSet?.reused_saved_image_count || 0,
          image_count: batchSet?.image_count || batchSet?.reviewed_images?.length || 0,
        },
      }),
    };
    storedResult._meta.recovered_from_batches = true;
    storedResult._meta.local_batch_assembled = true;
    storedResult._meta.result_kind = "recovered_batch_draft";
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
    setViewingArchiveRunId("");
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
      setError(note || "Final synthesis timed out, so Sarah assembled and saved the completed Sarah batch reviews locally.");
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
          normalizeImageReviewResult(job?.result, config),
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
  const hasCachedOrRecoverableReview = Boolean(result || availableCompletedReviewJob || hasRecoverableUnshownBatchSet || hasRecoverableDisplayRepair);
  const primaryReviewNeedsFreshContext = !result && !availableCompletedReviewJob && !hasRecoverableUnshownBatchSet && !hasRecoverableDisplayRepair;
  const activeReviewJob = ["queued", "running", "starting"].includes(jobStatus?.status);
  const freshReviewPending = Boolean(result && (loading || activeReviewJob || availableCompletedReviewJob) && !viewingArchiveRunId);
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
    if (hasRecoverableUnshownBatchSet || hasRecoverableDisplayRepair) return recoverFinalSynthesis();
    if (images.length > 0) return analyze();
    return analyze();
  };

  const recoverFinalSynthesis = async () => {
    if (!recoverableBatchSet?.batches?.length) {
      setError("No complete batch set is available to recover yet.");
      return;
    }
    if (recoverableBatchSet.partial) {
      setLoading(true);
      setError("");
      try {
        const batchParsedResults = recoverableBatchSet.batches
          .map((job) => remapBatchLocalImageIds(
            normalizeImageReviewResult(job?.result, config),
            job?.meta?.reviewed_images || [],
          ))
          .filter((item) => item?.overview);
        await saveBatchAssembledReview(
          batchParsedResults,
          `Saved a partial recovered review from ${batchParsedResults.length}/${recoverableBatchSet.expectedTotal || recoverableBatchSet.total} completed Sarah batches. Add credits and rerun when you want the full review.`,
          recoverableBatchSet,
          {
            state: "partial_batch_findings_saved",
            timestamp: new Date().toISOString(),
            synthesis_stage: "local_partial_batch_assembly",
            batch_reviews_completed: false,
            older_saved_review_showing: false,
            latest_batch_findings_available: true,
            batch_count: batchParsedResults.length,
            expected_batch_count: recoverableBatchSet.expectedTotal || recoverableBatchSet.total,
            final_synthesis_required: true,
          },
        );
      } catch (err) {
        console.error(`${config.title} partial recovery failed:`, err);
        setError(aiErrorMessage(err));
      } finally {
        setLoading(false);
      }
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
          normalizeImageReviewResult(job?.result, config),
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
      const cumulativeBaselineContext = formatCumulativeBaselineReviewForPrompt(
        selectCumulativeBaselineResult({ result, archive, userProfile: reviewUserProfile, config }),
        config,
      );
      const canonicalAnatomyPacket = formatCanonicalAnatomyPacketForPrompt({ result, archive, userProfile: reviewUserProfile, config });
      const establishedEvidenceContext = formatIncrementalEvidenceRecordsForPrompt(
        aggregateCumulativeAnatomyEvidence({ result, archive, userProfile: reviewUserProfile, config }),
        { limit: 48 },
      );
      const firstNameToneCue = buildOptionalFirstNameToneCue(reviewUserProfile, { prioritizeProfileTone: true });
      const anatomicalFocusRule = isHeadToToeBodyReference ? "" : ANATOMICAL_REFERENCE_FOCUS_RULE;
      const sessionGroundingRule = isHeadToToeBodyReference ? "" : SESSION_CONTEXT_GROUNDING_RULE;
      const responseSchema = profileImageReviewResponseSchema(config);
      const raw = await runProfilerAIJob({
        model: "claude_sonnet_4_6",
        max_tokens: PROFILE_IMAGE_REVIEW_MAX_TOKENS,
        attempts: 3,
        prompt: `You are Sarah, recovering the final Sarah profile image review from completed image-review batch JSON.

Review type: ${config.title}
Review purpose: ${config.purpose}
Recovery source: ${recoverableBatchSet.total} completed image-review batches from the previous run.
Directly rechecked image subset across recovered batches: ${recoverableBatchSet.image_count || recoverableBatchSet.reviewed_images?.length || "unknown"}.

No fresh images are attached to this recovery pass because the direct visual re-check already succeeded in the batch passes. Treat the recovered batch JSON below as directly reviewed visual evidence, then integrate it with saved profile/session context. Produce ONE final cumulative user-facing review, not a batch-by-batch report and not a review limited to the image subset.

${groundingContext}
${imageReviewContext}
${canonicalAnatomyPacket}
${cumulativeBaselineContext}
${anatomicalFocusRule}
${SARAH_APP_OVERLAY_TELEMETRY_RULE}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${sessionGroundingRule}
${PROFILE_OBSERVATION_PRODUCT_RULE}
${PROFILE_IMAGE_REVIEW_RULE_BUNDLE}
${establishedEvidenceContext}

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
        normalizeImageReviewResult(typeof raw === "string" ? JSON.parse(raw) : raw, config),
        batchParsedResults,
      );
      if (!parsed?.overview) throw new Error("Sarah returned an empty recovered image review.");
      const storedResult = {
        ...parsed,
        _meta: buildImageReviewMetaWithEvidence({
          images: [],
          sessions,
          previousResult: result,
          currentResult: parsed,
          evidenceCounts: visualEvidence.counts,
          reviewedImageOverride: recoverableBatchSet.reviewed_images || [],
          countOverrides: {
            fresh_image_count: recoverableBatchSet.fresh_image_count || 0,
            reused_saved_image_count: recoverableBatchSet.reused_saved_image_count || 0,
            image_count: recoverableBatchSet.image_count || recoverableBatchSet.reviewed_images?.length || 0,
          },
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
          await saveBatchAssembledReview(batchParsedResults, "Final Sarah synthesis timed out again, so Sarah assembled and saved the completed Sarah batch reviews locally.");
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
    setViewingArchiveRunId("");
    setError("");
    setAvailableCompletedReviewJob(null);
    setLatestAttemptStatus(null);
    setJobStatus({
      status: "starting",
      progress: {
        phase: "preparing",
        current: 0,
        total: 3,
        message: `Preparing ${config.shortTitle} review locally. Keep this screen open until Sarah says it is queued on the desktop backend.`,
      },
    });
    let batchParsedResults = [];
    let activeBatchSet = null;
    try {
      const reviewUserProfile = (await refreshUserProfile?.().catch(() => null)) || userProfile;
      const isHeadToToeBodyReference = config.contextScope === "head_to_toe_body_reference";
      const visualEvidence = buildExistingVisualEvidenceDigest({ sessions, bodyExplorations });
      const freshReviewImageLimit = config.maxImages || 5;
      const maxReviewImages = Math.max(freshReviewImageLimit, config.libraryImageLimit || freshReviewImageLimit);
      const savedReviewCandidateLimit = Math.max(maxReviewImages * 2, 120);
      const savedProfileContexts = collectSavedProfileImageAttachmentContexts(reviewUserProfile);
      const savedProfileQaAttachments = collectSavedProfileImageAttachments(reviewUserProfile, {
        limit: savedReviewCandidateLimit,
        purpose: isHeadToToeBodyReference ? "head_to_toe_body_reference" : "pelvic_genital",
      });
      const savedProfileReviewAttachments = collectSavedProfileReviewImageAttachments({
        result,
        archive,
        userProfile: reviewUserProfile,
        config,
        limit: savedReviewCandidateLimit,
        purpose: isHeadToToeBodyReference ? "head_to_toe_body_reference" : "pelvic_genital",
        savedProfileContexts,
      });
      const bodyExplorationFrameAttachments = collectBodyExplorationFrameAttachments(bodyExplorations, {
        limit: savedReviewCandidateLimit,
        purpose: isHeadToToeBodyReference ? "head_to_toe_body_reference" : "pelvic_genital",
      });
      const allSavedAttachments = mergeSavedReviewImageCandidates([
        savedProfileReviewAttachments,
        bodyExplorationFrameAttachments,
        savedProfileQaAttachments,
      ], savedReviewCandidateLimit);
      const freshLimit = images.length > 0
        ? Math.min(maxReviewImages, Math.max(freshReviewImageLimit, images.length))
        : 0;
      const freshSourceImages = images
        .filter((image) => image.media_type && (image.data || image.file || image.storagePath || image.url))
        .slice(0, freshLimit || maxReviewImages);
      const freshImagePayload = [];
      const skippedImageMessages = [];
      for (let imageIndex = 0; imageIndex < freshSourceImages.length; imageIndex += 1) {
        try {
          const prepared = await withTimeout(
            prepareFreshImageForReview(freshSourceImages[imageIndex], imageIndex, {
              total: freshSourceImages.length,
              onProgress: setJobStatus,
            }),
            PROFILER_IMAGE_SAVE_TIMEOUT_MS,
            `Reference image ${imageIndex + 1} did not finish preparing within ${Math.round(PROFILER_IMAGE_SAVE_TIMEOUT_MS / 1000)} seconds.`,
          );
          freshImagePayload.push(prepared);
        } catch (freshImageError) {
          skippedImageMessages.push(`Image ${imageIndex + 1}: ${freshImageError?.message || "Could not prepare image."}`);
        }
      }
      let reusedSavedImages = [];
      let savedImageLoadWarning = "";
      const savedImageSlots = Math.max(0, maxReviewImages - freshImagePayload.length);
      if (savedImageSlots > 0) {
        const savedAttachments = selectSavedAttachmentsForReview(
          allSavedAttachments,
          savedImageSlots,
          isHeadToToeBodyReference ? "head_to_toe_body_reference" : "pelvic_genital",
        );
        reusedSavedImages = savedAttachments
          .map((attachment, savedIndex) => {
            try {
              return savedAttachmentToImageRef(attachment, savedIndex);
            } catch (savedImageError) {
              savedImageLoadWarning = savedImageError?.message || "Some saved Profile Q&A images could not be queued for backend reload.";
              return null;
            }
          })
          .filter(Boolean)
          .slice(0, savedImageSlots);
      }
      if (!freshImagePayload.length && !reusedSavedImages.length && skippedImageMessages.length) {
        throw new Error(`No images could be prepared for review. ${skippedImageMessages[0]}`);
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
      const imagePreparationWarning = [
        skippedImageMessages.length ? `${skippedImageMessages.length} selected image${skippedImageMessages.length === 1 ? "" : "s"} could not be prepared and were skipped.` : "",
        savedImageLoadWarning,
      ].filter(Boolean).join(" ");
      const groundingContext = isHeadToToeBodyReference ? "" : buildAIGroundingContext(reviewUserProfile);
      const imageReviewContext = isHeadToToeBodyReference
        ? buildHeadToToeImageReviewContext({ userProfile: reviewUserProfile, sessions, bodyExplorations, hasFreshImages, hasReusedSavedImages })
        : buildProfileImageReviewContext({ userProfile: reviewUserProfile, sessions, bodyExplorations });
      const cumulativeBaselineContext = formatCumulativeBaselineReviewForPrompt(
        selectCumulativeBaselineResult({ result, archive, userProfile: reviewUserProfile, config }),
        config,
      );
      const canonicalAnatomyPacket = formatCanonicalAnatomyPacketForPrompt({ result, archive, userProfile: reviewUserProfile, config });
      const establishedEvidenceContext = formatIncrementalEvidenceRecordsForPrompt(
        aggregateCumulativeAnatomyEvidence({ result, archive, userProfile: reviewUserProfile, config }),
        { limit: 48 },
      );
      const firstNameToneCue = buildOptionalFirstNameToneCue(reviewUserProfile, { prioritizeProfileTone: true });
      const anatomicalFocusRule = isHeadToToeBodyReference ? "" : ANATOMICAL_REFERENCE_FOCUS_RULE;
      const sessionGroundingRule = isHeadToToeBodyReference ? "" : SESSION_CONTEXT_GROUNDING_RULE;
      const imagePresenceRules = hasImagePayload
        ? hasFreshImages && hasReusedSavedImages
          ? `COMBINED IMAGE REVIEW DIRECTIVE - HIGHEST PRIORITY:
- ${freshImagePayload.length} fresh image${freshImagePayload.length === 1 ? " is" : "s are"} attached as new direct visual evidence.
- ${reusedSavedImages.length} saved profile/media evidence image${reusedSavedImages.length === 1 ? " has" : "s have"} also been reloaded and attached as direct saved visual evidence from ${allSavedAttachments.length} saved library candidate${allSavedAttachments.length === 1 ? "" : "s"}. These may include prior profile-review images, body-exploration sampled frames, or saved Profile Q&A images.
- Review the attached image set as a representative direct visibility layer against the full saved library and canonical anatomy packet. Fresh images enhance and update the existing profile; they do not replace the saved baseline or define the report scope.
- Do not say prior photos are unavailable, that direct re-examination is not occurring, or that the review is based only on the newest images.
- Reconcile fresh images, reused saved images, prior Sarah visual reviews, session/body-exploration evidence, saved Profile Q&A findings, and entered measurements into one coherent whole-picture clinical analysis. Treat Profile Q&A as supporting context, not the organizing focus.`
          : hasReusedSavedImages
            ? `SAVED IMAGE REUSE DIRECTIVE - HIGHEST PRIORITY:
- ${imagePayload.length} saved profile/media evidence image${imagePayload.length === 1 ? " has" : "s have"} been reloaded and attached to this request from ${allSavedAttachments.length} saved library candidate${allSavedAttachments.length === 1 ? "" : "s"}.
- Review these saved images directly as reused profile evidence. They are not new uploads, but they are available to inspect in this run. They may include prior profile-review images, body-exploration sampled frames, or saved Profile Q&A images.
- Do not say the prior photos are unavailable or that direct image review is not occurring.
- Reconcile these saved images with prior Sarah visual reviews, session/body-exploration evidence, saved Profile Q&A findings, and entered measurements. Treat Profile Q&A as supporting context, not the organizing focus.`
            : `FRESH IMAGE DIRECTIVE - HIGHEST PRIORITY:
- ${imagePayload.length} fresh image${imagePayload.length === 1 ? " is" : "s are"} attached to this request and included in the model message.
- Review those attached image${imagePayload.length === 1 ? "" : "s"} directly as new direct visual evidence, but use them only to update the canonical anatomy packet. Do not let them replace the saved baseline or define the report scope.
- Do not say "no fresh images are attached", "no fresh images are available", or "direct re-examination is not occurring."
- Existing saved evidence remains active evidence. Treat fresh uploads as additive evidence that can refine, extend, or correct the existing profile, not as a standalone replacement review.`
        : `SAVED EVIDENCE DIRECTIVE:
- No fresh or reusable saved image payload is attached to this request.
- Use previously reviewed saved media reviews, session/body-exploration visual findings, entered metrics, saved media digests, and saved Profile Q&A findings as the evidence base.
- Treat Profile Q&A as secondary context. Do not let it become the whole clinical review when saved images/videos/reviewed media provide stronger visual evidence.
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
          images: batchImages.filter((image) => image.data).map((image) => ({
            filename: `${image.image_id || "profile_reference"}.jpg`,
            media_type: image.media_type,
            data: image.data,
          })),
          imageRefs: batchImages.filter((image) => !image.data).map((image) => ({
            image_id: image.image_id,
            filename: `${image.image_id || "profile_reference"}.jpg`,
            media_type: image.media_type,
            url: image.url || image.storagePath || image.file_url || image.preview_url || "",
            file_url: image.file_url || image.url || image.storagePath || image.preview_url || "",
            preview_url: image.preview_url || image.url || image.storagePath || image.file_url || "",
            storagePath: image.storagePath || image.url || image.file_url || image.preview_url || "",
          })),
          prompt: `You are Sarah, performing one batch of a larger Sarah profile image review.

Review type: ${config.title}
Review purpose: ${config.purpose}
Batch: ${batchIndex + 1} of ${imageBatches.length}
Images in this batch: ${batchImages.length}
Total images in full review: ${imagePayload.length}
Attached fresh image count in full review: ${freshImagePayload.length}.
Attached reused saved image count in full review: ${reusedSavedImages.length}.
${imagePreparationWarning ? `Image preparation warning: ${imagePreparationWarning}` : ""}

${groundingContext}
${imageReviewContext}
${canonicalAnatomyPacket}
${imagePresenceRules}
${cumulativeBaselineContext}
${anatomicalFocusRule}
${SARAH_APP_OVERLAY_TELEMETRY_RULE}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${sessionGroundingRule}
${PROFILE_OBSERVATION_PRODUCT_RULE}
${PROFILE_IMAGE_REVIEW_RULE_BUNDLE}
${establishedEvidenceContext}

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
          promptPrefix: `You are Sarah, synthesizing a final Sarah profile image review from completed image-review batch JSON.

Review type: ${config.title}
Review purpose: ${config.purpose}
Directly rechecked image subset across batches: ${imagePayload.length}
Batch count: ${imageBatches.length}

No fresh images are attached to this synthesis pass because the direct visual re-check already occurred in the batch passes. Treat the batch JSON below as directly reviewed visual evidence, then integrate it with saved profile/session context. Produce ONE final cumulative user-facing review, not a batch-by-batch report and not a review limited to the image subset.

${groundingContext}
${imageReviewContext}
${canonicalAnatomyPacket}
${cumulativeBaselineContext}
${anatomicalFocusRule}
${SARAH_APP_OVERLAY_TELEMETRY_RULE}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${sessionGroundingRule}
${PROFILE_OBSERVATION_PRODUCT_RULE}
${PROFILE_IMAGE_REVIEW_RULE_BUNDLE}
${establishedEvidenceContext}

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
            message: `${config.shortTitle} review is queued on the desktop backend. You can leave this page; Sarah will keep running it.`,
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
            message: `Queueing ${imagePayload.length} images in ${imageBatches.length} server-side batches. Keep this screen open until Sarah says the backend has the job.`,
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
            prompt: `You are Sarah, performing one batch of a larger Sarah profile image review.

Review type: ${config.title}
Review purpose: ${config.purpose}
Batch: ${batchIndex + 1} of ${imageBatches.length}
Images in this batch: ${batchImages.length}
Total images in full review: ${imagePayload.length}
Attached fresh image count in full review: ${freshImagePayload.length}.
Attached reused saved image count in full review: ${reusedSavedImages.length}.
${imagePreparationWarning ? `Image preparation warning: ${imagePreparationWarning}` : ""}

${groundingContext}
${imageReviewContext}
${canonicalAnatomyPacket}
${imagePresenceRules}
${anatomicalFocusRule}
${SARAH_APP_OVERLAY_TELEMETRY_RULE}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${sessionGroundingRule}
${PROFILE_OBSERVATION_PRODUCT_RULE}
${PROFILE_IMAGE_REVIEW_RULE_BUNDLE}
${establishedEvidenceContext}

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
              message: `Queued ${batchIndex + 1}/${imageBatches.length} ${config.shortTitle} image batches on the desktop backend.`,
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
            normalizeImageReviewResult(typeof completedBatchJob.result === "string" ? JSON.parse(completedBatchJob.result) : completedBatchJob.result, config),
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
          prompt: `You are Sarah, synthesizing a final Sarah profile image review from completed image-review batch JSON.

Review type: ${config.title}
Review purpose: ${config.purpose}
Directly rechecked image subset across batches: ${imagePayload.length}
Batch count: ${batchParsedResults.length}

No fresh images are attached to this synthesis pass because the direct visual re-check already occurred in the batch passes. Treat the batch JSON below as directly reviewed visual evidence, then integrate it with saved profile/session context. Produce ONE final cumulative user-facing review, not a batch-by-batch report and not a review limited to the image subset.

${groundingContext}
${imageReviewContext}
${canonicalAnatomyPacket}
${cumulativeBaselineContext}
${anatomicalFocusRule}
${SARAH_APP_OVERLAY_TELEMETRY_RULE}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${sessionGroundingRule}
${PROFILE_OBSERVATION_PRODUCT_RULE}
${PROFILE_IMAGE_REVIEW_RULE_BUNDLE}
${establishedEvidenceContext}

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
        const singlePrompt = `You are Sarah, performing a dedicated profile image review for Sarah.

Review type: ${config.title}
Review purpose: ${config.purpose}
Attached fresh image count: ${freshImagePayload.length}.
Attached reused saved image count: ${reusedSavedImages.length}.
${imagePreparationWarning ? `Image preparation warning: ${imagePreparationWarning}` : ""}

${groundingContext}
${imageReviewContext}
${canonicalAnatomyPacket}
${imagePresenceRules}
${cumulativeBaselineContext}
${anatomicalFocusRule}
${SARAH_APP_OVERLAY_TELEMETRY_RULE}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${sessionGroundingRule}
${PROFILE_OBSERVATION_PRODUCT_RULE}
${PROFILE_IMAGE_REVIEW_RULE_BUNDLE}
${establishedEvidenceContext}

IMAGE REVIEW RULES:
- Treat these as consensual private profile-reference images for anatomical and physiological review.
- If fresh images are attached to this request, analyze what is visible in those images as new direct evidence, then use those observations only to update the canonical anatomy packet. Do not make the update evidence the story.
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
              images: imagePayload.filter((image) => image.data).map((image) => ({
                filename: `${image.image_id || "profile_reference"}.jpg`,
                media_type: image.media_type,
                data: image.data,
              })),
              imageRefs: imagePayload.filter((image) => !image.data).map((image) => ({
                image_id: image.image_id,
                filename: `${image.image_id || "profile_reference"}.jpg`,
                media_type: image.media_type,
                url: image.url || image.storagePath || image.file_url || image.preview_url || "",
                file_url: image.file_url || image.url || image.storagePath || image.preview_url || "",
                preview_url: image.preview_url || image.url || image.storagePath || image.file_url || "",
                storagePath: image.storagePath || image.url || image.file_url || image.preview_url || "",
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
            message: `${config.shortTitle} review is queued on the desktop backend. You can leave this page; Sarah will keep running it.`,
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
        prompt: `You are Sarah, performing a dedicated profile image review for Sarah.

Review type: ${config.title}
Review purpose: ${config.purpose}
Attached fresh image count: ${freshImagePayload.length}.
Attached reused saved image count: ${reusedSavedImages.length}.
${imagePreparationWarning ? `Image preparation warning: ${imagePreparationWarning}` : ""}

${groundingContext}
${imageReviewContext}
${canonicalAnatomyPacket}
${imagePresenceRules}
${anatomicalFocusRule}
${SARAH_APP_OVERLAY_TELEMETRY_RULE}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${sessionGroundingRule}
${PROFILE_OBSERVATION_PRODUCT_RULE}
${PROFILE_IMAGE_REVIEW_RULE_BUNDLE}
${establishedEvidenceContext}

IMAGE REVIEW RULES:
- Treat these as consensual private profile-reference images for anatomical and physiological review.
- If fresh images are attached to this request, analyze what is visible in those images as new direct evidence, then use those observations only to update the canonical anatomy packet. Do not make the update evidence the story.
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
        normalizeImageReviewResult(typeof raw === "string" ? JSON.parse(raw) : raw, config),
        batchParsedResults,
      );
      if (!parsed?.overview) throw new Error("Sarah returned an empty image review.");
      const storedResult = {
        ...parsed,
        _meta: buildImageReviewMetaWithEvidence({
          images: imagePayload,
          sessions,
          previousResult: result,
          currentResult: parsed,
          evidenceCounts: visualEvidence.counts,
          countOverrides: {
            fresh_image_count: freshImagePayload.length,
            reused_saved_image_count: reusedSavedImages.length,
            image_count: imagePayload.length,
          },
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
            "Batch reviews completed, but final synthesis timed out. Sarah saved the latest batch findings as an interim review without rerunning image review.",
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
  const profileStale = Boolean(result) && (
    isProfileAIContentStale(result, sessions) ||
    isProfileImageReviewSourceStale(result, { sessions, bodyExplorations })
  );
  const existingEvidenceCount = Object.values(visualEvidence.counts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const reusableProfileAttachments = collectSavedProfileImageAttachments(userProfile, {
    limit: 99,
    purpose: config.contextScope === "head_to_toe_body_reference" ? "head_to_toe_body_reference" : "pelvic_genital",
  });
  const savedProfileAttachmentContexts = collectSavedProfileImageAttachmentContexts(userProfile);
  const reusableProfileReviewAttachments = collectSavedProfileReviewImageAttachments({
    result,
    archive,
    userProfile,
    config,
    limit: 99,
    purpose: config.contextScope === "head_to_toe_body_reference" ? "head_to_toe_body_reference" : "pelvic_genital",
    savedProfileContexts: savedProfileAttachmentContexts,
  });
  const reusableBodyExplorationFrameAttachments = collectBodyExplorationFrameAttachments(bodyExplorations, {
    limit: 99,
    purpose: config.contextScope === "head_to_toe_body_reference" ? "head_to_toe_body_reference" : "pelvic_genital",
  });
  const savedProfileContextImages = savedProfileAttachmentContexts.map((attachment, index) => ({
    image_id: `saved_context_${String(index + 1).padStart(3, "0")}`,
    previewUrl: attachment.url,
    storagePath: attachment.url,
    display_label: attachment.filename || `Saved Profile Q&A context ${reviewImageLetter(index)}`,
    coverage: cleanImageReviewProse([
      attachment.selection_prompt,
      attachment.selection_review_context,
    ].filter(Boolean).join(". ")),
    upload_note: cleanImageReviewProse([
      attachment.selection_prompt,
      attachment.selection_review_context,
    ].filter(Boolean).join(". ")),
    source: attachment.source || "saved_profile_qa_context",
  }));
  const fallbackReferenceImages = reusableProfileAttachments.map((attachment, index) => ({
    image_id: `saved_ref_${String(index + 1).padStart(3, "0")}`,
    previewUrl: attachment.url,
    storagePath: attachment.url,
    display_label: attachment.filename || `Saved Profile Q&A view ${reviewImageLetter(index)}`,
    coverage: cleanImageReviewProse([
      attachment.selection_prompt,
      attachment.selection_review_context,
    ].filter(Boolean).join(". ")),
    source: "saved_profile_qa_attachment",
  }));
  const archiveReferenceImages = (Array.isArray(archive) ? archive : [])
    .flatMap((entry, runIndex) => {
      const archivedResult = archiveEntryResult(entry);
      const reviewed = Array.isArray(archivedResult?._meta?.reviewed_images) ? archivedResult._meta.reviewed_images : [];
      const annotated = Array.isArray(archivedResult?.annotated_images) ? archivedResult.annotated_images : [];
      return reviewed.map((image, imageIndex) => {
        const originalId = image.image_id || `image_${imageIndex + 1}`;
        const annotation = annotated.find((item) => item?.image_id === originalId) || {};
        const archiveId = entry?.id || archivedResult?._meta?.last_generated_at || archivedResult?._meta?.updated_at || `run_${runIndex + 1}`;
        return {
          image_id: `archive_${runIndex + 1}_${String(originalId).replace(/[^a-z0-9_-]+/gi, "_")}`,
          original_image_id: originalId,
          previewUrl: image.preview_url || annotation.preview_url || "",
          storagePath: image.preview_url || annotation.preview_url || "",
          display_label: annotation.view_label || image.display_label || `Archived profile view ${reviewImageLetter(imageIndex)}`,
          coverage: cleanImageReviewProse([
            annotation.view_label,
            annotation.coverage,
            annotation.visibility_notes,
            Array.isArray(annotation.major_regions_visible) ? annotation.major_regions_visible.join(", ") : "",
            image.upload_note,
            image.source_video?.note,
            image.source_video?.purpose,
          ].filter(Boolean).join(". ")),
          source: image.source_video ? "profile_review_archive_video_frame" : "profile_review_archive",
          archive_id: archiveId,
          source_video: image.source_video || null,
        };
      });
    })
    .filter((image) => {
      if (!(image.previewUrl || image.storagePath)) return false;
      if (config.kind !== PELVIC_GENITAL_REVIEW_KIND) return true;
      const sourceContext = savedProfileContextImages.find((contextImage) => (
        contextImage.previewUrl && contextImage.previewUrl === (image.previewUrl || image.storagePath)
      ));
      const sourceText = compactEvidenceText(sourceContext?.coverage, sourceContext?.upload_note);
      if (sourceText && isPelvicGenitalTextOutOfScope(sourceText)) return false;
      if (sourceText && !PELVIC_GENITAL_STRONGLY_POSITIVE_RE.test(sourceText)) return false;
      const archiveText = compactEvidenceText(image.display_label, image.coverage);
      if (isPelvicGenitalTextOutOfScope(archiveText)) return false;
      return PELVIC_GENITAL_STRONGLY_POSITIVE_RE.test(sourceText || archiveText);
    });
  const inlineReferenceImages = [...images, ...fallbackReferenceImages, ...archiveReferenceImages]
    .reduce((items, image) => {
      const key = image.image_id || image.storagePath || image.previewUrl;
      if (!key || items.some((item) => (item.image_id || item.storagePath || item.previewUrl) === key)) return items;
      items.push(image);
      return items;
    }, []);
  const evidenceLookupImages = [...inlineReferenceImages, ...savedProfileContextImages]
    .reduce((items, image) => {
      const key = image.image_id || image.storagePath || image.previewUrl;
      if (!key || items.some((item) => (item.image_id || item.storagePath || item.previewUrl) === key)) return items;
      items.push(image);
      return items;
    }, []);
  const imageSaveInProgress = images.some((image) => image.upload_status === "saving");
  const videoSaveInProgress = videos.some((video) => video.upload_status === "saving");
  const imageSaveErrorCount = images.filter((image) => image.upload_status === "error").length;
  const videoSaveErrorCount = videos.filter((video) => video.upload_status === "error").length;
  const savingImageCount = images.filter((image) => image.upload_status === "saving").length;
  const savingVideoCount = videos.filter((video) => video.upload_status === "saving").length;
  const reviewPhase = String(jobStatus?.progress?.phase || "");
  const reviewIsPreparingLocally = loading && (jobStatus?.status === "starting" || reviewPhase === "preparing" || reviewPhase === "building");
  const reviewIsBackendQueued = activeReviewJob && !reviewIsPreparingLocally;
  const reviewCardStatusItems = [
    {
      active: profileLoading,
      loading: true,
      headline: `${config.shortTitle} is preparing context`,
      label: "Saved profile context",
      detail: "Loading saved profile facts, Q&A, and prior Sarah outputs.",
    },
    {
      active: evidenceLoading,
      loading: true,
      headline: `${config.shortTitle} is preparing evidence`,
      label: "Saved visual/session evidence",
      detail: "Loading reusable images, sessions, body-exploration frames, and prior review context.",
    },
    {
      active: imageSaveInProgress,
      loading: true,
      headline: `${config.shortTitle} is saving uploads`,
      label: "Fresh images",
      detail: `${savingImageCount} image upload${savingImageCount === 1 ? "" : "s"} still saving.`,
    },
    {
      active: videoSaveInProgress,
      loading: true,
      headline: `${config.shortTitle} is sampling video`,
      label: "Fresh videos",
      detail: `${savingVideoCount} video${savingVideoCount === 1 ? "" : "s"} still being sampled for review frames.`,
    },
    {
      active: loading || activeReviewJob,
      loading: true,
      headline: reviewIsPreparingLocally
        ? `Preparing ${config.shortTitle} review`
        : reviewIsBackendQueued
          ? `${config.shortTitle} review is queued`
          : `${config.shortTitle} review is running`,
      label: reviewIsPreparingLocally
        ? "Keep this screen open"
        : "Safe to leave this page",
      detail: jobStatus?.progress?.message || (reviewIsPreparingLocally
        ? "Sarah is packaging the request locally. Backgrounding too early can prevent the job from being created."
        : "The desktop backend has the job. Sarah will keep working even if the phone app backgrounds."),
    },
    {
      active: Boolean(availableCompletedReviewJob),
      loading: false,
      headline: `${config.shortTitle} result is ready`,
      label: "Completed background result",
      detail: "A finished review is available. Tap Show Completed Review to attach it to the card.",
    },
    {
      active: Boolean(hasRecoverableUnshownBatchSet || hasRecoverableDisplayRepair),
      loading: false,
      headline: `${config.shortTitle} completed batches are recoverable`,
      label: "Completed batch findings",
      detail: hasRecoverableDisplayRepair
        ? "A saved batch review can be repaired to reconnect its inline image callouts."
        : recoverableBatchSet?.partial
          ? `${recoverableBatchSet.batches.length}/${recoverableBatchSet.expectedTotal || recoverableBatchSet.total} completed batches were preserved and can be assembled as a partial draft.`
          : `${recoverableBatchSet?.total || recoverableBatchSet?.batches?.length || 0} completed batches can be assembled without rerunning image review.`,
    },
  ];
  const pelvicResultScoped = isPelvicGenitalReviewResult(result, config);
  const lightboxImageIds = result ? [...new Set([
    ...(Array.isArray(result?._meta?.reviewed_images) ? result._meta.reviewed_images.map((image) => image.image_id).filter(Boolean) : []),
    ...(Array.isArray(result?.annotated_images) ? result.annotated_images.map((image) => image.image_id).filter(Boolean) : []),
    ...(Array.isArray(result?.image_region_findings) ? result.image_region_findings.map((finding) => finding.image_id).filter(Boolean) : []),
  ])].filter((imageId) => {
    if (!pelvicResultScoped) return true;
    const text = pelvicGenitalImageEvidenceText(result, imageId, evidenceLookupImages, null);
    return text.trim() && !isPelvicGenitalTextOutOfScope(text) && PELVIC_GENITAL_STRONGLY_POSITIVE_RE.test(text);
  }) : [];
  const paragraphs = [];
  const paragraphMeta = [];
  if (result) {
    paragraphs.push(calmSpokenHeading(config.title));
    paragraphMeta.push({ type: "title", color: config.color, displayLabel: config.title });
    for (const section of sections) {
      const sectionFindings = pelvicResultScoped
        ? (result[section.key] || []).map(cleanPelvicGenitalScopeProseItem).filter(Boolean)
        : (result[section.key] || []);
      if (sectionFindings.length) {
        paragraphs.push(calmSpokenHeading(section.label));
        paragraphMeta.push({ type: "section-title", section, displayLabel: section.label });
        if (includeImageCalloutsInTts) {
          for (const calloutParagraph of imageCalloutNarrationParagraphs(result, section.key, evidenceLookupImages)) {
            paragraphs.push(calloutParagraph);
            paragraphMeta.push({ type: "visual-callout", section });
          }
        }
      }
      for (const finding of sectionFindings) {
        const cleanedFinding = cleanImageReviewProse(naturalizeSpokenDates(finding));
        if (!cleanedFinding) continue;
        paragraphs.push(cleanedFinding);
        paragraphMeta.push({ type: "section", section });
      }
    }
  }

  const buildAnatomyVideoImages = () => {
    if (!result) return [];
    const pelvicScoped = isPelvicGenitalReviewResult(result, config);
    const imageIds = [...new Set([
      ...lightboxImageIds,
      ...inlineReferenceImages.map((image, index) => image.image_id || `profile-image-${index + 1}`),
    ].filter(Boolean))];
    const sectionsByImage = new Map();
    const regionsByImage = new Map();
    (Array.isArray(result.image_region_findings) ? result.image_region_findings : [])
      .filter((finding) => !pelvicScoped || isPelvicGenitalFindingInScope(result, finding, evidenceLookupImages))
      .forEach((finding) => {
      if (!finding?.image_id) return;
      const section = sections.find((item) => item.key === finding.section_key);
      if (section?.label) {
        if (!sectionsByImage.has(finding.image_id)) sectionsByImage.set(finding.image_id, new Map());
        sectionsByImage.get(finding.image_id).set(section.key, section.label);
      }
      const region = cleanImageReviewProse(finding.region || finding.label || "");
      if (region) {
        if (!regionsByImage.has(finding.image_id)) regionsByImage.set(finding.image_id, new Set());
        regionsByImage.get(finding.image_id).add(region);
      }
    });
    const annotatedByImage = new Map();
    (Array.isArray(result.annotated_images) ? result.annotated_images : []).forEach((image) => {
      if (image?.image_id) annotatedByImage.set(image.image_id, image);
    });
    return imageIds
      .map((imageId) => {
        const image = pelvicScoped
          ? rawProfileImageById(result, imageId, evidenceLookupImages)
          : profileImageById(result, imageId, evidenceLookupImages);
        const rawImage = rawProfileImageById(result, imageId, evidenceLookupImages);
        return { image, rawImage };
      })
      .filter(({ image, rawImage }) => {
        if (!image?.preview_url) return false;
        if (!pelvicScoped) return true;
        const sourceText = compactEvidenceText(
          rawImage?.display_label,
          rawImage?.body_position,
          rawImage?.coverage,
          rawImage?.visibility_notes,
          rawImage?.major_regions_visible,
          rawImage?.upload_note,
          rawImage?.source_video?.note,
          rawImage?.source_video?.purpose,
        );
        if (isPelvicGenitalTextOutOfScope(sourceText)) return false;
        return PELVIC_GENITAL_STRONGLY_POSITIVE_RE.test(sourceText);
      })
      .map(({ image, rawImage }, index) => {
        const imageId = image.image_id || `profile-image-${index + 1}`;
        const sectionMap = sectionsByImage.get(imageId) || new Map();
        const sectionKeys = [...sectionMap.keys()];
        const sectionLabels = [...sectionMap.values()];
        const annotated = annotatedByImage.get(imageId) || {};
        const sourceText = cleanImageReviewProse([
          rawImage.coverage,
          rawImage.upload_note,
          rawImage.visibility_notes,
          Array.isArray(rawImage.major_regions_visible) ? rawImage.major_regions_visible.join(", ") : "",
          rawImage.source_video?.note,
          rawImage.source_video?.purpose,
        ].filter(Boolean).join(". "));
        const sourceHasScopeSignal = sourceText && (
          isPelvicGenitalTextOutOfScope(sourceText) ||
          PELVIC_GENITAL_STRONGLY_POSITIVE_RE.test(sourceText)
        );
        return {
          image_id: imageId,
          display_label: pelvicScoped
            ? (rawImage.display_label || image.display_label || `Reference view ${reviewImageLetter(index)}`)
            : (image.display_label || annotated.view_label || `Reference view ${reviewImageLetter(index)}`),
          section_key: sectionKeys[0] || "",
          section_label: sectionLabels[0] || "",
          section_labels: sectionLabels,
          regions: [...(regionsByImage.get(imageId) || new Set())],
          coverage: cleanImageReviewProse([
            sourceText,
            sourceHasScopeSignal ? "" : image.coverage,
            sourceHasScopeSignal ? "" : annotated.view_label,
            sourceHasScopeSignal ? "" : annotated.coverage,
            sourceHasScopeSignal ? "" : annotated.visibility_notes,
            sourceHasScopeSignal ? "" : Array.isArray(annotated.major_regions_visible) ? annotated.major_regions_visible.join(", ") : "",
          ].filter(Boolean).join(". ")),
          preview_url: image.preview_url,
          source: image.source || "profile_review",
        };
      })
      .slice(0, 80);
  };

  const startAnatomyVideoRender = async () => {
    if (!result || !paragraphs.length) {
      setAnatomyVideoStatus({ type: "error", message: "No profile review is available for an anatomy video." });
      return;
    }
    const videoImages = buildAnatomyVideoImages();
    if (!videoImages.length) {
      setAnatomyVideoStatus({ type: "error", message: "No linked review images are available for this anatomy video yet." });
      return;
    }
    let confirmedJobId = "";
    let sourceGeneratedAt = "";

    const finishAnatomyVideoJob = async (job, initialMessage) => {
      if (!job?.id) throw new Error("Anatomy video job did not return an id.");
      confirmedJobId = job.id;
      setActiveAnatomyVideoJobId(job.id);
      try {
        window.localStorage.setItem(anatomyVideoJobStorageKey, job.id);
      } catch {
        // The job is still queued server-side; storage is only for reconnect convenience.
      }
      setAnatomyVideoStatus({
        type: "working",
        message: initialMessage || "Queued on the desktop backend. You can background the app now; Sarah will keep rendering.",
      });

      const completed = job.status === "complete"
        ? (job.result ? job : await getBackgroundJob(job.id))
        : await waitForBackgroundJob(job.id, {
          intervalMs: 1500,
          onProgress: (nextJob) => {
            const progress = nextJob.progress || {};
            if (nextJob.id) setActiveAnatomyVideoJobId(nextJob.id);
            setAnatomyVideoStatus({
              type: nextJob.status === "error" ? "error" : "working",
              message: progress.message || "Queued on the desktop backend. You can background the app; Sarah will keep rendering.",
            });
          },
        });
      if (!completed.result?.file_url) throw new Error("Anatomy video render did not return an MP4.");
      setAnatomyVideo(completed.result);
      setActiveAnatomyVideoJobId("");
      try {
        window.localStorage.removeItem(anatomyVideoJobStorageKey);
      } catch {
        // Ignore storage cleanup failures.
      }
      setAnatomyVideoStatus({
        type: "ok",
        message: completed.result.audio_reused
          ? "Anatomy video ready. Reused matching narration."
          : "Anatomy video ready. Narration was rendered for this export.",
      });
    };

    const recoverTimedOutAnatomyVideoJob = async () => {
      if (!sourceGeneratedAt) return null;
      const jobs = await listBackgroundJobs({
        type: "profile_anatomy_video",
        status: "queued,running,complete",
        metaSource: "Profiler",
        limit: 50,
      });
      const sortedReviewJobs = (jobs.jobs || [])
        .filter((job) => profilerJobReviewType(job) === config.kind)
        .sort((a, b) => String(b.finishedAt || b.updatedAt || b.createdAt || "").localeCompare(String(a.finishedAt || a.updatedAt || a.createdAt || "")));
      const sourceMatch = sortedReviewJobs.find((job) => (
        String(job?.meta?.sourceGeneratedAt || job?.payload?.sourceGeneratedAt || "") === String(sourceGeneratedAt)
      ));
      if (sourceMatch) return sourceMatch;

      const startedAfterClick = Date.now() - 3 * 60 * 1000;
      return sortedReviewJobs.find((job) => {
        const createdMs = Date.parse(job.createdAt || job.startedAt || job.updatedAt || "");
        return Number.isFinite(createdMs) && createdMs >= startedAfterClick;
      }) || null;
    };

    try {
      setAnatomyVideo(null);
      setActiveAnatomyVideoJobId("");
      setAnatomyVideoStatus({
        type: "starting",
        message: "Preparing the anatomy video job. Keep Sarah in the foreground until it says the desktop backend has the job.",
      });
      const runtime = getTTSRuntime(loadTTSSettings());
      const readableItems = paragraphs
        .map((paragraph, index) => ({
          text: String(paragraph || "").trim(),
          meta: paragraphMeta[index] || {},
        }))
        .filter((item) => item.text);
      const readableParagraphs = readableItems.map((item) => item.text);
      const readableParagraphMeta = readableItems.map((item) => ({
        type: item.meta.type || "",
        displayLabel: item.meta.displayLabel || "",
        section_key: item.meta.section?.key || "",
        section_label: item.meta.section?.label || item.meta.displayLabel || "",
      }));
      const title = `${config.shortTitle} Anatomy Video`;
      const chunks = buildProfilerVideoChunks(readableParagraphs);
      const chapters = buildAudioChapterBundle({
        title,
        audioFilename: profileVideoFilename(title),
        paragraphs: readableParagraphs,
        source: "profile_anatomy_video",
      }).chapters;
      sourceGeneratedAt = result?._meta?.last_generated_at || result?._meta?.updated_at || new Date().toISOString();
      setAnatomyVideoStatus({
        type: "starting",
        message: "Sending the anatomy video job to the desktop backend...",
      });
      const job = await startBackgroundJob("profile_anatomy_video", {
        sessionId: `${config.ttsSessionId}-video`,
        title,
        sourceGeneratedAt,
        reviewType: config.kind,
        images: videoImages,
        paragraphs: readableParagraphs,
        paragraphMeta: readableParagraphMeta,
        chunks,
        chapters,
        voice: "nova",
        model: runtime.model,
        speed: runtime.speed,
        instructions: runtime.instructions,
        outputFormat: runtime.format,
        normalize: runtime.settings.normalizeExport,
        watermark: readWatermarkSettings(),
      }, {
        title,
        source: "Profiler",
        route: config.kind === PELVIC_GENITAL_REVIEW_KIND ? "/profiler#profiler-pelvic-genital-video" : "/profiler#profiler-head-to-toe-video",
        reviewType: config.kind,
        sourceGeneratedAt,
      });
      await finishAnatomyVideoJob(job, "Queued on the desktop backend. You can background the app now; Sarah will keep rendering.");
    } catch (err) {
      const message = String(err?.message || "");
      const staleApiJobType = /Unknown background job type:\s*profile_anatomy_video/i.test(message);
      const requestTimedOut = /timed out|timeout/i.test(message);
      if (!confirmedJobId && requestTimedOut && !staleApiJobType) {
        try {
          const recoveredJob = await recoverTimedOutAnatomyVideoJob();
          if (recoveredJob?.id) {
            setAnatomyVideoStatus({
              type: "working",
              message: "The phone request timed out, but the desktop backend has the video job. Reconnected to the render.",
            });
            await finishAnatomyVideoJob(recoveredJob, recoveredJob.progress?.message || "The desktop backend has the video job. You can background the app now; Sarah will keep rendering.");
            return;
          }
        } catch (recoverErr) {
          console.warn("Anatomy video timeout recovery skipped:", recoverErr);
        }
      }
      setAnatomyVideoStatus({
        type: "error",
        message: staleApiJobType
          ? "Anatomy video support is installed in the app code, but the local API has not reloaded it yet. Let the current render/analysis finish, then restart the local API to enable this button."
          : !confirmedJobId
            ? `The anatomy video job was not confirmed on the desktop backend. Keep Sarah foregrounded until the queued message appears, then retry. ${message || ""}`.trim()
          : message || "Anatomy video render failed.",
      });
    }
  };

  const downloadAnatomyVideo = async () => {
    if (!anatomyVideo?.file_url) return;
    const filename = anatomyVideo.filename || profileVideoFilename(`${config.shortTitle} Anatomy Video`);
    try {
      setAnatomyVideoStatus({
        type: "working",
        message: "Sending the anatomy video to Android Downloads...",
      });
      const result = await downloadOrSaveUrl(serverUrl(anatomyVideo.file_url), filename, { mimeType: "video/mp4" });
      setAnatomyVideoStatus({
        type: "ok",
        message: result?.systemDownload
          ? "Download handed to Android. Check the notification shade or Downloads."
          : result?.bytes
          ? `Anatomy video saved (${Math.round(result.bytes / 1024 / 1024)} MB).`
          : "Anatomy video download started.",
      });
    } catch (error) {
      setAnatomyVideoStatus({
        type: "error",
        message: error?.message || "Could not download the anatomy video.",
      });
    }
  };

  const panelId = config.kind === PELVIC_GENITAL_REVIEW_KIND ? "profiler-pelvic-genital" : "profiler-head-to-toe";
  const videoPanelId = config.kind === PELVIC_GENITAL_REVIEW_KIND ? "profiler-pelvic-genital-video" : "profiler-head-to-toe-video";
  const anatomyVideoBusy = anatomyVideoStatus.type === "starting" || anatomyVideoStatus.type === "working";
  const anatomyVideoCreatedLabel = formatVideoCreatedAt(anatomyVideo?.created_at || anatomyVideo?.exported_at || anatomyVideo?.finished_at);
  const anatomyVideoPoster = videoPosterDataUrl({
    title: `${config.shortTitle} Anatomy Video`,
    subtitle: anatomyVideoCreatedLabel ? "Generated Sarah review video" : "Tap to play generated Sarah review",
    timestamp: anatomyVideoCreatedLabel ? `Created ${anatomyVideoCreatedLabel}` : "",
  });

  return (
    <div id={panelId} className="scroll-mt-24">
    <SectionCard icon={config.icon} title={config.title} color={config.color} defaultCollapsed={true}>
      <div className="space-y-3">
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between">
          <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">{config.helper}</p>
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:flex-wrap">
            <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted/60 sm:h-8">
              <Upload className="h-3.5 w-3.5" /> Add Images
              <input type="file" accept="image/*" multiple className="hidden" onChange={handleImageFiles} />
            </label>
            <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted/60 sm:h-8">
              <Film className="h-3.5 w-3.5" /> Add Videos
              <input type="file" accept="video/*" multiple className="hidden" onChange={handleVideoFiles} />
            </label>
            <Button size="sm" onClick={handlePrimaryReviewAction} disabled={loading || activeReviewJob || imageSaveInProgress || videoSaveInProgress || (primaryReviewNeedsFreshContext && (profileLoading || evidenceLoading))} className="col-span-2 h-10 min-w-0 gap-1.5 text-xs sm:h-8 sm:w-auto">
              {loading
                ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />Reviewing...</>
                : imageSaveInProgress
                  ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />Saving Images...</>
                : videoSaveInProgress
                  ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />Sampling Video...</>
                : <><ImageIcon className="h-3.5 w-3.5" />{(hasRecoverableUnshownBatchSet || hasRecoverableDisplayRepair) ? (recoverableBatchSet?.partial ? "Show Partial Findings" : "Recover Final Synthesis") : availableCompletedReviewJob ? "Show Completed Review" : images.length ? (result ? "Re-review Images" : "Review Images") : (result ? "Re-review Evidence" : "Review Existing Evidence")}</>}
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
          <Badge variant="outline" className="h-auto min-h-6 max-w-full whitespace-normal px-2 py-1 text-left text-[10px] leading-tight">{existingEvidenceCount} saved visual/video evidence items</Badge>
          <Badge variant="outline" className="h-auto min-h-6 max-w-full whitespace-normal px-2 py-1 text-left text-[10px] leading-tight">
            {reusableProfileAttachments.length} relevant reusable Profile Q&A images
          </Badge>
          <Badge variant="outline" className="h-auto min-h-6 max-w-full whitespace-normal px-2 py-1 text-left text-[10px] leading-tight">
            {reusableProfileReviewAttachments.length + reusableBodyExplorationFrameAttachments.length} reusable saved review/frame images
          </Badge>
          <Badge variant="outline" className="h-auto min-h-6 max-w-full whitespace-normal px-2 py-1 text-left text-[10px] leading-tight">{sessions.length} sessions loaded</Badge>
          {bodyExplorations.length > 0 && (
            <Badge variant="outline" className="h-auto min-h-6 max-w-full whitespace-normal px-2 py-1 text-left text-[10px] leading-tight">{bodyExplorations.length} body exploration sessions loaded</Badge>
          )}
          {images.length > 0 && (
            <Badge variant="outline" className="h-auto min-h-6 max-w-full whitespace-normal px-2 py-1 text-left text-[10px] leading-tight">{images.length} fresh image{images.length === 1 ? "" : "s"} selected</Badge>
          )}
          {videos.length > 0 && (
            <Badge variant="outline" className="h-auto min-h-6 max-w-full whitespace-normal px-2 py-1 text-left text-[10px] leading-tight">{videos.length} video{videos.length === 1 ? "" : "s"} uploaded/sampled</Badge>
          )}
          {imageSaveErrorCount > 0 && (
            <Badge variant="destructive" className="h-auto min-h-6 max-w-full whitespace-normal px-2 py-1 text-left text-[10px] leading-tight">{imageSaveErrorCount} image save error{imageSaveErrorCount === 1 ? "" : "s"}</Badge>
          )}
          {videoSaveErrorCount > 0 && (
            <Badge variant="destructive" className="h-auto min-h-6 max-w-full whitespace-normal px-2 py-1 text-left text-[10px] leading-tight">{videoSaveErrorCount} video save error{videoSaveErrorCount === 1 ? "" : "s"}</Badge>
          )}
          {recoverableBatchSet?.batches?.length > 0 && !result?._meta?.local_batch_assembled && (
            <Badge variant="secondary" className="h-auto min-h-6 max-w-full whitespace-normal px-2 py-1 text-left text-[10px] leading-tight">
              {recoverableBatchSet.partial
                ? `${recoverableBatchSet.batches.length}/${recoverableBatchSet.expectedTotal || recoverableBatchSet.total} batches preserved`
                : `${recoverableBatchSet.total}/${recoverableBatchSet.total} batches recoverable`}
            </Badge>
          )}
          <Badge variant="secondary" className="h-auto min-h-6 max-w-full whitespace-normal px-2 py-1 text-left text-[10px] leading-tight">Priority background queue</Badge>
        </div>

        <ProfileImageReviewInlineStatus
          items={reviewCardStatusItems}
          color={config.color}
        />

        {recoverableBatchSet?.batches?.length > 0 && !result?._meta?.local_batch_assembled && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-950">
            {result?._meta?.local_batch_assembled
              ? "Batch reviews completed and are saved as the current review. The main review button will run a fresh review only when you ask for it."
              : latestAttemptStatus?.state === "batch_reviews_saved_without_final_synthesis"
                ? "Batch reviews completed and were saved as the current review. The main review button will run a fresh review only when you ask for it."
              : recoverableBatchSet?.partial
                ? `Sarah preserved ${recoverableBatchSet.batches.length}/${recoverableBatchSet.expectedTotal || recoverableBatchSet.total} completed batches before the job stopped. Tap Show Partial Findings to display a local draft without spending more credits.`
                : "Batch reviews completed, but the final rewrite did not finish. Tap Show Latest Findings to display the completed findings without rerunning image review."}
          </div>
        )}

        {result?._meta?.local_batch_assembled && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-sm leading-relaxed text-amber-950 shadow-sm">
            <p className="font-semibold">Recovered batch findings · Not final synthesis</p>
            <p className="mt-1">
              Sarah finished the image-review batches and preserved those findings. This view is a local recovered draft assembled from completed batches; the polished final Sarah synthesis has not run successfully yet.
            </p>
            <p className="mt-1">
              {providerErrorCategory(latestAttemptStatus?.provider_error || latestAttemptStatus?.error_message) === "insufficient_credits"
                ? "Anthropic credits are unavailable. Add credits, then use Retry final synthesis only so Sarah reuses the completed batches without rerunning image review."
                : "Use Retry final synthesis only when you want the polished final pass. Sarah should reuse the completed batches and avoid rerunning image review."}
            </p>
          </div>
        )}

        {(latestAttemptStatus || recoverableBatchSet?.batches?.length > 0) && !result?._meta?.local_batch_assembled && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950">
            <p className="font-semibold uppercase tracking-wider">Latest Attempt Status</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div className="rounded-md border border-amber-200 bg-white/70 px-2 py-1.5">
                <p className="text-[10px] uppercase tracking-wider text-amber-800">Final Synthesis</p>
                <p>{result?._meta?.local_batch_assembled
                  ? "Recovered batch draft is saved; final synthesis is still incomplete."
                  : latestAttemptStatus?.state === "batch_reviews_saved_without_final_synthesis"
                    ? "Not needed for current output; completed batch findings are saved."
                  : latestAttemptStatus?.error_message
                    ? `Failed: ${aiErrorMessage({ message: latestAttemptStatus.error_message, data: { error: latestAttemptStatus.error_message } })}`
                    : "Completed batch findings are ready to show."}</p>
              </div>
              <div className="rounded-md border border-amber-200 bg-white/70 px-2 py-1.5">
                <p className="text-[10px] uppercase tracking-wider text-amber-800">Current Display</p>
                <p>{result?._meta?.local_batch_assembled
                  ? "Showing recovered batch findings, not final synthesis."
                  : result
                    ? "Showing previous final synthesis until retry or local assembly succeeds."
                    : "No previous final synthesis is available yet."}</p>
              </div>
              <div className="rounded-md border border-amber-200 bg-white/70 px-2 py-1.5">
                <p className="text-[10px] uppercase tracking-wider text-amber-800">Latest Batch Findings</p>
                <p>{recoverableBatchSet?.batches?.length
                  ? recoverableBatchSet.partial
                    ? `${recoverableBatchSet.batches.length}/${recoverableBatchSet.expectedTotal || recoverableBatchSet.total} completed batches preserved.`
                    : `${recoverableBatchSet.total}/${recoverableBatchSet.total} completed batches available.`
                  : "No completed batch set loaded."}</p>
              </div>
              <div className="rounded-md border border-amber-200 bg-white/70 px-2 py-1.5">
                <p className="text-[10px] uppercase tracking-wider text-amber-800">Next Action</p>
                <p>{result?._meta?.local_batch_assembled
                  ? "Use Retry final synthesis only to polish this without rerunning image review."
                  : latestAttemptStatus?.state === "batch_reviews_saved_without_final_synthesis"
                  ? "The current batch-assembled review is already saved."
                  : recoverableBatchSet?.partial
                    ? "Tap Show Partial Findings to save the recovered draft locally. Rerun the full review after adding credits."
                    : "Tap Show Latest Findings. This will not rerun image review."}</p>
              </div>
            </div>
          </div>
        )}

        {result && (
          <div className="grid gap-1 text-xs leading-relaxed text-muted-foreground sm:flex sm:flex-wrap sm:items-center sm:gap-2 sm:text-[10px]">
            <span>{result?._meta?.last_generated_at ? `Generated ${formatGeneratedAt(result._meta.last_generated_at)}` : "Generated time unavailable"}</span>
            <span>Fresh images added this run: {result?._meta?.fresh_image_count ?? 0}</span>
            <span>Saved image views rechecked: {result?._meta?.reused_saved_image_count ?? 0}</span>
            {Array.isArray(result?._meta?.reviewed_images) && result._meta.reviewed_images.length > 0 && (
              <span>{result._meta.reviewed_images.length} direct view{result._meta.reviewed_images.length === 1 ? "" : "s"} linked into cumulative review</span>
            )}
            {profileStale && (
              <span className="rounded-full border border-amber-400/40 bg-amber-400/15 px-2 py-0.5 font-semibold text-amber-700">
                Newer saved evidence exists - re-review to update this synthesis
              </span>
            )}
          </div>
        )}

        {result && (
          <div id={videoPanelId} className="scroll-mt-24 rounded-xl border border-primary/20 bg-primary/5 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="flex items-center gap-1.5 text-sm font-bold text-foreground">
                  <Video className="h-4 w-4 text-primary" />
                  Narrated anatomy video
                </h4>
                <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted-foreground">
                  Builds a narrated HD review from the current Sarah text plus linked profile images and video-sampled frames.
                  Keep the app foregrounded only until the status says it is queued on the desktop backend.
                </p>
                {profileStale && (
                  <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] font-medium leading-relaxed text-amber-900">
                    This Profiler text is stale. A saved video may still be shown below, but use Re-review first if you want the narrated video to match the newest evidence.
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={startAnatomyVideoRender}
                  disabled={anatomyVideoBusy || !paragraphs.length}
                  className="h-8 gap-1.5 text-xs"
                >
                  {anatomyVideoBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Video className="h-3.5 w-3.5" />}
                  {anatomyVideoStatus.type === "starting"
                    ? "Starting..."
                    : anatomyVideoStatus.type === "working"
                      ? "Queued"
                      : anatomyVideo?.file_url ? "Rebuild video" : "Build anatomy video"}
                </Button>
                {anatomyVideo?.file_url && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={downloadAnatomyVideo}
                    className="h-8 gap-1.5 text-xs"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download MP4
                  </Button>
                )}
              </div>
            </div>
            {!anatomyVideo?.file_url && anatomyVideoStatus.message && (
              <div className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                anatomyVideoStatus.type === "error"
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : anatomyVideoStatus.type === "working" || anatomyVideoStatus.type === "starting" || anatomyVideoStatus.type === "checking"
                    ? "border-primary/25 bg-background text-muted-foreground"
                    : "border-border bg-background text-muted-foreground"
              }`}>
                {anatomyVideoStatus.type === "working" || anatomyVideoStatus.type === "starting" || anatomyVideoStatus.type === "checking"
                  ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                  : <Video className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />}
                <div>
                  <p className="font-semibold text-foreground">
                    {anatomyVideoStatus.type === "working" || anatomyVideoStatus.type === "starting"
                      ? "Video job is active"
                      : anatomyVideoStatus.type === "checking"
                        ? "Looking for a saved video"
                        : anatomyVideoStatus.type === "error"
                          ? "Video job needs attention"
                          : "No video is currently attached"}
                  </p>
                  <p className="mt-0.5">{anatomyVideoStatus.message}</p>
                </div>
              </div>
            )}
            {anatomyVideo?.file_url && (
              <div className="mt-3 overflow-hidden rounded-lg border border-border bg-black">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background px-3 py-2 text-xs">
                  <span className="font-semibold text-foreground">Generated video output</span>
                  <span className="text-muted-foreground">
                    {anatomyVideoCreatedLabel ? `Created ${anatomyVideoCreatedLabel}` : "Created time unavailable"}
                  </span>
                </div>
                <video
                  src={serverUrl(anatomyVideo.file_url)}
                  poster={anatomyVideoPoster}
                  controls
                  playsInline
                  preload="metadata"
                  className="block max-h-[34rem] w-full bg-black object-contain"
                />
              </div>
            )}
            {anatomyVideo?.file_url && anatomyVideoStatus.message && (
              <p className={`mt-2 text-xs ${
                anatomyVideoStatus.type === "error"
                  ? "text-destructive"
                  : anatomyVideoStatus.type === "ok"
                    ? "text-emerald-600"
                    : "text-muted-foreground"
              }`}>
                {anatomyVideoStatus.message}
              </p>
            )}
          </div>
        )}

        {!hasCachedOrRecoverableReview && (
          <ProfilerPanelLoadingStatus
            items={[
              { active: profileLoading, label: "Saved profile context", status: "loading" },
              { active: evidenceLoading, label: "Session and body-exploration evidence", status: "loading" },
            ]}
          />
        )}

        {!result && !profileLoading && !images.length && !videos.length && (
          <p className="text-xs text-muted-foreground">{config.emptyText}</p>
        )}

        {!result && (images.length > 0 || videos.length > 0) ? (
          <p className="text-xs text-muted-foreground">
            Keep this page open until selected images/videos show Saved. After that, video previews and sampled review frames are stored locally for this Profiler run.
          </p>
        ) : !result && reusableProfileAttachments.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            No fresh images selected. Sarah will review the saved visual library first, including prior reviewed images, reusable frames, body-exploration/session evidence, and Profile Q&A only as supporting context.
          </p>
        ) : null}

        {!result && !images.length && reusableProfileAttachments.length === 0 && existingEvidenceCount > 0 && (
          <p className="text-xs text-muted-foreground">
            Saved visual findings are available. Sarah will use prior media reviews, body-exploration/session evidence, and profile findings even if no reusable Profile Q&A image files are available.
          </p>
        )}

        {imageUploadStatus && (
          <div className="rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-xs leading-relaxed text-foreground">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{imageUploadStatus.message}</span>
              <span className="font-mono text-muted-foreground">{imageUploadStatus.current}/{imageUploadStatus.total}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.max(5, Math.min(100, (imageUploadStatus.current / Math.max(1, imageUploadStatus.total)) * 100))}%` }}
              />
            </div>
          </div>
        )}

        {videoUploadStatus && (
          <div className="rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-xs leading-relaxed text-foreground">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{videoUploadStatus.message}</span>
              <span className="font-mono text-muted-foreground">{videoUploadStatus.current}/{videoUploadStatus.total}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.max(5, Math.min(100, (videoUploadStatus.current / Math.max(1, videoUploadStatus.total)) * 100))}%` }}
              />
            </div>
          </div>
        )}

        {videos.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {videos.map((video) => (
              <div key={video.id} className="overflow-hidden rounded-lg border border-border bg-muted/20">
                <div className="relative aspect-video bg-black">
                  <video src={video.previewUrl} className="h-full w-full object-contain" controls playsInline preload="metadata" />
                  {video.upload_status && (
                    <span className={`absolute left-1 top-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      video.upload_status === "saved"
                        ? "bg-emerald-500/90 text-white"
                        : video.upload_status === "error"
                          ? "bg-destructive/90 text-white"
                          : "bg-background/85 text-foreground"
                    }`}>
                      {video.upload_status === "saved" ? "Saved" : video.upload_status === "error" ? "Error" : "Saving"}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeVideo(video.id)}
                    className="absolute right-1 top-1 rounded-full bg-background/85 p-1 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${video.filename}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="px-2 py-1.5">
                  <p className="truncate text-[10px] text-muted-foreground">{video.filename}</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {formatFileSize(video.size)} · {video.sampledFrameCount || 0} sampled review frame{video.sampledFrameCount === 1 ? "" : "s"}
                  </p>
                </div>
                {video.upload_error && (
                  <p className="px-2 pb-1 text-[10px] leading-relaxed text-destructive">{video.upload_error}</p>
                )}
                <div className="border-t border-border px-2 py-2">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Video note
                  </label>
                  <textarea
                    value={video.upload_note || ""}
                    onChange={(event) => updateVideoNote(video.id, event.target.value)}
                    rows={3}
                    placeholder="Optional context for Sarah: gait, device insertion, ruler/measurement, movement to compare..."
                    className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs leading-relaxed text-foreground outline-none focus:border-primary"
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {images.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {images.map((image) => (
              <div key={image.id} className="overflow-hidden rounded-lg border border-border bg-muted/20">
                <div className="relative aspect-[4/3] bg-black">
                  <img src={image.previewUrl} alt={image.filename} className="h-full w-full object-contain" />
                  {image.upload_status && (
                    <span className={`absolute left-1 top-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      image.upload_status === "saved"
                        ? "bg-emerald-500/90 text-white"
                        : image.upload_status === "error"
                          ? "bg-destructive/90 text-white"
                          : "bg-background/85 text-foreground"
                    }`}>
                      {image.upload_status === "saved" ? "Saved" : image.upload_status === "error" ? "Error" : "Saving"}
                    </span>
                  )}
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
                {image.upload_error && (
                  <p className="px-2 pb-1 text-[10px] leading-relaxed text-destructive">{image.upload_error}</p>
                )}
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

        <CompactError message={(loading || activeReviewJob || freshReviewPending) ? "" : error} />

        {result && !freshReviewPending && (
          <div className="mx-auto w-full max-w-6xl">
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
                        transientImages={evidenceLookupImages}
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
          </div>
        )}

        <ProfileImageLightbox
          result={result}
          imageIds={lightboxImageIds}
          selectedImageId={selectedProfilerImageId}
          onSelectImageId={setSelectedProfilerImageId}
          onClose={() => setSelectedProfilerImageId(null)}
          sections={sections}
          color={config.color}
          transientImages={evidenceLookupImages}
          onCorrectFinding={saveImageFindingClarification}
          onRemoveFinding={removeImageFindingCallout}
        />

        <ProfileArchiveList
          title={`${config.shortTitle} Run Archive`}
          archive={archive}
          currentResult={result}
          onViewRun={(entryOrResult) => {
            const archivedResult = archiveEntryResult(entryOrResult);
            if (!archivedResult) return;
            setResult(normalizeImageReviewResult(archivedResult, config) || archivedResult);
            setViewingArchiveRunId(entryOrResult?.id || archivedResult?._meta?.last_generated_at || archivedResult?._meta?.updated_at || "archived");
            setError("");
          }}
        />
      </div>
    </SectionCard>
    </div>
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
          ? await loadFullBackgroundJob(job)
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
${SARAH_APP_OVERLAY_TELEMETRY_RULE}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${PROFILE_IMAGE_LEFT_RIGHT_ORIENTATION_RULE}
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
Allowed phrasing includes "your body repeatedly shows", "this pattern appears to fit", "this aligns with prior entries", and "your data suggests".
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
Prefer wording like "you repeatedly report improved recovery with THC" over "THC improves parasympathetic recovery".

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
  const profileButtonDisabledReason = loading
    ? ""
    : evidenceLoading
      ? "Waiting for saved session evidence to finish loading."
      : sessions.length < 2
        ? "Need at least two sessions before generating this profile."
        : "";
  const profileButtonDisabled = Boolean(loading || profileButtonDisabledReason);

  return (
    <SectionCard icon={<Brain className="w-4 h-4" />} title="Comprehensive Physiological Profile" color="hsl(var(--primary))" defaultCollapsed={true}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          AI-generated personal physiological & arousal profile based on all sessions, event timelines, and profile notes.
        </p>
        <Button size="sm" onClick={analyze} disabled={profileButtonDisabled} title={profileButtonDisabledReason || undefined} className="h-7 text-xs gap-1.5 shrink-0 ml-2">
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
      {result && profileButtonDisabledReason && (
        <p className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          Re-generate is waiting: {profileButtonDisabledReason}
        </p>
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
          ? await loadFullBackgroundJob(job)
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
${SARAH_APP_OVERLAY_TELEMETRY_RULE}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${PROFILE_IMAGE_LEFT_RIGHT_ORIENTATION_RULE}
${firstNameToneCue}
${longitudinalHrvEvidence ? RR_HRV_INTERPRETATION_RULES : ""}

SYNTHESIS REQUIREMENTS:
- Begin with a compact whole-body overview, then expand only where the provided evidence supports detail.
- Write every part of the response directly to the person in second person, including the opening overview. Do not open with "Ben is," "the person is," "the user is," or any other third-person framing.
- Separate directly entered anatomical observations from repeated session-linked findings and from cautious interpretations.
- Consider constitutional/body habitus, cardiovascular/autonomic, respiratory, neurological/sensory, musculoskeletal/biomechanical, and endocrine/metabolic context only when those data were provided.
- Use psychological, personal-history, or broad longitudinal context only where it directly explains anatomy, visible mechanics, device interaction, safety/risk-control observations, or session-specific physiology. Do not turn this A&P artifact into a broad arousal biography or life-history synthesis.
- When usable RR-derived HRV, blood pressure, or pulse oximetry exists, use repeated within-session build, climax, or recovery changes to deepen the cardiovascular, oxygenation, and autonomic context without treating session HRV, BP, or SpO2 as resting-baseline diagnostic measurements.
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
  const apButtonDisabledReason = loading
    ? ""
    : profileLoading
      ? "Waiting for saved profile context to finish loading."
      : evidenceLoading
        ? "Waiting for saved session evidence to finish loading."
        : !userProfile
          ? "Profile context is not loaded yet."
          : "";
  const apButtonDisabled = Boolean(loading || apButtonDisabledReason);

  return (
    <SectionCard icon={<Activity className="w-4 h-4" />} title="Anatomical & Physiological Profile" color="hsl(var(--chart-2))" defaultCollapsed={true}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Evidence-grounded anatomy, dynamic function, fit, and instrumentation synthesis from your optional profile data and supported session findings.
        </p>
        <Button size="sm" onClick={analyze} disabled={apButtonDisabled} title={apButtonDisabledReason || undefined} className="h-7 text-xs gap-1.5 shrink-0">
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
      {result && apButtonDisabledReason && (
        <p className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          Re-generate is waiting: {apButtonDisabledReason}
        </p>
      )}
      {result && timelineLoading && !apButtonDisabledReason && (
        <p className="rounded-lg border border-primary/15 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
          HR timelines are still loading in the background. You can re-generate now; Sarah will use the timeline data already available.
        </p>
      )}
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
  const nearClimaxButtonDisabledReason = loading
    ? ""
    : timelineLoading
      ? "Waiting for heart-rate timelines to finish loading."
      : "";
  const nearClimaxButtonDisabled = Boolean(loading || nearClimaxButtonDisabledReason);

  return (
    <SectionCard icon={<Zap className="w-4 h-4" />} title="Near-Climax Event Analysis" color="hsl(var(--chart-3))" defaultCollapsed={true}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Detects erratic HR spikes & reversals that resemble — but don't complete — a climax cascade.</p>
        <Button size="sm" onClick={analyze} disabled={nearClimaxButtonDisabled} title={nearClimaxButtonDisabledReason || undefined} className="h-7 text-xs gap-1.5 shrink-0">
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
      {result && nearClimaxButtonDisabledReason && (
        <p className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          Re-run is waiting: {nearClimaxButtonDisabledReason}
        </p>
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
  const methodsButtonDisabledReason = loading
    ? ""
    : evidenceLoading
      ? "Waiting for saved session evidence to finish loading."
      : sessions.length < 2
        ? "Need at least two sessions before analyzing methods."
        : "";
  const methodsButtonDisabled = Boolean(loading || methodsButtonDisabledReason);

  return (
    <SectionCard icon={<Zap className="w-4 h-4" />} title="Stimulation Methods Analysis" color="hsl(var(--primary))" defaultCollapsed={true}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          How each stimulation method affects your physiology, arousal, and climax outcomes across sessions.
        </p>
        <Button size="sm" onClick={analyze} disabled={methodsButtonDisabled} title={methodsButtonDisabledReason || undefined} className="h-7 text-xs gap-1.5 shrink-0 ml-2">
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
      {result && methodsButtonDisabledReason && (
        <p className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          Re-generate is waiting: {methodsButtonDisabledReason}
        </p>
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
      .then((profile) => {
        if (cancelled) return null;
        setUserProfile(profile);
        setProfileContextLoading(false);
        return loadLatestProfilerAnalysis().then((latestProfilerAnalysis) => {
          if (!cancelled && latestProfilerAnalysis) {
            setUserProfile((current) => mergeProfilerResultsIntoProfile(current || profile, latestProfilerAnalysis));
          }
        });
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
    const me = await loadUserProfileWithProfilerResults();
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

      <div id="profiler-ai-profile" className="scroll-mt-24">
        <AIProfilePanel sessions={sessions} userProfile={userProfile} journals={journals} evidenceLoading={sessionEvidenceLoading} />
      </div>
      <div id="profiler-anatomical-profile" className="scroll-mt-24">
        <AnatomicalPhysiologicalProfilePanel
          sessions={sessions}
          allTimelines={allTimelines}
          userProfile={userProfile}
          profileLoading={profileContextLoading}
          evidenceLoading={sessionEvidenceLoading}
          timelineLoading={timelineLoading}
        />
      </div>
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
      <div id="profiler-stimulation-methods" className="scroll-mt-24">
        <StimulationMethodsPanel sessions={sessions} userProfile={userProfile} evidenceLoading={sessionEvidenceLoading} />
      </div>
      <div id="profiler-near-climax" className="scroll-mt-24">
        <NearClimaxPanel sessions={sessions} allTimelines={allTimelines} userProfile={userProfile} timelineLoading={timelineLoading} />
      </div>
    </div>
  );
}
