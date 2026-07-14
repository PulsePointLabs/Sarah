import { useState } from "react";
import { splitSentencesPreservingDecimals } from "@/utils/aiTextRepair";
import TTSReader from "./TTSReader";
import { serverUrl } from "@/lib/mobileApiBase";
import { videoPosterDataUrl } from "@/lib/videoPoster";

export function renderSentenceHighlightedText(text, activeSentenceIdx = -1, onSentenceClick) {
  const sentences = splitSentencesPreservingDecimals(text);
  return sentences.map((sentence, index) => (
    <span
      key={`${index}-${sentence.slice(0, 24)}`}
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        onSentenceClick?.(index);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onSentenceClick?.(index);
      }}
      className={`rounded-sm px-0.5 transition-colors ${activeSentenceIdx === index ? "bg-primary/20 text-foreground" : "hover:bg-muted/40"}`}
    >
      {sentence}{index < sentences.length - 1 ? " " : ""}
    </span>
  ));
}

function colorWithAlpha(color, alpha) {
  if (!color) return `hsl(var(--primary) / ${alpha})`;
  if (color.startsWith("hsl(var(")) return color.replace(/\)\)$/, `) / ${alpha})`);
  if (color.startsWith("hsl(") || color.startsWith("rgb(")) return color;
  if (color.startsWith("#")) {
    const clean = color.slice(1);
    if (clean.length === 3) {
      const expanded = clean.split("").map((char) => char + char).join("");
      return `#${expanded}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
    }
    if (clean.length === 6) return `${color}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
    return color;
  }
  return color;
}

function SectionHeader({ section }) {
  if (!section?.label && !section?.title) return null;
  return (
    <p
      className="mb-1.5 mt-4 flex w-full min-w-0 max-w-full items-center gap-1.5 border-t border-border pt-3 text-xs font-semibold uppercase tracking-wider"
      style={{ color: section.color || "hsl(var(--primary))" }}
    >
      {section.icon}{section.label || section.title}
    </p>
  );
}

