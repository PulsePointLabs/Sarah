import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { User, Heart, Activity, Scan, RefreshCw, CheckCircle, Flame } from "lucide-react";
import AIChat from "../components/AIChat";

function Field({ label, hint, children }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-semibold text-foreground/80">{label}</label>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
      {children}
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
  const [chatMessages, setChatMessages] = useState([]);

  useEffect(() => {
    base44.auth.me().then((u) => {
      setUser(u);
      setForm({
        age: u.age ?? null,
        weight_kg: u.weight_kg ?? null,
        resting_hr: u.resting_hr ?? null,
        max_hr: u.max_hr ?? null,
        recovery_hr_60s: u.recovery_hr_60s ?? null,
        medications: u.medications ?? "",
        fitness_level: u.fitness_level ?? "moderate",
        arousal_response_style: u.arousal_response_style ?? null,
        typical_build_duration: u.typical_build_duration ?? null,
        climax_sensitivity: u.climax_sensitivity ?? null,
        preferred_stimulation: u.preferred_stimulation ?? [],
        refractory_pattern: u.refractory_pattern ?? null,
        arousal_notes: u.arousal_notes ?? "",
      });
      setChatMessages(u.profile_chat_messages || []);
    });
  }, []);

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
    await base44.auth.updateMe(form);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  // Derived estimated max HR
  const estimatedMaxHR = form.age ? 220 - form.age : null;
  const effectiveMaxHR = form.max_hr || estimatedMaxHR;

  if (!user) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="px-4 py-6 pb-24 max-w-lg mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <User className="w-6 h-6 text-primary" /> Physiological Profile
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          These values improve HR zone accuracy and AI analysis across all sessions.
        </p>
      </div>

      {/* Demographics */}
      <div className="bg-card rounded-xl border border-border p-4 space-y-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
          <User className="w-3.5 h-3.5" /> Demographics
        </h2>
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
          <textarea
            value={form.medications ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, medications: e.target.value }))}
            placeholder="e.g. Prostate enlargement, prior inguinal hernia repair (left side), on Tamsulosin. Reduced pudendal nerve sensitivity since 2022. Pelvic floor tends to hypertonate under stress."
            rows={4}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none"
          />
        </Field>
      </div>

      {/* Arousal Profile */}
      <div className="bg-card rounded-xl border border-border p-4 space-y-4">
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
          <textarea
            value={form.arousal_notes ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, arousal_notes: e.target.value }))}
            placeholder="e.g. Arousal builds slowly but climax is intense and long. E-stim on low frequency always extends the plateau phase. High stress days reduce sensitivity significantly."
            rows={4}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none"
          />
        </Field>
      </div>

      {/* AI Interview */}
      <AIChat
        mode="profile"
        context={[
          `Age: ${form.age ?? "not set"}, Weight: ${form.weight_kg ?? "not set"}kg, Fitness: ${form.fitness_level ?? "not set"}`,
          `Resting HR: ${form.resting_hr ?? "not set"} bpm, Max HR: ${form.max_hr ?? "not set"} bpm, Recovery HR drop 60s: ${form.recovery_hr_60s ?? "not set"} bpm`,
          `Physical & anatomical context: ${form.medications || "none"}`,
          `Arousal response style: ${form.arousal_response_style ?? "not set"}`,
          `Typical build duration: ${form.typical_build_duration ?? "not set"}`,
          `Climax sensitivity: ${form.climax_sensitivity ?? "not set"}`,
          `Refractory pattern: ${form.refractory_pattern ?? "not set"}`,
          `Preferred stimulation: ${(form.preferred_stimulation || []).join(", ") || "not set"}`,
          `Arousal notes: ${form.arousal_notes || "none"}`,
        ].join("\n")}
        savedMessages={chatMessages}
        savedNotes={form.arousal_notes}
        onSaveMessages={async (msgs) => {
          setChatMessages(msgs);
          await base44.auth.updateMe({ profile_chat_messages: msgs });
        }}
        onSaveNotes={async (merged) => {
          setForm((f) => ({ ...f, arousal_notes: merged }));
          await base44.auth.updateMe({ arousal_notes: merged });
        }}
      />

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