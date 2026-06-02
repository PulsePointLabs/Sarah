import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronUp, Clapperboard, Loader2, Play, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { buildSessionVideoPassDigest, normalizeSessionVideoPassFindings } from "@/lib/visualEvidence";

function fmtMmSs(totalSeconds) {
  const v = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const m = Math.floor(v / 60);
  const s = v % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function estimateSessionEnd(session, timelineRows = []) {
  const candidates = [
    session?.duration_s,
    session?.duration_seconds,
    session?.recording_duration_s,
    session?.end_offset_s,
    session?.recovery_offset_s ? Number(session.recovery_offset_s) + 120 : null,
    session?.climax_offset_s ? Number(session.climax_offset_s) + 180 : null,
    ...timelineRows.map((row) => row.time_offset_s),
    ...(session?.event_timeline || []).map((event) => event.time_s),
  ].map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length ? Math.max(...candidates) : 600;
}

function candidateWindows(session, timelineRows, count = 6, clipSeconds = 24) {
  const end = estimateSessionEnd(session, timelineRows);
  const anchors = [];
  [
    session?.pre_climax_offset_s,
    session?.climax_offset_s,
    session?.recovery_offset_s,
  ].map(Number).filter((value) => Number.isFinite(value) && value > 0).forEach((value) => anchors.push(value));

  (session?.event_timeline || [])
    .filter((event) => String(event?.note || "").trim())
    .slice()
    .sort((a, b) => Number(a.time_s || 0) - Number(b.time_s || 0))
    .forEach((event) => {
      const note = String(event.note || "").toLowerCase();
      if (/(climax|ejac|orgasm|pause|resume|stroke|stimulation|foley|feet|foot|toe|heel|erection|recovery|bracing)/.test(note)) {
        anchors.push(Number(event.time_s));
      }
    });

  if (anchors.length < count) {
    const spacing = end / (count + 1);
    for (let i = 1; i <= count; i += 1) anchors.push(spacing * i);
  }

  const used = [];
  return anchors
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b)
    .map((anchor) => {
      const start = clamp(anchor - clipSeconds / 2, 0, Math.max(0, end - clipSeconds));
      return { start, end: Math.min(end, start + clipSeconds) };
    })
    .filter((window) => {
      const key = Math.round(window.start / 10);
      if (used.includes(key)) return false;
      used.push(key);
      return true;
    })
    .slice(0, count);
}

function sequentialWindows(startSeconds, session, timelineRows, count = 6, clipSeconds = 24) {
  const sessionEnd = estimateSessionEnd(session, timelineRows);
  const windows = [];
  let cursor = clamp(Number(startSeconds) || 0, 0, Math.max(0, sessionEnd - 0.25));
  for (let i = 0; i < count && cursor < sessionEnd; i += 1) {
    const end = Math.min(sessionEnd, cursor + clipSeconds);
    windows.push({ start: cursor, end });
    cursor = end;
  }
  return windows;
}

function nearestTelemetrySummary(timelineRows, start, end) {
  const rows = timelineRows.filter((row) => {
    const t = Number(row.time_offset_s);
    return Number.isFinite(t) && t >= start && t <= end;
  });
  if (!rows.length) return "No heart-rate samples in this window.";
  const hrs = rows.map((row) => Number(row.hr ?? row.heart_rate)).filter((value) => Number.isFinite(value));
  if (!hrs.length) return `${rows.length} telemetry samples, but no parsed BPM values.`;
  const min = Math.round(Math.min(...hrs));
  const max = Math.round(Math.max(...hrs));
  const avg = Math.round(hrs.reduce((sum, value) => sum + value, 0) / hrs.length);
  return `${rows.length} telemetry samples; HR avg ${avg} BPM, range ${min}-${max} BPM.`;
}

