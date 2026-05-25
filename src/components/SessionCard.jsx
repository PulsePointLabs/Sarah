import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  Brain,
  ChevronDown,
  ChevronUp,
  Clock,
  FileText,
  Heart,
  Star,
  Trash2,
  Video,
  Zap,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import moment from "moment";
import { gradeFromPct } from "@/utils/sessionScore";
import { getMotionEvidenceSummary } from "@/utils/sessionMotionEvidence";

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const hasVideo = (session) =>
  Boolean(session.video_link) || (session.media_videos || []).length > 0 || Boolean(session.video_file);

const hasDiscomfort = (session) =>
  Boolean(session.discomfort) ||
  (session.discomfort_entries || []).length > 0 ||
  num(session.discomfort_interference) >= 4;

const buildTypeLabel = (session) => {
  if (!session.build_type) return null;
  if (session.build_type === "Other" && session.custom_build_type) return session.custom_build_type;
  return session.build_type;
};

function buildSignalLine(session) {
  const parts = [];
  const build = buildTypeLabel(session);
  if (build) parts.push(`${build} build`);
  if (num(session.stimulation_fit) >= 8) parts.push("strong stimulation fit");
  if (num(session.sensory_immersion) >= 8) parts.push("high immersion");
  if (num(session.release_completeness) >= 8) parts.push("complete release");
  if (num(session.recovery_quality) >= 8) parts.push("clean recovery");
  if (num(session.arousal_depth) >= 8) parts.push("deep arousal");
  if (hasDiscomfort(session)) parts.push("comfort flag");
  if (session.primary_limiting_factor) parts.push(`limit: ${session.primary_limiting_factor}`);
  if (session.no_climax && num(session.arousal_depth) >= 7) parts.push("high arousal without climax");
  if (!parts.length && session.ai_analysis?.summary) return session.ai_analysis.summary.split(/\n+/)[0]?.slice(0, 150);
  return parts.slice(0, 3).join(" · ");
}

