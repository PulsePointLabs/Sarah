import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { serverUrl } from "@/lib/mobileApiBase";
import { attachBloodPressureToSession, findBloodPressureNearSession } from "@/lib/bloodPressure";
import { loadUserProfileWithProfilerResults } from "@/lib/profileContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Activity, ArrowLeft, Star, Trash2, Heart, Clock, Zap, Pencil, XCircle, Clapperboard, Sparkles, Maximize2 } from "lucide-react";
import AITagSuggester from "../components/AITagSuggester";
import AIChat from "../components/AIChat";
import SessionExportButton from "../components/SessionExportButton";
import moment from "moment";
import HRTimelineChart from "../components/HRTimelineChart";
import EMGTimelineChart from "../components/EMGTimelineChart";
import HRZoneAnalysis from "../components/HRZoneAnalysis";
import HRPhysiologicalAnalysis from "../components/HRPhysiologicalAnalysis";
import NearClimaxEvents, { detectNearClimaxEvents } from "../components/NearClimaxEvents";
import NearClimaxSessionOverview from "../components/NearClimaxSessionOverview";
import SessionAIPanel, { buildSessionAnalysisReaderData, SessionReviewVideoExportButton } from "../components/SessionAIPanel";
import SessionEvidencePatternPanel from "../components/SessionEvidencePatternPanel";
import SessionExecutiveSummary from "../components/SessionExecutiveSummary";
import SessionSnapshotHero from "../components/SessionSnapshotHero";
import SessionTelemetryDashboard from "../components/SessionTelemetryDashboard";
import SessionSectionNavigator from "../components/SessionSectionNavigator";
import LinkedLocalVideoManager from "../components/LinkedLocalVideoManager";
import VideoSyncPlayer from "../components/VideoSyncPlayer";
import PostSessionReviewWizard from "../components/PostSessionReviewWizard";
import CascadeOverviewPanel from "../components/CascadeOverviewPanel";
import AIPhaseMarkerSuggester from "../components/AIPhaseMarkerSuggester";
import ArousalEventChart from "../components/ArousalEventChart";
import UnifiedSessionTimeline from "../components/UnifiedSessionTimeline";
import InteractiveSessionTimeline from "../components/InteractiveSessionTimeline";
import InteractiveTimelinePlayer, { TimelineWaypointDetail } from "../components/InteractiveTimelinePlayer";
import NoClimaxAIPanel from "../components/NoClimaxAIPanel";
import SessionTimelineNarrative from "../components/SessionTimelineNarrative";
import SavedMotionSummaryCard from "../components/SavedMotionSummaryCard";
import JournalRecorder from "../components/JournalRecorder";
import MobileSessionVideoRenderPanel from "../components/MobileSessionVideoRenderPanel";
import { journalHasStoryline, normalizeJournalEntry } from "@/lib/journalEntry";
import { bloodPressureReadingsFromSession, pulseOxReadingsFromSession, sessionContextDisplayRows } from "@/lib/sessionContext";
import { buildSessionKeyVideoClipDigest, buildSessionPhaseMarkerDigest, buildSessionVideoPassDigest, buildSessionVisualEvidenceDigest, getReviewedVisualClips, isVisualReviewSource, makeSessionVisualEvidenceEntry, normalizeSessionKeyVideoClips, normalizeSessionVisualEvidence, sessionEventsForCurrentPhaseMarkers } from "@/lib/visualEvidence";
import { sanitizeSessionChatMessages } from "@/lib/chatFindings";
import { EVENT_CATEGORIES, normalizeCategoryArray } from "../components/session-form/EventTimelineSection";
import { hasMixedPauseResumeEvidence, isVerifiedMotionEvent } from "@/utils/sessionMotionEvidence";
import { summarizePerinealEmg } from "@/utils/perinealEmgSummary";
import { videoPosterDataUrl } from "@/lib/videoPoster";

