import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import PageHeader from "../components/PageHeader";
import SessionCard from "../components/SessionCard";
import { PlusCircle, Search, SlidersHorizontal, Download, Brain, Clock, Zap } from "lucide-react";
import RoutinePatternAnalysis from "../components/RoutinePatternAnalysis";
import { computeAISessionScore } from "@/utils/sessionScore";

const ALL_METHODS = ["Manual", "Silicone Sleeve", "Coyote E-Stim", "TENS", "Foley Catheter"];
const BUILD_TYPES = ["Gradual", "Stepwise", "Spike", "Plateau-heavy", "Erratic", "Other"];

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

  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = async () => {
    const data = await base44.entities.Session.list("-date", 200);
    setSessions(data);
    setLoading(false);
  };

  const filtered = sessions.filter((s) => {
    if (filterMethod && filterMethod !== "all_methods" && !(s.methods || []).includes(filterMethod)) return false;
    if (filterBuildType && filterBuildType !== "all_types" && s.build_type !== filterBuildType) return false;
    if (filterIntMin && s.intensity < Number(filterIntMin)) return false;
    if (filterIntMax && s.intensity > Number(filterIntMax)) return false;
    if (filterBQMin && (s.build_quality || 0) < Number(filterBQMin)) return false;
    if (filterBQMax && (s.build_quality || 0) > Number(filterBQMax)) return false;
    if (filterDateFrom && s.date < filterDateFrom) return false;
    if (filterDateTo && s.date > filterDateTo + "T23:59:59") return false;
    if (search) {
      const q = search.toLowerCase();
      const text = [s.notes, s.unusual_sensations, ...(s.methods || []), ...(s.tags || []), s.build_type].join(" ").toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  });

  const analyzeAll = async () => {
    const toAnalyze = sessions.filter((s) => !s.ai_analysis?.summary);
    if (!toAnalyze.length) return;
    setAnalyzing(true);
    setAnalyzeProgress(0);
    let done = 0;
    await Promise.all(toAnalyze.map(async (s) => {
      const eventCount = (s.event_timeline || []).length;
      const text = await base44.integrations.Core.InvokeLLM({
        prompt: `Write a brief 1–2 paragraph physiological summary of this session. Be concise and insightful. Focus on what happened, how the body responded, and any notable patterns.

Session data:
- Date: ${s.date?.slice(0, 10)}
- Duration: ${s.duration_minutes ?? "unknown"} minutes
- Methods: ${(s.methods || []).join(", ") || "none listed"}
- Build type: ${s.build_type || "unknown"}
- Intensity: ${s.intensity}/10
- Build quality: ${s.build_quality ?? "—"}/10
- Satisfaction: ${s.satisfaction ?? "—"}/10
- Climax duration: ${s.climax_duration || "—"}
- Avg HR: ${s.avg_hr ?? "—"} bpm, Max HR: ${s.max_hr ?? "—"} bpm, HR at climax: ${s.hr_at_climax ?? "—"} bpm
- Mood: ${s.mood || "—"}
- Events logged: ${eventCount}
${s.notes ? `- Notes: ${s.notes.slice(0, 200)}` : ""}`,
      });
      const summary = typeof text === "string" ? text : (text?.response ?? text?.summary ?? "");
      await base44.entities.Session.update(s.id, { ai_analysis: { ...(s.ai_analysis || {}), summary } });
      done++;
      setAnalyzeProgress(Math.round((done / toAnalyze.length) * 100));
      setSessions((prev) => prev.map((p) => p.id === s.id ? { ...p, ai_analysis: { ...(p.ai_analysis || {}), summary } } : p));
    }));
    setAnalyzing(false);
  };

  const gradeAllSessions = async () => {
    const toGrade = sessions; // Grade all sessions
    if (!toGrade.length) return;
    setGrading(true);
    setGradeProgress(0);
    let done = 0;
    await Promise.all(toGrade.map(async (s) => {
      const score = await computeAISessionScore(s, []);
      if (score != null) {
        // Auto-flag as favorite if score >= 85 and high arousal/climax quality
        const shouldFav = score >= 85 && (s.intensity >= 8 || s.satisfaction >= 9) && !s.no_climax;
        const updated = { ...(s.ai_analysis || {}), ai_score: score };
        await base44.entities.Session.update(s.id, { ai_analysis: updated, is_favorite: shouldFav || s.is_favorite });
        setSessions((prev) => prev.map((p) => p.id === s.id ? { ...p, ai_analysis: updated, is_favorite: shouldFav || s.is_favorite } : p));
      }
      done++;
      setGradeProgress(Math.round((done / toGrade.length) * 100));
    }));
    setGrading(false);
  };

  const backfillStartTimes = async () => {
    const toBackfill = sessions.filter((s) => !s.start_time);
    if (!toBackfill.length) return;
    setBackfilling(true);
    setBackfillProgress({ done: 0, total: toBackfill.length });
    let done = 0;
    await Promise.all(toBackfill.map(async (s) => {
      // Fetch the earliest HR timeline row for this session
      const rows = await base44.entities.HeartRateTimeline.filter({ session: s.id }, "time_offset_s", 1);
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
      } else if (s.date) {
        // Fall back to deriving from session date
        const etTime = new Date(s.date).toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        startTime = etTime === "24:00" ? "00:00" : etTime;
      }
      if (startTime) {
        await base44.entities.Session.update(s.id, { start_time: startTime });
        setSessions((prev) => prev.map((p) => p.id === s.id ? { ...p, start_time: startTime } : p));
      }
      done++;
      setBackfillProgress({ done, total: toBackfill.length });
    }));
    setBackfilling(false);
  };

  const clearFilters = () => {
    setFilterMethod(""); setFilterBuildType("");
    setFilterIntMin(""); setFilterIntMax("");
    setFilterBQMin(""); setFilterBQMax("");
    setFilterDateFrom(""); setFilterDateTo("");
  };

  const exportCSV = () => {
    const headers = ["Date","Duration","Avg HR","Max HR","HR at Climax","Methods","Intensity","Build Quality","Build Type","Satisfaction","Climax Duration","Mood","Environment","Tags"];
    const rows = filtered.map((s) => [
      s.date?.split("T")[0], s.duration_minutes,
      s.avg_hr, s.max_hr, s.hr_at_climax, (s.methods || []).join(";"),
      s.intensity, s.build_quality, s.build_type,
      s.satisfaction, s.climax_duration, s.mood, s.environment, (s.tags || []).join(";")
    ]);
    const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "sessions.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
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
            <Button variant="outline" size="icon" onClick={exportCSV} className="h-9 w-9">
              <Download className="w-4 h-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={backfillStartTimes}
              disabled={backfilling || sessions.every((s) => s.start_time)}
              className="gap-1.5 h-9"
              title="Set start times from HR CSV data"
            >
              {backfilling
                ? <><span className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />{backfillProgress.done}/{backfillProgress.total}</>
                : <><Clock className="w-4 h-4" />Times</>}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={gradeAllSessions}
              disabled={grading}
              className="gap-1.5 h-9"
            >
              {grading
                ? <><span className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />{gradeProgress}%</>
                : <><Zap className="w-4 h-4" />Grade</>
              }
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={analyzeAll}
              disabled={analyzing || sessions.every((s) => s.ai_analysis?.summary)}
              className="gap-1.5 h-9"
            >
              {analyzing
                ? <><span className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />{analyzeProgress}%</>
                : <><Brain className="w-4 h-4" />Analyze</>}
            </Button>
            <Link to="/new">
              <Button size="sm" className="gap-1.5 h-9">
                <PlusCircle className="w-4 h-4" /> New
              </Button>
            </Link>
          </div>
        }
      />

      <div className="px-4 space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search sessions..." className="pl-9 h-10" />
          </div>
          <Button variant={showFilters ? "secondary" : "outline"} size="icon" className="h-10 w-10" onClick={() => setShowFilters(!showFilters)}>
            <SlidersHorizontal className="w-4 h-4" />
          </Button>
        </div>

        {showFilters && (
          <div className="bg-card rounded-xl border border-border p-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase text-muted-foreground">Filters</span>
              <button onClick={clearFilters} className="text-xs text-primary">Clear all</button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Select value={filterMethod} onValueChange={setFilterMethod}>
                <SelectTrigger className="h-10"><SelectValue placeholder="Method" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all_methods">All Methods</SelectItem>
                  {ALL_METHODS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={filterBuildType} onValueChange={setFilterBuildType}>
                <SelectTrigger className="h-10"><SelectValue placeholder="Build Type" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all_types">All Types</SelectItem>
                  {BUILD_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <p className="text-[10px] text-muted-foreground uppercase font-semibold">Intensity Range</p>
            <div className="grid grid-cols-2 gap-2">
              <Input type="number" placeholder="Min" value={filterIntMin} onChange={(e) => setFilterIntMin(e.target.value)} className="h-9" />
              <Input type="number" placeholder="Max" value={filterIntMax} onChange={(e) => setFilterIntMax(e.target.value)} className="h-9" />
            </div>

            <p className="text-[10px] text-muted-foreground uppercase font-semibold">Build Quality Range</p>
            <div className="grid grid-cols-2 gap-2">
              <Input type="number" placeholder="Min" value={filterBQMin} onChange={(e) => setFilterBQMin(e.target.value)} className="h-9" />
              <Input type="number" placeholder="Max" value={filterBQMax} onChange={(e) => setFilterBQMax(e.target.value)} className="h-9" />
            </div>

            <p className="text-[10px] text-muted-foreground uppercase font-semibold">Date Range</p>
            <div className="grid grid-cols-2 gap-2">
              <Input type="date" value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.target.value)} className="h-9" />
              <Input type="date" value={filterDateTo} onChange={(e) => setFilterDateTo(e.target.value)} className="h-9" />
            </div>
          </div>
        )}

        <RoutinePatternAnalysis sessions={sessions} />

        <div className="space-y-2 pb-4">
          {filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <p className="text-sm">No sessions found</p>
              <Link to="/new" className="text-primary text-sm mt-1 inline-block">Record your first session →</Link>
            </div>
          ) : (
            filtered.map((s) => <SessionCard key={s.id} session={s} />)
          )}
        </div>
      </div>
    </div>
  );
}