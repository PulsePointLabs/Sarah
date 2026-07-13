import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Brain, Check, Loader2, Sparkles, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { EVENT_CATEGORIES, normalizeCategoryArray } from "./session-form/EventTimelineSection";
import { buildAIGroundingContext } from "@/lib/aiGrounding";
import { buildSessionVisualEvidenceDigest } from "@/lib/visualEvidence";
import { cleanTextForSpeech, getTTSMime, getTTSRuntime, prepareTTSInput } from "@/components/TTSButton";

function fmtMmSs(value) {
  if (value == null || Number(value) < 0) return "--";
  const total = Math.round(Number(value));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatSpokenTimeValue(totalSeconds) {
  const total = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes > 0 && seconds > 0) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }
  if (minutes > 0) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function formatSpokenTimeCode(minutesText, secondsText) {
  return formatSpokenTimeValue((Number(minutesText) * 60) + Number(secondsText));
}

function formatEvidenceTimeText(text) {
  return String(text || "").replace(/\b(\d{2,5})\s*s\b/g, (_, seconds) => `${fmtMmSs(Number(seconds))}`);
}

function humanizePhaseMarkerText(text) {
  return String(text || "")
    .replace(/\bE(\d+)\b/g, (_, index) => `event marker ${index}`)
    .replace(/\b(\d+):([0-5]\d)\b/g, (_, minutes, seconds) => formatSpokenTimeCode(minutes, seconds))
    .replace(/\b(\d{2,5})\s*s\b/g, (_, seconds) => formatSpokenTimeValue(Number(seconds)))
    .replace(/\bHR\b/g, "heart rate");
}

function base64ToAudioBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer.slice(0);
}

async function fetchTTSBase64(text) {
  const runtime = getTTSRuntime();
  const format = runtime.format;
  const res = await base44.functions.invoke("openaiTTS", {
    text: prepareTTSInput(text),
    voice: "nova",
    model: runtime.model,
    speed: runtime.speed,
    instructions: runtime.supportsInstructions ? runtime.instructions : "",
    format,
  });
  return {
    audio: res?.data?.audio || "",
    mimeType: getTTSMime(format),
  };
}