function _getCategoryMeta(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

function _fmtMmSs(s) {
  const totalS = Math.round(Number(s));
  const m = Math.floor(totalS / 60);
  const sec = totalS % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger
} from "@/components/ui/alert-dialog";

function inferStoryVideoPriority(video = {}) {
  const text = `${video?.label || ""} ${video?.filename || ""} ${video?.path || ""}`.toLowerCase();
  if (/\b(composite|pip|picture[-_\s]?in[-_\s]?picture|obs)\b/.test(text)) return 0;
  if (/\b(main|focus|primary|close|genital|shaft|glans)\b/.test(text)) return 1;
  if (/\b(side|lateral|angle)\b/.test(text)) return 8;
  if (/\b(feet|foot|toe|toes|heel|heels|lower[-_\s]?body|legs?|pelvis)\b/.test(text)) return 9;
  return 3;
}

function buildSessionStoryVideoSources({ linkedVideos = [], uploadedVideos = [] }) {
  const linkedSources = Array.isArray(linkedVideos)
    ? linkedVideos
        .filter((video) => video?.path && video.exists !== false)
        .sort((a, b) => inferStoryVideoPriority(a) - inferStoryVideoPriority(b))
        .map((video, index) => ({
          id: video.id || video.path || `linked-${index}`,
          label: video.label || video.filename || (index === 0 ? "Session composite" : `Linked video ${index + 1}`),
          url: base44.integrations.Core.localVideoStreamUrl(video.path),
          timelineOffsetSeconds: Number(video.timelineOffsetSeconds) || 0,
          sourceKind: "linked_local_video",
        }))
    : [];

  if (linkedSources.length) return linkedSources;

  return Array.isArray(uploadedVideos)
    ? uploadedVideos
        .filter(Boolean)
        .map((url, index) => ({
          id: `uploaded-${index}`,
          label: index === 0 ? "Uploaded session video" : `Uploaded video ${index + 1}`,
          url: serverUrl(url),
          timelineOffsetSeconds: 0,
          sourceKind: "uploaded_session_video",
        }))
    : [];
}

function cacheBustedMediaUrl(fileUrl = "", cacheKey = "") {
  const url = serverUrl(fileUrl);
  if (!url) return "";
  const version = String(cacheKey || Date.now()).replace(/[^a-zA-Z0-9_.-]/g, "");
  return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}`;
}

function InfoRow({ label, value }) {
  if (!value && value !== 0) return null;
  return (
    <div className="flex justify-between py-2 border-b border-border last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-right max-w-[60%]">{value}</span>
    </div>
  );
}

function MetricBadge({ label, value, max = 10 }) {
  if (value === undefined || value === null || value === "") return null;
  const pct = (value / max) * 100;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-bold">{value}/{max}</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function EmptyPanelNote({ children }) {
  return (
    <p className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      {children}
    </p>
  );
}

function formatBpTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function downsampleRows(rows, maxRows = 900) {
  if (rows.length <= maxRows) return rows;
  const step = Math.ceil(rows.length / maxRows);
  return rows.filter((_row, index) => index % step === 0);
}

function roundTrimSeconds(value) {
  return Number(Number(value || 0).toFixed(1));
}

function readNumericTime(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getSessionMaxOffset(timelineRows = [], emgRows = []) {
  const hrMax = timelineRows.reduce((max, row) => {
    const time = readNumericTime(row?.time_offset_s);
    return time != null ? Math.max(max, time) : max;
  }, 0);
  const emgMax = emgRows.reduce((max, row) => {
    const time = readNumericTime(row?.time_s);
    return time != null ? Math.max(max, time) : max;
  }, 0);
  return Math.max(hrMax, emgMax);
}

function normalizeAnalysisTrim(trim, timelineRows = [], emgRows = []) {
  const maxOffset = getSessionMaxOffset(timelineRows, emgRows);
  if (!(maxOffset > 0)) return null;
  const startRaw = readNumericTime(trim?.start_s);
  const endRaw = readNumericTime(trim?.end_s);
  const start = Math.max(0, startRaw ?? 0);
  const end = Math.min(maxOffset, endRaw ?? maxOffset);
  if (!(end > start)) return null;
  const meaningfullyTrimmed = start > 0.25 || end < maxOffset - 0.25;
  if (!meaningfullyTrimmed) return null;
  return {
    start_s: roundTrimSeconds(start),
    end_s: roundTrimSeconds(end),
    duration_s: roundTrimSeconds(end - start),
    max_s: roundTrimSeconds(maxOffset),
  };
}

function trimTimeValue(value, trim) {
  const time = readNumericTime(value);
  if (time == null || !trim) return value ?? null;
  return roundTrimSeconds(time - trim.start_s);
}

function rowFallsInsideTrim(timeValue, trim) {
  const time = readNumericTime(timeValue);
  if (time == null || !trim) return true;
  return time >= trim.start_s && time <= trim.end_s;
}

function trimTimelineRows(rows = [], trim) {
  if (!trim) return rows;
  return rows
    .filter((row) => rowFallsInsideTrim(row?.time_offset_s, trim))
    .map((row) => ({
      ...row,
      time_offset_s: trimTimeValue(row.time_offset_s, trim),
    }));
}

function trimEmgRows(rows = [], trim) {
  if (!trim) return rows;
  return rows
    .filter((row) => rowFallsInsideTrim(row?.time_s, trim))
    .map((row) => ({
      ...row,
      time_s: trimTimeValue(row.time_s, trim),
    }));
}

function trimEventTimeline(events = [], trim) {
  if (!trim) return events;
  return events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => rowFallsInsideTrim(event?.time_s, trim))
    .map(({ event, index }) => ({
      ...event,
      time_s: trimTimeValue(event.time_s, trim),
      _trim_original_index: index,
    }));
}

function trimNearClimaxEvents(events = [], trim) {
  if (!trim) return events;
  return events
    .filter((event) => {
      const start = readNumericTime(event?.start_offset_s);
      const end = readNumericTime(event?.end_offset_s);
      if (start == null && end == null) return true;
      const safeStart = start ?? end ?? trim.start_s;
      const safeEnd = end ?? start ?? trim.end_s;
      return safeEnd >= trim.start_s && safeStart <= trim.end_s;
    })
    .map((event) => ({
      ...event,
      start_offset_s: readNumericTime(event?.start_offset_s) == null
        ? event?.start_offset_s
        : roundTrimSeconds(Math.max(0, Number(event.start_offset_s) - trim.start_s)),
      peak_offset_s: trimTimeValue(event?.peak_offset_s, trim),
      end_offset_s: readNumericTime(event?.end_offset_s) == null
        ? event?.end_offset_s
        : roundTrimSeconds(Math.max(0, Number(event.end_offset_s) - trim.start_s)),
    }));
}

function trimPhaseMarker(value, trim) {
  const time = readNumericTime(value);
  if (time == null || !trim) return value ?? null;
  if (time < trim.start_s || time > trim.end_s) return null;
  return roundTrimSeconds(time - trim.start_s);
}

function buildTrimmedSessionView(session, timelineRows = [], emgRows = [], trim = null) {
  if (!session) {
    return {
      session: null,
      timelineRows,
      emgRows,
    };
  }
  if (!trim) {
    return {
      session,
      timelineRows,
      emgRows,
    };
  }
  return {
    session: {
      ...session,
      analysis_trim: trim,
      pre_climax_offset_s: trimPhaseMarker(session.pre_climax_offset_s, trim),
      climax_offset_s: trimPhaseMarker(session.climax_offset_s, trim),
      recovery_offset_s: trimPhaseMarker(session.recovery_offset_s, trim),
      event_timeline: trimEventTimeline(session.event_timeline || [], trim),
      ai_near_climax_events: trimNearClimaxEvents(session.ai_near_climax_events || [], trim),
    },
    timelineRows: trimTimelineRows(timelineRows, trim),
    emgRows: trimEmgRows(emgRows, trim),
  };
}

function BloodPressureSessionChart({ session }) {
  const readings = bloodPressureReadingsFromSession(session);
  if (!readings.length) return null;
  const chartRows = readings.map((reading) => ({
    ...reading,
    label: formatBpTime(reading.measured_at),
    systolic: reading.systolic_mm_hg,
    diastolic: reading.diastolic_mm_hg,
    pulse: reading.pulse_bpm,
  }));
  const latest = readings[readings.length - 1];
  const avgSys = Math.round(readings.reduce((sum, reading) => sum + Number(reading.systolic_mm_hg || 0), 0) / readings.length);
  const avgDia = Math.round(readings.reduce((sum, reading) => sum + Number(reading.diastolic_mm_hg || 0), 0) / readings.length);
  const pulseValues = readings.map((reading) => Number(reading.pulse_bpm)).filter(Number.isFinite);
  const avgPulse = pulseValues.length ? Math.round(pulseValues.reduce((sum, value) => sum + value, 0) / pulseValues.length) : null;
  const compactReading = (systolic, diastolic) => `${systolic}/${diastolic}`;

  return (
    <section id="session-blood-pressure-chart" className="scroll-mt-24 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
            <Activity className="h-3.5 w-3.5" /> Blood Pressure
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Session-linked BP readings plotted with pulse so Sarah can compare vascular load against HR/HRV context.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:text-right">
          <div className="rounded-lg bg-muted/25 px-3 py-2 text-left sm:text-right">
            <p className="whitespace-nowrap font-mono text-lg font-bold text-foreground sm:text-xl">{compactReading(latest.systolic_mm_hg, latest.diastolic_mm_hg)}</p>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">latest</p>
          </div>
          <div className="rounded-lg bg-muted/25 px-3 py-2 text-left sm:text-right">
            <p className="whitespace-nowrap font-mono text-lg font-bold text-foreground sm:text-xl">{compactReading(avgSys, avgDia)}</p>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">average</p>
          </div>
          <div className="col-span-2 rounded-lg bg-muted/25 px-3 py-2 text-left sm:col-span-1 sm:text-right">
            <p className="whitespace-nowrap font-mono text-lg font-bold text-foreground sm:text-xl">{avgPulse ?? "--"}</p>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">pulse</p>
          </div>
        </div>
      </div>

      <div className="mt-4 h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartRows} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis yAxisId="bp" tick={{ fontSize: 10 }} domain={["dataMin - 8", "dataMax + 8"]} />
            <YAxis yAxisId="pulse" orientation="right" tick={{ fontSize: 10 }} domain={["dataMin - 8", "dataMax + 8"]} />
            <Tooltip
              formatter={(value, name) => [`${Math.round(Number(value))}${name === "pulse" ? " bpm" : " mmHg"}`, name === "systolic" ? "Systolic" : name === "diastolic" ? "Diastolic" : "Pulse"]}
              labelFormatter={(_, rows = []) => rows?.[0]?.payload?.measured_at ? new Date(rows[0].payload.measured_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}
            />
            <Line yAxisId="bp" type="monotone" dataKey="systolic" name="systolic" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={{ r: 3 }} />
            <Line yAxisId="bp" type="monotone" dataKey="diastolic" name="diastolic" stroke="hsl(var(--chart-3))" strokeWidth={2.5} dot={{ r: 3 }} />
            <Line yAxisId="pulse" type="monotone" dataKey="pulse" name="pulse" stroke="hsl(var(--chart-2))" strokeWidth={2} strokeDasharray="4 3" dot={{ r: 3 }} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {readings.slice(-6).reverse().map((reading) => (
          <div key={reading.id || `${reading.measured_at}-${reading.systolic_mm_hg}-${reading.diastolic_mm_hg}`} className="rounded-lg border border-border bg-muted/15 px-3 py-2">
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-lg font-bold text-foreground">
              <span className="whitespace-nowrap">{compactReading(reading.systolic_mm_hg, reading.diastolic_mm_hg)}</span>
              <span className="whitespace-nowrap text-base">mmHg</span>
              {reading.pulse_bpm ? <span className="whitespace-nowrap text-base">· {reading.pulse_bpm} bpm</span> : null}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {reading.measured_at ? new Date(reading.measured_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "No timestamp"}
              {reading.source_app ? ` · ${reading.source_app}` : ""}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function BloodPressureAttachPanel({
  attachedReadings = [],
  nearbyReadings = [],
  attachBusy = false,
  attachStatus = "",
  onAttachReadings,
}) {
  const attachedIds = new Set(attachedReadings.map((reading) => reading?.id).filter(Boolean));
  const attachable = nearbyReadings.filter((reading) => !attachedIds.has(reading?.id));
  if (!attachable.length && !attachStatus) return null;

  return (
    <section className="rounded-xl border border-primary/20 bg-primary/[0.05] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
            <Activity className="h-3.5 w-3.5" /> Blood Pressure Association
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Attach saved cuff readings that landed near this session but were not stamped into it at capture time.
          </p>
        </div>
        {attachable.length > 0 && (
          <Button
            type="button"
            onClick={() => onAttachReadings?.(attachable.map((reading) => reading.id))}
            disabled={attachBusy}
            className="shrink-0"
          >
            {attachBusy ? "Attaching..." : `Attach ${attachable.length} Nearby Reading${attachable.length === 1 ? "" : "s"}`}
          </Button>
        )}
      </div>
      {attachStatus && (
        <p className="mt-3 rounded-lg border border-border bg-background/70 px-3 py-2 text-xs text-muted-foreground">
          {attachStatus}
        </p>
      )}
      {attachable.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {attachable.map((reading) => (
            <div key={reading.id || `${reading.measured_at}-${reading.systolic_mm_hg}-${reading.diastolic_mm_hg}`} className="rounded-lg border border-border bg-background/70 px-3 py-2">
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-lg font-bold text-foreground">
                <span className="whitespace-nowrap">{reading.systolic_mm_hg}/{reading.diastolic_mm_hg}</span>
                <span className="whitespace-nowrap text-base">mmHg</span>
                {reading.pulse_bpm ? <span className="whitespace-nowrap text-base">· {reading.pulse_bpm} bpm</span> : null}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {reading.measured_at ? new Date(reading.measured_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "No timestamp"}
                {reading.source_app ? ` · ${reading.source_app}` : ""}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PulseOxSessionChart({ session }) {
  const readings = pulseOxReadingsFromSession(session);
  if (!readings.length) return null;
  const chartRows = downsampleRows(readings).map((reading) => ({
    ...reading,
    label: reading.measured_at ? formatBpTime(reading.measured_at) : _fmtMmSs(reading.time_offset_s || 0),
    spo2: reading.spo2_percent,
    pulse: reading.pulse_bpm,
  }));
  const latest = readings[readings.length - 1];
  const spo2Values = readings.map((reading) => Number(reading.spo2_percent)).filter(Number.isFinite);
  const pulseValues = readings.map((reading) => Number(reading.pulse_bpm)).filter(Number.isFinite);
  const avgSpo2 = Math.round(spo2Values.reduce((sum, value) => sum + value, 0) / spo2Values.length);
  const minSpo2 = Math.min(...spo2Values);
  const avgPulse = pulseValues.length ? Math.round(pulseValues.reduce((sum, value) => sum + value, 0) / pulseValues.length) : null;

  return (
    <section id="session-pulse-ox" className="scroll-mt-24 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
            <Activity className="h-3.5 w-3.5" /> Pulse Oximetry
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Imported EMAY SpO2 and pulse readings aligned to the session for oxygenation and autonomic context.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 text-right">
          <div className="rounded-lg bg-muted/25 px-3 py-2">
            <p className="font-mono text-xl font-bold text-foreground">{latest.spo2_percent}%</p>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">latest SpO2</p>
          </div>
          <div className="rounded-lg bg-muted/25 px-3 py-2">
            <p className="font-mono text-xl font-bold text-foreground">{avgSpo2}%</p>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">avg SpO2</p>
          </div>
          <div className="rounded-lg bg-muted/25 px-3 py-2">
            <p className="font-mono text-xl font-bold text-foreground">{minSpo2}%</p>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">min SpO2</p>
          </div>
        </div>
      </div>

      <div className="mt-4 h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartRows} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis yAxisId="spo2" tick={{ fontSize: 10 }} domain={[80, 100]} />
            <YAxis yAxisId="pulse" orientation="right" tick={{ fontSize: 10 }} domain={["dataMin - 8", "dataMax + 8"]} />
            <Tooltip
              formatter={(value, name) => [`${Math.round(Number(value))}${name === "pulse" ? " bpm" : "%"}`, name === "spo2" ? "SpO2" : "Pulse"]}
              labelFormatter={(_, rows = []) => rows?.[0]?.payload?.measured_at ? new Date(rows[0].payload.measured_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}
            />
            <Line yAxisId="spo2" type="monotone" dataKey="spo2" name="spo2" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={false} />
            <Line yAxisId="pulse" type="monotone" dataKey="pulse" name="pulse" stroke="hsl(var(--chart-2))" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border bg-muted/15 px-3 py-2">
          <p className="text-xs text-muted-foreground">Samples</p>
          <p className="font-mono text-lg font-bold text-foreground">{readings.length}</p>
        </div>
        <div className="rounded-lg border border-border bg-muted/15 px-3 py-2">
          <p className="text-xs text-muted-foreground">Average pulse</p>
          <p className="font-mono text-lg font-bold text-foreground">{avgPulse ?? "--"} bpm</p>
        </div>
        <div className="rounded-lg border border-border bg-muted/15 px-3 py-2">
          <p className="text-xs text-muted-foreground">First sample</p>
          <p className="font-mono text-sm font-bold text-foreground">{readings[0]?.measured_at ? new Date(readings[0].measured_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "--"}</p>
        </div>
        <div className="rounded-lg border border-border bg-muted/15 px-3 py-2">
          <p className="text-xs text-muted-foreground">Last sample</p>
          <p className="font-mono text-sm font-bold text-foreground">{latest.measured_at ? new Date(latest.measured_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "--"}</p>
        </div>
      </div>
    </section>
  );
}

function SessionKeyVideoMoments({ session }) {
  const clips = normalizeSessionKeyVideoClips(session);
  if (!clips.length) return null;
  const previewClips = clips.slice(0, 6);
  const hasMoreClips = clips.length > previewClips.length;
  return (
    <div className="rounded-xl border border-primary/20 bg-primary/[0.04] p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-primary">
        Key Video Moments
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {previewClips.map((clip) => {
          const src = serverUrl(clip.url || clip.clip_url || clip.file_url);
          return (
            <article key={`${clip.id}-${clip.url}`} className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="px-2 py-1 text-[10px]">
                <p className="truncate font-semibold text-primary">{clip.label || "Saved key moment"}</p>
                <p className="truncate text-muted-foreground">
                  {clip.session_time_s != null ? _fmtMmSs(clip.session_time_s) : "time?"}
                  {clip.camera_angle ? ` · ${clip.camera_angle}` : ""}
                  {clip.frames?.length ? ` · ${clip.frames.length} frames for Sarah Q&A` : src ? " · playable clip" : " · saved session marker"}
                </p>
              </div>
              {src ? (
                <video src={src} controls preload="metadata" className="block max-h-64 w-full bg-black object-contain" />
              ) : (
                <div className="flex min-h-24 items-center justify-center bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
                  This moment comes from the saved session timeline or phase markers and can be referenced in Ask Sarah even without a sampled clip.
                </div>
              )}
            </article>
          );
        })}
      </div>
      <details className="mt-3 rounded-lg border border-border bg-card/70 p-2">
        <summary className="cursor-pointer list-none text-sm font-semibold text-primary">
          All session moments ({clips.length})
        </summary>
        <div className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">
          {clips.map((clip) => (
            <div key={`all-${clip.id}-${clip.session_time_s}`} className="rounded-lg border border-border bg-background/80 px-3 py-2 text-xs">
              <p className="font-semibold text-foreground">{clip.label || "Saved key moment"}</p>
              <p className="text-muted-foreground">
                {clip.session_time_s != null ? _fmtMmSs(clip.session_time_s) : "time?"}
                {clip.camera_angle ? ` · ${clip.camera_angle}` : ""}
                {clip.frames?.length ? ` · ${clip.frames.length} frames` : clip.url || clip.clip_url || clip.file_url ? " · playable clip" : " · saved marker"}
              </p>
            </div>
          ))}
        </div>
      </details>
      {hasMoreClips ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          The preview shows the first few moments in time order. Open “All session moments” for the full list, including later climax and recovery markers.
        </p>
      ) : null}
    </div>
  );
}

function SessionStoryVideoPlayer({ linkedVideos = [], uploadedVideos = [], onAskSarahAtTimestamp }) {
  const playableVideos = useMemo(
    () => buildSessionStoryVideoSources({ linkedVideos, uploadedVideos }),
    [linkedVideos, uploadedVideos],
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const videoRef = useRef(null);
  const wrapperRef = useRef(null);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, playableVideos.length - 1)));
  }, [playableVideos.length]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackSpeed;
  }, [playbackSpeed, activeIndex]);

  if (!playableVideos.length) return null;
  const activeVideo = playableVideos[activeIndex] || playableVideos[0];
  const activeVideoUrl = cacheBustedMediaUrl(
    activeVideo.url,
    [activeVideo.id, activeVideo.label, activeVideo.timelineOffsetSeconds, activeIndex].filter(Boolean).join("-"),
  );
  const activeVideoPoster = videoPosterDataUrl({
    title: activeVideo.label || "Session video",
    subtitle: activeVideo.sourceKind === "linked_local_video" ? "Sarah source session video" : "Uploaded session video",
    timestamp: "Tap to play",
  });

  const openFullscreen = async () => {
    const video = videoRef.current;
    if (!video) return;
    video.controls = true;
    try {
      if (typeof video.requestFullscreen === "function") {
        await video.requestFullscreen();
        return;
      }
      if (typeof video.webkitEnterFullscreen === "function") {
        video.webkitEnterFullscreen();
        return;
      }
      const target = wrapperRef.current || video;
      if (!target?.requestFullscreen) return;
      await target.requestFullscreen();
    } catch (error) {
      console.warn("Could not open session video fullscreen:", error);
    }
  };

  const askSarahAboutMoment = () => {
    if (!activeVideo?.url) return;
    onAskSarahAtTimestamp?.({
      timeSeconds: Math.max(0, Number(playheadSeconds) || 0),
      sourceUrl: activeVideo.url,
      timelineOffsetSeconds: Number(activeVideo.timelineOffsetSeconds) || 0,
      sourceLabel: activeVideo.label || "Session video",
      sourceKind: activeVideo.sourceKind || "session_video",
    });
  };

  return (
    <section id="session-story-video" className="scroll-mt-24">
      <div className="ml-auto w-full max-w-2xl rounded-xl border border-primary/20 bg-card p-3 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
              <Clapperboard className="h-3.5 w-3.5" /> Session Video
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              This player follows Sarah&apos;s primary source video for the session. Use it to review the real composite/main recording and ask her about the current moment.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-full border border-border bg-muted/35 p-1">
              {[0.5, 1, 1.5, 2].map((speed) => (
                <button
                  key={speed}
                  type="button"
                  onClick={() => setPlaybackSpeed(speed)}
                  className={`rounded-full px-2 py-1 text-[10px] font-semibold ${playbackSpeed === speed ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {speed}x
                </button>
              ))}
            </div>
            <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" onClick={openFullscreen}>
              <Maximize2 className="h-3.5 w-3.5" />
              Fullscreen
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-foreground">{activeVideo.label}</p>
            <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground tabular-nums">
              {Math.floor(playheadSeconds / 60)}:{Math.round(playheadSeconds % 60).toString().padStart(2, "0")}
              {activeVideo.timelineOffsetSeconds ? ` · sync offset ${activeVideo.timelineOffsetSeconds > 0 ? "+" : ""}${activeVideo.timelineOffsetSeconds}s` : ""}
            </p>
          </div>
          <Button type="button" size="sm" className="h-8 gap-1.5" onClick={askSarahAboutMoment}>
            <Sparkles className="h-3.5 w-3.5" />
            Ask Sarah About This Moment
          </Button>
        </div>
        {playableVideos.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {playableVideos.map((video, index) => (
              <Button
                key={video.id || index}
                type="button"
                size="sm"
                variant={index === activeIndex ? "default" : "outline"}
                className="h-7 text-[10px]"
                onClick={() => setActiveIndex(index)}
              >
                {video.label || `Video ${index + 1}`}
              </Button>
            ))}
          </div>
        )}
        <div ref={wrapperRef} className="relative mt-3 max-w-full overflow-hidden rounded-lg border border-border bg-black">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background px-3 py-2 text-xs">
            <span className="font-semibold text-foreground">Session video</span>
            <span className="text-muted-foreground">{activeVideo.label || "Primary source video"}</span>
          </div>
          <video
            ref={videoRef}
            key={activeVideoUrl}
            src={activeVideoUrl}
            poster={activeVideoPoster}
            controls
            playsInline
            preload="metadata"
            className="aspect-video w-full bg-black object-contain"
            onLoadedMetadata={(event) => {
              event.currentTarget.playbackRate = playbackSpeed;
              setPlayheadSeconds(event.currentTarget.currentTime || 0);
            }}
            onTimeUpdate={(event) => {
              setPlayheadSeconds(event.currentTarget.currentTime || 0);
            }}
            onSeeked={(event) => {
              setPlayheadSeconds(event.currentTarget.currentTime || 0);
            }}
          />
          <div className="pointer-events-none absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] truncate rounded-full border border-white/15 bg-black/72 px-3 py-1.5 text-[12px] font-semibold tracking-[0.18em] text-white shadow-[0_6px_18px_rgba(0,0,0,0.34)] tabular-nums backdrop-blur-sm">
            {Math.floor(playheadSeconds / 60)}:{Math.round(playheadSeconds % 60).toString().padStart(2, "0")}
          </div>
        </div>
      </div>
    </section>
  );
}

