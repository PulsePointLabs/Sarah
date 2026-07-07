import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Play, Pause, Video, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Pencil, Trash2, Plus, Check, X, SkipBack, SkipForward, Mic, MicOff, ArrowUp, Sparkles, Maximize2, Minimize2, Heart } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, CartesianGrid,
} from "recharts";
import { EVENT_CATEGORIES, EXPLORATION_EVENT_CATEGORIES, normalizeCategoryArray } from "./session-form/EventTimelineSection";
import { base44 } from "@/api/base44Client";
import SavedMotionSummaryCard from "./SavedMotionSummaryCard";
import ClimaxMotionSnapshotCard from "./ClimaxMotionSnapshotCard";
import MotionPlaybackReadout from "./MotionPlaybackReadout";
import { getMotionEvidenceSummary } from "@/utils/sessionMotionEvidence";
import { cleanWhisperTranscript } from "@/utils/whisperTranscript";
import { isSarahNativeShell } from "@/lib/mobileApiBase";

function getCategoryMeta(value) {
  return [...EVENT_CATEGORIES, ...EXPLORATION_EVENT_CATEGORIES].find((c) => c.value === value) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

function fmtMmSs(totalSeconds) {
  const v = Math.round(Number(totalSeconds));
  const m = Math.floor(v / 60);
  const s = v % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtSignedMmSs(totalSeconds) {
  const value = Number(totalSeconds) || 0;
  return `${value < 0 ? "-" : ""}${fmtMmSs(Math.abs(value))}`;
}

const PHASE_LINES = [
  { key: "pre_climax_offset_s", label: "Pre", color: "#a855f7" },
  { key: "climax_offset_s",     label: "Climax", color: "#ef4444" },
  { key: "recovery_offset_s",   label: "Recovery", color: "#3b82f6" },
];

const EVENT_COLORS = [
  "#f59e0b", "#a855f7", "#10b981", "#f43f5e", "#0ea5e9",
  "#fb923c", "#84cc16", "#e879f9", "#34d399", "#f87171",
];

const AI_EVENT_TAGS = {
  physical_finding: { label: "Physical finding", color: "#10b981" },
  physiological_observation: { label: "Physiology", color: "#14b8a6" },
  stimulation_action: { label: "Stimulation action", color: "#3b82f6" },
  stimulation_change: { label: "Stim change", color: "#06b6d4" },
  instrumentation_action: { label: "Instrumentation", color: "#0ea5e9" },
  instrumentation_change: { label: "Instrument change", color: "#06b6d4" },
  sensation_report: { label: "Sensation", color: "#a855f7" },
  position_or_comfort: { label: "Position/comfort", color: "#f59e0b" },
  comfort_or_tolerance: { label: "Comfort/tolerance", color: "#f59e0b" },
  equipment_or_setup: { label: "Equipment", color: "#64748b" },
  other_context: { label: "Other context", color: "#94a3b8" },
};

const SESSION_AI_EVENT_TAGS = [
  "physical_finding",
  "physiological_observation",
  "stimulation_action",
  "stimulation_change",
  "sensation_report",
  "position_or_comfort",
  "equipment_or_setup",
  "other_context",
];
const EXPLORATION_AI_EVENT_TAGS = [
  "physical_finding",
  "physiological_observation",
  "instrumentation_action",
  "instrumentation_change",
  "sensation_report",
  "position_or_comfort",
  "comfort_or_tolerance",
  "equipment_or_setup",
  "other_context",
];
const VALID_AI_EVENT_TAGS = new Set(Object.keys(AI_EVENT_TAGS));
const EVENT_FILTERS = [
  { key: "ai_generated", label: "AI Generated", matches: (ev) => isAIGeneratedAnnotation(ev) },
  { key: "non_ai", label: "Non-AI", matches: (ev) => !isAIGeneratedAnnotation(ev) },
  { key: "stimulation", label: "Stimulation", matches: (ev) => normalizeCategoryArray(ev.category).includes("stimulation") || (ev.annotation_tags || []).includes("stimulation_action") },
  { key: "stimulation_change", label: "Stimulation Change", matches: (ev) => (ev.annotation_tags || []).includes("stimulation_change") || normalizeCategoryArray(ev.category).some((cat) => cat.includes("stimulation_")) },
  { key: "physical", label: "Physical", matches: (ev) => normalizeCategoryArray(ev.category).includes("physical") || (ev.annotation_tags || []).includes("physical_finding") },
  { key: "movement", label: "Movement", matches: (ev) => ev.source === "motion_derived" || (ev.annotation_tags || []).some((tag) => ["lower_body", "movement", "motion_derived"].includes(tag)) || normalizeCategoryArray(ev.category).includes("movement_observed") },
  { key: "physiology", label: "Physiology", matches: (ev) => (ev.annotation_tags || []).includes("physiological_observation") },
  { key: "sensation", label: "Sensation", matches: (ev) => normalizeCategoryArray(ev.category).includes("sensation") || (ev.annotation_tags || []).includes("sensation_report") },
  { key: "context", label: "Context", matches: (ev) => (ev.annotation_tags || []).some((tag) => ["position_or_comfort", "equipment_or_setup", "other_context"].includes(tag)) },
];
const VIDEO_FEED_SLOTS = [
  { key: "composite", label: "Composite / Picture-in-Picture", description: "Current single-video workflow with all views already combined." },
  { key: "main", label: "Main Focus Camera", description: "Primary close view used for the main review angle." },
  { key: "lower_body", label: "Feet / Lower Body Camera", description: "Separate feet, legs, and pelvis view." },
  { key: "lateral", label: "Lateral Angle", description: "Optional side-angle context view." },
];

function blankVideoFeeds() {
  return Object.fromEntries(VIDEO_FEED_SLOTS.map((feed) => [feed.key, {
    label: feed.label,
    fileName: "",
    src: null,
    localPath: "",
  }]));
}

function inferLinkedVideoFeedKey(video) {
  const text = `${video?.label || ""} ${video?.filename || ""} ${video?.path || ""}`.toLowerCase();
  if (/\b(feet|foot|toe|toes|heel|heels|lower[-_\s]?body|legs?|pelvis)\b/.test(text)) return "lower_body";
  if (/\b(main|focus|primary|close|genital|penis|shaft|glans|meatus)\b/.test(text)) return "main";
  if (/\b(side|lateral|angle)\b/.test(text)) return "lateral";
  if (/\b(composite|pip|picture[-_\s]?in[-_\s]?picture|obs)\b/.test(text)) return "composite";
  return "";
}

function assignLinkedVideosToFeeds(videos = []) {
  const fallbackSlots = ["composite", "lower_body", "main", "lateral"];
  const usedSlots = new Set();
  return videos.slice(0, VIDEO_FEED_SLOTS.length).map((video) => {
    const preferred = inferLinkedVideoFeedKey(video);
    const slotKey = preferred && !usedSlots.has(preferred)
      ? preferred
      : fallbackSlots.find((slot) => !usedSlots.has(slot));
    usedSlots.add(slotKey);
    return { video, slotKey };
  }).filter((assignment) => assignment.slotKey);
}

// Nearest HR from sorted chart data
function nearestHR(chartData, time_s) {
  if (!chartData.length) return null;
  let best = chartData[0];
  let bestDist = Math.abs(chartData[0].t - time_s);
  for (const pt of chartData) {
    const d = Math.abs(pt.t - time_s);
    if (d < bestDist) { bestDist = d; best = pt; }
  }
  return Math.round(best.hr);
}

// Events within ±windowSec of a playhead position
function _nearbyEvents(events, currentSec, windowSec = 30) {
  return events
    .map((ev, i) => ({ ev, i, dist: Math.abs(ev.time_s - currentSec) }))
    .filter(({ dist }) => dist <= windowSec)
    .sort((a, b) => a.dist - b.dist);
}

function CategorySelector({ selected, onChange, categories }) {
  const toggle = (val) => {
    onChange(selected.includes(val) ? selected.filter((v) => v !== val) : [...selected, val]);
  };
  return (
    <div className="flex flex-wrap gap-1">
      {categories.map((c) => {
        const active = selected.includes(c.value);
        return (
          <button key={c.value} type="button" onClick={() => toggle(c.value)}
            className="text-[9px] px-1.5 py-0.5 rounded-full border font-medium transition-all"
            style={active
              ? { background: c.color, color: "#fff", borderColor: c.color }
              : { background: c.color + "18", color: c.color, borderColor: c.color + "44" }
            }>{c.label}</button>
        );
      })}
    </div>
  );
}

function AnnotationTagPill({ value }) {
  const meta = AI_EVENT_TAGS[value];
  if (!meta) return null;
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-0 text-[8px] font-medium"
      style={{ background: meta.color + "1f", color: meta.color, border: `1px solid ${meta.color}40` }}
    >
      {meta.label}
    </span>
  );
}

function MotionDerivedBadge({ event }) {
  if (event?.verification_status === "reviewed_verified") {
    return (
      <span className="inline-flex items-center rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0 text-[8px] font-medium text-emerald-300">
        Verified
      </span>
    );
  }
  if (event?.verification_status === "reviewed_adjusted") {
    return (
      <span className="inline-flex items-center rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0 text-[8px] font-medium text-amber-300">
        Reviewed / adjusted
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0 text-[8px] font-medium text-primary">
      Motion-derived
    </span>
  );
}

function normalizeTagResult(result, categoryOptions, annotationTagOptions) {
  const validEventCategories = new Set(categoryOptions.map((category) => category.value));
  const validAnnotationTags = new Set(annotationTagOptions);
  const categories = (Array.isArray(result?.categories) ? result.categories : [])
    .filter((cat) => validEventCategories.has(cat));
  const annotationTags = (Array.isArray(result?.annotation_tags) ? result.annotation_tags : [])
    .filter((tag) => validAnnotationTags.has(tag));
  return {
    categories: categories.length ? [...new Set(categories)] : ["other"],
    annotation_tags: annotationTags.length ? [...new Set(annotationTags)] : ["other_context"],
    rationale: typeof result?.rationale === "string" ? result.rationale.slice(0, 180) : "",
  };
}

function getAnnotationTags(ev) {
  const tags = Array.isArray(ev?.annotation_tags) ? ev.annotation_tags : [];
  return tags.filter((tag) => VALID_AI_EVENT_TAGS.has(tag));
}

function isAIGeneratedAnnotation(ev) {
  return ev?.source === "ai_video_pass"
    || ev?.source === "ai_audio_pass"
    || ev?.ai_generated === true
    || ev?.annotation_origin === "ai"
    || ev?.ai_annotation?.source === "sarah_video_pass"
    || ev?.ai_annotation?.source === "sarah_audio_pass"
    || Boolean(ev?.audio_review);
}

function AIGeneratedBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-primary">
      AI
    </span>
  );
}

