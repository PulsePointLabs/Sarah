import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import moment from "moment";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  CheckCircle2,
  Compass,
  Gauge,
  Heart,
  Layers,
  ShieldAlert,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Badge } from "@/components/ui/badge";
import PageHeader from "../components/PageHeader";
import BestSessionPanel from "../components/BestSessionPanel";
import HRSatisfactionCorrelationChart from "../components/HRSatisfactionCorrelationChart";

const POSITIVE_FIELDS = [
  "satisfaction",
  "intensity",
  "build_quality",
  "arousal_depth",
  "release_completeness",
  "erection_stability",
  "stimulation_fit",
  "sensory_immersion",
  "recovery_quality",
];

const NEW_SUBJECTIVE_FIELDS = [
  "release_completeness",
  "arousal_depth",
  "erection_stability",
  "stimulation_fit",
  "sensory_immersion",
  "recovery_quality",
  "discomfort_interference",
  "primary_limiting_factor",
];

const metricLabels = {
  arousal_depth: "Arousal Depth",
  build_quality: "Build Quality",
  discomfort_interference: "Discomfort Interference",
  erection_stability: "Erection Stability",
  intensity: "Intensity",
  recovery_quality: "Recovery Quality",
  release_completeness: "Release Completeness",
  satisfaction: "Satisfaction",
  sensory_immersion: "Sensory Immersion",
  stimulation_fit: "Stimulation Fit",
};

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const avg = (values) => {
  const valid = values.map(num).filter((value) => value != null);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
};

const fmt = (value, digits = 1) => {
  const parsed = num(value);
  return parsed == null ? "n/a" : parsed.toFixed(digits);
};

const sentenceCase = (value) => {
  if (!value) return "";
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (char) => char.toUpperCase());
};

const formatMethods = (methods) => {
  const list = Array.isArray(methods) ? methods.filter(Boolean) : [];
  return list.length ? [...list].sort().join(" + ") : "Unspecified method";
};

const methodComboKey = (session) => {
  const key = formatMethods(session.methods);
  return key === "Unspecified method" ? null : key;
};

const buildTypeLabel = (session) => {
  if (!session?.build_type) return "Unspecified build";
  if (session.build_type === "Other" && session.custom_build_type) return session.custom_build_type;
  return session.build_type;
};

const scoreSession = (session) => {
  const values = POSITIVE_FIELDS.map((field) => num(session[field])).filter((value) => value != null);
  if (!values.length) return null;

  const discomfort = num(session.discomfort_interference);
  if (discomfort != null) values.push(Math.max(0, 10 - discomfort));

  return avg(values);
};

const groupAverage = (sessions, getKey, getValue = scoreSession, minCount = 2) => {
  const groups = new Map();

  for (const session of sessions) {
    const key = getKey(session);
    const value = getValue(session);
    if (!key || value == null) continue;
    const current = groups.get(key) || { key, total: 0, count: 0, sessions: [] };
    current.total += value;
    current.count += 1;
    current.sessions.push(session);
    groups.set(key, current);
  }

  return [...groups.values()]
    .filter((group) => group.count >= minCount)
    .map((group) => ({ ...group, average: group.total / group.count }))
    .sort((a, b) => b.average - a.average);
};