function DataPill({ icon: Icon, label, active, tone = "muted" }) {
  const className = active
    ? tone === "primary"
      ? "border-primary/30 bg-primary/10 text-primary"
      : "border-cyan-500/30 bg-cyan-500/10 text-cyan-300"
    : "border-border bg-muted/30 text-muted-foreground/70";

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${className}`}>
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

function latestSessionUpdate(session) {
  const candidates = [
    session.updated_date,
    session.updated_at,
    session.motion_analysis_summary?.analyzed_at,
    session.ai_analysis?._meta?.last_generated_at,
    session.ai_analysis?._meta?.updated_at,
    session.ai_analysis?._meta?.generated_at,
    session.ai_session_deep_dive?._meta?.last_generated_at,
    session.ai_session_deep_dive?._meta?.updated_at,
    session.ai_cascade?._meta?.last_generated_at,
    session.ai_cascade?._meta?.updated_at,
    session.ai_no_climax?._meta?.last_generated_at,
    session.ai_no_climax?._meta?.updated_at,
    session.ai_timeline_narrative?._meta?.last_generated_at,
    session.ai_timeline_narrative?._meta?.updated_at,
    session.ai_near_climax_overview?._meta?.last_generated_at,
    session.ai_near_climax_overview?._meta?.updated_at,
  ].filter(Boolean);

  const dates = candidates
    .map((candidate) => moment(candidate))
    .filter((candidate) => candidate.isValid());
  if (!dates.length) return null;
  return dates.reduce((latest, candidate) => candidate.isAfter(latest) ? candidate : latest);
}

export default function SessionCard({ session, selectable, selected, onSelect, onDelete }) {
  const [aiExpanded, setAiExpanded] = useState(false);

  const date = moment(session.date).format("MMM D, YYYY");
  const updatedMoment = latestSessionUpdate(session);
  const updatedLabel = updatedMoment ? `Updated ${updatedMoment.fromNow()}` : "Updated time unavailable";
  const updatedTitle = updatedMoment ? `Last updated ${updatedMoment.format("MMM D, YYYY [at] h:mm A")}` : undefined;
  const methods = session.methods || [];
  const eventCount = (session.event_timeline || []).length;
  // Prefer the cached score computed in SessionDetail (includes HR data); fall back to score without HR
  // Use only persisted AI score for consistency across pages
  const scorePct = session.ai_analysis?.ai_score;
  const gradeInfo = scorePct != null ? gradeFromPct(scorePct) : null;
  const aiSummary = session.ai_analysis?.summary;
  const hasEMG = session.emg_enabled ||
    session.emg_general_notes || session.emg_left_placement_notes || session.emg_right_placement_notes ||
    (session.emg_placement_photos || []).length > 0;
  const signalLine = buildSignalLine(session);
  const motionEvidence = getMotionEvidenceSummary(session);
  const newerMetrics = [
    session.release_completeness,
    session.arousal_depth,
    session.erection_stability,
    session.stimulation_fit,
    session.sensory_immersion,
    session.recovery_quality,
    session.discomfort_interference,
    session.primary_limiting_factor,
  ].filter((value) => value != null && value !== "").length;

  const content = (
    <div className={`bg-card rounded-xl border p-4 transition-all ${
      selected ? "border-primary ring-1 ring-primary" : "border-border hover:border-primary/30"
    }`}>
      {/* Header row */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          {selectable && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onSelect?.(session.id)}
              className="w-5 h-5 rounded accent-primary"
            />
          )}
          <div>
            <p className="text-sm font-semibold">{date}</p>
            {(session.start_time || session.duration_minutes) && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {session.start_time}
                {session.end_time && ` – ${session.end_time}`}
                {session.duration_minutes && ` (${session.duration_minutes}m)`}
              </p>
            )}
            <p className="mt-0.5 text-[11px] text-muted-foreground/80" title={updatedTitle}>
              {updatedLabel}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {session.no_climax && (
            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
              <XCircle className="w-2.5 h-2.5" /> NC
            </span>
          )}
          {hasEMG && (
            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-chart-2/15 text-chart-2 border border-chart-2/30">
              EMG
            </span>
          )}
          {hasVideo(session) && (
            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
              <Video className="w-2.5 h-2.5" /> VID
            </span>
          )}
          {motionEvidence.hasAnyMotionEvidence && (
            <span
              className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[9px] font-bold ${
                motionEvidence.hasSavedTelemetry && motionEvidence.hasPromotedEvents
                  ? "border-primary/35 bg-primary/15 text-primary"
                  : motionEvidence.hasSavedTelemetry
                    ? "border-amber-400/30 bg-amber-400/10 text-amber-300"
                    : "border-violet-400/30 bg-violet-400/10 text-violet-300"
              }`}
              title={motionEvidence.hasSavedTelemetry && motionEvidence.hasPromotedEvents
                ? "Saved motion telemetry and reviewed motion-derived findings are available."
                : motionEvidence.hasSavedTelemetry
                  ? "Saved motion telemetry exists, but no reviewed motion findings have been promoted yet."
                  : "Reviewed motion-derived findings are present in the event timeline."}
            >
              {motionEvidence.hasSavedTelemetry && motionEvidence.hasPromotedEvents
                ? "Motion Saved + Events"
                : motionEvidence.hasSavedTelemetry ? "Telemetry Only" : "Motion Events"}
            </span>
          )}
          {session.is_quick_entry && <Zap className="w-4 h-4 text-primary" />}
          {session.is_favorite && <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />}
          {!selectable && onDelete && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button
                  type="button"
                  aria-label={`Delete session from ${date}`}
                  title="Delete session"
                  onClick={(event) => event.stopPropagation()}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent onClick={(event) => event.stopPropagation()}>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this session?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {date} will be permanently removed. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => onDelete(session)}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete session
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {/* Metrics row */}
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-1">
          <Heart className="w-3.5 h-3.5 text-chart-3" />
          <span className="text-xs font-mono">{session.max_hr || "—"}</span>
        </div>
        <div className="bg-primary/10 rounded-full px-2 py-0.5">
          <span className="text-xs font-bold text-primary">
            {session.no_climax ? "Arousal" : "Int"}: {session.intensity}/10
          </span>
        </div>
        {session.satisfaction && (
          <span className="text-xs text-muted-foreground">Sat: {session.satisfaction}/10</span>
        )}
        {eventCount > 0 && (
          <span className="text-[10px] bg-muted rounded-full px-2 py-0.5 text-muted-foreground">
            {eventCount} event{eventCount !== 1 ? "s" : ""}
          </span>
        )}
        {gradeInfo && (
          <span
            className="text-[10px] font-bold rounded-full px-2 py-0.5"
            style={{ background: gradeInfo.color + "22", color: gradeInfo.color }}
          >
            {gradeInfo.grade} · {scorePct}%
          </span>
        )}
      </div>

      {signalLine && (
        <p className="mb-2 rounded-lg border border-border bg-muted/25 px-3 py-2 text-xs leading-5 text-foreground/85">
          {signalLine}
        </p>
      )}

      {/* Badges */}
      <div className="flex flex-wrap gap-1 mb-2">
        {methods.slice(0, 3).map((m) => (
          <Badge key={m} variant="secondary" className="text-[10px] py-0">{m}</Badge>
        ))}
        {methods.length > 3 && (
          <Badge variant="secondary" className="text-[10px] py-0">+{methods.length - 3}</Badge>
        )}
        {session.foley_size && (
          <Badge variant="secondary" className="text-[10px] py-0">
            Foley {session.foley_size}{session.foley_type ? ` (${session.foley_type})` : ""}
          </Badge>
        )}
        {(session.tags || []).slice(0, 2).map((t) => (
          <Badge key={t} variant="outline" className="text-[10px] py-0">{t}</Badge>
        ))}
      </div>

      <div className="mb-2 flex flex-wrap gap-1.5">
        <DataPill icon={Heart} label="HR" active={Boolean(session.avg_hr || session.max_hr)} tone="primary" />
        <DataPill icon={Activity} label={`${eventCount} Events`} active={eventCount > 0} />
        <DataPill icon={Brain} label="AI" active={Boolean(aiSummary || gradeInfo)} tone="primary" />
        {motionEvidence.hasSavedTelemetry && <DataPill icon={Activity} label="Motion Saved" active tone="primary" />}
        <DataPill icon={FileText} label={`${newerMetrics}/8 Metrics`} active={newerMetrics >= 5} />
        {hasDiscomfort(session) && <DataPill icon={AlertTriangle} label="Comfort" active tone="primary" />}
      </div>

      {/* AI breakdown toggle (only shown when summary exists) */}
      {!selectable && aiSummary && (
        <>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setAiExpanded((v) => !v); }}
            className="flex items-center gap-1 text-[10px] text-primary font-semibold mt-1"
          >
            <Brain className="w-3 h-3" />
            {aiExpanded ? "Hide breakdown" : "Show AI breakdown"}
            {aiExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          {aiExpanded && (
            <div className="mt-2 pt-2 border-t border-border">
              <p className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap">{aiSummary}</p>
            </div>
          )}
        </>
      )}
    </div>
  );

  if (selectable) return content;
  return <Link to={`/sessions/${session.id}`}>{content}</Link>;
}
