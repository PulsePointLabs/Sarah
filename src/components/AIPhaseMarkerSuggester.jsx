import { useMemo, useState } from "react";
import { AlertCircle, Brain, Check, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { EVENT_CATEGORIES, normalizeCategoryArray } from "./session-form/EventTimelineSection";
import { buildAIGroundingContext } from "@/lib/aiGrounding";

function fmtMmSs(value) {
  if (value == null || Number(value) < 0) return "--";
  const total = Math.round(Number(value));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatEvidenceTimeText(text) {
  return String(text || "").replace(/\b(\d{2,5})\s*s\b/g, (_, seconds) => `${fmtMmSs(Number(seconds))}`);
}

function getCategoryLabel(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value)?.label || value || "Other";
}

const PHASE_NOTE_PATTERNS = {
  climax: /\b(ejaculat(?:e|ed|ion|ing)?|orgasm(?:ed|ic)?|climax(?:ed|ing)?|came|cum(?:ming|med)?|release(?:d)?|semen|emission|expulsion|spurts?|puls(?:e|ed|ing)|rhythmic contraction|involuntary contraction|ejaculatory contraction|ejaculatory reflex)\b/i,
  pre_climax: /\b(near|close|edge|edging|urge|building|final build|point of no return|about to|impending|couldn'?t hold|tense|tensing|locked|toe|curl|feet|legs|plant(?:ed|ing)?|downward|shudder|tremor|quiver|spasm|breath(?:ing)?|moan|pre[-\s]?climax|approach(?:ing)?|escalat(?:e|ed|ing)|intensif(?:y|ied|ying))\b/i,
  recovery: /\b(recover(?:y|ing)?|stopped|stopping|stop(?:ped)? all|all stimulation stopped|stimulation stopped|stimulation ended|ceased|hands off|toy off|vibrator off|sleeve removed|slowed|slowing|pause|paused|relax(?:ed|ing)?|body relaxed|settled|refractory|afterglow|cleanup|finished|ended|soften(?:ed|ing)?|flaccid|breathing normalized|heart rate drop|parasympathetic)\b/i,
};

function aiErrorMessage(error) {
  const raw = error?.data?.error || error?.message || String(error || "Marker suggestion failed");
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || parsed?.message || parsed?.error || raw;
  } catch {
    return raw;
  }
}

function normalizeSuggestion(res) {
  const raw = typeof res === "string" ? JSON.parse(res) : res;
  const parsed = raw?.response ?? raw;
  const cleanNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  };
  const cleanConfidence = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  };

  return {
    pre_climax_offset_s: cleanNumber(parsed?.pre_climax_offset_s),
    climax_offset_s: cleanNumber(parsed?.climax_offset_s),
    recovery_offset_s: cleanNumber(parsed?.recovery_offset_s),
    pre_climax_confidence: cleanConfidence(parsed?.pre_climax_confidence),
    climax_confidence: cleanConfidence(parsed?.climax_confidence),
    recovery_confidence: cleanConfidence(parsed?.recovery_confidence),
    evidence: Array.isArray(parsed?.evidence) ? parsed.evidence.filter(Boolean).slice(0, 8).map(formatEvidenceTimeText) : [],
    reasoning: formatEvidenceTimeText(String(parsed?.reasoning || "").trim()),
  };
}

function findPhaseEvidenceAnchors(session) {
  const events = (session.event_timeline || [])
    .slice()
    .sort((a, b) => Number(a.time_s) - Number(b.time_s));

  const eventAt = (event, index, phase) => event ? {
    time_s: Math.round(Number(event.time_s) || 0),
    evidence: `E${index + 1} at ${fmtMmSs(event.time_s)} explicitly suggests ${phase}: "${String(event.note || "").slice(0, 140)}"`,
  } : null;

  const climaxIndex = events.findIndex((event) => PHASE_NOTE_PATTERNS.climax.test(String(event.note || "")));
  const climax = climaxIndex >= 0 ? eventAt(events[climaxIndex], climaxIndex, "climax/release") : null;
  const climaxTime = climax?.time_s ?? session.climax_offset_s ?? null;

  let recovery = null;
  if (climaxTime != null) {
    const recoveryIndex = events.findIndex((event) =>
      Number(event.time_s) >= Number(climaxTime) &&
      PHASE_NOTE_PATTERNS.recovery.test(String(event.note || ""))
    );
    recovery = recoveryIndex >= 0 ? eventAt(events[recoveryIndex], recoveryIndex, "recovery") : null;
  }

  let preClimax = null;
  if (climaxTime != null) {
    const preCandidates = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) =>
        Number(event.time_s) < Number(climaxTime) &&
        PHASE_NOTE_PATTERNS.pre_climax.test(String(event.note || ""))
      );
    const finalWindow = preCandidates.filter(({ event }) => Number(event.time_s) >= Number(climaxTime) - 240);
    const chosen = (finalWindow.length ? finalWindow : preCandidates).at(0);
    preClimax = chosen ? eventAt(chosen.event, chosen.index, "pre-climax escalation") : null;
  }

  return { preClimax, climax, recovery };
}

