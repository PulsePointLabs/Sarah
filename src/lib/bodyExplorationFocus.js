const PROCEDURE_RE = /\b(foley|catheter|urethral|urethra|meatus|meatal|bladder|balloon|statlock|leg\s*bag|drainage|dwell|insertion|sounding|dilat(?:e|ion)|instrumentation)\b/i;
const FOLEY_RE = /\b(foley|catheter|20\s*fr|18\s*fr|french|balloon|statlock|leg\s*bag|drainage|urine return|urethral|meatus|meatal)\b/i;
const PROCEDURE_ALLOWED_RE = /\b(sterile|field|prep|preparation|drape|swab|iodine|glans|foreskin|meatus|meatal|urethra|urethral|lubricat|catheter|foley|french|fr\b|advanc|insert|passage|sphincter|resistance|relax|breath|angle|pressure|discomfort|pain|pinch|sensation|bracing|heart[-\s]?rate|telemetry|bladder|urine|return|balloon|seat|traction|drainage|secure|statlock|tubing|bag|dwell|ambulatory|blood|bleeding|bypass|leak|spasm|urgency|tolerance|comfort|prior|previous|18\s*fr|20\s*fr|kegel|pelvic|erection|tugging|subjective|annotation|visible|video|frame)\b/i;
const PERIPHERAL_RE = /\b(ankle|foot|feet|edema|beer|alcohol|hydration coaching|daily hydration|respiratory|cough|head-to-toe|dog bite|skin finding|follicular|striae|bruise|wound|leg swelling|vascular history|venous history|urine color|leg-bag urine image|later leg bag|systemic context)\b/i;
const PERIPHERAL_ALLOWED_WITH_PROCEDURE_RE = /\b(leg\s*bag|drainage|tubing|secure|statlock|ambulat|urine return|urine concentration|patency|flow|dwell|traction|placement|procedure|catheter|foley)\b/i;
const GENERIC_HYDRATION_RE = /\b(beer intake|daily hydration|hydrate more|hydration coaching|drink more water|urine color from a separate later|later leg-bag urine image)\b/i;
const LATER_LEG_BAG_CONTEXT_RE = /\b(later[-\s]+leg[-\s]+bag|urine color from a separate later|separate later leg[-\s]+bag|later urine image)\b/i;
const LATER_LEG_BAG_ALLOWED_RE = /\b(flow|patency|blocked|obstruct|kink|tubing|securement|traction|dwell function|drainage function|bypass|leak)\b/i;
const TIMESTAMP_RE = /\b(?:\d{1,2}:\d{2}|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)[-\s]+minutes?)\b/gi;

export const FOCUSED_FOLEY_SECTION_DEFS = [
  { key: "procedural_course", label: "Procedural Course" },
  { key: "clinical_interpretation", label: "Clinical Interpretation" },
  { key: "body_response_felt_experience", label: "Body Response & Felt Experience" },
  { key: "placement_confidence", label: "Placement Confidence & Immediate Outcome" },
  { key: "prior_comparison", label: "Comparison With Previous Insertions" },
  { key: "focused_follow_up", label: "Focused Follow-Up" },
];

function compactText(value, max = 900) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function flattenExplorationText(exploration = {}) {
  return [
    exploration.title,
    exploration.exploration_type,
    exploration.purpose,
    exploration.methods,
    exploration.devices,
    exploration.foley_size,
    exploration.foley_type,
    exploration.sounding_notes,
    exploration.comfort_notes,
    exploration.findings,
    exploration.notes,
    exploration.unusual_sensations,
    ...(Array.isArray(exploration.tags) ? exploration.tags : []),
    ...(Array.isArray(exploration.event_timeline) ? exploration.event_timeline.map((event) => event?.note) : []),
  ].filter(Boolean).join(" ");
}

export function isFocusedFoleyExploration(exploration = {}) {
  const text = flattenExplorationText(exploration);
  return FOLEY_RE.test(text) && PROCEDURE_RE.test(text);
}

function shouldKeepProfileEntry(key, value) {
  const combined = `${key}: ${compactText(value, 500)}`;
  if (!PROCEDURE_RE.test(combined) && !/\b(thca|cannabis|anxiety|relax|dissociat|pain|discomfort|pelvic|kegel|erection|tugging|dwell)\b/i.test(combined)) {
    return false;
  }
  if (/\b(ankle|edema|beer|respiratory|dog bite|head-to-toe|follicular|striae)\b/i.test(combined) && !PERIPHERAL_ALLOWED_WITH_PROCEDURE_RE.test(combined)) {
    return false;
  }
  return true;
}

export function buildFocusedFoleyProfileContext(userProfile = {}) {
  const lines = [];
  const visit = (value, path = []) => {
    if (lines.length >= 28 || value == null) return;
    if (Array.isArray(value)) {
      value.slice(0, 20).forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }
    if (typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => visit(item, [...path, key]));
      return;
    }
    const key = path.filter((part) => !/^\d+$/.test(part)).slice(-3).join(".");
    const text = compactText(value, 700);
    if (text && shouldKeepProfileEntry(key, text)) {
      lines.push(`- ${key || "profile"}: ${text}`);
    }
  };
  visit(userProfile);
  return lines.length
    ? `FOCUSED FOLEY-RELEVANT LONGITUDINAL CONTEXT:\n${lines.join("\n")}`
    : "FOCUSED FOLEY-RELEVANT LONGITUDINAL CONTEXT:\n- No saved Foley-specific profile context was found. Use only this procedure record, annotations, visual evidence, and telemetry.";
}