const confidenceFor = (count, total) => {
  if (count >= Math.max(5, Math.ceil(total * 0.3))) {
    return { label: "Strong signal", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" };
  }
  if (count >= 3) {
    return { label: "Emerging pattern", className: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300" };
  }
  return { label: "Low sample", className: "border-amber-500/30 bg-amber-500/10 text-amber-300" };
};

const countLimitingFactors = (sessions) => {
  const counts = new Map();
  for (const session of sessions) {
    const factor = session.primary_limiting_factor || session.limiting_factor;
    if (!factor) continue;
    const key = sentenceCase(factor);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
};

const countDiscomfortSessions = (sessions) =>
  sessions.filter((session) => {
    const entries = Array.isArray(session.discomfort_entries) ? session.discomfort_entries : [];
    return entries.length > 0 || Boolean(session.discomfort) || num(session.discomfort_interference) >= 4;
  });

function SignalCard({ icon: Icon, label, value, detail, tone = "primary" }) {
  const toneClass = {
    primary: "text-primary bg-primary/10",
    rose: "text-rose-300 bg-rose-500/10",
    amber: "text-amber-300 bg-amber-500/10",
    cyan: "text-cyan-300 bg-cyan-500/10",
  }[tone];

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className="mt-2 text-2xl font-semibold leading-none">{value}</p>
        </div>
        <div className={`rounded-lg p-2 ${toneClass}`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      {detail && <p className="mt-3 text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

function InsightCard({ icon: Icon, question, title, description, count, total, to, metric }) {
  const confidence = confidenceFor(count || 1, total || 1);
  const content = (
    <div className="h-full rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{question}</p>
            <Badge variant="outline" className={`h-5 border px-2 text-[10px] ${confidence.className}`}>
              {confidence.label}
            </Badge>
          </div>
          <p className="mt-2 text-sm font-semibold leading-snug">{title}</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">{description}</p>
          {metric && <p className="mt-3 text-xs font-medium text-primary">{metric}</p>}
        </div>
        {to && <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />}
      </div>
    </div>
  );

  if (to) return <Link to={to}>{content}</Link>;
  return content;
}

function RecordRow({ label, value, detail, to }) {
  const content = (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 hover:border-primary/40">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-muted-foreground">{label}</p>
        <p className="mt-1 truncate text-sm font-medium">{detail}</p>
      </div>
      <p className="shrink-0 font-mono text-sm font-semibold text-primary">{value}</p>
    </div>
  );

  if (to) return <Link to={to}>{content}</Link>;
  return content;
}

export default function Insights() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const data = await base44.entities.Session.list("-date", 500);
      setSessions(data);
      setLoading(false);
    })();
  }, []);

  const model = useMemo(() => {
    const total = sessions.length;
    const scored = sessions.map((session) => ({ session, score: scoreSession(session) })).filter((item) => item.score != null);
    const completed = sessions.filter((session) => !session.no_climax);
    const withHr = sessions.filter((session) => session.max_hr || session.avg_hr);
    const metricCoverage = NEW_SUBJECTIVE_FIELDS.filter((field) =>
      sessions.some((session) => session[field] != null && session[field] !== "")
    ).length;

    const bestOverall = scored.sort((a, b) => b.score - a.score)[0];
    const highestSatisfaction = sessions
      .filter((session) => num(session.satisfaction) != null)
      .sort((a, b) => num(b.satisfaction) - num(a.satisfaction))[0];
    const highestIntensity = sessions
      .filter((session) => num(session.intensity) != null)
      .sort((a, b) => num(b.intensity) - num(a.intensity))[0];
    const peakHr = sessions
      .filter((session) => num(session.max_hr) != null)
      .sort((a, b) => num(b.max_hr) - num(a.max_hr))[0];

    const methodGroups = groupAverage(sessions, methodComboKey, scoreSession, 2);
    const buildGroups = groupAverage(sessions, buildTypeLabel, scoreSession, 2);
    const moodGroups = groupAverage(sessions, (session) => sentenceCase(session.mood), scoreSession, 2);
    const limiterCounts = countLimitingFactors(sessions);
    const discomfortSessions = countDiscomfortSessions(sessions);

    const recent = sessions.slice(0, 5);
    const previous = sessions.slice(5, 10);
    const recentScore = avg(recent.map(scoreSession));
    const previousScore = avg(previous.map(scoreSession));
    const trendDelta = recentScore != null && previousScore != null ? recentScore - previousScore : null;

    const stimulationFitGroups = groupAverage(
      sessions,
      methodComboKey,
      (session) => num(session.stimulation_fit),
      2
    );

    const immersionHigh = sessions.filter((session) => num(session.sensory_immersion) >= 8);
    const immersionLow = sessions.filter((session) => {
      const value = num(session.sensory_immersion);
      return value != null && value <= 5;
    });
    const highImmersionScore = avg(immersionHigh.map(scoreSession));
    const lowImmersionScore = avg(immersionLow.map(scoreSession));

    const insights = [];

    if (methodGroups[0]) {
      insights.push({
        icon: Sparkles,
        question: "What works best?",
        title: methodGroups[0].key,
        description: `This combination has the strongest blended outcome score across satisfaction, intensity, build quality, and newer subjective markers when available.`,
        count: methodGroups[0].count,
        total,
        metric: `Avg signal ${fmt(methodGroups[0].average)}/10 across ${methodGroups[0].count} sessions`,
        to: methodGroups[0].sessions[0]?.id ? `/sessions/${methodGroups[0].sessions[0].id}` : null,
      });
    } else if (bestOverall) {
      insights.push({
        icon: Sparkles,
        question: "What works best?",
        title: bestOverall.session?.id ? "Current best reference session" : "Best available signal",
        description: "There is not enough repeated method data for a confident method pattern yet, so the strongest full-session result is the clearest reference point.",
        count: 1,
        total,
        metric: `Best blended signal ${fmt(bestOverall.score)}/10`,
        to: `/sessions/${bestOverall.session.id}`,
      });
    }

    if (buildGroups[0]) {
      insights.push({
        icon: Layers,
        question: "What build shape helps?",
        title: sentenceCase(buildGroups[0].key),
        description: "This build pattern is currently associated with the strongest overall session quality, not just the highest heart-rate peak.",
        count: buildGroups[0].count,
        total,
        metric: `Avg signal ${fmt(buildGroups[0].average)}/10`,
      });
    }

    if (stimulationFitGroups[0]) {
      insights.push({
        icon: Target,
        question: "What feels most matched?",
        title: stimulationFitGroups[0].key,
        description: "Among sessions with stimulation-fit ratings, this method cluster appears to match the body state most cleanly.",
        count: stimulationFitGroups[0].count,
        total,
        metric: `Stimulation fit ${fmt(stimulationFitGroups[0].average)}/10`,
      });
    }

    if (limiterCounts[0]) {
      insights.push({
        icon: ShieldAlert,
        question: "What limits outcomes?",
        title: limiterCounts[0].name,
        description: "This is the most repeated limiting factor in the newer subjective fields, so it is worth tracking as a first-class condition.",
        count: limiterCounts[0].count,
        total,
        metric: `${limiterCounts[0].count} logged sessions`,
      });
    } else if (discomfortSessions.length > 0) {
      insights.push({
        icon: AlertTriangle,
        question: "What interrupts comfort?",
        title: `${discomfortSessions.length} sessions with discomfort markers`,
        description: "Discomfort is present often enough to keep separated from general quality scores, especially when interpreting intensity or recovery.",
        count: discomfortSessions.length,
        total,
        metric: `${Math.round((discomfortSessions.length / total) * 100)}% of recorded sessions`,
      });
    }

    if (trendDelta != null) {
      insights.push({
        icon: trendDelta >= 0 ? TrendingUp : TrendingDown,
        question: "What changed recently?",
        title: trendDelta >= 0 ? "Recent sessions are trending stronger" : "Recent sessions are trending softer",
        description: "This compares the latest five sessions against the five before them using the blended outcome score.",
        count: Math.min(total, 10),
        total,
        metric: `${trendDelta >= 0 ? "+" : ""}${fmt(trendDelta)} points`,
      });
    }

    if (highImmersionScore != null && lowImmersionScore != null) {
      insights.push({
        icon: Brain,
        question: "Does immersion matter?",
        title: highImmersionScore >= lowImmersionScore ? "High immersion tracks with better outcomes" : "Immersion is not the main driver yet",
        description: "Sensory immersion is compared against the blended outcome score, which helps separate environment effects from pure stimulation intensity.",
        count: immersionHigh.length + immersionLow.length,
        total,
        metric: `High ${fmt(highImmersionScore)}/10 vs low ${fmt(lowImmersionScore)}/10`,
      });
    }

    if (moodGroups.length >= 2) {
      insights.push({
        icon: Brain,
        question: "Which starting state helps?",
        title: moodGroups[0].key,
        description: `This mood state currently has the strongest average session signal compared with ${moodGroups[moodGroups.length - 1].key}.`,
        count: moodGroups[0].count,
        total,
        metric: `${fmt(moodGroups[0].average)}/10 vs ${fmt(moodGroups[moodGroups.length - 1].average)}/10`,
      });
    }

    const nextExperiment =
      methodGroups[0] && buildGroups[0]
        ? {
            title: `${methodGroups[0].key} with a ${sentenceCase(buildGroups[0].key)} build`,
            rationale: "This combines the strongest method pattern with the strongest build-shape pattern, then watches whether the result repeats.",
            track: ["release_completeness", "arousal_depth", "stimulation_fit", "sensory_immersion"],
          }
        : buildGroups[0]
          ? {
              title: `Repeat a ${sentenceCase(buildGroups[0].key)} build under clean conditions`,
              rationale: "Build shape is the clearest repeated signal right now. A deliberate repeat will make the method and context patterns easier to separate.",
              track: ["release_completeness", "arousal_depth", "stimulation_fit", "primary_limiting_factor"],
            }
        : {
            title: "Repeat the current strongest session conditions once",
            rationale: "A clean repeat will separate a real pattern from a one-off peak and make the next insight pass more confident.",
            track: ["release_completeness", "arousal_depth", "recovery_quality", "primary_limiting_factor"],
          };

    return {
      bestOverall,
      completed,
      highestIntensity,
      highestSatisfaction,
      insights,
      metricCoverage,
      nextExperiment,
      peakHr,
      scored,
      total,
      withHr,
    };
  }, [sessions]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div>
        <PageHeader title="Insights" subtitle="Pattern guidance from your session history" />
        <div className="px-4 py-12 text-center text-sm text-muted-foreground">
          Record some sessions first to see insights.
        </div>
      </div>
    );
  }

  const coveragePct = Math.round((model.metricCoverage / NEW_SUBJECTIVE_FIELDS.length) * 100);

  return (
    <div>
      <PageHeader title="Insights" subtitle={`Pattern guidance from ${model.total} sessions`} />

      <div className="space-y-6 px-4 pb-10">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SignalCard
            icon={Compass}
            label="Outcome Signal"
            value={`${fmt(avg(model.scored.map((item) => item.score)))}/10`}
            detail={`${model.scored.length} sessions with enough subjective data`}
          />
          <SignalCard
            icon={Heart}
            label="HR Coverage"
            value={model.withHr.length}
            detail={`${Math.round((model.withHr.length / model.total) * 100)}% of session history`}
            tone="rose"
          />
          <SignalCard
            icon={CheckCircle2}
            label="Completion"
            value={`${Math.round((model.completed.length / model.total) * 100)}%`}
            detail={`${model.completed.length} completed sessions`}
            tone="cyan"
          />
          <SignalCard
            icon={Gauge}
            label="New Metrics"
            value={`${coveragePct}%`}
            detail={`${model.metricCoverage} of ${NEW_SUBJECTIVE_FIELDS.length} newer fields are represented`}
            tone={coveragePct >= 60 ? "primary" : "amber"}
          />
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
              Insight Brief
            </Badge>
            <Badge variant="outline">{moment(sessions[sessions.length - 1].date).format("MMM YYYY")} to {moment(sessions[0].date).format("MMM YYYY")}</Badge>
          </div>
          <p className="mt-4 max-w-5xl text-sm leading-6 text-muted-foreground">
            The useful signal is shifting from isolated peaks toward repeatable conditions: method fit, build shape, sensory immersion, and recovery quality.
            The strongest insights below weight older session fields when needed, then become more specific as the newer subjective metrics fill in.
          </p>
        </div>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Pattern Questions</h2>
              <p className="mt-1 text-xs text-muted-foreground">Ranked by usefulness and available sample size.</p>
            </div>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {model.insights.map((insight) => (
              <InsightCard key={`${insight.question}-${insight.title}`} {...insight} total={model.total} />
            ))}
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-2 text-primary">
              <Target className="h-4 w-4" />
              <h2 className="text-sm font-semibold uppercase tracking-wider">Next Session Experiment</h2>
            </div>
            <p className="mt-4 text-lg font-semibold leading-snug">{model.nextExperiment.title}</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{model.nextExperiment.rationale}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {model.nextExperiment.track.map((field) => (
                <Badge key={field} variant="outline" className="border-border bg-muted/50">
                  {metricLabels[field] || sentenceCase(field)}
                </Badge>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            {model.highestSatisfaction && (
              <RecordRow
                label="Highest Satisfaction"
                value={`${model.highestSatisfaction.satisfaction}/10`}
                detail={moment(model.highestSatisfaction.date).format("MMM D, YYYY")}
                to={`/sessions/${model.highestSatisfaction.id}`}
              />
            )}
            {model.highestIntensity && (
              <RecordRow
                label="Highest Intensity"
                value={`${model.highestIntensity.intensity}/10`}
                detail={formatMethods(model.highestIntensity.methods)}
                to={`/sessions/${model.highestIntensity.id}`}
              />
            )}
            {model.peakHr && (
              <RecordRow
                label="Peak Heart Rate"
                value={`${model.peakHr.max_hr} bpm`}
                detail={moment(model.peakHr.date).format("MMM D, YYYY")}
                to={`/sessions/${model.peakHr.id}`}
              />
            )}
            {model.bestOverall && (
              <RecordRow
                label="Best Blended Signal"
                value={`${fmt(model.bestOverall.score)}/10`}
                detail={formatMethods(model.bestOverall.session.methods)}
                to={`/sessions/${model.bestOverall.session.id}`}
              />
            )}
          </div>
        </section>

        <HRSatisfactionCorrelationChart sessions={sessions} />

        <BestSessionPanel sessions={sessions} />
      </div>
    </div>
  );
}