function applyEvidenceAnchors(suggestion, session) {
  const anchors = findPhaseEvidenceAnchors(session);
  const next = {
    ...suggestion,
    evidence: [...(suggestion.evidence || [])],
  };

  if (anchors.climax && (next.climax_offset_s == null || Math.abs(next.climax_offset_s - anchors.climax.time_s) > 30)) {
    next.climax_offset_s = anchors.climax.time_s;
    next.climax_confidence = Math.max(next.climax_confidence || 0, 0.95);
    next.evidence.unshift(anchors.climax.evidence);
  }

  const climaxTime = next.climax_offset_s;
  if (anchors.recovery && (next.recovery_offset_s == null || next.recovery_offset_s < climaxTime || Math.abs(next.recovery_offset_s - anchors.recovery.time_s) > 45)) {
    next.recovery_offset_s = anchors.recovery.time_s;
    next.recovery_confidence = Math.max(next.recovery_confidence || 0, 0.9);
    next.evidence.unshift(anchors.recovery.evidence);
  }

  if (anchors.preClimax && (next.pre_climax_offset_s == null || next.pre_climax_offset_s >= climaxTime)) {
    next.pre_climax_offset_s = anchors.preClimax.time_s;
    next.pre_climax_confidence = Math.max(next.pre_climax_confidence || 0, 0.82);
    next.evidence.unshift(anchors.preClimax.evidence);
  }

  next.evidence = [...new Set(next.evidence.map(formatEvidenceTimeText))].slice(0, 8);
  return next;
}

function buildHRHelpers(rows) {
  const sortedRows = [...rows].sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));
  const nearestHR = (time_s) => {
    if (!sortedRows.length || time_s == null) return null;
    let best = sortedRows[0];
    let bestDist = Math.abs(Number(best.time_offset_s) - Number(time_s));
    for (const row of sortedRows) {
      const d = Math.abs(Number(row.time_offset_s) - Number(time_s));
      if (d < bestDist) {
        best = row;
        bestDist = d;
      }
      if (Number(row.time_offset_s) > Number(time_s) + 20) break;
    }
    return Math.round(Number(best.hr_smoothed || best.hr));
  };

  const windowSummary = (time_s) => {
    if (!sortedRows.length || time_s == null) return null;
    const before = sortedRows.filter((r) => Number(r.time_offset_s) >= time_s - 45 && Number(r.time_offset_s) < time_s);
    const after = sortedRows.filter((r) => Number(r.time_offset_s) > time_s && Number(r.time_offset_s) <= time_s + 45);
    const avg = (arr) => arr.length ? Math.round(arr.reduce((sum, r) => sum + Number(r.hr_smoothed || r.hr), 0) / arr.length) : null;
    const beforeAvg = avg(before);
    const afterAvg = avg(after);
    const at = nearestHR(time_s);
    const trend = beforeAvg != null && afterAvg != null ? afterAvg - beforeAvg : null;
    return { time_s: Math.round(time_s), hr_at_time: at, avg_45s_before: beforeAvg, avg_45s_after: afterAvg, after_minus_before: trend };
  };

  const calcMetrics = (markers) => {
    const updates = {};
    const pre = markers.pre_climax_offset_s;
    const climax = markers.climax_offset_s;
    if (pre != null && climax != null) {
      const lo = Math.min(pre, climax);
      const hi = Math.max(pre, climax);
      const seg = sortedRows.filter((r) => Number(r.time_offset_s) >= lo && Number(r.time_offset_s) <= hi);
      if (seg.length) {
        updates.hr_avg_pre_to_climax = Math.round(seg.reduce((sum, r) => sum + Number(r.hr_smoothed || r.hr), 0) / seg.length);
      }
    }
    if (climax != null) {
      const win = sortedRows.filter((r) => Math.abs(Number(r.time_offset_s) - climax) <= 30);
      if (win.length) {
        updates.hr_avg_at_climax_window = Math.round(win.reduce((sum, r) => sum + Number(r.hr_smoothed || r.hr), 0) / win.length);
      }
      const at = nearestHR(climax);
      if (at != null) updates.hr_at_climax = at;
    }
    return updates;
  };

  return { sortedRows, nearestHR, windowSummary, calcMetrics };
}