export const FOCUSED_FOLEY_RELEVANCE_RULE = `
FOCUSED FOLEY INSERTION RELEVANCE GATE - HIGH PRIORITY:
- This is a focused Foley catheter insertion/procedure analysis, not a general body exploration or longitudinal health review.
- Include only material directly connected to: sterile field/prep, genital or meatal preparation, catheter lubrication, meatal engagement, urethral advancement, resistance points, pelvic relaxation, discomfort or sensation, visible bracing/lack of bracing, meaningful heart-rate response, bladder entry, urine return, balloon inflation, balloon seating, drainage, securement, immediate post-placement comfort, short-term dwell observations, and concise comparison with prior catheter sizes or insertion sessions.
- Exclude peripheral findings unless they materially affect placement, securement, drainage, ambulation, perception, relaxation, anxiety, discomfort, or dwell comfort.
- Normally omit unrelated foot or ankle edema, unrelated skin findings, unrelated injuries, Head-to-Toe findings, beer intake, generic hydration coaching, later urine-color images, respiratory/cardiovascular background, unrelated sexual-response findings, and unrelated historical diagnoses.
- When a peripheral factor is relevant, name the procedural connection in the same sentence. If the connection is not clear, omit it.
- Once the focused procedure, body response, placement outcome, relevant comparison, and procedure-specific monitoring have been addressed, stop. Do not fill the report with other profile findings.
`;

export const FOCUSED_FOLEY_NARRATIVE_RULE = `
FOCUSED FOLEY NARRATIVE STRUCTURE:
A. Clinical Overview: catheter type/size, duration, technical success, tolerance, main resistance point, maximum discomfort, urine return, balloon seating, immediate dwell status, and one or two conclusions.
B. Procedural Course: meaningful phases only: preparation/sterile field; meatal engagement and distal passage; primary resistance point; proximal passage and bladder entry; urine return, balloon inflation, seating; immediate post-placement transition.
C. Clinical Interpretation: explain whether placement appeared smooth, moderately difficult, or difficult; where resistance mattered; whether relaxation, breathing, angle change, or continued pressure helped; whether heart rate supports calm tolerance, anticipation, discomfort, exertion, or no meaningful autonomic response; whether absence of bracing, withdrawal, bleeding, severe discomfort, or HR escalation matters; whether size changed tolerance; and what deserves caution.
D. Body Response and Felt Experience: integrate subjective annotations, visible behavior, and telemetry. Include clinician-observer/dissociative state, deliberate pelvic relaxation, breathing, discomfort character, bracing/lack of bracing, and transition into background awareness when supported.
E. Placement Confidence and Immediate Outcome: separate visual observation, subjective annotation, telemetry-supported interpretation, and historical comparison while summarizing advancement, urine return, balloon inflation without concerning pain, seating, drainage, tubing/bag state, ambulation, and absence of visible complications when supported.
F. Comparison With Previous Insertions: use prior sessions only when comparison adds value, such as 18 Fr versus 20 Fr, resistance, meatal awareness, erection-related tugging, Kegel sensation, and dwell comfort.
G. Focused Follow-Up: only procedure-specific monitoring: urine flow, tubing patency, meatal irritation, bleeding, bypass leakage, bladder spasms/urgency, securement/traction, erection-related tugging, pelvic-floor sensation during dwell, and comfort versus prior catheter size.

Reduce play-by-play:
- Do not narrate every timestamp, hand motion, pause, or HR sample.
- Each major fact has one primary home: timeline/mechanics in Procedural Course; meaning in Clinical Interpretation; subjective experience in Body Response; placement evidence in Placement Confidence; prior differences in Comparison; future monitoring in Focused Follow-Up.
- Use timestamps selectively for major events only.
- Summarize telemetry as ranges and response patterns rather than reciting samples.
- Medium-length sentences. Avoid huge multi-clause sentences. Keep it natural for TTS.
`;

export function focusedFoleyResponseSchema() {
  return {
    type: "object",
    properties: {
      clinical_overview: { type: "string" },
      procedural_course: { type: "array", items: { type: "string" } },
      clinical_interpretation: { type: "array", items: { type: "string" } },
      body_response_felt_experience: { type: "array", items: { type: "string" } },
      placement_confidence: { type: "array", items: { type: "string" } },
      prior_comparison: { type: "array", items: { type: "string" } },
      focused_follow_up: { type: "array", items: { type: "string" } },
    },
    required: [
      "clinical_overview",
      "procedural_course",
      "clinical_interpretation",
      "body_response_felt_experience",
      "placement_confidence",
      "prior_comparison",
      "focused_follow_up",
    ],
  };
}

