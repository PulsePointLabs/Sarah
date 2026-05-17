import { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { Brain, Zap, Heart, Clock, ChevronDown, ChevronUp, TrendingUp, AlertCircle, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import TTSReader from "@/components/TTSReader";

const PRESET_METHODS = [
  "Manual", "E-Stim", "Foley", "TENS", "Vibration", "Edging", "Prostate", "Sleeve", "Hands-free"
];

const DURATION_OPTIONS = [15, 20, 30, 45, 60, 90, 120];
const MOOD_OPTIONS = ["relaxed", "neutral", "excited", "stressed", "tired", "anxious"];
const HYDRATION_OPTIONS = ["low", "normal", "high"];
const BUILD_TYPE_OPTIONS = ["Gradual", "Stepwise", "Spike", "Plateau-heavy", "Erratic"];

function FieldLabel({ children }) {
  return <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">{children}</p>;
}

function ToggleChip({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors border ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-muted/50 text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

function GaugeBar({ label, value, color, suffix = "%" }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-bold font-mono" style={{ color }}>
          {value != null ? `${value}${suffix}` : "—"}
        </p>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${Math.min(100, value ?? 0)}%`, background: color }}
        />
      </div>
    </div>
  );
}

export default function PredictiveModeler() {
  const [sessions, setSessions] = useState([]);
  const [customMethods, setCustomMethods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  // Simulation inputs
  const [selectedMethods, setSelectedMethods] = useState([]);
  const [duration, setDuration] = useState(45);
  const [mood, setMood] = useState("relaxed");
  const [hydration, setHydration] = useState("normal");
  const [buildType, setBuildType] = useState("Gradual");
  const [customMethodInput, setCustomMethodInput] = useState("");

  useEffect(() => {
    Promise.all([
      base44.entities.Session.list("-date", 200),
      base44.entities.CustomMethod.list(),
    ]).then(([s, cm]) => {
      setSessions(s);
      setCustomMethods(cm.map(c => c.name));
      setLoading(false);
    });
  }, []);

  const allMethods = useMemo(() => {
    const set = new Set([...PRESET_METHODS, ...customMethods]);
    sessions.forEach(s => {
      (s.methods || []).forEach(m => set.add(m));
      (s.custom_methods || []).forEach(m => set.add(m));
    });
    return [...set].sort();
  }, [sessions, customMethods]);

  const toggleMethod = (m) => {
    setSelectedMethods(prev =>
      prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]
    );
  };

  // Statistical baseline from historical data
  const historicalStats = useMemo(() => {
    if (!sessions.length) return null;
    const relevant = sessions.filter(s =>
      selectedMethods.length === 0 ||
      selectedMethods.some(m => (s.methods || []).includes(m) || (s.custom_methods || []).includes(m))
    );
    if (!relevant.length) return null;

    const climaxSessions = relevant.filter(s => !s.no_climax);
    const climaxRate = Math.round((climaxSessions.length / relevant.length) * 100);
    const avgMaxHR = relevant.filter(s => s.max_hr).map(s => s.max_hr);
    const avgHRAtClimax = climaxSessions.filter(s => s.hr_at_climax).map(s => s.hr_at_climax);
    const avgSat = relevant.filter(s => s.satisfaction).map(s => s.satisfaction);
    const avgInt = relevant.filter(s => s.intensity).map(s => s.intensity);
    const durations = relevant.filter(s => s.duration_minutes).map(s => s.duration_minutes);

    const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;

    return {
      sessionCount: relevant.length,
      climaxRate,
      avgMaxHR: avg(avgMaxHR),
      avgHRAtClimax: avg(avgHRAtClimax),
      avgSatisfaction: avg(avgSat),
      avgIntensity: avg(avgInt),
      avgDuration: avg(durations),
    };
  }, [sessions, selectedMethods]);

  const simulate = async () => {
    if (selectedMethods.length === 0) return;
    setRunning(true);
    setResult(null);

    // Build historical summaries for the AI
    const methodStats = {};
    for (const m of selectedMethods) {
      const ms = sessions.filter(s =>
        (s.methods || []).includes(m) || (s.custom_methods || []).includes(m)
      );
      if (!ms.length) continue;
      const withClimax = ms.filter(s => !s.no_climax);
      const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
      methodStats[m] = {
        session_count: ms.length,
        climax_rate_pct: Math.round((withClimax.length / ms.length) * 100),
        avg_satisfaction: avg(ms.map(s => s.satisfaction).filter(Boolean)),
        avg_intensity: avg(ms.map(s => s.intensity).filter(Boolean)),
        avg_max_hr: avg(ms.map(s => s.max_hr).filter(Boolean)),
        avg_hr_at_climax: avg(withClimax.map(s => s.hr_at_climax).filter(Boolean)),
        avg_duration_min: avg(ms.map(s => s.duration_minutes).filter(Boolean)),
        common_combos: [...new Set(ms.flatMap(s => [...(s.methods || []), ...(s.custom_methods || [])]).filter(x => x !== m))].slice(0, 4),
        mood_distribution: ms.reduce((acc, s) => { if (s.mood) acc[s.mood] = (acc[s.mood] || 0) + 1; return acc; }, {}),
        hydration_distribution: ms.reduce((acc, s) => { if (s.hydration) acc[s.hydration] = (acc[s.hydration] || 0) + 1; return acc; }, {}),
      };
    }

    // Combination history
    const comboHistory = sessions.filter(s => {
      const sm = [...(s.methods || []), ...(s.custom_methods || [])];
      return selectedMethods.every(m => sm.includes(m));
    }).map(s => ({
      date: s.date?.slice(0, 10),
      satisfaction: s.satisfaction,
      intensity: s.intensity,
      climax: !s.no_climax,
      max_hr: s.max_hr,
      hr_at_climax: s.hr_at_climax,
      duration_minutes: s.duration_minutes,
      mood: s.mood,
      hydration: s.hydration,
      build_type: s.build_type,
    }));

    const res = await base44.integrations.Core.InvokeLLM({
      model: "claude_sonnet_4_6",
      prompt: `You are a physiological data scientist specializing in sexual response modelling. Based on the person's historical session data, predict outcomes for a PLANNED session with the following parameters.

PLANNED SESSION:
- Methods: ${selectedMethods.join(", ")}
- Intended duration: ${duration} minutes
- Mood going in: ${mood}
- Hydration: ${hydration}
- Expected build type: ${buildType}

PER-METHOD HISTORICAL STATS:
${JSON.stringify(methodStats, null, 2)}

EXACT COMBINATION HISTORY (sessions where ALL selected methods were used together):
${comboHistory.length > 0 ? JSON.stringify(comboHistory, null, 2) : "No sessions found with this exact combination."}

OVERALL BASELINE (${sessions.length} total sessions):
- Overall climax rate: ${Math.round(sessions.filter(s => !s.no_climax).length / sessions.length * 100)}%
- Avg max HR across all: ${Math.round(sessions.filter(s => s.max_hr).reduce((a, s) => a + s.max_hr, 0) / Math.max(1, sessions.filter(s => s.max_hr).length))} bpm
- Avg satisfaction: ${(sessions.filter(s => s.satisfaction).reduce((a, s) => a + s.satisfaction, 0) / Math.max(1, sessions.filter(s => s.satisfaction).length)).toFixed(1)}/10

Based on ALL of the above, produce a precise session forecast. Be specific and data-driven. Reference actual numbers from the historical data to justify each prediction.

IMPORTANT: For climax_probability, predicted_hr_min, predicted_hr_max, predicted_hr_at_climax, and predicted_satisfaction — these MUST be numeric values (integers or floats), not strings. climax_probability is 0-100 (integer). HR values are beats per minute. satisfaction is 1-10.`,
      response_json_schema: {
        type: "object",
        properties: {
          climax_probability: { type: "number", description: "0-100 integer probability" },
          predicted_hr_min: { type: "number", description: "Predicted minimum HR during session in bpm" },
          predicted_hr_max: { type: "number", description: "Predicted peak HR in bpm" },
          predicted_hr_at_climax: { type: "number", description: "Predicted HR at climax moment in bpm" },
          predicted_satisfaction: { type: "number", description: "Predicted satisfaction score 1-10" },
          confidence_level: { type: "string", enum: ["low", "medium", "high"], description: "Based on how much data exists for this combo" },
          data_basis: { type: "string", description: "How many sessions this is based on, and how well the combo is represented" },
          key_factors: { type: "array", items: { type: "string" }, description: "Top 3-4 factors driving this prediction" },
          risk_flags: { type: "array", items: { type: "string" }, description: "Any physiological or contextual risk factors to watch for" },
          optimization_tips: { type: "array", items: { type: "string" }, description: "2-3 concrete adjustments to improve the predicted outcome" },
          narrative: { type: "string", description: "2-3 sentence plain-language summary of the forecast" },
        },
        required: ["climax_probability", "predicted_hr_min", "predicted_hr_max", "predicted_hr_at_climax", "predicted_satisfaction", "confidence_level", "data_basis", "key_factors", "risk_flags", "optimization_tips", "narrative"]
      }
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    setResult(raw?.response ?? raw);
    setRunning(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const CONFIDENCE_COLOR = { low: "hsl(var(--chart-4))", medium: "hsl(var(--primary))", high: "hsl(var(--chart-1))" };
  const confColor = result ? CONFIDENCE_COLOR[result.confidence_level] || "hsl(var(--primary))" : null;

  return (
    <div className="px-4 py-6 pb-24 space-y-6 max-w-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Brain className="w-6 h-6 text-primary" /> Predictive Modeler
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Simulate a planned session — get AI-forecast climax probability, HR range, and optimization tips.
        </p>
      </div>

      {/* Config Panel */}
      <div className="bg-card rounded-xl border border-border p-4 space-y-5">
        {/* Methods */}
        <div>
          <FieldLabel>Stimulation Methods</FieldLabel>
          <div className="flex flex-wrap gap-1.5">
            {allMethods.map(m => (
              <ToggleChip key={m} label={m} active={selectedMethods.includes(m)} onClick={() => toggleMethod(m)} />
            ))}
          </div>
          {/* Custom method entry */}
          <div className="flex gap-2 mt-2">
            <input
              value={customMethodInput}
              onChange={e => setCustomMethodInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && customMethodInput.trim()) {
                  const m = customMethodInput.trim();
                  if (!selectedMethods.includes(m)) setSelectedMethods(p => [...p, m]);
                  setCustomMethodInput("");
                }
              }}
              placeholder="Add custom method…"
              className="flex-1 bg-background border border-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const m = customMethodInput.trim();
                if (m && !selectedMethods.includes(m)) setSelectedMethods(p => [...p, m]);
                setCustomMethodInput("");
              }}
              disabled={!customMethodInput.trim()}
            >
              Add
            </Button>
          </div>
        </div>

        {/* Duration */}
        <div>
          <FieldLabel>Planned Duration</FieldLabel>
          <div className="flex flex-wrap gap-1.5">
            {DURATION_OPTIONS.map(d => (
              <ToggleChip key={d} label={`${d}m`} active={duration === d} onClick={() => setDuration(d)} />
            ))}
          </div>
        </div>

        {/* Mood + Hydration */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <FieldLabel>Mood Going In</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              {MOOD_OPTIONS.map(m => (
                <ToggleChip key={m} label={m} active={mood === m} onClick={() => setMood(m)} />
              ))}
            </div>
          </div>
          <div>
            <FieldLabel>Hydration</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              {HYDRATION_OPTIONS.map(h => (
                <ToggleChip key={h} label={h} active={hydration === h} onClick={() => setHydration(h)} />
              ))}
            </div>
          </div>
        </div>

        {/* Build Type */}
        <div>
          <FieldLabel>Expected Build Type</FieldLabel>
          <div className="flex flex-wrap gap-1.5">
            {BUILD_TYPE_OPTIONS.map(b => (
              <ToggleChip key={b} label={b} active={buildType === b} onClick={() => setBuildType(b)} />
            ))}
          </div>
        </div>

        {/* Historical baseline summary */}
        {historicalStats && selectedMethods.length > 0 && (
          <div className="bg-muted/40 rounded-lg p-3 space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Historical Baseline ({historicalStats.sessionCount} matching sessions)</p>
            <div className="grid grid-cols-3 gap-2">
              {[
                ["Climax Rate", `${historicalStats.climaxRate}%`],
                ["Avg Sat", historicalStats.avgSatisfaction ? `${historicalStats.avgSatisfaction}/10` : "—"],
                ["Peak HR", historicalStats.avgMaxHR ? `${historicalStats.avgMaxHR}` : "—"],
              ].map(([l, v]) => (
                <div key={l} className="text-center">
                  <p className="text-base font-bold font-mono text-foreground">{v}</p>
                  <p className="text-[9px] text-muted-foreground">{l}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <Button
          onClick={simulate}
          disabled={running || selectedMethods.length === 0 || sessions.length < 3}
          className="w-full gap-2"
        >
          {running
            ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Simulating…</>
            : <><Brain className="w-4 h-4" />Run Simulation</>}
        </Button>
        {sessions.length < 3 && (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" /> Need at least 3 sessions to generate a meaningful prediction.
          </p>
        )}
        {selectedMethods.length === 0 && sessions.length >= 3 && (
          <p className="text-xs text-muted-foreground">Select at least one stimulation method to simulate.</p>
        )}
      </div>

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {/* Headline metrics */}
          <div className="bg-card rounded-xl border border-border p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Simulation Forecast</h2>
              <Badge
                variant="outline"
                style={{ borderColor: confColor, color: confColor }}
                className="text-[10px] capitalize"
              >
                {result.confidence_level} confidence
              </Badge>
            </div>

            <p className="text-sm text-muted-foreground leading-relaxed">{result.narrative}</p>
            <p className="text-[10px] text-muted-foreground italic">{result.data_basis}</p>

            {/* TTS for narrative */}
            {result.narrative && (
              <TTSReader
                sessionId={`modeler_${selectedMethods.join("_")}_${duration}`}
                title="Simulation Forecast"
                paragraphs={[result.narrative]}
                renderParagraph={(text, idx, isActive, isBuffering) => (
                  <p className={`text-sm leading-relaxed border-l-2 pl-3 py-1 transition-all duration-200 rounded-r-md flex items-center gap-2 ${isActive ? "border-primary bg-primary/8 text-foreground" : isBuffering ? "border-primary/60 bg-primary/5 text-muted-foreground" : "border-primary/30 text-muted-foreground"}`}>
                    {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
                    {text}
                  </p>
                )}
              />
            )}

            <div className="space-y-3">
              <GaugeBar
                label="Climax Probability"
                value={result.climax_probability}
                color="hsl(var(--chart-3))"
              />
              <GaugeBar
                label="Predicted Satisfaction"
                value={result.predicted_satisfaction != null ? Math.round(result.predicted_satisfaction * 10) : null}
                color="hsl(var(--accent))"
              />
            </div>

            {/* HR Range */}
            <div className="bg-muted/40 rounded-lg p-3 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Heart className="w-3.5 h-3.5 text-destructive" /> Predicted HR Range
              </p>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ["Min", result.predicted_hr_min, "hsl(var(--chart-1))"],
                  ["At Climax", result.predicted_hr_at_climax, "hsl(var(--chart-3))"],
                  ["Peak", result.predicted_hr_max, "hsl(var(--destructive))"],
                ].map(([l, v, c]) => (
                  <div key={l} className="text-center bg-card rounded-lg py-2">
                    <p className="text-lg font-bold font-mono" style={{ color: c }}>{v ?? "—"}</p>
                    <p className="text-[9px] text-muted-foreground">{l} bpm</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Key factors */}
          {result.key_factors?.length > 0 && (
            <div className="bg-card rounded-xl border border-border p-4 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
                <TrendingUp className="w-3.5 h-3.5" /> Key Predictive Factors
              </p>
              <TTSReader
                sessionId={`modeler_factors_${selectedMethods.join("_")}`}
                title="Key Predictive Factors"
                paragraphs={result.key_factors}
                renderParagraph={(text, idx, isActive, isBuffering) => (
                  <li className={`text-sm pl-3 border-l-2 py-1 list-none transition-all duration-200 rounded-r-md flex items-center gap-2 ${isActive ? "border-primary bg-primary/8 text-foreground font-medium" : isBuffering ? "border-primary/60 bg-primary/5 text-foreground" : "border-primary/40 text-foreground"}`}>
                    {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
                    {text}
                  </li>
                )}
              />
            </div>
          )}

          {/* Risk flags */}
          {result.risk_flags?.length > 0 && (
            <div className="bg-card rounded-xl border border-border p-4 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-destructive flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5" /> Risk Flags
              </p>
              <TTSReader
                sessionId={`modeler_risks_${selectedMethods.join("_")}`}
                title="Risk Flags"
                paragraphs={result.risk_flags}
                renderParagraph={(text, idx, isActive, isBuffering) => (
                  <li className={`text-sm pl-3 border-l-2 py-1 list-none transition-all duration-200 rounded-r-md flex items-center gap-2 ${isActive ? "border-destructive bg-destructive/8 text-foreground font-medium" : isBuffering ? "border-destructive/60 bg-destructive/5 text-foreground" : "border-destructive/40 text-foreground"}`}>
                    {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-destructive border-t-transparent rounded-full animate-spin" />}
                    {text}
                  </li>
                )}
              />
            </div>
          )}

          {/* Optimization tips */}
          {result.optimization_tips?.length > 0 && (
            <div className="bg-card rounded-xl border border-border p-4 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-accent flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5" /> Optimization Tips
              </p>
              <TTSReader
                sessionId={`modeler_tips_${selectedMethods.join("_")}`}
                title="Optimization Tips"
                paragraphs={result.optimization_tips}
                renderParagraph={(text, idx, isActive, isBuffering) => (
                  <li className={`text-sm pl-3 border-l-2 py-1 list-none transition-all duration-200 rounded-r-md flex items-center gap-2 ${isActive ? "border-accent bg-accent/8 text-foreground font-medium" : isBuffering ? "border-accent/60 bg-accent/5 text-foreground" : "border-accent/40 text-foreground"}`}>
                    {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />}
                    {text}
                  </li>
                )}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}