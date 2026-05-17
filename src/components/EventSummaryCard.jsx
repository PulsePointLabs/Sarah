import { useMemo } from "react";
import { MessageSquare } from "lucide-react";
import { EVENT_CATEGORIES } from "./session-form/EventTimelineSection";

function getCategoryMeta(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

export default function EventSummaryCard({ sessions }) {
  const stats = useMemo(() => {
    const allEvents = [];
    sessions.forEach((s) => {
      (s.event_timeline || []).forEach((ev) => {
        allEvents.push({ ...ev, session_date: s.date });
      });
    });

    if (!allEvents.length) return null;

    // Count by category
    const catCount = {};
    allEvents.forEach((ev) => {
      const cat = ev.category || "other";
      catCount[cat] = (catCount[cat] || 0) + 1;
    });

    const categoryCounts = EVENT_CATEGORIES.map((c) => ({
      ...c,
      count: catCount[c.value] || 0,
    })).filter((c) => c.count > 0).sort((a, b) => b.count - a.count);

    const sessionsWithEvents = sessions.filter((s) => s.event_timeline?.length > 0).length;

    return {
      total: allEvents.length,
      sessionsWithEvents,
      categoryCounts,
      avgPerSession: sessionsWithEvents > 0 ? (allEvents.length / sessionsWithEvents).toFixed(1) : 0,
    };
  }, [sessions]);

  if (!stats) return null;

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
        <MessageSquare className="w-3.5 h-3.5" /> Event Log Summary
      </h2>

      <div className="grid grid-cols-3 gap-2">
        <div className="bg-muted/50 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold font-mono text-primary">{stats.total}</p>
          <p className="text-[10px] text-muted-foreground">Total Events</p>
        </div>
        <div className="bg-muted/50 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold font-mono text-chart-2">{stats.sessionsWithEvents}</p>
          <p className="text-[10px] text-muted-foreground">Sessions w/ Events</p>
        </div>
        <div className="bg-muted/50 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold font-mono text-accent">{stats.avgPerSession}</p>
          <p className="text-[10px] text-muted-foreground">Avg / Session</p>
        </div>
      </div>

      {/* Category breakdown */}
      <div className="space-y-1.5">
        <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider">By Category</p>
        {stats.categoryCounts.map((c) => (
          <div key={c.value} className="flex items-center gap-2">
            <span className="text-[10px] font-semibold w-20 shrink-0" style={{ color: c.color }}>{c.label}</span>
            <div className="flex-1 h-4 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.round((c.count / stats.total) * 100)}%`, background: c.color }}
              />
            </div>
            <span className="text-[10px] font-mono text-muted-foreground w-6 text-right shrink-0">{c.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}