export function focusedFoleyPromptBlock() {
  return `${FOCUSED_FOLEY_RELEVANCE_RULE}\n\n${FOCUSED_FOLEY_NARRATIVE_RULE}`;
}

export function isFocusedProcedureRelevantText(text) {
  const value = compactText(text, 3000);
  if (!value) return false;
  if (LATER_LEG_BAG_CONTEXT_RE.test(value) && !LATER_LEG_BAG_ALLOWED_RE.test(value)) return false;
  if (GENERIC_HYDRATION_RE.test(value) && !PERIPHERAL_ALLOWED_WITH_PROCEDURE_RE.test(value)) return false;
  if (PERIPHERAL_RE.test(value) && !PERIPHERAL_ALLOWED_WITH_PROCEDURE_RE.test(value)) return false;
  return PROCEDURE_ALLOWED_RE.test(value) || !PERIPHERAL_RE.test(value);
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return value ? [String(value)] : [];
  return value.map((item) => compactText(item, 1400)).filter(Boolean);
}

function splitLongSentences(text, maxLength = 360) {
  return compactText(text, 2200)
    .split(/(?<=[.!?])\s+/)
    .flatMap((sentence) => {
      if (sentence.length <= maxLength) return [sentence];
      return sentence
        .replace(/;\s+/g, ". ")
        .replace(/\s+-\s+/g, ". ")
        .split(/(?<=[.!?])\s+/)
        .flatMap((part) => part.length <= maxLength ? [part] : part.split(/,\s+(?=(?:and|but|while|with|without|which|because)\b)/i));
    })
    .map((part) => compactText(part, maxLength + 80))
    .filter(Boolean)
    .join(" ");
}

function cleanFocusedRows(rows) {
  return normalizeArray(rows)
    .map((row) => splitLongSentences(row))
    .filter(isFocusedProcedureRelevantText);
}

export function classifyFocusedProcedureProvenance(text) {
  const value = compactText(text, 1600);
  const labels = [];
  if (/\b(note|annotat|reported|felt|sensation|discomfort|pinch|urge|relax|breath|clinician-observer|dissociat)\b/i.test(value)) labels.push("subjective annotation");
  if (/\b(visible|video|frame|reviewed|showed|seen|hand|body|bracing|blood|leak|tubing|bag|statlock)\b/i.test(value)) labels.push("visual observation");
  if (/\b(heart[-\s]?rate|hr\b|telemetry|beats per minute|range|spike|stable|rose|dropped|plateau)\b/i.test(value)) labels.push("telemetry supported");
  if (/\b(prior|previous|18\s*fr|20\s*fr|compared|last insertion|earlier catheter)\b/i.test(value)) labels.push("historical comparison");
  if (/\b(suggests?|suggesting|supports?|appears?|likely|notable|clinically|evidence|confidence|concern|monitor|watch|absence)\b/i.test(value)) labels.push("clinical interpretation");
  return labels.length ? labels : ["clinical interpretation"];
}

function buildProvenanceDebug(analysis) {
  const entries = [];
  const add = (section, text) => {
    if (!text) return;
    entries.push({
      section,
      text: compactText(text, 320),
      provenance: classifyFocusedProcedureProvenance(text),
    });
  };
  add("clinical_overview", analysis.clinical_overview);
  FOCUSED_FOLEY_SECTION_DEFS.forEach((section) => {
    normalizeArray(analysis[section.key]).forEach((text) => add(section.key, text));
  });
  return entries;
}

export function normalizeFocusedFoleyAnalysis(raw) {
  const parsed = raw?.response ?? raw ?? {};
  const analysis = {
    clinical_overview: splitLongSentences(parsed.clinical_overview || parsed.summary || ""),
    procedural_course: cleanFocusedRows(parsed.procedural_course || parsed.mechanical_findings),
    clinical_interpretation: cleanFocusedRows(parsed.clinical_interpretation || parsed.telemetry_findings),
    body_response_felt_experience: cleanFocusedRows(parsed.body_response_felt_experience || parsed.comfort_safety_findings),
    placement_confidence: cleanFocusedRows(parsed.placement_confidence || parsed.comfort_safety_findings || parsed.mechanical_findings),
    prior_comparison: cleanFocusedRows(parsed.prior_comparison),
    focused_follow_up: cleanFocusedRows(parsed.focused_follow_up || parsed.recommendations),
  };

  if (!isFocusedProcedureRelevantText(analysis.clinical_overview)) {
    analysis.clinical_overview = "";
  }
  if (!analysis.clinical_overview || !analysis.procedural_course.length || !analysis.clinical_interpretation.length || !analysis.placement_confidence.length) {
    throw new Error("AI returned an incomplete focused Foley insertion analysis. Please try again.");
  }

  analysis.summary = analysis.clinical_overview;
  analysis._focus = {
    mode: "foley_insertion",
    relevance_gate: "focused_procedure_fail_closed",
    section_model: "focused_foley_v1",
  };
  analysis._debug_provenance = buildProvenanceDebug(analysis);
  return analysis;
}
