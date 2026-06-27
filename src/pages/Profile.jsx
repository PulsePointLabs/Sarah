import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { User, Heart, Scan, RefreshCw, CheckCircle, ChevronDown, ChevronUp, Flame, Ruler, MessageCircle } from "lucide-react";
import RichTextEditor from "../components/RichTextEditor";
import { richTextToCanonicalText } from "@/lib/richText";
import {
  backfillImageReviewFindingsFromChat,
  buildProfileQaFindingCards,
  normalizeProfileQaFindings,
  parseProfileQaFindingsFromText,
} from "@/lib/profileQa";

function Field({ label, hint, children }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-semibold text-foreground/80">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function NumInput({ value, onChange, placeholder, min, max }) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      placeholder={placeholder}
      className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
    />
  );
}

function TextInput({ value, onChange, placeholder }) {
  return (
    <input
      type="text"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
    />
  );
}

function SelectInput({ value, onChange, options, placeholder = "Not set" }) {
  const optionValues = options.map((option) => typeof option === "string" ? option : option.value);
  const hasSavedLegacyValue = value && !optionValues.includes(value);

  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
    >
      <option value="">{placeholder}</option>
      {hasSavedLegacyValue && <option value={value}>Saved: {value}</option>}
      {options.map((option) => {
        const valueOption = typeof option === "string" ? option : option.value;
        const label = typeof option === "string" ? option : option.label;
        return <option key={valueOption} value={valueOption}>{label}</option>;
      })}
    </select>
  );
}

const LENGTH_UNITS = ["inches", "cm"];
const DIAMETER_UNITS = ["mm", "inches"];
const DEFAULT_MECHANICAL_PROFILE = {
  flaccid_length: { value: null, unit: "inches" },
  flaccid_mid_shaft_diameter: { value: null, unit: "mm" },
  flaccid_base_diameter: { value: null, unit: "mm" },
  flaccid_widest_glans_diameter: { value: null, unit: "mm" },
  bone_pressed_erect_length: { value: null, unit: "inches" },
  visible_erect_length: { value: null, unit: "inches" },
  mid_shaft_diameter: { value: null, unit: "mm" },
  base_diameter: { value: null, unit: "mm" },
  below_glans_diameter: { value: null, unit: "mm" },
  widest_glans_diameter: { value: null, unit: "mm" },
  visible_meatal_vertical_length: { value: null, unit: "mm" },
  visible_meatal_horizontal_width: { value: null, unit: "mm" },
  foley_discomfort_factors: [],
};

const FORESKIN_OPTIONS = ["Fully retracted", "Partially retracted", "Variable", "Not applicable"];
const GLANS_SENSITIVITY_OPTIONS = ["Low", "Moderate", "High", "Very high", "Variable"];
const YES_NO_VARIABLE_OPTIONS = ["Yes", "No", "Variable"];
const MEATAL_SHAPE_OPTIONS = [
  "Slit-shaped (vertical)",
  "Slit-shaped (horizontal)",
  "Oval",
  "Round",
  "Irregular / asymmetric",
  "Prefer not to specify",
];
const MEATAL_MOBILITY_OPTIONS = [
  "Minimal change",
  "Slight widening",
  "Noticeable widening",
  "Significant shape change",
  "Variable",
  "Not sure",
];
const MEATAL_SENSITIVITY_OPTIONS = ["Low", "Moderate", "High", "Very high", "Variable"];
const MEATAL_DEVICE_STABILITY_OPTIONS = [
  "Very stable",
  "Stable",
  "Variable",
  "Movement noticeable",
  "Highly sensitive to movement",
];
const ERECTION_STABILITY_OPTIONS = ["Very stable", "Stable", "Variable", "Unstable"];
const NEAR_THRESHOLD_OPTIONS = ["Remains rigid", "Slight softening", "Noticeable softening", "Variable"];
const RECOVERY_EFFECTIVENESS_OPTIONS = ["Poor", "Moderate", "Good", "Excellent", "Not applicable"];
const HAND_EFFECTIVENESS_OPTIONS = ["More effective", "Less effective", "Same", "Variable"];
const SLEEVE_FIT_OPTIONS = ["Too loose", "Slightly loose", "Ideal", "Slightly tight", "Overly compressive", "Variable"];
const DEVICE_MOVEMENT_OPTIONS = ["Low", "Moderate", "High"];
const FOLEY_DISCOMFORT_OPTIONS = [
  "Meatal tension",
  "Device movement",
  "Balloon awareness",
  "Urethral pressure",
  "Irritation after prolonged wear",
  "Friction",
  "Other",
];
const RICH_TEXT_MECHANICAL_FIELDS = [
  "resting_glans_observations",
  "resting_foreskin_coverage_mobility",
  "resting_curvature_orientation",
  "resting_meatal_observations",
  "resting_urethral_accommodation_notes",
  "erect_glans_observations",
  "erect_curvature_orientation",
  "meatal_tension_fit_notes",
  "erect_meatal_observations",
  "erect_urethral_accommodation_notes",
  "flaccid_to_erect_expansion_characteristics",
  "relative_girth_expansion",
  "rigidity_compliance_observations",
  "tissue_response_observations",
  "fit_variability_by_state",
  "sensitivity_differences_by_state",
  "pressure_distribution_observations",
  "accommodation_differences_by_state",
  "device_interaction_observations",
  "repeated_instrumentation_fit_findings",
  "erect_functional_observations",
  "additional_functional_notes",
];

