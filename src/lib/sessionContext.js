export const SESSION_CONTEXT_GROUNDING_RULE = `SESSION CONTEXT GROUNDING:
- Prefer explicitly logged structured session context over inference.
- Treat absent or unknown context as unknown.
- Do not attribute effects to alcohol, cannabis, fatigue, hydration, food state, stress, privacy, or preparation unless explicitly logged or clearly framed as a possibility.
- Preserve natural synthesis; use context only when it meaningfully informs interpretation.`;

export const FATIGUE_OPTIONS = [
  { value: "very_rested", label: "Very rested" },
  { value: "rested", label: "Rested" },
  { value: "neutral", label: "Neutral" },
  { value: "tired", label: "Tired" },
  { value: "exhausted", label: "Exhausted" },
  { value: "unknown", label: "Not recorded" },
];

export const HYDRATION_OPTIONS = [
  { value: "poor", label: "Poor" },
  { value: "fair", label: "Fair" },
  { value: "good", label: "Good" },
  { value: "electrolyte_supported", label: "Intentionally hydrated / electrolyte supported" },
  { value: "unknown", label: "Not recorded" },
];

export const FOOD_OPTIONS = [
  { value: "fasting", label: "Fasting" },
  { value: "light_meal", label: "Light meal" },
  { value: "normal_meal", label: "Normal meal" },
  { value: "heavy_meal", label: "Heavy meal" },
  { value: "unknown", label: "Not recorded" },
];

export const TIMING_OPTIONS = [
  { value: "during_session", label: "During session" },
  { value: "under_30_min", label: "Under 30 minutes before" },
  { value: "30_to_90_min", label: "30 to 90 minutes before" },
  { value: "over_90_min", label: "Over 90 minutes before" },
  { value: "earlier_same_day", label: "Earlier the same day" },
  { value: "unknown", label: "Not recorded" },
];

export const LEVEL_OPTIONS = [
  { value: "mild", label: "Mild" },
  { value: "moderate", label: "Moderate" },
  { value: "significant", label: "Significant" },
  { value: "unknown", label: "Not recorded" },
];

export const CANNABIS_ROUTE_OPTIONS = [
  { value: "smoked", label: "Smoked" },
  { value: "vaped", label: "Vaped" },
  { value: "edible", label: "Edible" },
  { value: "other", label: "Other" },
  { value: "unknown", label: "Not recorded" },
];

export const MENTAL_STATE_OPTIONS = [
  { value: "calm", label: "Calm" },
  { value: "mildly_distracted", label: "Mildly distracted" },
  { value: "stressed", label: "Stressed" },
  { value: "emotionally_activated", label: "Emotionally activated" },
  { value: "exploratory", label: "Experimental / exploratory" },
  { value: "meditative", label: "Meditative" },
];

export const PRIVACY_OPTIONS = [
  { value: "fully_private", label: "Fully private" },
  { value: "moderate_risk", label: "Moderate interruption risk" },
  { value: "high_risk", label: "High interruption risk" },
  { value: "unknown", label: "Not recorded" },
];

export const PREPARATION_OPTIONS = [
  { value: "showered_recently", label: "Showered recently" },
  { value: "tools_prepared", label: "Tools prepared" },
  { value: "room_prepared", label: "Room prepared" },
  { value: "media_prepared", label: "Media prepared" },
  { value: "telemetry_active", label: "Telemetry active" },
  { value: "rushed_start", label: "Rushed start" },
];

function labelFor(options, value) {
  return options.find((option) => option.value === value)?.label || String(value || "").replace(/_/g, " ");
}

function recordedValue(value) {
  return value && value !== "unknown";
}

function firstRecorded(...values) {
  return values.find(recordedValue);
}

function arrayValue(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
    if (recordedValue(value)) return [value];
  }
  return [];
}

function substanceText(label, value) {
  if (!value || typeof value.used !== "boolean") return null;
  if (!value.used) return `${label}: explicitly logged as none`;
  const detail = [
    label === "Cannabis" && recordedValue(value.route) ? labelFor(CANNABIS_ROUTE_OPTIONS, value.route) : null,
    recordedValue(value.qualitative_level) ? labelFor(LEVEL_OPTIONS, value.qualitative_level) : null,
    recordedValue(value.timing_relative_to_session) ? labelFor(TIMING_OPTIONS, value.timing_relative_to_session) : null,
  ].filter(Boolean);
  return `${label}: logged use${detail.length ? ` (${detail.join(", ")})` : ""}`;
}

