import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import PageHeader from "../components/PageHeader";
import SessionCard from "../components/SessionCard";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock,
  Download,
  FileText,
  HeartPulse,
  MoreHorizontal,
  PlusCircle,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  TrendingUp,
  Video,
  Zap,
} from "lucide-react";
import RoutinePatternAnalysis from "../components/RoutinePatternAnalysis";
import { computeAISessionScore } from "@/utils/sessionScore";

const ALL_METHODS = ["Manual", "Silicone Sleeve", "Coyote E-Stim", "TENS", "Foley Catheter"];
const BUILD_TYPES = ["Gradual", "Stepwise", "Spike", "Plateau-heavy", "Erratic", "Other"];
const SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "best_score", label: "Best Score" },
  { value: "satisfaction", label: "Satisfaction" },
  { value: "intensity", label: "Intensity" },
  { value: "peak_hr", label: "Peak HR" },
  { value: "duration", label: "Duration" },
  { value: "events", label: "Events" },
  { value: "needs_review", label: "Needs Review" },
];

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
  return parsed == null ? "—" : parsed.toFixed(digits);
};

const scoreOf = (session) => num(session.ai_analysis?.ai_score);

const hasEMG = (session) =>
  session.emg_enabled ||
  session.emg_general_notes ||
  session.emg_left_placement_notes ||
  session.emg_right_placement_notes ||
  (session.emg_placement_photos || []).length > 0;

const hasVideo = (session) =>
  Boolean(session.video_link) || (session.media_videos || []).length > 0 || Boolean(session.video_file);

const hasDiscomfort = (session) =>
  Boolean(session.discomfort) ||
  (session.discomfort_entries || []).length > 0 ||
  num(session.discomfort_interference) >= 4;

const needsReview = (session) =>
  !session.ai_analysis?.summary ||
  scoreOf(session) == null ||
  hasDiscomfort(session) ||
  !(session.avg_hr || session.max_hr);

const buildTypeLabel = (session) => {
  if (!session.build_type) return "";
  if (session.build_type === "Other" && session.custom_build_type) return session.custom_build_type;
  return session.build_type;
};

