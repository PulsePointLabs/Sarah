import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Brain, CheckCircle2, ChevronDown, ClipboardCheck, Edit3, FileText, HeartPulse, ListChecks, NotebookText } from "lucide-react";
import { Button } from "@/components/ui/button";

function fmtMmSs(value) {
  if (value == null || Number(value) < 0) return "--";
  const total = Math.round(Number(value));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && value !== "";
}

function StepRow({ done, icon: Icon, title, detail, actionLabel, onAction }) {
  return (
    <div className={`rounded-lg border px-3 py-3 ${done ? "border-primary/25 bg-primary/8" : "border-border bg-muted/25"}`}>
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 rounded-full p-1 ${done ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
          {done ? <CheckCircle2 className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{detail}</p>
        </div>
        {actionLabel && (
          <Button type="button" variant="ghost" size="sm" onClick={onAction} className="h-8 shrink-0 px-2.5 text-sm">
            {actionLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

export default function PostSessionReviewWizard({ session, timelineRows = [], emgRows = [], onUpdate, onOpenTab, onEdit }) {
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(session?.post_session_review?.completed_at || "");
  const [saveError, setSaveError] = useState("");
  const [collapsed, setCollapsed] = useState(Boolean(session?.post_session_review?.completed_at));

  useEffect(() => {
    const completedAt = session?.post_session_review?.completed_at || "";
    setSavedAt(completedAt);
    setCollapsed(Boolean(completedAt));
  }, [session?.id, session?.post_session_review?.completed_at]);

  const review = useMemo(() => {
    const events = session?.event_timeline || [];
    const hasSubjective = session?.no_climax
      ? hasValue(session?.intensity) && hasValue(session?.build_quality) && hasValue(session?.satisfaction)
      : hasValue(session?.intensity) && hasValue(session?.build_quality) && hasValue(session?.satisfaction) && hasValue(session?.climax_duration);
    const hasContext = hasValue(session?.mood) || hasValue(session?.environment) || hasValue(session?.hydration) || hasValue(session?.notes);
    const hasEvents = events.some((event) => String(event?.note || "").trim());
    const hasHr = timelineRows.length > 0 || hasValue(session?.hr_data_file) || hasValue(session?.avg_hr);
    const hasEmg = !session?.emg_enabled || emgRows.length > 0 || hasValue(session?.emg_data_file);
    const hasMarkers = session?.no_climax || (
      session?.pre_climax_offset_s != null &&
      session?.climax_offset_s != null &&
      session?.recovery_offset_s != null
    );
    const hasAi = Boolean(session?.ai_analysis || session?.cascade_overview || session?.timeline_narrative);
    const hasJournal = Boolean(session?.journal_entry || session?.ai_journal || session?.session_journal);
    const captureDigest = session?.capture_digest;
    const steps = [
      {
        key: "details",
        done: hasSubjective && hasContext,
        icon: Edit3,
        title: "Subjective Details",
        detail: hasSubjective && hasContext
          ? "Core ratings and context are present."
          : "Add ratings, climax details, mood/environment, and any important subjective context.",
        actionLabel: "Edit",
        action: "edit",
      },
      {
        key: "data",
        done: hasHr && hasEmg,
        icon: HeartPulse,
        title: "Telemetry Data",
        detail: hasHr
          ? `${timelineRows.length || session?.capture_digest?.hr_rows || 0} HR rows available${hasEmg ? "; EMG status is okay." : "; EMG still needs review."}`
          : "Heart-rate data is missing or not imported yet.",
        actionLabel: "Physiology",
        tab: "physiology",
      },
      {
        key: "events",
        done: hasEvents,
        icon: FileText,
        title: "Event Notes",
        detail: hasEvents
          ? `${events.length} timestamped notes are available for timeline correlation.`
          : "Add or review timestamped notes so AI can anchor stimulation, body signs, climax, and recovery.",
        actionLabel: "Timeline",
        tab: "timeline",
      },
      {
        key: "markers",
        done: hasMarkers,
        icon: ListChecks,
        title: "Phase Markers",
        detail: hasMarkers
          ? session?.no_climax
            ? "No-climax session; climax markers are not required."
            : `Pre ${fmtMmSs(session.pre_climax_offset_s)}, climax ${fmtMmSs(session.climax_offset_s)}, recovery ${fmtMmSs(session.recovery_offset_s)}.`
          : "Use Phase Detection 2.0 to place pre-climax, climax, and recovery from notes plus HR shape.",
        actionLabel: "Markers",
        tab: "physiology",
      },
      {
        key: "ai",
        done: hasAi,
        icon: Brain,
        title: "AI Analysis",
        detail: hasAi
          ? "At least one AI analysis artifact exists."
          : "Run analysis after details, notes, and markers are reviewed for best output.",
        actionLabel: "AI",
        tab: "ai",
      },
      {
        key: "journal",
        done: hasJournal,
        icon: NotebookText,
        title: "Journal",
        detail: hasJournal
          ? "A journal/storyline artifact appears to be present."
          : "Optional: generate a session journal once the physiological record is cleaned up.",
        actionLabel: "Journal",
        tab: "journal",
      },
    ];
    const doneCount = steps.filter((step) => step.done).length;
    const nextStep = steps.find((step) => !step.done) || null;
    const completedAt = savedAt || session?.post_session_review?.completed_at || "";
    return { steps, doneCount, total: steps.length, pct: Math.round((doneCount / steps.length) * 100), captureDigest, completedAt, nextStep };
  }, [emgRows.length, savedAt, session, timelineRows.length]);

  const markComplete = async () => {
    setSaving(true);
    setSaveError("");
    const completedAt = new Date().toISOString();
    const previousSavedAt = savedAt;
    setSavedAt(completedAt);
    try {
      await onUpdate({
        post_session_review: {
          completed_at: completedAt,
          completion_pct: review.pct,
          checked_steps: review.steps.filter((step) => step.done).map((step) => step.key),
        },
      });
      setCollapsed(true);
    } catch (error) {
      setSavedAt(previousSavedAt);
      setSaveError(error?.message || "Review completion could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  if (review.completedAt && collapsed) {
    return (
      <div className="rounded-xl border border-primary/20 bg-primary/8 p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4" /> Post-Session Review Complete
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {review.doneCount} of {review.total} checks complete. Last marked {new Date(review.completedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setCollapsed(false)} className="gap-1.5 text-sm">
            <ChevronDown className="h-3.5 w-3.5" />
            Review
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
            <ClipboardCheck className="h-4 w-4" /> Post-Session Review
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Clean up the record before deep analysis so AI has the full story.
          </p>
          {review.completedAt && (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Review completed {new Date(review.completedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </p>
          )}
          {saveError && <p className="mt-2 text-sm text-destructive">{saveError}</p>}
        </div>
        <div className="min-w-[9rem]">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Ready</span>
            <span className="font-mono font-bold text-foreground">{review.pct}%</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${review.pct}%` }} />
          </div>
        </div>
      </div>

      {review.captureDigest?.findings?.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {review.captureDigest.findings.slice(0, 8).map((finding) => (
            <span key={finding} className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
              {finding}
            </span>
          ))}
        </div>
      )}

      {review.nextStep && (
        <div className="rounded-lg border border-primary/25 bg-primary/8 px-3 py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Next Best Review Step</p>
              <p className="mt-1 text-sm text-foreground">{review.nextStep.title}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{review.nextStep.detail}</p>
            </div>
            {review.nextStep.actionLabel && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (review.nextStep.action === "edit") onEdit?.();
                  else if (review.nextStep.tab) onOpenTab?.(review.nextStep.tab);
                }}
                className="shrink-0 gap-1.5 text-sm"
              >
                {review.nextStep.actionLabel}
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-2 lg:grid-cols-2">
        {review.steps.map((step) => (
          <StepRow
            key={step.key}
            done={step.done}
            icon={step.icon}
            title={step.title}
            detail={step.detail}
            actionLabel={step.actionLabel}
            onAction={() => {
              if (step.action === "edit") onEdit?.();
              else if (step.tab) onOpenTab?.(step.tab);
            }}
          />
        ))}
      </div>

      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={markComplete} disabled={saving} className="gap-1.5 text-sm">
          {saving ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          {review.completedAt ? "Update Review Complete" : "Mark Review Complete"}
        </Button>
      </div>
    </div>
  );
}
