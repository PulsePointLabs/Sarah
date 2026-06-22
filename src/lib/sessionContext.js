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

function cleanBloodPressureReading(value = {}) {
  const systolic = Number(value.systolic_mm_hg ?? value.systolic);
  const diastolic = Number(value.diastolic_mm_hg ?? value.diastolic);
  if (!Number.isFinite(systolic) || !Number.isFinite(diastolic)) return null;
  const pulse = Number(value.pulse_bpm ?? value.pulse);
  return {
    id: value.id || value.reading_id || value.external_id || "",
    measured_at: value.measured_at || value.timestamp || value.time || "",
    systolic_mm_hg: Math.round(systolic),
    diastolic_mm_hg: Math.round(diastolic),
    pulse_bpm: Number.isFinite(pulse) ? Math.round(pulse) : null,
    source_app: value.source_app || value.sourceApp || "",
    source_device: value.source_device || value.sourceDevice || "",
    relationship: value.relationship || "",
  };
}

function cleanPulseOxReading(value = {}) {
  const spo2 = Number(value.spo2_percent ?? value.spo2 ?? value.oxygen_saturation ?? value.oxygen_saturation_percent);
  if (!Number.isFinite(spo2)) return null;
  const pulse = Number(value.pulse_bpm ?? value.pulse ?? value.pr_bpm ?? value.heart_rate_bpm ?? value.hr);
  const timeOffset = Number(value.time_offset_s);
  return {
    id: value.id || value.reading_id || value.external_id || "",
    measured_at: value.measured_at || value.timestamp || value.time || "",
    time_offset_s: Number.isFinite(timeOffset) ? timeOffset : null,
    spo2_percent: Math.round(spo2),
    pulse_bpm: Number.isFinite(pulse) ? Math.round(pulse) : null,
    perfusion_index: value.perfusion_index ?? value.pi ?? null,
    source_app: value.source_app || value.sourceApp || "",
    source_device: value.source_device || value.sourceDevice || "",
  };
}

export function bloodPressureReadingsFromSession(session) {
  const readings = [];
  const add = (value) => {
    const reading = cleanBloodPressureReading(value);
    if (!reading) return;
    const key = reading.id || `${reading.measured_at}-${reading.systolic_mm_hg}-${reading.diastolic_mm_hg}-${reading.pulse_bpm || ""}`;
    if (readings.some((item) => (item.id || `${item.measured_at}-${item.systolic_mm_hg}-${item.diastolic_mm_hg}-${item.pulse_bpm || ""}`) === key)) return;
    readings.push(reading);
  };

  add(session?.session_context?.blood_pressure);
  add(session?.latest_blood_pressure_reading);
  (session?.session_context?.blood_pressure_readings || []).forEach(add);
  (session?.blood_pressure_readings || []).forEach(add);
  (session?.event_timeline || []).forEach((event) => {
    add(event?.blood_pressure);
  });

  return readings.sort((a, b) => new Date(a.measured_at || 0).getTime() - new Date(b.measured_at || 0).getTime());
}

export function pulseOxReadingsFromSession(session) {
  const readings = [];
  const add = (value) => {
    const reading = cleanPulseOxReading(value);
    if (!reading) return;
    const key = reading.id || `${reading.measured_at}-${reading.time_offset_s}-${reading.spo2_percent}-${reading.pulse_bpm || ""}`;
    if (readings.some((item) => (item.id || `${item.measured_at}-${item.time_offset_s}-${item.spo2_percent}-${item.pulse_bpm || ""}`) === key)) return;
    readings.push(reading);
  };

  add(session?.session_context?.pulse_ox);
  add(session?.latest_pulse_ox_reading);
  (session?.session_context?.pulse_ox_readings || []).forEach(add);
  (session?.pulse_ox_readings || []).forEach(add);
  (session?.event_timeline || []).forEach((event) => {
    add(event?.pulse_ox);
  });

  return readings.sort((a, b) => {
    const at = new Date(a.measured_at || 0).getTime();
    const bt = new Date(b.measured_at || 0).getTime();
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
    return Number(a.time_offset_s || 0) - Number(b.time_offset_s || 0);
  });
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
  if (context.blood_pressure && typeof context.blood_pressure === "object") cleaned.blood_pressure = context.blood_pressure;
  const bpReadings = bloodPressureReadingsFromSession(session);
  if (bpReadings.length) cleaned.blood_pressure_readings = bpReadings;
  const pulseOxReadings = pulseOxReadingsFromSession(session);
  if (pulseOxReadings.length) {
    cleaned.pulse_ox_readings = pulseOxReadings;
    const spo2Values = pulseOxReadings.map((reading) => Number(reading.spo2_percent)).filter(Number.isFinite);
    const pulseValues = pulseOxReadings.map((reading) => Number(reading.pulse_bpm)).filter(Number.isFinite);
    cleaned.pulse_ox_summary = {
      samples: pulseOxReadings.length,
      min_spo2_percent: Math.min(...spo2Values),
      avg_spo2_percent: Math.round(spo2Values.reduce((sum, value) => sum + value, 0) / spo2Values.length),
      avg_pulse_bpm: pulseValues.length ? Math.round(pulseValues.reduce((sum, value) => sum + value, 0) / pulseValues.length) : null,
      max_pulse_bpm: pulseValues.length ? Math.max(...pulseValues) : null,
      source_app: pulseOxReadings.find((reading) => reading.source_app)?.source_app || session?.pulse_ox_source || "",
    };
  }
  return Object.keys(cleaned).length ? cleaned : undefined;
}