function normalizeAIResult(raw, fallbackWindow) {
  const value = typeof raw === "string" ? null : raw;
  const findings = Array.isArray(value?.findings) && value.findings.length
    ? value.findings
    : [{
      title: "Video window review",
      text: typeof raw === "string" ? raw.trim() : "Sarah reviewed this window but did not return separate findings.",
      confidence: "moderate",
      category: "other",
    }];
  const events = Array.isArray(value?.events) ? value.events : [];
  return {
    summary: value?.summary || findings[0]?.text || "Review complete.",
    findings: findings.map((finding) => ({
      title: finding.title || "Finding",
      text: finding.text || finding.findingText || "",
      confidence: finding.confidence || "moderate",
      category: finding.category || "other",
    })).filter((finding) => finding.text),
    events: events.map((event) => ({
      time_s: Number.isFinite(Number(event.time_s)) ? Number(event.time_s) : fallbackWindow.start,
      note: event.note || event.text || "",
      category: Array.isArray(event.category) ? event.category : [event.category || "other"],
      annotation_tags: Array.isArray(event.annotation_tags) ? event.annotation_tags : ["other_context"],
      confidence: event.confidence || "moderate",
    })).filter((event) => event.note),
  };
}

function normalizeEventCategories(categories = []) {
  const allowed = new Set(["stimulation", "stimulation_started", "stimulation_paused", "stimulation_resumed", "stimulation_stopped", "motion_pause", "motion_resume", "movement_observed", "sensation", "physical", "other"]);
  const mapped = categories.map((category) => {
    if (category === "movement") return "movement_observed";
    if (category === "physiology") return "physical";
    if (category === "environment" || category === "equipment") return "other";
    return category;
  }).filter((category) => allowed.has(category));
  return mapped.length ? [...new Set(mapped)] : ["other"];
}

function eventFromCard(card, event, index) {
  return {
    time_s: Number(event.time_s || card.window.start),
    note: event.note,
    category: normalizeEventCategories(event.category),
    source: "ai_video_pass",
    annotation_tags: event.annotation_tags?.length ? event.annotation_tags : ["other_context"],
    ai_annotation: {
      source: "sarah_video_pass",
      confidence: event.confidence || card.confidence || "moderate",
      clip_url: card.clipUrl,
      clip_start_s: card.window.start,
      clip_end_s: card.window.end,
      source_video: card.sourceVideo?.filename || card.sourceVideo?.label || "",
    },
    video_clip: {
      url: card.clipUrl,
      start_s: card.window.start,
      end_s: card.window.end,
      label: card.label,
    },
    title: `${card.label} finding ${index + 1}`,
  };
}

function persistedCardFrom(card) {
  return {
    id: card.id,
    saved_at: new Date().toISOString(),
    label: card.label,
    source: "ai_video_pass",
    source_video: {
      id: card.sourceVideo?.id || null,
      label: card.sourceVideo?.label || "",
      filename: card.sourceVideo?.filename || "",
      fingerprint: card.sourceVideo?.fingerprint || "",
    },
    clip: {
      url: card.clipUrl,
      thumbnail_url: card.thumbnailUrl || "",
      start_s: card.window.start,
      end_s: card.window.end,
      duration_s: Number((card.window.end - card.window.start).toFixed(2)),
    },
    summary: card.summary,
    findings: card.findings,
    draft_events: card.events,
    telemetry: card.telemetry,
    motion_summary: card.motionSummary || null,
  };
}

function compactVideoPassFlow(entries = []) {
  return normalizeSessionVideoPassFindings(entries).map((entry) => ({
    id: entry.id,
    label: entry.label,
    source_video: entry.source_video,
    clip: entry.clip,
    summary: entry.summary,
    findings: entry.findings.slice(0, 6),
    draft_events: entry.draft_events.slice(0, 5),
    telemetry: entry.telemetry,
    saved_at: entry.saved_at,
  }));
}

