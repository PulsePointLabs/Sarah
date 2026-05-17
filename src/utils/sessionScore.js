// Shared session score computation (mirrors SessionExecutiveSummary logic)
import { base44 } from "@/api/base44Client";

function calcHRVariability(rows) {
  if (!rows || rows.length < 5) return null;
  const hrs = rows.map((r) => Number(r.hr)).filter((v) => !isNaN(v));
  const mean = hrs.reduce((a, b) => a + b, 0) / hrs.length;
  const std = Math.sqrt(hrs.reduce((a, v) => a + (v - mean) ** 2, 0) / hrs.length);
  return std;
}

function calcRecoveryTime(session) {
  if (session?.climax_offset_s == null || session?.recovery_offset_s == null) return null;
  return Math.abs(session.recovery_offset_s - session.climax_offset_s);
}

function calcHRRise(session) {
  if (!session?.hr_avg_pre_to_climax || !session?.avg_hr) return null;
  return session.hr_avg_pre_to_climax - session.avg_hr;
}

function calcPauseTime(session) {
  const events = session?.event_timeline || [];
  const cats = (ev) => Array.isArray(ev.category) ? ev.category : [ev.category].filter(Boolean);
  const sorted = [...events].sort((a, b) => a.time_s - b.time_s);
  let totalPause = 0;
  let pauseStart = null;
  for (const ev of sorted) {
    const c = cats(ev);
    if (c.includes("stimulation_paused") && pauseStart == null) pauseStart = ev.time_s;
    if (c.includes("stimulation_resumed") && pauseStart != null) {
      totalPause += ev.time_s - pauseStart;
      pauseStart = null;
    }
  }
  return totalPause;
}

function calcDiscomfortPenalty(session) {
  if (session?.discomfort_entries?.length > 0) {
    const avg = session.discomfort_entries.reduce((a, e) => a + (e.severity || 5), 0) / session.discomfort_entries.length;
    return avg;
  }
  if (session?.discomfort) return 5;
  return 0;
}

const CLIMAX_DUR_SCORE = { long: 10, medium: 7, short: 4 };

export function computeSessionScore(session, timelineRows = []) {
  const factors = [];

  if (session.satisfaction)
    factors.push({ score: (session.satisfaction / 10) * 25, max: 25 });

  if (session.build_quality)
    factors.push({ score: (session.build_quality / 10) * 20, max: 20 });

  const hrVar = calcHRVariability(timelineRows);
  if (hrVar != null) {
    const n = Math.min(1, hrVar < 18 ? hrVar / 18 : Math.max(0, 1 - (hrVar - 18) / 20));
    factors.push({ score: n * 15, max: 15 });
  }

  const recoveryS = calcRecoveryTime(session);
  if (recoveryS != null) {
    const n = recoveryS <= 90 ? 1 : recoveryS >= 300 ? 0 : 1 - (recoveryS - 90) / 210;
    factors.push({ score: n * 15, max: 15 });
  }

  if (session.climax_duration)
    factors.push({ score: ((CLIMAX_DUR_SCORE[session.climax_duration] || 5) / 10) * 10, max: 10 });

  const hrRise = calcHRRise(session);
  if (hrRise != null) {
    factors.push({ score: Math.min(1, Math.max(0, hrRise / 20)) * 10, max: 10 });
  }

  const pauseS = calcPauseTime(session);
  if (pauseS > 0 && session.duration_minutes) {
    const ratio = Math.min(1, pauseS / (session.duration_minutes * 60));
    factors.push({ score: -ratio * 10, max: 0, penalty: true });
  }

  const discomfort = calcDiscomfortPenalty(session);
  if (discomfort > 0)
    factors.push({ score: -(discomfort / 10) * 15, max: 0, penalty: true });

  if (!factors.length) return null;

  const totalMax = factors.filter((f) => !f.penalty).reduce((a, f) => a + f.max, 0);
  const totalScore = factors.reduce((a, f) => a + f.score, 0);
  if (totalMax === 0) return null;
  return Math.round(Math.max(0, Math.min(100, (totalScore / totalMax) * 100)));
}

export async function computeAISessionScore(session, timelineRows = []) {
  if (!session) return null;
  const eventCount = (session.event_timeline || []).length;
  const hrData = timelineRows.length > 0
    ? `Avg HR: ${session.avg_hr || "—"} bpm, Max: ${session.max_hr || "—"}, Recovery time: ${session.recovery_offset_s != null && session.climax_offset_s != null ? Math.round((session.recovery_offset_s - session.climax_offset_s) / 60) + "s" : "—"}`
    : "No HR data";
  const arousal = `Intensity: ${session.intensity || "—"}/10, Build: ${session.build_quality || "—"}/10, Satisfaction: ${session.satisfaction || "—"}/10`;
  const climax = !session.no_climax ? `Climax duration: ${session.climax_duration || "—"}, HR at climax: ${session.hr_at_climax || "—"}` : "No climax";
  const prompt = `Grade this session 0-100 based on arousal quality, physiological response, and satisfaction. Return only a number.\nArousal: ${arousal}\nClimax: ${climax}\nHR: ${hrData}\nMethods: ${(session.methods || []).join(", ") || "none"}\nBuild: ${session.build_type || "unknown"}\nEvents: ${eventCount}\nGrade:`.substring(0, 500);
  try {
    const res = await base44.integrations.Core.InvokeLLM({ prompt });
    const scoreStr = (typeof res === "string" ? res : res?.response || "").trim();
    const score = parseInt(scoreStr, 10);
    return !isNaN(score) && score >= 0 && score <= 100 ? score : null;
  } catch (err) {
    return null;
  }
}

export function gradeFromPct(pct) {
  if (pct >= 85) return { grade: "A", label: "Excellent", color: "hsl(var(--chart-1))" };
  if (pct >= 70) return { grade: "B", label: "Good", color: "hsl(var(--primary))" };
  if (pct >= 55) return { grade: "C", label: "Average", color: "hsl(var(--chart-4))" };
  if (pct >= 40) return { grade: "D", label: "Below Avg", color: "hsl(var(--chart-3))" };
  return { grade: "F", label: "Low", color: "hsl(var(--destructive))" };
}