function heuristicTagEventNote(note, isExploration) {
  const text = String(note || "").toLowerCase();
  const categories = new Set();
  const annotationTags = new Set();

  if (isExploration) {
    if (/\b(foley|catheter|insert|insertion|remove|removal|sound|sounding|dilator|meatus|urethra|urethral|balloon|advance|withdraw|instrument|probe|device|lubric)\b/.test(text)) {
      categories.add("instrumentation");
      annotationTags.add("instrumentation_action");
    }
    if (/\b(adjust|change|switch|reposition|advance|withdraw|move|movement|rotate|pause|resume|stop|start|tension|size)\b/.test(text)) {
      categories.add("instrumentation_change");
      annotationTags.add("instrumentation_change");
    }
    if (/\b(leg|legs|feet|foot|toe|toes|tense|relax|shudder|tremor|spasm|breath|breathing|erection|scrot|foreskin|glans|flush|sweat|heart rate|hr|bpm)\b/.test(text)) {
      categories.add("physical");
      annotationTags.add(/\b(heart rate|hr|bpm)\b/.test(text) ? "physiological_observation" : "physical_finding");
    }
    if (/\b(sensation|feel|felt|pressure|fullness|stretch|awareness|sensitive|discomfort|pain|burn|sting|irritat|comfort|tolerat|pinch)\b/.test(text)) {
      categories.add(/\b(discomfort|pain|burn|sting|irritat|comfort|tolerat|pinch)\b/.test(text) ? "comfort" : "sensation");
      annotationTags.add(/\b(discomfort|pain|burn|sting|irritat|comfort|tolerat|pinch)\b/.test(text) ? "comfort_or_tolerance" : "sensation_report");
    }
    if (/\b(position|table|pillow|setup|camera|video|light|electrode|wire|strap|towel|sheet)\b/.test(text)) {
      categories.add(/\b(setup|camera|video|light|electrode|wire|strap|towel|sheet)\b/.test(text) ? "setup" : "comfort");
      annotationTags.add(/\b(setup|camera|video|light|electrode|wire|strap|towel|sheet)\b/.test(text) ? "equipment_or_setup" : "position_or_comfort");
    }
    if (!categories.size) categories.add("other");
    if (!annotationTags.size) annotationTags.add("other_context");
    return normalizeTagResult({
      categories: [...categories],
      annotation_tags: [...annotationTags],
      rationale: "Local keyword fallback",
    }, EXPLORATION_EVENT_CATEGORIES, EXPLORATION_AI_EVENT_TAGS);
  }

  if (/\b(stroke|stroking|grip|squeeze|speed|pace|pressure|manual|sleeve|vibrat|estim|e-stim|tens|foley|catheter|probe|lubric|suction|glans|frenulum|perineal|perineum|shaft)\b/.test(text)) {
    categories.add("stimulation");
    annotationTags.add("stimulation_action");
  }
  if (/\b(increas|decreas|faster|slower|firmer|lighter|harder|softer|adjust|switch|change|resume|pause|stop|start)\b/.test(text)) {
    annotationTags.add("stimulation_change");
  }
  if (/\b(start|begin|initiated|first contact)\b/.test(text)) categories.add("stimulation_started");
  if (/\b(paused|pause|break|stopped touching)\b/.test(text)) categories.add("stimulation_paused");
  if (/\b(resumed|resume|restarted)\b/.test(text)) categories.add("stimulation_resumed");
  if (/\b(stopped|stop stimulation|ended stimulation)\b/.test(text)) categories.add("stimulation_stopped");

  if (/\b(leg|legs|feet|foot|toe|toes|curl|plant|planted|tense|tensing|relax|shudder|tremor|spasm|pelvic|floor|thigh|hips|abdomen|breath|breathing|erection|scrot|foreskin|glans|flush|sweat)\b/.test(text)) {
    categories.add("physical");
    annotationTags.add("physical_finding");
  }
  if (/\b(hr|heart rate|bpm|sympathetic|parasympathetic|arousal|climax|ejaculat|release|recovery|engorg|contraction|autonomic)\b/.test(text)) {
    categories.add("physical");
    annotationTags.add("physiological_observation");
  }
  if (/\b(sensation|feel|felt|pleasure|warm|fullness|pressure|tingle|urge|near|edge|sensitive|discomfort|pain|burn|numb)\b/.test(text)) {
    categories.add("sensation");
    annotationTags.add("sensation_report");
  }
  if (/\b(reposition|position|table|comfort|pillow|adjusted body|moved|shifted|sat up|laid back|lithotomy|supine)\b/.test(text)) {
    categories.add("other");
    annotationTags.add("position_or_comfort");
  }
  if (/\b(camera|video|light|setup|electrode|wire|strap|device|tool|towel|sheet)\b/.test(text)) {
    categories.add("other");
    annotationTags.add("equipment_or_setup");
  }
  if (!categories.size) categories.add("other");
  if (!annotationTags.size) annotationTags.add("other_context");

  return normalizeTagResult({
    categories: [...categories],
    annotation_tags: [...annotationTags],
    rationale: "Local keyword fallback",
  }, EVENT_CATEGORIES, SESSION_AI_EVENT_TAGS);
}

async function classifyEventNoteWithAI(note, isExploration) {
  const categoryOptions = isExploration ? EXPLORATION_EVENT_CATEGORIES : EVENT_CATEGORIES;
  const annotationTagOptions = isExploration ? EXPLORATION_AI_EVENT_TAGS : SESSION_AI_EVENT_TAGS;
  const fallback = heuristicTagEventNote(note, isExploration);
  try {
    const result = await base44.integrations.Core.InvokeLLM({
      model: "claude_sonnet_4_5",
      temperature: 0,
      max_tokens: 600,
      response_json_schema: {
        type: "object",
        properties: {
          categories: {
            type: "array",
            items: { type: "string", enum: categoryOptions.map((c) => c.value) },
          },
          annotation_tags: {
            type: "array",
            items: { type: "string", enum: annotationTagOptions },
          },
          rationale: { type: "string" },
        },
        required: ["categories", "annotation_tags", "rationale"],
        additionalProperties: false,
      },
      prompt: isExploration ? `Classify this timestamped event annotation from a body exploration or instrumentation video review.

This record is not a stimulation-session timeline. Do not label notes as stimulation start, pause, resume, or stop.

Return broad event categories plus more specific annotation tags.

Broad category rules:
- instrumentation: Foley catheter, urethral sounding, dilator, insertion, removal, device contact, movement, or direct instrumentation observation.
- instrumentation_change: instrument adjustment, depth/position change, size/tool change, insertion/removal transition, or tension/movement change.
- physical: visible body finding or physiological sign, including legs, feet, breathing, tissue appearance, heart-rate/body response.
- sensation: subjective sensation such as pressure, fullness, stretch, sensitivity, awareness, or other felt response.
- comfort: comfort, discomfort, tolerance, irritation, pain, positioning-for-comfort, or pressure concerns.
- setup: camera/table/environment/device setup details that are not the body finding itself.
- other: useful context that does not fit above.

Specific annotation tag rules:
- physical_finding: visible body finding.
- physiological_observation: telemetry or body response interpretation grounded in the note.
- instrumentation_action: insertion, removal, Foley/sound/dilator use, or direct device/body interaction.
- instrumentation_change: tool movement, tension/position adjustment, size/device change, or insertion transition.
- sensation_report: subjective sensation or felt response.
- position_or_comfort: body repositioning or comfort adjustment.
- comfort_or_tolerance: comfort, discomfort, pressure tolerance, irritation, pain, or fit concern.
- equipment_or_setup: equipment, recording, table, or setup note.
- other_context: useful context outside the above.

Use multiple categories and tags when one annotation contains multiple things.

Annotation:
"${String(note).replace(/"/g, '\\"')}"` : `Classify this timestamped event annotation from a sexual response physiology video review.

Return broad event categories plus more specific annotation tags.

Broad category rules:
- stimulation: direct stimulation technique, speed, pressure, grip, tool use, e-stim, manual action.
- stimulation_started / stimulation_paused / stimulation_resumed / stimulation_stopped: use when the note clearly marks that state change.
- physical: visible body finding or physiological sign, including legs, feet, toes, pelvic floor, breathing, erection, heart-rate/body response.
- sensation: subjective sensation, pleasure, discomfort, fullness, sensitivity, urge, near-climax sensation.
- other: non-stimulation actions, repositioning, setup, comfort adjustment, camera/table/environment, or context.

Specific annotation tag rules:
- physical_finding: visible physical finding such as tense legs, foot planting, toe curl, tremor, pelvic movement.
- physiological_observation: arousal physiology, heart rate, autonomic shift, erection/climax/recovery pattern.
- stimulation_action: what is being done to stimulate.
- stimulation_change: increasing/decreasing speed, pressure, grip, switching tools, pausing/resuming.
- sensation_report: subjective feeling or sensation.
- position_or_comfort: repositioning or comfort adjustment that is not stimulation.
- equipment_or_setup: device, camera, electrode, catheter, sleeve, table, or setup note.
- other_context: useful context that does not fit above.

Use multiple categories and tags when one annotation contains multiple things.

Annotation:
"${String(note).replace(/"/g, '\\"')}"`,
    });
    const normalized = normalizeTagResult(result, categoryOptions, annotationTagOptions);
    return {
      categories: normalized.categories.length ? normalized.categories : fallback.categories,
      annotation_tags: normalized.annotation_tags.length ? normalized.annotation_tags : fallback.annotation_tags,
      rationale: normalized.rationale || "AI classification",
    };
  } catch (err) {
    console.warn("AI event auto-tagging failed, using local fallback:", err);
    return fallback;
  }
}