function buildCandidateEvents(session, rows) {
  const { windowSummary } = buildHRHelpers(rows);
  const events = (session.event_timeline || []).slice().sort((a, b) => Number(a.time_s) - Number(b.time_s));

  return events
    .map((event, index) => {
      const note = String(event.note || "");
      const tags = Object.entries(PHASE_NOTE_PATTERNS)
        .filter(([, regex]) => regex.test(note))
        .map(([key]) => key);
      const categories = normalizeCategoryArray(event.category).map(getCategoryLabel);
      return {
        index: index + 1,
        time_s: Math.round(Number(event.time_s) || 0),
        time: fmtMmSs(event.time_s),
        categories,
        candidate_for: tags.length ? tags : ["context"],
        note,
        hr_context: windowSummary(Number(event.time_s) || 0),
      };
    })
    .filter(Boolean)
    .slice(0, 80);
}

function buildHRSamples(rows) {
  if (!rows.length) return [];
  const sorted = [...rows].sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));
  const step = Math.max(1, Math.floor(sorted.length / 80));
  return sorted
    .filter((_, index) => index % step === 0)
    .map((row) => `${Math.round(Number(row.time_offset_s))}s:${Math.round(Number(row.hr_smoothed || row.hr))}`)
    .join(" ");
}

function MarkerCell({ label, color, time, confidence }) {
  return (
    <div className="rounded-lg bg-muted/60 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color }}>{label}</p>
      <p className="text-lg font-mono font-bold text-foreground">{fmtMmSs(time)}</p>
      <p className="text-[10px] text-muted-foreground">{Math.round((confidence || 0) * 100)}% confidence</p>
    </div>
  );
}