function normalizeMechanicalProfile(profile) {
  const normalized = { ...DEFAULT_MECHANICAL_PROFILE, ...(profile || {}) };
  Object.keys(DEFAULT_MECHANICAL_PROFILE).forEach((key) => {
    if (DEFAULT_MECHANICAL_PROFILE[key]?.unit) {
      normalized[key] = { ...DEFAULT_MECHANICAL_PROFILE[key], ...(profile?.[key] || {}) };
    }
  });
  normalized.foley_discomfort_factors = Array.isArray(normalized.foley_discomfort_factors)
    ? normalized.foley_discomfort_factors
    : [];
  RICH_TEXT_MECHANICAL_FIELDS.forEach((key) => {
    normalized[key] = richTextToCanonicalText(normalized[key]);
  });
  if (normalized.visible_meatal_horizontal_width?.value == null && normalized.visible_meatal_width_mm != null) {
    normalized.visible_meatal_horizontal_width = {
      value: normalized.visible_meatal_width_mm,
      unit: "mm",
    };
  }
  return normalized;
}

function roundMeasurement(value, unit) {
  if (value == null || Number.isNaN(Number(value))) return null;
  const precision = unit === "inches" ? 3 : 2;
  return Number(Number(value).toFixed(precision));
}

function convertMeasurement(value, from, to) {
  if (value == null || from === to) return value;
  if (from === "inches" && to === "cm") return roundMeasurement(Number(value) * 2.54, to);
  if (from === "cm" && to === "inches") return roundMeasurement(Number(value) / 2.54, to);
  if (from === "inches" && to === "mm") return roundMeasurement(Number(value) * 25.4, to);
  if (from === "mm" && to === "inches") return roundMeasurement(Number(value) / 25.4, to);
  return value;
}