export default function VideoSyncPlayer({
  session,
  timelineRows,
  recordType = "session",
  externalSeekTime = null,
  onEventsChange,
}) {
  const isExploration = recordType === "body_exploration";
  const recordLabel = isExploration ? "exploration" : "session";
  const categoryOptions = isExploration ? EXPLORATION_EVENT_CATEGORIES : EVENT_CATEGORIES;
  const defaultCategory = isExploration ? "instrumentation" : "stimulation";
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const videoFeedRefs = useRef({});
  const videoFeedUrls = useRef({});
  const pendingMasterTimeRef = useRef(null);
  const autoLinkedSignatureRef = useRef("");
  const [videoSrc, setVideoSrc] = useState(null);
  const [videoFeeds, setVideoFeeds] = useState(blankVideoFeeds);
  const [activeFeedKey, setActiveFeedKey] = useState("composite");
  const [videoLayout, setVideoLayout] = useState("single");
  const [videoOffset, setVideoOffset] = useState(0);
  const [playheadS, setPlayheadS] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [playerHeight, setPlayerHeight] = useState(68);
  const [playerWidth, setPlayerWidth] = useState(66);
  const [telemetryDisplayMode, setTelemetryDisplayMode] = useState("sidebar");
  const [feedsExpanded, setFeedsExpanded] = useState(true);
  const layoutRef = useRef(null);
  const fullscreenSurfaceRef = useRef(null);
  const [domFullscreenActive, setDomFullscreenActive] = useState(false);
  const [shellFullscreenActive, setShellFullscreenActive] = useState(false);
  const fullscreenActive = domFullscreenActive || shellFullscreenActive;
  const [fullscreenControlsVisible, setFullscreenControlsVisible] = useState(true);
  const [mobileEventSheetOpen, setMobileEventSheetOpen] = useState(false);
  const fullscreenControlsTimerRef = useRef(null);
  const suppressNextFullscreenVideoToggleRef = useRef(false);
  const nativeShell = isSarahNativeShell();
  const widthDragStartRef = useRef({ x: 0, width: 66, layoutWidth: 1 });
  const [zoomWindow, setZoomWindow] = useState(60);
  const [activeEventIdx, setActiveEventIdx] = useState(null);
  const [selectedEventFilters, setSelectedEventFilters] = useState([]);
  const loadedFeeds = useMemo(
    () => VIDEO_FEED_SLOTS.map((meta) => ({ ...meta, ...videoFeeds[meta.key] })).filter((feed) => feed.src),
    [videoFeeds],
  );
  const linkedLocalVideos = useMemo(
    () => (session.linked_local_videos || []).filter((video) => video?.path && video.exists !== false),
    [session.linked_local_videos],
  );

  // Local mutable events list
  const [events, setEvents] = useState(session.event_timeline || []);

  useEffect(() => {
    setEvents(session.event_timeline || []);
    setSelectedEventFilters([]);
    setActiveEventIdx(null);
    setEditingIdx(null);
  }, [session.id, session.event_timeline]);

  // Edit state: idx of event being edited, or null
  const [editingIdx, setEditingIdx] = useState(null);
  const [editNote, setEditNote] = useState("");
  const [editCats, setEditCats] = useState([]);
  const [editMin, setEditMin] = useState("");
  const [editSec, setEditSec] = useState("");

  // Add-new state
  const [addingNew, setAddingNew] = useState(false);
  const [newNote, setNewNote] = useState("");
  const [lastUsedCat, setLastUsedCat] = useState(defaultCategory);
  const [newCats, setNewCats] = useState([lastUsedCat]);
  const [newMin, setNewMin] = useState("");
  const [newSec, setNewSec] = useState("");
  const [autoTagging, setAutoTagging] = useState(false);
  const [autoTagSuggestion, setAutoTagSuggestion] = useState(null);
  const [autoTagSuggestionNote, setAutoTagSuggestionNote] = useState("");
  const [autoTagError, setAutoTagError] = useState("");
  const [newCatsTouched, setNewCatsTouched] = useState(false);
  const [savingEvent, setSavingEvent] = useState(false);
  const autoTagPromiseRef = useRef(null);
  const autoTagPromiseNoteRef = useRef("");
  const autoTagRequestIdRef = useRef(0);
  const latestNewNoteRef = useRef("");

  // STT — Whisper via MediaRecorder, single-blob transcription on stop
  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState("");
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const sttSupported = !!navigator.mediaDevices?.getUserMedia;
  const newNoteRef = useRef(null);

  // Rich Whisper prompt written as a natural sentence so the decoder learns the vocabulary
  // and your speech pattern (deliberate pauses, short clauses, anatomical terms).
  const WHISPER_PROMPT = isExploration
    ? "Body exploration note. Foley catheter insertion. Urethral sounding observation. " +
      "Device movement at the meatus. Balloon awareness. Pressure and comfort noted. " +
      "Instrumentation paused for repositioning. Gentle withdrawal. Tissue appearance observed. " +
      "Heart rate change. Breathing relaxed. Irritation and tolerance review."
    :
    "Session log note. Gentle strokes on the glans penis. Foreskin partially retracted. " +
    "Stimulation paused. Perineum pressure applied. Pelvic floor contraction. " +
    "E-stim via TENS unit. Foley catheter in place. Urethral stimulation. " +
    "Edging — arousal near climax. Frenulum contact. Prostate stimulation. " +
    "Ejaculation. Refractory period. Buildup plateau. Involuntary spasm. Discomfort noted.";

  useEffect(() => {
    latestNewNoteRef.current = newNote.trim();
  }, [newNote]);

  const getEventClassification = useCallback(async (note) => {
    const cleanNote = String(note || "").trim();
    if (!cleanNote) return heuristicTagEventNote(cleanNote, isExploration);
    if (autoTagSuggestion && autoTagSuggestionNote === cleanNote) return autoTagSuggestion;
    if (autoTagPromiseRef.current && autoTagPromiseNoteRef.current === cleanNote) {
      return autoTagPromiseRef.current;
    }

    const requestId = autoTagRequestIdRef.current + 1;
    autoTagRequestIdRef.current = requestId;
    autoTagPromiseNoteRef.current = cleanNote;
    setAutoTagging(true);
    setAutoTagError("");

    const promise = classifyEventNoteWithAI(cleanNote, isExploration)
      .then((suggestion) => {
        if (
          autoTagRequestIdRef.current === requestId
          && autoTagPromiseNoteRef.current === cleanNote
          && latestNewNoteRef.current === cleanNote
        ) {
          setAutoTagSuggestion(suggestion);
          setAutoTagSuggestionNote(cleanNote);
          if (!newCatsTouched) setNewCats(suggestion.categories);
        }
        return suggestion;
      })
      .catch((err) => {
        console.warn("Event classification failed:", err);
        const fallback = heuristicTagEventNote(cleanNote, isExploration);
        if (autoTagRequestIdRef.current === requestId && latestNewNoteRef.current === cleanNote) {
          setAutoTagSuggestion(fallback);
          setAutoTagSuggestionNote(cleanNote);
        }
        return fallback;
      })
      .finally(() => {
        if (autoTagRequestIdRef.current === requestId) {
          setAutoTagging(false);
          autoTagPromiseRef.current = null;
          autoTagPromiseNoteRef.current = "";
        }
      });

    autoTagPromiseRef.current = promise;
    return promise;
  }, [autoTagSuggestion, autoTagSuggestionNote, isExploration, newCatsTouched]);

  const stopListening = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const toggleListening = useCallback(async () => {
    if (isListening) {
      stopListening();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/ogg";
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setIsListening(false);
        setInterimText("Transcribing…");
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];
        const ab = await blob.arrayBuffer();
        const bytes = new Uint8Array(ab);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const base64Audio = btoa(bin);
        const res = await base44.functions.invoke("whisperSTT", {
          audio_base64: base64Audio,
          mime_type: mimeType,
          prompt: WHISPER_PROMPT,
        });
        const text = cleanWhisperTranscript(res.data?.text);
        if (text) {
          setNewNote((prev) => {
            const base = prev.trim();
            return base ? base + " " + text : text;
          });
        }
        setInterimText("");
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsListening(true);
    } catch (err) {
      console.error("Mic access error:", err);
    }
  }, [isListening, stopListening]);

  const saveEvents = async (updated) => {
    const sorted = [...updated].sort((a, b) => a.time_s - b.time_s);
    setEvents(sorted);
    const entity = isExploration ? base44.entities.BodyExploration : base44.entities.Session;
    await entity.update(session.id, { event_timeline: sorted });
    onEventsChange?.(sorted);
  };

  const persistVideoOffset = async () => {
    const activePath = videoFeeds[activeFeedKey]?.localPath;
    if (!activePath) return;
    const nextVideos = (session.linked_local_videos || []).map((video) => (
      video.path === activePath ? { ...video, timelineOffsetSeconds: Number(videoOffset) || 0 } : video
    ));
    const entity = isExploration ? base44.entities.BodyExploration : base44.entities.Session;
    try {
      await entity.update(session.id, { linked_local_videos: nextVideos });
    } catch (err) {
      console.warn("Could not save linked video timeline offset:", err);
    }
  };

  const startEdit = (ev, idx) => {
    setEditingIdx(idx);
    setEditNote(ev.note);
    setEditCats(normalizeCategoryArray(ev.category).length ? normalizeCategoryArray(ev.category) : ["other"]);
    setEditMin(String(Math.floor(ev.time_s / 60)));
    setEditSec(String(ev.time_s % 60));
  };

  const commitEdit = async () => {
    const m = parseInt(editMin, 10) || 0;
    const s = Math.min(59, parseInt(editSec, 10) || 0);
    const updated = events.map((ev, i) =>
      i === editingIdx ? { ...ev, time_s: m * 60 + s, note: editNote.trim() || ev.note, category: editCats } : ev
    );
    setEditingIdx(null);
    await saveEvents(updated);
  };

  const cancelEdit = () => setEditingIdx(null);

  const deleteEvent = async (idx) => {
    await saveEvents(events.filter((_, i) => i !== idx));
  };

  const commitAdd = async ({ resume = false } = {}) => {
    const cleanNote = newNote.trim();
    if (!cleanNote || savingEvent) return;
    stopListening();
    setSavingEvent(true);
    try {
      setAutoTagError("");
      const classification = await getEventClassification(cleanNote);
      const m = parseInt(newMin, 10) || 0;
      const s = Math.min(59, parseInt(newSec, 10) || 0);
      const categories = newCatsTouched ? newCats : classification.categories;
      const ev = {
        time_s: m * 60 + s,
        note: cleanNote,
        category: categories,
        source: "manual",
        annotation_tags: classification.annotation_tags,
        ai_annotation: {
          source: classification.rationale === "Local keyword fallback" ? "local-fallback" : "ai",
          rationale: classification.rationale,
        },
      };
      await saveEvents([...events, ev]);
      setLastUsedCat(categories[0] || "other");
      setNewNote(""); setNewMin(""); setNewSec(""); setNewCats([categories[0] || "other"]);
      setNewCatsTouched(false);
      setAutoTagSuggestion(null);
      setAutoTagSuggestionNote("");
      setAutoTagError("");
      setAutoTagging(false);
      setSavingEvent(false);
      setAddingNew(false);
      if (resume && videoRef.current) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        await videoRef.current.play();
      }
    } catch (err) {
      console.error("Failed to save event:", err);
      setAutoTagging(false);
      setSavingEvent(false);
      setAutoTagError("Could not save event. Please try again.");
    }
  };

  const startAddAtPlayhead = () => {
    if (videoRef.current && !videoRef.current.paused) videoRef.current.pause();
    setNewMin(String(Math.floor(playheadS / 60)));
    setNewSec(String(Math.round(playheadS % 60)));
    setNewCats([lastUsedCat]);
    setNewCatsTouched(false);
    setAutoTagSuggestion(null);
    setAutoTagSuggestionNote("");
    setAutoTagError("");
    setAutoTagging(false);
    setAddingNew(true);
    setTimeout(() => newNoteRef.current?.focus(), 80);
  };

  const chartData = useMemo(() =>
    timelineRows.map((r) => ({
      t: Number(r.time_offset_s),
      hr: Math.round(Number(r.hr_smoothed || r.hr)),
    })),
    [timelineRows]
  );

  const maxT = chartData.length ? chartData[chartData.length - 1].t : (session.duration_minutes || 60) * 60;

  // Visible x-domain centered on playhead
  const xDomain = useMemo(() => {
    const half = zoomWindow / 2;
    const lo = Math.max(0, playheadS - half);
    const hi = Math.min(maxT, lo + zoomWindow);
    return [lo, hi];
  }, [playheadS, zoomWindow, maxT]);

  const setSynchronizedVideoTime = useCallback((timeS) => {
    const safeTime = Math.max(0, Number(timeS) || 0);
    if (videoRef.current) videoRef.current.currentTime = safeTime;
    loadedFeeds.forEach((feed) => {
      if (feed.key !== activeFeedKey && videoFeedRefs.current[feed.key]?.readyState > 0) {
        videoFeedRefs.current[feed.key].currentTime = safeTime;
      }
    });
  }, [activeFeedKey, loadedFeeds]);

  useEffect(() => {
    const requestedTime = typeof externalSeekTime === "object" && externalSeekTime !== null
      ? externalSeekTime.time
      : externalSeekTime;
    if (!Number.isFinite(Number(requestedTime))) return;
    const sessionTime = Math.max(0, Number(requestedTime));
    const localTime = Math.max(0, sessionTime - Number(videoOffset || 0));
    setPlayheadS(sessionTime);
    setSynchronizedVideoTime(localTime);
  }, [externalSeekTime, setSynchronizedVideoTime, videoOffset]);

  const syncSecondaryVideos = useCallback((primaryTime, playing = false) => {
    loadedFeeds.forEach((feed) => {
      if (feed.key === activeFeedKey) return;
      const video = videoFeedRefs.current[feed.key];
      if (!video || video.readyState === 0) return;
      if (Math.abs(video.currentTime - primaryTime) > 0.2) video.currentTime = primaryTime;
      video.playbackRate = playbackSpeed;
      if (playing && video.paused) video.play().catch(() => {});
      if (!playing && !video.paused) video.pause();
    });
  }, [activeFeedKey, loadedFeeds, playbackSpeed]);

  const selectMasterFeed = useCallback((key) => {
    const feed = videoFeeds[key];
    if (!feed?.src || key === activeFeedKey) return;
    pendingMasterTimeRef.current = Math.max(0, playheadS - videoOffset);
    videoRef.current?.pause();
    const linkedVideo = linkedLocalVideos.find((video) => video.path === feed.localPath);
    setVideoOffset(Number(linkedVideo?.timelineOffsetSeconds) || 0);
    setActiveFeedKey(key);
    setVideoSrc(feed.src);
  }, [activeFeedKey, linkedLocalVideos, playheadS, videoFeeds, videoOffset]);

  // Load browser-local video feeds. Files remain in memory only for this review.
  const handleFileLoad = (e, feedKey = "composite") => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const previousUrl = videoFeedUrls.current[feedKey];
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    videoFeedUrls.current[feedKey] = url;
    setVideoFeeds((current) => ({
      ...current,
      [feedKey]: { ...current[feedKey], src: url, fileName: file.name, localPath: "" },
    }));
    if (!videoSrc || feedKey === activeFeedKey) {
      setActiveFeedKey(feedKey);
      setVideoSrc(url);
      setVideoOffset(Number(video.timelineOffsetSeconds) || 0);
    }
    e.target.value = "";
  };

  const loadLinkedLocalVideo = useCallback((video, feedKey = "composite") => {
    if (!video?.path) return;
    const previousUrl = videoFeedUrls.current[feedKey];
    if (previousUrl) {
      URL.revokeObjectURL(previousUrl);
      delete videoFeedUrls.current[feedKey];
    }
    const url = base44.integrations.Core.localVideoStreamUrl(video.path);
    setVideoFeeds((current) => ({
      ...current,
      [feedKey]: {
        ...current[feedKey],
        src: url,
        fileName: video.label || video.filename || video.path,
        localPath: video.path,
      },
    }));
    if (!videoSrc || feedKey === activeFeedKey) {
      setActiveFeedKey(feedKey);
      setVideoSrc(url);
    }
  }, [activeFeedKey, videoSrc]);

  useEffect(() => {
    if (!linkedLocalVideos.length) return;
    const signature = linkedLocalVideos
      .map((video) => `${video.id || video.path}:${Number(video.timelineOffsetSeconds) || 0}`)
      .join("|");
    if (autoLinkedSignatureRef.current === signature) return;
    autoLinkedSignatureRef.current = signature;

    const assignments = assignLinkedVideosToFeeds(linkedLocalVideos);
    if (!assignments.length) return;
    const firstAssignment = assignments[0];
    const firstUrl = base44.integrations.Core.localVideoStreamUrl(firstAssignment.video.path);

    setVideoFeeds((current) => {
      const next = { ...current };
      assignments.forEach(({ video, slotKey }) => {
        const currentFeed = next[slotKey] || {};
        const isManualBrowserFile = currentFeed.src && !currentFeed.localPath;
        if (isManualBrowserFile) return;
        next[slotKey] = {
          ...currentFeed,
          label: video.label || video.filename || currentFeed.label || VIDEO_FEED_SLOTS.find((slot) => slot.key === slotKey)?.label || "Linked video",
          src: base44.integrations.Core.localVideoStreamUrl(video.path),
          fileName: video.label || video.filename || video.path,
          localPath: video.path,
        };
      });
      return next;
    });

    if (!videoSrc) {
      setActiveFeedKey(firstAssignment.slotKey);
      setVideoSrc(firstUrl);
      setVideoOffset(Number(firstAssignment.video.timelineOffsetSeconds) || 0);
    } else {
      const activePath = videoFeeds[activeFeedKey]?.localPath;
      const activeLinkedVideo = linkedLocalVideos.find((video) => video.path === activePath);
      if (activeLinkedVideo) setVideoOffset(Number(activeLinkedVideo.timelineOffsetSeconds) || 0);
    }
    if (assignments.length > 1) {
      setVideoLayout("multi");
      setFeedsExpanded(false);
    }
  }, [activeFeedKey, linkedLocalVideos, videoFeeds, videoSrc]);

  const renameFeed = (feedKey, label) => {
    setVideoFeeds((current) => ({
      ...current,
      [feedKey]: { ...current[feedKey], label },
    }));
  };

  const removeFeed = (feedKey) => {
    const removedUrl = videoFeedUrls.current[feedKey];
    const remaining = loadedFeeds.filter((feed) => feed.key !== feedKey);
    setVideoFeeds((current) => ({
      ...current,
      [feedKey]: { ...current[feedKey], src: null, fileName: "", localPath: "" },
    }));
    delete videoFeedRefs.current[feedKey];
    delete videoFeedUrls.current[feedKey];
    if (feedKey === activeFeedKey) {
      const next = remaining[0];
      pendingMasterTimeRef.current = Math.max(0, playheadS - videoOffset);
      setActiveFeedKey(next?.key || "composite");
      setVideoSrc(next?.src || null);
      setVideoDuration(0);
    }
    if (removedUrl) URL.revokeObjectURL(removedUrl);
    if (remaining.length <= 1) setVideoLayout("single");
  };

  // Sync video → playhead
  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const sessionTime = v.currentTime + videoOffset;
    setPlayheadS(sessionTime);
    syncSecondaryVideos(v.currentTime, !v.paused);
  }, [syncSecondaryVideos, videoOffset]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const handlePlay = () => {
      setIsPlaying(true);
      syncSecondaryVideos(v.currentTime, true);
    };
    const handlePause = () => {
      setIsPlaying(false);
      syncSecondaryVideos(v.currentTime, false);
    };
    const handleLoadedMetadata = () => {
      const desiredTime = pendingMasterTimeRef.current;
      if (Number.isFinite(desiredTime)) {
        v.currentTime = Math.min(desiredTime, v.duration || desiredTime);
        pendingMasterTimeRef.current = null;
      }
      setVideoDuration(v.duration);
      v.playbackRate = playbackSpeed;
      syncSecondaryVideos(v.currentTime, false);
    };
    v.addEventListener("timeupdate", handleTimeUpdate);
    v.addEventListener("play", handlePlay);
    v.addEventListener("pause", handlePause);
    v.addEventListener("loadedmetadata", handleLoadedMetadata);
    return () => {
      v.removeEventListener("timeupdate", handleTimeUpdate);
      v.removeEventListener("play", handlePlay);
      v.removeEventListener("pause", handlePause);
      v.removeEventListener("loadedmetadata", handleLoadedMetadata);
    };
  }, [handleTimeUpdate, playbackSpeed, syncSecondaryVideos, videoSrc]);

  useEffect(() => {
    if (!videoRef.current) return;
    syncSecondaryVideos(videoRef.current.currentTime, !videoRef.current.paused);
  }, [syncSecondaryVideos, videoLayout]);

  useEffect(() => () => {
    Object.values(videoFeedUrls.current).forEach((url) => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const fullscreenElement = document.fullscreenElement;
      setDomFullscreenActive(
        fullscreenElement === fullscreenSurfaceRef.current
        || fullscreenElement === videoRef.current
      );
      setFullscreenControlsVisible(true);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!shellFullscreenActive) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [shellFullscreenActive]);

  const clearFullscreenControlsTimer = useCallback(() => {
    if (fullscreenControlsTimerRef.current) {
      window.clearTimeout(fullscreenControlsTimerRef.current);
      fullscreenControlsTimerRef.current = null;
    }
  }, []);

  const showFullscreenControls = useCallback((hideDelay = 1800) => {
    setFullscreenControlsVisible(true);
    clearFullscreenControlsTimer();
    if (fullscreenActive && isPlaying) {
      fullscreenControlsTimerRef.current = window.setTimeout(() => {
        setFullscreenControlsVisible(false);
        fullscreenControlsTimerRef.current = null;
      }, hideDelay);
    }
  }, [clearFullscreenControlsTimer, fullscreenActive, isPlaying]);

  useEffect(() => {
    if (!fullscreenActive || !isPlaying) {
      clearFullscreenControlsTimer();
      setFullscreenControlsVisible(true);
      return undefined;
    }
    showFullscreenControls(1800);
    return clearFullscreenControlsTimer;
  }, [clearFullscreenControlsTimer, fullscreenActive, isPlaying, showFullscreenControls]);

  useEffect(() => {
    if (isPlaying && mobileEventSheetOpen) setMobileEventSheetOpen(false);
  }, [isPlaying, mobileEventSheetOpen]);

  const toggleFullscreenOverlay = useCallback(async () => {
    const surface = fullscreenSurfaceRef.current;
    const video = videoRef.current;
    if (!surface && !video) return;
    try {
      if (nativeShell) {
        setTelemetryDisplayMode("overlay");
        setShellFullscreenActive((current) => !current);
        setFullscreenControlsVisible(true);
        return;
      }
      if (document.fullscreenElement === surface || document.fullscreenElement === video) {
        await document.exitFullscreen?.();
        return;
      }
      if (document.fullscreenElement) await document.exitFullscreen?.();
      setTelemetryDisplayMode("overlay");
      await surface?.requestFullscreen?.();
    } catch (err) {
      console.warn("Fullscreen playback could not be opened:", err);
    }
  }, [nativeShell]);

  // Scroll-to-top
  const [showScrollTop, setShowScrollTop] = useState(false);
  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 300);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      const active = document.activeElement;
      const inInput = active?.tagName === "INPUT" || active?.tagName === "TEXTAREA" || active?.tagName === "SELECT";

      // Space: play/pause (not when typing)
      if (e.code === "Space" && !inInput) {
        e.preventDefault();
        if (videoRef.current) {
          videoRef.current.paused ? videoRef.current.play() : videoRef.current.pause();
        }
      }

      if ((e.code === "ArrowLeft" || e.code === "ArrowRight") && !inInput && videoRef.current) {
        e.preventDefault();
        const direction = e.code === "ArrowLeft" ? -1 : 1;
        const jumpS = e.shiftKey ? 30 : 5;
        setSynchronizedVideoTime(Math.max(0, Math.min(videoDuration || Infinity, videoRef.current.currentTime + (direction * jumpS))));
      }

      // S: pause video + open event form at current playhead (if not already open)
      if (e.code === "KeyS" && !inInput) {
        e.preventDefault();
        if (videoRef.current && !videoRef.current.paused) videoRef.current.pause();
        if (!addingNew) {
          setNewMin(String(Math.floor(playheadS / 60)));
          setNewSec(String(Math.round(playheadS % 60)));
          setNewCats([lastUsedCat]);
          setAddingNew(true);
          // Focus the textarea after render
          setTimeout(() => newNoteRef.current?.focus(), 50);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addingNew, playheadS, lastUsedCat, setSynchronizedVideoTime, videoDuration]);

  // Click on chart → seek video
  const handleChartClick = useCallback((data) => {
    if (!data?.activeLabel) return;
    const sessionT = Number(data.activeLabel);
    setPlayheadS(sessionT);
    const videoT = Math.max(0, sessionT - videoOffset);
    setSynchronizedVideoTime(videoT);
  }, [setSynchronizedVideoTime, videoOffset]);

  // Click event note → seek to it
  const seekToEvent = (ev, idx) => {
    setActiveEventIdx(idx);
    setPlayheadS(ev.time_s);
    const videoT = Math.max(0, ev.time_s - videoOffset);
    setSynchronizedVideoTime(videoT);
  };

  const seekToMotionPeak = (timeS) => {
    setPlayheadS(timeS);
    const videoT = Math.max(0, timeS - videoOffset);
    setSynchronizedVideoTime(videoT);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play(); else v.pause();
  };

  const stepFrames = (seconds) => {
    const v = videoRef.current;
    if (!v) return;
    setSynchronizedVideoTime(Math.max(0, v.currentTime + seconds));
  };

  const setSpeed = (speed) => {
    setPlaybackSpeed(speed);
    if (videoRef.current) videoRef.current.playbackRate = speed;
    loadedFeeds.forEach((feed) => {
      if (feed.key !== activeFeedKey && videoFeedRefs.current[feed.key]) {
        videoFeedRefs.current[feed.key].playbackRate = speed;
      }
    });
  };

  const handleWidthDragStart = useCallback((e) => {
    if (!layoutRef.current) return;
    e.preventDefault();
    const rect = layoutRef.current.getBoundingClientRect();
    widthDragStartRef.current = {
      x: e.clientX,
      width: playerWidth,
      layoutWidth: rect.width || 1,
    };

    const onMove = (ev) => {
      const { x, width, layoutWidth } = widthDragStartRef.current;
      const delta = ((ev.clientX - x) / layoutWidth) * 100;
      setPlayerWidth(Math.max(48, Math.min(78, Math.round(width + delta))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [playerWidth]);

  const handleTimelineScrub = (e) => {
    const v = videoRef.current;
    if (!v || !videoDuration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setSynchronizedVideoTime(frac * videoDuration);
  };

  const currentHR = useMemo(() => nearestHR(chartData, playheadS), [chartData, playheadS]);

  // Chart: only show data in visible window
  const visibleChartData = useMemo(() => {
    const [lo, hi] = xDomain;
    return chartData.filter(d => d.t >= lo - 5 && d.t <= hi + 5);
  }, [chartData, xDomain]);

  const savedMotionSummary = !isExploration ? session.motion_analysis_summary : null;
  const motionEvidence = !isExploration ? getMotionEvidenceSummary(session) : null;
  const visibleEventEntries = useMemo(() => events
    .map((ev, i) => ({ ev, i }))
    .filter(({ ev }) => (
      selectedEventFilters.length === 0
      || EVENT_FILTERS.some((filter) => selectedEventFilters.includes(filter.key) && filter.matches(ev))
    )), [events, selectedEventFilters]);
  const visibleEvents = useMemo(() => visibleEventEntries.map(({ ev }) => ev), [visibleEventEntries]);
  const closestVisibleEvent = useMemo(() => {
    if (!visibleEventEntries.length) return null;
    return visibleEventEntries.reduce((closest, entry) => (
      Math.abs(Number(entry.ev.time_s) - playheadS) < Math.abs(Number(closest.ev.time_s) - playheadS)
        ? entry
        : closest
    ), visibleEventEntries[0]);
  }, [playheadS, visibleEventEntries]);
  const closestVisibleEventHR = useMemo(
    () => closestVisibleEvent ? nearestHR(chartData, Number(closestVisibleEvent.ev.time_s)) : null,
    [chartData, closestVisibleEvent],
  );
  const closestVisibleEventCategories = closestVisibleEvent
    ? normalizeCategoryArray(closestVisibleEvent.ev.category)
    : [];
  const closestVisibleEventPrimaryCategory = closestVisibleEventCategories[0] || "other";
  const closestVisibleEventPrimaryMeta = getCategoryMeta(closestVisibleEventPrimaryCategory);
  const closestVisibleEventDeltaSeconds = closestVisibleEvent
    ? Math.round(Math.abs(Number(closestVisibleEvent.ev.time_s) - playheadS))
    : 0;
  const closestVisibleEventRelativeText = closestVisibleEvent
    ? closestVisibleEventDeltaSeconds < 1
      ? "At current playback position"
      : `${closestVisibleEventDeltaSeconds}s ${Number(closestVisibleEvent.ev.time_s) < playheadS ? "ago" : "ahead"}`
    : "";
  const closestVisibleEventHrText = closestVisibleEventHR != null && currentHR != null
    ? `HR ${closestVisibleEventHR} → Now ${currentHR}`
    : closestVisibleEventHR != null
      ? `HR ${closestVisibleEventHR}`
      : currentHR != null
        ? `Now ${currentHR}`
        : "";
  const hasSidebarContent = chartData.length > 0 || events.length > 0 || !!savedMotionSummary;
  const showSidebar = hasSidebarContent && telemetryDisplayMode === "sidebar";
  const showMobileEventPanel = telemetryDisplayMode === "overlay" && closestVisibleEvent;
  const mobileEventPanelExpanded = mobileEventSheetOpen || fullscreenActive;
  const mobileNearbyEventEntries = useMemo(() => visibleEventEntries
    .map(({ ev, i }) => ({ ev, i, dist: Math.abs(Number(ev.time_s) - playheadS) }))
    .filter(({ dist }) => dist <= 120)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 5), [playheadS, visibleEventEntries]);
  const displayedFeeds = videoLayout === "multi"
    ? loadedFeeds
    : loadedFeeds.filter((feed) => feed.key === activeFeedKey);
  const fullscreenControlsShown = !fullscreenActive || !isPlaying || fullscreenControlsVisible;

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      {showScrollTop && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="fixed bottom-6 right-4 z-50 w-10 h-10 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:bg-primary/90 transition-all"
          title="Scroll to top"
        >
          <ArrowUp className="w-4 h-4" />
        </button>
      )}
      <Dialog
        open={addingNew}
        onOpenChange={(open) => {
          if (!open) {
            stopListening();
            setAddingNew(false);
            setAutoTagging(false);
            setSavingEvent(false);
            autoTagRequestIdRef.current += 1;
            autoTagPromiseRef.current = null;
            autoTagPromiseNoteRef.current = "";
            setAutoTagSuggestion(null);
            setAutoTagSuggestionNote("");
            setAutoTagError("");
            setNewCatsTouched(false);
          }
        }}
      >
        <DialogContent
          portalContainer={fullscreenActive ? fullscreenSurfaceRef.current : undefined}
          overlayClassName="bg-transparent"
          className="w-[calc(100vw-2rem)] max-w-lg rounded-xl border-primary/30 bg-card p-4 sm:left-auto sm:right-6 sm:top-auto sm:bottom-6 sm:translate-x-0 sm:translate-y-0"
        >
          <DialogHeader className="pr-8">
            <DialogTitle className="text-sm text-primary">New Event at {fmtMmSs(playheadS)}</DialogTitle>
            <DialogDescription className="text-xs">
              Capture the current video moment and save it back to this {recordLabel}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input type="number" min={0} value={newMin} onChange={(e) => setNewMin(e.target.value)}
                placeholder="min" className="w-16 text-xs font-mono text-center bg-background border border-border rounded px-2 py-1.5" />
              <span className="text-muted-foreground font-bold">:</span>
              <input type="number" min={0} max={59} value={newSec} onChange={(e) => setNewSec(e.target.value)}
                placeholder="sec" className="w-16 text-xs font-mono text-center bg-background border border-border rounded px-2 py-1.5" />
            </div>
            <CategorySelector
              selected={newCats}
              categories={categoryOptions}
              onChange={(cats) => {
                setNewCatsTouched(true);
                setNewCats(cats.length ? cats : ["other"]);
              }}
            />
            <div className="flex gap-2 items-end">
              <textarea
                ref={newNoteRef}
                value={newNote}
                onChange={(e) => {
                  setNewNote(e.target.value);
                  setAutoTagError("");
                }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (newNote.trim() && !savingEvent) commitAdd({ resume: true }); } }}
                placeholder="Describe the event… or tap mic to dictate"
                rows={3}
                className="flex-1 text-sm bg-background border border-border rounded px-3 py-2 resize-none"
              />
              {sttSupported && (
                <button
                  type="button"
                  onClick={toggleListening}
                  className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${isListening ? "bg-destructive/10 border-destructive text-destructive animate-pulse" : "bg-muted border-border text-muted-foreground hover:text-foreground"}`}
                  title={isListening ? "Stop dictation" : "Dictate"}
                >
                  {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </button>
              )}
            </div>
            <div className="rounded-lg border border-border bg-muted/25 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <Sparkles className="h-3 w-3 text-primary" />
                  AI Annotation Tags
                </div>
                {autoTagging && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-primary">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    Tagging
                  </span>
                )}
                {newCatsTouched && autoTagSuggestion && (
                  <button
                    type="button"
                    onClick={() => {
                      setNewCats(autoTagSuggestion.categories);
                      setNewCatsTouched(false);
                    }}
                    className="text-[10px] font-medium text-primary hover:underline"
                  >
                    Apply AI
                  </button>
                )}
              </div>
              {autoTagSuggestion?.annotation_tags?.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {autoTagSuggestion.annotation_tags.map((tag) => <AnnotationTagPill key={tag} value={tag} />)}
                </div>
              ) : (
                <p className="mt-1 text-[10px] text-muted-foreground/75">
                  Tags are generated once when you save, then added to the event note.
                </p>
              )}
              {autoTagSuggestion?.rationale && autoTagSuggestion.rationale !== "Local keyword fallback" && (
                <p className="mt-1 text-[10px] text-muted-foreground/75">{autoTagSuggestion.rationale}</p>
              )}
              {autoTagError && <p className="mt-1 text-[10px] text-destructive">{autoTagError}</p>}
            </div>
            {isListening && (
              <p className="text-[10px] flex items-center gap-1.5 text-destructive">
                <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse inline-block shrink-0" />
                Recording, tap mic to stop and transcribe
              </p>
            )}
            {!isListening && interimText && (
              <p className="text-[10px] flex items-center gap-1.5 text-primary">
                <span className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin inline-block shrink-0" />
                {interimText}
              </p>
            )}
            {!isListening && !interimText && (
              <p className="text-[10px] text-muted-foreground/70"><kbd className="px-1 py-0.5 rounded bg-muted border border-border font-mono text-[9px]">Enter</kbd> saves and resumes video</p>
            )}
            <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
              <button onClick={() => { stopListening(); setAddingNew(false); }} className="flex items-center justify-center gap-1 text-xs px-3 py-2 rounded-lg bg-muted text-muted-foreground font-medium">
                <X className="w-3 h-3" /> Cancel
              </button>
              <button
                onClick={() => commitAdd({ resume: true })}
                disabled={!newNote.trim() || savingEvent}
                className="flex items-center justify-center gap-1 text-xs px-3 py-2 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-50"
              >
                {savingEvent || autoTagging ? <span className="w-3 h-3 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" /> : <Check className="w-3 h-3" />}
                {savingEvent ? (autoTagging ? "Tagging & Saving…" : "Saving…") : "Save & Resume"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
          <Video className="w-4 h-4" /> Video Sync Player
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {hasSidebarContent && videoSrc && (
            <div className="inline-flex rounded-lg border border-border bg-background p-1">
              <button
                type="button"
                onClick={() => setTelemetryDisplayMode("sidebar")}
                className={`rounded-md px-2.5 py-1 text-[10px] font-semibold ${telemetryDisplayMode === "sidebar" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              >
                Player + Sidebar
              </button>
              <button
                type="button"
                onClick={() => setTelemetryDisplayMode("overlay")}
                className={`rounded-md px-2.5 py-1 text-[10px] font-semibold ${telemetryDisplayMode === "overlay" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              >
                Video Overlay
              </button>
            </div>
          )}
          {videoSrc && (
            <button
              type="button"
              onClick={toggleFullscreenOverlay}
              className="inline-flex items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/10 px-2.5 py-1.5 text-[10px] font-semibold text-primary hover:bg-primary/20"
              title="Open the video with telemetry overlays in fullscreen"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              <span className="max-[950px]:hidden">Fullscreen Overlay</span>
              <span className="min-[951px]:hidden">Fullscreen Viewer</span>
            </button>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-xs px-3 py-1.5 rounded-lg bg-primary/10 text-primary font-medium hover:bg-primary/20 transition-colors"
          >
            {videoFeeds.composite.src ? "Change Composite Video" : "Load Composite / PiP Video"}
          </button>
        </div>
        <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={(event) => handleFileLoad(event, "composite")} />
      </div>

      <div className="p-4 space-y-4">
        <div className="rounded-lg border border-border bg-muted/15 p-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Local Video Feeds</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Use one composite picture-in-picture recording, linked original recording, or separate angles. Files remain local to this browser review.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {loadedFeeds.length > 0 && !feedsExpanded && (
                <span className="text-[10px] text-muted-foreground">{loadedFeeds.length} feed{loadedFeeds.length === 1 ? "" : "s"} loaded</span>
              )}
              <button
                type="button"
                onClick={() => setFeedsExpanded((current) => !current)}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground hover:border-primary/40 hover:text-primary"
                aria-expanded={feedsExpanded}
              >
                {feedsExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {feedsExpanded ? "Collapse" : "Expand"}
              </button>
            </div>
          </div>
          {feedsExpanded && (
          <>
          {loadedFeeds.length > 1 && (
            <div className="inline-flex rounded-lg border border-border bg-background p-1">
              <button
                type="button"
                onClick={() => setVideoLayout("single")}
                className={`rounded-md px-2.5 py-1 text-[10px] font-semibold ${videoLayout === "single" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              >
                One View
              </button>
              <button
                type="button"
                onClick={() => setVideoLayout("multi")}
                className={`rounded-md px-2.5 py-1 text-[10px] font-semibold ${videoLayout === "multi" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              >
                Side by Side
              </button>
            </div>
          )}
          <div className="grid gap-2 lg:grid-cols-2 2xl:grid-cols-4">
            {VIDEO_FEED_SLOTS.map((slot) => {
              const feed = videoFeeds[slot.key];
              const isMaster = feed.src && activeFeedKey === slot.key;
              return (
                <div key={slot.key} className={`rounded-lg border p-2.5 ${isMaster ? "border-primary/40 bg-primary/[0.06]" : "border-border bg-card/50"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-foreground">{feed.label || slot.label}</p>
                    {isMaster && <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold text-primary">Master</span>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[10px] text-muted-foreground">{slot.description}</p>
                  {feed.src ? (
                    <>
                      <input
                        value={feed.label}
                        onChange={(event) => renameFeed(slot.key, event.target.value)}
                        className="mt-2 h-7 w-full rounded border border-border bg-background px-2 text-[11px] text-foreground"
                        aria-label={`Rename ${slot.label}`}
                      />
                      <p className="mt-1 truncate text-[10px] text-muted-foreground">{feed.fileName}</p>
                      {feed.localPath && (
                        <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground">{feed.localPath}</p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {!isMaster && (
                          <button type="button" onClick={() => selectMasterFeed(slot.key)} className="rounded-md border border-primary/25 px-2 py-1 text-[10px] font-medium text-primary">
                            Use as master
                          </button>
                        )}
                        <label className="cursor-pointer rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground hover:text-foreground">
                          Replace
                          <input type="file" accept="video/*" className="hidden" onChange={(event) => handleFileLoad(event, slot.key)} />
                        </label>
                        {linkedLocalVideos.length > 0 && (
                          <select
                            value=""
                            onChange={(event) => {
                              const selected = linkedLocalVideos.find((video) => video.id === event.target.value || video.path === event.target.value);
                              if (selected) loadLinkedLocalVideo(selected, slot.key);
                            }}
                            className="h-6 rounded-md border border-border bg-background px-1.5 text-[10px] text-muted-foreground"
                            aria-label={`Load linked video into ${slot.label}`}
                          >
                            <option value="">Linked...</option>
                            {linkedLocalVideos.map((video) => (
                              <option key={video.id || video.path} value={video.id || video.path}>{video.label || video.filename || "Linked video"}</option>
                            ))}
                          </select>
                        )}
                        <button type="button" onClick={() => removeFeed(slot.key)} className="rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-destructive">
                          Remove
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="mt-3 grid gap-1.5">
                      {linkedLocalVideos.length > 0 && (
                        <select
                          value=""
                          onChange={(event) => {
                            const selected = linkedLocalVideos.find((video) => video.id === event.target.value || video.path === event.target.value);
                            if (selected) loadLinkedLocalVideo(selected, slot.key);
                          }}
                          className="h-8 rounded-md border border-primary/25 bg-primary/10 px-2 text-[10px] font-medium text-primary"
                          aria-label={`Load linked video into ${slot.label}`}
                        >
                          <option value="">Load linked video...</option>
                          {linkedLocalVideos.map((video) => (
                            <option key={video.id || video.path} value={video.id || video.path}>{video.label || video.filename || "Linked video"}</option>
                          ))}
                        </select>
                      )}
                      <label className="flex cursor-pointer items-center justify-center rounded-md border border-dashed border-border px-2 py-2 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary">
                        Load local video
                        <input type="file" accept="video/*" className="hidden" onChange={(event) => handleFileLoad(event, slot.key)} />
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {loadedFeeds.length > 1 && (
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              The master feed controls playback, seeking, event placement, and telemetry alignment. Other angles follow the same local timestamp and remain muted.
            </p>
          )}
          </>
          )}
        </div>
        <div ref={layoutRef} className="flex flex-col xl:flex-row gap-4 items-start">
          {/* Video player */}
          <div
            className="w-full min-w-0 space-y-3"
            style={{ flex: showSidebar ? `0 1 ${playerWidth}%` : "1 1 100%" }}
          >
        {videoSrc ? (
          <div className="space-y-3">
            <div
              ref={fullscreenSurfaceRef}
              className={`video-sync-surface relative flex w-full flex-col overflow-hidden bg-black ${
                fullscreenActive
                  ? `video-sync-fullscreen rounded-none ${shellFullscreenActive ? "fixed inset-0 z-[95] h-[100svh]" : "h-screen"}`
                  : "rounded-lg"
              }`}
              style={fullscreenActive ? undefined : { height: `${playerHeight}vh`, minHeight: 280, maxHeight: "82vh" }}
              onPointerMove={() => {
                if (fullscreenActive) showFullscreenControls();
              }}
              onPointerDown={() => {
                if (fullscreenActive && isPlaying && !fullscreenControlsVisible) {
                  suppressNextFullscreenVideoToggleRef.current = true;
                  showFullscreenControls();
                }
              }}
              onTouchStart={() => {
                if (fullscreenActive) showFullscreenControls();
              }}
            >
              <div className={`video-sync-media relative min-h-0 min-w-0 flex-1 bg-black ${videoLayout === "multi" && displayedFeeds.length > 1 ? "grid gap-px bg-border md:grid-cols-2" : ""}`}>
              {displayedFeeds.map((feed) => {
                const isMaster = feed.key === activeFeedKey;
                return (
                  <div key={feed.key} className="relative flex min-h-0 min-w-0 items-center justify-center bg-black">
                    <video
                      ref={isMaster
                        ? videoRef
                        : (element) => { videoFeedRefs.current[feed.key] = element; }}
                      src={feed.src}
                      muted={!isMaster}
                      className="h-full w-full object-contain cursor-pointer"
                      controls={!nativeShell && fullscreenActive && isMaster}
                      playsInline
                      onClick={() => {
                        if (isMaster) {
                          if (suppressNextFullscreenVideoToggleRef.current) {
                            suppressNextFullscreenVideoToggleRef.current = false;
                            return;
                          }
                          if (fullscreenActive && isPlaying && !fullscreenControlsVisible) {
                            showFullscreenControls();
                            return;
                          }
                          togglePlay();
                        }
                        else selectMasterFeed(feed.key);
                      }}
                    />
                    <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1 rounded bg-black/65 px-2 py-1 text-[10px] font-medium text-white">
                      {feed.label}
                      {isMaster && <span className="text-primary">Master</span>}
                    </div>
                    {!isMaster && (
                      <button
                        type="button"
                        onClick={() => selectMasterFeed(feed.key)}
                        className="absolute bottom-2 right-2 rounded bg-black/70 px-2 py-1 text-[10px] font-medium text-white hover:bg-primary"
                      >
                        Make master
                      </button>
                    )}
                  </div>
                );
              })}
              {telemetryDisplayMode === "overlay" && closestVisibleEvent && (
                <>
                  <div className="pointer-events-none absolute right-3 top-3 z-20 hidden w-[min(18rem,calc(100%-1.5rem))] overflow-hidden rounded-full border border-white/15 bg-black/70 px-3 py-2 text-white shadow-lg min-[951px]:block">
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 truncate text-[10px] font-semibold text-white">
                        {closestVisibleEventPrimaryMeta.label || "Event"}
                      </p>
                      <span className="shrink-0 font-mono text-xs font-semibold text-primary">
                        {fmtMmSs(closestVisibleEvent.ev.time_s)}
                      </span>
                    </div>
                    {(closestVisibleEventHR != null || currentHR != null) && (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {closestVisibleEventHR != null && (
                          <span className="font-mono text-[10px] font-bold text-rose-200">
                            HR {closestVisibleEventHR}
                          </span>
                        )}
                        {currentHR != null && closestVisibleEventDeltaSeconds >= 1 && (
                          <span className="font-mono text-[10px] font-semibold text-white/75">
                            → {currentHR}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                </>
              )}
              {telemetryDisplayMode === "overlay" && savedMotionSummary && (
                <div className={`absolute right-3 z-10 w-[min(24rem,calc(100%-1.5rem))] pointer-events-none max-[950px]:hidden ${closestVisibleEvent ? (fullscreenActive ? "bottom-28" : "bottom-3") : "top-3"}`}>
                  <div className="pointer-events-auto">
                    <MotionPlaybackReadout
                      summary={savedMotionSummary}
                      playbackTime={playheadS}
                      currentHR={currentHR}
                      overlay
                    />
                  </div>
                </div>
              )}
              {telemetryDisplayMode === "overlay" && currentHR != null && (!savedMotionSummary || fullscreenActive) && (
                <div className={`pointer-events-none absolute z-20 rounded-full border border-rose-200/20 bg-black/58 px-2.5 py-1.5 text-white shadow-lg backdrop-blur-md max-[950px]:px-2 max-[950px]:py-1 ${closestVisibleEvent && fullscreenActive ? "left-3 top-14 max-[950px]:left-auto max-[950px]:right-2 max-[950px]:top-2" : "right-3 top-3 max-[950px]:right-2 max-[950px]:top-2"}`}>
                  <div className="flex items-center gap-1.5">
                    <Heart className="h-3.5 w-3.5 fill-rose-400 text-rose-400 max-[950px]:h-3 max-[950px]:w-3" />
                    <span className="font-mono text-sm font-bold text-rose-200 max-[950px]:text-xs">{currentHR}</span>
                  </div>
                </div>
              )}
              {fullscreenActive && (
                <div className="absolute left-3 top-3 z-30 flex items-center gap-2 max-[950px]:left-2 max-[950px]:top-2">
                  <button
                    type="button"
                    onClick={toggleFullscreenOverlay}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-black/65 px-2.5 py-2 text-[10px] font-semibold text-white backdrop-blur-sm hover:bg-black/80 max-[950px]:px-2 max-[950px]:py-1.5"
                  >
                    <Minimize2 className="h-3.5 w-3.5" />
                    <span className="max-[950px]:sr-only">Exit Fullscreen</span>
                  </button>
                  <span className="hidden rounded-lg border border-white/10 bg-black/55 px-2.5 py-2 text-[10px] text-white/70 backdrop-blur-sm lg:inline">
                    Space play/pause | arrows seek | S add event
                  </span>
                </div>
              )}
              {fullscreenActive && (
                <div className="pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+5.75rem)] z-40 flex justify-end px-3 min-[951px]:hidden">
                  <button
                    type="button"
                    onClick={() => {
                      showFullscreenControls(2200);
                      startAddAtPlayhead();
                    }}
                    className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-xl shadow-black/25 transition-transform hover:scale-[1.02] active:scale-[0.98]"
                    aria-label={`Add event at ${fmtMmSs(playheadS)}`}
                  >
                    <Plus className="h-4 w-4" />
                    <span>Add event</span>
                    <span className="rounded-full bg-primary-foreground/15 px-2 py-0.5 font-mono text-[11px] text-primary-foreground/90">
                      {fmtMmSs(playheadS)}
                    </span>
                  </button>
                </div>
              )}
              {fullscreenActive && (
                <div className={`absolute inset-x-3 bottom-3 z-30 rounded-xl border border-white/15 bg-black/70 p-3 text-white shadow-xl backdrop-blur-sm transition-all duration-300 max-[950px]:inset-x-2 max-[950px]:bottom-2 max-[950px]:p-2 ${fullscreenControlsShown ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-4 opacity-0"}`}>
                  {videoDuration > 0 && (
                    <div className="mb-2 space-y-1 max-[950px]:mb-1.5">
                      <div
                        className="relative h-3 cursor-pointer rounded-full bg-white/15 max-[950px]:h-2.5"
                        onClick={handleTimelineScrub}
                        title="Click to seek video"
                      >
                        <div
                          className="absolute inset-y-0 left-0 rounded-full bg-primary"
                          style={{ width: `${((videoRef.current?.currentTime || 0) / videoDuration) * 100}%` }}
                        />
                        <div
                          className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-white shadow"
                          style={{ left: `${((videoRef.current?.currentTime || 0) / videoDuration) * 100}%` }}
                        />
                      </div>
                      <div className="flex justify-between px-0.5 font-mono text-[10px] text-white/70">
                        <span>{fmtMmSs(videoRef.current?.currentTime || 0)}</span>
                        <span>{fmtMmSs(videoDuration)}</span>
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2 max-[950px]:gap-1.5">
                    <button type="button" onClick={() => stepFrames(-5)} className="rounded-lg bg-white/10 p-2 hover:bg-white/20 max-[950px]:p-1.5" title="Back 5 seconds">
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={togglePlay} className="inline-flex min-w-28 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 max-[950px]:min-w-20 max-[950px]:px-3 max-[950px]:py-1.5">
                      {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                      <span>{isPlaying ? "Pause" : "Play"}</span>
                    </button>
                    <button type="button" onClick={() => stepFrames(5)} className="rounded-lg bg-white/10 p-2 hover:bg-white/20 max-[950px]:p-1.5" title="Forward 5 seconds">
                      <ChevronRight className="h-4 w-4" />
                    </button>
                    <div className="ml-1 flex items-center gap-1 max-[950px]:ml-0">
                      {[0.5, 1, 1.5, 2].map((speed) => (
                        <button
                          key={speed}
                          type="button"
                          onClick={() => setSpeed(speed)}
                          className={`rounded px-2 py-1 text-[10px] font-semibold max-[950px]:px-1.5 max-[950px]:py-1 ${playbackSpeed === speed ? "bg-primary text-primary-foreground" : "bg-white/10 text-white/75 hover:bg-white/20"}`}
                        >
                          {speed}x
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={startAddAtPlayhead}
                      className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-primary/35 bg-primary/15 px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/25 max-[950px]:px-2 max-[950px]:py-1.5"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span className="max-[950px]:hidden">Add Event at </span>{fmtMmSs(playheadS)}
                    </button>
                  </div>
                </div>
              )}
              </div>
              {showMobileEventPanel && (
                <div className={`video-sync-event-panel min-[951px]:hidden shrink-0 border-t border-border bg-card text-foreground shadow-2xl ${fullscreenActive ? "max-h-[42vh] pb-[calc(env(safe-area-inset-bottom)+0.5rem)]" : "max-h-[46vh]"} ${mobileEventPanelExpanded ? "overflow-y-auto" : "overflow-hidden"}`}>
                  <button
                    type="button"
                    onClick={() => setMobileEventSheetOpen((value) => !value)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
                    aria-expanded={mobileEventPanelExpanded}
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: closestVisibleEventPrimaryMeta.color }}
                        />
                        <p className="truncate text-sm font-semibold leading-none">
                          {closestVisibleEventPrimaryMeta.label || "Event"}
                        </p>
                      </div>
                      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                        {closestVisibleEventHrText || "Telemetry unavailable"} · {fmtMmSs(closestVisibleEvent.ev.time_s)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="rounded-full bg-muted px-2 py-1 font-mono text-[10px] font-semibold text-muted-foreground">
                        {closestVisibleEventRelativeText}
                      </span>
                      {mobileEventPanelExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
                    </div>
                  </button>
                  <div className={`px-3 ${mobileEventPanelExpanded ? "pb-3" : "pb-2"}`}>
                    <p className={`${mobileEventPanelExpanded ? "text-base leading-relaxed" : "line-clamp-1 text-xs"} text-foreground`}>
                      {closestVisibleEvent.ev.note || "Event note"}
                    </p>
                    {mobileEventPanelExpanded && (
                      <div className="mt-3 space-y-3">
                        <div className="flex flex-wrap gap-1.5">
                          {closestVisibleEventCategories.map((category) => {
                            const meta = getCategoryMeta(category);
                            return (
                              <span
                                key={category}
                                className="rounded-full border px-2 py-1 text-[10px] font-semibold"
                                style={{ color: meta.color, borderColor: `${meta.color}66`, background: `${meta.color}18` }}
                              >
                                {meta.label}
                              </span>
                            );
                          })}
                          {closestVisibleEvent.ev.source === "motion_derived" && <MotionDerivedBadge event={closestVisibleEvent.ev} />}
                          {isAIGeneratedAnnotation(closestVisibleEvent.ev) && <AIGeneratedBadge />}
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                          <div className="rounded-lg border border-border bg-muted/35 px-2.5 py-2">
                            <p className="text-muted-foreground">Timestamp</p>
                            <p className="mt-0.5 font-mono font-semibold text-foreground">{fmtMmSs(closestVisibleEvent.ev.time_s)}</p>
                          </div>
                          <div className="rounded-lg border border-border bg-muted/35 px-2.5 py-2">
                            <p className="text-muted-foreground">Position</p>
                            <p className="mt-0.5 font-semibold text-foreground">{closestVisibleEventRelativeText}</p>
                          </div>
                          <div className="rounded-lg border border-border bg-muted/35 px-2.5 py-2">
                            <p className="text-muted-foreground">Marker HR</p>
                            <p className="mt-0.5 font-mono font-semibold text-rose-500">{closestVisibleEventHR != null ? `${closestVisibleEventHR} bpm` : "No data"}</p>
                          </div>
                          <div className="rounded-lg border border-border bg-muted/35 px-2.5 py-2">
                            <p className="text-muted-foreground">Now</p>
                            <p className="mt-0.5 font-mono font-semibold text-rose-500">{currentHR != null ? `${currentHR} bpm` : "No data"}</p>
                          </div>
                        </div>
                        {mobileNearbyEventEntries.length > 1 && (
                          <div className="space-y-1.5">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Nearby events</p>
                            {mobileNearbyEventEntries.map(({ ev, i, dist }) => {
                              const color = EVENT_COLORS[i % EVENT_COLORS.length];
                              const cats = normalizeCategoryArray(ev.category);
                              const primaryMeta = getCategoryMeta(cats[0] || "other");
                              return (
                                <button
                                  key={`${i}-${ev.time_s}`}
                                  type="button"
                                  onClick={() => seekToEvent(ev, i)}
                                  className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors"
                                  style={{ background: `${color}14`, borderLeft: `3px solid ${color}` }}
                                >
                                  <span className="shrink-0 font-mono text-[10px] font-bold" style={{ color }}>
                                    {fmtMmSs(ev.time_s)}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[10px] font-semibold uppercase tracking-wide" style={{ color: primaryMeta.color }}>
                                      {primaryMeta.label}
                                    </span>
                                    <span className="line-clamp-2 text-foreground">{ev.note || "Event note"}</span>
                                  </span>
                                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                                    {dist < 1 ? "now" : `${Math.round(dist)}s`}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="flex flex-col md:flex-row md:items-center gap-2 rounded-lg bg-muted/40 px-3 py-2">
              <label className="flex items-center gap-3 flex-1 min-w-[220px]">
                <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider shrink-0">Height</span>
                <Slider
                  value={[playerHeight]}
                  min={38}
                  max={82}
                  step={2}
                  onValueChange={([value]) => setPlayerHeight(value)}
                  className="flex-1"
                />
                <span className="text-[10px] font-mono text-muted-foreground w-10 text-right">{playerHeight}vh</span>
              </label>
              <label className="hidden xl:flex items-center gap-3 flex-1 min-w-[220px]">
                <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider shrink-0">Width</span>
                <Slider
                  value={[playerWidth]}
                  min={48}
                  max={78}
                  step={1}
                  onValueChange={([value]) => setPlayerWidth(value)}
                  className="flex-1"
                />
                <span className="text-[10px] font-mono text-muted-foreground w-10 text-right">{playerWidth}%</span>
              </label>
            </div>
            {/* Video timeline scrubber */}
            {videoDuration > 0 && (
              <div className="space-y-1">
                <div
                  className="relative h-3 bg-muted rounded-full cursor-pointer group"
                  onClick={handleTimelineScrub}
                >
                  <div
                    className="absolute inset-y-0 left-0 bg-primary rounded-full transition-none"
                    style={{ width: `${((videoRef.current?.currentTime || 0) / videoDuration) * 100}%` }}
                  />
                  <div
                    className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white border-2 border-primary rounded-full shadow -translate-x-1/2"
                    style={{ left: `${((videoRef.current?.currentTime || 0) / videoDuration) * 100}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-muted-foreground px-0.5">
                  <span>{fmtMmSs(videoRef.current?.currentTime || 0)}</span>
                  <span>{fmtMmSs(videoDuration)}</span>
                </div>
              </div>
            )}

            {/* Playback controls */}
            <div className="flex items-center gap-2">
              <button onClick={() => stepFrames(-10)} className="p-1.5 rounded-lg bg-muted hover:bg-muted/70 transition-colors" title="-10s">
                <SkipBack className="w-4 h-4" />
              </button>
              <button onClick={() => stepFrames(-5)} className="p-1.5 rounded-lg bg-muted hover:bg-muted/70 transition-colors" title="-5s">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button onClick={togglePlay} className="flex-1 flex items-center justify-center gap-2 h-9 rounded-lg bg-primary text-primary-foreground font-medium text-sm transition-colors hover:bg-primary/90">
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                {isPlaying ? "Pause" : "Play"}
              </button>
              <button onClick={() => stepFrames(5)} className="p-1.5 rounded-lg bg-muted hover:bg-muted/70 transition-colors" title="+5s">
                <ChevronRight className="w-4 h-4" />
              </button>
              <button onClick={() => stepFrames(10)} className="p-1.5 rounded-lg bg-muted hover:bg-muted/70 transition-colors" title="+10s">
                <SkipForward className="w-4 h-4" />
              </button>
            </div>

            {/* Playback speed */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider shrink-0">Speed:</span>
              {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={`text-[10px] px-1.5 py-0.5 rounded font-medium transition-colors ${playbackSpeed === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
                >
                  {s}×
                </button>
              ))}
            </div>

            <button
              onClick={startAddAtPlayhead}
              className="w-full flex items-center justify-center gap-2 h-10 rounded-xl bg-primary/10 text-primary font-semibold text-sm hover:bg-primary/20 transition-colors border border-primary/20"
            >
              <Plus className="w-4 h-4" /> Add Event at {fmtMmSs(playheadS)} <span className="text-[9px] font-normal opacity-60 ml-1">(or press S)</span>
            </button>

            {/* Video offset alignment */}
            <div className="flex items-center gap-2 bg-muted/50 rounded-lg px-3 py-2">
              <span className="text-xs text-muted-foreground shrink-0">Video offset ({recordLabel} start align):</span>
              <input
                type="number"
                value={videoOffset}
                onChange={(e) => setVideoOffset(Number(e.target.value) || 0)}
                onBlur={persistVideoOffset}
                className="w-20 text-xs font-mono text-center bg-background border border-border rounded px-2 py-1 h-7"
                step="0.1"
              />
              <span className="text-xs text-muted-foreground">s</span>
              <span className="text-xs text-muted-foreground ml-auto">Video 0:00 = {isExploration ? "Exploration" : "Session"} {fmtSignedMmSs(videoOffset)}</span>
            </div>
          </div>
        ) : (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full h-32 rounded-xl border-2 border-dashed border-border flex flex-col items-center justify-center gap-2 text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors"
          >
            <Video className="w-8 h-8" />
            <span className="text-sm font-medium">Load composite / picture-in-picture video</span>
            <span className="text-xs">Or use the feed slots above for separate synchronized angles</span>
          </button>
        )}
          </div>

          {showSidebar && (
            <div
              onMouseDown={handleWidthDragStart}
              className="hidden xl:flex self-stretch w-3 cursor-ew-resize items-center justify-center group"
              title="Drag to resize player and sidebar"
            >
              <div className="h-24 w-1 rounded-full bg-border group-hover:bg-primary transition-colors" />
            </div>
          )}

          {/* HR Timeline + event context */}
          {showSidebar && (
            <aside
              className="w-full xl:min-w-[320px] xl:max-w-[560px] shrink-0 space-y-4 xl:sticky xl:top-4 xl:self-start xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto"
              style={{ flex: `1 1 ${100 - playerWidth}%` }}
            >
            {events.length > 0 && (
              <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Event Note Filters</p>
                  <button
                    type="button"
                    onClick={() => setSelectedEventFilters([])}
                    className="text-[10px] font-medium text-primary hover:underline"
                  >
                    Clear all
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {EVENT_FILTERS.map((filter) => {
                    const active = selectedEventFilters.includes(filter.key);
                    return (
                      <button
                        key={filter.key}
                        type="button"
                        onClick={() => setSelectedEventFilters((current) => (
                          current.includes(filter.key)
                            ? current.filter((key) => key !== filter.key)
                            : [...current, filter.key]
                        ))}
                        className={`rounded-full border px-2 py-1 text-[10px] font-medium transition-colors ${active ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
                      >
                        {filter.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {selectedEventFilters.length ? `${visibleEvents.length} of ${events.length} notes visible. Multiple filters combine.` : `Showing all ${events.length} notes.`}
                </p>
              </div>
            )}
            {/* HR Timeline */}
            {chartData.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">HR Timeline — click to seek</p>
                <div className="flex items-center gap-1 mb-1.5 flex-wrap">
                  <span className="text-[9px] text-muted-foreground">Zoom:</span>
                  {[30, 60, 120, 300].map((w) => (
                    <button
                      key={w}
                      onClick={() => setZoomWindow(w)}
                      className={`text-[9px] px-2 py-0.5 rounded font-medium transition-colors ${zoomWindow === w ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
                    >
                      {w < 60 ? `${w}s` : `${w / 60}m`}
                    </button>
                  ))}
                </div>
                <div className="h-48 cursor-pointer">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={visibleChartData}
                      margin={{ top: 8, right: 4, bottom: 0, left: -20 }}
                      onClick={handleChartClick}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                      <XAxis
                        dataKey="t"
                        type="number"
                        domain={xDomain}
                        tick={{ fontSize: 9 }}
                        tickFormatter={fmtMmSs}
                        tickCount={8}
                        allowDataOverflow
                      />
                      <YAxis tick={{ fontSize: 9 }} domain={["auto", "auto"]} />
                      <Tooltip
                        formatter={(val) => [`${val} bpm`, "HR"]}
                        labelFormatter={(v) => fmtMmSs(Math.round(Number(v)))}
                        contentStyle={{ fontSize: 11 }}
                      />

                      {/* Phase markers */}
                      {!isExploration && PHASE_LINES.map(({ key, label, color }) =>
                        session[key] != null ? (
                          <ReferenceLine key={key} x={session[key]} stroke={color} strokeWidth={1.5}
                            strokeDasharray="4 2"
                            label={{ value: label, fontSize: 7, fill: color, position: "top" }}
                          />
                        ) : null
                      )}

                      {/* Event markers */}
                      {visibleEventEntries.map(({ ev, i }) => {
                        const color = EVENT_COLORS[i % EVENT_COLORS.length];
                        return (
                          <ReferenceLine key={i} x={ev.time_s} stroke={color} strokeWidth={1.5}
                            strokeDasharray="2 3"
                            label={{ value: `E${i + 1}`, fontSize: 7, fill: color, position: "insideTopLeft" }}
                          />
                        );
                      })}

                      {/* Live playhead */}
                      <ReferenceLine
                        x={playheadS}
                        stroke="hsl(var(--foreground))"
                        strokeWidth={2}
                        label={{ value: "▶", fontSize: 10, fill: "hsl(var(--foreground))", position: "top" }}
                      />

                      <Line
                        type="monotone"
                        dataKey="hr"
                        stroke="hsl(var(--primary))"
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {savedMotionSummary && (
              <>
                {motionEvidence?.hasSavedTelemetry && !motionEvidence?.hasPromotedEvents && (
                  <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                    Motion telemetry is saved for this session, but no reviewed motion candidates have been promoted to timeline events. The Movement and Context filters show promoted event notes only.
                  </div>
                )}
                <MotionPlaybackReadout
                  summary={savedMotionSummary}
                  playbackTime={playheadS}
                  currentHR={currentHR}
                />
                <SavedMotionSummaryCard
                  summary={savedMotionSummary}
                  onSeek={videoSrc ? seekToMotionPeak : undefined}
                  playbackTime={playheadS}
                  chartOnly
                  focus
                />
                <ClimaxMotionSnapshotCard session={session} compact />
              </>
            )}

            {/* Nearby Events */}
            {visibleEvents.length > 0 && (() => {
              const nearby = visibleEventEntries
                .map(({ ev, i }) => ({ ev, i, dist: Math.abs(ev.time_s - playheadS) }))
                .filter(({ dist }) => dist <= 60)
                .sort((a, b) => a.dist - b.dist);
              if (!nearby.length) return null;
              return (
                <div className="space-y-1.5 border-t border-border pt-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Nearby (±60s)</p>
                  {nearby.map(({ ev, i, dist }) => {
                    const color = EVENT_COLORS[i % EVENT_COLORS.length];
                    const cats = normalizeCategoryArray(ev.category);
                    const annotationTags = getAnnotationTags(ev);
                    const aiGenerated = isAIGeneratedAnnotation(ev);
                    const isCurrent = dist < 5;
                    return (
                      <button
                        key={i}
                        onClick={() => seekToEvent(ev, i)}
                        className="w-full text-left flex items-start gap-2 rounded-lg px-2 py-1.5 transition-all text-xs"
                        style={{
                          background: isCurrent ? color + "30" : color + "18",
                          borderLeft: `3px solid ${color}`,
                          outline: isCurrent ? `1px solid ${color}66` : "none",
                        }}
                      >
                        <span className="font-mono text-[9px] font-bold shrink-0 mt-0.5" style={{ color }}>
                          {fmtMmSs(ev.time_s)}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap gap-1 mb-0.5">
                            {cats.map((c) => {
                              const meta = getCategoryMeta(c);
                              return (
                                <span key={c} className="text-[7px] px-0.5 rounded-full font-medium"
                                  style={{ background: meta.color + "22", color: meta.color, border: `0.5px solid ${meta.color}44` }}>
                                  {meta.label}
                                </span>
                              );
                            })}
                            {ev.source === "motion_derived" && <MotionDerivedBadge event={ev} />}
                            {aiGenerated && <AIGeneratedBadge />}
                          </div>
                          {annotationTags.length > 0 && (
                            <div className="mb-0.5 flex flex-wrap gap-0.5">
                              {annotationTags.map((tag) => <AnnotationTagPill key={tag} value={tag} />)}
                            </div>
                          )}
                          <span className="text-[10px] text-foreground leading-tight line-clamp-2">{ev.note}</span>
                        </div>
                        <span className="text-[8px] font-mono text-muted-foreground shrink-0 mt-0.5">
                          {dist < 1 ? "now" : `${Math.round(dist)}s`}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })()}

            {/* Most Recent Events */}
            {visibleEvents.length > 0 && (() => {
              const past = visibleEventEntries
                .map(({ ev, i }) => ({ ev, i, diff: playheadS - ev.time_s }))
                .filter(({ diff }) => diff >= 0)
                .sort((a, b) => a.diff - b.diff)
                .slice(0, 3);
              if (!past.length) return null;
              return (
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Most Recent</p>
                  {past.map(({ ev, i, diff }) => {
                    const color = EVENT_COLORS[i % EVENT_COLORS.length];
                    const cats = normalizeCategoryArray(ev.category);
                    const annotationTags = getAnnotationTags(ev);
                    const aiGenerated = isAIGeneratedAnnotation(ev);
                    const isCurrent = diff < 5;
                    return (
                      <button
                        key={i}
                        onClick={() => seekToEvent(ev, i)}
                        className="w-full text-left flex flex-col gap-1 rounded-lg px-3 py-2 transition-all text-sm"
                        style={{
                          background: isCurrent ? color + "30" : color + "1a",
                          borderLeft: `3px solid ${color}`,
                          outline: isCurrent ? `1px solid ${color}66` : "none",
                        }}
                      >
                        <span className="font-mono text-[10px] font-bold" style={{ color }}>
                          {fmtMmSs(ev.time_s)}
                        </span>
                        <div className="flex flex-wrap gap-1 mb-0.5">
                          {cats.map((c) => {
                            const meta = getCategoryMeta(c);
                            return (
                              <span key={c} className="text-[8px] px-1 rounded-full font-medium"
                                style={{ background: meta.color + "22", color: meta.color, border: `1px solid ${meta.color}44` }}>
                                {meta.label}
                              </span>
                            );
                          })}
                          {ev.source === "motion_derived" && <MotionDerivedBadge event={ev} />}
                          {aiGenerated && <AIGeneratedBadge />}
                        </div>
                        {annotationTags.length > 0 && (
                          <div className="flex flex-wrap gap-0.5">
                            {annotationTags.map((tag) => <AnnotationTagPill key={tag} value={tag} />)}
                          </div>
                        )}
                        <span className="text-xs text-foreground leading-tight">{ev.note}</span>
                        <span className="text-[9px] font-mono text-muted-foreground">
                          {diff < 1 ? "now" : `${Math.round(diff)}s ago`}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })()}
            </aside>
          )}
        </div>

        {/* Playhead status bar */}
        <div className="flex items-center gap-3 bg-muted/40 rounded-lg px-3 py-2">
          <span className="font-mono text-sm font-bold text-primary">{fmtMmSs(playheadS)}</span>
          <span className="text-xs text-muted-foreground">{recordLabel} time</span>
          {currentHR != null && (
            <>
              <div className="w-px h-4 bg-border" />
              <span className="font-mono text-sm font-bold text-chart-3">{currentHR} bpm</span>
            </>
          )}
        </div>

        {/* All event notes — full list */}
        {events.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Visible Events ({visibleEvents.length}/{events.length}) — nearby highlighted
            </p>
            {[...visibleEventEntries].reverse().map(({ ev, i }) => {
              const color = EVENT_COLORS[i % EVENT_COLORS.length];
              const cats = normalizeCategoryArray(ev.category);
              const annotationTags = getAnnotationTags(ev);
              const aiGenerated = isAIGeneratedAnnotation(ev);
              const dist = Math.abs(ev.time_s - playheadS);
              const isNearby = dist <= 30;
              const isCurrent = dist < 5;
              const isActive = activeEventIdx === i;
              const isEditing = editingIdx === i;

              if (isEditing) {
                return (
                  <div key={i} className="rounded-lg px-3 py-2.5 space-y-2"
                    style={{ background: color + "18", borderLeft: `3px solid ${color}` }}>
                    <div className="flex items-center gap-2">
                      <input type="number" min={0} value={editMin} onChange={(e) => setEditMin(e.target.value)}
                        className="w-14 text-xs font-mono text-center bg-background border border-border rounded px-2 py-1" />
                      <span className="text-muted-foreground font-bold">:</span>
                      <input type="number" min={0} max={59} value={editSec} onChange={(e) => setEditSec(e.target.value)}
                        className="w-14 text-xs font-mono text-center bg-background border border-border rounded px-2 py-1" />
                    </div>
                    <CategorySelector selected={editCats} onChange={setEditCats} categories={categoryOptions} />
                    <textarea
                      value={editNote}
                      onChange={(e) => setEditNote(e.target.value)}
                      rows={2}
                      className="w-full text-xs bg-background border border-border rounded px-2 py-1.5 resize-none"
                    />
                    <div className="flex gap-2">
                      <button onClick={commitEdit} className="flex items-center gap-1 text-[10px] px-3 py-1 rounded-lg bg-primary text-primary-foreground font-medium">
                        <Check className="w-3 h-3" /> Save
                      </button>
                      <button onClick={cancelEdit} className="flex items-center gap-1 text-[10px] px-3 py-1 rounded-lg bg-muted text-muted-foreground font-medium">
                        <X className="w-3 h-3" /> Cancel
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={i}
                  className="w-full text-left flex items-start gap-2 rounded-lg px-3 py-2 transition-all"
                  style={{
                    background: isActive || isCurrent ? color + "28" : isNearby ? color + "18" : color + "08",
                    borderLeft: `3px solid ${isNearby ? color : color + "55"}`,
                    outline: isCurrent ? `1px solid ${color}66` : "none",
                    opacity: isNearby ? 1 : 0.55,
                  }}
                >
                  <button onClick={() => seekToEvent(ev, i)} className="font-mono text-[11px] font-bold shrink-0 mt-0.5" style={{ color: isNearby ? color : color + "99" }}>
                    {fmtMmSs(ev.time_s)}
                  </button>
                  <button onClick={() => seekToEvent(ev, i)} className="flex-1 min-w-0 text-left">
                    <div className="flex flex-wrap gap-1 mb-0.5">
                      {cats.map((c) => {
                        const meta = getCategoryMeta(c);
                        return (
                          <span key={c} className="text-[9px] px-1.5 rounded-full font-medium"
                            style={{ background: meta.color + "22", color: meta.color, border: `1px solid ${meta.color}44` }}>
                            {meta.label}
                          </span>
                        );
                      })}
                      {ev.source === "motion_derived" && <MotionDerivedBadge event={ev} />}
                      {aiGenerated && <AIGeneratedBadge />}
                    </div>
                    {annotationTags.length > 0 && (
                      <div className="mb-0.5 flex flex-wrap gap-0.5">
                        {annotationTags.map((tag) => <AnnotationTagPill key={tag} value={tag} />)}
                      </div>
                    )}
                    <span className="text-xs text-foreground leading-snug">{ev.note}</span>
                  </button>
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <div className="flex items-center gap-1">
                      <button onClick={() => startEdit(ev, i)} className="text-muted-foreground hover:text-primary transition-colors p-0.5">
                        <Pencil className="w-3 h-3" />
                      </button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <button type="button" className="text-muted-foreground hover:text-destructive transition-colors p-0.5" aria-label={`Delete event annotation at ${fmtMmSs(ev.time_s)}`}>
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete this event annotation?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This removes the note at {fmtMmSs(ev.time_s)} from the synchronized timeline. This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => deleteEvent(i)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                              Delete annotation
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {dist < 1 ? "now" : isNearby ? `${Math.round(dist)}s ${ev.time_s < playheadS ? "ago" : "ahead"}` : fmtMmSs(ev.time_s)}
                    </span>
                    {nearestHR(chartData, ev.time_s) != null && (
                      <span className="text-[10px] font-mono font-bold text-primary/70">{nearestHR(chartData, ev.time_s)} bpm</span>
                    )}
                  </div>
                </div>
              );
            })}
            {visibleEventEntries.length === 0 && (
              <p className="rounded-lg border border-border bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
                No event notes match the selected filters.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
