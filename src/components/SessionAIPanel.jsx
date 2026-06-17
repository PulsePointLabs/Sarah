import { useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { AlertCircle, Brain, Activity, Lightbulb, TrendingUp, Zap, ChevronDown, ChevronUp, Download, Loader2, MessageCircle, Video } from "lucide-react";
import AIOutputReader from "./AIOutputReader";
import { Button } from "@/components/ui/button";
import { EVENT_CATEGORIES } from "./session-form/EventTimelineSection";
import { buildAIGroundingContext, buildOptionalFirstNameToneCue, PERSONALIZED_ANATOMY_OUTPUT_RULE } from "@/lib/aiGrounding";
import { listBackgroundJobs, startBackgroundJob, waitForBackgroundJob } from "@/lib/backgroundJobs";
import { buildAudioChapterBundle } from "@/lib/audioChapters";
import { serverUrl } from "@/lib/mobileApiBase";
import { SESSION_CONTEXT_GROUNDING_RULE, sessionContextEvidenceItems, sessionContextEvidenceText, structuredSessionContextForAI } from "@/lib/sessionContext";
import { buildSessionKeyVideoClipDigest, buildSessionVideoPassDigest, buildSessionVisualEvidenceDigest, normalizeSessionKeyVideoClips, normalizeSessionVideoPassFindings } from "@/lib/visualEvidence";
import { getMotionEvidenceDigest, getMotionEvidenceSummary } from "@/utils/sessionMotionEvidence";
import { buildSessionAIContentMeta, formatGeneratedAt, isSessionAIContentStale } from "@/utils/aiContentMetadata";
import { formatSecondsAsWords, repairAITextBlocks, repairCharacterSplitParagraph } from "@/utils/aiTextRepair";
import { buildSessionHrvEvidence, RR_HRV_INTERPRETATION_RULES } from "@/utils/hrvEvidence";
import { cleanTextForSpeech, getTTSRuntime, loadTTSSettings, prepareTTSInput, splitIntoChunks, TTS_CHUNK_TARGET_CHARS } from "./TTSButton";

export const REVIEW_VIDEO_RENDER_VERSION = "session_review_video_v11_hd";

function trailingContext(text, maxChars = 320) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  return cleaned.length > maxChars ? cleaned.slice(-maxChars) : cleaned;
}

function buildReviewVideoChunks(paragraphs = []) {
  const chunks = [];
  let previousText = "";
  paragraphs.forEach((paragraph) => {
    const cleaned = cleanTextForSpeech(paragraph);
    if (!cleaned) return;
    splitIntoChunks(cleaned, TTS_CHUNK_TARGET_CHARS).forEach((part) => {
      const text = prepareTTSInput(part);
      if (!text) return;
      chunks.push({
        text,
        previousContext: trailingContext(previousText),
      });
      previousText = previousText ? `${previousText} ${part}` : part;
    });
  });
  return chunks;
}

function reviewFilename(title = "Session Review Video") {
  return `${String(title || "Session Review Video")
    .replace(/^AI\s+/i, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "Session-Review-Video"}.mp4`;
}

