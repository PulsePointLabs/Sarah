import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Clapperboard, Crosshair, HeartPulse, Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import HRTimelineChart from "./HRTimelineChart";
import EMGTimelineChart from "./EMGTimelineChart";
import PerinealEmgPanel from "./PerinealEmgPanel";
import SavedMotionSummaryCard from "./SavedMotionSummaryCard";
import ClimaxMotionSnapshotCard from "./ClimaxMotionSnapshotCard";
import { summarizePerinealEmg } from "@/utils/perinealEmgSummary";

function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function nearest(rows, time, key) {
  if (!rows?.length || !Number.isFinite(Number(time))) return null;
  return rows.reduce((closest, row) => (
    Math.abs(Number(row[key]) - Number(time)) < Math.abs(Number(closest[key]) - Number(time)) ? row : closest
  ), rows[0]);
}

function Metric({ label, value, tone = "text-foreground" }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 font-mono text-sm font-semibold ${tone}`}>{value ?? "--"}</p>
    </div>
  );
}

export default function SessionTelemetryDashboard({
  session,
  timelineRows = [],
  emgRows = [],
  nearClimaxEvents = [],
  highlightRange,
  selectedEventIndex,
  onSelectEventIndex,
  inspectionTime,
  onInspectionTimeChange,
  onMarkersChange,
  onOpenReview,
}) {
  const [inspectorPlaying, setInspectorPlaying] = useState(false);
  const [inspectorSpeed, setInspectorSpeed] = useState(1);
  const [inspectorDockOpen, setInspectorDockOpen] = useState(false);
  const [inspectorDockExpanded, setInspectorDockExpanded] = useState(false);
  const inspectionTimeRef = useRef(Number(inspectionTime) || 0);
  const events = Array.isArray(session.event_timeline) ? session.event_timeline : [];
  const perinealEmgSummary = useMemo(() => summarizePerinealEmg(session), [session]);
  const orderedEvents = useMemo(
    () => events
      .map((event, index) => ({ event, index, timeS: Number(event.time_s) }))
      .filter((entry) => Number.isFinite(entry.timeS))
      .sort((a, b) => a.timeS - b.timeS),
    [events],
  );
  const hrPoint = useMemo(() => nearest(timelineRows, inspectionTime, "time_offset_s"), [inspectionTime, timelineRows]);
  const motionPoint = useMemo(
    () => nearest(session.motion_analysis_summary?.derived_timeline || [], inspectionTime, "time_s"),
    [inspectionTime, session.motion_analysis_summary],
  );
  const cadencePoint = useMemo(
    () => nearest(session.motion_analysis_summary?.hand_cadence_timeline || [], inspectionTime, "time_s"),
    [inspectionTime, session.motion_analysis_summary],
  );
  const nearestEvent = useMemo(() => nearest(events, inspectionTime, "time_s"), [events, inspectionTime]);
  const baseline = Number(hrPoint?.baseline_hr);
  const currentHR = Number(hrPoint?.hr);
  const balanceTotal = Number(motionPoint?.left_lower_body_activity || 0) + Number(motionPoint?.right_lower_body_activity || 0);
  const balance = balanceTotal > 0
    ? (Number(motionPoint?.left_lower_body_activity || 0) - Number(motionPoint?.right_lower_body_activity || 0)) / balanceTotal
    : null;
  const balanceText = balance == null || Math.abs(balance) <= 0.1 ? "Similar" : `${balance > 0 ? "Left" : "Right"} higher`;
  const durationS = Math.max(
    Number(session.duration_minutes || 0) * 60,
    ...timelineRows.map((row) => Number(row.time_offset_s) || 0),
    ...(session.motion_analysis_summary?.derived_timeline || []).map((row) => Number(row.time_s) || 0),
    ...emgRows.map((row) => Number(row.time_s) || 0),
  );
  const previousEvent = [...orderedEvents].reverse().find((entry) => entry.timeS < Number(inspectionTime || 0) - 0.25) || null;
  const nextEvent = orderedEvents.find((entry) => entry.timeS > Number(inspectionTime || 0) + 0.25) || null;

  const toggleInspectorPlayback = () => {
    if (inspectionTimeRef.current >= durationS) {
      inspectionTimeRef.current = 0;
      onInspectionTimeChange?.(0);
    }
    setInspectorDockOpen(true);
    setInspectorPlaying((playing) => !playing);
  };

  const jumpToEvent = (entry) => {
    if (!entry) return;
    inspectionTimeRef.current = entry.timeS;
    onInspectionTimeChange?.(entry.timeS);
    onSelectEventIndex?.(entry.index);
  };

  useEffect(() => {
    inspectionTimeRef.current = Number(inspectionTime) || 0;
  }, [inspectionTime]);

  useEffect(() => {
    if (!inspectorPlaying || durationS <= 0 || !onInspectionTimeChange) return undefined;
    const timer = window.setInterval(() => {
      const next = Math.min(durationS, inspectionTimeRef.current + (0.1 * inspectorSpeed));
      inspectionTimeRef.current = next;
      onInspectionTimeChange(next);
      if (next >= durationS) setInspectorPlaying(false);
    }, 100);
    return () => window.clearInterval(timer);
  }, [durationS, inspectorPlaying, inspectorSpeed, onInspectionTimeChange]);

  return (
    <section id="session-telemetry" className="scroll-mt-24 rounded-2xl border border-primary/20 bg-card p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
            <HeartPulse className="h-4 w-4" />
            Unified Evidence Dashboard
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Heart rate, saved motion, cadence, EMG, and events on one inspection cursor.
          </p>
        </div>
        {onOpenReview && (
          <Button type="button" variant="outline" size="sm" onClick={onOpenReview} className="gap-1.5">
            <Clapperboard className="h-3.5 w-3.5" />
            Review against video
          </Button>
        )}
      </div>

      <div className="rounded-xl border border-border bg-muted/10 p-3 space-y-3">
        <div className="flex items-center gap-2">
          <Crosshair className="h-4 w-4 text-rose-400" />
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Inspector</p>
          <span className="ml-auto font-mono text-lg font-bold text-rose-400">{formatTime(inspectionTime)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={toggleInspectorPlayback}
            disabled={durationS <= 0}
            className="inline-flex items-center gap-1.5 rounded-md border border-rose-400/30 bg-rose-400/[0.08] px-3 py-1.5 text-xs font-semibold text-rose-300 disabled:opacity-45"
          >
            {inspectorPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {inspectorPlaying ? "Pause" : "Play"} inspector
          </button>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Speed</span>
          {[0.5, 1, 2, 4].map((speed) => (
            <button
              key={speed}
              type="button"
              onClick={() => setInspectorSpeed(speed)}
              className={`rounded-md border px-2 py-1 text-[10px] font-semibold ${inspectorSpeed === speed ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
            >
              {speed}x
            </button>
          ))}
          <span className="text-[10px] text-muted-foreground">Advances the evidence cursor only.</span>
        </div>
        {durationS > 0 && (
          <input
            type="range"
            min={0}
            max={durationS}
            step={1}
            value={Math.min(durationS, Math.max(0, Number(inspectionTime) || 0))}
            onChange={(event) => onInspectionTimeChange(Number(event.target.value))}
            className="w-full accent-rose-400"
            aria-label="Inspect session timestamp"
          />
        )}
        <div className="grid gap-2 grid-cols-2 md:grid-cols-4 xl:grid-cols-8">
          <Metric label="HR" value={Number.isFinite(currentHR) ? `${Math.round(currentHR)} bpm` : "--"} tone="text-rose-400" />
          <Metric label="Smoothed" value={Number.isFinite(Number(hrPoint?.hr_smoothed)) ? `${Math.round(Number(hrPoint.hr_smoothed))} bpm` : "--"} />
          <Metric label="Baseline Delta" value={Number.isFinite(currentHR) && Number.isFinite(baseline) ? `${currentHR - baseline >= 0 ? "+" : ""}${Math.round(currentHR - baseline)}` : "--"} />
          <Metric label="Left Lower Body" value={motionPoint?.left_lower_body_activity ?? "--"} tone="text-primary" />
          <Metric label="Right Lower Body" value={motionPoint?.right_lower_body_activity ?? "--"} tone="text-amber-400" />
          <Metric label="Hands" value={motionPoint?.hand_activity ?? "--"} tone="text-violet-400" />
          <Metric label="Cadence" value={cadencePoint?.movement_cycles_per_minute_estimate != null ? `${cadencePoint.movement_cycles_per_minute_estimate}/min` : "--"} tone="text-violet-400" />
          <Metric label="Balance" value={balanceText} />
        </div>
        {nearestEvent && (
          <button
            type="button"
            onClick={() => onSelectEventIndex?.(events.indexOf(nearestEvent))}
            className="w-full rounded-lg border border-border bg-card/70 px-3 py-2 text-left text-sm hover:border-primary/40"
          >
            <span className="mr-2 font-mono text-xs font-semibold text-primary">{formatTime(nearestEvent.time_s)}</span>
            <span className="text-muted-foreground">Nearest event: </span>
            <span className="text-foreground">{nearestEvent.note || "Untitled event"}</span>
          </button>
        )}
      </div>

      <ClimaxMotionSnapshotCard session={session} />

      {timelineRows.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Heart Rate And Phase Markers</p>
          <HRTimelineChart
            rows={timelineRows}
            savedMarkers={{
              pre_climax_offset_s: session.pre_climax_offset_s,
              climax_offset_s: session.climax_offset_s,
              recovery_offset_s: session.recovery_offset_s,
            }}
            onMarkersChange={onMarkersChange}
            highlightRange={highlightRange}
            noClimax={!!session.no_climax}
            nearClimaxEvents={nearClimaxEvents}
            events={events}
            selectedEventIndex={selectedEventIndex}
            onSelectEventIndex={onSelectEventIndex}
            initialWindow="full"
            inspectionTime={inspectionTime}
            onInspectionTimeChange={onInspectionTimeChange}
          />
        </div>
      )}

      {(perinealEmgSummary.hasPerinealEvents || perinealEmgSummary.hasPerinealSetup) && (
        <PerinealEmgPanel
          session={session}
          summary={perinealEmgSummary}
          emgRows={emgRows}
          inspectionTime={inspectionTime}
          onInspectionTimeChange={onInspectionTimeChange}
        />
      )}

      {session.motion_analysis_summary && (
        <SavedMotionSummaryCard
          summary={session.motion_analysis_summary}
          playbackTime={inspectionTime}
          onSeek={onInspectionTimeChange}
          chartOnly
          interactionLabel="Saved movement and cadence traces aligned to this session; click to move the inspection cursor."
        />
      )}

      {emgRows.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">EMG Correlation</p>
          <EMGTimelineChart
            rows={emgRows}
            channelMode={session.emg_channels || "single"}
            events={events}
            savedMarkers={{
              pre_climax_offset_s: session.pre_climax_offset_s,
              climax_offset_s: session.climax_offset_s,
              recovery_offset_s: session.recovery_offset_s,
            }}
            timelineRows={timelineRows}
            inspectionTime={inspectionTime}
            onInspectionTimeChange={onInspectionTimeChange}
          />
        </div>
      )}

      {inspectorDockOpen && (
        <div className="fixed bottom-20 left-1/2 z-40 flex w-[min(calc(100vw-2rem),30rem)] -translate-x-1/2 flex-col items-end gap-2 md:left-auto md:right-6 md:translate-x-0">
          {!inspectorDockExpanded && nearestEvent && (
            <button
              type="button"
              onClick={() => onSelectEventIndex?.(events.indexOf(nearestEvent))}
              className="max-w-full rounded-lg border border-primary/20 bg-card/95 px-3 py-2 text-left text-xs shadow-lg backdrop-blur hover:border-primary/40"
              title="Select nearest event"
            >
              <span className="mr-2 font-mono font-semibold text-primary">{formatTime(nearestEvent.time_s)}</span>
              <span className="text-muted-foreground">Nearest event: </span>
              <span className="line-clamp-1 text-foreground">{nearestEvent.note || "Untitled event"}</span>
            </button>
          )}
          <div className={`rounded-xl border border-rose-400/25 bg-card/95 shadow-2xl backdrop-blur ${inspectorDockExpanded ? "w-full p-3" : "p-2"}`}>
            {!inspectorDockExpanded ? (
              <div className="flex items-center gap-2">
                <Crosshair className="h-3.5 w-3.5 text-rose-400" />
                <span className="font-mono text-sm font-bold text-rose-400">{formatTime(inspectionTime)}</span>
                <button
                  type="button"
                  onClick={toggleInspectorPlayback}
                  disabled={durationS <= 0}
                  className="inline-flex items-center gap-1 rounded-md border border-rose-400/30 bg-rose-400/[0.08] px-2.5 py-1.5 text-[11px] font-semibold text-rose-300 disabled:opacity-45"
                >
                  {inspectorPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  {inspectorPlaying ? "Pause" : "Play"}
                </button>
                <button
                  type="button"
                  onClick={() => setInspectorDockExpanded(true)}
                  className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Expand inspector playback controls"
                  title="Expand controls"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setInspectorPlaying(false);
                    setInspectorDockOpen(false);
                    setInspectorDockExpanded(false);
                  }}
                  className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Close inspector playback controls"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <Crosshair className="h-3.5 w-3.5 text-rose-400" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Inspector Playback</span>
                  <span className="ml-auto font-mono text-sm font-bold text-rose-400">{formatTime(inspectionTime)}</span>
                  <button
                    type="button"
                    onClick={() => setInspectorDockExpanded(false)}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Collapse inspector playback controls"
                    title="Compact controls"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInspectorPlaying(false);
                      setInspectorDockOpen(false);
                      setInspectorDockExpanded(false);
                    }}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Close inspector playback controls"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={toggleInspectorPlayback}
                    disabled={durationS <= 0}
                    className="inline-flex items-center gap-1.5 rounded-md border border-rose-400/30 bg-rose-400/[0.08] px-3 py-1.5 text-xs font-semibold text-rose-300 disabled:opacity-45"
                  >
                    {inspectorPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    {inspectorPlaying ? "Pause" : "Play"}
                  </button>
                  <button
                    type="button"
                    onClick={() => jumpToEvent(previousEvent)}
                    disabled={!previousEvent}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-[10px] font-semibold text-muted-foreground disabled:opacity-40"
                    title={previousEvent ? `Jump to ${formatTime(previousEvent.timeS)}` : "No earlier event marker"}
                  >
                    <SkipBack className="h-3.5 w-3.5" />
                    Last event
                  </button>
                  <button
                    type="button"
                    onClick={() => jumpToEvent(nextEvent)}
                    disabled={!nextEvent}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-[10px] font-semibold text-muted-foreground disabled:opacity-40"
                    title={nextEvent ? `Jump to ${formatTime(nextEvent.timeS)}` : "No later event marker"}
                  >
                    Next event
                    <SkipForward className="h-3.5 w-3.5" />
                  </button>
                  <span className="ml-auto text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Speed</span>
                  {[0.5, 1, 2, 4].map((speed) => (
                    <button
                      key={`floating-${speed}`}
                      type="button"
                      onClick={() => setInspectorSpeed(speed)}
                      className={`rounded-md border px-2 py-1 text-[10px] font-semibold ${inspectorSpeed === speed ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
                    >
                      {speed}x
                    </button>
                  ))}
                </div>
                {nearestEvent && (
                  <p className="mt-2 truncate text-[10px] text-muted-foreground">
                    Nearest event: <span className="font-mono text-primary">{formatTime(nearestEvent.time_s)}</span> {nearestEvent.note || "Untitled event"}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