export function structuredSessionContextForAI(session) {
  const context = session?.session_context || {};
  if (!context || typeof context !== "object") return undefined;
  const cleaned = {};
  if (context.alcohol && typeof context.alcohol.used === "boolean") cleaned.alcohol = context.alcohol;
  if (context.cannabis && typeof context.cannabis.used === "boolean") cleaned.cannabis = context.cannabis;
  const fatigue = firstRecorded(context.fatigue, session?.fatigue);
  const hydration = firstRecorded(context.hydration_state, context.hydrationState, session?.hydration_state, session?.hydration);
  const foodState = firstRecorded(context.food_state, context.foodState, session?.food_state, session?.foodState);
  const privacy = firstRecorded(context.privacy_interruptibility, context.privacy, session?.privacy_interruptibility, session?.privacy);
  if (fatigue) cleaned.fatigue = fatigue;
  if (hydration) cleaned.hydration_state = hydration;
  if (foodState) cleaned.food_state = foodState;
  if (privacy) cleaned.privacy_interruptibility = privacy;
  const mentalState = arrayValue(context.mental_state, context.mentalState, session?.mental_state, session?.mentalState, session?.mood);
  if (mentalState.length) cleaned.mental_state = mentalState;
  const preparation = arrayValue(context.environmental_preparation, context.preparation, session?.environmental_preparation, session?.preparation);
  if (preparation.length) cleaned.environmental_preparation = preparation;
  return Object.keys(cleaned).length ? cleaned : undefined;
}

export function sessionContextEvidenceItems(session) {
  const context = structuredSessionContextForAI(session);
  if (!context) return [];
  return [
    substanceText("Alcohol", context.alcohol),
    substanceText("Cannabis", context.cannabis),
    recordedValue(context.fatigue) ? `Fatigue: ${labelFor(FATIGUE_OPTIONS, context.fatigue)}` : null,
    recordedValue(context.hydration_state) ? `Hydration: ${labelFor(HYDRATION_OPTIONS, context.hydration_state)}` : null,
    recordedValue(context.food_state) ? `Food state: ${labelFor(FOOD_OPTIONS, context.food_state)}` : null,
    context.mental_state?.length ? `Mental state: ${context.mental_state.map((value) => labelFor(MENTAL_STATE_OPTIONS, value)).join(", ")}` : null,
    recordedValue(context.privacy_interruptibility) ? `Privacy: ${labelFor(PRIVACY_OPTIONS, context.privacy_interruptibility)}` : null,
    context.environmental_preparation?.length ? `Preparation: ${context.environmental_preparation.map((value) => labelFor(PREPARATION_OPTIONS, value)).join(", ")}` : null,
  ].filter(Boolean);
}

export function sessionContextEvidenceText(session) {
  return sessionContextEvidenceItems(session).join("; ");
}

export function sessionContextFactorLabels(session) {
  const evidence = sessionContextEvidenceItems(session);
  if (evidence.length) return evidence;
  return [session?.mood, session?.environment, session?.hydration, ...(session?.substances || [])].filter(Boolean);
}

export function sessionContextDisplayRows(session) {
  const context = structuredSessionContextForAI(session);
  const rows = [];
  if (context?.fatigue) rows.push({ label: "Fatigue", value: labelFor(FATIGUE_OPTIONS, context.fatigue) });
  if (context?.hydration_state) rows.push({ label: "Hydration", value: labelFor(HYDRATION_OPTIONS, context.hydration_state) });
  else if (session?.hydration) rows.push({ label: "Hydration", value: labelFor([], session.hydration) });
  if (context?.food_state) rows.push({ label: "Food State", value: labelFor(FOOD_OPTIONS, context.food_state) });
  const alcohol = substanceText("Alcohol", context?.alcohol);
  const cannabis = substanceText("Cannabis", context?.cannabis);
  if (alcohol) rows.push({ label: "Alcohol", value: alcohol.replace(/^Alcohol: /, "") });
  if (cannabis) rows.push({ label: "Cannabis", value: cannabis.replace(/^Cannabis: /, "") });
  if (context?.mental_state?.length) rows.push({ label: "Mental State", value: context.mental_state.map((value) => labelFor(MENTAL_STATE_OPTIONS, value)).join(", ") });
  else if (session?.mood) rows.push({ label: "Mood", value: labelFor([], session.mood) });
  if (context?.privacy_interruptibility) rows.push({ label: "Privacy", value: labelFor(PRIVACY_OPTIONS, context.privacy_interruptibility) });
  if (session?.environment) rows.push({ label: "Environment", value: labelFor([], session.environment) });
  if (context?.environmental_preparation?.length) rows.push({ label: "Preparation", value: context.environmental_preparation.map((value) => labelFor(PREPARATION_OPTIONS, value)).join(", ") });
  return rows;
}