function normalizeFindingsText(text) {
  return humanizePhaseMarkerText(String(text || ""))
    .replace(/\s*([,.;:!?])/g, "$1")
    .replace(/([,.;:!?])(?=\S)/g, "$1 ")
    .replace(/\s*[–—]\s*/g, " — ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function getCategoryLabel(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value)?.label || value || "Other";
}

const PHASE_NOTE_PATTERNS = {
  climax: /\b(ejaculat(?:e|ed|ion|ing)?|orgasm(?:ed|ic)?|climax(?:ed|ing)?|came|cum(?:ming|med)?|release(?:d)?|semen|emission|expulsion|spurts?|puls(?:e|ed|ing)|rhythmic contraction|involuntary contraction|ejaculatory contraction|ejaculatory reflex)\b/i,
  pre_climax: /\b(near|close|edge|edging|urge|building|final build|point of no return|about to|impending|couldn'?t hold|tense|tensing|locked|toe|curl|feet|legs|plant(?:ed|ing)?|downward|shudder|tremor|quiver|spasm|breath(?:ing)?|moan|pre[-\s]?climax|approach(?:ing)?|escalat(?:e|ed|ing)|intensif(?:y|ied|ying))\b/i,
  recovery: /\b(recover(?:y|ing)?|stopped|stopping|stop(?:ped)? all|all stimulation stopped|stimulation stopped|stimulation ended|ceased|hands off|toy off|vibrator off|sleeve removed|slowed|slowing|pause|paused|relax(?:ed|ing)?|body relaxed|settled|refractory|afterglow|cleanup|finished|ended|soften(?:ed|ing)?|flaccid|breathing normalized|heart rate drop|parasympathetic)\b/i,
};

const STRONG_PHASE_PATTERNS = {
  climax: /\b(ejaculat(?:e|ed|ion|ing)?|orgasm(?:ed|ic)?|climax(?:ed|ing)?|came|cum(?:ming|med)?|semen|emission|expulsion|ejaculatory reflex|ejaculatory contraction|rhythmic contraction)\b/i,
  finalApproach: /\b(point of no return|about to|impending|couldn'?t hold|final build|near(?:ing)? climax|close to climax|edge|edging|urge|locked|maximum|peak|intensif(?:y|ied|ying)|escalat(?:e|ed|ing))\b/i,
  bodyApproach: /\b(feet|foot|legs|toe|curl|plant(?:ed|ing)?|downward|shudder|tremor|quiver|spasm|breath(?:ing)?|pelvic|tense|tensing|locked)\b/i,
  recoveryStrong: /\b(all stimulation stopped|stimulation stopped|stimulation ended|hands off|toy off|vibrator off|sleeve removed|recovery|refractory|cleanup|finished|ended|soften(?:ed|ing)?|flaccid|breathing normalized|body relaxed|settled)\b/i,
  transientPause: /\b(reposition|position|comfort|pause|paused|slowed|slowing|adjust|break)\b/i,
};

const PRE_EJACULATE_OBSERVATION_PATTERN = /\b(pre[-\s]?ejaculat(?:e|ory|ion)?|pre[-\s]?cum|precum|cowper'?s?|cowper|meatus)\b/i;
const EXPLICIT_CLIMAX_PATTERN = /\b(ejaculat(?:ed|ion|ing)|orgasm(?:ed|ic)?|climax(?:ed|ing)?|came|cum(?:ming|med)?|ejaculatory reflex|ejaculatory contraction|semen emission|full release|release of semen)\b/i;
const RELEASE_WITH_CONTEXT_PATTERN = /\b(release|released)\b/i;
const LIVE_CUE_SOFT_CLIMAX_PATTERN = /\bsarah live cue:\s*climax\s+(possible|imminent)\b/i;
const SOFT_APPROACH_CUE_PATTERN = /\b(climax possible|climax imminent|near climax|possible climax|imminent climax)\b/i;

function isPreEjaculateObservation(note) {
  const text = String(note || "");
  if (!PRE_EJACULATE_OBSERVATION_PATTERN.test(text)) return false;
  return !EXPLICIT_CLIMAX_PATTERN.test(text) && !/\b(climax|orgasm|ejaculat(?:ed|ion|ing)|semen emission|full release|ejaculatory contraction)\b/i.test(text);
}

function hasExplicitClimaxCue(note) {
  const text = String(note || "");
  if (!text.trim() || isPreEjaculateObservation(text)) return false;
  if (LIVE_CUE_SOFT_CLIMAX_PATTERN.test(text)) return false;
  if (SOFT_APPROACH_CUE_PATTERN.test(text) && !/\b(ejaculat(?:ed|ion|ing)|orgasm(?:ed|ic)?|came|cum(?:ming|med)?|semen|emission|spurts?|ejaculatory)\b/i.test(text)) {
    return false;
  }
  if (EXPLICIT_CLIMAX_PATTERN.test(text)) return true;
  return RELEASE_WITH_CONTEXT_PATTERN.test(text) && /\b(semen|ejaculat|orgasm|climax|cum|ejaculatory|emission|expulsion|spurts?)\b/i.test(text);
}

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
    evidence: Array.isArray(parsed?.evidence)
      ? parsed.evidence.filter(Boolean).slice(0, 8).map((item) => normalizeFindingsText(formatEvidenceTimeText(item)))
      : [],
    reasoning: normalizeFindingsText(formatEvidenceTimeText(String(parsed?.reasoning || "").trim())),
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

  const climaxIndex = events.findIndex((event) => hasExplicitClimaxCue(event.note));
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
    const chosenPool = finalWindow.length ? finalWindow : preCandidates;
    const chosen = chosenPool[chosenPool.length - 1];
    preClimax = chosen ? eventAt(chosen.event, chosen.index, "pre-climax escalation") : null;
  }

  return { preClimax, climax, recovery };
}

function findEventNearTime(session, time_s, toleranceS = 4) {
  if (time_s == null) return null;
  return (session.event_timeline || [])
    .map((event, index) => ({ event, index, distance: Math.abs(Number(event.time_s) - Number(time_s)) }))
    .filter((item) => Number.isFinite(item.distance) && item.distance <= toleranceS)
    .sort((a, b) => a.distance - b.distance)[0] || null;
}

function findPeakHrMarker(rows) {
  const peak = [...(rows || [])]
    .filter((row) => getHR(row) != null && Number.isFinite(Number(row.time_offset_s)))
    .sort((a, b) => getHR(b) - getHR(a))[0];
  return peak ? Math.round(Number(peak.time_offset_s)) : null;
}

function validateTimelineSuggestion(suggestion, session, rows = []) {
  const anchors = findPhaseEvidenceAnchors(session);
  const next = {
    ...suggestion,
    evidence: [...(suggestion.evidence || [])],
  };
  const hasValidOrder = (value) =>
    value.climax_offset_s != null &&
    (value.pre_climax_offset_s == null || value.pre_climax_offset_s < value.climax_offset_s) &&
    (value.recovery_offset_s == null || value.recovery_offset_s >= value.climax_offset_s);

  if (anchors.climax && (next.climax_offset_s == null || !hasValidOrder(next))) {
    next.climax_offset_s = anchors.climax.time_s;
    next.climax_confidence = Math.max(next.climax_confidence || 0, 0.95);
    next.evidence.unshift(`Ordering check used explicit climax cue: ${anchors.climax.evidence}`);
  }

  const suggestedClimaxEvent = findEventNearTime(session, next.climax_offset_s);
  const suggestedNote = String(suggestedClimaxEvent?.event?.note || "");
  if (!anchors.climax && isPreEjaculateObservation(suggestedNote)) {
    const peakTime = findPeakHrMarker(rows);
    if (peakTime != null) {
      next.climax_offset_s = peakTime;
      next.climax_confidence = Math.min(next.climax_confidence || 0.45, 0.48);
      next.evidence.unshift(`Climax caution: E${suggestedClimaxEvent.index + 1} at ${fmtMmSs(suggestedClimaxEvent.event.time_s)} mentions pre-ejaculate/fluid, not climax; using HR peak near ${fmtMmSs(peakTime)} as a lower-confidence fallback.`);
    } else {
      next.climax_confidence = Math.min(next.climax_confidence || 0.35, 0.35);
      next.evidence.unshift(`Climax caution: E${suggestedClimaxEvent.index + 1} at ${fmtMmSs(suggestedClimaxEvent.event.time_s)} mentions pre-ejaculate/fluid, which is not a climax cue by itself.`);
    }
  }

  const climaxTime = next.climax_offset_s;
  if (anchors.recovery && climaxTime != null && (next.recovery_offset_s == null || next.recovery_offset_s < climaxTime)) {
    next.recovery_offset_s = anchors.recovery.time_s;
    next.recovery_confidence = Math.max(next.recovery_confidence || 0, 0.9);
    next.evidence.unshift(`Ordering check used explicit recovery cue: ${anchors.recovery.evidence}`);
  }

  if (anchors.preClimax && climaxTime != null && (next.pre_climax_offset_s == null || next.pre_climax_offset_s >= climaxTime)) {
    next.pre_climax_offset_s = anchors.preClimax.time_s;
    next.pre_climax_confidence = Math.max(next.pre_climax_confidence || 0, 0.82);
    next.evidence.unshift(`Ordering check used final pre-climax cue: ${anchors.preClimax.evidence}`);
  }

  next.evidence = [...new Set(next.evidence.map((item) => normalizeFindingsText(formatEvidenceTimeText(item))))].slice(0, 8);
  return next;
}

function scoreEventForPhase(event, index, events, hrHelpers) {
  const note = String(event?.note || "");
  const t = Math.round(Number(event?.time_s) || 0);
  const hr = hrHelpers.windowSummary(t);
  const categories = normalizeCategoryArray(event?.category);
  let climaxScore = 0;
  let preScore = 0;
  let recoveryScore = 0;

  if (hasExplicitClimaxCue(note)) climaxScore += STRONG_PHASE_PATTERNS.climax.test(note) ? 100 : 70;
  if (categories.includes("climax") || categories.includes("orgasm")) climaxScore += 30;

  if (STRONG_PHASE_PATTERNS.finalApproach.test(note)) preScore += 48;
  if (STRONG_PHASE_PATTERNS.bodyApproach.test(note)) preScore += 24;
  if (PHASE_NOTE_PATTERNS.pre_climax.test(note)) preScore += 18;
  if (categories.includes("physical") || categories.includes("sensation")) preScore += 8;
  if (hr?.after_minus_before != null && hr.after_minus_before > 2) preScore += Math.min(18, hr.after_minus_before * 2);

  if (STRONG_PHASE_PATTERNS.recoveryStrong.test(note)) recoveryScore += 65;
  else if (PHASE_NOTE_PATTERNS.recovery.test(note)) recoveryScore += 30;
  if (STRONG_PHASE_PATTERNS.transientPause.test(note)) recoveryScore -= 12;
  if (hr?.after_minus_before != null && hr.after_minus_before < -2) recoveryScore += Math.min(20, Math.abs(hr.after_minus_before) * 2);

  return {
    event,
    index,
    time_s: t,
    note,
    hr,
    climaxScore,
    preScore,
    recoveryScore,
  };
}

function buildWholeTimelineDraft(session, rows) {
  const hrHelpers = buildHRHelpers(rows);
  const events = (session.event_timeline || [])
    .slice()
    .sort((a, b) => Number(a.time_s) - Number(b.time_s));
  const scored = events.map((event, index) => scoreEventForPhase(event, index, events, hrHelpers));
  const sortedRows = hrHelpers.sortedRows;
  const evidence = [];
  const durationS = Math.round(Math.max(...sortedRows.map((row) => Number(row.time_offset_s) || 0), 0));
  const sessionEarlyGuardS = Math.min(10 * 60, Math.max(4 * 60, durationS * 0.3));

  const bestClimax = scored
    .filter((item) => item.climaxScore >= 60)
    .sort((a, b) => {
      const aLateBonus = a.time_s >= sessionEarlyGuardS ? 1 : 0;
      const bLateBonus = b.time_s >= sessionEarlyGuardS ? 1 : 0;
      return bLateBonus - aLateBonus || b.climaxScore - a.climaxScore || b.time_s - a.time_s;
    })[0];

  let climax = bestClimax?.time_s ?? null;
  let climaxConfidence = bestClimax ? Math.min(0.98, 0.68 + bestClimax.climaxScore / 300) : 0;
  if (bestClimax) {
    evidence.push(`Climax anchor: E${bestClimax.index + 1} at ${fmtMmSs(bestClimax.time_s)} uses explicit climax or ejaculation language: "${bestClimax.note.slice(0, 140)}"`);
  }

  if (climax == null && sortedRows.length) {
    const lateRows = sortedRows.filter((row) => Number(row.time_offset_s) >= sessionEarlyGuardS);
    const fallbackPool = lateRows.length ? lateRows : sortedRows;
    const peak = [...fallbackPool].filter((row) => getHR(row) != null).sort((a, b) => getHR(b) - getHR(a))[0];
    if (peak) {
      climax = Math.round(Number(peak.time_offset_s));
      climaxConfidence = 0.42;
      evidence.push(`Fallback climax anchor: strongest HR peak near ${fmtMmSs(climax)} because no explicit release note was found.`);
    }
  }

  const preCandidates = climax != null
    ? scored.filter((item) => item.time_s < climax && item.time_s >= climax - 360 && item.preScore >= 25)
    : scored.filter((item) => item.preScore >= 35);
  const finalApproachCandidates = preCandidates
    .map((item) => ({
      ...item,
      distancePenalty: climax != null ? Math.max(0, (climax - item.time_s - 210) / 15) : 0,
      clusterScore: preCandidates.filter((other) => Math.abs(other.time_s - item.time_s) <= 120).reduce((sum, other) => sum + other.preScore, 0),
      recencyBonus: climax != null ? Math.max(0, 40 - Math.abs((climax - item.time_s) - 120) / 3) : 0,
    }))
    .sort((a, b) => (b.preScore + b.clusterScore * 0.12 + b.recencyBonus - b.distancePenalty) - (a.preScore + a.clusterScore * 0.12 + a.recencyBonus - a.distancePenalty));
  let pre = finalApproachCandidates[0]?.time_s ?? null;
  let preConfidence = finalApproachCandidates[0] ? Math.min(0.9, 0.5 + finalApproachCandidates[0].preScore / 180) : 0;
  if (pre != null && climax != null && pre >= climax) pre = null;
  if (pre == null && climax != null) {
    const risingWindows = summarizeTrendWindows(sortedRows.filter((row) => Number(row.time_offset_s) < climax), 90, 3).strongest_rises;
    const rise = risingWindows.find((win) => win.end_s < climax && win.end_s >= climax - 360);
    if (rise) {
      pre = rise.start_s;
      preConfidence = 0.46;
      evidence.push(`Pre-climax fallback: strongest late HR rise begins around ${fmtMmSs(pre)} and runs to ${fmtMmSs(rise.end_s)}.`);
    }
  }
  if (finalApproachCandidates[0]) {
    evidence.push(`Pre-climax anchor: E${finalApproachCandidates[0].index + 1} at ${fmtMmSs(finalApproachCandidates[0].time_s)} is the strongest late approach cue before climax: "${finalApproachCandidates[0].note.slice(0, 140)}"`);
  }

  const recoveryCandidates = climax != null
    ? scored.filter((item) => item.time_s >= climax && item.recoveryScore >= 25)
    : scored.filter((item) => item.recoveryScore >= 45);
  const recoveryBest = recoveryCandidates
    .sort((a, b) => {
      const aStrong = STRONG_PHASE_PATTERNS.recoveryStrong.test(a.note) ? 1 : 0;
      const bStrong = STRONG_PHASE_PATTERNS.recoveryStrong.test(b.note) ? 1 : 0;
      return bStrong - aStrong || a.time_s - b.time_s || b.recoveryScore - a.recoveryScore;
    })[0];
  let recovery = recoveryBest?.time_s ?? null;
  let recoveryConfidence = recoveryBest ? Math.min(0.92, 0.5 + recoveryBest.recoveryScore / 180) : 0;
  if (recoveryBest) {
    evidence.push(`Recovery anchor: E${recoveryBest.index + 1} at ${fmtMmSs(recoveryBest.time_s)} shows post-climax de-escalation: "${recoveryBest.note.slice(0, 140)}"`);
  }
  if (recovery == null && climax != null) {
    const drops = summarizeTrendWindows(sortedRows.filter((row) => Number(row.time_offset_s) >= climax), 90, 3).strongest_drops;
    const drop = drops[0];
    if (drop) {
      recovery = drop.start_s;
      recoveryConfidence = 0.44;
      evidence.push(`Recovery fallback: HR begins its strongest post-climax drop around ${fmtMmSs(recovery)}.`);
    }
  }

  const draft = validateTimelineSuggestion({
    pre_climax_offset_s: pre,
    climax_offset_s: climax,
    recovery_offset_s: recovery,
    pre_climax_confidence: preConfidence,
    climax_confidence: climaxConfidence,
    recovery_confidence: recoveryConfidence,
    evidence,
    reasoning: "Phase Detection 2.0 draft: marker placement is based on the full note sequence first, then checked against HR movement and chronological ordering.",
  }, session, rows);

  return draft;
}

function getHR(row) {
  const value = Number(row?.hr_smoothed ?? row?.hr);
  return Number.isFinite(value) ? value : null;
}

function summarizeTrendWindows(sortedRows, windowS = 90, limit = 6) {
  if (sortedRows.length < 2) return { strongest_rises: [], strongest_drops: [] };
  const stride = Math.max(1, Math.floor(sortedRows.length / 120));
  const windows = [];

  for (let i = 0; i < sortedRows.length; i += stride) {
    const start = sortedRows[i];
    const startTime = Number(start.time_offset_s);
    const startHR = getHR(start);
    if (!Number.isFinite(startTime) || startHR == null) continue;

    const targetTime = startTime + windowS;
    let end = null;
    let bestDistance = Infinity;
    for (let j = i + 1; j < sortedRows.length; j += 1) {
      const rowTime = Number(sortedRows[j].time_offset_s);
      const distance = Math.abs(rowTime - targetTime);
      if (distance < bestDistance) {
        end = sortedRows[j];
        bestDistance = distance;
      }
      if (rowTime > targetTime + 12) break;
    }

    const endTime = Number(end?.time_offset_s);
    const endHR = getHR(end);
    if (!end || endHR == null || !Number.isFinite(endTime) || endTime - startTime < windowS * 0.65) continue;

    windows.push({
      start_s: Math.round(startTime),
      start: fmtMmSs(startTime),
      end_s: Math.round(endTime),
      end: fmtMmSs(endTime),
      start_hr: Math.round(startHR),
      end_hr: Math.round(endHR),
      delta_hr: Math.round(endHR - startHR),
    });
  }

  const byDelta = (a, b) => b.delta_hr - a.delta_hr;
  return {
    strongest_rises: windows.filter((w) => w.delta_hr > 0).sort(byDelta).slice(0, limit),
    strongest_drops: windows.filter((w) => w.delta_hr < 0).sort((a, b) => a.delta_hr - b.delta_hr).slice(0, limit),
  };
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
        .filter(([key, regex]) => key === "climax" ? hasExplicitClimaxCue(note) : regex.test(note))
        .map(([key]) => key);
      const categories = normalizeCategoryArray(event.category).map(getCategoryLabel);
      const previous = events[index - 1];
      const next = events[index + 1];
      return {
        index: index + 1,
        time_s: Math.round(Number(event.time_s) || 0),
        time: fmtMmSs(event.time_s),
        minutes_seconds: fmtMmSs(event.time_s),
        categories,
        note_cues_only_not_a_phase_decision: tags.length ? tags : ["context"],
        note,
        hr_context: windowSummary(Number(event.time_s) || 0),
        previous_event_gap_s: previous ? Math.round(Number(event.time_s) - Number(previous.time_s)) : null,
        next_event_gap_s: next ? Math.round(Number(next.time_s) - Number(event.time_s)) : null,
        previous_note: previous?.note ? String(previous.note).slice(0, 120) : null,
        next_note: next?.note ? String(next.note).slice(0, 120) : null,
      };
    })
    .filter(Boolean)
    .slice(0, 80);
}