function SummaryTile({ icon: Icon, label, value, detail, tone = "primary" }) {
  const toneClass = {
    primary: "bg-primary/10 text-primary",
    rose: "bg-rose-500/10 text-rose-300",
    cyan: "bg-cyan-500/10 text-cyan-300",
    amber: "bg-amber-500/10 text-amber-300",
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

function ViewButton({ active, count, icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors ${
        active
          ? "border-primary/50 bg-primary/15 text-primary"
          : "border-border bg-card text-muted-foreground hover:border-primary/30 hover:text-foreground"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      <span className="font-mono text-[10px] opacity-70">{count}</span>
    </button>
  );
}

export default function Sessions() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState(0);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState({ done: 0, total: 0 });
  const [showFilters, setShowFilters] = useState(false);
  const [search, setSearch] = useState("");
  const [filterMethod, setFilterMethod] = useState("");
  const [filterBuildType, setFilterBuildType] = useState("");
  const [filterIntMin, setFilterIntMin] = useState("");
  const [filterIntMax, setFilterIntMax] = useState("");
  const [filterBQMin, setFilterBQMin] = useState("");
  const [filterBQMax, setFilterBQMax] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [grading, setGrading] = useState(false);
  const [gradeProgress, setGradeProgress] = useState(0);
  const [viewMode, setViewMode] = useState("all");
  const [sortMode, setSortMode] = useState("newest");

  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = async () => {
    const data = await base44.entities.Session.list("-date", 200);
    setSessions(data);
    setLoading(false);
  };

  const stats = useMemo(() => {
    const withHr = sessions.filter((session) => session.avg_hr || session.max_hr);
    const scored = sessions.filter((session) => scoreOf(session) != null);
    const completed = sessions.filter((session) => !session.no_climax);
    const recent = sessions.slice(0, 5);
    const previous = sessions.slice(5, 10);
    const recentAvg = avg(recent.map((session) => scoreOf(session) ?? session.satisfaction ?? session.intensity));
    const previousAvg = avg(previous.map((session) => scoreOf(session) ?? session.satisfaction ?? session.intensity));
    const best = [...sessions].sort((a, b) => (scoreOf(b) ?? b.satisfaction ?? 0) - (scoreOf(a) ?? a.satisfaction ?? 0))[0];

    return {
      avgScore: avg(scored.map(scoreOf)),
      best,
      completed,
      missingAnalysis: sessions.filter((session) => !session.ai_analysis?.summary),
      needsReview: sessions.filter(needsReview),
      recentDelta: recentAvg != null && previousAvg != null ? recentAvg - previousAvg : null,
      scored,
      withHr,
    };
  }, [sessions]);

  const viewDefinitions = useMemo(() => [
    { value: "all", label: "All", icon: FileText, count: sessions.length },
    { value: "favorites", label: "Favorites", icon: Star, count: sessions.filter((session) => session.is_favorite).length },
    {
      value: "best",
      label: "Best Outcomes",
      icon: Sparkles,
      count: sessions.filter((session) => scoreOf(session) >= 85 || session.satisfaction >= 9 || session.intensity >= 9).length,
    },
    { value: "needs_review", label: "Needs Review", icon: AlertTriangle, count: stats.needsReview.length },
    { value: "no_climax", label: "No Climax", icon: CheckCircle2, count: sessions.filter((session) => session.no_climax).length },
    { value: "video", label: "Video", icon: Video, count: sessions.filter(hasVideo).length },
    { value: "emg", label: "EMG", icon: HeartPulse, count: sessions.filter(hasEMG).length },
    { value: "discomfort", label: "Discomfort", icon: AlertTriangle, count: sessions.filter(hasDiscomfort).length },
  ], [sessions, stats.needsReview.length]);

  const activeFilterCount = [
    search,
    filterMethod && filterMethod !== "all_methods",
    filterBuildType && filterBuildType !== "all_types",
    filterIntMin,
    filterIntMax,
    filterBQMin,
    filterBQMax,
    filterDateFrom,
    filterDateTo,
  ].filter(Boolean).length;

  const visibleSessions = useMemo(() => {
    const matchesView = (session) => {
      if (viewMode === "favorites") return session.is_favorite;
      if (viewMode === "best") return scoreOf(session) >= 85 || session.satisfaction >= 9 || session.intensity >= 9;
      if (viewMode === "needs_review") return needsReview(session);
      if (viewMode === "no_climax") return session.no_climax;
      if (viewMode === "video") return hasVideo(session);
      if (viewMode === "emg") return hasEMG(session);
      if (viewMode === "discomfort") return hasDiscomfort(session);
      return true;
    };

    const matchesFilters = (session) => {
      const dateOnly = session.date?.slice(0, 10) || "";
      if (!matchesView(session)) return false;
      if (filterMethod && filterMethod !== "all_methods" && !(session.methods || []).includes(filterMethod)) return false;
      if (filterBuildType && filterBuildType !== "all_types" && buildTypeLabel(session) !== filterBuildType) return false;
      if (filterIntMin && (num(session.intensity) ?? 0) < Number(filterIntMin)) return false;
      if (filterIntMax && (num(session.intensity) ?? 0) > Number(filterIntMax)) return false;
      if (filterBQMin && (num(session.build_quality) ?? 0) < Number(filterBQMin)) return false;
      if (filterBQMax && (num(session.build_quality) ?? 0) > Number(filterBQMax)) return false;
      if (filterDateFrom && dateOnly < filterDateFrom) return false;
      if (filterDateTo && dateOnly > filterDateTo) return false;
      if (search) {
        const q = search.toLowerCase();
        const searchable = [
          session.notes,
          session.unusual_sensations,
          session.primary_limiting_factor,
          session.mood,
          session.environment,
          buildTypeLabel(session),
          ...(session.methods || []),
          ...(session.tags || []),
        ].join(" ").toLowerCase();
        if (!searchable.includes(q)) return false;
      }
      return true;
    };

    const sorted = sessions.filter(matchesFilters);
    sorted.sort((a, b) => {
      if (sortMode === "best_score") return (scoreOf(b) ?? 0) - (scoreOf(a) ?? 0);
      if (sortMode === "satisfaction") return (num(b.satisfaction) ?? 0) - (num(a.satisfaction) ?? 0);
      if (sortMode === "intensity") return (num(b.intensity) ?? 0) - (num(a.intensity) ?? 0);
      if (sortMode === "peak_hr") return (num(b.max_hr) ?? 0) - (num(a.max_hr) ?? 0);
      if (sortMode === "duration") return (num(b.duration_minutes) ?? 0) - (num(a.duration_minutes) ?? 0);
      if (sortMode === "events") return (b.event_timeline || []).length - (a.event_timeline || []).length;
      if (sortMode === "needs_review") return Number(needsReview(b)) - Number(needsReview(a));
      return new Date(b.date || 0) - new Date(a.date || 0);
    });
    return sorted;
  }, [
    filterBQMax,
    filterBQMin,
    filterBuildType,
    filterDateFrom,
    filterDateTo,
    filterIntMax,
    filterIntMin,
    filterMethod,
    search,
    sessions,
    sortMode,
    viewMode,
  ]);

  const analyzeAll = async () => {
    const toAnalyze = sessions.filter((session) => !session.ai_analysis?.summary);
    if (!toAnalyze.length) return;
    setAnalyzing(true);
    setAnalyzeProgress(0);
    let done = 0;
    await Promise.all(toAnalyze.map(async (session) => {
      const eventCount = (session.event_timeline || []).length;
      const text = await base44.integrations.Core.InvokeLLM({
        prompt: `Write a brief 1-2 paragraph physiological summary of this session. Be concise and insightful. Focus on what happened, how the body responded, and any notable patterns.

Session data:
- Date: ${session.date?.slice(0, 10)}
- Duration: ${session.duration_minutes ?? "unknown"} minutes
- Methods: ${(session.methods || []).join(", ") || "none listed"}
- Build type: ${buildTypeLabel(session) || "unknown"}
- Intensity: ${session.intensity}/10
- Build quality: ${session.build_quality ?? "-"}/10
- Satisfaction: ${session.satisfaction ?? "-"}/10
- Climax duration: ${session.climax_duration || "-"}
- Avg HR: ${session.avg_hr ?? "-"} bpm, Max HR: ${session.max_hr ?? "-"} bpm, HR at climax: ${session.hr_at_climax ?? "-"} bpm
- Mood: ${session.mood || "-"}
- Events logged: ${eventCount}
${session.notes ? `- Notes: ${session.notes.slice(0, 200)}` : ""}`,
      });
      const summary = typeof text === "string" ? text : (text?.response ?? text?.summary ?? "");
      await base44.entities.Session.update(session.id, { ai_analysis: { ...(session.ai_analysis || {}), summary } });
      done++;
      setAnalyzeProgress(Math.round((done / toAnalyze.length) * 100));
      setSessions((prev) => prev.map((item) => item.id === session.id ? { ...item, ai_analysis: { ...(item.ai_analysis || {}), summary } } : item));
    }));
    setAnalyzing(false);
  };

  const gradeAllSessions = async () => {
    const toGrade = sessions;
    if (!toGrade.length) return;
    setGrading(true);
    setGradeProgress(0);
    let done = 0;
    await Promise.all(toGrade.map(async (session) => {
      const score = await computeAISessionScore(session, []);
      if (score != null) {
        const shouldFav = score >= 85 && (session.intensity >= 8 || session.satisfaction >= 9) && !session.no_climax;
        const updated = { ...(session.ai_analysis || {}), ai_score: score };
        await base44.entities.Session.update(session.id, { ai_analysis: updated, is_favorite: shouldFav || session.is_favorite });
        setSessions((prev) => prev.map((item) => item.id === session.id ? { ...item, ai_analysis: updated, is_favorite: shouldFav || item.is_favorite } : item));
      }
      done++;
      setGradeProgress(Math.round((done / toGrade.length) * 100));
    }));
    setGrading(false);
  };

  const backfillStartTimes = async () => {
    const toBackfill = sessions.filter((session) => !session.start_time);
    if (!toBackfill.length) return;
    setBackfilling(true);
    setBackfillProgress({ done: 0, total: toBackfill.length });
    let done = 0;
    await Promise.all(toBackfill.map(async (session) => {
      const rows = await base44.entities.HeartRateTimeline.filter({ session: session.id }, "time_offset_s", 1);
      const firstRow = rows[0];
      let startTime = null;
      if (firstRow?.timestamp) {
        const ts = new Date(firstRow.timestamp);
        const etTime = ts.toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        startTime = etTime === "24:00" ? "00:00" : etTime;
      } else if (session.date) {
        const etTime = new Date(session.date).toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        startTime = etTime === "24:00" ? "00:00" : etTime;
      }
      if (startTime) {
        await base44.entities.Session.update(session.id, { start_time: startTime });
        setSessions((prev) => prev.map((item) => item.id === session.id ? { ...item, start_time: startTime } : item));
      }
      done++;
      setBackfillProgress({ done, total: toBackfill.length });
    }));
    setBackfilling(false);
  };

  const clearFilters = () => {
    setSearch("");
    setFilterMethod("");
    setFilterBuildType("");
    setFilterIntMin("");
    setFilterIntMax("");
    setFilterBQMin("");
    setFilterBQMax("");
    setFilterDateFrom("");
    setFilterDateTo("");
  };

  const exportCSV = () => {
    const escapeCell = (value) => {
      const text = value == null ? "" : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const headers = ["Date", "Duration", "Avg HR", "Max HR", "HR at Climax", "Methods", "Intensity", "Build Quality", "Build Type", "Satisfaction", "Climax Duration", "Mood", "Environment", "Tags"];
    const rows = visibleSessions.map((session) => [
      session.date?.split("T")[0],
      session.duration_minutes,
      session.avg_hr,
      session.max_hr,
      session.hr_at_climax,
      (session.methods || []).join(";"),
      session.intensity,
      session.build_quality,
      buildTypeLabel(session),
      session.satisfaction,
      session.climax_duration,
      session.mood,
      session.environment,
      (session.tags || []).join(";"),
    ]);
    const csv = [headers, ...rows].map((row) => row.map(escapeCell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sessions.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Sessions"
        subtitle={`${sessions.length} total`}
        action={
          <div className="flex gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-1.5">
                  <MoreHorizontal className="h-4 w-4" /> Tools
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Library Actions</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={exportCSV}>
                  <Download className="h-4 w-4" /> Export current view
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={backfilling || sessions.every((session) => session.start_time)}
                  onSelect={backfillStartTimes}
                >
                  <Clock className="h-4 w-4" />
                  {backfilling ? `Backfilling ${backfillProgress.done}/${backfillProgress.total}` : "Backfill start times"}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={grading} onSelect={gradeAllSessions}>
                  <Zap className="h-4 w-4" />
                  {grading ? `Grading ${gradeProgress}%` : "Grade sessions"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={analyzing || sessions.every((session) => session.ai_analysis?.summary)}
                  onSelect={analyzeAll}
                >
                  <Brain className="h-4 w-4" />
                  {analyzing ? `Analyzing ${analyzeProgress}%` : "Analyze missing summaries"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Link to="/new">
              <Button size="sm" className="h-9 gap-1.5">
                <PlusCircle className="h-4 w-4" /> New
              </Button>
            </Link>
          </div>
        }
      />

      <div className="space-y-4 px-4 pb-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryTile
            icon={Sparkles}
            label="Avg Score"
            value={stats.avgScore == null ? "—" : `${fmt(stats.avgScore, 0)}%`}
            detail={`${stats.scored.length} graded sessions`}
          />
          <SummaryTile
            icon={HeartPulse}
            label="HR Coverage"
            value={stats.withHr.length}
            detail={`${Math.round((stats.withHr.length / Math.max(1, sessions.length)) * 100)}% of library`}
            tone="rose"
          />
          <SummaryTile
            icon={TrendingUp}
            label="Recent Shift"
            value={stats.recentDelta == null ? "—" : `${stats.recentDelta >= 0 ? "+" : ""}${fmt(stats.recentDelta)}`}
            detail="Latest five vs previous five"
            tone={stats.recentDelta != null && stats.recentDelta < 0 ? "amber" : "cyan"}
          />
          <SummaryTile
            icon={AlertTriangle}
            label="Needs Review"
            value={stats.needsReview.length}
            detail={`${stats.missingAnalysis.length} missing AI summaries`}
            tone={stats.needsReview.length ? "amber" : "primary"}
          />
        </div>

        <div className="overflow-x-auto pb-1">
          <div className="flex min-w-max gap-2">
            {viewDefinitions.map((view) => (
              <ViewButton
                key={view.value}
                active={viewMode === view.value}
                count={view.count}
                icon={view.icon}
                label={view.label}
                onClick={() => setViewMode(view.value)}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2 lg:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search notes, methods, mood, tags..."
              className="h-10 pl-9"
            />
          </div>
          <div className="flex gap-2">
            <Select value={sortMode} onValueChange={setSortMode}>
              <SelectTrigger className="h-10 w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant={showFilters ? "secondary" : "outline"}
              size="sm"
              className="h-10 gap-1.5"
              onClick={() => setShowFilters(!showFilters)}
            >
              <SlidersHorizontal className="h-4 w-4" />
              Filters
              {activeFilterCount > 0 && (
                <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
                  {activeFilterCount}
                </span>
              )}
            </Button>
          </div>
        </div>

        {showFilters && (
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Refine Current View</span>
              <button onClick={clearFilters} className="text-xs font-medium text-primary">Clear all</button>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase text-muted-foreground">Method</p>
                <Select value={filterMethod} onValueChange={setFilterMethod}>
                  <SelectTrigger className="h-10"><SelectValue placeholder="Any method" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all_methods">All Methods</SelectItem>
                    {ALL_METHODS.map((method) => <SelectItem key={method} value={method}>{method}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase text-muted-foreground">Build Type</p>
                <Select value={filterBuildType} onValueChange={setFilterBuildType}>
                  <SelectTrigger className="h-10"><SelectValue placeholder="Any build" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all_types">All Types</SelectItem>
                    {BUILD_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase text-muted-foreground">Intensity</p>
                <div className="grid grid-cols-2 gap-2">
                  <Input type="number" min="0" max="10" placeholder="Min" value={filterIntMin} onChange={(e) => setFilterIntMin(e.target.value)} className="h-10" />
                  <Input type="number" min="0" max="10" placeholder="Max" value={filterIntMax} onChange={(e) => setFilterIntMax(e.target.value)} className="h-10" />
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase text-muted-foreground">Build Quality</p>
                <div className="grid grid-cols-2 gap-2">
                  <Input type="number" min="0" max="10" placeholder="Min" value={filterBQMin} onChange={(e) => setFilterBQMin(e.target.value)} className="h-10" />
                  <Input type="number" min="0" max="10" placeholder="Max" value={filterBQMax} onChange={(e) => setFilterBQMax(e.target.value)} className="h-10" />
                </div>
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <p className="text-[10px] font-semibold uppercase text-muted-foreground">Date Range</p>
                <div className="grid grid-cols-2 gap-2">
                  <Input type="date" value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.target.value)} className="h-10" />
                  <Input type="date" value={filterDateTo} onChange={(e) => setFilterDateTo(e.target.value)} className="h-10" />
                </div>
              </div>
            </div>
          </div>
        )}

        <RoutinePatternAnalysis sessions={sessions} />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">{visibleSessions.length} session{visibleSessions.length !== 1 ? "s" : ""}</p>
            <p className="text-xs text-muted-foreground">
              {viewDefinitions.find((view) => view.value === viewMode)?.label || "All"} · {SORT_OPTIONS.find((option) => option.value === sortMode)?.label}
            </p>
          </div>
          {stats.best && (
            <Link to={`/sessions/${stats.best.id}`} className="text-xs font-medium text-primary hover:underline">
              Best current signal: {stats.best.date?.slice(0, 10)}
            </Link>
          )}
        </div>

        <div className="space-y-2 pb-4">
          {visibleSessions.length === 0 ? (
            <div className="rounded-xl border border-border bg-card py-12 text-center text-muted-foreground">
              <p className="text-sm">No sessions match this view.</p>
              <button onClick={clearFilters} className="mt-1 text-sm text-primary">Clear filters</button>
            </div>
          ) : (
            visibleSessions.map((session) => <SessionCard key={session.id} session={session} />)
          )}
        </div>
      </div>
    </div>
  );
}