export function sessionContextEvidenceItems(session) {
  const context = structuredSessionContextForAI(session);
  if (!context) return [];
  const bp = context.blood_pressure;
  const bpReadings = context.blood_pressure_readings || [];
  const pulseOxSummary = context.pulse_ox_summary;
  const bpText = bp?.systolic_mm_hg && bp?.diastolic_mm_hg
    ? `Blood pressure: ${bp.systolic_mm_hg}/${bp.diastolic_mm_hg} mmHg${bp.pulse_bpm ? `, pulse ${bp.pulse_bpm} bpm` : ""}${bp.measured_at ? ` at ${new Date(bp.measured_at).toLocaleString()}` : ""}${bp.source_app ? ` (${bp.source_app})` : ""}`
    : null;
  const bpSeriesText = bpReadings.length > 1
    ? `Blood pressure series: ${bpReadings.map((reading) => `${reading.systolic_mm_hg}/${reading.diastolic_mm_hg}${reading.pulse_bpm ? ` pulse ${reading.pulse_bpm}` : ""}${reading.measured_at ? ` at ${new Date(reading.measured_at).toLocaleString()}` : ""}`).join("; ")}`
    : null;
  return [
    substanceText("Alcohol", context.alcohol),
    substanceText("Cannabis", context.cannabis),
    bpText,
    bpSeriesText,
    pulseOxSummary?.samples
      ? `Pulse oximetry: ${pulseOxSummary.samples} samples, average SpO2 ${pulseOxSummary.avg_spo2_percent}%, minimum SpO2 ${pulseOxSummary.min_spo2_percent}%${pulseOxSummary.avg_pulse_bpm ? `, average pulse ${pulseOxSummary.avg_pulse_bpm} bpm` : ""}${pulseOxSummary.source_app ? ` (${pulseOxSummary.source_app})` : ""}`
      : null,
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
  const bpReadings = bloodPressureReadingsFromSession(session);
  const pulseOxReadings = pulseOxReadingsFromSession(session);
  const rows = [];
  if (context?.fatigue) rows.push({ label: "Fatigue", value: labelFor(FATIGUE_OPTIONS, context.fatigue) });
  if (context?.hydration_state) rows.push({ label: "Hydration", value: labelFor(HYDRATION_OPTIONS, context.hydration_state) });
  else if (session?.hydration) rows.push({ label: "Hydration", value: labelFor([], session.hydration) });
  if (context?.food_state) rows.push({ label: "Food State", value: labelFor(FOOD_OPTIONS, context.food_state) });
  if (context?.blood_pressure?.systolic_mm_hg && context?.blood_pressure?.diastolic_mm_hg) {
    const bp = context.blood_pressure;
    const measured = bp.measured_at ? new Date(bp.measured_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    rows.push({
      label: "Blood Pressure",
      value: `${bp.systolic_mm_hg}/${bp.diastolic_mm_hg} mmHg${bp.pulse_bpm ? ` · ${bp.pulse_bpm} bpm` : ""}${measured ? ` · ${measured}` : ""}`,
    });
  }
  if (bpReadings.length > 1) {
    rows.push({
      label: "BP Readings",
      value: `${bpReadings.length} readings · latest ${bpReadings[bpReadings.length - 1].systolic_mm_hg}/${bpReadings[bpReadings.length - 1].diastolic_mm_hg} mmHg`,
    });
  }
  if (pulseOxReadings.length) {
    const summary = context?.pulse_ox_summary;
    rows.push({
      label: "Pulse Oximetry",
      value: summary
        ? `${summary.samples} samples · avg ${summary.avg_spo2_percent}% · min ${summary.min_spo2_percent}%${summary.avg_pulse_bpm ? ` · pulse ${summary.avg_pulse_bpm} bpm` : ""}`
        : `${pulseOxReadings.length} samples`,
    });
  }
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