function formatVideoClock(seconds = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function cleanReviewAnswerForDisplay(text = "") {
  return String(text || "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isProviderRefusalText(text = "") {
  const value = String(text || "").toLowerCase();
  return [
    "i'm not able to provide analysis of this content",
    "i am not able to provide analysis of this content",
    "explicit sexual material",
    "can't review, describe, or analyze",
    "cannot review, describe, or analyze",
    "i can’t assist with that request",
    "i can't assist with that request",
  ].some((needle) => value.includes(needle));
}

function shouldUseEvidenceOnlyQuestion(question = "") {
  return /\b(ejaculat|spurt|semen|cum|fluid|orgasm|climax|penis|shaft|glans|foley|catheter|meatus|stroke|stroking|grip|hand|masturbat|genital|visible|see|show|confirm)\b/i
    .test(String(question || ""));
}

function overlapSeconds(aStart, aEnd, bStart, bEnd) {
  const start = Math.max(Number(aStart), Number(bStart));
  const end = Math.min(Number(aEnd), Number(bEnd));
  return Math.max(0, end - start);
}

function cleanEvidenceText(value = "", maxLength = 360) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function reviewManifestSegmentsForPlayback(manifest, windowStart, windowEnd) {
  const clips = Array.isArray(manifest?.generated_clips) ? manifest.generated_clips : [];
  const chapters = Array.isArray(manifest?.chapters) ? manifest.chapters : [];
  let cursor = 0;
  return clips.map((clip, index) => {
    const chapterStart = Number(chapters[index]?.startMs);
    const playerStart = Number.isFinite(chapterStart) ? chapterStart / 1000 : cursor;
    const duration = Math.max(0.2, Number(clip.audio_duration_seconds || 0) || 0);
    const nextChapterStart = Number(chapters[index + 1]?.startMs);
    const playerEnd = Number.isFinite(nextChapterStart) ? nextChapterStart / 1000 : playerStart + duration;
    cursor = playerEnd;
    return {
      ...clip,
      player_start_s: playerStart,
      player_end_s: playerEnd,
      overlap_s: overlapSeconds(playerStart, playerEnd, windowStart, windowEnd),
    };
  }).filter((clip) => clip.overlap_s > 0.05);
}

function buildSessionRangesFromManifestSegments(segments = [], fallbackStart, fallbackEnd) {
  const ranges = segments
    .map((segment) => {
      const center = Number(segment.session_time_s);
      if (!Number.isFinite(center)) return null;
      const radius = Math.max(8, Number(segment.audio_duration_seconds || 0) / Math.max(0.5, Number(segment.playback_rate || 1)) + 4);
      return {
        start: Math.max(0, center - radius),
        end: center + radius,
        center,
        label: segment.label || "Review-video segment",
      };
    })
    .filter(Boolean);
  if (ranges.length) return ranges;
  return [{
    start: Math.max(0, Number(fallbackStart || 0) - 8),
    end: Math.max(0, Number(fallbackEnd || 0) + 8),
    center: Math.max(0, (Number(fallbackStart || 0) + Number(fallbackEnd || 0)) / 2),
    label: "Playback window fallback",
  }];
}

function timeInRanges(time, ranges = [], pad = 0) {
  const value = Number(time);
  return Number.isFinite(value) && ranges.some((range) => value >= range.start - pad && value <= range.end + pad);
}

function rangeOverlapsRanges(start, end, ranges = [], pad = 0) {
  const a = Number(start);
  const b = Number(end);
  if (!Number.isFinite(a) && !Number.isFinite(b)) return false;
  const safeStart = Number.isFinite(a) ? a : b;
  const safeEnd = Number.isFinite(b) ? b : a;
  return ranges.some((range) => overlapSeconds(safeStart, safeEnd, range.start - pad, range.end + pad) > 0);
}

function buildReviewWindowEvidencePacket({ session, manifest, windowStart, windowEnd, question }) {
  const manifestSegments = reviewManifestSegmentsForPlayback(manifest, windowStart, windowEnd);
  const sessionRanges = buildSessionRangesFromManifestSegments(manifestSegments, windowStart, windowEnd);
  const eventTimeline = Array.isArray(session?.event_timeline) ? session.event_timeline : [];
  const events = eventTimeline
    .filter((event) => timeInRanges(event?.time_s ?? event?.offset_s ?? event?.timestamp_s, sessionRanges, 10))
    .sort((a, b) => Number(a.time_s ?? a.offset_s ?? a.timestamp_s) - Number(b.time_s ?? b.offset_s ?? b.timestamp_s))
    .slice(0, 12)
    .map((event) => ({
      time_s: Number(event.time_s ?? event.offset_s ?? event.timestamp_s),
      text: cleanEvidenceText(event.note || event.label || event.description || event.text || event.event || "Saved timeline event", 520),
      category: Array.isArray(event.category) ? event.category.join(", ") : event.category || "",
      source: event.source || "event_timeline",
    }));
  const videoPasses = normalizeSessionVideoPassFindings(session)
    .filter((entry) => (
      rangeOverlapsRanges(entry.clip.start_s, entry.clip.end_s, sessionRanges, 12)
      || entry.draft_events.some((event) => timeInRanges(event.time_s, sessionRanges, 12))
    ))
    .slice(0, 8)
    .map((entry) => ({
      range: entry.clip.start_s != null && entry.clip.end_s != null ? `${formatVideoClock(entry.clip.start_s)}-${formatVideoClock(entry.clip.end_s)}` : "range unavailable",
      label: entry.label,
      summary: cleanEvidenceText(entry.summary, 520),
      findings: entry.findings.slice(0, 5).map((finding) => cleanEvidenceText(finding, 420)),
      draft_events: entry.draft_events.slice(0, 5).map((event) => `${formatVideoClock(event.time_s)}: ${cleanEvidenceText(event.note, 360)}`),
      source_video: entry.source_video.label || entry.source_video.filename || "",
    }));
  const keyClips = normalizeSessionKeyVideoClips(session)
    .filter((clip) => (
      timeInRanges(clip.session_time_s, sessionRanges, 18)
      || rangeOverlapsRanges(clip.startSeconds, clip.endSeconds, sessionRanges, 18)
    ))
    .slice(0, 8)
    .map((clip) => ({
      time: clip.session_time_s != null ? formatVideoClock(clip.session_time_s) : "time unavailable",
      source_range: clip.startSeconds != null && clip.endSeconds != null ? `${formatVideoClock(clip.startSeconds)}-${formatVideoClock(clip.endSeconds)}` : "",
      label: clip.label,
      reason: cleanEvidenceText(clip.reason, 520),
      camera: [clip.source_video_label, clip.camera_angle].filter(Boolean).join(", "),
    }));
  const visualFindings = (Array.isArray(session?.ai_analysis?._visual_findings) ? session.ai_analysis._visual_findings : [])
    .flatMap((entry) => Array.isArray(entry?.findings) ? entry.findings : [])
    .map((finding) => cleanEvidenceText(finding, 360))
    .filter(Boolean)
    .slice(0, 8);
  const explicitNeedles = String(question || "").toLowerCase().match(/\b(ejaculat\w*|spurt\w*|semen|fluid|climax|orgasm|stroke\w*|grip|catheter|foley|glans|shaft|hand\w*)\b/g) || [];
  const allText = JSON.stringify({ events, videoPasses, keyClips, visualFindings }).toLowerCase();
  const keywordHits = [...new Set(explicitNeedles)].filter((word) => allText.includes(word.replace(/\W+/g, "")) || allText.includes(word));

  return {
    player_window: `${formatVideoClock(windowStart)}-${formatVideoClock(windowEnd)}`,
    mapped_session_ranges: sessionRanges.map((range) => `${formatVideoClock(range.start)}-${formatVideoClock(range.end)} (${range.label})`),
    manifest_segments: manifestSegments.slice(0, 5).map((segment) => ({
      player_range: `${formatVideoClock(segment.player_start_s)}-${formatVideoClock(segment.player_end_s)}`,
      source_range: segment.source_start_s != null && segment.source_end_s != null ? `${formatVideoClock(segment.source_start_s)}-${formatVideoClock(segment.source_end_s)}` : "",
      session_time: segment.session_time_s != null ? formatVideoClock(segment.session_time_s) : "",
      label: segment.label || "",
      spoken_text: cleanEvidenceText(segment.spoken_text, 420),
      matched_event: Boolean(segment.matched_event),
      slow_motion: Boolean(segment.slow_motion),
    })),
    events,
    video_passes: videoPasses,
    key_clips: keyClips,
    visual_findings: visualFindings,
    keyword_hits: keywordHits,
    evidence_count: events.length + videoPasses.length + keyClips.length + visualFindings.length,
  };
}

function formatEvidencePacketForPrompt(packet) {
  return JSON.stringify(packet, null, 2).slice(0, 10000);
}

function deterministicEvidenceAnswer(packet, question = "") {
  const lines = [
    `I checked the saved evidence mapped to player ${packet.player_window}.`,
  ];
  if (packet.manifest_segments?.length) {
    lines.push(`That playback window maps to session/source context around ${packet.mapped_session_ranges.join("; ")}.`);
  }
  if (packet.events?.length) {
    lines.push("", "Nearest saved timeline notes:");
    packet.events.slice(0, 5).forEach((event) => lines.push(`• ${formatVideoClock(event.time_s)}: ${event.text}`));
  }
  if (packet.video_passes?.length) {
    lines.push("", "Accepted video-pass evidence near that moment:");
    packet.video_passes.slice(0, 3).forEach((entry) => {
      lines.push(`• ${entry.range}: ${entry.summary || entry.label}`);
      entry.findings?.slice(0, 2).forEach((finding) => lines.push(`  - ${finding}`));
      entry.draft_events?.slice(0, 2).forEach((event) => lines.push(`  - ${event}`));
    });
  }
  if (packet.key_clips?.length) {
    lines.push("", "Saved key clips near that moment:");
    packet.key_clips.slice(0, 3).forEach((clip) => lines.push(`• ${clip.time}: ${clip.label}${clip.reason ? ` — ${clip.reason}` : ""}`));
  }
  if (!packet.evidence_count) {
    lines.push("", "I do not have accepted local/timeline evidence close enough to answer that window confidently.");
  } else if (/\b(spurt|ejaculat|semen|fluid)\b/i.test(question) && !packet.keyword_hits.some((hit) => /spurt|ejaculat|semen|fluid/i.test(hit))) {
    lines.push("", "I do not have accepted evidence in this window that specifically confirms a visible ejaculatory spurt. The app needs a saved local annotation or timestamp note for that exact visual claim.");
  }
  return lines.join("\n");
}

function reviewSecondsFromText(text = "") {
  const source = String(text || "");
  const times = [];
  source.replace(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g, (match, hours, minutes, seconds) => {
    times.push((Number(hours || 0) * 3600) + (Number(minutes) * 60) + Number(seconds));
    return match;
  });
  source.replace(/\b(\d{1,3}):(\d{2})\b/g, (match, minutes, seconds) => {
    times.push((Number(minutes) * 60) + Number(seconds));
    return match;
  });
  source.replace(/\b(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\s*(?:and\s*)?(?:(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds))?\b/gi, (match, minutes, seconds) => {
    times.push((Number(minutes) * 60) + Number(seconds || 0));
    return match;
  });
  return [...new Set(times.filter((time) => Number.isFinite(time) && time >= 0))];
}

function reviewTextWords(text = "") {
  const stop = new Set([
    "about", "after", "again", "also", "around", "being", "during", "from", "into", "that", "this", "there", "these",
    "those", "through", "while", "with", "within", "your", "session", "moment", "window", "evidence", "marker",
    "saved", "video", "clip", "analysis", "section", "body", "physiology", "appeared", "suggests", "suggested",
  ]);
  return new Set(String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^-+|-+$/g, ""))
    .filter((word) => word.length >= 4 && !stop.has(word)));
}

function hasAnyReviewTerm(text = "", terms = []) {
  const value = String(text || "").toLowerCase();
  return terms.some((term) => term.test(value));
}

function reviewConceptScore(clipText, paragraphText) {
  const concepts = [
    { score: 90, terms: [/\bejaculat/, /\bclimax/, /\borgasm/, /\bsemen/, /\bfluid release/, /\brelease\b/] },
    { score: 60, terms: [/\bpre[-\s]?climax/, /\bbuild/, /\bapproach/] },
    { score: 55, terms: [/\brecovery/, /\bsettled/, /\bsettling/, /\brecovered/] },
    { score: 45, terms: [/\bpeak hr\b/, /\bheart[-\s]?rate/, /\bbpm\b/] },
    { score: 35, terms: [/\bleft hand/, /\bright hand/, /\bsupported/, /\bsupporting/, /\bheld\b/, /\bgrip\b/] },
    { score: 30, terms: [/\bpelvic/, /\bperineal/, /\bcontraction/, /\bemg\b/] },
  ];
  return concepts.reduce((sum, concept) => (
    hasAnyReviewTerm(clipText, concept.terms) && hasAnyReviewTerm(paragraphText, concept.terms)
      ? sum + concept.score
      : sum
  ), 0);
}

function bestParagraphIndexForClipByText(clip, paragraphs = []) {
  const clipText = [
    clip?.label,
    clip?.reason,
    clip?.motion_summary,
    clip?.camera_angle,
    clip?.source_video_label,
  ].filter(Boolean).join(" ");
  const clipWords = reviewTextWords(clipText);
  const clipTime = Number(clip?.session_time_s);
  let best = { index: -1, score: 0 };

  paragraphs.forEach((paragraph, index) => {
    const paragraphText = String(paragraph || "");
    const paragraphWords = reviewTextWords(paragraphText);
    const overlap = [...clipWords].filter((word) => paragraphWords.has(word)).length;
    const paragraphTimes = reviewSecondsFromText(paragraphText);
    const directTimeScore = Number.isFinite(clipTime) && paragraphTimes.some((time) => Math.abs(time - clipTime) <= 18) ? 120 : 0;
    const conceptScore = reviewConceptScore(clipText, paragraphText);
    const score = directTimeScore + conceptScore + (overlap * 10);
    if (score > best.score) best = { index, score };
  });

  return best.score >= 35 ? best.index : -1;
}

export function buildSessionAnalysisReaderData({ result, session, timelineRows = [], isTechnical = false }) {
  if (!result) {
    return {
      paragraphs: [],
      paragraphMeta: [],
      keyVideoClips: [],
      keyVideoClipError: "",
      sections: [],
      clipsByParagraph: new Map(),
    };
  }

  const arousalItems = toAnalysisTextArray(result.arousal_arc?.length ? result.arousal_arc : result.phase_analysis);
  const eventItems = toAnalysisTextArray(result.event_analysis?.length ? result.event_analysis : result.hr_analysis);
  const emgItems = toAnalysisTextArray(result.emg_analysis);
  const notableItems = toAnalysisTextArray(result.notable_findings);
  const recommendationItems = toAnalysisTextArray(result.recommendations);

  const paragraphs = [
    result.summary,
    ...arousalItems,
    ...eventItems,
    ...emgItems,
    ...notableItems,
    ...recommendationItems,
  ]
    .filter(Boolean)
    .map(repairCharacterSplitParagraph);

  let idx = 0;
  const sections = [];
  if (result.summary) sections.push({ label: null, color: "primary", items: [result.summary], start: idx++ });
  if (arousalItems.length) { sections.push({ label: isTechnical ? "Arousal Arc" : "Chronological Deep Dive", color: "chart-2", icon: <TrendingUp className="w-3.5 h-3.5" />, items: arousalItems, start: idx }); idx += arousalItems.length; }
  if (eventItems.length) { sections.push({ label: isTechnical ? "Event Analysis" : "Motion & Evidence Interpretation", color: "chart-1", icon: <Activity className="w-3.5 h-3.5" />, items: eventItems, start: idx }); idx += eventItems.length; }
  if (emgItems.length) { sections.push({ label: "EMG Analysis", color: "chart-3", icon: <Activity className="w-3.5 h-3.5" />, items: emgItems, start: idx }); idx += emgItems.length; }
  if (notableItems.length) { sections.push({ label: isTechnical ? "Notable Findings" : "Patterns & Hypotheses", color: "chart-4", icon: <Zap className="w-3.5 h-3.5" />, items: notableItems, start: idx }); idx += notableItems.length; }
  if (recommendationItems.length) { sections.push({ label: isTechnical ? "Recommendations" : "Recommendations & Experiments", color: "accent", icon: <Lightbulb className="w-3.5 h-3.5" />, items: recommendationItems, start: idx }); }

  const keyVideoClips = Array.isArray(result?._meta?.key_video_clips) ? result._meta.key_video_clips : [];
  const keyVideoClipError = result?._meta?.key_video_clip_error || "";
  const clipsByParagraph = keyVideoClips.reduce((map, clip) => {
    const paraIndex = paragraphIndexForClip(clip, sections, paragraphs.length, sessionDurationSeconds(session, timelineRows), paragraphs);
    if (!map.has(paraIndex)) map.set(paraIndex, []);
    map.get(paraIndex).push(clip);
    return map;
  }, new Map());

  const paragraphMeta = paragraphs.map((_, paraIdx) => {
    let section = sections[0];
    for (const sec of sections) {
      if (paraIdx >= sec.start) section = sec;
    }
    const clips = clipsByParagraph.get(paraIdx) || [];
    return section?.label === null
      ? { type: "summary", color: "hsl(var(--primary))", clips }
      : {
        type: "section",
        clips,
        sec: {
          key: section?.label,
          label: section?.label,
          color: SECTION_COLORS[section?.color] || "hsl(var(--primary))",
          icon: section?.icon,
        },
      };
  });

  return { paragraphs, paragraphMeta, keyVideoClips, keyVideoClipError, sections, clipsByParagraph };
}

function sanitizeReviewClip(clip = {}) {
  return {
    id: clip.id || null,
    label: clip.label || "",
    reason: clip.reason || "",
    session_time_s: clip.session_time_s ?? clip.sessionTimeSeconds ?? clip.timeline_offset_s ?? null,
    camera_angle: clip.camera_angle || null,
    source_video_label: clip.source_video_label || null,
    source_video_fingerprint: clip.source_video_fingerprint || null,
    timeline_offset_s: clip.timeline_offset_s ?? null,
    url: clip.url || clip.clip_url || clip.file_url || "",
    clip_url: clip.clip_url || clip.url || clip.file_url || "",
    file_url: clip.file_url || clip.url || clip.clip_url || "",
    filename: clip.filename || "",
    startSeconds: clip.startSeconds ?? null,
    endSeconds: clip.endSeconds ?? null,
    durationSeconds: clip.durationSeconds ?? null,
  };
}

export function SessionReviewVideoExportButton({
  session,
  analysisTitle,
  sourceGeneratedAt,
  paragraphs = [],
  paragraphMeta = [],
  recordType = "session",
}) {
  const [status, setStatus] = useState({ type: "idle", message: "" });
  const [rendered, setRendered] = useState(null);
  const [existingVideo, setExistingVideo] = useState(null);
  const [previewTime, setPreviewTime] = useState(0);
  const [reviewQuestion, setReviewQuestion] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const [reviewStatus, setReviewStatus] = useState({ type: "idle", message: "" });
  const chatStorageLoadedRef = useRef("");
  const activeVideo = rendered?.file_url ? rendered : existingVideo;
  const activeVideoUrl = activeVideo?.file_url ? serverUrl(activeVideo.file_url) : "";
  const chatStorageKey = session?.id
    ? [
      "pulsepoint",
      "reviewVideoChat",
      session.id,
      sourceGeneratedAt || "latest",
      activeVideo?.file_url || "pending",
    ].join(":")
    : "";

  useEffect(() => {
    let cancelled = false;
    const loadExisting = async () => {
      if (!session?.id) return;
      try {
        const [records, jobsResult] = await Promise.all([
          base44.entities.SessionReviewVideo.filter({ session_id: session.id }, "-created_date", 20),
          listBackgroundJobs({
            type: "session_review_video",
            status: "complete",
            metaSessionId: session.id,
            includeCleared: true,
            limit: 20,
          }),
        ]);
        if (cancelled) return;
        const matchingRecord = (records || []).find((record) => (
          record?.file_url &&
          record?.render_version === REVIEW_VIDEO_RENDER_VERSION &&
          (!sourceGeneratedAt || !record.source_generated_at || record.source_generated_at === sourceGeneratedAt)
        ));
        const matchingJob = (jobsResult?.jobs || []).find((job) => (
          job?.result?.file_url &&
          job?.result?.render_version === REVIEW_VIDEO_RENDER_VERSION &&
          (!sourceGeneratedAt || !job?.meta?.sourceGeneratedAt || job.meta.sourceGeneratedAt === sourceGeneratedAt)
        ));
        const recovered = matchingRecord || (matchingJob ? {
          id: `job:${matchingJob.id}`,
          file_url: matchingJob.result.file_url,
          filename: matchingJob.result.filename || String(matchingJob.result.file_url).split("/").pop(),
          duration_seconds: matchingJob.result.duration_seconds,
          audio_reused: matchingJob.result.audio_reused,
          source_generated_at: matchingJob.meta?.sourceGeneratedAt || null,
          _source: "completed_review_video_job",
        } : null);
        setExistingVideo(recovered);
      } catch (error) {
        if (!cancelled) console.warn("Could not load existing review video:", error);
      }
    };
    loadExisting();
    return () => {
      cancelled = true;
    };
  }, [session?.id, sourceGeneratedAt]);

  useEffect(() => {
    if (!chatStorageKey) return;
    chatStorageLoadedRef.current = "";
    try {
      const stored = window.localStorage?.getItem(chatStorageKey);
      const parsed = stored ? JSON.parse(stored) : [];
      setChatMessages(Array.isArray(parsed) ? parsed : []);
    } catch {
      setChatMessages([]);
    }
    const timer = window.setTimeout(() => {
      chatStorageLoadedRef.current = chatStorageKey;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [chatStorageKey]);

  useEffect(() => {
    if (!chatStorageKey || chatStorageLoadedRef.current !== chatStorageKey) return;
    try {
      window.localStorage?.setItem(chatStorageKey, JSON.stringify(chatMessages.slice(-40)));
    } catch {
      // Local persistence is best-effort only.
    }
  }, [chatMessages, chatStorageKey]);

  const startRender = async () => {
    const readableParagraphs = paragraphs.map((paragraph) => String(paragraph || "").trim()).filter(Boolean);
    if (!readableParagraphs.length) {
      setStatus({ type: "error", message: "No analysis text is available for a review video." });
      return;
    }
    setRendered(null);
    try {
      const runtime = getTTSRuntime(loadTTSSettings());
      const chunks = buildReviewVideoChunks(readableParagraphs);
      const chapters = buildAudioChapterBundle({
        title: analysisTitle || "Session Review Video",
        audioFilename: reviewFilename(analysisTitle),
        paragraphs: readableParagraphs,
        source: "session_review_video",
      }).chapters;
      const reviewParagraphMeta = paragraphMeta.map((meta = {}) => ({
        type: meta.type || "section",
        sec: meta.sec ? { label: meta.sec.label || "", color: meta.sec.color || "" } : null,
        clips: Array.isArray(meta.clips) ? meta.clips.map(sanitizeReviewClip) : [],
      }));
      const payload = {
        sessionId: session?.id || null,
        sessionDate: session?.date || null,
        title: analysisTitle || "Session Review Video",
        sourceGeneratedAt: sourceGeneratedAt || null,
        recordType,
        session: {
          id: session?.id || null,
          date: session?.date || null,
          record_type: recordType,
          title: session?.title || null,
          exploration_type: session?.exploration_type || null,
          methods: session?.methods || [],
          devices: session?.devices || null,
          foley_size: session?.foley_size || null,
          foley_type: session?.foley_type || null,
          notes: session?.notes || null,
          linked_local_videos: Array.isArray(session?.linked_local_videos) ? session.linked_local_videos : [],
          event_timeline: Array.isArray(session?.event_timeline) ? session.event_timeline : [],
          pre_climax_offset_s: session?.pre_climax_offset_s ?? null,
          climax_offset_s: session?.climax_offset_s ?? null,
          recovery_offset_s: session?.recovery_offset_s ?? null,
        },
        paragraphs: readableParagraphs,
        paragraphMeta: reviewParagraphMeta,
        chunks,
        chapters,
        voice: "nova",
        model: runtime.model,
        speed: runtime.speed,
        instructions: runtime.instructions,
        outputFormat: runtime.format,
        normalize: runtime.settings.normalizeExport,
      };

      setStatus({ type: "working", message: "Starting review video render..." });
      const job = await startBackgroundJob("session_review_video", payload, {
        title: `${analysisTitle || "Session Analysis"} review video`,
        source: "SessionAIPanel",
        sessionId: session?.id || null,
        recordType,
        sourceGeneratedAt: sourceGeneratedAt || null,
      });
      const completed = await waitForBackgroundJob(job.id, {
        intervalMs: 1500,
        onProgress: (nextJob) => {
          const progress = nextJob.progress || {};
          setStatus({
            type: nextJob.status === "error" ? "error" : "working",
            message: progress.message || "Rendering review video...",
          });
        },
      });
      if (!completed.result?.file_url) throw new Error("Review render did not return an MP4.");
      setRendered(completed.result);
      setExistingVideo(completed.result);
      setStatus({
        type: "ok",
        message: completed.result.audio_reused
          ? "Review video ready. Reused matching narration."
          : "Review video ready. Narration was rendered for this export.",
      });
    } catch {
      setStatus({ type: "error", message: error?.message || "Review video render failed." });
    }
  };

  const download = () => {
    const target = activeVideo;
    if (!target?.file_url) return;
    const a = document.createElement("a");
    a.href = serverUrl(target.file_url);
    a.download = target.filename || reviewFilename(analysisTitle);
    a.click();
  };

  const loadActiveManifest = async () => {
    if (!activeVideo?.manifest_url) return null;
    try {
      const res = await fetch(serverUrl(activeVideo.manifest_url));
      if (!res.ok) throw new Error(`Manifest request failed: ${res.status}`);
      return await res.json();
    } catch (error) {
      console.warn("Could not load review video manifest:", error);
      return null;
    }
  };

  const askSarahFromEvidencePacket = async ({ question, windowStart, windowEnd, reason = "evidence_only" }) => {
    setReviewStatus({
      type: "working",
      message: reason === "provider_refusal"
        ? "Building a saved-evidence answer after provider refusal..."
        : "Reviewing saved local/timeline evidence for this window...",
    });
    const manifest = await loadActiveManifest();
    const packet = buildReviewWindowEvidencePacket({ session, manifest, windowStart, windowEnd, question });
    const deterministic = deterministicEvidenceAnswer(packet, question);
    if (!packet.evidence_count) {
      setChatMessages((messages) => [
        ...messages,
        {
          id: `assistant-local-${Date.now()}`,
          role: "assistant",
          text: deterministic,
          windowStart,
          windowEnd,
          error: true,
        },
      ]);
      setReviewStatus({ type: "error", message: "No accepted local/timeline evidence was close enough to answer this window." });
      return;
    }
    try {
      const conversationContext = chatMessages.slice(-8).map((message) => (
        `${message.role === "assistant" ? "Sarah" : "Ben"} (${formatVideoClock(message.windowStart)}-${formatVideoClock(message.windowEnd)}): ${message.text}`
      )).join("\n");
      const response = await base44.integrations.Core.InvokeLLM({
        model: "claude_sonnet_4_6",
        max_tokens: 1400,
        label: "Review video local-evidence Q&A",
        source: "session_review_video_window_local_evidence_qa",
        prompt: `You are Sarah answering a PulsePoint review-video follow-up using saved evidence only.

Do not claim you are directly inspecting frames in this request. No images are attached. Use only the saved local/timeline evidence packet below.

Question:
${question}

Recent conversation:
${conversationContext || "- This is the first evidence-only answer in this review thread."}

Saved evidence packet:
${formatEvidencePacketForPrompt(packet)}

Answer directly and practically. If the evidence specifically supports the user's visual question, say so and cite the timestamp/source in natural language. If it does not support the specific visual claim, say that clearly and explain what the saved evidence does support. Keep the tone conversational, clinical, and not erotic. Do not include policy language. Do not invent visual confirmation beyond the packet. Do not lean on "consistent with", "consistent", or "consistently"; use direct observation or varied wording such as "matches", "supports", "fits with", "points toward", or "tracks with".`,
      });
      const text = typeof response === "string" ? response : response?.response || "";
      if (isProviderRefusalText(text)) throw new Error("Provider refused text-only evidence synthesis.");
      setChatMessages((messages) => [
        ...messages,
        {
          id: `assistant-local-${Date.now()}`,
          role: "assistant",
          text: cleanReviewAnswerForDisplay(text) || deterministic,
          windowStart,
          windowEnd,
        },
      ]);
      setReviewStatus({ type: "ok", message: "Sarah answered from saved local/timeline evidence." });
    } catch {
      setChatMessages((messages) => [
        ...messages,
        {
          id: `assistant-local-fallback-${Date.now()}`,
          role: "assistant",
          text: deterministic,
          windowStart,
          windowEnd,
          error: true,
        },
      ]);
      setReviewStatus({ type: "error", message: "Cloud synthesis did not complete; showing saved-evidence packet instead." });
    }
  };

  const askSarahAboutCurrentWindow = async () => {
    const fileUrl = activeVideo?.file_url || "";
    if (!fileUrl) return;
    const windowStart = Math.max(0, Number(previewTime || 0) - 2);
    const windowEnd = windowStart + 12;
    const question = reviewQuestion.trim() || "What do you notice about the visible body mechanics and stimulation pattern in this window?";
    const userMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      text: question,
      windowStart,
      windowEnd,
    };
    setChatMessages((messages) => [...messages, userMessage]);
    setReviewQuestion("");
    if (shouldUseEvidenceOnlyQuestion(question)) {
      await askSarahFromEvidencePacket({ question, windowStart, windowEnd, reason: "explicit_visual_question" });
      return;
    }
    setReviewStatus({ type: "working", message: "Sampling the processed review video window..." });
    try {
      const clip = await base44.integrations.Core.ProcessUploadedVideoClip({
        file_url: fileUrl,
        startSeconds: windowStart,
        endSeconds: windowEnd,
        label: `${analysisTitle || "Review video"} current window`,
        frameCount: 12,
        maxDurationSeconds: 18,
      });
      const frames = Array.isArray(clip.frames) ? clip.frames.slice(0, 12) : [];
      if (!frames.length) throw new Error("No frames were sampled from this video window.");
      setReviewStatus({ type: "working", message: "Sarah is reviewing the sampled frames..." });
      const conversationContext = chatMessages.slice(-8).map((message) => (
        `${message.role === "assistant" ? "Sarah" : "Ben"} (${formatVideoClock(message.windowStart)}-${formatVideoClock(message.windowEnd)}): ${message.text}`
      )).join("\n");
      const response = await base44.integrations.Core.InvokeLLM({
        model: "claude_sonnet_4_6",
        max_tokens: 1600,
        label: "Review video window Q&A",
        source: "session_review_video_window_qa",
        images: frames.map((frame) => ({
          filename: frame.filename || `review-video-frame-${frame.frameIndex || 1}.jpg`,
          media_type: frame.mimeType || "image/jpeg",
          data: frame.data,
        })).filter((frame) => frame.data),
        prompt: `You are Sarah reviewing sampled frames from a processed PulsePoint review video.

The user is asking about the visible moment currently being played in the exported review video.

Question:
${question}

Recent conversation for follow-up continuity:
${conversationContext || "- This is the first question in this review thread."}

Video context:
- Review video title: ${analysisTitle || "Review video"}
- Processed video playback window: ${formatVideoClock(windowStart)} to ${formatVideoClock(windowEnd)}
- Source record type: ${recordType}
- Sampled frame count: ${frames.length}
- Manifest URL if available: ${activeVideo?.manifest_url || "not available"}

Content handling:
- Treat this as consensual private physiology/session review for PulsePoint, not erotic writing.
- Keep any answer clinical, observational, and evidence-based.
- Do not sexualize, embellish, or produce arousal-oriented prose.
- If provider policy prevents visual review of these frames, say only: "Provider refused direct visual review for this window." Do not produce a long refusal paragraph.

Anatomical laterality rule: "your left" and "your right" must mean Ben's anatomical left/right, not viewer screen-left/screen-right. If the view is facing Ben, his anatomical right appears on viewer-left. If the camera perspective, supine positioning, mirroring, rotation, crop, or composite layout makes laterality uncertain, say screen-left/screen-right, near/far, upper/lower, one hand/the other hand, or one leg/the other leg instead of anatomical left/right. Preserve anatomical identity across poses and camera angles: a bruise, mole, scar, catheter/tubing position, pelvic finding, genital finding, or skin mark on Ben's anatomical right remains right-sided when he moves from supine to standing, turns toward the camera, rotates, or appears in another crop/camera lane.

Answer directly and practically in conversational prose, not markdown. Describe only what is visible in the sampled frames, plus cautious interpretation of body mechanics, stroke/contact pattern, positioning, device interaction, or timing if supported. If the frames are unclear, say exactly what cannot be confirmed in one short sentence, then focus on what is visible. If a useful follow-up would clarify the review, ask one concise follow-up question at the end. Do not invent sensations or intent. Do not lean on "consistent with", "consistent", or "consistently"; use direct observation or varied wording such as "matches", "supports", "fits with", "points toward", or "tracks with".`,
      });
      const text = typeof response === "string" ? response : response?.response || "";
      if (isProviderRefusalText(text)) {
        await askSarahFromEvidencePacket({ question, windowStart, windowEnd, reason: "provider_refusal" });
        return;
      }
      setChatMessages((messages) => [
        ...messages,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: cleanReviewAnswerForDisplay(text) || "Sarah did not return a visible-window answer.",
          windowStart,
          windowEnd,
        },
      ]);
      setReviewStatus({ type: "ok", message: "Sarah reviewed this processed-video window." });
    } catch (error) {
      setChatMessages((messages) => [
        ...messages,
        {
          id: `assistant-error-${Date.now()}`,
          role: "assistant",
          text: error?.message || "Could not review this video window.",
          windowStart,
          windowEnd,
          error: true,
        },
      ]);
      setReviewStatus({ type: "error", message: error?.message || "Could not review this video window." });
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-primary/20 bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
            <MessageCircle className="h-3.5 w-3.5" /> Ask Sarah About The Review Video
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Ask about the current playback window. Sarah samples that moment and keeps the thread open for follow-up questions.
          </p>
        </div>
        {chatMessages.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setChatMessages([])}
            className="h-8 text-xs"
          >
            Clear chat
          </Button>
        )}
      </div>
      {activeVideoUrl && (
        <div className="relative overflow-hidden rounded-lg border border-border bg-black">
          <video
            key={activeVideoUrl}
            src={activeVideoUrl}
            controls
            preload="metadata"
            playsInline
            className="aspect-video w-full bg-black object-contain"
            onLoadedMetadata={(event) => setPreviewTime(event.currentTarget.currentTime || 0)}
            onTimeUpdate={(event) => setPreviewTime(event.currentTarget.currentTime || 0)}
            onSeeked={(event) => setPreviewTime(event.currentTarget.currentTime || 0)}
          />
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-black/75 px-2 py-1 font-mono text-xs font-semibold text-white shadow">
            player {formatVideoClock(previewTime)}
          </div>
        </div>
      )}
      {activeVideoUrl && (
        <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={reviewQuestion}
              onChange={(event) => setReviewQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && reviewStatus.type !== "working") {
                  event.preventDefault();
                  askSarahAboutCurrentWindow();
                }
              }}
              placeholder="Ask Sarah about the current video window..."
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={askSarahAboutCurrentWindow}
              disabled={reviewStatus.type === "working"}
              className="h-9 gap-1.5 text-xs"
            >
              {reviewStatus.type === "working" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5" />}
              Review Window
            </Button>
          </div>
          {chatMessages.length > 0 && (
            <div className="space-y-3">
              {chatMessages.map((message) => (
                <div
                  key={message.id}
                  className={`max-w-[92%] rounded-xl border px-3 py-2 ${
                    message.role === "user"
                      ? "ml-auto border-primary/25 bg-primary/10 text-foreground"
                      : message.error
                        ? "mr-auto border-amber-400/30 bg-amber-400/10 text-amber-100"
                        : "mr-auto border-border bg-background/80 text-foreground"
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <span>{message.role === "user" ? "You" : "Sarah"}</span>
                    <span className="font-mono normal-case tracking-normal">
                      {formatVideoClock(message.windowStart)}-{formatVideoClock(message.windowEnd)}
                    </span>
                  </div>
                  {message.role === "assistant" && !message.error ? (
                    <AIOutputReader
                      sessionId={`${session?.id || "session"}-review-video-chat-${message.id}`}
                      title="Sarah Review Window"
                      sessionDate={session?.date}
                      sourceGeneratedAt={message.id}
                      paragraphs={[message.text]}
                      paragraphMeta={[{ type: "summary", color: "hsl(var(--primary))" }]}
                    />
                  ) : (
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.text}</p>
                  )}
                </div>
              ))}
            </div>
          )}
          {reviewStatus.message && (
            <p className={`text-[11px] ${reviewStatus.type === "error" ? "text-amber-300" : reviewStatus.type === "ok" ? "text-emerald-400" : "text-muted-foreground"}`}>
              {reviewStatus.message}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={startRender}
          disabled={status.type === "working" || !paragraphs.length}
          className="h-8 gap-1.5 text-xs"
        >
          {status.type === "working" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Video className="h-3.5 w-3.5" />}
          Build review video
        </Button>
        {activeVideo?.file_url && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={download}
            className="h-8 gap-1.5 text-xs"
          >
            <Download className="h-3.5 w-3.5" />
            {rendered?.file_url ? "Download MP4" : "Download Existing"}
          </Button>
        )}
        {existingVideo?._source === "completed_review_video_job" && (
          <span className="text-xs text-amber-200">
            Recovered from completed background render
          </span>
        )}
        {status.message && (
          <span className={`text-xs ${status.type === "error" ? "text-destructive" : status.type === "ok" ? "text-emerald-400" : "text-muted-foreground"}`}>
            {status.message}
          </span>
        )}
      </div>
    </div>
  );
}

function buildSessionContext(session, timelineRows) {
  const hrMin = timelineRows.length ? Math.round(Math.min(...timelineRows.map(r => Number(r.hr)))) : null;
  const hrMax = timelineRows.length ? Math.round(Math.max(...timelineRows.map(r => Number(r.hr)))) : null;
  return [
    `Session date: ${session.date?.slice(0, 10)}`,
    `Duration: ${session.duration_minutes ?? "?"}min`,
    `Methods: ${(session.methods || []).join(", ")}`,
    session.foley_size ? `Foley: ${session.foley_size}Fr ${session.foley_type || ""}` : null,
    session.estim_notes ? `E-Stim notes: ${session.estim_notes}` : null,
    `Intensity: ${session.intensity}/10, Build quality: ${session.build_quality}/10, Satisfaction: ${session.satisfaction}/10`,
    [
      session.release_completeness ? `release completeness ${session.release_completeness}/10` : null,
      session.arousal_depth ? `arousal depth ${session.arousal_depth}/10` : null,
      session.erection_stability ? `response stability ${session.erection_stability}/10` : null,
      session.stimulation_fit ? `stimulation fit ${session.stimulation_fit}/10` : null,
      session.control ? `edge/control quality ${session.control}/10` : null,
      session.sensory_immersion ? `sensory immersion ${session.sensory_immersion}/10` : null,
      session.recovery_quality ? `recovery quality ${session.recovery_quality}/10` : null,
      session.discomfort_interference ? `discomfort/interruption impact ${session.discomfort_interference}/10` : null,
    ].filter(Boolean).length
      ? `Targeted subjective metrics: ${[
        session.release_completeness ? `release completeness ${session.release_completeness}/10` : null,
        session.arousal_depth ? `arousal depth ${session.arousal_depth}/10` : null,
        session.erection_stability ? `response stability ${session.erection_stability}/10` : null,
        session.stimulation_fit ? `stimulation fit ${session.stimulation_fit}/10` : null,
        session.control ? `edge/control quality ${session.control}/10` : null,
        session.sensory_immersion ? `sensory immersion ${session.sensory_immersion}/10` : null,
        session.recovery_quality ? `recovery quality ${session.recovery_quality}/10` : null,
        session.discomfort_interference ? `discomfort/interruption impact ${session.discomfort_interference}/10` : null,
      ].filter(Boolean).join(", ")}`
      : null,
    session.primary_limiting_factor ? `Primary limiting factor: ${session.primary_limiting_factor}` : null,
    session.subjective_notes ? `Subjective metric notes: ${session.subjective_notes}` : null,
    `Build type: ${session.build_type}${session.custom_build_type ? " — " + session.custom_build_type : ""}`,
    `Climax duration: ${session.climax_duration ?? "?"}`,
    `Mood: ${session.mood}, Hydration: ${session.hydration}`,
    sessionContextEvidenceText(session) ? `Logged session context/influences: ${sessionContextEvidenceText(session)}` : null,
    hrMin != null ? `HR: min ${hrMin}, avg ${session.avg_hr ?? "?"}, max ${hrMax}, at climax ${session.hr_at_climax ?? "?"}` : null,
    session.pre_climax_offset_s != null ? `Phase markers: pre-climax at ${formatSecondsAsWords(session.pre_climax_offset_s)}, climax at ${formatSecondsAsWords(session.climax_offset_s)}, recovery ${session.recovery_offset_s != null ? `at ${formatSecondsAsWords(session.recovery_offset_s)}` : "unknown"}` : null,
    session.ejaculate_volume ? `Ejaculate: ${session.ejaculate_volume}` : null,
    session.unusual_sensations ? `Unusual sensations: ${session.unusual_sensations}` : null,
    (session.discomfort_entries || []).length ? `Discomfort: ${session.discomfort_entries.map(e => `sev ${e.severity}/10 — ${e.note}`).join("; ")}` : null,
    (session.event_timeline || []).length ? `Events: ${session.event_timeline.map(e => `[${Math.floor(Number(e.time_s || 0) / 60)}:${String(Math.round(Number(e.time_s || 0) % 60)).padStart(2, "0")}] ${e.note}`).join(" | ")}` : null,
    session.notes ? `Session notes: ${session.notes}` : null,
    buildSessionVisualEvidenceDigest(session),
    buildSessionVideoPassDigest(session),
    buildSessionKeyVideoClipDigest(session),
    session.ai_analysis?.summary ? `AI analysis summary: ${session.ai_analysis.summary}` : null,
  ].filter(Boolean).join("\n");
}

function buildWarmMotionEvidence(session) {
  const evidence = getMotionEvidenceSummary(session);
  if (!evidence.hasAnyMotionEvidence) return "";
  return `

REVIEWED MEDIA-DERIVED MOTION EVIDENCE (observational evidence only):
${getMotionEvidenceDigest(session)}

MOTION INTERPRETATION RULES:
- This summary contains compact locally derived movement signals, not raw video or raw landmarks.
- Use it only for visible movement timing, side-to-side comparison, or cautious correlation with heart rate and logged events.
- Do not infer intent, mechanism, muscle force, neurological meaning, or arousal state from movement alone.
- Any hand cadence estimate is an observational hand-movement cadence proxy, not confirmed stroke speed.

EVIDENCE PRECEDENCE HIERARCHY FOR MOVEMENT:
- Saved motion telemetry has precedence for visible lower-body movement timing, left/right comparison, asymmetry, cadence proxy, and motion peaks.
- User-verified motion-derived events have been visually reviewed and may be treated as stronger observational evidence than unverified motion-derived events. Verification does not establish intent, force, neurological mechanism, or physiological cause.
- For stimulation pause/resume timing and pause duration, explicit manually entered timeline events tagged stimulation_paused or stimulation_resumed take priority over motion-derived hand pause/resume candidates. Hand tracking can miss or misclassify activity, so use motion-derived pauses only as secondary corroboration when manual pause/resume events exist.
- If there are no explicit manually entered stimulation pause/resume events, describe motion-derived pauses only as observed hand-activity gap candidates, not confirmed stimulation pauses.
- Manual notes remain valuable when they add context motion cannot infer, such as repositioning, method changes, breathing changes, subjective sensation, or interruption.
- If a vague manual movement description conflicts with saved motion telemetry, prefer telemetry for the visible movement description while preserving the note as subjective or contextual history.
- Treat motion-derived evidence as observational only. Do not infer intent, arousal phase, muscle force, neurological meaning, or physiological mechanism from motion alone.`;
}

const AI_SESSION_TYPE_GROUNDING_V1 = `
SESSION TYPE / INTENT GROUNDING - HIGH PRIORITY:
- Before interpreting this session, infer the session intent from build_type, methods, notes, event timeline, phase markers, climax fields, HR data, journal, and saved motion evidence.
- Distinguish masturbation/stimulation sessions from body exploration, sensation mapping, positioning review, recovery review, device fit/comfort review, or other non-climax observational sessions.
- Absence of climax is not missing data, failure, or an incomplete session when the session appears exploratory or observational. Do not imply that heart-rate data, event notes, motion evidence, or metrics are absent if they are present in the prompt.
- If climax, ejaculation, pre-climax, or recovery markers are absent, say that those specific phase markers are not logged; do not generalize that session evidence is missing.
- For body exploration sessions, analyze the available evidence on its own terms: what the body was doing, which sensations or positions were being mapped, how HR changed, what events were logged, what motion evidence showed, and what was learned.
- For masturbation/stimulation sessions, interpret stimulation efficiency, arousal build, plateau, climax approach, climax/release when present, and recovery when supported.
- For mixed sessions, explicitly separate exploratory/body-mapping goals from stimulation/arousal goals.
`;

const BODY_STATE_INTERPRETIVE_STYLE_V1 = `
BODY-STATE INTERPRETIVE STYLE - RESTORE PULSEPOINT FEEL:
- Do not let the analysis become only "this happened, then this happened." Use the timeline as evidence for what the body was doing in each phase.
- When HR, event notes, subjective sensations, movement evidence, or stimulation changes line up, translate them into body-state language: autonomic loading, sensory focus, pelvic/urethral/prostatic awareness when supported, muscular tension or settling when supported, preparation, plateauing, thresholding, recovery, or exploratory mapping.
- Prefer phrasing like "at this point your body appears to be..." or "this looks like..." when evidence supports a visible/physiological state.
- Keep mechanism calibrated. Do not overclaim. But when the data supports it, explain the likely physiological meaning instead of merely retelling the timestamp.
- In body exploration sessions, "what your body is doing" may mean mapping sensation, testing comfort, observing HR response, position tolerance, device fit, movement patterns, or nervous-system settling rather than arousal escalation.
`;

const HUMANIZED_PHYSIOLOGY_NARRATION_V1 = `
HUMANIZED PHYSIOLOGY NARRATION - HIGH PRIORITY:
- Do not shorten the analysis. Do not reduce technical depth. Do not remove physiological discussion. Improve how the physiology is explained.
- Metrics are evidence; the body-state story is the product. Heart rate, HRV, RR intervals, EMG, and telemetry should support the explanation rather than become the explanation.
- Before naming a number or metric, answer: "what does this suggest the body was doing?" Then use the number only as support when useful.
- Describe the person, not the graph. Prefer "your body repeatedly approached higher-intensity states, backed away slightly, and rebuilt again" over "heart rate oscillated between two values."
- Whenever HRV, RR intervals, EMG, or heart rate are discussed, explain why the user should care: commitment to stimulation, release of tension, efficient recovery, sustained effort, artifact caution, mismatch between body cues, or a useful future comparison.
- Connect physiology to possible lived experience cautiously when appropriate. Examples: "While the data cannot confirm subjective experience, this pattern often corresponds to increasing focus, effort, or immersion" or "this recovery pattern is often associated with a feeling of release or reduced effort."
- Use technical terms when they add precision, but do not let them dominate. Rotate language naturally: focused, loaded, engaged, activated, settled, relaxed, flexible, sustained, rebuilding, recovering, releasing tension, backing away from intensity, reloading, maintaining effort.
- Reduce repetition of these phrases: "beat-to-beat variability", "autonomic system", "compressed", "sympathetic drive", "parasympathetic activation", "physiological state", "consistent with". They are allowed, but no single one should become the default wording.
- Prefer "may fit with", "may point toward", "supports the idea that", "aligns with", "could reflect", "looks like", and "suggests" over repeating "consistent with."
- HRV example target: instead of "The HRV signal remained tightly compressed," write "Your physiology appeared highly focused during this phase. Rather than alternating between activation and recovery, your body stayed locked into a sustained build state."
- Recovery example target: instead of "beat-to-beat variability opened dramatically," write "Within seconds, your body appeared to let go of the effort it had been maintaining. Recovery was rapid, with cardiovascular flexibility returning almost immediately."
- Brief spike example target: instead of "intermittent HRV spikes appeared," write "Several brief moments suggest your body may have been trying to release tension before returning to the sustained build that characterized most of the session."
`;

const SARAH_LANGUAGE_VARIETY_RULE_V1 = `
SARAH LANGUAGE VARIETY RULE - HIGH PRIORITY:
- Do not make "consistent with", "consistent", or "consistently" your default evidence phrase. In a full analysis, use this word family at most once unless quoting a saved source or preserving a user quote.
- Prefer direct clinical narration and varied connectors: "fits with", "aligns with", "matches", "supports", "points toward", "may reflect", "helps explain", "tracks with", "stays stable", "repeats across", "holds steady", or simply state the observation without a qualifier.
- Avoid stacking evidence caveats in the same rhythm. Instead of repeating "This is consistent with..." across paragraphs, explain what your body appears to be doing and why the evidence matters.
- Before returning final output, scan for repeated phrasing. If the "consistent" word family appears more than once, rewrite the extra instances with more natural wording or direct observation language.
`;

const GENITAL_STIMULATION_MECHANICS_RULE_V1 = `
GENITAL STATUS AND STIMULATION MECHANICS - HIGH PRIORITY:
- Do not let HR, HRV, or telemetry crowd out concrete session mechanics. When supported by notes, event timeline, reviewed visual evidence, video-pass findings, saved key clips, or subjective fields, include erection quality/stability, genital state, glans/shaft/meatus status, hand position, grip/contact geometry, stroke pattern, contact zone, pressure/friction/suction changes, device/foley interaction, and stimulation effectiveness.
- For masturbation or stimulation sessions, Sarah should usually answer: what was the genital/stimulation situation, how did contact or technique change over time, how did your penis respond when visible or logged, and how did those mechanics shape arousal, plateauing, climax threshold, discomfort, or recovery?
- If visual evidence supports grip, stroke, hand/genital contact, erection state, detumescence, genital visibility, sleeve/device fit, catheter/foley position, lubricant/preparation, or contact-location changes, mention the strongest supported findings in the Chronological Deep Dive or Motion & Evidence Interpretation. Use personal anatomy wording such as "your penis", "your shaft", "your glans", "your meatus", "your erection", and "your grip/contact pattern" when applicable.
- If the data only gives subjective scores such as erection stability or stimulation fit, use them as subjective evidence and say what they suggest practically. For example, a high stimulation-fit score can support that the technique was effective; a lower erection-stability score can explain why grip, contact zone, or stimulation method may have shifted.
- If these details are not visible or not logged, say that specific genital status, erection quality, grip, or stroke mechanics were not directly assessable rather than silently omitting the category. Do not invent a stroke pattern or erection state from HR alone.
- Keep the tone clinical and observational, not erotic. The point is session analysis: visible mechanics, sensory input, effectiveness, and physiological consequence.
`;

const BASELINE_ANATOMY_AND_DEVICE_SETUP_RULE_V1 = `
BASELINE / ENTRY ANATOMY AND DEVICE SETUP - HIGH PRIORITY:
- In the opening window of the Chronological Deep Dive, include a brief baseline physical setup read when evidence supports it. This may include visible or logged genital state, flaccid/partial/erect status, resting position relative to the scrotum or body, Foley/catheter visibility or size, electrode placement, lubricant/preparation, and whether stimulation had already begun.
- Treat reviewed session media, reviewed profile/anatomy evidence, session notes, event timeline entries, and structured subjective fields as possible sources for this baseline read. Current-session evidence controls current-session claims. Established profile/anatomy context may be used as baseline context only when it is clearly marked as established context or when current evidence supports it.
- Do not let the caution against invention erase supported visible anatomy. If the data supports that your penis was flaccid, partially erect, fully erect, resting on the scrotum, supported by a hand, catheterized, obscured, or not directly assessable at the start, say that plainly and clinically.
- If current-session visual evidence is absent or unclear, do not invent a baseline genital state. Say what is known from logs and what is not directly assessable, then continue.
- The goal is to preserve the old PulsePoint usefulness: the reader should understand the physical starting condition before HR, HRV, arousal arc, or device effects are interpreted.
`;

const ANATOMICAL_LATERALITY_RULE_V1 = `
ANATOMICAL LEFT/RIGHT DISCIPLINE - HIGH PRIORITY:
- "Your left" and "your right" must mean Ben's anatomical left/right, not the viewer's screen-left/screen-right.
- When you are facing the camera, your anatomical right appears on the viewer's left. In foot-of-table, overhead, supine, mirrored, rotated, composite, or cropped views, left/right can be ambiguous.
- Preserve anatomical identity across poses and camera angles. A bruise, mole, scar, catheter/tubing position, pelvic finding, genital finding, or skin mark on your anatomical right remains right-sided when you move from supine to standing, turn toward the camera, rotate, or appear in another crop or camera lane.
- Track stable landmarks such as your umbilicus, sternum, pubic mound, inguinal creases, thighs, known scars, moles, bruises, catheter exit angle, and manual side notes before assigning side.
- Do not convert screen position into anatomical laterality unless the evidence clearly establishes camera orientation from body landmarks, tracking labels, manual notes, or source metadata.
- If laterality is uncertain, say "screen-left", "screen-right", "near/far", "upper/lower", "one hand/the other hand", or "one leg/the other leg" instead of anatomical left/right.
- Apply this to masturbation/stimulation mechanics, body exploration, Foley/procedure review, head-to-toe assessments, lower-body/foot findings, hand grip/stroke descriptions, and posture/asymmetry comments.
- If older video-pass evidence uses left/right but the camera perspective is unclear, treat the side label as uncertain and preserve the visible action without repeating the possibly flipped side.
`;

const ESTIM_WAVEFORM_AND_MODE_RULE_V1 = `
E-STIM WAVEFORM AND MODE INTERPRETATION - HIGH PRIORITY:
- If e-stim is listed in methods, e-stim notes exist, or e-stim screenshots are attached, do not silently drop the e-stim setup. Include the strongest supported details in the overview, Chronological Deep Dive, or Motion & Evidence Interpretation.
- When screenshots, notes, readable video overlays, or reviewed visual evidence provide enough detail, name and interpret waveform type, mode/program, channel assignments, electrode path, frequency, pulse width, power level, intensity, channel state, playback/activity state, ramp/intensity behavior, and whether the likely effect was sensory input, motor recruitment, pelvic floor loading, urethral/prostatic awareness, abdominal bracing, or mixed.
- Treat readable Howl, Coyote-E, e-stim, TENS, or stim-control overlays as device telemetry evidence. If frequency, intensity, power, mode, waveform, channel, play/pause, active state, or ramp state is visible, integrate it naturally into the session timeline instead of saying the device cannot be interpreted.
- If exact waveform or mode details are unavailable, say that the session confirms e-stim presence and placement but does not preserve the exact waveform/mode parameters. Then interpret only the supported placement, ramp, channel, or subjective effects.
- Connect e-stim settings to practical physiology: what muscle or sensory territory was likely being engaged, how it may have shaped erection quality, plateauing, pelvic/perineal loading, climax threshold, discomfort, ejaculatory force, or recovery.
- Keep uncertainty calibrated. E-stim settings are evidence, not proof of a single mechanism.
`;

const WARM_COMPANION_OUTPUT_DISCIPLINE = `
COMPANION VOICE AND SINGLE-PASS STRUCTURE - HIGH PRIORITY:
- Address the person directly throughout. Never write "the user," "the user's notes," "the subject," "the participant," or "the patient." Say "your notes," "you observed," "your body," "your pattern," or "your recovery."
- Produce one interpretive pass through the timeline only. The executive summary should preview the central arc without replaying details. The chronological deep dive is the only place to narrate sequential events.
- Do not re-explain the same insertion, heart-rate shift, movement event, or sensory note in multiple sections. Later sections should synthesize implications, not retell the event sequence.
- Organize the existing response keys as follows:
  * summary = Executive Summary: rich and concise.
  * arousal_arc = Chronological Deep Dive: one ordered, phase-by-phase timeline pass.
  * event_analysis = Motion Telemetry Interpretation and evidence integration: asymmetry, cadence proxy, movement patterns, conflicts between sources, and new implications only; do not replay chronology.
  * notable_findings = Pattern Recognition / Cross-Session Context and clearly identified hypotheses.
  * recommendations = Recommendations / Experiments: focused next steps grounded in supported findings.
- Prefix speculative mechanisms with "Hypothesis:" or "One possible explanation:" and qualify them with varied wording such as "may suggest", "may fit with", "aligns with", or "could reflect." Do not lean on "consistent with" or "consistently"; use those phrases sparingly.
- Describe observed findings confidently, but never say evidence "proves," "confirms," or "indicates definitively" an inferred physiological mechanism.
- If a subjective note conflicts with stronger direct visual review, reviewed media-derived evidence, telemetry, or a corrected later observation, prefer the stronger evidence and explicitly acknowledge the discrepancy. Do not build recommendations on a disputed note as though it were settled fact.
`;

function getCategoryMeta(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

const SECTION_COLORS = {
  primary: "hsl(var(--primary))",
  "chart-1": "hsl(var(--chart-1))",
  "chart-2": "hsl(var(--chart-2))",
  "chart-4": "hsl(var(--chart-4))",
  accent: "hsl(var(--accent))",
  destructive: "hsl(var(--destructive))",
};

function aiErrorMessage(error) {
  const raw = error?.data?.error || error?.message || String(error || "Analysis failed");
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || parsed?.message || parsed?.error || raw;
  } catch {
    return raw;
  }
}

function completedAt(job) {
  return job?.finishedAt || job?.updatedAt || job?.createdAt || null;
}

function isNewerCompletedJob(job, savedResult) {
  if (job?.status !== "complete") return false;
  const jobTime = new Date(completedAt(job) || 0).getTime();
  const savedTime = new Date(savedResult?._meta?.last_generated_at || savedResult?._meta?.updated_at || 0).getTime();
  return Number.isFinite(jobTime) && jobTime > (Number.isFinite(savedTime) ? savedTime : 0);
}

function hasKeyVideoClipMeta(savedResult) {
  const meta = savedResult?._meta || {};
  return Array.isArray(meta.key_video_clips) && meta.key_video_clips.length > 0
    || Boolean(meta.key_video_clip_error);
}

const LOWER_BODY_VIDEO_RE = /(?:^|[^a-z0-9])(feet|foot|toe|toes|heel|heels|sole|soles|lower[-_\s]?body|lower[-_\s]?cam|legs?)(?:$|[^a-z0-9])/i;
const LOWER_BODY_EVENT_RE = /(?:^|[^a-z0-9])(feet|foot|toe|toes|curl|plantar|heel|heels|sole|soles|leg|legs|thigh|thighs|knee|knees|ankle|ankles|lower[-_\s]?body|tremor|shudder|spasm|bracing|braced|plant(?:ed|ing)?)(?:$|[^a-z0-9])/i;
const KEY_VIDEO_CLIP_SCHEMA_VERSION = 3;

function hasLowerBodyVideoToken(value) {
  return LOWER_BODY_VIDEO_RE.test(String(value || "").toLowerCase());
}

function hasLowerBodyEventToken(value) {
  return LOWER_BODY_EVENT_RE.test(String(value || "").toLowerCase());
}

function clipLooksLowerBodyOnly(clip) {
  return clip?.camera_angle === "lower_body"
    || hasLowerBodyVideoToken([
      clip?.label,
      clip?.source_video_label,
      clip?.filename,
      clip?.url,
      clip?.clip_url,
    ].filter(Boolean).join(" "));
}

function hasPrimaryKeyVideoClipMeta(savedResult) {
  const clips = savedResult?._meta?.key_video_clips;
  return Array.isArray(clips) && clips.some((clip) => !clipLooksLowerBodyOnly(clip));
}

function hasLegacyTruncatedKeyVideoClipLabel(savedResult) {
  const clips = savedResult?._meta?.key_video_clips;
  if (!Array.isArray(clips)) return false;
  return clips.some((clip) => {
    const label = String(clip?.label || "").trim();
    if (label.length < 48 || /(\.\.\.|[.!?])$/.test(label)) return false;
    if (/^(Pre-climax build|Climax window|Recovery shift|Peak HR\b)/i.test(label)) return false;
    return /\b(partial(?:ly)?|appears?\s+to|consistent\s+with|visible|continues?|remains?|moves?|contact|shaft|glans|sleeve|hand|catheter|foley)\b/i.test(label);
  });
}

function hasOutdatedKeyVideoClipSchema(savedResult) {
  return hasKeyVideoClipMeta(savedResult)
    && Number(savedResult?._meta?.key_video_clip_schema_version || 0) < KEY_VIDEO_CLIP_SCHEMA_VERSION;
}

function needsKeyVideoClipRepair(savedResult) {
  return hasKeyVideoClipMeta(savedResult)
    && (
      !hasPrimaryKeyVideoClipMeta(savedResult)
      || hasLegacyTruncatedKeyVideoClipLabel(savedResult)
      || hasOutdatedKeyVideoClipSchema(savedResult)
    );
}

function shouldProcessCompletedJob(job, savedResult) {
  if (isNewerCompletedJob(job, savedResult)) return true;
  if (job?.status === "complete" && savedResult && needsKeyVideoClipRepair(savedResult)) return true;
  return job?.status === "complete" && savedResult && !hasKeyVideoClipMeta(savedResult);
}

function toAnalysisTextArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => repairCharacterSplitParagraph(String(item || "").trim()))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const repaired = repairCharacterSplitParagraph(value.trim());
    return repaired ? [repaired] : [];
  }
  return [];
}

function normalizeAnalysisShape(value) {
  if (!value || typeof value !== "object") return value;
  return {
    ...value,
    summary: typeof value.summary === "string" ? repairCharacterSplitParagraph(value.summary) : value.summary,
    arousal_arc: toAnalysisTextArray(value.arousal_arc),
    phase_analysis: toAnalysisTextArray(value.phase_analysis),
    event_analysis: toAnalysisTextArray(value.event_analysis),
    hr_analysis: toAnalysisTextArray(value.hr_analysis),
    emg_analysis: toAnalysisTextArray(value.emg_analysis),
    notable_findings: toAnalysisTextArray(value.notable_findings),
    recommendations: toAnalysisTextArray(value.recommendations),
  };
}

function repairSessionAnalysisResult(value) {
  return normalizeAnalysisShape(repairAITextBlocks(value));
}

function sessionAIPreflight(session, timelineRows = []) {
  const events = Array.isArray(session?.event_timeline)
    ? session.event_timeline.filter((event) => String(event?.note || "").trim())
    : [];
  const aiEvents = events.filter((event) => event?.source === "ai_video_pass" || event?.ai_annotation?.source);
  const localCandidateEvents = events.filter((event) => /candidate,\s*not confirmed|candidate_not_confirmed/i.test(`${event?.note || ""} ${(event?.annotation_tags || []).join(" ")}`));
  const videoPasses = normalizeSessionVideoPassFindings(session);
  const videoDraftEventCount = videoPasses.reduce((sum, entry) => sum + (entry.draft_events?.length || 0), 0);
  const videoFindingCount = videoPasses.reduce((sum, entry) => sum + (entry.findings?.length || 0), 0);
  const usefulEventNotes = events.filter((event) => String(event.note || "").replace(/\s+/g, " ").trim().length >= 35);
  const contextItems = sessionContextEvidenceItems(session);
  const weakVisualContext = videoPasses.length === 0 || (videoDraftEventCount < 2 && aiEvents.length < 2);
  const weakTimeline = usefulEventNotes.length < 3;
  return {
    eventCount: events.length,
    usefulEventCount: usefulEventNotes.length,
    aiEventCount: aiEvents.length,
    localCandidateEventCount: localCandidateEvents.length,
    videoPassCount: videoPasses.length,
    videoDraftEventCount,
    videoFindingCount,
    contextItems,
    contextEvidenceCount: contextItems.length,
    hasTelemetry: Array.isArray(timelineRows) && timelineRows.length > 5,
    creditRisk: weakTimeline && weakVisualContext,
  };
}

function normalizeSessionAnalysis(res) {
  const raw = typeof res === "string" ? JSON.parse(res) : res;
  const parsed = raw?.response ?? raw;
  const hasContent =
    parsed?.summary ||
    parsed?.arousal_arc?.length ||
    parsed?.phase_analysis?.length ||
    parsed?.event_analysis?.length ||
    parsed?.hr_analysis?.length;

  if (!hasContent || parsed?.raw) {
    throw new Error("AI returned text, but not the structured session analysis the app needs. Please try again.");
  }

  return repairSessionAnalysisResult(parsed);
}

function Section({ icon, title, color, children }) {
  return (
    <div className="bg-muted/60 rounded-lg p-3 space-y-2">
      <p className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: SECTION_COLORS[color] }}>
        {icon}{title}
      </p>
      <ul className="space-y-1.5">{children}</ul>
    </div>
  );
}

function Item({ text }) {
  return (
    <li className="text-sm text-foreground leading-relaxed pl-3 border-l-2 border-primary/40 py-1">
      {text}
    </li>
  );
}

function AnalysisStatus({ job }) {
  const progress = job?.progress || {};
  const total = Number(progress.total || 0);
  const current = Number(progress.current || 0);
  const pct = total > 0 ? Math.max(8, Math.min(100, Math.round((current / total) * 100))) : 18;
  const label = progress.message || (job?.status === "queued" ? "Queued…" : "Working…");
  return (
    <div className="rounded-lg border border-primary/25 bg-primary/8 px-3 py-3 text-xs">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-foreground">{label}</p>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10px] uppercase text-primary">
              {job?.status || "starting"}{progress.phase ? ` / ${progress.phase}` : ""}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
            {job?.id && <span>Job {String(job.id).slice(0, 8)}</span>}
            {progress.model && <span>Model {progress.model}</span>}
            {total > 0 && <span>Step {Math.min(current + 1, total)} of {total}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtMmSs(totalSeconds) {
  const value = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const m = Math.floor(value / 60);
  const s = value % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function timelineOffsetSeconds(video) {
  return Number(video?.timelineOffsetSeconds) || 0;
}

function sourceTimeForSession(sessionSeconds, video) {
  return Math.max(0, Number(sessionSeconds || 0) - timelineOffsetSeconds(video));
}

function sessionDurationSeconds(session, timelineRows = []) {
  const candidates = [
    numberOrNull(session?.duration_s),
    numberOrNull(session?.duration_seconds),
    numberOrNull(session?.recording_duration_s),
    numberOrNull(session?.duration_minutes) != null ? numberOrNull(session.duration_minutes) * 60 : null,
    numberOrNull(session?.recovery_offset_s) != null ? numberOrNull(session.recovery_offset_s) + 120 : null,
    numberOrNull(session?.climax_offset_s) != null ? numberOrNull(session.climax_offset_s) + 180 : null,
    ...timelineRows.map((row) => numberOrNull(row.time_offset_s)),
  ].filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : 0;
}

function clipPriorityForEvent(event) {
  const categories = Array.isArray(event?.category) ? event.category : [event?.category].filter(Boolean);
  const note = String(event?.note || "").toLowerCase();
  if (isExplicitClimaxOrEjaculationText(note)) return 95;
  if (categories.includes("sensation")) return 75;
  if (categories.includes("physical")) return 70;
  if (categories.includes("stimulation_started") || categories.includes("stimulation_resumed")) return 64;
  if (categories.includes("stimulation_paused") || categories.includes("stimulation_stopped")) return 58;
  if (categories.includes("movement_observed")) return 52;
  return 30;
}

function isExplicitClimaxOrEjaculationText(text) {
  const value = String(text || "").toLowerCase();
  if (/\brelease follow[-\s]?through\b/.test(value)) return false;
  return /\b(climax(?:ed|ing)?|orgasm(?:ed|ic)?|ejaculat(?:e|ed|ion|ing)?|cum(?:ming|med)?|came|semen|emission|expulsion|visible ejaculate|whitish ejaculate|fluid release|release of semen|full release)\b/.test(value);
}

function isClimaxClipText(text) {
  return isExplicitClimaxOrEjaculationText(text);
}

function clipWindowForEvent(event) {
  const text = [
    event?.note,
    Array.isArray(event?.category) ? event.category.join(" ") : event?.category,
    Array.isArray(event?.annotation_tags) ? event.annotation_tags.join(" ") : event?.annotation_tags,
  ].filter(Boolean).join(" ");
  if (isClimaxClipText(text)) return { before: 0, after: 45, maxDurationSeconds: 45 };
  if (hasLowerBodyEventToken(text)) return { before: 8, after: 18 };
  return { before: 6, after: 14 };
}

function keyClipLabelFromNote(note, fallback, maxLength = 96) {
  const normalized = String(note || "").replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  if (normalized.length <= maxLength) return normalized;
  const punctuationCut = Math.max(
    normalized.lastIndexOf("; ", maxLength),
    normalized.lastIndexOf(". ", maxLength),
    normalized.lastIndexOf(", ", maxLength),
  );
  const wordCut = normalized.lastIndexOf(" ", maxLength - 3);
  const cutAt = punctuationCut >= 36 ? punctuationCut + 1 : wordCut >= 36 ? wordCut : maxLength - 3;
  return `${normalized.slice(0, cutAt).trim()}...`;
}

function dedupeClipRequests(requests, minSpacingS = 22) {
  const sorted = [...requests]
    .filter((item) => Number.isFinite(item.session_time_s))
    .sort((a, b) => b.priority - a.priority);
  const accepted = [];
  for (const request of sorted) {
    if (accepted.some((item) => Math.abs(item.session_time_s - request.session_time_s) < minSpacingS)) continue;
    accepted.push(request);
  }
  return accepted.sort((a, b) => a.session_time_s - b.session_time_s);
}

function buildKeyVideoClipRequests(session, timelineRows = []) {
  const duration = sessionDurationSeconds(session, timelineRows);
  const requests = [];
  const add = (time, label, reason, priority, windowBefore = 5, windowAfter = 8, maxDurationSeconds = 30) => {
    const t = numberOrNull(time);
    if (t == null || t < 0) return;
    const clamped = duration ? Math.min(duration, Math.max(0, t)) : Math.max(0, t);
    requests.push({
      id: `${label}:${Math.round(clamped)}`,
      label,
      reason,
      priority,
      session_time_s: clamped,
      window_before_s: windowBefore,
      window_after_s: windowAfter,
      max_duration_s: maxDurationSeconds,
      include_lower_body_view: shouldIncludeLowerBodyClip(session, clamped, `${label} ${reason}`),
    });
  };

  add(session?.pre_climax_offset_s, "Pre-climax build", "Saved pre-climax marker", 88, 10, 16);
  add(session?.climax_offset_s, "Climax / ejaculation evidence window", "Saved climax marker; includes pre-roll so visible release or ejaculation evidence is not clipped off. Do not assume orgasm is visually occurring unless the clip itself shows it.", 100, 8, 38, 46);
  if (session?.climax_offset_s != null) {
    add(
      Number(session.climax_offset_s) + 22,
      "After-marker continuation",
      "Continued contact/motion after the saved climax marker; not automatically post-climax or orgasm evidence unless visible fluid/recovery signs confirm it.",
      78,
      8,
      22,
      30,
    );
  }
  add(session?.recovery_offset_s, "Recovery shift", "Saved recovery marker", 82, 10, 20);

  const hrRows = timelineRows
    .map((row) => ({ t: numberOrNull(row.time_offset_s), hr: numberOrNull(row.hr) }))
    .filter((row) => row.t != null && row.hr != null);
  if (hrRows.length) {
    const peak = hrRows.reduce((best, row) => (row.hr > best.hr ? row : best), hrRows[0]);
    const nearClimax = session?.climax_offset_s != null && Math.abs(Number(peak.t) - Number(session.climax_offset_s)) <= 45;
    add(
      peak.t,
      `Peak HR ${Math.round(peak.hr)} bpm`,
      "Highest heart-rate point in the imported timeline",
      nearClimax ? 92 : 74,
      nearClimax ? 6 : 8,
      nearClimax ? 30 : 16,
    );
  }

  const eventRequests = (session?.event_timeline || [])
    .map((event, index) => ({
      event,
      index,
      priority: clipPriorityForEvent(event),
    }))
    .filter((item) => item.priority >= 55)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 5);
  for (const { event, priority, index } of eventRequests) {
    const note = String(event?.note || "").trim();
    const label = keyClipLabelFromNote(note, `Event ${index + 1}`);
    const clipWindow = clipWindowForEvent(event);
    add(event?.time_s, label, "Accepted event timeline note", priority, clipWindow.before, clipWindow.after, clipWindow.maxDurationSeconds || 30);
  }

  return dedupeClipRequests(requests).slice(0, 5);
}

function linkedVideoRoleText(video) {
  return [
    video?.role,
    video?.viewRole,
    video?.source_video_role,
    video?.cameraRole,
    video?.camera,
    video?.label,
    video?.filename,
    video?.path,
  ].filter(Boolean).join(" ").toLowerCase();
}

function isLowerBodyVideo(video) {
  return hasLowerBodyVideoToken(linkedVideoRoleText(video));
}

function lowerBodySignalText(session, timeS, baseText = "") {
  const nearby = (session?.event_timeline || [])
    .filter((event) => Math.abs(Number(event?.time_s) - Number(timeS)) <= 28)
    .map((event) => [
      event?.note,
      Array.isArray(event?.category) ? event.category.join(" ") : event?.category,
      Array.isArray(event?.annotation_tags) ? event.annotation_tags.join(" ") : event?.annotation_tags,
    ].filter(Boolean).join(" "))
    .join(" ");
  return `${baseText} ${nearby}`.toLowerCase();
}

function shouldIncludeLowerBodyClip(session, timeS, baseText = "") {
  const text = lowerBodySignalText(session, timeS, baseText);
  return hasLowerBodyEventToken(text);
}

function chooseLinkedVideo(session, preference = "primary") {
  const videos = Array.isArray(session?.linked_local_videos) ? session.linked_local_videos : [];
  const reachable = videos.filter((video) => video?.path && video.exists !== false);
  const anyWithPath = videos.filter((video) => video?.path);
  const candidates = reachable.length ? reachable : anyWithPath;
  const preferredCandidates = preference === "lower_body"
    ? candidates.filter(isLowerBodyVideo)
    : candidates.filter((video) => !isLowerBodyVideo(video));
  const pool = preferredCandidates.length ? preferredCandidates : candidates;
  const score = (video) => {
    const text = linkedVideoRoleText(video);
    if (/\b(composite|pip|picture[-_\s]?in[-_\s]?picture|combined|obs)\b/.test(text)) return 120;
    if (/\b(main|primary|focus|genital|close)\b/.test(text)) return 110;
    if (/\b(lateral|side|full[-_\s]?body|whole[-_\s]?body)\b/.test(text)) return 80;
    if (hasLowerBodyVideoToken(text)) return 10;
    if (/\b(body|session)\b/.test(text)) return 60;
    return 50;
  };
  return [...pool].sort((a, b) => score(b) - score(a))[0] || null;
}

export async function generateSessionKeyVideoClips({ session, timelineRows, label, onProgress }) {
  const primaryVideo = chooseLinkedVideo(session, "primary");
  const lowerBodyVideo = chooseLinkedVideo(session, "lower_body");
  if (!primaryVideo?.path && !lowerBodyVideo?.path) return { clips: [], error: "No linked local recording is available for key clips." };
  const requests = buildKeyVideoClipRequests(session, timelineRows);
  if (!requests.length) return { clips: [], error: "No usable markers, events, or HR peaks were available for key clips." };

  const clips = [];
  const clipJobs = requests.flatMap((request) => {
    const jobs = [];
    const main = primaryVideo || lowerBodyVideo;
    if (main?.path) jobs.push({ request, video: main, angle: "primary" });
    if (
      request.include_lower_body_view &&
      lowerBodyVideo?.path &&
      lowerBodyVideo.path !== main?.path
    ) {
      jobs.push({ request, video: lowerBodyVideo, angle: "lower_body" });
    }
    return jobs;
  });

  for (let index = 0; index < clipJobs.length; index += 1) {
    const { request, video, angle } = clipJobs[index];
    onProgress?.({
      phase: "video_clips",
      current: index,
      total: clipJobs.length,
      message: `${label}: cutting key clip ${index + 1}/${clipJobs.length} with ffmpeg…`,
    });
    const sourceCenter = sourceTimeForSession(request.session_time_s, video);
    const startSeconds = Math.max(0, sourceCenter - request.window_before_s);
    const endSeconds = sourceCenter + request.window_after_s;
    const clip = await base44.integrations.Core.ProcessLocalVideoClip({
      path: video.path,
      startSeconds,
      endSeconds,
      label: `${label} ${request.label}${angle === "lower_body" ? " lower-body view" : ""}`,
      frameCount: 4,
      maxDurationSeconds: request.max_duration_s || 30,
    });
    clips.push({
      id: `${request.id}:${angle}:${index}`,
      label: angle === "lower_body" ? `${request.label} - lower-body view` : request.label,
      reason: angle === "lower_body" ? `${request.reason}; lower-body angle included for foot/leg/climax context` : request.reason,
      session_time_s: request.session_time_s,
      camera_angle: angle,
      source_video_label: video.label || video.filename || "Linked local video",
      source_video_fingerprint: video.fingerprint || "",
      timeline_offset_s: timelineOffsetSeconds(video),
      url: clip.url || clip.clip_url || clip.file_url,
      clip_url: clip.clip_url || clip.url || clip.file_url,
      filename: clip.filename,
      startSeconds: clip.startSeconds,
      endSeconds: clip.endSeconds,
      durationSeconds: clip.durationSeconds,
      motion_summary: clip.motion_summary || null,
      frames: Array.isArray(clip.frames)
        ? clip.frames.map((frame) => ({
          filename: frame.filename,
          file_url: frame.file_url || frame.url,
          url: frame.url || frame.file_url,
          mimeType: frame.mimeType || "image/jpeg",
          frameTimeSeconds: frame.frameTimeSeconds,
          frameIndex: frame.frameIndex,
        }))
        : [],
    });
  }
  return { clips, error: "" };
}

export function paragraphIndexForClip(clip, sections, totalParagraphs, durationS, paragraphs = []) {
  const textMatchedIndex = bestParagraphIndexForClipByText(clip, paragraphs);
  if (textMatchedIndex >= 0) return Math.min(totalParagraphs - 1, textMatchedIndex);
  const arousalSection = sections.find((section) => /chronological|arousal arc/i.test(section.label || ""));
  if (arousalSection?.items?.length) {
    const duration = durationS || Math.max(1, Number(clip.session_time_s) || 1);
    const ratio = Math.max(0, Math.min(0.999, Number(clip.session_time_s || 0) / duration));
    return arousalSection.start + Math.min(arousalSection.items.length - 1, Math.floor(ratio * arousalSection.items.length));
  }
  return Math.min(Math.max(1, totalParagraphs - 1), totalParagraphs - 1);
}

async function buildStoredSessionAnalysisResult({
  parsed,
  completedJob,
  session,
  analysisField,
  timelineRows,
  analysisLabel,
  previousResult,
  onProgress,
}) {
  const previousMeta = (previousResult || session?.[analysisField])?._meta || {};
  const clipResult = await generateSessionKeyVideoClips({
    session,
    timelineRows,
    label: analysisLabel,
    onProgress,
  }).catch((clipError) => ({
    clips: [],
    error: clipError?.message || "Could not generate key video clips.",
  }));

  return {
    ...parsed,
    _meta: {
      ...buildSessionAIContentMeta(session, previousMeta, completedAt(completedJob)),
      key_video_clip_schema_version: KEY_VIDEO_CLIP_SCHEMA_VERSION,
      key_video_clips: clipResult.clips || [],
      key_video_clip_error: clipResult.error || "",
    },
  };
}

export default function SessionAIPanel({ session, timelineRows, emgRows = [], userProfile, sessionJournal, mode = "companion", onAnalysisSaved }) {
  const isTechnical = mode === "technical";
  const analysisField = isTechnical ? "ai_session_deep_dive" : "ai_analysis";
  const analysisLabel = isTechnical ? "AI Session Technical Deep Dive" : "AI Session Analysis";
  const analysisTitle = isTechnical ? "Technical Session Deep Dive" : "AI Session Analysis";
  const [collapsed, setCollapsed] = useState(true);
  const [loading, setLoading] = useState(false);
  const [jobStatus, setJobStatus] = useState(null);
  const [result, setResult] = useState(repairSessionAnalysisResult(session[analysisField] ?? null));
  const [error, setError] = useState("");
  const clipRepairRef = useRef("");
  const resultStale = isSessionAIContentStale(result, session);
  const evidencePreflight = sessionAIPreflight(session, timelineRows);

  useEffect(() => {
    setResult(repairSessionAnalysisResult(session[analysisField] ?? null));
  }, [analysisField, session]);

  useEffect(() => {
    let cancelled = false;

    const reconnect = async () => {
      try {
        const data = await listBackgroundJobs({
          type: "ai_invoke",
          status: "queued,running,complete",
          metaSessionId: session.id,
          limit: 4,
        });
        if (cancelled) return;
        const job = (data.jobs || []).find((item) => item.meta?.label === analysisLabel);
        if (!job) return;
        if (job.status === "complete" && !shouldProcessCompletedJob(job, result || session[analysisField])) return;

        setCollapsed(false);
        setJobStatus(job);
        setLoading(job.status !== "complete");

        const completedJob = job.status === "complete"
          ? job
          : await waitForBackgroundJob(job.id, {
            intervalMs: 1200,
            onProgress: (nextJob) => {
              if (!cancelled) setJobStatus(nextJob);
            },
          });
        if (cancelled) return;
        if (!shouldProcessCompletedJob(completedJob, result || session[analysisField])) return;

        const parsed = normalizeSessionAnalysis(completedJob.result);
        const storedResult = await buildStoredSessionAnalysisResult({
          parsed,
          completedJob,
          session,
          analysisField,
          timelineRows,
          analysisLabel,
          previousResult: result || session[analysisField],
          onProgress: (progress) => {
            if (!cancelled) {
              setJobStatus({
                ...completedJob,
                progress: {
                  ...(completedJob.progress || {}),
                  ...progress,
                },
              });
            }
          },
        });
        if (cancelled) return;
        setResult(storedResult);
        setJobStatus({
          ...completedJob,
          progress: {
            ...(completedJob.progress || {}),
            phase: "saving",
            current: 3,
            total: 3,
            message: "Recovered complete analysis; saving it back to the session…",
          },
        });
        await base44.entities.Session.update(session.id, { [analysisField]: storedResult });
        onAnalysisSaved?.(analysisField, storedResult);
      } catch (err) {
        if (!cancelled) {
          console.warn(`${analysisLabel} reconnect skipped:`, err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    reconnect();
    return () => {
      cancelled = true;
    };
  }, [analysisField, analysisLabel, onAnalysisSaved, result, session, session.id]);

  useEffect(() => {
    let cancelled = false;
    const repairKeyClips = async () => {
      const currentResult = result || session[analysisField];
      if (!currentResult || !needsKeyVideoClipRepair(currentResult)) return;
      const primaryVideo = chooseLinkedVideo(session, "primary");
      if (!primaryVideo?.path) return;
      const repairReason = !hasPrimaryKeyVideoClipMeta(currentResult)
        ? "Replaced stale clips sourced from lower-body/feet video as primary."
        : hasOutdatedKeyVideoClipSchema(currentResult)
          ? "Rebuilt key video clips with current timing and clip-window rules."
        : "Rebuilt legacy key video clip labels that were cut off mid-phrase.";
      const repairKey = [
        session.id,
        analysisField,
        currentResult?._meta?.last_generated_at || currentResult?._meta?.updated_at || "unknown",
        repairReason,
        primaryVideo.path,
      ].join("|");
      if (clipRepairRef.current === repairKey) return;
      clipRepairRef.current = repairKey;
      try {
        setJobStatus({
          status: "running",
          progress: {
            phase: "video_clip_repair",
            current: 0,
            total: 1,
            message: `${analysisLabel}: refreshing saved key video clips...`,
          },
        });
        const clipResult = await generateSessionKeyVideoClips({
          session,
          timelineRows,
          label: analysisLabel,
          onProgress: (progress) => {
            if (!cancelled) {
              setJobStatus({
                status: "running",
                progress,
              });
            }
          },
        }).catch((clipError) => ({
          clips: [],
          error: clipError?.message || "Could not regenerate key video clips.",
        }));
        if (cancelled) return;
        if (!clipResult.clips?.length) {
          setJobStatus(null);
          return;
        }
        const repairedResult = {
          ...currentResult,
          _meta: {
            ...(currentResult._meta || {}),
            key_video_clip_schema_version: KEY_VIDEO_CLIP_SCHEMA_VERSION,
            key_video_clips: clipResult.clips,
            key_video_clip_error: clipResult.error || "",
            key_video_clip_repaired_at: new Date().toISOString(),
            key_video_clip_repair_reason: repairReason,
          },
        };
        setResult(repairedResult);
        await base44.entities.Session.update(session.id, { [analysisField]: repairedResult });
        onAnalysisSaved?.(analysisField, repairedResult);
        if (!cancelled) {
          setJobStatus({
            status: "complete",
            progress: {
              phase: "video_clip_repair",
              current: 1,
              total: 1,
              message: "Key video clips repaired with main/composite source.",
            },
          });
        }
      } catch (err) {
        if (!cancelled) {
          console.warn(`${analysisLabel} key video clip repair skipped:`, err);
          setJobStatus(null);
        }
      }
    };
    repairKeyClips();
    return () => {
      cancelled = true;
    };
  }, [analysisField, analysisLabel, onAnalysisSaved, result, session, session.id, timelineRows]);

  const analyze = async () => {
    setLoading(true);
    setError("");
    setCollapsed(false);
    setJobStatus({
      status: "starting",
      progress: {
        phase: "building",
        current: 0,
        total: 3,
        message: "Building session context, HR timeline, event notes, and profile grounding…",
      },
    });

    try {

    // Build EMG summary for AI
    const emgSummary = (() => {
      if (!emgRows.length) return null;
      const isDual = emgRows.some((r) => r.left_pct != null || r.right_pct != null);
      const step = Math.max(1, Math.floor(emgRows.length / 200));
      const sampled = emgRows.filter((_, i) => i % step === 0);

      if (isDual) {
        const leftPcts = sampled.map((r) => r.left_pct).filter((v) => v != null);
        const rightPcts = sampled.map((r) => r.right_pct).filter((v) => v != null);
        const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
        const max = (arr) => arr.length ? Math.round(Math.max(...arr)) : null;
        // Detect clipping
        const leftClipPct = leftPcts.length ? Math.round((leftPcts.filter((v) => v >= 99).length / leftPcts.length) * 100) : 0;
        const rightClipPct = rightPcts.length ? Math.round((rightPcts.filter((v) => v >= 99).length / rightPcts.length) * 100) : 0;
        // Trajectory (sampled as "time_s:pct" pairs)
        const leftTraj = sampled.filter((r) => r.left_pct != null).map((r) => `at ${formatSecondsAsWords(r.time_s)}, ${Math.round(r.left_pct)}%`).join("; ");
        const rightTraj = sampled.filter((r) => r.right_pct != null).map((r) => `at ${formatSecondsAsWords(r.time_s)}, ${Math.round(r.right_pct)}%`).join("; ");
        return {
          channel_mode: "dual",
          total_samples: emgRows.length,
          target_area: session.emg_target_area || undefined,
          sensor_type: session.emg_sensor_type || undefined,
          left_avg_pct: avg(leftPcts),
          left_max_pct: max(leftPcts),
          left_clip_percent_of_time: leftClipPct,
          right_avg_pct: avg(rightPcts),
          right_max_pct: max(rightPcts),
          right_clip_percent_of_time: rightClipPct,
          left_trajectory: leftTraj,
          right_trajectory: rightTraj,
          calibration: {
            rest_l: session.emg_rest_left,
            max_l: session.emg_max_left,
            rest_r: session.emg_rest_right,
            max_r: session.emg_max_right,
            lr_flipped: session.emg_left_right_flipped,
          },
          placement_notes: {
            left: session.emg_left_placement_notes,
            right: session.emg_right_placement_notes,
            calibration: session.emg_calibration_notes,
            general: session.emg_general_notes,
          },
          placement_photo_tags: (session.emg_placement_photos || []).map((p) => `${p.tag}: ${p.caption}`).filter(Boolean),
        };
      } else {
        const pcts = sampled.map((r) => r.level_pct).filter((v) => v != null);
        const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
        const clipPct = pcts.length ? Math.round((pcts.filter((v) => v >= 99).length / pcts.length) * 100) : 0;
        const traj = sampled.filter((r) => r.level_pct != null).map((r) => `at ${formatSecondsAsWords(r.time_s)}, ${Math.round(r.level_pct)}%`).join("; ");
        return {
          channel_mode: "single",
          total_samples: emgRows.length,
          target_area: session.emg_target_area || undefined,
          sensor_type: session.emg_sensor_type || undefined,
          avg_pct: avg(pcts),
          max_pct: pcts.length ? Math.round(Math.max(...pcts)) : null,
          clip_percent_of_time: clipPct,
          trajectory: traj,
          calibration: {
            rest: session.emg_rest_left,
            max: session.emg_max_left,
            calibration_notes: session.emg_calibration_notes,
          },
          placement_notes: session.emg_left_placement_notes,
          general_notes: session.emg_general_notes,
          placement_photo_tags: (session.emg_placement_photos || []).map((p) => `${p.tag}: ${p.caption}`).filter(Boolean),
        };
      }
    })();

    const estimScreenshots = [
      ...(session.estim_screenshots || []),
      ...(session.estim_screenshot && !(session.estim_screenshots?.includes(session.estim_screenshot)) ? [session.estim_screenshot] : []),
    ].filter(Boolean);

    const hrSummary = timelineRows.length > 0 ? {
      total_points: timelineRows.length,
      duration_s: Math.round(Math.max(...timelineRows.map(r => Number(r.time_offset_s) || 0))),
      hr_min: Math.round(Math.min(...timelineRows.map(r => Number(r.hr)))),
      hr_avg: Math.round(timelineRows.reduce((sum, row) => sum + Number(row.hr), 0) / timelineRows.length),
      hr_max: Math.round(Math.max(...timelineRows.map(r => Number(r.hr)))),
    } : null;
    const hrvEvidence = buildSessionHrvEvidence(timelineRows, session);

    // Sample HR trajectory for the prompt (~1 point every 15s)
    const hrTrajectory = (() => {
      if (!timelineRows.length) return null;
      const step = Math.max(1, Math.floor(timelineRows.length / 60));
      return timelineRows
        .filter((_, i) => i % step === 0)
        .map(r => `at ${formatSecondsAsWords(Number(r.time_offset_s))}, ${Math.round(Number(r.hr))} beats per minute`)
        .join("; ");
    })();

    // Build a sorted HR lookup from timeline rows for nearest-HR matching
    const sortedRows = [...timelineRows].sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));
    const nearestHR = (time_s) => {
      if (!sortedRows.length) return null;
      let best = sortedRows[0];
      let bestDist = Math.abs(Number(sortedRows[0].time_offset_s) - time_s);
      for (const r of sortedRows) {
        const d = Math.abs(Number(r.time_offset_s) - time_s);
        if (d < bestDist) { bestDist = d; best = r; }
        if (Number(r.time_offset_s) > time_s + 10) break; // past the window, stop early
      }
      return Math.round(Number(best.hr));
    };

    const formatTimeWords = (seconds) => {
      return formatSecondsAsWords(seconds);
    };

    const eventTimeline = (session.event_timeline || []).map(e => {
      const timeWords = formatTimeWords(e.time_s);
      const hr = nearestHR(e.time_s);
      const categories = Array.isArray(e.category) ? e.category : [e.category].filter(Boolean);
      const categoryLabels = categories.map((category) => getCategoryMeta(category).label).join(", ") || "Other";
      const provenance = e.source === "motion_derived" ? "motion-derived observation" : "manual observation";
      const relToClimax = session.climax_offset_s != null ? Math.round(e.time_s - session.climax_offset_s) : null;
      const relStr = relToClimax != null ? ` (${formatTimeWords(Math.abs(relToClimax))} ${relToClimax >= 0 ? 'after' : 'before'} climax)` : "";
      return `[${categoryLabels}; ${provenance}] at ${timeWords}${relStr} — ${e.note}${hr != null ? ` (heart rate: ${hr} beats per minute)` : ''}`;
    });

    const arousalProfile = userProfile && (userProfile.arousal_response_style || userProfile.arousal_notes || userProfile.climax_sensitivity) ? `

USER AROUSAL PROFILE:
${JSON.stringify({
  arousal_response_style: userProfile.arousal_response_style,
  typical_build_duration: userProfile.typical_build_duration,
  climax_sensitivity: userProfile.climax_sensitivity,
  preferred_stimulation: userProfile.preferred_stimulation,
  refractory_pattern: userProfile.refractory_pattern,
  arousal_notes: userProfile.arousal_notes,
}, null, 2)}

Use this arousal profile to personalize analysis: compare the observed build arc and climax pattern against the user's known response style. Note deviations (e.g. faster/slower than typical, more/less sensitive). Reference preferred methods when interpreting session effectiveness.` : "";

    const groundingContext = buildAIGroundingContext(userProfile);
    const firstNameToneCue = !isTechnical ? buildOptionalFirstNameToneCue(userProfile) : "";
    const structuredSessionContext = structuredSessionContextForAI(session);
    const structuredSessionContextText = sessionContextEvidenceText(session);
    const warmMotionEvidence = buildWarmMotionEvidence(session);
    const reviewedVisualEvidence = buildSessionVisualEvidenceDigest(session);
    const reviewedVideoPassEvidence = buildSessionVideoPassDigest(session);

    const journalContext = sessionJournal ? `

SESSION JOURNAL (person's own reflections after this session — treat as first-person subjective data):
Emotional reflection: ${sessionJournal.emotional_reflection || ""}
Physiological observations: ${sessionJournal.physiological_observations || ""}
Experience narrative: ${sessionJournal.experience_narrative || ""}
Insights: ${sessionJournal.insights || ""}
Next session intentions: ${sessionJournal.next_session_intentions || ""}
${sessionJournal.key_moments?.length ? `Key moments noted: ${sessionJournal.key_moments.join("; ")}` : ""}

Factor the journal into your analysis — where the person's subjective experience aligns with or diverges from the objective physiological data is especially worth noting.` : "";

    const hrvIntegrationRules = hrvEvidence ? `
RR-DERIVED HRV INTEGRATION RULE:
- Use RR-derived HRV as interpreted body-state evidence throughout the session analysis when quality and coverage support it, not as a detached metric list.
- Sarah should use HRV values to understand what the body appeared to be doing, then explain that clearly. The user should not have to decode RMSSD, SDNN, or pNN50 to understand the point.
- In companion/default analysis, translate HRV into body-state language first: focused, loaded, engaged, settled, flexible, releasing tension, backing away from intensity, reloading, recovering, mixed signal, or artifact/noisy signal. Only name RMSSD, SDNN, or pNN50 if the exact metric is necessary to support the claim.
- In Technical Deep Dive, you may name exact metrics, but still lead with the body-state interpretation before the value.
- Lead with what appears to be happening physiologically, then include the number only as supporting evidence. Bad: "RMSSD was five point two milliseconds." Better: "Your body looked highly focused here; the low rolling RMSSD supports that sustained-build read."
- Every HRV value you mention must answer "why is this interesting?" Tie it to a transition, mismatch, recovery response, breath/position possibility, stimulation change, or artifact caution. If the value does not change interpretation, leave it out.
- Compare HRV by meaningful windows: baseline or entry state, build/exploration, stimulation or body-state transitions, pre-climax, climax-to-recovery, and recovery/end-state when those windows exist.
- Tie HRV changes to heart rate direction, event notes, movement or EMG, stimulation changes, breathing/settling cues, discomfort, and recovery markers. The useful question is what the HRV pattern adds to the session story.
- If HR rises while usable HRV falls, describe what that means in human terms: the body may have been committing more fully to the ongoing experience rather than alternating between engagement and recovery.
- If recovery shows higher rolling RMSSD or SDNN than the build/climax window, use that to explain whether the body released effort efficiently rather than only saying HR came down.
- If HRV spikes while HR is still high, treat that as notable because it is a mixed signal: it may reflect a brief breath-release/tension-release moment, an irregular RR interval, or movement/contact artifact rather than simple relaxation. Explain the competing interpretations and why the timing matters.
- If HRV stays very low across a sustained phase, explain that as a focused, sustained, loaded build state when supported, not merely as "low HRV."
- If HRV is flat, noisy, low-quality-only, or not aligned with a meaningful event window, say the HRV evidence does not add a strong interpretation rather than forcing one.
- Put HRV where it belongs: overview if it changes the overall read, phase/window paragraphs when it explains a transition, notable findings when it forms a pattern, and recommendations only if it suggests a focused future comparison.
- Do not write a separate HRV mini-report unless the session's strongest finding is HRV-specific. Do not list RMSSD, SDNN, or pNN50 values without explaining their timing, quality, body-state meaning, and relationship to the session arc.
- For default Sarah analysis, prefer sentences like "your body looked more locked-in here," "there was a brief release signal while HR stayed elevated," or "your system seemed to back away from intensity briefly before reloading" over metric-first wording.
` : "";

    const aiPayload = {
      model: "claude_sonnet_4_6",
      ...(isTechnical ? { max_tokens: 12000 } : {}),
      ...(!isTechnical ? {
        temperature: 0.5,
        schema_mode: "base44_parity",
      } : {}),
      ...(estimScreenshots.length > 0 ? { file_urls: estimScreenshots } : {}),
      prompt: `${isTechnical
        ? `You are Sarah, an expert physiologist and anatomist specializing in sexual response, body-state interpretation, and careful review of intimate physiology data. Analyze this session as a rich, cohesive physiological story. Integrate session intent, arousal or exploration context, anatomy, heart rate data, stimulation or body-mapping technique, event notes, motion evidence when present, and subjective experience. Write directly to the person — use "you" and "your" throughout, as if speaking to them personally.

TARGET SESSION ANALYSIS STYLE:
- Begin with a substantial overview that synthesizes the session's outcome, heart-rate arc, stimulation context, notable physiology, and why the session behaved the way it did.
- When usable RR-derived HRV is present, integrate meaningful HRV changes into the overview and relevant windows instead of treating heart rate as the only autonomic signal.
- In Technical Deep Dive, HRV may include exact RMSSD, SDNN, pNN50, quality, and timing values, but never as a bare metric list. For each HRV detail you cite, explain the likely body-state meaning, why it is notable in that window, and what competing explanations remain. A good technical sentence should read like: "Your body looked highly focused during this window; the low rolling RMSSD supports that sustained-build interpretation because it occurred while HR was rising and contact intensity was changing." Not: "RMSSD was low."
- Technical does not mean number-heavy. It means mechanism-heavy, evidence-calibrated, and explicit about uncertainty. Use numbers as evidence anchors, then translate them into focus, load, release, reloading, recovery quality, sensor artifact, or mixed-signal interpretation.
- Then explain the session through meaningful physiological windows based on session intent: baseline/entry state, exploration or stimulation phase, sensory/body-state transitions, plateaus or settling, pre-climax when supported, climax or intentionally non-climax outcome, and recovery or end-state.
- A window may be chronological when chronology explains the physiology. The point is not to avoid time; the point is to make each time window explain arousal state, autonomic loading, sensory input, technique effectiveness, or recovery.
- Keep the older PulsePoint feel: detailed, insightful, physiology-forward, personally grounded, and useful for later comparison across sessions.
- Do not flatten the analysis into generic observations or a short summary. This is a deep session interpretation.`
        : `You are Sarah, an expert physiologist and anatomist specializing in sexual response, body-state interpretation, and careful review of intimate physiology data. Analyze this session by first identifying whether it is primarily masturbation/stimulation, body exploration, sensation mapping, recovery review, or mixed. Integrate anatomy, heart rate data, event timeline, motion evidence when present, subjective experience, and session intent into a cohesive narrative. Write directly to the person — use "you" and "your" throughout, as if speaking to them personally. Keep this natural, clinically grounded, and never forced. Let the narration feel warmly attentive and quietly familiar with the person's established patterns, noticing what stands out with natural human interest while staying grounded in the provided evidence.

Default HRV style: use HRV as Sarah's behind-the-scenes physiological signal. Explain what it suggests about load, settling, breath-release, recovery, or artifact in plain language. Do not make the user wade through RMSSD, SDNN, pNN50, or dense HRV numbers unless one value is essential and immediately translated.`}

${groundingContext}
${SESSION_CONTEXT_GROUNDING_RULE}
${structuredSessionContextText ? `
LOGGED SESSION CONTEXT / INFLUENCES (user-entered context, not telemetry or visual proof):
${structuredSessionContextText}

Use these fields as logged contextual influences. Keep alcohol and cannabis wording neutral and clinical. If logged alcohol or cannabis occurred near the session, say it may have influenced heart rate, arousal timing, sensory state, or autonomic tone; do not overclaim causality.` : ""}
${AI_SESSION_TYPE_GROUNDING_V1}
${BODY_STATE_INTERPRETIVE_STYLE_V1}
${reviewedVisualEvidence}
${reviewedVideoPassEvidence}
${warmMotionEvidence}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${HUMANIZED_PHYSIOLOGY_NARRATION_V1}
${SARAH_LANGUAGE_VARIETY_RULE_V1}
${GENITAL_STIMULATION_MECHANICS_RULE_V1}
${BASELINE_ANATOMY_AND_DEVICE_SETUP_RULE_V1}
${ANATOMICAL_LATERALITY_RULE_V1}
${ESTIM_WAVEFORM_AND_MODE_RULE_V1}
${firstNameToneCue}
${!isTechnical ? WARM_COMPANION_OUTPUT_DISCIPLINE : ""}

PHYSIOLOGICAL & ANATOMICAL LENS${isTechnical ? ":" : " — EVIDENCE-GROUNDED USE:"}
- Only mention specific physiological phases (e.g. emission, expulsion, plateau) or anatomical structures (e.g. pudendal nerve, bulbocavernosus, prostatic urethra) when the session data — an event note, HR pattern, subjective metric, or logged sensation — gives you a concrete reason to do so. Never insert these as generic background explanation.
- This caution should prevent unsupported invention, not suppress supported baseline anatomy, visible genital status, stimulation mechanics, Foley/catheter setup, or e-stim settings. When those are supported, include them.
- A saved climax marker is a timing anchor, not visual proof that orgasm, ejaculation, emission, expulsion, or recovery is visibly occurring throughout the surrounding clip. Distinguish exact visible/logged ejaculation or orgasm evidence from continued stimulation/contact, release follow-through, and after-marker continuation. Do not call a window post-climax unless visible recovery/cleanup/de-escalation or an accepted event note supports that state.
${isTechnical
  ? "- Interpret HR trajectory as a window into what the body was doing — loading, sustaining effort, backing away, rebuilding, settling, or recovering — but only narrate a mechanism if the HR data actually shows it."
  : "- Interpret HR trajectory as a window into what the body was doing — loading, sustaining effort, backing away, rebuilding, settling, or recovering — but only narrate a mechanism if the HR data actually shows it."}
${hrvEvidence ? "- Use usable RR-derived HRV as an additional within-session signal where it changes or strengthens the interpretation; weave it into the relevant body-state, stimulation, and recovery windows instead of merely listing HRV numbers. Translate the HRV pattern into clear body-state language before naming metrics." : ""}
${isTechnical
  ? `- Preserve the explanatory "why" as the center of the answer. When stimulation changes, heart-rate movement, physical cues, or subjective metrics line up, explain the likely mechanism behind the pattern instead of merely restating that it happened.
- Discuss stimulation-to-body links when supported: how pressure, friction, suction, vibration, e-stim, foley/urethral input, perineal contact, or technique shifts likely changed sensory input, pelvic floor tone, autonomic loading, or climax threshold.
- Preserve timeline awareness without becoming a transcript. Use time windows, HR ranges, plateaus, marker timing, and major transitions when they clarify the physiology. Do not list every note in order unless each one changes the interpretation.
- When the data allows more than one explanation, state the most plausible possibilities without inventing certainty. For example, a HR change after a technique shift may reflect sensory novelty, increased stimulation efficiency, pelvic floor recruitment, breath/position change, increased load, or reloading after a pause depending on the notes around it.`
  : ""}
- If foley or urethral stimulation is logged, discuss urethral sensory dynamics — but only in terms of what actually happened (logged sensations, HR response, notes). Skip if there's nothing to connect it to.
- If e-stim is present, discuss waveform/mode, electrode path, channel behavior, fiber recruitment, and frequency effects when e-stim notes or settings screenshots give you something specific to work with. If they do not, explicitly state that exact waveform/mode details were not preserved instead of implying they were unavailable by omission.
- Connect subjective sensations (pressure, throb, tightness, wave) to anatomical generators ONLY if the user actually logged those sensations.
- When figures from saved session summaries and sampled timeline calculations differ, use the directly computed timeline figure for timeline interpretation and explicitly state that a stored summary differs or may reflect rounding. Never silently cite conflicting heart-rate maxima or averages.
- Interpret discomfort anatomically ONLY if discomfort entries are present.
- The goal is ${isTechnical
  ? "a tight, evidence-driven explanation of what happened and why it likely happened. Every anatomical or physiological claim must be traceable to a specific data point in the session, but do not omit relevant physiology when the data supports it."
  : "a tight, evidence-driven analysis of what actually happened — not a physiology lecture. Every anatomical or physiological claim must be traceable to a specific data point in the session."}
${emgSummary ? `
EMG INTERPRETATION RULES — apply carefully:
- EMG % is NORMALIZED RELATIVE ACTIVATION, NOT absolute force. Never claim EMG % equals muscle force.
- Left/right comparisons are only valid when each channel was independently calibrated.
- If placement differs between sides, note that asymmetry may reflect placement differences, not true muscle asymmetry.
- Clipping (100%) means timing data is useful but high-end intensity detail is compressed — recommend raising max calibration or lowering gain.
- One flat/noisy channel suggests sensor dropout, poor contact, or cross-talk — call this out.
- If diff_pct is near zero during high activity, describe bilateral symmetry.
- If one side rises earlier, describe it as a lead/phase difference.
- If EMG peaks precede HR rise, describe EMG leading the HR response.
- If HR rises without EMG change, note this as a possible autonomic or non-muscular response.
- Describe the likely target muscle based on placement notes and photo tags when available.` : ""}
${hrvEvidence ? RR_HRV_INTERPRETATION_RULES : ""}
${hrvIntegrationRules}

CRITICAL FOR TEXT-TO-SPEECH QUALITY:
- Write all times as words: "ten minutes and thirty seconds" not "10:30"
- Never write raw second offsets such as "at 943 seconds" or "943s". Convert them to minutes and seconds, such as "at fifteen minutes and forty-three seconds".
- Spell out all numbers as words (e.g., "ten beats per minute" not "10 bpm")
- Write in conversational, sentence-based prose with natural pauses
- Use short sentences and simple grammar optimized for audio readability
- Avoid dense jargon — explain anatomical concepts briefly but accessibly
- Use commas and periods to create natural speech cadence
${arousalProfile}${estimScreenshots.length > 0 ? `

E-STIM SCREENSHOTS ATTACHED (${estimScreenshots.length}): Analyze the waveform types, frequencies, pulse widths, and channel configurations. Interpret how these settings recruited sensory vs motor fibers, shaped smooth muscle tone, and drove the arousal arc through the session.` : ""}${eventTimeline.length > 0 ? `

SESSION EVENT TIMELINE (with heart rate at each moment):
${eventTimeline.join('\n')}

${isTechnical
  ? `This is evidence for the physiological arc. Do not write a note-by-note transcript. Use the timeline to identify major transitions, clusters, body findings, stimulation shifts, phase markers, and recovery cues, then explain how those details connect to the HR trajectory and subjective outcome.

Use time references when they anchor the arc, but each time reference should answer "what changed and why might it matter?" Connect stimulation changes, physical findings, HR movement, and subjective context into mechanism-level interpretation. If a technique shift appears to change arousal, explain the plausible sensory or body-state reason. If HR rises, plateaus, or drops, explain what that likely says about load, sustained effort, backing away from intensity, pelvic floor engagement, sensory novelty, stimulation efficiency, or recovery state.

The best output should feel like: "Here is what was happening in the body during this phase, here is why this stimulation/body cue mattered, and here is how it shaped the next phase" — not "at this timestamp, then at this timestamp."`
  : `This is primary evidence for the single Chronological Deep Dive. Group closely related events into meaningful body-state transitions rather than narrating every note separately. At each major transition, explain what the body appears to be doing and why that matters. Reserve movement telemetry synthesis, recurring patterns, hypotheses, and recommendations for their dedicated sections; do not retell this timeline there.`}` : ""}

${hrTrajectory ? `HR TRAJECTORY (sampled readable time and heart rate):
${hrTrajectory}

Use this to trace body-state transitions, exploratory response, arousal plateaus when relevant, and correlation between HR changes and event timing. Describe what the person’s body appeared to be doing: becoming engaged, holding effort, backing away, rebuilding, settling, or recovering. For non-climax body exploration sessions, HR still matters: use it to describe activation, settling, comfort/discomfort, or positional/sensory response rather than looking for a climax arc.` : ""}

${hrvEvidence ? `RR-DERIVED HRV EVIDENCE (interpret in context; do not dump numbers):
${JSON.stringify(hrvEvidence, null, 2)}

Use this evidence to compare rolling HRV across meaningful session windows and explain what it adds to the HR/event/body-state interpretation. Treat quality and coverage as part of the claim. If the HRV pattern does not add a supported interpretation, say that briefly and move on.

Plain-language requirement: Sarah should use these values to improve the physiological read, but the final analysis should sound like a clear explanation of focus, load, release, reloading, recovery, mixed signals, or artifact. Avoid metric-first wording and avoid repeating "beat-to-beat variability", "compressed", or "autonomic" when more natural language would carry the same meaning.` : ""}

Session data:
${JSON.stringify({
  date: session.date ? (() => {
    const d = new Date(session.date);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  })() : undefined,
  time_of_day: session.start_time ? (() => {
    const h = parseInt(session.start_time.split(":")[0], 10);
    if (h >= 5 && h < 12) return "morning";
    if (h >= 12 && h < 17) return "afternoon";
    if (h >= 17 && h < 21) return "evening";
    return "night";
  })() : undefined,
  duration_minutes: session.duration_minutes,
  intensity: session.intensity,
  satisfaction: session.satisfaction,
  build_quality: session.build_quality,
  release_completeness: session.release_completeness,
  arousal_depth: session.arousal_depth,
  erection_stability: session.erection_stability,
  stimulation_fit: session.stimulation_fit,
  edge_control_quality: session.control,
  sensory_immersion: session.sensory_immersion,
  recovery_quality: session.recovery_quality,
  discomfort_interruption_impact: session.discomfort_interference,
  primary_limiting_factor: session.primary_limiting_factor,
  subjective_notes: session.subjective_notes,
  ...(isTechnical ? {
    technical_detail_mode: true,
  } : {}),
  build_type: session.build_type,
  climax_duration: session.climax_duration,
  mood: session.mood,
  environment: session.environment,
  methods: session.methods,
  foley_size: session.foley_size,
  foley_type: session.foley_type,
  estim_notes: session.estim_notes,
  estim_screenshots_attached: estimScreenshots.length,
  ejaculate_volume: session.ejaculate_volume,
  hydration: session.hydration,
  substances: session.substances,
  ...(structuredSessionContext ? { session_context: structuredSessionContext } : {}),
  discomfort_entries: session.discomfort_entries?.length > 0 ? session.discomfort_entries : undefined,
  unusual_sensations: session.unusual_sensations,
  refractory_notes: session.refractory_notes,
  notes: session.notes,
  reviewed_visual_evidence: reviewedVisualEvidence || undefined,
  reviewed_video_pass_evidence: reviewedVideoPassEvidence || undefined,
  hr: hrSummary ? {
    timeline_derived_avg: hrSummary.hr_avg,
    timeline_derived_max: hrSummary.hr_max,
    timeline_derived_min: hrSummary.hr_min,
    hr_at_climax: session.hr_at_climax,
    ...(session.avg_hr != null && Number(session.avg_hr) !== hrSummary.hr_avg ? { stored_summary_avg: session.avg_hr } : {}),
    ...(session.max_hr != null && Number(session.max_hr) !== hrSummary.hr_max ? { stored_summary_max: session.max_hr } : {}),
  } : undefined,
  rr_derived_hrv: hrvEvidence || undefined,
  phase_markers_s: {
    pre_climax: session.pre_climax_offset_s,
    climax: session.climax_offset_s,
    recovery: session.recovery_offset_s,
  },
}, null, 2)}

${session.discomfort_entries?.length > 0 ? "Discomfort entries present — analyze each for likely anatomical cause (nerve, tissue, positional), severity context, and whether it disrupted the arousal arc." : ""}
${emgSummary ? `\nEMG DATA:\n${JSON.stringify(emgSummary, null, 2)}\n\nAnalyze EMG activation patterns alongside HR. Reference timing relationships between EMG and HR changes. Check for clipping, asymmetry, noise, and relate activation bursts to event markers and phase markers when present. Describe what muscle the sensor likely captures based on placement notes and target area.` : ""}
${journalContext}

Provide ${isTechnical
  ? "a rich, physiologically-grounded analysis that tells the story of this session — from the autonomic and anatomical level up to the subjective experience. It should be detailed enough to explain the HR arc, phase shifts, stimulation effectiveness, distinctive sensations, and recovery pattern, while remaining smooth enough for text-to-speech narration."
  : "a rich, physiologically-grounded analysis that tells the story of this session — from the autonomic and anatomical level up to the subjective experience."}`,
      response_json_schema: {
        type: "object",
        properties: {
          summary: isTechnical
            ? { type: "string", description: "One cohesive overview emphasizing what the body appeared to be doing, arousal pattern, baseline anatomy/device setup when relevant, genital/stimulation context when supported, e-stim waveform/mode interpretation when available, stimulation effectiveness, HR/HRV-supported interpretation when available, and why the session behaved the way it did. Metrics support the story; they are not the story." }
            : { type: "string", description: "Executive Summary: a rich but concise overview of the session arc and defining findings, including supported baseline anatomy/device setup, erection quality/genital status/stimulation mechanics, and e-stim waveform/mode details when they materially shaped the session. Use HRV behind the scenes to explain focus, load, release, reloading, recovery, or mixed signals in plain language; avoid HRV metric lists." },
          arousal_arc: isTechnical
            ? { type: "array", items: { type: "string" }, description: "Several detailed phase/window paragraphs explaining HR and usable HRV as evidence for body-state transitions, beginning with a supported baseline physical setup read when available. Include exploration or stimulation links, supported anatomy, genital state, erection/response quality, grip/contact/stroke mechanics, e-stim waveform/mode or electrode-path details when available, pre-climax/climax/recovery shifts when present, and why the session progressed as it did. Preserve technical depth without becoming metric narration." }
            : { type: "array", items: { type: "string" }, description: "Chronological Deep Dive: group related events into meaningful body-state transitions and explain what the body appears to be doing. Start with supported baseline physical setup when available, including genital state, Foley/catheter or e-stim setup, and whether stimulation had begun. Include supported erection quality, grip/contact/stroke mechanics, e-stim settings/electrode path, and stimulation effectiveness where they explain the arousal arc. Weave in usable HRV as plain physiology when it clarifies a transition, not as raw values." },
          event_analysis: isTechnical
            ? { type: "array", items: { type: "string" }, description: "Several interpretive paragraphs about major event clusters, phase markers, distinctive sensations/findings, visible or logged stimulation mechanics, genital/foley/device interaction, e-stim waveform/mode/electrode-path implications, HR/HRV-supported turning points, and what made the session notable. Use time and numbers as evidence anchors, then explain why they matter to the body-state story." }
            : { type: "array", items: { type: "string" }, description: "Motion Telemetry Interpretation and evidence synthesis: interpret asymmetry, cadence proxy, movement patterns, visible or logged grip/contact/stroke/genital-state findings, e-stim waveform/mode/electrode-path implications when available, and HRV-informed body state where relevant, without raw HRV number dumps or chronology replay." },
          emg_analysis: { type: "array", items: { type: "string" }, description: "EMG signal quality, activation patterns, L/R comparison, EMG vs HR, calibration notes, and practical meaning for muscle engagement or relaxation — only if EMG data present" },
          notable_findings: isTechnical
            ? { type: "array", items: { type: "string" } }
            : { type: "array", items: { type: "string" }, description: "Pattern recognition, cross-session context when supported, and clearly labelled hypotheses with calibrated mechanism language." },
          recommendations: isTechnical
            ? { type: "array", items: { type: "string" } }
            : { type: "array", items: { type: "string" }, description: "Focused recommendations or experiments grounded in supported findings rather than repeated narrative." },
        },
        required: ["summary", "arousal_arc", "event_analysis", "notable_findings", "recommendations"],
      },
      label: analysisLabel,
    };

    setJobStatus({
      status: "starting",
      progress: {
        phase: "queueing",
        current: 0,
        total: 3,
        message: "Sending analysis to the background queue so it can continue outside the active tab…",
      },
    });
    const startedJob = await startBackgroundJob("ai_invoke", aiPayload, {
      sessionId: session.id,
      label: analysisLabel,
    });
    setJobStatus(startedJob);
    const completedJob = await waitForBackgroundJob(startedJob.id, {
      intervalMs: 1200,
      onProgress: setJobStatus,
    });

    const parsed = normalizeSessionAnalysis(completedJob.result);
    const storedResult = await buildStoredSessionAnalysisResult({
      parsed,
      completedJob,
      session,
      analysisField,
      timelineRows,
      analysisLabel,
      previousResult: session[analysisField],
      onProgress: (progress) => {
        setJobStatus({
          ...completedJob,
          progress: {
            ...(completedJob.progress || {}),
            ...progress,
          },
        });
      },
    });
    setResult(storedResult);
    setJobStatus({
      ...completedJob,
      progress: {
        ...(completedJob.progress || {}),
        phase: "saving",
        current: 3,
        total: 3,
        message: "Saving analysis to the session…",
      },
    });
    await base44.entities.Session.update(session.id, { [analysisField]: storedResult });
    onAnalysisSaved?.(analysisField, storedResult);
    } catch (err) {
      console.error(`${analysisLabel} failed:`, err);
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <button className="flex items-center gap-1.5 flex-1 text-left" onClick={() => setCollapsed((v) => !v)}>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
            <Brain className="w-4 h-4" /> {analysisTitle}
          </h3>
          {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground ml-1" /> : <ChevronUp className="w-4 h-4 text-muted-foreground ml-1" />}
        </button>
        <Button size="sm" onClick={analyze} disabled={loading} className="h-7 text-xs gap-1.5">
          {loading
            ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Working…</>
            : <><Brain className="w-3 h-3" />Analyze</>}
        </Button>
      </div>

      {!collapsed && loading && <AnalysisStatus job={jobStatus} />}

      {!collapsed && !result && !loading && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {isTechnical
              ? "Click Analyze for the newer deeper technical pass across physiology, timeline structure, and session turning points. Uses Claude Sonnet."
              : "Click Analyze to generate the original warm AI physiological session analysis. Uses Claude Sonnet."}
          </p>
          <div className={`rounded-lg border px-3 py-2 text-xs ${evidencePreflight.creditRisk ? "border-amber-400/35 bg-amber-400/10 text-amber-100" : "border-primary/20 bg-primary/5 text-muted-foreground"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-foreground">Evidence preflight</span>
              <span className="rounded-full border border-border bg-background/70 px-2 py-0.5">{evidencePreflight.usefulEventCount} useful event notes</span>
              <span className="rounded-full border border-border bg-background/70 px-2 py-0.5">{evidencePreflight.videoPassCount} saved video cards</span>
              <span className="rounded-full border border-border bg-background/70 px-2 py-0.5">{evidencePreflight.videoDraftEventCount} video draft events</span>
              {evidencePreflight.localCandidateEventCount > 0 && (
                <span className="rounded-full border border-border bg-background/70 px-2 py-0.5">{evidencePreflight.localCandidateEventCount} local candidates</span>
              )}
              {evidencePreflight.contextEvidenceCount > 0 && (
                <span className="rounded-full border border-border bg-background/70 px-2 py-0.5">{evidencePreflight.contextEvidenceCount} logged context fields</span>
              )}
            </div>
            {evidencePreflight.contextItems?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {evidencePreflight.contextItems.map((item) => (
                  <span key={item} className="rounded-full border border-border bg-background/80 px-2 py-0.5 text-[10px] text-foreground/90">
                    {item}
                  </span>
                ))}
              </div>
            )}
            <p className="mt-1 leading-relaxed">
              {evidencePreflight.creditRisk
                ? "Credit caution: Sarah has telemetry/profile/logged context, but not much accepted video/event evidence. This run may be generic unless you save useful annotation findings first."
                : "This looks usable for Session Analysis. Sarah will see accepted event notes, saved video-pass findings, telemetry, logged context/influences, and profile context."}
            </p>
          </div>
        </div>
      )}

      {!collapsed && error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!collapsed && result && (() => {
        const {
          paragraphs: paras,
          paragraphMeta,
          keyVideoClips,
          keyVideoClipError,
        } = buildSessionAnalysisReaderData({ result, session, timelineRows, isTechnical });

        return (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              <span>
                {result?._meta?.last_generated_at
                  ? `Generated ${formatGeneratedAt(result._meta.last_generated_at)}`
                  : "Generated time unavailable"}
              </span>
              {resultStale && (
                <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-semibold text-amber-300">
                  May be stale - newer saved evidence exists
                </span>
              )}
              {keyVideoClips.length > 0 && (
                <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-semibold text-primary">
                  {keyVideoClips.length} key video clip{keyVideoClips.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {!keyVideoClips.length && keyVideoClipError && (
              <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
                Key video clips were not added: {keyVideoClipError}
              </div>
            )}
            <AIOutputReader
              sessionId={session.id}
              title={analysisTitle}
              sessionDate={session.date}
              sourceGeneratedAt={result?._meta?.last_generated_at}
              paragraphs={paras}
              paragraphMeta={paragraphMeta}
            />
          </div>
        );
      })()}
    </div>
  );
}