export default function AIPhaseMarkerSuggester({ session, timelineRows, userProfile, onApply }) {
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [suggestion, setSuggestion] = useState(session.phase_marker_ai_suggestion || null);
  const [error, setError] = useState("");

  const hasInputs = timelineRows.length > 5 && (session.event_timeline || []).length > 0;
  const { calcMetrics } = useMemo(() => buildHRHelpers(timelineRows), [timelineRows]);

  const generate = async () => {
    setLoading(true);
    setError("");
    try {
      const candidates = buildCandidateEvents(session, timelineRows);
      const hrSamples = buildHRSamples(timelineRows);
      const durationS = Math.round(Math.max(...timelineRows.map((r) => Number(r.time_offset_s) || 0), Number(session.duration_minutes || 0) * 60));
      const groundingContext = buildAIGroundingContext(userProfile);

      const res = await base44.integrations.Core.InvokeLLM({
        model: "claude_sonnet_4_6",
        max_tokens: 2200,
        prompt: `You are helping place pre-climax, climax, and recovery markers on a personal physiology timeline. Use the timestamped event notes as primary evidence. Use heart-rate shape only as supporting context.

${groundingContext}

Choose:
- pre_climax_offset_s: the beginning of the final pre-climax escalation. Prefer the first event in the final continuous approach where notes show impending climax, involuntary tension, legs/feet/toes locking or planting, tremors, breathing shifts, escalating stimulation, point-of-no-return language, or repeated near-climax signs.
- climax_offset_s: the most likely climax/release/ejaculation moment. If ejaculation, orgasm, climax, release, semen/emission, or ejaculatory contractions are mentioned, use that event or the nearest clearly linked timestamp even if HR peaks elsewhere.
- recovery_offset_s: the start of post-climax recovery. Prefer the first event after climax where stimulation stops or slows, all stimulation is stopped, tools are removed/turned off, the body relaxes/settles, breathing normalizes, refractory shift begins, cleanup begins, or HR begins a sustained post-release decline.

Rules:
- Event-note evidence beats HR-only heuristics. Never choose the HR peak as climax when notes explicitly place ejaculation/release/climax elsewhere.
- Treat "ejaculation", "orgasm", "climax", "came", "cum", "release", "semen", "emission", "pulsing", or "ejaculatory contractions" as the strongest climax evidence.
- Treat "all stimulation stopped", "stimulation stopped", "hands off", "toy/vibrator off", "sleeve removed", "relaxed", "settled", "refractory", "cleanup", "softened/flaccid", or "breathing normalized" after climax as strong recovery evidence.
- If a note contains both climax and immediate recovery language, set climax to that event and recovery to the next timestamp showing stopping/relaxation if one exists; otherwise recovery may be the same timestamp only when the note explicitly says recovery began.
- Pre-climax must be before climax. Recovery must be at or after climax. If the best evidence violates that ordering, explain why and choose the nearest ordered marker.
- Return marker offsets as seconds numbers only. If a marker is truly unknowable, return -1 for that marker.
- In evidence and reasoning, express times as m:ss, not raw seconds.
- Keep evidence concise and cite the event number/time plus the specific note cue.

Session duration: ${durationS} seconds (${fmtMmSs(durationS)})
Current saved markers: ${JSON.stringify({
  pre_climax_offset_s: session.pre_climax_offset_s,
  climax_offset_s: session.climax_offset_s,
  recovery_offset_s: session.recovery_offset_s,
})}

HR samples time:heart-rate:
${hrSamples}

Candidate/context events:
${JSON.stringify(candidates, null, 2)}

Session notes:
${session.notes || "none"}`,
        response_json_schema: {
          type: "object",
          properties: {
            pre_climax_offset_s: { type: "number" },
            climax_offset_s: { type: "number" },
            recovery_offset_s: { type: "number" },
            pre_climax_confidence: { type: "number" },
            climax_confidence: { type: "number" },
            recovery_confidence: { type: "number" },
            evidence: { type: "array", items: { type: "string" } },
            reasoning: { type: "string" },
          },
          required: [
            "pre_climax_offset_s",
            "climax_offset_s",
            "recovery_offset_s",
            "pre_climax_confidence",
            "climax_confidence",
            "recovery_confidence",
            "evidence",
            "reasoning",
          ],
        },
      });

      const normalized = applyEvidenceAnchors(normalizeSuggestion(res), session);
      setSuggestion(normalized);
    } catch (err) {
      console.error("AI phase marker suggestion failed:", err);
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    if (!suggestion) return;
    setApplying(true);
    setError("");
    try {
      const markerUpdates = {
        pre_climax_offset_s: suggestion.pre_climax_offset_s,
        climax_offset_s: suggestion.climax_offset_s,
        recovery_offset_s: suggestion.recovery_offset_s,
      };
      const updates = {
        ...markerUpdates,
        ...calcMetrics(markerUpdates),
        phase_marker_ai_suggestion: suggestion,
      };
      await onApply(updates);
    } catch (err) {
      console.error("AI phase marker apply failed:", err);
      setError(aiErrorMessage(err));
    } finally {
      setApplying(false);
    }
  };

  if (!hasInputs) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        AI marker suggestion needs HR data and event notes.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
            <Brain className="w-3.5 h-3.5" /> AI Phase Marker Suggestion
          </h4>
          <p className="text-xs text-muted-foreground mt-1">
            Uses event notes first, then checks the surrounding heart-rate shape.
          </p>
        </div>
        <Button size="sm" onClick={generate} disabled={loading || applying} className="h-7 text-xs gap-1.5">
          {loading ? (
            <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Suggesting...</>
          ) : (
            <><Sparkles className="w-3 h-3" />Suggest</>
          )}
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {suggestion && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <MarkerCell label="Pre-Climax" color="#a855f7" time={suggestion.pre_climax_offset_s} confidence={suggestion.pre_climax_confidence} />
            <MarkerCell label="Climax" color="#ef4444" time={suggestion.climax_offset_s} confidence={suggestion.climax_confidence} />
            <MarkerCell label="Recovery" color="#3b82f6" time={suggestion.recovery_offset_s} confidence={suggestion.recovery_confidence} />
          </div>

          {suggestion.evidence.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">Evidence</p>
              <ul className="space-y-1">
                {suggestion.evidence.map((item, index) => (
                  <li key={index} className="text-xs text-foreground/85 leading-relaxed pl-3 border-l border-primary/40">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {suggestion.reasoning && (
            <p className="text-xs text-muted-foreground leading-relaxed">{suggestion.reasoning}</p>
          )}

          <div className="flex justify-end">
            <Button size="sm" onClick={apply} disabled={applying || loading} className="h-8 text-xs gap-1.5">
              {applying ? (
                <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Applying...</>
              ) : (
                <><Check className="w-3.5 h-3.5" />Apply Markers</>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