export default function AIVideoPassPanel({
  session,
  timelineRows = [],
  linkedLocalVideos = [],
  onSessionUpdate,
}) {
  const availableVideos = useMemo(() => linkedLocalVideos.filter((video) => video?.path && video.exists !== false), [linkedLocalVideos]);
  const [selectedPath, setSelectedPath] = useState(availableVideos[0]?.path || "");
  const [clipSeconds, setClipSeconds] = useState(24);
  const [windowCount, setWindowCount] = useState(5);
  const [scanMode, setScanMode] = useState("smart");
  const [scanCursor, setScanCursor] = useState(0);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [cards, setCards] = useState([]);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState({});
  const [acceptedIds, setAcceptedIds] = useState(new Set());

  const selectedVideo = availableVideos.find((video) => video.path === selectedPath) || availableVideos[0];
  const sessionEnd = useMemo(() => estimateSessionEnd(session, timelineRows), [session, timelineRows]);
  const plannedWindows = useMemo(
    () => scanMode === "continue"
      ? sequentialWindows(scanCursor, session, timelineRows, windowCount, clipSeconds)
      : candidateWindows(session, timelineRows, windowCount, clipSeconds),
    [scanMode, scanCursor, session, timelineRows, windowCount, clipSeconds],
  );

  const resetScanCursor = () => {
    setScanCursor(0);
    setStatus("");
  };

  useEffect(() => {
    setScanCursor(0);
  }, [selectedVideo?.path]);

  const runPass = async () => {
    if (!selectedVideo?.path || running) return;
    setRunning(true);
    setError("");
    setCards([]);
    setAcceptedIds(new Set());
    try {
      const nextCards = [];
      for (let i = 0; i < plannedWindows.length; i += 1) {
        const window = plannedWindows[i];
        const label = `AI video pass ${fmtMmSs(window.start)}-${fmtMmSs(window.end)}`;
        setStatus(`Preparing ${label}`);
        const preview = await base44.integrations.Core.ProcessLocalVideoClip({
          path: selectedVideo.path,
          startSeconds: window.start,
          endSeconds: window.end,
          label,
          frameCount: 10,
        });
        const telemetry = nearestTelemetrySummary(timelineRows, window.start, window.end);
        setStatus(`Sarah reviewing ${label}`);
        const images = (preview.frames || []).map((frame) => ({
          filename: frame.filename,
          media_type: frame.mimeType || "image/jpeg",
          data: frame.data,
        }));
        const ai = await base44.integrations.Core.InvokeLLM({
          max_tokens: 1800,
          response_json_schema: {
            type: "object",
            properties: {
              summary: { type: "string" },
              findings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    text: { type: "string" },
                    category: { type: "string", enum: ["stimulation", "physiology", "physical", "movement", "environment", "equipment", "other"] },
                    confidence: { type: "string", enum: ["low", "moderate", "high"] },
                  },
                  required: ["title", "text", "category", "confidence"],
                },
              },
              events: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    time_s: { type: "number" },
                    note: { type: "string" },
                    category: {
                      type: "array",
                      items: {
                        type: "string",
                        enum: ["stimulation", "stimulation_started", "stimulation_paused", "stimulation_resumed", "stimulation_stopped", "motion_pause", "motion_resume", "movement_observed", "sensation", "physical", "other"],
                      },
                    },
                    annotation_tags: { type: "array", items: { type: "string" } },
                    confidence: { type: "string", enum: ["low", "moderate", "high"] },
                  },
                  required: ["time_s", "note", "category", "annotation_tags", "confidence"],
                },
              },
            },
            required: ["summary", "findings", "events"],
          },
          images,
          prompt: `You are Sarah, reviewing sampled frames from a linked local session video. Analyze only what is visible or supported by telemetry/context. Do not infer intent, pressure, force, coverings, gloves, lubricant, device fit, sensation, or cause beyond visible evidence. If a hand or object is partially blurred, occluded, bright, or low-detail, describe it neutrally as visible contact/hand position rather than naming gloves or materials.

Visible tools and materials matter when supported: identify lubrication bottles or lubricant application only when a bottle, gel/fluid, hand motion, shine, or user/session context makes that reasonably clear. Identify devices such as a silicone sleeve, Foley catheter, e-stim/TENS leads, pump, towel, table, or camera/monitor setup when visible or strongly supported by session context. If uncertain, say "possible" and mark confidence low or moderate. Write findings in direct second person using "you" and "your".

Session window: ${fmtMmSs(window.start)} to ${fmtMmSs(window.end)} (${window.start.toFixed(1)}s-${window.end.toFixed(1)}s).
Telemetry in this window: ${telemetry}
Session methods/devices/context: ${[
  ...(session?.methods || []),
  session?.sleeve_type ? `Sleeve: ${session.sleeve_type}` : null,
  session?.foley_type ? `Foley: ${session.foley_type}` : null,
  session?.tens_placement ? `TENS placement: ${session.tens_placement}` : null,
  session?.estim_notes ? `E-stim notes: ${session.estim_notes}` : null,
].filter(Boolean).join(" | ") || "No specific device context listed."}
Nearby session events: ${(session?.event_timeline || [])
  .filter((event) => Math.abs(Number(event.time_s || 0) - ((window.start + window.end) / 2)) <= 75)
  .map((event) => `[${fmtMmSs(event.time_s)}] ${event.note}`)
  .join(" | ") || "None nearby."}

Return concise visual findings and 1-3 proposed timeline events. Good targets are stimulation technique shifts, lubrication or device-use moments, pauses/resumes, erection or physical-state changes, body/feet bracing, telemetry-visible physiological changes, device/position changes, and important environment/setup context. Use low confidence or omit the finding when the evidence is ambiguous.`,
        });
        const normalized = normalizeAIResult(ai, window);
        const card = {
          id: `${Date.now()}-${i}`,
          label,
          window,
          sourceVideo: selectedVideo,
          clipUrl: preview.clip_url || preview.url,
          thumbnailUrl: preview.frames?.[0]?.url || "",
          motionSummary: preview.motion_summary,
          telemetry,
          ...normalized,
        };
        nextCards.push(card);
        setCards([...nextCards]);
      }
      if (scanMode === "continue" && nextCards.length) {
        setScanCursor(nextCards[nextCards.length - 1].window.end);
      }
      setStatus(`Review complete: ${nextCards.length} windows ready.`);
    } catch (err) {
      setError(err?.data?.error || err?.message || "AI video pass failed.");
      setStatus("");
    } finally {
      setRunning(false);
    }
  };

  const acceptEvents = async (card, eventIndexes = null) => {
    const selectedEvents = eventIndexes
      ? card.events.filter((_, index) => eventIndexes.includes(index))
      : card.events;
    if (!selectedEvents.length && !card.findings.length) return;
    const nextEvents = [
      ...(session?.event_timeline || []),
      ...selectedEvents.map((event, index) => eventFromCard(card, event, index)),
    ].sort((a, b) => Number(a.time_s || 0) - Number(b.time_s || 0));
    const existingAnalysis = session?.ai_analysis || {};
    const existingVideoPassFindings = Array.isArray(existingAnalysis._video_pass_findings)
      ? existingAnalysis._video_pass_findings
      : [];
    const persistedCard = persistedCardFrom(card);
    const nextVideoPassFindings = [
      persistedCard,
      ...existingVideoPassFindings.filter((item) => item?.id !== persistedCard.id),
    ].slice(0, 80);
    const nextAnalysisBase = {
      ...existingAnalysis,
      _video_pass_findings: nextVideoPassFindings,
      _video_pass_findings_updated_at: persistedCard.saved_at,
      _video_pass_detail_flow: compactVideoPassFlow(nextVideoPassFindings),
    };
    const nextAnalysis = {
      ...nextAnalysisBase,
      _video_pass_digest: buildSessionVideoPassDigest({ ai_analysis: nextAnalysisBase }),
    };
    const updated = await base44.entities.Session.update(session.id, {
      event_timeline: nextEvents,
      ai_analysis: nextAnalysis,
    });
    onSessionUpdate?.({ ...session, ...updated, event_timeline: nextEvents, ai_analysis: nextAnalysis });
    setAcceptedIds((prev) => new Set([...prev, card.id]));
  };

  if (!availableVideos.length) {
    return (
      <div className="rounded-xl border border-border bg-muted/10 p-3 text-sm text-muted-foreground">
        Link a local original video first, then Sarah can scan candidate windows and build review cards.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-muted/10 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
            <Sparkles className="h-3.5 w-3.5" /> AI Video Pass
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Sarah scans candidate windows, creates short preview clips, and drafts timeline findings for review.
          </p>
        </div>
        <Button type="button" onClick={runPass} disabled={running || !selectedVideo || !plannedWindows.length} className="h-8">
          {running ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Clapperboard className="mr-2 h-3.5 w-3.5" />}
          {scanMode === "continue" ? (scanCursor > 0 ? "Run Next Pass" : "Start at 0:00") : "Run Pass"}
        </Button>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto_auto_auto]">
        <select
          value={selectedVideo?.path || selectedPath}
          onChange={(event) => setSelectedPath(event.target.value)}
          className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
        >
          {availableVideos.map((video) => (
            <option key={video.path} value={video.path}>{video.label || video.filename || video.path}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs text-muted-foreground">
          Mode
          <select
            value={scanMode}
            onChange={(event) => setScanMode(event.target.value)}
            className="bg-transparent text-foreground outline-none"
          >
            <option value="smart">Smart windows</option>
            <option value="continue">Continue forward</option>
          </select>
        </label>
        <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs text-muted-foreground">
          Windows
          <input
            type="number"
            min="1"
            max="8"
            value={windowCount}
            onChange={(event) => setWindowCount(clamp(Number(event.target.value) || 1, 1, 8))}
            className="w-12 bg-transparent text-foreground outline-none"
          />
        </label>
        <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs text-muted-foreground">
          Seconds
          <input
            type="number"
            min="8"
            max="30"
            value={clipSeconds}
            onChange={(event) => setClipSeconds(clamp(Number(event.target.value) || 24, 8, 30))}
            className="w-12 bg-transparent text-foreground outline-none"
          />
        </label>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
        {scanMode === "continue" && (
          <button
            type="button"
            onClick={resetScanCursor}
            className="rounded-full border border-primary/25 bg-primary/10 px-2 py-1 font-semibold text-primary hover:bg-primary/15"
          >
            Cursor {fmtMmSs(scanCursor)} / {fmtMmSs(sessionEnd)} · reset to 0:00
          </button>
        )}
        {plannedWindows.map((window) => (
          <span key={`${window.start}-${window.end}`} className="rounded-full border border-border bg-card px-2 py-1">
            {fmtMmSs(window.start)}-{fmtMmSs(window.end)}
          </span>
        ))}
        {!plannedWindows.length && (
          <span className="rounded-full border border-border bg-card px-2 py-1">End reached</span>
        )}
      </div>

      {(status || error) && (
        <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${error ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-primary/20 bg-primary/10 text-primary"}`}>
          {error || status}
        </div>
      )}

      {cards.length > 0 && (
        <div className="mt-3 grid gap-3">
          {cards.map((card) => {
            const isExpanded = expanded[card.id];
            const accepted = acceptedIds.has(card.id);
            return (
              <article key={card.id} className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="grid gap-3 p-3 lg:grid-cols-[minmax(15rem,22rem)_1fr]">
                  <button
                    type="button"
                    onClick={() => setExpanded((prev) => ({ ...prev, [card.id]: !prev[card.id] }))}
                    className="group relative overflow-hidden rounded-lg border border-border bg-black text-left"
                  >
                    <video
                      src={card.clipUrl}
                      muted
                      playsInline
                      preload="metadata"
                      className={`w-full bg-black object-contain ${isExpanded ? "max-h-[28rem]" : "aspect-video"}`}
                      controls={isExpanded}
                    />
                    {!isExpanded && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/10 opacity-90 transition-opacity group-hover:opacity-100">
                        <span className="rounded-full bg-background/80 p-2 text-foreground shadow">
                          <Play className="h-5 w-5" />
                        </span>
                      </div>
                    )}
                  </button>
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h5 className="font-semibold text-foreground">{card.label}</h5>
                        <p className="text-xs text-muted-foreground">
                          {card.sourceVideo?.label || card.sourceVideo?.filename} · {fmtMmSs(card.window.start)} to {fmtMmSs(card.window.end)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setExpanded((prev) => ({ ...prev, [card.id]: !prev[card.id] }))}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        {isExpanded ? "Collapse" : "Expand clip"}
                      </button>
                    </div>
                    <p className="text-sm leading-relaxed text-foreground/90">{card.summary}</p>
                    <div className="space-y-1.5">
                      {card.findings.map((finding, index) => (
                        <div key={`${finding.title}-${index}`} className="rounded-lg border border-border bg-muted/20 px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold text-primary">{finding.title}</span>
                            <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">{finding.confidence}</span>
                          </div>
                          <p className="mt-1 text-sm leading-relaxed text-foreground/85">{finding.text}</p>
                        </div>
                      ))}
                    </div>
                    {card.events.length > 0 && (
                      <div className="rounded-lg border border-primary/20 bg-primary/5 p-2">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">Draft Video Sync Events</span>
                          <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => acceptEvents(card)} disabled={accepted}>
                            <Check className="mr-1 h-3.5 w-3.5" /> {accepted ? "Accepted" : "Accept All"}
                          </Button>
                        </div>
                        <div className="space-y-1">
                          {card.events.map((event, index) => (
                            <div key={`${event.time_s}-${index}`} className="flex items-start gap-2 rounded-md bg-background/60 px-2 py-1.5 text-xs">
                              <span className="font-mono font-bold text-primary">{fmtMmSs(event.time_s)}</span>
                              <span className="leading-relaxed text-foreground/85">{event.note}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <p className="text-[10px] text-muted-foreground">{card.telemetry}</p>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