function UnitNumberField({ label, hint, measure, units, onChange, min = 0, placeholder }) {
  const value = measure || { value: null, unit: units[0] };
  const selectUnit = (unit) => onChange({
    value: convertMeasurement(value.value, value.unit, unit),
    unit,
  });

  return (
    <div className="space-y-1">
      <label className="text-xs font-semibold text-foreground/80">{label}</label>
      <div className="flex gap-2">
        <input
          type="number"
          min={min}
          step="any"
          value={value.value ?? ""}
          onChange={(e) => onChange({ ...value, value: e.target.value === "" ? null : Number(e.target.value) })}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <div className="flex shrink-0 rounded-lg border border-border bg-background p-1">
          {units.map((unit) => (
            <button
              key={unit}
              type="button"
              onClick={() => selectUnit(unit)}
              className={`rounded-md px-2 py-1 text-xs font-medium ${value.unit === unit ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            >
              {unit}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  );
}

function MultiSelectButtons({ options, selected, onChange }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const active = selected.includes(option);
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(active ? selected.filter((item) => item !== option) : [...selected, option])}
            className="px-3 py-1 rounded-full text-xs font-medium border transition-colors"
            style={active
              ? { background: "hsl(var(--accent))", color: "hsl(var(--accent-foreground))", borderColor: "hsl(var(--accent))" }
              : { borderColor: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

const AROUSAL_RESPONSE_OPTIONS = [
  { value: "gradual", label: "Gradual" },
  { value: "rapid", label: "Rapid" },
  { value: "stepwise", label: "Stepwise" },
  { value: "plateau-heavy", label: "Plateau-heavy" },
  { value: "erratic", label: "Erratic" },
];

const BUILD_DURATION_OPTIONS = [
  { value: "short (<10min)", label: "Short (<10min)" },
  { value: "medium (10-30min)", label: "Medium (10–30min)" },
  { value: "long (>30min)", label: "Long (>30min)" },
];

const SENSITIVITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "moderate", label: "Moderate" },
  { value: "high", label: "High" },
  { value: "very high", label: "Very High" },
];

const REFRACTORY_OPTIONS = [
  { value: "short (<15min)", label: "Short (<15min)" },
  { value: "medium (15-60min)", label: "Medium (15–60min)" },
  { value: "long (>1hr)", label: "Long (>1hr)" },
  { value: "variable", label: "Variable" },
];

const PREFERRED_STIM_OPTIONS = [
  "Foley Catheter", "Coyote E-Stim", "Silicone Sleeve", "TENS",
  "Manual", "Vibration", "Edging", "Other"
];

const FITNESS_OPTIONS = [
  { value: "sedentary", label: "Sedentary" },
  { value: "light", label: "Light" },
  { value: "moderate", label: "Moderate" },
  { value: "active", label: "Active" },
  { value: "athlete", label: "Athlete" },
];

export default function Profile() {
  const [user, setUser] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [computing, setComputing] = useState(false);
  const [computedRecovery, setComputedRecovery] = useState(null);
  const [mechanicalOpen, setMechanicalOpen] = useState(false);
  const [profileLoadError, setProfileLoadError] = useState("");
  const [profileReloadToken, setProfileReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setProfileLoadError("");
    setUser(null);
    base44.auth.me().then((u) => {
      if (cancelled) return;
      const savedQaFindings = normalizeProfileQaFindings(u.profile_qa_findings);
      const importedQaFindings = savedQaFindings.length ? savedQaFindings : parseProfileQaFindingsFromText(u.arousal_notes);
      const savedChatMessages = u.profile_chat_messages || [];
      const imageReviewBackfills = backfillImageReviewFindingsFromChat(savedChatMessages, importedQaFindings, u.first_name);
      const qaFindingsWithBackfills = imageReviewBackfills.length
        ? normalizeProfileQaFindings([...imageReviewBackfills, ...importedQaFindings])
        : importedQaFindings;
      setUser(u);
      setForm({
        first_name: u.first_name ?? "",
        age: u.age ?? null,
        weight_kg: u.weight_kg ?? null,
        resting_hr: u.resting_hr ?? null,
        max_hr: u.max_hr ?? null,
        recovery_hr_60s: u.recovery_hr_60s ?? null,
        medications: richTextToCanonicalText(u.medications ?? ""),
        fitness_level: u.fitness_level ?? "moderate",
        arousal_response_style: u.arousal_response_style ?? null,
        typical_build_duration: u.typical_build_duration ?? null,
        climax_sensitivity: u.climax_sensitivity ?? null,
        preferred_stimulation: u.preferred_stimulation ?? [],
        refractory_pattern: u.refractory_pattern ?? null,
        arousal_notes: richTextToCanonicalText(u.arousal_notes ?? ""),
        profile_qa_findings: qaFindingsWithBackfills,
        anatomical_mechanical_profile: normalizeMechanicalProfile(u.anatomical_mechanical_profile),
      });
      if (!savedQaFindings.length && importedQaFindings.length && !imageReviewBackfills.length) {
        base44.auth.updateMe({ profile_qa_findings: importedQaFindings }).catch(() => {});
      }
      if (imageReviewBackfills.length) {
        base44.auth.updateMe({ profile_qa_findings: qaFindingsWithBackfills }).catch(() => {});
      }
    }).catch((error) => {
      if (cancelled) return;
      setProfileLoadError(error?.message || "Sarah could not load the profile record.");
    });
    return () => {
      cancelled = true;
    };
  }, [profileReloadToken]);

  // Auto-compute recovery HR from session HR timelines
  const computeRecovery = async () => {
    setComputing(true);
    const sessions = await base44.entities.Session.list("-date", 50);
    const withPeak = sessions.filter((s) => s.climax_offset_s != null);
    if (!withPeak.length) { setComputing(false); return; }

    const drops = [];
    for (const s of withPeak.slice(0, 20)) {
      const rows = await base44.entities.HeartRateTimeline.filter({ session: s.id }, "time_offset_s", 5000);
      if (rows.length < 5) continue;
      const peakIdx = rows.reduce((best, r, i) => Number(r.hr) > Number(rows[best].hr) ? i : best, 0);
      const peakHr = Number(rows[peakIdx].hr);
      const peakTime = Number(rows[peakIdx].time_offset_s);
      const r60 = rows.find((r) => Number(r.time_offset_s) >= peakTime + 60);
      if (r60) drops.push(peakHr - Number(r60.hr));
    }

    if (drops.length > 0) {
      const avg = Math.round(drops.reduce((a, b) => a + b, 0) / drops.length);
      setComputedRecovery(avg);
      setForm((f) => ({ ...f, recovery_hr_60s: avg }));
    }
    setComputing(false);
  };

  const save = async () => {
    setSaving(true);
    const canonicalForm = {
      ...form,
      first_name: String(form.first_name || "").trim() || null,
      medications: richTextToCanonicalText(form.medications),
      arousal_notes: richTextToCanonicalText(form.arousal_notes),
      profile_qa_findings: normalizeProfileQaFindings(form.profile_qa_findings),
      anatomical_mechanical_profile: normalizeMechanicalProfile(form.anatomical_mechanical_profile),
    };
    await base44.auth.updateMe(canonicalForm);
    setForm(canonicalForm);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };
  const mechanicalProfile = normalizeMechanicalProfile(form.anatomical_mechanical_profile);
  const updateMechanical = (field, value) => setForm((current) => ({
    ...current,
    anatomical_mechanical_profile: {
      ...normalizeMechanicalProfile(current.anatomical_mechanical_profile),
      [field]: value,
    },
  }));

  // Derived estimated max HR
  const estimatedMaxHR = form.age ? 220 - form.age : null;
  const effectiveMaxHR = form.max_hr || estimatedMaxHR;
  const profileQaFindings = normalizeProfileQaFindings(form.profile_qa_findings);
  const profileQaFindingCards = buildProfileQaFindingCards(profileQaFindings, form.first_name);

  if (!user) return (
    <div className="flex min-h-64 items-center justify-center px-4 py-10">
      {profileLoadError ? (
        <div className="w-full max-w-md rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm">
          <p className="font-semibold text-foreground">Profile could not load.</p>
          <p className="mt-2 text-muted-foreground">{profileLoadError}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            On the APK this usually means Sarah cannot reach the local desktop server/API from the phone.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-4"
            onClick={() => setProfileReloadToken((value) => value + 1)}
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" /> Retry
          </Button>
        </div>
      ) : (
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      )}
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 pb-24 sm:px-6 lg:px-8">
      <div className="max-w-3xl">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <User className="w-6 h-6 text-primary" /> Physiological Profile
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          These values improve HR zone accuracy and AI analysis across all sessions.
        </p>
      </div>

      <div className="space-y-6">
        <div className="space-y-6">
          {/* Demographics */}
          <div className="bg-card rounded-xl border border-border p-4 space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
              <User className="w-3.5 h-3.5" /> Demographics
            </h2>
            <Field label="First Name (optional)" hint="Used sparingly by AI when a more personal direct address feels natural.">
              <TextInput value={form.first_name} onChange={(v) => setForm((f) => ({ ...f, first_name: v }))} placeholder="e.g. Ben" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Age (years)">
                <NumInput value={form.age} onChange={(v) => setForm((f) => ({ ...f, age: v }))} placeholder="e.g. 35" min={10} max={100} />
              </Field>
              <Field label="Weight (kg)">
                <NumInput value={form.weight_kg} onChange={(v) => setForm((f) => ({ ...f, weight_kg: v }))} placeholder="e.g. 80" min={30} max={250} />
              </Field>
            </div>
            <Field label="Fitness Level">
              <div className="flex flex-wrap gap-2 mt-1">
                {FITNESS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setForm((f) => ({ ...f, fitness_level: opt.value }))}
                    className="px-3 py-1 rounded-full text-xs font-medium border transition-colors"
                    style={form.fitness_level === opt.value
                      ? { background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderColor: "hsl(var(--primary))" }
                      : { borderColor: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }
                    }
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </Field>
          </div>

          {/* Heart Rate */}
          <div className="bg-card rounded-xl border border-border p-4 space-y-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
          <Heart className="w-3.5 h-3.5" /> Heart Rate Baselines
        </h2>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Resting HR (bpm)" hint="Measured at complete rest">
            <NumInput value={form.resting_hr} onChange={(v) => setForm((f) => ({ ...f, resting_hr: v }))} placeholder="e.g. 60" min={30} max={120} />
          </Field>
          <Field label="Max HR (bpm)" hint={estimatedMaxHR ? `Age estimate: ${estimatedMaxHR}` : "Measured or leave blank"}>
            <NumInput value={form.max_hr} onChange={(v) => setForm((f) => ({ ...f, max_hr: v }))} placeholder={estimatedMaxHR ? String(estimatedMaxHR) : "e.g. 185"} min={100} max={230} />
          </Field>
        </div>

        {effectiveMaxHR && form.resting_hr && (
          <div className="bg-muted/60 rounded-lg px-3 py-2 text-xs space-y-1">
            <p className="font-semibold text-foreground/70 uppercase text-[10px] tracking-wider">Computed Zone Boundaries</p>
            {[1,2,3,4,5].map((z) => {
              const lo = Math.round(form.resting_hr + (effectiveMaxHR - form.resting_hr) * ((z - 1) * 0.2));
              const hi = Math.round(form.resting_hr + (effectiveMaxHR - form.resting_hr) * (z * 0.2));
              const zColors = ["#3b82f6","#22c55e","#eab308","#f97316","#ef4444"];
              return (
                <div key={z} className="flex justify-between">
                  <span className="font-semibold" style={{ color: zColors[z-1] }}>Zone {z}</span>
                  <span className="font-mono text-foreground/80">{lo}–{hi} bpm</span>
                </div>
              );
            })}
            <p className="text-[10px] text-muted-foreground mt-1">Uses Karvonen (HR reserve) method</p>
          </div>
        )}

        <Field label="Recovery HR at 60s post-peak (bpm drop)" hint="Average drop from peak HR at 60 seconds after climax">
          <div className="flex gap-2">
            <NumInput value={form.recovery_hr_60s} onChange={(v) => setForm((f) => ({ ...f, recovery_hr_60s: v }))} placeholder="e.g. 18" min={0} max={80} />
            <Button
              variant="outline"
              size="sm"
              onClick={computeRecovery}
              disabled={computing}
              className="shrink-0 gap-1.5 text-xs"
            >
              {computing
                ? <span className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                : <RefreshCw className="w-3 h-3" />}
              Auto
            </Button>
          </div>
          {computedRecovery != null && (
            <p className="text-[10px] text-primary mt-1">Computed from sessions: avg {computedRecovery} bpm drop</p>
          )}
        </Field>
          </div>

          {/* Physical & Anatomical Context */}
          <div className="bg-card rounded-xl border border-border p-4 space-y-4">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
            <Scan className="w-3.5 h-3.5" /> Physical & Anatomical Overview
          </h2>
          <p className="text-[10px] text-muted-foreground mt-1">
            Describes your current physical state — used by AI to contextualize HR, EMG, and arousal data.
          </p>
        </div>
        <Field label="Current Physical & Anatomical Context" hint="Anatomy, surgeries, chronic conditions, medications, nerve/muscle factors affecting response — anything the AI should factor into its interpretation">
          <RichTextEditor
            value={form.medications ?? ""}
            onChange={(value) => setForm((f) => ({ ...f, medications: value }))}
            placeholder="e.g. Prostate enlargement, prior inguinal hernia repair (left side), on Tamsulosin. Reduced pudendal nerve sensitivity since 2022. Pelvic floor tends to hypertonate under stress."
          />
        </Field>
          </div>
        </div>

        <div className="flex flex-col gap-6">
          {/* Anatomical / Functional Mechanical Profile */}
          <div className="order-2 bg-card rounded-xl border border-border overflow-hidden">
        <button
          type="button"
          onClick={() => setMechanicalOpen((open) => !open)}
          className="flex w-full items-start justify-between gap-4 p-4 text-left"
        >
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
              <Ruler className="w-3.5 h-3.5" /> Anatomical / Functional Mechanical Profile (Optional)
            </h2>
            <p className="text-[10px] leading-relaxed text-muted-foreground mt-1">
              Optional anatomical and functional details that may improve personalized interpretation of stimulation mechanics, device interaction, and repeated physiological patterns.
            </p>
          </div>
          {mechanicalOpen ? <ChevronUp className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
        </button>
        {mechanicalOpen && (
          <div className="space-y-5 border-t border-border p-4">
            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground/80">Resting / Flaccid Anatomy</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <UnitNumberField label="Flaccid Length" measure={mechanicalProfile.flaccid_length} units={LENGTH_UNITS} onChange={(value) => updateMechanical("flaccid_length", value)} placeholder="e.g. 3.5" hint="Optional resting measurement without stretching or compression." />
                <UnitNumberField label="Flaccid Mid-Shaft Diameter" measure={mechanicalProfile.flaccid_mid_shaft_diameter} units={DIAMETER_UNITS} onChange={(value) => updateMechanical("flaccid_mid_shaft_diameter", value)} placeholder="e.g. 28" hint="Optional resting width at mid-shaft with gentle contact." />
                <UnitNumberField label="Flaccid Base Diameter" measure={mechanicalProfile.flaccid_base_diameter} units={DIAMETER_UNITS} onChange={(value) => updateMechanical("flaccid_base_diameter", value)} placeholder="e.g. 30" hint="Optional resting width near the base with gentle contact." />
                <UnitNumberField label="Resting Widest Glans Diameter" measure={mechanicalProfile.flaccid_widest_glans_diameter} units={DIAMETER_UNITS} onChange={(value) => updateMechanical("flaccid_widest_glans_diameter", value)} placeholder="e.g. 32" hint="Optional widest visible glans width at rest." />
              </div>
              <Field label="Resting Glans Observations" hint="Note visible resting shape, contour, tissue condition, or other neutral observations that may contextualize measurements.">
                <RichTextEditor value={mechanicalProfile.resting_glans_observations ?? ""} onChange={(value) => updateMechanical("resting_glans_observations", value)} placeholder="Describe resting glans observations when relevant." />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Resting Foreskin Coverage / Mobility" hint="Describe coverage at rest and whether movement or retraction changes fit or measurement consistency.">
                  <RichTextEditor value={mechanicalProfile.resting_foreskin_coverage_mobility ?? ""} onChange={(value) => updateMechanical("resting_foreskin_coverage_mobility", value)} placeholder="Optional resting coverage or mobility observations." />
                </Field>
                <Field label="Resting Curvature / Orientation" hint="Record resting position or curvature only when it may affect fit, placement, or comparison over time.">
                  <RichTextEditor value={mechanicalProfile.resting_curvature_orientation ?? ""} onChange={(value) => updateMechanical("resting_curvature_orientation", value)} placeholder="Optional curvature or orientation notes." />
                </Field>
                <Field label="Resting Meatal Observations" hint="Record visible resting meatal characteristics that may help interpret accommodation or device fit.">
                  <RichTextEditor value={mechanicalProfile.resting_meatal_observations ?? ""} onChange={(value) => updateMechanical("resting_meatal_observations", value)} placeholder="Optional resting meatal observations." />
                </Field>
                <Field label="Resting Urethral Accommodation Notes" hint="Describe comfort, resistance, or repeatable accommodation observations in the resting state.">
                  <RichTextEditor value={mechanicalProfile.resting_urethral_accommodation_notes ?? ""} onChange={(value) => updateMechanical("resting_urethral_accommodation_notes", value)} placeholder="Optional resting accommodation observations." />
                </Field>
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground/80">Erect Anatomy</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <UnitNumberField label="Bone-Pressed Erect Length" measure={mechanicalProfile.bone_pressed_erect_length} units={LENGTH_UNITS} onChange={(value) => updateMechanical("bone_pressed_erect_length", value)} placeholder="e.g. 6.5" hint="Measure along the top (dorsal side) from pubic bone to tip of glans. Compress gently to bone for consistency." />
                <UnitNumberField label="Visible Erect Length" measure={mechanicalProfile.visible_erect_length} units={LENGTH_UNITS} onChange={(value) => updateMechanical("visible_erect_length", value)} placeholder="e.g. 6.0" hint="Same measurement as above, but without compressing to the pubic bone." />
                <UnitNumberField label="Mid-Shaft Diameter" measure={mechanicalProfile.mid_shaft_diameter} units={DIAMETER_UNITS} onChange={(value) => updateMechanical("mid_shaft_diameter", value)} placeholder="e.g. 38" hint="Measure width at the midpoint of the erect shaft using gentle caliper contact without compression." />
                <UnitNumberField label="Base Diameter" measure={mechanicalProfile.base_diameter} units={DIAMETER_UNITS} onChange={(value) => updateMechanical("base_diameter", value)} placeholder="e.g. 40" hint="Measure near the base of the erect shaft without compressing tissue." />
                <UnitNumberField label="Diameter Just Below Glans" measure={mechanicalProfile.below_glans_diameter} units={DIAMETER_UNITS} onChange={(value) => updateMechanical("below_glans_diameter", value)} placeholder="e.g. 36" hint="Measure shaft width immediately below the glans (coronal region). Useful for sleeve fit interpretation." />
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground/80">Glans / Foreskin Context</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <UnitNumberField label="Widest Glans Diameter" measure={mechanicalProfile.widest_glans_diameter} units={DIAMETER_UNITS} onChange={(value) => updateMechanical("widest_glans_diameter", value)} placeholder="e.g. 42" hint="Measure the widest natural left-to-right span of the glans using gentle caliper contact." />
                <Field label="Circumcision Status" hint="Provides anatomical context for glans exposure, mobility, and session fit observations.">
                  <SelectInput value={mechanicalProfile.circumcision_status} onChange={(value) => updateMechanical("circumcision_status", value)} options={["Circumcised", "Uncircumcised"]} />
                </Field>
                <Field label="Foreskin Behavior During Sessions" hint="Select the pattern most consistently observed during activity or device interaction.">
                  <SelectInput value={mechanicalProfile.foreskin_behavior} onChange={(value) => updateMechanical("foreskin_behavior", value)} options={FORESKIN_OPTIONS} />
                </Field>
                <Field label="Glans Sensitivity" hint="Rate the usual functional sensitivity level rather than a single-session exception.">
                  <SelectInput value={mechanicalProfile.glans_sensitivity} onChange={(value) => updateMechanical("glans_sensitivity", value)} options={GLANS_SENSITIVITY_OPTIONS} />
                </Field>
                <Field label="Glans Overstimulation Near Climax" hint="Does glans stimulation become excessively intense or less effective near threshold?">
                  <SelectInput value={mechanicalProfile.glans_overstimulation_near_climax} onChange={(value) => updateMechanical("glans_overstimulation_near_climax", value)} options={YES_NO_VARIABLE_OPTIONS} />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Erect Glans Observations" hint="Note observations in the erect state when they may affect fit, sensation, or interpretation of dimensions.">
                  <RichTextEditor value={mechanicalProfile.erect_glans_observations ?? ""} onChange={(value) => updateMechanical("erect_glans_observations", value)} placeholder="Optional erect glans observations." />
                </Field>
                <Field label="Erect Curvature / Orientation" hint="Record erect curvature or orientation when relevant to stimulation mechanics or device placement.">
                  <RichTextEditor value={mechanicalProfile.erect_curvature_orientation ?? ""} onChange={(value) => updateMechanical("erect_curvature_orientation", value)} placeholder="Optional erect curvature or orientation notes." />
                </Field>
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground/80">Meatus / Urethral Context</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Meatal Shape" hint="Select the external visible shape of the meatal opening.">
                  <SelectInput value={mechanicalProfile.meatal_shape} onChange={(value) => updateMechanical("meatal_shape", value)} options={MEATAL_SHAPE_OPTIONS} />
                </Field>
                <UnitNumberField
                  label="Visible Meatal Vertical Length"
                  measure={mechanicalProfile.visible_meatal_vertical_length}
                  units={DIAMETER_UNITS}
                  onChange={(value) => updateMechanical("visible_meatal_vertical_length", value)}
                  placeholder="e.g. 5"
                  hint="Approximate visible top-to-bottom slit length at rest. Measure naturally without manually stretching tissue."
                />
                <UnitNumberField
                  label="Visible Meatal Horizontal Width"
                  measure={mechanicalProfile.visible_meatal_horizontal_width}
                  units={DIAMETER_UNITS}
                  onChange={(value) => updateMechanical("visible_meatal_horizontal_width", value)}
                  placeholder="e.g. 3"
                  hint="Approximate widest naturally visible left-to-right opening at rest. Gentle measurement only; do not manually stretch."
                />
                <Field label="Meatal Mobility / Shape Change During Erection" hint="Does the visible opening or shape noticeably change with erection or device placement?">
                  <SelectInput value={mechanicalProfile.meatal_mobility_shape_change} onChange={(value) => updateMechanical("meatal_mobility_shape_change", value)} options={MEATAL_MOBILITY_OPTIONS} />
                </Field>
                <Field label="Meatal Sensitivity" hint="Rate usual sensitivity at the meatal interface during relevant contact or instrumentation.">
                  <SelectInput value={mechanicalProfile.meatal_sensitivity} onChange={(value) => updateMechanical("meatal_sensitivity", value)} options={MEATAL_SENSITIVITY_OPTIONS} />
                </Field>
                <Field label="Device Stability at Meatus" hint="How stable do devices such as Foley catheters feel at the meatal interface?">
                  <SelectInput value={mechanicalProfile.device_stability_at_meatus} onChange={(value) => updateMechanical("device_stability_at_meatus", value)} options={MEATAL_DEVICE_STABILITY_OPTIONS} />
                </Field>
                <Field label="Comfortable Inserted Diameter (mm)" hint="Maximum repeatedly comfortable functional diameter, not absolute tolerance.">
                  <NumInput value={mechanicalProfile.comfortable_inserted_diameter_mm} onChange={(value) => updateMechanical("comfortable_inserted_diameter_mm", value)} placeholder="e.g. 6" min={0} />
                </Field>
                <Field label="Maximum Tolerated Diameter (mm)" hint="Optional upper limit if known.">
                  <NumInput value={mechanicalProfile.maximum_tolerated_diameter_mm} onChange={(value) => updateMechanical("maximum_tolerated_diameter_mm", value)} placeholder="e.g. 7" min={0} />
                </Field>
                <Field label="Preferred Foley Size (French)" hint="Preferred catheter size if applicable.">
                  <NumInput value={mechanicalProfile.preferred_foley_size_fr} onChange={(value) => updateMechanical("preferred_foley_size_fr", value)} placeholder="e.g. 18" min={0} />
                </Field>
                <Field label="Stable Foley Range" hint="Enter the repeatably stable catheter-size range, such as 18-22 Fr, when known.">
                  <input value={mechanicalProfile.stable_foley_range ?? ""} onChange={(e) => updateMechanical("stable_foley_range", e.target.value)} placeholder="e.g. 18-22 Fr" className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
                </Field>
              </div>
              <Field label="Meatal Tension / Fit Notes" hint="Any observations related to tension, movement, sealing, pressure, irritation, or device interaction at the meatus.">
                <RichTextEditor
                  value={mechanicalProfile.meatal_tension_fit_notes ?? ""}
                  onChange={(value) => updateMechanical("meatal_tension_fit_notes", value)}
                  placeholder="Add relevant fit, pressure, movement, or irritation notes."
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Erect Meatal Observations" hint="Describe visible changes or fit-relevant observations in the erect state.">
                  <RichTextEditor value={mechanicalProfile.erect_meatal_observations ?? ""} onChange={(value) => updateMechanical("erect_meatal_observations", value)} placeholder="Optional erect meatal observations." />
                </Field>
                <Field label="Erect Urethral Accommodation Notes" hint="Describe accommodation, comfort, or resistance differences observed during erection.">
                  <RichTextEditor value={mechanicalProfile.erect_urethral_accommodation_notes ?? ""} onChange={(value) => updateMechanical("erect_urethral_accommodation_notes", value)} placeholder="Optional erect accommodation observations." />
                </Field>
              </div>
              <Field label="Foley Discomfort Factors" hint="Select recurring discomfort contributors observed during instrumentation or prolonged wear.">
                <MultiSelectButtons options={FOLEY_DISCOMFORT_OPTIONS} selected={mechanicalProfile.foley_discomfort_factors} onChange={(value) => updateMechanical("foley_discomfort_factors", value)} />
              </Field>
            </section>

            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground/80">Dynamic Function & State Transition</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Flaccid to Erect Expansion Characteristics" hint="Describe how length, width, contour, or fit changes between resting and erect states.">
                  <RichTextEditor value={mechanicalProfile.flaccid_to_erect_expansion_characteristics ?? ""} onChange={(value) => updateMechanical("flaccid_to_erect_expansion_characteristics", value)} placeholder="Describe meaningful state-transition observations." />
                </Field>
                <Field label="Relative Girth Expansion" hint="Note meaningful change in girth relative to length or baseline state; include measurements when known.">
                  <RichTextEditor value={mechanicalProfile.relative_girth_expansion ?? ""} onChange={(value) => updateMechanical("relative_girth_expansion", value)} placeholder="Describe functional changes in girth where relevant." />
                </Field>
                <Field label="Rigidity / Compliance Observations" hint="Describe firmness or tissue compliance only as it affects repeatable fit, pressure, or response.">
                  <RichTextEditor value={mechanicalProfile.rigidity_compliance_observations ?? ""} onChange={(value) => updateMechanical("rigidity_compliance_observations", value)} placeholder="Optional rigidity or compliance findings." />
                </Field>
                <Field label="Tissue Response Observations" hint="Record repeatable tissue responses such as compression, swelling, irritation, or recovery when relevant.">
                  <RichTextEditor value={mechanicalProfile.tissue_response_observations ?? ""} onChange={(value) => updateMechanical("tissue_response_observations", value)} placeholder="Optional tissue response observations." />
                </Field>
                <Field label="Fit Variability by Anatomical State" hint="Describe how device or hand fit differs between resting, partial, and erect states.">
                  <RichTextEditor value={mechanicalProfile.fit_variability_by_state ?? ""} onChange={(value) => updateMechanical("fit_variability_by_state", value)} placeholder="Optional fit changes between resting and erect states." />
                </Field>
                <Field label="Sensitivity Differences by State" hint="Record repeatable differences in sensation between anatomical states, without inferring a cause.">
                  <RichTextEditor value={mechanicalProfile.sensitivity_differences_by_state ?? ""} onChange={(value) => updateMechanical("sensitivity_differences_by_state", value)} placeholder="Optional sensitivity differences by state." />
                </Field>
                <Field label="Pressure Distribution Observations" hint="Note where pressure feels concentrated or relieved and whether this varies by fit or state.">
                  <RichTextEditor value={mechanicalProfile.pressure_distribution_observations ?? ""} onChange={(value) => updateMechanical("pressure_distribution_observations", value)} placeholder="Optional pressure distribution observations." />
                </Field>
                <Field label="Accommodation Differences by State" hint="Describe meaningful changes in tolerance, comfort, or accommodation across anatomical states.">
                  <RichTextEditor value={mechanicalProfile.accommodation_differences_by_state ?? ""} onChange={(value) => updateMechanical("accommodation_differences_by_state", value)} placeholder="Optional accommodation differences by state." />
                </Field>
                <Field label="Device Interaction Observations" hint="Record fit, movement, sealing, contact, or stability observations tied to specific devices.">
                  <RichTextEditor value={mechanicalProfile.device_interaction_observations ?? ""} onChange={(value) => updateMechanical("device_interaction_observations", value)} placeholder="Optional device interaction observations." />
                </Field>
                <Field label="Repeated Instrumentation Fit Findings" hint="Capture consistent findings across repeated insertions or fittings, including size when relevant.">
                  <RichTextEditor value={mechanicalProfile.repeated_instrumentation_fit_findings ?? ""} onChange={(value) => updateMechanical("repeated_instrumentation_fit_findings", value)} placeholder="Optional repeated fit findings." />
                </Field>
              </div>

              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground/80 pt-2">Functional Response Observations</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Full Erection Stability Early Session" hint="Select the typical early-session stability pattern observed repeatedly.">
                  <SelectInput value={mechanicalProfile.full_erection_stability_early_session} onChange={(value) => updateMechanical("full_erection_stability_early_session", value)} options={ERECTION_STABILITY_OPTIONS} />
                </Field>
                <Field label="Near-Threshold Erection Behavior" hint="Select the pattern usually observed close to threshold, not a one-off variation.">
                  <SelectInput value={mechanicalProfile.near_threshold_erection_behavior} onChange={(value) => updateMechanical("near_threshold_erection_behavior", value)} options={NEAR_THRESHOLD_OPTIONS} />
                </Field>
                <Field label="Finger-on-Glans Recovery Effectiveness" hint="Used when recovering from near-threshold overstimulation or rebuilding erection quality.">
                  <SelectInput value={mechanicalProfile.finger_on_glans_recovery_effectiveness} onChange={(value) => updateMechanical("finger_on_glans_recovery_effectiveness", value)} options={RECOVERY_EFFECTIVENESS_OPTIONS} />
                </Field>
                <Field label="Full-Hand Stimulation Effectiveness Near Threshold" hint="Compare effectiveness near threshold relative to the user's typical alternatives.">
                  <SelectInput value={mechanicalProfile.full_hand_stimulation_effectiveness_near_threshold} onChange={(value) => updateMechanical("full_hand_stimulation_effectiveness_near_threshold", value)} options={HAND_EFFECTIVENESS_OPTIONS} />
                </Field>
                <Field label="Sleeve Fit Dynamics" hint="Describe the usual fit relationship during use, particularly where girth or state affects pressure.">
                  <SelectInput value={mechanicalProfile.sleeve_fit_dynamics} onChange={(value) => updateMechanical("sleeve_fit_dynamics", value)} options={SLEEVE_FIT_OPTIONS} />
                </Field>
                <Field label="Device Movement Sensitivity" hint="Rate sensitivity to device shifting, repositioning, or movement during sessions.">
                  <SelectInput value={mechanicalProfile.device_movement_sensitivity} onChange={(value) => updateMechanical("device_movement_sensitivity", value)} options={DEVICE_MOVEMENT_OPTIONS} />
                </Field>
              </div>
              <Field label="Erect Functional Observations" hint="Record repeatable erect-state findings that help connect anatomy, fit, and response.">
                <RichTextEditor value={mechanicalProfile.erect_functional_observations ?? ""} onChange={(value) => updateMechanical("erect_functional_observations", value)} placeholder="Optional erect functional observations." />
              </Field>
              <Field label="Additional Functional Notes" hint="Any anatomy-related functional observations that affect stimulation, device interaction, or climax behavior.">
                <RichTextEditor
                  value={mechanicalProfile.additional_functional_notes ?? ""}
                  onChange={(value) => updateMechanical("additional_functional_notes", value)}
                  placeholder="Add functional observations relevant to later interpretation."
                />
              </Field>
            </section>
          </div>
        )}
          </div>

          {/* Arousal Profile */}
          <div className="order-1 bg-card rounded-xl border border-border p-4 space-y-4">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
            <Flame className="w-3.5 h-3.5" /> Arousal Profile
          </h2>
          <p className="text-[10px] text-muted-foreground mt-1">
            Describes your personal arousal arc — used by AI to personalize physiological interpretation and pattern analysis.
          </p>
        </div>

        <Field label="Arousal Response Style" hint="How does your arousal typically build?">
          <div className="flex flex-wrap gap-2 mt-1">
            {AROUSAL_RESPONSE_OPTIONS.map((opt) => (
              <button key={opt.value}
                onClick={() => setForm((f) => ({ ...f, arousal_response_style: opt.value }))}
                className="px-3 py-1 rounded-full text-xs font-medium border transition-colors"
                style={form.arousal_response_style === opt.value
                  ? { background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderColor: "hsl(var(--primary))" }
                  : { borderColor: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}>
                {opt.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Typical Build Duration" hint="How long does it usually take to reach climax?">
          <div className="flex flex-wrap gap-2 mt-1">
            {BUILD_DURATION_OPTIONS.map((opt) => (
              <button key={opt.value}
                onClick={() => setForm((f) => ({ ...f, typical_build_duration: opt.value }))}
                className="px-3 py-1 rounded-full text-xs font-medium border transition-colors"
                style={form.typical_build_duration === opt.value
                  ? { background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderColor: "hsl(var(--primary))" }
                  : { borderColor: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}>
                {opt.label}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Climax Sensitivity" hint="How easily do you reach climax?">
            <div className="flex flex-wrap gap-2 mt-1">
              {SENSITIVITY_OPTIONS.map((opt) => (
                <button key={opt.value}
                  onClick={() => setForm((f) => ({ ...f, climax_sensitivity: opt.value }))}
                  className="px-3 py-1 rounded-full text-xs font-medium border transition-colors"
                  style={form.climax_sensitivity === opt.value
                    ? { background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderColor: "hsl(var(--primary))" }
                    : { borderColor: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Refractory Pattern" hint="Typical recovery time after climax">
            <div className="flex flex-wrap gap-2 mt-1">
              {REFRACTORY_OPTIONS.map((opt) => (
                <button key={opt.value}
                  onClick={() => setForm((f) => ({ ...f, refractory_pattern: opt.value }))}
                  className="px-3 py-1 rounded-full text-xs font-medium border transition-colors"
                  style={form.refractory_pattern === opt.value
                    ? { background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderColor: "hsl(var(--primary))" }
                    : { borderColor: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </Field>
        </div>

        <Field label="Preferred Stimulation Methods" hint="Methods that consistently produce good results">
          <div className="flex flex-wrap gap-2 mt-1">
            {PREFERRED_STIM_OPTIONS.map((opt) => {
              const selected = (form.preferred_stimulation || []).includes(opt);
              return (
                <button key={opt}
                  onClick={() => setForm((f) => ({
                    ...f,
                    preferred_stimulation: selected
                      ? (f.preferred_stimulation || []).filter((x) => x !== opt)
                      : [...(f.preferred_stimulation || []), opt]
                  }))}
                  className="px-3 py-1 rounded-full text-xs font-medium border transition-colors"
                  style={selected
                    ? { background: "hsl(var(--accent))", color: "hsl(var(--accent-foreground))", borderColor: "hsl(var(--accent))" }
                    : { borderColor: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}>
                  {opt}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Arousal Notes" hint="Unique patterns, what consistently works or doesn't, edge cases — used directly by AI">
          <RichTextEditor
            value={form.arousal_notes ?? ""}
            onChange={(value) => setForm((f) => ({ ...f, arousal_notes: value }))}
            placeholder="e.g. Arousal builds slowly but climax is intense and long. E-stim on low frequency always extends the plateau phase. High stress days reduce sensitivity significantly."
          />
        </Field>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
              <MessageCircle className="h-3.5 w-3.5" /> Chat with Sarah
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The interview chat and saved findings now live on their own page, keeping this profile form focused.
            </p>
            <p className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              {profileQaFindingCards.length} saved finding{profileQaFindingCards.length === 1 ? "" : "s"}
            </p>
          </div>
          <Button asChild className="shrink-0 gap-2">
            <Link to="/profile-qa">
              <MessageCircle className="h-4 w-4" />
               Open Chat with Sarah
            </Link>
          </Button>
        </div>
      </div>

      <Button onClick={save} disabled={saving} className="w-full gap-2">
        {saved
          ? <><CheckCircle className="w-4 h-4" /> Saved!</>
          : saving
          ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Saving…</>
          : "Save Profile"}
      </Button>
    </div>
  );
}