function getEventCategories(event) {
  const categories = Array.isArray(event?.category) ? event.category : [event?.category].filter(Boolean);
  return categories.length ? categories : ["other"];
}

function EventNotesPanel({
  events = [],
  motionSummary,
  selectedIndex,
  onSelect,
  onUpdateEvent,
  onDeleteEvent,
  onDeleteAll,
  onUpdateMotionVerification,
  title = "Timeline Notes",
  helper = "Click a note to highlight its pin.",
  maxHeight = true,
}) {
  const [filter, setFilter] = useState("all");
  const [editingIndex, setEditingIndex] = useState(null);
  const [editNote, setEditNote] = useState("");
  const [editMinutes, setEditMinutes] = useState("");
  const [editSeconds, setEditSeconds] = useState("");
  const [editCategories, setEditCategories] = useState([]);
  const showPausePrecedenceNote = hasMixedPauseResumeEvidence({ event_timeline: events, motion_analysis_summary: motionSummary });
  const filteredEvents = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => {
      const categories = getEventCategories(event);
      if (filter === "manual") return event.source !== "motion_derived";
      if (filter === "motion") return event.source === "motion_derived";
      if (filter === "pause") return categories.some((category) => ["stimulation_paused", "stimulation_resumed", "motion_pause", "motion_resume"].includes(category));
      if (filter === "phase") return categories.some((category) => ["climax", "pre_climax", "recovery"].includes(category));
      return true;
    });

  const startEdit = (event, index) => {
    setEditingIndex(index);
    setEditNote(event.note || "");
    setEditMinutes(String(Math.floor(Number(event.time_s) / 60)));
    setEditSeconds(String(Math.round(Number(event.time_s) % 60)));
    const categories = normalizeCategoryArray(event.category);
    setEditCategories(categories.length ? categories : ["other"]);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditNote("");
    setEditMinutes("");
    setEditSeconds("");
    setEditCategories([]);
  };

  const saveEdit = async (event, index) => {
    const minutes = Math.max(0, parseInt(editMinutes, 10) || 0);
    const seconds = Math.min(59, Math.max(0, parseInt(editSeconds, 10) || 0));
    await onUpdateEvent?.(index, {
      ...event,
      time_s: minutes * 60 + seconds,
      note: editNote.trim(),
      category: editCategories.length ? editCategories : ["other"],
    });
    cancelEdit();
  };

  if (!events.length) {
    return (
      <div className="rounded-xl border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        No event notes logged for this session yet.
      </div>
    );
  }

  return (
    <div className={`rounded-xl border border-border bg-muted/20 p-3 space-y-3 ${maxHeight ? "xl:max-h-[26rem] xl:overflow-y-auto" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-primary">{title}</h4>
          {helper && <p className="text-xs text-muted-foreground">{helper}</p>}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-muted-foreground">{events.length}</span>
          {onDeleteAll && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md border border-destructive/30 px-2 py-1 text-[10px] font-medium text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3 w-3" /> Delete all
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete all event notes?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This clears every event note for this session. Telemetry, media, AI summaries, and the session itself will remain.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={onDeleteAll} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    Delete all event notes
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {[
          ["all", "All"],
          ["manual", "Manual"],
          ["motion", "Motion-derived"],
          ["pause", "Pause / resume"],
          ["phase", "Phase"],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`rounded-full border px-2 py-1 text-[10px] font-medium transition-colors ${
              filter === value ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {showPausePrecedenceNote && (
        <div className="rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          Manual pause/resume annotations are used as primary stimulation timing evidence. Motion-derived hand pauses are supporting visual evidence because hand tracking may be incomplete.
        </div>
      )}
      <div className="space-y-1.5">
        {filteredEvents.map(({ event, index }) => {
          const categories = getEventCategories(event);
          const primary = _getCategoryMeta(categories[0]);
          const selected = selectedIndex === index;
          const verified = isVerifiedMotionEvent(event);
          const editing = editingIndex === index;
          if (editing) {
            return (
              <div
                key={`${event.time_s}-${index}`}
                className="w-full space-y-2 rounded-lg border border-primary/40 bg-primary/[0.06] px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    value={editMinutes}
                    onChange={(e) => setEditMinutes(e.target.value)}
                    className="h-8 w-14 rounded border border-border bg-background px-2 text-center font-mono text-xs"
                    aria-label="Event minutes"
                  />
                  <span className="font-bold text-muted-foreground">:</span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={editSeconds}
                    onChange={(e) => setEditSeconds(e.target.value)}
                    className="h-8 w-14 rounded border border-border bg-background px-2 text-center font-mono text-xs"
                    aria-label="Event seconds"
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {EVENT_CATEGORIES.map((category) => {
                    const active = editCategories.includes(category.value);
                    return (
                      <button
                        key={category.value}
                        type="button"
                        onClick={() => setEditCategories((current) => (
                          active ? current.filter((value) => value !== category.value) : [...current, category.value]
                        ))}
                        className="rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors"
                        style={active
                          ? { background: category.color, color: "#fff", borderColor: category.color }
                          : { background: `${category.color}18`, color: category.color, borderColor: `${category.color}44` }}
                      >
                        {category.label}
                      </button>
                    );
                  })}
                </div>
                <textarea
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  rows={3}
                  className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                  aria-label="Event annotation"
                />
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" className="h-7 text-xs" onClick={() => saveEdit(event, index)}>
                    Save annotation
                  </Button>
                  <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={cancelEdit}>
                    Cancel
                  </Button>
                </div>
              </div>
            );
          }
          return (
            <div
              key={`${event.time_s}-${index}`}
              className={`w-full rounded-lg border px-3 py-2 transition-colors ${
                selected ? "bg-primary/10 border-primary/50" : "bg-card/50 border-border hover:border-primary/40"
              }`}
            >
              <button type="button" onClick={() => onSelect(selected ? null : index)} className="w-full text-left">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold" style={{ color: primary.color }}>{_fmtMmSs(event.time_s)}</span>
                  <div className="flex flex-wrap gap-1">
                    {categories.map((category) => {
                      const meta = _getCategoryMeta(category);
                      return (
                        <span
                          key={category}
                          className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
                          style={{ color: meta.color, borderColor: `${meta.color}55`, background: `${meta.color}18` }}
                        >
                          {meta.label}
                        </span>
                      );
                    })}
                    {event.source === "motion_derived" && (
                      <span className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        Motion-derived
                      </span>
                    )}
                    {verified && (
                      <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
                        event.verification_status === "reviewed_verified"
                          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                          : "border-amber-400/30 bg-amber-400/10 text-amber-300"
                      }`}>
                        {event.verification_status === "reviewed_verified" ? "Verified" : "Reviewed / adjusted"}
                      </span>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-sm leading-relaxed text-foreground/90">{event.note || "No note"}</p>
              </button>
              {(onUpdateEvent || onDeleteEvent || (event.source === "motion_derived" && onUpdateMotionVerification)) && (
                <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border/70 pt-2">
                  {onUpdateEvent && (
                    <button type="button" onClick={() => startEdit(event, index)} className="rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground hover:border-primary/40 hover:text-primary">
                      <Pencil className="mr-1 inline h-3 w-3" /> Edit
                    </button>
                  )}
                  {onDeleteEvent && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <button type="button" className="rounded-md border border-destructive/30 px-2 py-1 text-[10px] font-medium text-destructive hover:bg-destructive/10">
                          <Trash2 className="mr-1 inline h-3 w-3" /> Delete
                        </button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this event annotation?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This removes the note at {_fmtMmSs(event.time_s)} from the session timeline. This cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => onDeleteEvent(index)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                            Delete annotation
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                  {event.source === "motion_derived" && onUpdateMotionVerification && (
                    <>
                      <button type="button" onClick={() => onUpdateMotionVerification(index, "reviewed_verified")} className="rounded-md border border-emerald-400/25 px-2 py-1 text-[10px] font-medium text-emerald-300 hover:bg-emerald-400/10">
                        Mark verified
                      </button>
                      <button type="button" onClick={() => onUpdateMotionVerification(index, "reviewed_adjusted")} className="rounded-md border border-amber-400/25 px-2 py-1 text-[10px] font-medium text-amber-300 hover:bg-amber-400/10">
                        Mark adjusted
                      </button>
                      {verified && (
                        <button type="button" onClick={() => onUpdateMotionVerification(index, "unverified")} className="rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground hover:text-foreground">
                          Clear verification
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!filteredEvents.length && (
          <p className="rounded-lg border border-border bg-card/50 px-3 py-3 text-sm text-muted-foreground">
            No event notes match this filter.
          </p>
        )}
      </div>
    </div>
  );
}

export default function SessionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const sessionRef = useRef(null);
  const aiAnalysisSaveQueueRef = useRef(Promise.resolve());
  const [rawTimelineRows, setRawTimelineRows] = useState([]);
  const [rawEmgRows, setRawEmgRows] = useState([]);
  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedNearClimaxIdx, setSelectedNearClimaxIdx] = useState(null);
  const [selectedEventIdx, setSelectedEventIdx] = useState(null);
  const [timelineWaypointDetail, setTimelineWaypointDetail] = useState(null);
  const [lightboxPhoto, setLightboxPhoto] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [sessionNotes, setSessionNotes] = useState("");
  const [sessionJournal, setSessionJournal] = useState(null);
  const [pendingSectionId, setPendingSectionId] = useState("");
  const [pendingTimestampReview, setPendingTimestampReview] = useState(null);
  const [inspectionTime, setInspectionTime] = useState(0);
  const [nearbyBloodPressure, setNearbyBloodPressure] = useState([]);
  const [bpAttachBusy, setBpAttachBusy] = useState(false);
  const [bpAttachStatus, setBpAttachStatus] = useState("");
  const [trimDraftStart, setTrimDraftStart] = useState("");
  const [trimDraftEnd, setTrimDraftEnd] = useState("");
  const [trimBusy, setTrimBusy] = useState(false);
  const [trimStatus, setTrimStatus] = useState("");
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const analysisTrim = useMemo(
    () => normalizeAnalysisTrim(session?.analysis_trim, rawTimelineRows, rawEmgRows),
    [session?.analysis_trim, rawTimelineRows, rawEmgRows],
  );
  const trimmedView = useMemo(
    () => buildTrimmedSessionView(session, rawTimelineRows, rawEmgRows, analysisTrim),
    [session, rawTimelineRows, rawEmgRows, analysisTrim],
  );
  const displaySession = trimmedView.session;
  const timelineRows = trimmedView.timelineRows;
  const emgRows = trimmedView.emgRows;
  const rawSessionEndSec = useMemo(() => getSessionMaxOffset(rawTimelineRows, rawEmgRows), [rawTimelineRows, rawEmgRows]);
  const trimOffsetToRaw = useCallback((value) => {
    const numericValue = readNumericTime(value);
    if (numericValue == null) return null;
    return roundTrimSeconds(numericValue + (analysisTrim?.start_s || 0));
  }, [analysisTrim]);
  const trimNearClimaxEventsToRaw = useCallback((events = []) => {
    if (!analysisTrim) return events;
    return events.map((event) => ({
      ...event,
      start_offset_s: readNumericTime(event?.start_offset_s) == null ? event?.start_offset_s : trimOffsetToRaw(event.start_offset_s),
      peak_offset_s: readNumericTime(event?.peak_offset_s) == null ? event?.peak_offset_s : trimOffsetToRaw(event.peak_offset_s),
      end_offset_s: readNumericTime(event?.end_offset_s) == null ? event?.end_offset_s : trimOffsetToRaw(event.end_offset_s),
    }));
  }, [analysisTrim, trimOffsetToRaw]);

  const refreshNearbyBloodPressure = useCallback(async (sessionId) => {
    if (!sessionId) {
      setNearbyBloodPressure([]);
      return;
    }
    try {
      const result = await findBloodPressureNearSession(sessionId, { beforeHours: 1, afterHours: 2 });
      setNearbyBloodPressure(Array.isArray(result?.readings) ? result.readings : []);
    } catch (error) {
      console.warn("[SessionDetail] Nearby BP lookup failed", error);
      setNearbyBloodPressure([]);
    }
  }, []);

  const handleAttachBloodPressure = useCallback(async (readingIds = []) => {
    const currentSession = sessionRef.current;
    if (!currentSession?.id || !readingIds.length) return;
    setBpAttachBusy(true);
    setBpAttachStatus("Attaching nearby blood pressure readings to this session...");
    try {
      const result = await attachBloodPressureToSession(currentSession.id, readingIds);
      const nextSession = result?.session || currentSession;
      sessionRef.current = nextSession;
      setSession(nextSession);
      const attached = Number(result?.attached || 0);
      setBpAttachStatus(
        attached
          ? `Attached ${attached} blood pressure reading${attached === 1 ? "" : "s"} to this session.`
          : "Those blood pressure readings were already attached to this session.",
      );
      await refreshNearbyBloodPressure(currentSession.id);
    } catch (error) {
      setBpAttachStatus(error?.message || "Could not attach blood pressure readings.");
    } finally {
      setBpAttachBusy(false);
    }
  }, [refreshNearbyBloodPressure]);

  const handleChatMessagesSave = useCallback(async (messages) => {
    const currentSession = sessionRef.current;
    if (!currentSession?.id) return;
    const cleanMessages = sanitizeSessionChatMessages(messages);
    const aiAnalysis = {
      ...(currentSession.ai_analysis || {}),
      _chat_messages: cleanMessages,
    };
    const nextSession = { ...currentSession, ai_analysis: aiAnalysis };
    sessionRef.current = nextSession;
    setChatMessages(cleanMessages);
    setSession(nextSession);
    aiAnalysisSaveQueueRef.current = aiAnalysisSaveQueueRef.current
      .catch(() => {})
      .then(() => base44.entities.Session.update(currentSession.id, { ai_analysis: aiAnalysis }));
    await aiAnalysisSaveQueueRef.current;
  }, []);

  const handleSessionNotesSave = useCallback(async (merged, meta = {}) => {
    const currentSession = sessionRef.current;
    if (!currentSession?.id) return;
    setSessionNotes(merged);
    const conversation = sanitizeSessionChatMessages(Array.isArray(meta.conversation)
      ? meta.conversation
      : currentSession.ai_analysis?._chat_messages || []);
    const nextAiAnalysis = {
      ...(currentSession.ai_analysis || {}),
      _chat_messages: conversation,
    };
    const patch = {
      notes: merged,
      ai_analysis: nextAiAnalysis,
    };
    let nextSession = { ...currentSession, notes: merged };
    setChatMessages(conversation);

    if (isVisualReviewSource(meta.source)) {
      const visualEntry = makeSessionVisualEvidenceEntry(meta, merged);
      const visualFindings = normalizeSessionVisualEvidence([
        visualEntry,
        ...(currentSession.ai_analysis?._visual_findings || []),
      ]);
      patch.ai_analysis = {
        ...nextAiAnalysis,
        _visual_findings: visualFindings,
      };
      nextSession = { ...nextSession, ai_analysis: patch.ai_analysis };
    } else {
      nextSession = { ...nextSession, ai_analysis: nextAiAnalysis };
    }

    sessionRef.current = nextSession;
    setSession(nextSession);
    aiAnalysisSaveQueueRef.current = aiAnalysisSaveQueueRef.current
      .catch(() => {})
      .then(() => base44.entities.Session.update(currentSession.id, patch));
    await aiAnalysisSaveQueueRef.current;
  }, []);

  const handleAnalysisSaved = useCallback((field, value) => {
    setSession((current) => {
      if (!current) return current;
      if (field === "ai_analysis") {
        return {
          ...current,
          ai_analysis: {
            ...(current.ai_analysis || {}),
            ...(value || {}),
          },
        };
      }
      return { ...current, [field]: value };
    });
  }, []);

  const savePhaseMarkers = useCallback(async (markers) => {
    if (!id) return;
    const nextMarkers = {
      pre_climax_offset_s: trimOffsetToRaw(markers.pre_climax_offset_s),
      climax_offset_s: trimOffsetToRaw(markers.climax_offset_s),
      recovery_offset_s: trimOffsetToRaw(markers.recovery_offset_s),
    };
    const patch = {
      ...nextMarkers,
      phase_markers_updated_at: new Date().toISOString(),
    };
    const preClimax = Number(nextMarkers.pre_climax_offset_s);
    const climax = Number(nextMarkers.climax_offset_s);
    if (Number.isFinite(preClimax) && Number.isFinite(climax) && rawTimelineRows.length) {
      const lo = Math.min(preClimax, climax);
      const hi = Math.max(preClimax, climax);
      const seg = rawTimelineRows.filter((row) => {
        const t = Number(row.time_offset_s);
        return Number.isFinite(t) && t >= lo && t <= hi;
      });
      patch.hr_avg_pre_to_climax = seg.length
        ? Math.round(seg.reduce((sum, row) => sum + Number(row.hr_smoothed || row.hr || 0), 0) / seg.length)
        : null;
    } else if ("pre_climax_offset_s" in markers || "climax_offset_s" in markers) {
      patch.hr_avg_pre_to_climax = null;
    }
    if (Number.isFinite(climax) && rawTimelineRows.length) {
      const win = rawTimelineRows.filter((row) => {
        const t = Number(row.time_offset_s);
        return Number.isFinite(t) && Math.abs(t - climax) <= 30;
      });
      patch.hr_avg_at_climax_window = win.length
        ? Math.round(win.reduce((sum, row) => sum + Number(row.hr_smoothed || row.hr || 0), 0) / win.length)
        : null;
    } else if ("climax_offset_s" in markers) {
      patch.hr_avg_at_climax_window = null;
    }
    await base44.entities.Session.update(id, patch);
    setSession((prev) => (prev ? { ...prev, ...patch } : prev));
  }, [id, rawTimelineRows, trimOffsetToRaw]);

  const handleMotionVerificationUpdate = useCallback(async (eventIndex, verificationStatus) => {
    if (!session?.id) return;
    const currentEvents = Array.isArray(session.event_timeline) ? session.event_timeline : [];
    const displayedEvents = Array.isArray(displaySession?.event_timeline) ? displaySession.event_timeline : [];
    const displayedEvent = displayedEvents[eventIndex];
    const rawIndex = Number.isInteger(displayedEvent?._trim_original_index) ? displayedEvent._trim_original_index : eventIndex;
    const selectedEvent = currentEvents[rawIndex];
    if (!selectedEvent || selectedEvent.source !== "motion_derived") return;
    const verified = verificationStatus === "reviewed_verified" || verificationStatus === "reviewed_adjusted";
    const nextEvent = {
      ...selectedEvent,
      verification_status: verified ? verificationStatus : "unverified",
      verified_at: verified ? new Date().toISOString() : null,
      verified_by: verified ? "user" : null,
    };
    const eventTimeline = currentEvents.map((event, index) => (index === rawIndex ? nextEvent : event));
    await base44.entities.Session.update(session.id, { event_timeline: eventTimeline });
    setSession((current) => (current ? { ...current, event_timeline: eventTimeline } : current));
  }, [displaySession, session]);
  const handleEventAnnotationUpdate = useCallback(async (eventIndex, updatedEvent) => {
    if (!session?.id) return;
    const currentEvents = Array.isArray(session.event_timeline) ? session.event_timeline : [];
    const rawIndex = Number.isInteger(updatedEvent?._trim_original_index) ? updatedEvent._trim_original_index : eventIndex;
    const nextEvent = {
      ...updatedEvent,
      time_s: trimOffsetToRaw(updatedEvent?.time_s),
    };
    delete nextEvent._trim_original_index;
    const eventTimeline = currentEvents
      .map((event, index) => (index === rawIndex ? nextEvent : event))
      .sort((a, b) => Number(a.time_s) - Number(b.time_s));
    await base44.entities.Session.update(session.id, { event_timeline: eventTimeline });
    setSelectedEventIdx(null);
    setSession((current) => (current ? { ...current, event_timeline: eventTimeline } : current));
  }, [session, trimOffsetToRaw]);
  const handleEventAnnotationDelete = useCallback(async (eventIndex) => {
    if (!session?.id) return;
    const currentEvents = Array.isArray(session.event_timeline) ? session.event_timeline : [];
    const displayedEvents = Array.isArray(displaySession?.event_timeline) ? displaySession.event_timeline : [];
    const displayedEvent = displayedEvents[eventIndex];
    const rawIndex = Number.isInteger(displayedEvent?._trim_original_index) ? displayedEvent._trim_original_index : eventIndex;
    const eventTimeline = currentEvents.filter((_event, index) => index !== rawIndex);
    await base44.entities.Session.update(session.id, { event_timeline: eventTimeline });
    setSelectedEventIdx(null);
    setSession((current) => (current ? { ...current, event_timeline: eventTimeline } : current));
  }, [displaySession, session]);
  const handleDeleteAllEventNotes = useCallback(async () => {
    if (!session?.id) return;
    await base44.entities.Session.update(session.id, { event_timeline: [] });
    setSelectedEventIdx(null);
    setSession((current) => (current ? { ...current, event_timeline: [] } : current));
  }, [session?.id]);

  const nearClimaxEvents = useMemo(() => {
    if (!displaySession) return [];
    if (displaySession.ai_near_climax_events?.length > 0) return displaySession.ai_near_climax_events;
    return detectNearClimaxEvents(timelineRows, displaySession.climax_offset_s, displaySession.pre_climax_offset_s);
  }, [displaySession, timelineRows]);

  useEffect(() => {
    const events = displaySession?.event_timeline || [];
    if (!events.length || !Number.isFinite(Number(inspectionTime))) return;
    const nearestIndex = events.reduce((closestIndex, event, index) => (
      Math.abs(Number(event.time_s) - Number(inspectionTime))
        < Math.abs(Number(events[closestIndex].time_s) - Number(inspectionTime))
        ? index
        : closestIndex
    ), 0);
    setSelectedEventIdx(nearestIndex);
  }, [displaySession?.event_timeline, inspectionTime]);

  useEffect(() => {
    setTrimDraftStart(analysisTrim ? String(analysisTrim.start_s) : "");
    setTrimDraftEnd(analysisTrim ? String(analysisTrim.end_s) : rawSessionEndSec > 0 ? String(roundTrimSeconds(rawSessionEndSec)) : "");
    setTrimStatus("");
  }, [analysisTrim?.end_s, analysisTrim?.start_s, rawSessionEndSec, session?.id]);

  const highlightRange = useMemo(() => {
    if (selectedNearClimaxIdx == null || !nearClimaxEvents[selectedNearClimaxIdx]) return null;
    const ev = nearClimaxEvents[selectedNearClimaxIdx];
    return { start: ev.start_offset_s, end: ev.end_offset_s };
  }, [selectedNearClimaxIdx, nearClimaxEvents]);

  const elevatedTime = timelineRows.length > 1
    ? timelineRows.reduce((total, row, i) => {
        if (i === 0) return total;
        const delta = Number(row.elevated_delta);
        if (isNaN(delta) || delta <= 8) return total;
        const dt = Number(row.time_offset_s) - Number(timelineRows[i - 1].time_offset_s);
        return total + (dt > 0 ? dt : 0);
      }, 0)
    : null;

  const handleApplyAnalysisTrim = useCallback(async () => {
    if (!id || !(rawSessionEndSec > 0)) return;
    const start = Math.max(0, Number(trimDraftStart || 0));
    const end = Math.min(rawSessionEndSec, Number(trimDraftEnd || rawSessionEndSec));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      setTrimStatus("Pick a valid trim window. The end needs to be after the start.");
      return;
    }
    if (end - start < 15) {
      setTrimStatus("Keep at least 15 seconds in the trimmed analysis window.");
      return;
    }
    const nextTrim = normalizeAnalysisTrim(
      { start_s: start, end_s: end },
      rawTimelineRows,
      rawEmgRows,
    );
    setTrimBusy(true);
    setTrimStatus("Saving analysis trim...");
    try {
      await base44.entities.Session.update(id, { analysis_trim: nextTrim ? { start_s: nextTrim.start_s, end_s: nextTrim.end_s } : null });
      setSession((prev) => (prev ? { ...prev, analysis_trim: nextTrim ? { start_s: nextTrim.start_s, end_s: nextTrim.end_s } : null } : prev));
      setTrimStatus(nextTrim
        ? `Analysis view now starts at ${_fmtMmSs(nextTrim.start_s)} and ends at ${_fmtMmSs(nextTrim.end_s)}. Raw source timing stays untouched.`
        : "Analysis trim cleared.");
    } catch (error) {
      setTrimStatus(error?.message || "Could not save the trim window.");
    } finally {
      setTrimBusy(false);
    }
  }, [id, rawEmgRows, rawSessionEndSec, rawTimelineRows, trimDraftEnd, trimDraftStart]);

  const handleClearAnalysisTrim = useCallback(async () => {
    if (!id) return;
    setTrimBusy(true);
    setTrimStatus("Clearing analysis trim...");
    try {
      await base44.entities.Session.update(id, { analysis_trim: null });
      setSession((prev) => (prev ? { ...prev, analysis_trim: null } : prev));
      setTrimStatus("Analysis trim cleared. The full raw session is back in view.");
    } catch (error) {
      setTrimStatus(error?.message || "Could not clear the trim window.");
    } finally {
      setTrimBusy(false);
    }
  }, [id]);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const [all, me] = await Promise.all([
          base44.entities.Session.filter({ id }),
          loadUserProfileWithProfilerResults(),
        ]);
        const s = all[0];
        sessionRef.current = s;
        setSession(s);
        setBpAttachStatus("");
        setUserProfile(me);
        const savedChatMessages = sanitizeSessionChatMessages(s?.ai_analysis?._chat_messages || []);
        setChatMessages(savedChatMessages);
        setSessionNotes(s?.notes || "");
        await refreshNearbyBloodPressure(id);
        const rows = await base44.entities.HeartRateTimeline.filter({ session: id }, "time_offset_s", 10000);

        // Load journal for this session so it can be factored into AI analyses
        base44.entities.Journal.filter({ session_id: id }, "-created_date", 10).then((rows) => {
          const rowWithStoryline = rows.find((row) => journalHasStoryline(row.ai_journal));
          if (rowWithStoryline?.ai_journal) setSessionJournal(normalizeJournalEntry(rowWithStoryline.ai_journal));
        }).catch((error) => {
          console.warn("[SessionDetail] Journal load failed", error);
        });
        setRawTimelineRows(rows);

        // Load EMG data from the stored CSV file (client-side parse — no DB rows needed)
        if (s?.emg_data_file) {
          try {
            const csvResp = await fetch(serverUrl(s.emg_data_file));
            const text = await csvResp.text();
            const { parseEmgCsv } = await import("../utils/parseEmgCsv");
            const result = parseEmgCsv(text);
            if (!result.error) {
              const startRow = result.rows.find((r) => r.marker === "RECORD_START");
              const timeZero = startRow ? startRow.time_s : result.rows[0]?.time_s ?? 0;
              setRawEmgRows(result.rows.map((r) => ({ ...r, time_s: parseFloat((r.time_s - timeZero).toFixed(6)) })));
            }
          } catch {
            setRawEmgRows([]);
          }
        } else {
          setRawEmgRows([]);
        }

        const hasEventNotes = (s?.event_timeline || []).some((event) => String(event?.note || "").trim());

        // Auto-detect phase markers if not already set. Use the old HR-only fallback only
        // when no event notes exist; noted sessions need full timeline context.
        if (rows.length > 10 && s && !s.climax_offset_s && !hasEventNotes) {
          // Climax: peak HR in last 60% of session
          const startIdx = Math.floor(rows.length * 0.25);
          let peakIdx = startIdx;
          for (let i = startIdx; i < rows.length; i++) {
            if (Number(rows[i].hr) > Number(rows[peakIdx].hr)) peakIdx = i;
          }
          const climaxOffset = Number(rows[peakIdx].time_offset_s);

          // Pre-climax: lowest HR point within 5 min before climax
          const windowStart = climaxOffset - 300;
          const windowEnd = climaxOffset - 15;
          let valleyIdx = peakIdx;
          let foundInWindow = false;
          for (let i = 0; i < rows.length; i++) {
            const t = Number(rows[i].time_offset_s);
            if (t < windowStart) continue;
            if (t > windowEnd) break;
            if (!foundInWindow || Number(rows[i].hr) < Number(rows[valleyIdx].hr)) {
              valleyIdx = i;
              foundInWindow = true;
            }
          }
          const preClimaxOffset = Number(rows[valleyIdx].time_offset_s);

          // Recovery: first point after 15s where HR is falling for 4 consecutive samples and dropped 2%
          const peakHr = Number(rows[peakIdx].hr);
          let searchStart = peakIdx + 1;
          for (let i = peakIdx + 1; i < rows.length; i++) {
            if (Number(rows[i].time_offset_s) >= Number(rows[peakIdx].time_offset_s) + 15) { searchStart = i; break; }
          }
          let recoveryIdx = Math.min(searchStart, rows.length - 1);
          for (let i = searchStart; i <= rows.length - 4; i++) {
            const hr = Number(rows[i].hr);
            if (
              hr < Number(rows[i - 1].hr) &&
              Number(rows[i + 1].hr) < hr &&
              Number(rows[i + 2].hr) < Number(rows[i + 1].hr) &&
              Number(rows[i + 3].hr) < Number(rows[i + 2].hr) &&
              hr <= peakHr * 0.98
            ) {
              recoveryIdx = i;
              break;
            }
          }
          const recoveryOffset = Number(rows[recoveryIdx].time_offset_s);

          const updates = {
            pre_climax_offset_s: preClimaxOffset,
            climax_offset_s: climaxOffset,
            recovery_offset_s: recoveryOffset,
            phase_markers_updated_at: new Date().toISOString(),
          };

          // Compute HR metrics
          const lo = Math.min(preClimaxOffset, climaxOffset);
          const hi = Math.max(preClimaxOffset, climaxOffset);
          const seg = rows.filter((r) => Number(r.time_offset_s) >= lo && Number(r.time_offset_s) <= hi);
          if (seg.length > 0) updates.hr_avg_pre_to_climax = Math.round(seg.reduce((a, r) => a + Number(r.hr), 0) / seg.length);

          const win = rows.filter((r) => Math.abs(Number(r.time_offset_s) - climaxOffset) <= 30);
          if (win.length > 0) updates.hr_avg_at_climax_window = Math.round(win.reduce((a, r) => a + Number(r.hr), 0) / win.length);

          await base44.entities.Session.update(id, updates);
          setSession((prev) => ({ ...prev, ...updates }));
        } else if (rows.length > 0 && s && (!s.hr_avg_pre_to_climax || !s.hr_avg_at_climax_window)) {
          // Auto-compute phase HR metrics for existing sessions with markers but no computed values
          const updates = {};
          if (s.pre_climax_offset_s != null && s.climax_offset_s != null && !s.hr_avg_pre_to_climax) {
            const lo = Math.min(s.pre_climax_offset_s, s.climax_offset_s);
            const hi = Math.max(s.pre_climax_offset_s, s.climax_offset_s);
            const seg = rows.filter((r) => Number(r.time_offset_s) >= lo && Number(r.time_offset_s) <= hi);
            if (seg.length > 0)
              updates.hr_avg_pre_to_climax = Math.round(seg.reduce((a, r) => a + Number(r.hr), 0) / seg.length);
          }
          if (s.climax_offset_s != null && !s.hr_avg_at_climax_window) {
            const win = rows.filter((r) => Math.abs(Number(r.time_offset_s) - s.climax_offset_s) <= 30);
            if (win.length > 0)
              updates.hr_avg_at_climax_window = Math.round(win.reduce((a, r) => a + Number(r.hr), 0) / win.length);
          }
          if (Object.keys(updates).length > 0) {
            await base44.entities.Session.update(id, updates);
            setSession((prev) => ({ ...prev, ...updates }));
          }
        }
      } catch (error) {
        console.error("[SessionDetail] Failed to load session detail", error);
      } finally {
        setLoading(false);
      }
    })();
  }, [id, refreshNearbyBloodPressure]);

  useEffect(() => {
    if (!pendingSectionId) return undefined;

    const frame = window.requestAnimationFrame(() => {
      const section = document.getElementById(pendingSectionId);
      if (!section) return;
      section.scrollIntoView({ behavior: "smooth", block: "start" });
      setPendingSectionId("");
    });

    return () => window.cancelAnimationFrame(frame);
  }, [pendingSectionId]);

  useEffect(() => {
    if (loading || typeof window === "undefined" || window.location.hash) return undefined;
    const scrollTop = () => {
      document.querySelector("main")?.scrollTo({ top: 0, left: 0, behavior: "auto" });
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    };
    const frame = window.requestAnimationFrame(() => {
      scrollTop();
      window.setTimeout(scrollTop, 180);
      window.setTimeout(scrollTop, 720);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [id, loading]);

  const handleDelete = async () => {
    await base44.entities.Session.delete(id);
    navigate("/sessions");
  };

  const toggleFav = async () => {
    await base44.entities.Session.update(id, { is_favorite: !session.is_favorite });
    setSession((s) => ({ ...s, is_favorite: !s.is_favorite }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!session) {
    return <div className="p-6 text-center text-muted-foreground">Session not found</div>;
  }

  const s = displaySession;
  const cap = (str) => str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
  const contextRows = sessionContextDisplayRows(s);
  const bloodPressureReadings = bloodPressureReadingsFromSession(s);
  const attachableBloodPressureReadings = nearbyBloodPressure.filter((reading) => !bloodPressureReadings.some((attached) => attached.id && attached.id === reading.id));
  const pulseOxReadings = pulseOxReadingsFromSession(s);
  const recorded = (value) => value !== undefined && value !== null && value !== "";
  const metricBadges = [
    { label: s.no_climax ? "Peak Arousal" : "Peak Intensity", value: s.intensity },
    { label: "Build Quality", value: s.build_quality },
    { label: "Satisfaction", value: s.satisfaction },
    !s.no_climax ? { label: "Release Completeness", value: s.release_completeness } : null,
    { label: "Arousal Depth", value: s.arousal_depth },
    s.no_climax ? { label: "Arousal Sustainability", value: s.sustainability } : null,
    { label: "Erection / Response Stability", value: s.erection_stability },
    { label: "Stimulation Fit", value: s.stimulation_fit },
    { label: "Edge / Control Quality", value: s.control },
    { label: "Sensory Immersion", value: s.sensory_immersion },
    !s.no_climax ? { label: "Recovery / Afterglow Quality", value: s.recovery_quality } : null,
    { label: "Discomfort / Interruption Impact", value: s.discomfort_interference },
  ].filter((item) => item && recorded(item.value));
  const metricInfoRows = [
    s.build_type ? { label: "Build Type", value: s.build_type === "Other" && s.custom_build_type ? s.custom_build_type : s.build_type } : null,
    !s.no_climax && s.climax_duration ? { label: "Climax Duration", value: cap(s.climax_duration) } : null,
    s.primary_limiting_factor ? { label: "Primary Limiting Factor", value: s.primary_limiting_factor } : null,
    s.no_climax_stop_reason ? { label: "Why It Stopped", value: s.no_climax_stop_reason } : null,
    s.subjective_notes ? { label: "Subjective Notes", value: s.subjective_notes } : null,
    s.barrier_to_completion ? { label: "Barrier to Completion", value: s.barrier_to_completion } : null,
  ].filter(Boolean);
  const hasMetricContent = metricBadges.length > 0 || metricInfoRows.length > 0;
  const perinealEmgSummary = summarizePerinealEmg(s);
  const hasTimelineSection = timelineRows.length > 0 || (s.event_timeline || []).length > 0 || (s.ai_near_climax_events || []).length > 0 || !!s.motion_analysis_summary;
  const reviewedMediaClips = getReviewedVisualClips(s.ai_analysis?._visual_findings || []);
  const linkedLocalVideos = s.linked_local_videos || [];
  const uploadedSessionVideos = Array.isArray(s.media_videos) ? s.media_videos.filter(Boolean) : [];
  const storyVideoSources = buildSessionStoryVideoSources({ linkedVideos: linkedLocalVideos, uploadedVideos: uploadedSessionVideos });
  const companionAnalysisData = buildSessionAnalysisReaderData({
    result: s.ai_analysis,
    session: s,
    timelineRows,
    emgRows,
    isTechnical: false,
  });
  const technicalAnalysisData = buildSessionAnalysisReaderData({
    result: s.ai_session_deep_dive,
    session: s,
    timelineRows,
    emgRows,
    isTechnical: true,
  });
  const technicalVideoSourceGeneratedAt = s.ai_session_deep_dive?._meta?.last_generated_at
    ? `${s.ai_session_deep_dive._meta.last_generated_at}:technical-deep-dive`
    : `${s.id || s.date || "session"}:technical-deep-dive`;
  const sectionLinks = [
    { id: "session-snapshot", label: "Session Snapshot", group: "Overview" },
    { id: "session-telemetry", label: "Evidence Dashboard", group: "Overview" },
    ...(rawSessionEndSec > 0 ? [{ id: "session-analysis-trim", label: "Analysis Trim", group: "Overview" }] : []),
    ...((bloodPressureReadings.length || attachableBloodPressureReadings.length) ? [{ id: "session-blood-pressure", label: "Blood Pressure", group: "Overview" }] : []),
    ...(pulseOxReadings.length ? [{ id: "session-pulse-ox", label: "Pulse Oximetry", group: "Overview" }] : []),
    { id: "session-summary", label: "Executive Summary", group: "Overview" },
    { id: "session-review", label: "Review Checklist", group: "Overview" },
    { id: "session-metrics-context", label: "Metrics & Context", group: "Overview" },
    ...(storyVideoSources.length ? [{ id: "session-story-video", label: "Session Video", group: "Session Story" }] : []),
    { id: "session-mobile-video-render", label: "Mobile Video Render", group: "Session Story" },
    ...(!s.no_climax ? [
      { id: "session-ai-companion", label: "Companion Analysis", group: "Session Story" },
      { id: "session-ai-technical", label: "Technical Deep Dive", group: "Session Story" },
      { id: "session-ai-support", label: "Supporting AI Views", group: "Session Story" },
    ] : []),
    ...(s.no_climax ? [{ id: "session-ai-companion", label: "No-Climax Analysis", group: "Session Story" }] : []),
    ...((emgRows.length > 0 || s.emg_enabled || perinealEmgSummary.hasPerinealEvents || perinealEmgSummary.hasPerinealSetup) ? [{ id: "session-emg", label: "EMG", group: "Physiology" }] : []),
    ...(hasTimelineSection ? [
      { id: "session-timeline", label: "Timeline Player", group: "Timeline & Events" },
      { id: "session-event-notes", label: "Event Notes", group: "Timeline & Events" },
      { id: "session-timeline-advanced", label: "Advanced Views", group: "Timeline & Events" },
    ] : []),
    { id: "session-journal", label: "Journal", group: "Reflection" },
    { id: "session-interview", label: "Ask Sarah", group: "Reflection" },
    { id: "session-devices", label: "Methods & Devices", group: "Session Context" },
    { id: "session-physiology", label: "Body Findings", group: "Session Context" },
    { id: "session-notes", label: "Session Notes", group: "Session Context" },
    { id: "session-media", label: "Media", group: "Session Context" },
    { id: "session-tags", label: "Tags", group: "Session Context" },
  ];
  const selectSection = (section) => {
    setPendingSectionId(section.id);
  };
  const openReviewSection = (target) => {
    const idByTarget = {
      physiology: "session-telemetry",
      timeline: "session-timeline",
      ai: "session-ai-companion",
      journal: "session-journal",
    };
    if (idByTarget[target]) setPendingSectionId(idByTarget[target]);
  };
  const handleAskSarahAtTimestamp = ({ timeSeconds, sourceUrl, timelineOffsetSeconds = 0, sourceLabel = "Session video", sourceKind = "session_video" }) => {
    if (!sourceUrl) return;
    setPendingSectionId("session-interview");
    setPendingTimestampReview({
      requestId: `session-video-review-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      timeSeconds: Math.max(0, Number(timeSeconds) || 0),
      sourceUrl,
      timelineOffsetSeconds: Number(timelineOffsetSeconds) || 0,
      sourceLabel,
      sourceKind,
    });
  };
  const renderReviewVideoBuilder = ({
    id,
    title,
    helper,
    sourceGeneratedAt,
    analysisData,
    routeHash,
  }) => {
    if (!analysisData?.paragraphs?.length) return null;
    return (
      <div id={id} className="scroll-mt-24 rounded-xl border border-primary/20 bg-primary/[0.045] p-3 space-y-2">
        <div className="flex items-start gap-2">
          <Clapperboard className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">{title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{helper}</p>
          </div>
        </div>
        <SessionReviewVideoExportButton
          session={s}
          analysisTitle={title}
          sourceGeneratedAt={sourceGeneratedAt}
          paragraphs={analysisData.paragraphs}
          paragraphMeta={analysisData.paragraphMeta}
          timelineRows={timelineRows}
          emgRows={emgRows}
          routeHash={routeHash}
        />
      </div>
    );
  };
  const sessionStorySection = !s.no_climax ? (
    <section className="space-y-4">
      {storyVideoSources.length > 0 && (
        <SessionStoryVideoPlayer
          linkedVideos={linkedLocalVideos}
          uploadedVideos={uploadedSessionVideos}
          onAskSarahAtTimestamp={handleAskSarahAtTimestamp}
        />
      )}
      <section id="session-ai-companion" className="scroll-mt-24 space-y-3">
        <SessionAIPanel session={s} timelineRows={timelineRows} emgRows={emgRows} userProfile={userProfile} sessionJournal={sessionJournal} onAnalysisSaved={handleAnalysisSaved} />
        {renderReviewVideoBuilder({
          id: "session-ai-video-companion",
          title: "AI Session Analysis",
          helper: "Build a narrated MP4 from the AI Session Analysis above.",
          sourceGeneratedAt: s.ai_analysis?._meta?.last_generated_at,
          analysisData: companionAnalysisData,
          routeHash: "session-ai-companion",
        })}
      </section>
      <section id="session-ai-technical" className="scroll-mt-24 space-y-3">
        <SessionAIPanel session={s} timelineRows={timelineRows} emgRows={emgRows} userProfile={userProfile} sessionJournal={sessionJournal} mode="technical" onAnalysisSaved={handleAnalysisSaved} />
        {renderReviewVideoBuilder({
          id: "session-ai-video-technical",
          title: "Technical Deep Dive",
          helper: "Build a narrated MP4 from the Technical Deep Dive above.",
          sourceGeneratedAt: technicalVideoSourceGeneratedAt,
          analysisData: technicalAnalysisData,
          routeHash: "session-ai-technical",
        })}
      </section>
      <section id="session-ai-support" className="scroll-mt-24 rounded-xl border border-primary/20 bg-card p-4 space-y-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Timeline & Cascade Analysis</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Main story cards for phase timing, arousal narrative, and climax cascade video generation.
          </p>
        </div>
        <CascadeOverviewPanel session={s} timelineRows={timelineRows} emgRows={emgRows} userProfile={userProfile} sessionJournal={sessionJournal} />
        <SessionTimelineNarrative session={s} timelineRows={timelineRows} userProfile={userProfile} sessionJournal={sessionJournal} />
        <details className="rounded-xl border border-border bg-muted/10 p-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">
            Supporting Evidence Pattern View
          </summary>
          <div className="mt-3">
            <SessionEvidencePatternPanel session={s} timelineRows={timelineRows} userProfile={userProfile} sessionJournal={sessionJournal} />
          </div>
        </details>
      </section>
    </section>
  ) : (
    <section id="session-ai-companion" className="scroll-mt-24">
      <NoClimaxAIPanel session={s} timelineRows={timelineRows} userProfile={userProfile} />
    </section>
  );

  return (
    <div className="w-full max-w-[100vw] overflow-x-hidden overscroll-x-none">
      <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2 px-3 pt-4 md:px-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold">{moment(s.date).format("MMM D, YYYY")}</h1>
          <p className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground">
            {s.start_time && <><Clock className="w-3 h-3" />{s.start_time}</>}
            {s.end_time && ` – ${s.end_time}`}
            {s.duration_minutes && <> · <strong>{s.duration_minutes}m</strong></>}
            {s.is_quick_entry && <><Zap className="w-3 h-3 ml-1" /> Quick</>}
            {s.no_climax && (
              <span className="inline-flex items-center gap-1 ml-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
                <XCircle className="w-3 h-3" /> No Climax
              </span>
            )}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => navigate(`/sessions/${id}/edit`)} className="shrink-0">
          <Pencil className="w-5 h-5 text-muted-foreground" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="hidden gap-1.5 md:inline-flex"
          onClick={() => navigate(`/motion-lab?session=${encodeURIComponent(s.id)}`)}
        >
          <Activity className="h-3.5 w-3.5" />
          Motion Lab
        </Button>
        <SessionExportButton session={s} timelineRows={timelineRows} />
        <Button variant="ghost" size="icon" onClick={toggleFav} className="shrink-0">
          <Star className={`w-5 h-5 ${s.is_favorite ? "text-yellow-500 fill-yellow-500" : "text-muted-foreground"}`} />
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" className="shrink-0"><Trash2 className="w-5 h-5 text-destructive" /></Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete session?</AlertDialogTitle>
              <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <SessionSectionNavigator sections={sectionLinks} onSelect={selectSection} />

      <div className="min-w-0 max-w-full space-y-4 overflow-x-hidden px-3 py-4 pb-24 md:px-4 xl:pr-60 [overflow-wrap:anywhere]">
        <section id="session-snapshot" className="scroll-mt-24">
          <SessionSnapshotHero session={s} timelineRows={timelineRows} motionSummary={s.motion_analysis_summary} />
        </section>

        <SessionTelemetryDashboard
          session={s}
          timelineRows={timelineRows}
          emgRows={emgRows}
          nearClimaxEvents={nearClimaxEvents}
          highlightRange={highlightRange}
          selectedEventIndex={selectedEventIdx}
          onSelectEventIndex={setSelectedEventIdx}
          inspectionTime={inspectionTime}
          onInspectionTimeChange={setInspectionTime}
          onMarkersChange={savePhaseMarkers}
          onOpenReview={() => navigate(`/review-player?session=${encodeURIComponent(s.id)}`)}
        />
        {rawSessionEndSec > 0 && (
          <section id="session-analysis-trim" className="scroll-mt-24 rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                  <Clock className="h-3.5 w-3.5" /> Analysis Trim
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Trim away pre-table lead-in or other dead air for charts, phase markers, and AI review without touching the raw source video.
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                {analysisTrim
                  ? `Showing ${_fmtMmSs(analysisTrim.start_s)} to ${_fmtMmSs(analysisTrim.end_s)} (${_fmtMmSs(analysisTrim.duration_s)}).`
                  : `Showing full session window (${_fmtMmSs(rawSessionEndSec)}).`}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,140px)_minmax(0,140px)_auto_auto] lg:items-end">
              <label className="space-y-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Start (seconds)
                <input
                  type="number"
                  min={0}
                  step="0.1"
                  value={trimDraftStart}
                  onChange={(event) => setTrimDraftStart(event.target.value)}
                  className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm font-mono text-foreground"
                />
              </label>
              <label className="space-y-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                End (seconds)
                <input
                  type="number"
                  min={0}
                  step="0.1"
                  value={trimDraftEnd}
                  onChange={(event) => setTrimDraftEnd(event.target.value)}
                  className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm font-mono text-foreground"
                />
              </label>
              <Button onClick={handleApplyAnalysisTrim} disabled={trimBusy}>
                {trimBusy ? "Saving..." : "Apply Trim"}
              </Button>
              <Button variant="outline" onClick={handleClearAnalysisTrim} disabled={trimBusy || !analysisTrim}>
                Clear Trim
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Tip: after trimming, the visible timeline resets to zero for the kept window. Raw source timestamps and video files stay unchanged.
            </p>
            {trimStatus && <p className="text-xs text-muted-foreground">{trimStatus}</p>}
          </section>
        )}
        {(bloodPressureReadings.length > 0 || attachableBloodPressureReadings.length > 0 || bpAttachStatus) && (
          <div id="session-blood-pressure" className="scroll-mt-24 space-y-4">
            {(attachableBloodPressureReadings.length > 0 || bpAttachStatus) && (
              <BloodPressureAttachPanel
                attachedReadings={bloodPressureReadings}
                nearbyReadings={nearbyBloodPressure}
                attachBusy={bpAttachBusy}
                attachStatus={bpAttachStatus}
                onAttachReadings={handleAttachBloodPressure}
              />
            )}
            {bloodPressureReadings.length > 0 && <BloodPressureSessionChart session={s} />}
          </div>
        )}
        {pulseOxReadings.length > 0 && <PulseOxSessionChart session={s} />}
        {timelineRows.length > 0 && (
          <details className="rounded-xl border border-border bg-card p-4">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">
              Marker Tools & Supporting Physiological Analysis
            </summary>
            <div className="mt-3 space-y-3">
              {!s.no_climax && (
                <AIPhaseMarkerSuggester
                  session={s}
                  timelineRows={timelineRows}
                  userProfile={userProfile}
                  onApply={savePhaseMarkers}
                />
              )}
              {!s.no_climax && (
                <NearClimaxEvents
                  timelineRows={timelineRows}
                  session={s}
                  selectedIndex={selectedNearClimaxIdx}
                  onSelectIndex={setSelectedNearClimaxIdx}
                  onEventsRefined={(refined) => setSession((prev) => ({ ...prev, ai_near_climax_events: trimNearClimaxEventsToRaw(refined) }))}
                  userProfile={userProfile}
                />
              )}
              {!s.no_climax && nearClimaxEvents.length > 0 && (
                <NearClimaxSessionOverview session={s} nearClimaxEvents={nearClimaxEvents} userProfile={userProfile} />
              )}
              <HRZoneAnalysis rows={timelineRows} sessionMaxHR={s.max_hr} userProfile={userProfile} />
              <HRPhysiologicalAnalysis timelineRows={timelineRows} session={s} />
            </div>
          </details>
        )}
        {timelineRows.length === 0 && s.hr_timeline?.length > 0 && (
          <div className="rounded-xl border border-border bg-card p-4 space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Heart Rate Timeline</h3>
            <div className="h-32">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={s.hr_timeline}>
                  <XAxis dataKey="minute" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} domain={["auto", "auto"]} />
                  <Tooltip />
                  <Line type="monotone" dataKey="hr" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {sessionStorySection}
        <MobileSessionVideoRenderPanel session={s} />

        {/* Executive Summary */}
        <section id="session-summary" className="scroll-mt-24 space-y-4">
          <SessionExecutiveSummary
            session={s}
            timelineRows={timelineRows}
            onScoreComputed={async (pct) => {
              if (pct != null && s.ai_analysis?.score !== pct) {
                const updated = { ...(s.ai_analysis || {}), score: pct };
                await base44.entities.Session.update(id, { ai_analysis: updated });
                setSession((prev) => ({ ...prev, ai_analysis: updated }));
              }
            }}
          />

          <section id="session-review" className="scroll-mt-24">
            <PostSessionReviewWizard
              session={s}
              timelineRows={timelineRows}
              emgRows={emgRows}
              onOpenTab={openReviewSection}
              onEdit={() => navigate(`/sessions/${id}/edit`)}
              onUpdate={async (updates) => {
                await base44.entities.Session.update(id, updates);
                setSession((prev) => ({ ...prev, ...updates }));
              }}
            />
          </section>
        </section>

        {/* Subjective Metrics */}
        <section id="session-metrics-context" className="scroll-mt-24 space-y-4">
        <div className="bg-card rounded-xl border border-border p-4 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Metrics</h3>
          {hasMetricContent ? (
            <>
              {metricBadges.map((metric) => <MetricBadge key={metric.label} label={metric.label} value={metric.value} />)}
              {metricInfoRows.map((row) => <InfoRow key={row.label} label={row.label} value={row.value} />)}
            </>
          ) : (
            <EmptyPanelNote>No subjective metrics are saved for this session yet. Edit the session to add intensity, build quality, satisfaction, response quality, limiting factors, or no-climax metrics.</EmptyPanelNote>
          )}
        </div>

        <div className="bg-card rounded-xl border border-border p-4 space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary mb-2">Context</h3>
          {contextRows.length ? (
            contextRows.map((row) => <InfoRow key={row.label} label={row.label} value={row.value} />)
          ) : (
            <EmptyPanelNote>No structured context is saved for this session yet. Edit the session to add fatigue, hydration, food state, alcohol/cannabis context, mental state, privacy, environment, or preparation.</EmptyPanelNote>
          )}
        </div>
        </section>

        {/* Heart Rate + Most Recent Side-by-Side */}
        {false && <div id="session-telemetry-legacy" className="scroll-mt-24 bg-card rounded-xl border border-border p-4">
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
            <Heart className="w-3.5 h-3.5" /> Heart Rate
          </h3>
          <div className="grid grid-cols-3 gap-3">
            {[["Avg", s.avg_hr], ["Max", s.max_hr], ["Climax", s.hr_at_climax]].map(([label, val]) => (
              <div key={label} className="text-center">
                <p className="text-2xl font-bold font-mono">{val || "—"}</p>
                <p className="text-xs text-muted-foreground uppercase">{label}</p>
              </div>
            ))}
          </div>
          {!s.no_climax && (s.hr_avg_pre_to_climax || s.hr_avg_at_climax_window) && (
            <div className="grid grid-cols-2 gap-2">
              {s.hr_avg_pre_to_climax && (
                <div className="flex items-center justify-between rounded-lg bg-chart-2/10 px-3 py-2">
                  <span className="text-sm text-muted-foreground">Avg HR Pre→Climax</span>
                  <span className="text-sm font-mono font-bold text-chart-2">{s.hr_avg_pre_to_climax} bpm</span>
                </div>
              )}
              {s.hr_avg_at_climax_window && (
                <div className="flex items-center justify-between rounded-lg bg-chart-3/10 px-3 py-2">
                  <span className="text-sm text-muted-foreground">Avg HR ±30s Climax</span>
                  <span className="text-sm font-mono font-bold text-chart-3">{s.hr_avg_at_climax_window} bpm</span>
                </div>
              )}
            </div>
          )}
          {elevatedTime != null && elevatedTime > 0 && (
            <div className="flex items-center justify-between rounded-lg bg-chart-3/10 px-3 py-2">
              <span className="text-sm text-muted-foreground">Elevated Time <span className="text-xs">(Δ &gt; 8)</span></span>
              <span className="text-sm font-mono font-bold text-chart-3">{Math.floor(elevatedTime / 60) > 0 ? `${Math.floor(elevatedTime / 60)}m ${Math.round(elevatedTime % 60)}s` : `${Math.round(elevatedTime)}s`}</span>
            </div>
          )}
          <div className="space-y-3">
              {timelineRows.length > 0 && (
                <div className="space-y-3">
                  <HRTimelineChart
                    rows={timelineRows}
                    savedMarkers={{
                      pre_climax_offset_s: s.pre_climax_offset_s,
                      climax_offset_s: s.climax_offset_s,
                      recovery_offset_s: s.recovery_offset_s,
                    }}
                    onMarkersChange={savePhaseMarkers}
                    highlightRange={highlightRange}
                    noClimax={!!s.no_climax}
                    nearClimaxEvents={nearClimaxEvents}
                    events={s.event_timeline || []}
                    selectedEventIndex={selectedEventIdx}
                    onSelectEventIndex={setSelectedEventIdx}
                  />
                  <details className="rounded-xl border border-border bg-card p-3">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">
                      Timeline Notes {(s.event_timeline || []).length ? `(${(s.event_timeline || []).length})` : ""}
                    </summary>
                    <div className="mt-3">
                      <EventNotesPanel
                        events={s.event_timeline || []}
                        motionSummary={s.motion_analysis_summary}
                        selectedIndex={selectedEventIdx}
                        onSelect={setSelectedEventIdx}
                        onUpdateEvent={handleEventAnnotationUpdate}
                        onDeleteEvent={handleEventAnnotationDelete}
                        onUpdateMotionVerification={handleMotionVerificationUpdate}
                        helper="Tap a note to highlight its marker on the heart-rate chart."
                      />
                    </div>
                  </details>
                </div>
              )}
              {timelineRows.length > 0 && (
                <details className="rounded-xl border border-border bg-muted/20 p-3">
                  <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">
                    Marker Tools & Supporting Analysis
                  </summary>
                  <div className="mt-3 space-y-3">
                    {!s.no_climax && (
                      <AIPhaseMarkerSuggester
                        session={s}
                        timelineRows={timelineRows}
                        userProfile={userProfile}
                        onApply={savePhaseMarkers}
                      />
                    )}
                    {!s.no_climax && (
                      <NearClimaxEvents
                        timelineRows={timelineRows}
                        session={s}
                        selectedIndex={selectedNearClimaxIdx}
                        onSelectIndex={setSelectedNearClimaxIdx}
                        onEventsRefined={(refined) => setSession((prev) => ({ ...prev, ai_near_climax_events: trimNearClimaxEventsToRaw(refined) }))}
                        userProfile={userProfile}
                      />
                    )}
                    {!s.no_climax && nearClimaxEvents.length > 0 && (
                      <NearClimaxSessionOverview
                        session={s}
                        nearClimaxEvents={nearClimaxEvents}
                        userProfile={userProfile}
                      />
                    )}
                    <HRZoneAnalysis rows={timelineRows} sessionMaxHR={s.max_hr} userProfile={userProfile} />
                    <HRPhysiologicalAnalysis timelineRows={timelineRows} session={s} />
                  </div>
                </details>
              )}
              {timelineRows.length === 0 && s.hr_timeline?.length > 0 && (
                <div className="h-32">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={s.hr_timeline}>
                      <XAxis dataKey="minute" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} domain={["auto", "auto"]} />
                      <Tooltip />
                      <Line type="monotone" dataKey="hr" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
        </div>

        </div>
        </div>}

        {/* EMG */}
        {(emgRows.length > 0 || s.emg_enabled || perinealEmgSummary.hasPerinealEvents || perinealEmgSummary.hasPerinealSetup) && (
          <details id="session-emg" className="scroll-mt-24 rounded-xl border border-border bg-card p-4">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">EMG</summary>
            <div className="mt-3 space-y-3">
            {s.emg_target_area && <p className="text-xs text-muted-foreground">Target: {s.emg_target_area}</p>}
            {emgRows.length > 0 ? (
              <EMGTimelineChart
                rows={emgRows}
                channelMode={s.emg_channels || "single"}
                events={s.event_timeline || []}
                savedMarkers={{
                  pre_climax_offset_s: s.pre_climax_offset_s,
                  climax_offset_s: s.climax_offset_s,
                  recovery_offset_s: s.recovery_offset_s,
                }}
                timelineRows={timelineRows}
              />
            ) : (
              <p className="text-xs text-muted-foreground">EMG recorded but no timeline data imported yet. Edit session to upload CSV.</p>
            )}
            {/* Placement photos (thumbnails) + notes side by side */}
            {(s.emg_placement_photos?.length > 0 || s.emg_general_notes || s.emg_left_placement_notes || s.emg_right_placement_notes) && (
              <div className="flex gap-3 items-start">
                {s.emg_placement_photos?.length > 0 && (
                  <div className="flex flex-col gap-1.5 shrink-0">
                    {s.emg_placement_photos.map((photo, i) => (
                      <button
                        key={i}
                        onClick={() => setLightboxPhoto(photo)}
                        className="block rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-1 focus:ring-primary"
                        title={photo.caption || photo.tag || "View photo"}
                      >
                        <img src={photo.url} alt={photo.caption || ""} className="w-16 h-16 object-cover" />
                      </button>
                    ))}
                  </div>
                )}
                {(s.emg_general_notes || s.emg_left_placement_notes || s.emg_right_placement_notes) && (
                  <div className="flex-1 space-y-1.5 text-xs text-foreground/80">
                    {s.emg_left_placement_notes && (
                      <p><span className="font-semibold text-muted-foreground">Left: </span>{s.emg_left_placement_notes}</p>
                    )}
                    {s.emg_right_placement_notes && (
                      <p><span className="font-semibold text-muted-foreground">Right: </span>{s.emg_right_placement_notes}</p>
                    )}
                    {s.emg_general_notes && <p className="whitespace-pre-wrap">{s.emg_general_notes}</p>}
                  </div>
                )}
              </div>
            )}
            </div>
          </details>
        )}

        {/* Lightbox */}
        {lightboxPhoto && (
          <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
            onClick={() => setLightboxPhoto(null)}
          >
            <div className="max-w-lg w-full space-y-2" onClick={(e) => e.stopPropagation()}>
              <img src={lightboxPhoto.url} alt={lightboxPhoto.caption || ""} className="rounded-xl w-full object-contain max-h-[70vh]" />
              {(lightboxPhoto.caption || lightboxPhoto.tag) && (
                <div className="text-center">
                  {lightboxPhoto.caption && <p className="text-sm text-white">{lightboxPhoto.caption}</p>}
                  {lightboxPhoto.tag && <p className="text-xs text-white/60">{lightboxPhoto.tag}</p>}
                </div>
              )}
              <button
                onClick={() => setLightboxPhoto(null)}
                className="w-full text-xs text-white/60 hover:text-white py-2"
              >
                Tap to close
              </button>
            </div>
          </div>
        )}

        {/* Methods */}
        <details id="session-devices" className="scroll-mt-24 rounded-xl border border-border bg-card p-4">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Methods & Devices</summary>
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {(s.methods || []).map((m) => <Badge key={m} variant="secondary">{m}</Badge>)}
            </div>
            {s.foley_size && <InfoRow label="Foley Size" value={`${s.foley_size} Fr`} />}
            {s.foley_type && <InfoRow label="Foley Type" value={s.foley_type} />}
            {s.estim_notes && <InfoRow label="E-Stim Notes" value={s.estim_notes} />}
            {s.sleeve_type && <InfoRow label="Sleeve" value={s.sleeve_type} />}
            {s.tens_placement && <InfoRow label="TENS Placement" value={s.tens_placement} />}
            {s.estim_screenshot && (
              <img src={s.estim_screenshot} alt="E-Stim settings" className="rounded-lg w-full mt-2" />
            )}
          </div>
        </details>

        {/* Physiological */}
        <details id="session-physiology" className="scroll-mt-24 rounded-xl border border-border bg-card p-4">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Body Findings</summary>
          <div className="mt-3 space-y-1">
          <InfoRow label="Ejaculate Volume" value={cap(s.ejaculate_volume)} />
          {s.discomfort_entries?.length > 0 && (
            <div className="py-2 border-b border-border space-y-1.5">
              <span className="text-sm text-muted-foreground">Discomfort Log</span>
              {s.discomfort_entries.map((e, i) => (
                <div key={i} className="flex items-start gap-2 bg-muted/50 rounded-lg px-3 py-2">
                  <span className="text-xs font-bold text-destructive shrink-0 w-16">Sev {e.severity}/10</span>
                  <span className="text-sm text-foreground leading-snug whitespace-pre-wrap">{e.note}</span>
                </div>
              ))}
            </div>
          )}
          {!s.discomfort_entries?.length && <InfoRow label="Discomfort" value={s.discomfort ? "Yes" : "No"} />}
          {s.unusual_sensations && <InfoRow label="Unusual Sensations" value={s.unusual_sensations} />}
          {s.refractory_notes && <InfoRow label="Refractory Notes" value={s.refractory_notes} />}
          </div>
        </details>

        {/* Notes */}
        {s.notes && (
          <details id="session-notes" className="scroll-mt-24 rounded-xl border border-border bg-card p-4">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Session Notes</summary>
            <p className="mt-3 text-sm whitespace-pre-wrap">{s.notes}</p>
          </details>
        )}

        {/* Media */}
        <details id="session-media" className="scroll-mt-24 rounded-xl border border-border bg-card p-4">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Media</summary>
            <div className="mt-3 space-y-3">
            <LinkedLocalVideoManager
              videos={linkedLocalVideos}
              title="Linked Original Videos"
              helper="Save local references to original recordings for review and Video Sync. The app stores the path and fingerprint metadata only; raw video is not copied into the database."
              onChange={async (nextVideos) => {
                await base44.entities.Session.update(id, { linked_local_videos: nextVideos });
                setSession((prev) => ({ ...prev, linked_local_videos: nextVideos }));
              }}
            />
            {linkedLocalVideos.length > 0 && (
              <details className="rounded-xl border border-border bg-muted/10 p-3" open>
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">
                  Rich Linked Video Playback
                </summary>
                <p className="mt-1 text-xs text-muted-foreground">
                  Play the linked original video with synchronized event notes and telemetry context.
                </p>
                <div className="mt-3">
                  <VideoSyncPlayer
                    key={`media-sync:${s.id}:${linkedLocalVideos.map((video) => video.fingerprint || video.path).join("|")}`}
                    session={s}
                    timelineRows={timelineRows}
                    recordType="session"
                    onEventsChange={(eventTimeline) => {
                      setSelectedEventIdx(null);
                      setSession((current) => (current ? { ...current, event_timeline: eventTimeline } : current));
                    }}
                  />
                </div>
              </details>
            )}
            {linkedLocalVideos.length > 0 && (
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
                      <Sparkles className="h-3.5 w-3.5" /> AI Assisted Annotation
                    </h4>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Run Sarah video/audio passes, choose main vs feet vs lateral interpretation, and accept findings into this session.
                    </p>
                  </div>
                  <Button asChild type="button" size="sm" className="h-8">
                    <Link to={`/sessions/${s.id}/ai-annotation`}>
                      <Clapperboard className="mr-2 h-3.5 w-3.5" /> Open Workbench
                    </Link>
                  </Button>
                </div>
              </div>
            )}
            {s.media_images?.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {s.media_images.map((url, i) => (
                  <img key={i} src={url} alt="" className="rounded-lg w-full aspect-square object-cover" />
                ))}
              </div>
            )}
            {(s.media_videos || []).length > 0 && (
              <div className="space-y-2">
                {s.media_videos.map((url, i) => (
                  <video key={i} src={url} controls className="w-full rounded-lg bg-black" />
                ))}
              </div>
            )}
            {reviewedMediaClips.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Sarah Reviewed Clips</p>
                {reviewedMediaClips.map((clip, i) => (
                  <div key={`${clip.processedClipUrl}-${i}`} className="rounded-lg border border-border bg-muted/20 p-2">
                    <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
                      <span className="font-semibold text-primary">{clip.label || clip.filename || "Reviewed clip"}</span>
                      <span>{clip.evidenceDate || "Undated"} · {clip.startSeconds != null && clip.endSeconds != null ? `${Number(clip.startSeconds).toFixed(1)}-${Number(clip.endSeconds).toFixed(1)}s` : "trimmed clip"}</span>
                    </div>
                    <video src={clip.processedClipUrl} controls className="w-full rounded-lg bg-black" />
                  </div>
                ))}
              </div>
            )}
            {s.video_link && (
              <a href={s.video_link} target="_blank" rel="noopener noreferrer" className="text-sm text-primary underline">
                Video Link →
              </a>
            )}
            </div>
          </details>

        {/* Pause / Active Time */}
        {(() => {
          const events = s.event_timeline || [];
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
          if (totalPause === 0) return null;
          const totalS = (s.duration_minutes || 0) * 60;
          const activeS = totalS > 0 ? Math.max(0, totalS - totalPause) : null;
          const fmtS = (v) => { const m = Math.floor(v / 60); const sec = Math.round(v % 60); return m > 0 ? `${m}m ${sec}s` : `${sec}s`; };
          return (
            <div className="bg-card rounded-xl border border-border p-4 space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Stimulation Timing</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-muted/50 rounded-lg p-3 text-center">
                  <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Paused</p>
                  <p className="text-2xl font-bold font-mono text-destructive">{fmtS(totalPause)}</p>
                </div>
                {activeS != null && (
                  <div className="bg-muted/50 rounded-lg p-3 text-center">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Active</p>
                    <p className="text-2xl font-bold font-mono text-chart-1">{fmtS(activeS)}</p>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Interactive Timeline Player */}
        {(timelineRows.length > 0 || (s.event_timeline || []).length > 0 || (s.ai_near_climax_events || []).length > 0 || s.motion_analysis_summary) && (
          <section id="session-timeline" className="scroll-mt-24 space-y-4">
            {false && <div className="rounded-xl border border-border bg-card p-4 space-y-3">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Timeline Heart Rate Trace</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  The active event in the player is highlighted here so the note stays tied to its HR context.
                </p>
              </div>
              {timelineRows.length > 0 ? (
                <HRTimelineChart
                  rows={timelineRows}
                  savedMarkers={{
                    pre_climax_offset_s: s.pre_climax_offset_s,
                    climax_offset_s: s.climax_offset_s,
                    recovery_offset_s: s.recovery_offset_s,
                  }}
                  highlightRange={highlightRange}
                  noClimax={!!s.no_climax}
                  nearClimaxEvents={nearClimaxEvents}
                  events={s.event_timeline || []}
                  selectedEventIndex={selectedEventIdx}
                  onSelectEventIndex={setSelectedEventIdx}
                  initialWindow="full"
                />
              ) : (
                <p className="rounded-lg border border-border bg-muted/25 px-3 py-3 text-sm text-muted-foreground">
                  No imported heart-rate timeline is available for this session yet.
                </p>
              )}
              <TimelineWaypointDetail
                waypoint={timelineWaypointDetail?.waypoint}
                currentHR={timelineWaypointDetail?.currentHR}
              />
              {s.motion_analysis_summary && (
                <div className="space-y-2 border-t border-border pt-3">
                  <SavedMotionSummaryCard summary={s.motion_analysis_summary} compact showBalanceGauge={false} />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(`/review-player?session=${encodeURIComponent(s.id)}`)}
                    className="gap-1.5"
                  >
                    <Clapperboard className="h-3.5 w-3.5" />
                    Review motion against video
                  </Button>
                </div>
              )}
            </div>}
            <TimelineWaypointDetail
              waypoint={timelineWaypointDetail?.waypoint}
              currentHR={timelineWaypointDetail?.currentHR}
            />
            <InteractiveTimelinePlayer
              session={s}
              timelineRows={timelineRows}
              onActiveEventIndexChange={setSelectedEventIdx}
              onActiveWaypointChange={setTimelineWaypointDetail}
              externalTime={inspectionTime}
              onTimeChange={setInspectionTime}
            />
          </section>
        )}

        {(s.event_timeline || []).length > 0 && (
          <details id="session-event-notes" className="scroll-mt-24 rounded-xl border border-border bg-card p-4">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">
              Event Notes ({(s.event_timeline || []).length})
            </summary>
            <div className="mt-3">
            <EventNotesPanel
              events={s.event_timeline || []}
              motionSummary={s.motion_analysis_summary}
              selectedIndex={selectedEventIdx}
              onSelect={setSelectedEventIdx}
              onUpdateEvent={handleEventAnnotationUpdate}
              onDeleteEvent={handleEventAnnotationDelete}
              onDeleteAll={handleDeleteAllEventNotes}
              onUpdateMotionVerification={handleMotionVerificationUpdate}
              title="Event Notes"
              helper="Use this as the readable log beside the timeline visualizations."
              maxHeight={false}
            />
            </div>
          </details>
        )}

        {/* Advanced Timeline Views */}
        {(timelineRows.length > 0 || (s.event_timeline || []).length > 0) && (
          <details id="session-timeline-advanced" className="scroll-mt-24 rounded-xl border border-border bg-card p-4">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">
              Advanced Timeline Views
            </summary>
            <div className="mt-3 space-y-3">
              <InteractiveSessionTimeline session={s} timelineRows={timelineRows} />
              {timelineRows.length > 0 && <UnifiedSessionTimeline session={s} timelineRows={timelineRows} />}
              {((session.event_timeline || []).length > 0 || timelineRows.length > 0) && (
                <ArousalEventChart session={s} timelineRows={timelineRows} />
              )}
              <SessionKeyVideoMoments session={s} />
            </div>
          </details>
        )}

        {/* Session Journal */}
        <details id="session-journal" className="scroll-mt-24 rounded-xl border border-border bg-card p-4">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Session Journal</summary>
          <div className="mt-3">
          <JournalRecorder session={s} timelineRows={timelineRows} userProfile={userProfile} />
          </div>
        </details>

        {/* Ask Sarah */}
        <section
          id="session-interview"
          className="scroll-mt-24 min-w-0 max-w-full overflow-hidden rounded-xl border border-primary/20 bg-card p-3 sm:p-4"
        >
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">
            Ask Sarah{chatMessages.length > 0 ? ` (${chatMessages.length} saved messages)` : ""}
          </h3>
          <div className="mt-3">
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Attach images or a short local video clip for Sarah to review visible technique, device fit, anatomy, marker placement, telemetry overlays, or body movement for this session.
        </p>
        <AIChat
          mode="session"
          userProfile={userProfile}
          scopeId={id}
          context={[
            `Session date: ${s.date?.slice(0, 10)}`,
            `Duration: ${s.duration_minutes ?? "?"}min`,
            `Methods: ${(s.methods || []).join(", ")}`,
            s.foley_size ? `Foley: ${s.foley_size}Fr ${s.foley_type || ""}` : null,
            s.estim_notes ? `E-Stim notes: ${s.estim_notes}` : null,
            `Intensity: ${s.intensity}/10, Build quality: ${s.build_quality}/10, Satisfaction: ${s.satisfaction}/10`,
            `Build type: ${s.build_type}${s.custom_build_type ? " — " + s.custom_build_type : ""}`,
            `Climax duration: ${s.climax_duration ?? "?"}`,
            `Mood: ${s.mood}, Hydration: ${s.hydration}`,
            s.avg_hr ? `HR: avg ${s.avg_hr}, max ${s.max_hr}, at climax ${s.hr_at_climax ?? "?"}` : null,
            buildSessionPhaseMarkerDigest(s),
            s.pre_climax_offset_s != null ? (() => { const fmt = (v) => { if (v == null) return "?"; const m = Math.floor(v/60); const sec = Math.round(v%60); return `${m}:${sec.toString().padStart(2,"0")}`; }; return `Phase markers: pre-climax ${fmt(s.pre_climax_offset_s)}, climax ${fmt(s.climax_offset_s)}, recovery ${fmt(s.recovery_offset_s)}`; })() : null,
            s.ejaculate_volume ? `Ejaculate: ${s.ejaculate_volume}` : null,
            s.unusual_sensations ? `Unusual sensations: ${s.unusual_sensations}` : null,
            (s.discomfort_entries || []).length ? `Discomfort: ${s.discomfort_entries.map(e => `sev ${e.severity}/10 — ${e.note}`).join("; ")}` : null,
            sessionEventsForCurrentPhaseMarkers(s).length ? `Events: ${sessionEventsForCurrentPhaseMarkers(s).map(e => { const m = Math.floor(e.time_s / 60); const sec = Math.round(e.time_s % 60); return `[${m}:${sec.toString().padStart(2,"0")}] ${e.note}`; }).join(" | ")}` : null,
            buildSessionVisualEvidenceDigest(s),
            buildSessionVideoPassDigest(s),
            buildSessionKeyVideoClipDigest(s),
            s.notes ? `Session notes: ${s.notes}` : null,
          ].filter(Boolean).join("\n")}
          savedVideoClips={normalizeSessionKeyVideoClips(s)}
          sessionVideoSources={storyVideoSources}
          pendingTimestampReview={pendingTimestampReview}
          savedMessages={chatMessages}
          savedNotes={sessionNotes}
          defaultOpen
          autoScrollOnMount={false}
          onSaveMessages={handleChatMessagesSave}
          onSaveNotes={handleSessionNotesSave}
        />
          </div>
        </section>

        {/* Tags */}
        <details id="session-tags" className="scroll-mt-24 rounded-xl border border-border bg-card p-4">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Tags</summary>
          <div className="mt-3 space-y-3">
          {(s.tags || []).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {s.tags.map((t) => <Badge key={t} variant="outline">{t}</Badge>)}
            </div>
          )}
          <AITagSuggester
            session={s}
            userProfile={userProfile}
            onTagsAdded={(merged) => setSession((prev) => ({ ...prev, tags: merged }))}
          />
          </div>
        </details>
      </div>
    </div>
  );
}
