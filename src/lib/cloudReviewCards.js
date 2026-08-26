function rows(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function clock(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function sentence(value) {
  let text = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(?:the\s+)?subject's\b/gi, "your")
    .replace(/\b(?:the\s+)?subject\s+is\b/gi, "you are")
    .replace(/\b(?:the\s+)?subject\s+has\b/gi, "you have")
    .replace(/\b(?:the\s+)?subject\b/gi, "you")
    .replace(/\btheir\b/gi, "your")
    .replace(/\bthey\s+are\b/gi, "you are")
    .replace(/\bthey\b/gi, "you")
    .replace(/\byou\s+interacts\b/gi, "you interact")
    .replace(/\byou\s+continues\b/gi, "you continue")
    .replace(/\byou\s+remains\b/gi, "you remain")
    .replace(/\byou\s+holds\b/gi, "you hold")
    .replace(/\byou\s+moves\b/gi, "you move")
    .replace(/\byou\s+uses\b/gi, "you use")
    .replace(/\byou\s+adjusts\b/gi, "you adjust")
    .replace(/\byou\s+appear\s+you\s+are\b/gi, "you appear to be")
    .replace(/\byou\s+appear\s+(lying|seated|standing)\b/gi, "you are $1")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/([,.;:])\1+/g, "$1")
    .trim();
  if (!text) return "";
  text = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function useful(values, { allowStable = false } = {}) {
  const seen = new Set();
  return rows(values)
    .map(sentence)
    .filter(Boolean)
    .filter((text) => allowStable || !/\b(?:no (?:other )?(?:significant )?(?:new )?changes?|no changes? observed|remain(?:s|ed)? (?:in )?the same|continue(?:s|d)? to)\b/i.test(text))
    .filter((text) => {
      const key = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function joinSentences(values, limit = 3) {
  return useful(values).slice(0, limit).join(" ");
}

function labelText(value) {
  return String(value || "audio activity")
    .replace(/^audio_/, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function audioKey(item = {}) {
  return `${labelText(item.label).toLowerCase()}|${item.start_ms}|${item.end_ms}`;
}

function confidenceWord(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "moderate";
  if (number >= 0.78) return "high";
  if (number >= 0.48) return "moderate";
  return "low";
}

function physiologyText(physiology = {}) {
  const heartRate = physiology.heart_rate_bpm;
  const rmssd = physiology.rmssd_ms;
  const bp = rows(physiology.blood_pressure)[0];
  const pulseOx = rows(physiology.pulse_ox)[0];
  return [
    heartRate?.samples ? `Heart rate averaged ${heartRate.avg} bpm and ranged from ${heartRate.min} to ${heartRate.max} bpm across ${heartRate.samples} aligned samples.` : null,
    rmssd?.samples ? `RMSSD averaged ${rmssd.avg} ms.` : null,
    bp?.systolic_mm_hg && bp?.diastolic_mm_hg ? `Blood pressure was ${bp.systolic_mm_hg}/${bp.diastolic_mm_hg}.` : null,
    pulseOx?.spo2_percent ? `SpO2 was ${pulseOx.spo2_percent}%.` : null,
    rows(physiology.howl_changes).length ? `${rows(physiology.howl_changes).length} Howl setting change${rows(physiology.howl_changes).length === 1 ? " was" : "s were"} aligned to this window.` : null,
  ].filter(Boolean).join(" ");
}

function visualSummary(window = {}) {
  const evidence = window.visual_evidence || {};
  const position = joinSentences(evidence.body_position, 2);
  const actions = joinSentences(evidence.actions, 3);
  const changes = joinSentences(evidence.change_across_frames, 3);
  const audio = rows(window.audio_candidates).map((item) => labelText(item.label)).filter(Boolean);
  const pieces = [position, actions, changes];
  if (audio.length) pieces.push(`Audio cues detected in this window: ${audio.join(", ")}.`);
  const clean = pieces.filter(Boolean).join(" ");
  return clean || sentence(window.review_summary || window.basis || "Cloud review retained this window for inspection.");
}

function visualTitle(window = {}) {
  const action = useful(window.visual_evidence?.actions)[0];
  if (action) return action.replace(/[.!?]$/, "").replace(/^You\s+/i, "");
  const change = useful(window.visual_evidence?.change_across_frames)[0];
  if (change) return change.replace(/[.!?]$/, "");
  return "Saved cloud visual review";
}

function visualFindings(window = {}) {
  const evidence = window.visual_evidence || {};
  const confidence = confidenceWord(window.confidence);
  const findings = [];
  const activity = [joinSentences(evidence.body_position, 2), joinSentences(evidence.actions, 3)].filter(Boolean).join(" ");
  if (activity) findings.push({ title: "Visible position and activity", text: activity, confidence, category: "cloud_visual" });
  const changes = joinSentences(evidence.change_across_frames, 4);
  if (changes) findings.push({ title: "Changes across the window", text: changes, confidence, category: "cloud_visual" });
  const equipment = [joinSentences(evidence.devices, 3), joinSentences(evidence.interactions, 2)].filter(Boolean).join(" ");
  if (equipment) findings.push({ title: "Visible equipment and interaction", text: equipment, confidence, category: "cloud_visual" });
  const physiology = physiologyText(window.physiology);
  if (physiology) findings.push({ title: "Aligned physiology", text: physiology, confidence: "high", category: "physiology" });
  const audio = rows(window.audio_candidates);
  if (audio.length) {
    findings.push({
      title: "Audio evidence",
      text: audio.map((item) => `${labelText(item.label)}${item.confidence_band ? ` (${item.confidence_band} confidence)` : ""}`).join(", ") + ".",
      confidence: confidenceWord(Math.max(...audio.map((item) => Number(item.confidence) || 0))),
      category: "cloud_audio",
    });
  }
  return findings.slice(0, 5);
}

function clipUrl(streamUrl, start, end) {
  if (!streamUrl) return "";
  const base = String(streamUrl).split("#")[0];
  return `${base}#t=${Math.max(0, start).toFixed(2)},${Math.max(start + 0.25, end).toFixed(2)}`;
}

export function buildSavedCloudReviewCards({ pass, selectedVideo = {}, streamUrl = "", isExploration = false } = {}) {
  const result = pass?.result;
  if (!result?.ok) return [];
  const sourceOffset = Number(pass?.source_video?.source_zero_session_ms || 0) / 1000;
  const windows = rows(result.multimodal_windows).slice().sort((a, b) => Number(a.start_ms || 0) - Number(b.start_ms || 0));
  const usedAudio = new Set();

  const visualCards = windows.map((window, index) => {
    const sourceStart = Math.max(0, Number(window.start_ms || 0) / 1000);
    const sourceEnd = Math.max(sourceStart + 0.25, Number(window.end_ms ?? window.start_ms ?? 0) / 1000);
    const start = sourceStart + sourceOffset;
    const end = sourceEnd + sourceOffset;
    rows(window.audio_candidates).forEach((item) => usedAudio.add(audioKey(item)));
    const summary = visualSummary(window);
    return {
      id: `saved-cloud-${pass.id || result.id || "pass"}-${window.id || index}`,
      cloudMultimodal: true,
      label: `Cloud video review ${clock(start)}-${clock(end)}`,
      window: { start, end },
      sourceWindow: { start: sourceStart, end: sourceEnd },
      sourceVideo: selectedVideo,
      sourceVideoRole: pass?.source_video?.role && pass.source_video.role !== "unknown"
        ? pass.source_video.role
        : selectedVideo?.role || "main",
      clipUrl: clipUrl(streamUrl, sourceStart, sourceEnd),
      thumbnailUrl: "",
      sampledFrames: [],
      motionSummary: null,
      telemetry: physiologyText(window.physiology) || "No aligned physiology was saved for this window.",
      summary,
      findings: visualFindings(window).length ? visualFindings(window) : [{ title: visualTitle(window), text: summary, confidence: confidenceWord(window.confidence), category: "cloud_visual" }],
      events: [{
        time_s: Number(window.representative_time_ms ?? window.start_ms ?? 0) / 1000 + sourceOffset,
        note: summary,
        category: isExploration ? ["physical"] : ["other"],
        annotation_tags: ["cloud_multimodal", "visual_evidence"],
        confidence: confidenceWord(window.confidence),
      }],
      confidence: confidenceWord(window.confidence),
    };
  });

  const unmatchedAudio = rows(result.strong_candidates)
    .filter((item) => String(item?.provenance?.modality || "").toLowerCase() === "audio")
    .filter((item) => !usedAudio.has(audioKey(item)))
    .map((item, index) => {
      const sourceStart = Math.max(0, Number(item.start_ms || 0) / 1000);
      const sourceEnd = Math.max(sourceStart + 0.25, Number(item.end_ms ?? item.start_ms ?? 0) / 1000);
      const start = sourceStart + sourceOffset;
      const end = sourceEnd + sourceOffset;
      const label = labelText(item.label);
      const text = `${label.charAt(0).toUpperCase()}${label.slice(1)} was detected in the saved audio track${item.confidence_band ? ` with ${item.confidence_band} confidence` : ""}.`;
      return {
        id: `saved-cloud-${pass.id || result.id || "pass"}-audio-${item.id || index}`,
        cloudMultimodal: true,
        label: `Cloud audio review ${clock(start)}-${clock(end)}`,
        window: { start, end },
        sourceWindow: { start: sourceStart, end: sourceEnd },
        sourceVideo: selectedVideo,
        sourceVideoRole: pass?.source_video?.role && pass.source_video.role !== "unknown"
          ? pass.source_video.role
          : selectedVideo?.role || "main",
        clipUrl: clipUrl(streamUrl, sourceStart, sourceEnd),
        thumbnailUrl: "",
        sampledFrames: [],
        motionSummary: null,
        telemetry: "Saved cloud audio evidence.",
        summary: text,
        findings: [{ title: `${label.charAt(0).toUpperCase()}${label.slice(1)} audio cue`, text, confidence: confidenceWord(item.confidence), category: "cloud_audio" }],
        events: [{
          time_s: start,
          note: text,
          category: isExploration ? ["physical"] : ["other"],
          annotation_tags: ["cloud_multimodal", "audio_evidence"],
          confidence: confidenceWord(item.confidence),
        }],
        confidence: confidenceWord(item.confidence),
      };
    });

  return [...visualCards, ...unmatchedAudio].sort((a, b) => a.window.start - b.window.start);
}