function buildTimelineEvidence(session, rows) {
  const { sortedRows } = buildHRHelpers(rows);
  const hrValues = sortedRows.map(getHR).filter((value) => value != null);
  const durationS = Math.round(Math.max(
    ...sortedRows.map((r) => Number(r.time_offset_s) || 0),
    Number(session.duration_minutes || 0) * 60,
    0
  ));
  const peakPoints = [...sortedRows]
    .filter((row) => getHR(row) != null)
    .sort((a, b) => getHR(b) - getHR(a))
    .slice(0, 8)
    .sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s))
    .map((row) => ({
      time_s: Math.round(Number(row.time_offset_s)),
      time: fmtMmSs(row.time_offset_s),
      hr: Math.round(getHR(row)),
    }));
  const anchors = findPhaseEvidenceAnchors(session);

  return {
    session_duration_s: durationS,
    session_duration: fmtMmSs(durationS),
    event_count: (session.event_timeline || []).length,
    hr_summary: hrValues.length ? {
      min_hr: Math.round(Math.min(...hrValues)),
      max_hr: Math.round(Math.max(...hrValues)),
      range_bpm: Math.round(Math.max(...hrValues) - Math.min(...hrValues)),
      peak_points: peakPoints,
      ...summarizeTrendWindows(sortedRows, 90, 6),
    } : null,
    current_saved_markers: {
      pre_climax: session.pre_climax_offset_s != null ? fmtMmSs(session.pre_climax_offset_s) : null,
      climax: session.climax_offset_s != null ? fmtMmSs(session.climax_offset_s) : null,
      recovery: session.recovery_offset_s != null ? fmtMmSs(session.recovery_offset_s) : null,
    },
    explicit_note_cues_for_sanity_check_only: {
      pre_climax: anchors.preClimax?.evidence || null,
      climax: anchors.climax?.evidence || null,
      recovery: anchors.recovery?.evidence || null,
    },
    event_sequence: buildCandidateEvents(session, rows),
  };
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
  const [speakingKey, setSpeakingKey] = useState(null);
  const [speechLoadingKey, setSpeechLoadingKey] = useState(null);
  const localDraft = useMemo(() => buildWholeTimelineDraft(session, timelineRows), [session, timelineRows]);
  const [suggestion, setSuggestion] = useState(session.phase_marker_ai_suggestion || localDraft || null);
  const [error, setError] = useState("");
  const audioRef = useRef(null);
  const audioUrlRef = useRef("");

  const hasInputs = timelineRows.length > 5 && (session.event_timeline || []).length > 0;
  const { calcMetrics } = useMemo(() => buildHRHelpers(timelineRows), [timelineRows]);

  const stopSpeech = useCallback(() => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.src = "";
      } catch {}
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      try { URL.revokeObjectURL(audioUrlRef.current); } catch {}
      audioUrlRef.current = "";
    }
    setSpeakingKey(null);
    setSpeechLoadingKey(null);
  }, []);

  useEffect(() => () => stopSpeech(), [stopSpeech]);

  const speakFindings = useCallback(async (text, key, label = "finding") => {
    const spokenText = cleanTextForSpeech(normalizeFindingsText(text));
    if (!spokenText) return;
    if (speakingKey === key && audioRef.current) {
      stopSpeech();
      return;
    }
    stopSpeech();
    setSpeechLoadingKey(key);
    try {
      const { audio, mimeType } = await fetchTTSBase64(`${label}. ${spokenText}`);
      if (!audio) throw new Error("TTS returned no audio");
      const url = URL.createObjectURL(new Blob([base64ToAudioBytes(audio)], { type: mimeType }));
      const audioEl = new Audio(url);
      audioUrlRef.current = url;
      audioRef.current = audioEl;
      audioEl.preload = "auto";
      audioEl.onended = () => stopSpeech();
      audioEl.onerror = () => stopSpeech();
      setSpeakingKey(key);
      setSpeechLoadingKey(null);
      await audioEl.play();
    } catch (speechError) {
      console.error("Phase marker TTS failed:", speechError);
      stopSpeech();
    }
  }, [speakingKey, stopSpeech]);

  const generate = async () => {
    setLoading(true);
    setError("");
    try {
      const timelineEvidence = buildTimelineEvidence(session, timelineRows);
      const hrSamples = buildHRSamples(timelineRows);
      const groundingContext = buildAIGroundingContext(userProfile);
      const reviewedVisualEvidence = buildSessionVisualEvidenceDigest(session);
      const draft = buildWholeTimelineDraft(session, timelineRows);

      const res = await base44.integrations.Core.InvokeLLM({
        model: "claude_sonnet_4_6",
        max_tokens: 3200,
        prompt: `You are helping place pre-climax, climax, and recovery markers on a personal physiology timeline.

Analyze the entire session arc first. Do not classify a marker from one note in isolation.

Use event notes and heart-rate trajectory together:
- Event notes describe observable behavior, stimulation changes, release language, relaxation, and body cues.
- Heart-rate shape describes the whole arousal arc, final escalation, peak/plateau timing, and post-climax de-escalation.
- The correct marker should make sense in the full sequence before it makes sense as an isolated note.

${groundingContext}
${reviewedVisualEvidence}

Choose:
- pre_climax_offset_s: the beginning of the final sustained approach to climax, not the first intense or interesting cue. Look for the point where the event sequence and HR trajectory stop behaving like ordinary build/plateau and become the final approach.
- climax_offset_s: the most likely climax/release/ejaculation moment. Explicit ejaculation, orgasm, climax, release, semen/emission, or ejaculatory contractions are strongest evidence, but place it in the surrounding timeline rather than treating a vague word as enough by itself.
- recovery_offset_s: the start of post-climax recovery. Prefer the first post-climax point where stimulation stops/slows, tools are removed/turned off, the body relaxes/settles, breathing normalizes, refractory shift begins, cleanup begins, or HR begins sustained post-release decline.

Rules:
- Build a whole-session interpretation first, then choose markers.
- Do not choose an early note simply because it contains words like tense, legs, feet, building, or tremor. Those may be ordinary build or plateau unless the later timeline confirms they are part of the final approach.
- Do not choose recovery before climax just because a note says pause, slowed, relaxed, or repositioned. Recovery must follow release/climax or a clearly final stopping/de-escalation.
- Never choose the HR peak as climax when notes explicitly place ejaculation/release/climax elsewhere, but do use HR shape to decide whether vague notes are plausible.
- Treat "ejaculation", "orgasm", "climax", "came", "cum", "release of semen", "semen emission", or "ejaculatory contractions" as the strongest climax evidence.
- Do not treat pre-ejaculate, Cowper fluid, meatus observations, lubrication, or arousal fluid as climax. Those are observations unless the note also explicitly says orgasm/climax/ejaculation/release occurred.
- If no explicit climax/release note exists, use the strongest HR peak together with late approach cues as a lower-confidence estimate and say that it is a fallback.
- Treat "all stimulation stopped", "stimulation stopped", "hands off", "toy/vibrator off", "sleeve removed", "relaxed", "settled", "refractory", "cleanup", "softened/flaccid", or "breathing normalized" after climax as strong recovery evidence.
- If a note contains both climax and immediate recovery language, set climax to that event and recovery to the next timestamp showing stopping/relaxation if one exists; otherwise recovery may be the same timestamp only when the note explicitly says recovery began.
- Pre-climax must be before climax. Recovery must be at or after climax. If the best evidence violates that ordering, explain why and choose the nearest ordered marker.
- Return marker offsets as seconds numbers only. If a marker is truly unknowable, return -1 for that marker.
- In evidence and reasoning, express times as m:ss, not raw seconds.
- Keep evidence concise and cite multiple timeline facts when possible: event number/time, note cue, HR trend/peak/drop, and what came before/after.

Compact HR samples time:heart-rate:
${hrSamples}

Phase Detection 2.0 evidence-guided draft:
${JSON.stringify(draft, null, 2)}

Whole-session timeline evidence:
${JSON.stringify(timelineEvidence, null, 2)}

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

      const normalized = validateTimelineSuggestion(normalizeSuggestion(res), session, timelineRows);
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
    <div className="min-w-0 rounded-xl border border-border bg-muted/30 p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
            <Brain className="w-3.5 h-3.5" /> AI Phase Marker Suggestion
          </h4>
          <p className="text-xs text-muted-foreground mt-1">
            Reads the full event sequence with the heart-rate arc, then checks marker ordering.
          </p>
        </div>
        <Button size="sm" onClick={generate} disabled={loading || applying} className="h-7 text-xs gap-1.5">
          {loading ? (
            <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Suggesting...</>
          ) : (
            <><Sparkles className="w-3 h-3" />Refine</>
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
          {suggestion === localDraft && (
            <div className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary">
              Phase Detection 2.0 has drafted markers from the whole timeline. Use Refine for an AI pass, or apply this evidence-guided draft.
            </div>
          )}
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
                  <li key={index}>
                    <button
                      type="button"
                      onClick={() => speakFindings(item, `evidence-${index}`, `Evidence ${index + 1}`)}
                      className="flex min-w-0 w-full items-start gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:border-primary/20 hover:bg-primary/5"
                      title={speakingKey === `evidence-${index}` ? "Tap to stop Sarah" : "Tap to hear Sarah read this finding"}
                    >
                      <span className="mt-0.5 min-w-0 flex-1 break-words border-l border-primary/40 pl-3 text-xs text-foreground/85 leading-relaxed">
                        {item}
                      </span>
                      {(speechLoadingKey === `evidence-${index}` || speakingKey === `evidence-${index}`) && (
                        <span className="ml-auto mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[9px] font-semibold text-primary">
                          {speechLoadingKey === `evidence-${index}` ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Volume2 className="h-2.5 w-2.5" />}
                          {speechLoadingKey === `evidence-${index}` ? "Sarah loading" : "Sarah reading"}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {suggestion.reasoning && (
            <button
              type="button"
              onClick={() => speakFindings(suggestion.reasoning, "reasoning", "Reasoning")}
              className="flex min-w-0 w-full items-start gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:border-primary/20 hover:bg-primary/5"
              title={speakingKey === "reasoning" ? "Tap to stop Sarah" : "Tap to hear Sarah read this reasoning"}
            >
              <span className="min-w-0 flex-1 break-words text-xs leading-relaxed text-muted-foreground">{suggestion.reasoning}</span>
              {(speechLoadingKey === "reasoning" || speakingKey === "reasoning") && (
                <span className="ml-auto mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[9px] font-semibold text-primary">
                  {speechLoadingKey === "reasoning" ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Volume2 className="h-2.5 w-2.5" />}
                  {speechLoadingKey === "reasoning" ? "Sarah loading" : "Sarah reading"}
                </span>
              )}
            </button>
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