function fmtMmSs(totalSeconds) {
  const value = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const m = Math.floor(value / 60);
  const s = value % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function clipFrameSrc(frame = {}) {
  if (frame?.data) return `data:${frame.mimeType || "image/jpeg"};base64,${frame.data}`;
  return serverUrl(frame?.url || frame?.file_url || "");
}

function stillMetricPill(label, value) {
  if (value == null || value === "") return null;
  return (
    <div key={label} className="rounded-full border border-border bg-background/80 px-3 py-1 text-[11px]">
      <span className="font-semibold text-primary">{label}</span>{" "}
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function StillMetricStrip({ telemetrySummary, dark = false }) {
  if (!telemetrySummary) return null;
  const hrRange = telemetrySummary.hrMin != null && telemetrySummary.hrMax != null
    ? `${telemetrySummary.hrMin}-${telemetrySummary.hrMax} bpm`
    : "";
  const emgValue = telemetrySummary.emgAvg != null
    ? `${telemetrySummary.emgLabel || "EMG"} ${telemetrySummary.emgAvg}`
    : "";
  const pills = [
    stillMetricPill("Window", telemetrySummary.windowLabel),
    stillMetricPill("HR AVG", telemetrySummary.hrAvg != null ? `${telemetrySummary.hrAvg} bpm` : ""),
    stillMetricPill("HR RANGE", hrRange),
    stillMetricPill("RMSSD", telemetrySummary.rmssdAvg != null ? `${telemetrySummary.rmssdAvg} ms` : ""),
    stillMetricPill("SDNN", telemetrySummary.sdnnAvg != null ? `${telemetrySummary.sdnnAvg} ms` : ""),
    stillMetricPill("HRV", telemetrySummary.hrvQuality),
    stillMetricPill("EMG", emgValue),
    stillMetricPill("Events", telemetrySummary.nearbyEventCount ? `${telemetrySummary.nearbyEventCount} nearby` : ""),
  ].filter(Boolean);
  if (!pills.length) return null;
  return (
    <div className={`mt-2 flex flex-wrap gap-2 ${dark ? "text-white" : ""}`}>
      {pills}
    </div>
  );
}

function InlineClipCard({ clip, onSelectStill }) {
  const hasVideo = Boolean(clip?.url || clip?.clip_url || clip?.file_url);
  const stills = Array.isArray(clip?.frames) ? clip.frames.filter((frame) => clipFrameSrc(frame)) : [];
  if (!hasVideo && !stills.length) return null;
  const src = serverUrl(clip.url || clip.clip_url || clip.file_url);
  const timestamp = [
    clip.session_time_s != null ? fmtMmSs(clip.session_time_s) : "",
    clip.startSeconds != null && clip.endSeconds != null ? `clip ${fmtMmSs(clip.startSeconds)}-${fmtMmSs(clip.endSeconds)}` : "",
  ].filter(Boolean).join(" · ");
  return (
    <div
      className="mt-2 overflow-hidden rounded-lg border border-primary/20 bg-background/80"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-primary/5 px-2.5 py-1.5 text-[10px]">
        <span className="font-semibold text-primary">{clip.label || "Key video moment"}</span>
        <span className="font-mono text-muted-foreground">
          {clip.session_time_s != null ? fmtMmSs(clip.session_time_s) : ""}
          {clip.startSeconds != null && clip.endSeconds != null ? ` · clip ${fmtMmSs(clip.startSeconds)}-${fmtMmSs(clip.endSeconds)}` : ""}
        </span>
      </div>
      {hasVideo && (
        <video
          src={src}
          poster={videoPosterDataUrl({
            title: clip.label || "Key video moment",
            subtitle: "Sarah session evidence clip",
            timestamp,
          })}
          controls
          preload="metadata"
          className="block w-full bg-black"
        />
      )}
      {clip.mediaCaption && (
        <p className="px-2.5 pt-2 text-xs leading-relaxed text-muted-foreground">{clip.mediaCaption}</p>
      )}
      <StillMetricStrip telemetrySummary={clip.telemetrySummary} />
      {stills.length > 0 && (
        <div className="mt-2 space-y-2 border-t border-border/70 px-2.5 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Key moment stills</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {stills.slice(0, 6).map((frame, index) => {
              const frameSrc = clipFrameSrc(frame);
              const caption = frame.caption || `${clip.label || "Key still"}${frame.sessionTimeLabel ? ` · ${frame.sessionTimeLabel}` : ""}`;
              return (
                <button
                  key={frame.id || `${clip.id || clip.label}-still-${index}`}
                  type="button"
                  onClick={() => onSelectStill?.({ clip, frame, frameIndex: index })}
                  className="overflow-hidden rounded-lg border border-border bg-background text-left transition-colors hover:border-primary/40"
                >
                  <img src={frameSrc} alt={caption} className="aspect-[4/3] w-full bg-black object-cover" loading="lazy" />
                  <div className="space-y-1 px-2 py-1.5">
                    <p className="line-clamp-2 text-[10px] font-medium text-foreground">{caption}</p>
                    {frame.detailCaption && (
                      <p className="line-clamp-2 text-[10px] text-muted-foreground">{frame.detailCaption}</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AIOutputReader({
  paragraphs,
  paragraphMeta = [],
  sessionId,
  title,
  sessionDate,
  sourceGeneratedAt,
  summaryColor = "hsl(var(--primary))",
}) {
  const safeParagraphs = (paragraphs || []).filter(Boolean);
  const [selectedStill, setSelectedStill] = useState(null);
  const selectedStillFrames = Array.isArray(selectedStill?.clip?.frames)
    ? selectedStill.clip.frames.filter((frame) => clipFrameSrc(frame))
    : [];
  const selectedStillIndex = selectedStill?.frameIndex ?? 0;
  const activeStill = selectedStillFrames[selectedStillIndex] || selectedStill?.frame || null;
  const activeStillSrc = clipFrameSrc(activeStill);

  return (
    <>
      <TTSReader
        sessionId={sessionId}
        title={title}
        sessionDate={sessionDate}
        sourceGeneratedAt={sourceGeneratedAt}
        paragraphs={safeParagraphs}
        renderParagraph={(text, idx, isActive, isBuffering, activeSentenceIdx, startFromSentence) => {
          const meta = paragraphMeta[idx] || {};
          const section = meta.sec || meta.section || meta;
          const isSummary = meta.type === "summary" || meta.type === "overview" || meta.type === "title" || idx === 0 && !section?.label;
          const color = section?.color || (isSummary ? summaryColor : "hsl(var(--primary))");
          const sectionKey = section?.key || section?.label || section?.title || `section-${idx}`;
          const firstSectionIndex = paragraphMeta.findIndex((item) => {
            const itemSection = item?.sec || item?.section || item;
            const itemKey = itemSection?.key || itemSection?.label || itemSection?.title;
            return (item.type === "section" || item.type === "phase" || item.type === "quality")
              && itemKey === sectionKey;
          });
          const isFirstInSection = !isSummary && firstSectionIndex === idx;

          if (isSummary) {
            return (
              <div
                className="ai-output-paragraph w-full min-w-0 max-w-full rounded-r-md border-l-2 py-1 pl-3 text-base font-medium leading-relaxed transition-all duration-200"
                style={{
                  borderColor: isActive ? color : colorWithAlpha(color, 0.5),
                  background: isActive ? colorWithAlpha(color, 0.12) : isBuffering ? colorWithAlpha(color, 0.07) : "transparent",
                  color: "hsl(var(--foreground))",
                }}
              >
                {isBuffering && (
                  <span className="mr-2 inline-block h-3 w-3 rounded-full border-2 border-t-transparent align-[-1px] animate-spin" style={{ borderColor: color, borderTopColor: "transparent" }} />
                )}
                {renderSentenceHighlightedText(text, activeSentenceIdx, startFromSentence)}
                {Array.isArray(meta.clips) && meta.clips.map((clip) => (
                  <InlineClipCard key={clip.id || clip.url || clip.clip_url} clip={clip} onSelectStill={setSelectedStill} />
                ))}
              </div>
            );
          }

          return (
            <div className="ai-output-paragraph-shell w-full min-w-0 max-w-full">
              {isFirstInSection && <SectionHeader section={section} />}
              <li
                className="ai-output-paragraph w-full min-w-0 max-w-full list-none rounded-r-md border-l-2 py-1.5 pl-3 text-sm leading-relaxed transition-all duration-200"
                style={{
                  borderColor: isActive ? color : colorWithAlpha(color, 0.45),
                  background: isActive ? colorWithAlpha(color, 0.1) : isBuffering ? colorWithAlpha(color, 0.06) : "transparent",
                  color: "hsl(var(--foreground))",
                }}
              >
                {isBuffering && (
                  <span className="mr-2 inline-block h-3 w-3 rounded-full border-2 border-t-transparent align-[-1px] animate-spin" style={{ borderColor: color, borderTopColor: "transparent" }} />
                )}
                {renderSentenceHighlightedText(text, activeSentenceIdx, startFromSentence)}
                {Array.isArray(meta.clips) && meta.clips.map((clip) => (
                  <InlineClipCard key={clip.id || clip.url || clip.clip_url} clip={clip} onSelectStill={setSelectedStill} />
                ))}
              </li>
            </div>
          );
        }}
      />
      {selectedStill && activeStill && activeStillSrc && (
        <div className="fixed inset-0 z-50 bg-black/85 p-3 sm:p-6" onClick={() => setSelectedStill(null)}>
          <div
            className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-background shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{activeStill.caption || selectedStill.clip?.label || "Key moment still"}</p>
                {activeStill.detailCaption && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{activeStill.detailCaption}</p>}
              </div>
              <button
                type="button"
                onClick={() => setSelectedStill(null)}
                className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <img src={activeStillSrc} alt={activeStill.caption || "Key moment still"} className="mx-auto max-h-[70vh] w-full rounded-xl bg-black object-contain" />
              <StillMetricStrip telemetrySummary={activeStill.telemetrySummary} />
              {selectedStillFrames.length > 1 && (
                <div className="mt-4 space-y-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Other stills from this key moment</p>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {selectedStillFrames.map((frame, index) => {
                      const thumbSrc = clipFrameSrc(frame);
                      const active = index === selectedStillIndex;
                      return (
                        <button
                          key={frame.id || `${selectedStill.clip?.id || "key-moment"}-lightbox-${index}`}
                          type="button"
                          onClick={() => setSelectedStill((current) => ({ ...(current || {}), frame, frameIndex: index }))}
                          className={`shrink-0 overflow-hidden rounded-lg border ${active ? "border-primary" : "border-border"} bg-background`}
                        >
                          <img src={thumbSrc} alt={frame.caption || `Key moment still ${index + 1}`} className="h-24 w-32 object-cover" loading="lazy" />
                          <p className="max-w-32 truncate px-2 py-1 text-[10px] text-muted-foreground">{frame.sessionTimeLabel || `Still ${index + 1}`}</p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
