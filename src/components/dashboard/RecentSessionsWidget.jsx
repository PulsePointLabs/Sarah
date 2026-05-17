import { Link } from "react-router-dom";
import moment from "moment";
import { ChevronRight } from "lucide-react";

export default function RecentSessionsWidget({ sessions }) {
  const recent = [...sessions]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5);

  if (!recent.length) return null;

  return (
    <div className="bg-card rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent Sessions</h2>
        <Link to="/sessions" className="text-[10px] text-primary hover:underline flex items-center gap-0.5">
          All <ChevronRight className="w-3 h-3" />
        </Link>
      </div>
      <div className="space-y-2">
        {recent.map((s) => (
          <Link
            key={s.id}
            to={`/sessions/${s.id}`}
            className="flex items-center gap-3 px-3 py-2 rounded-lg bg-muted/40 hover:bg-muted/70 transition-colors group"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium">{moment(s.date).format("MMM D")}</span>
                {s.is_favorite && <span className="text-[9px] text-chart-4">★</span>}
                {s.no_climax && <span className="text-[9px] text-muted-foreground bg-muted px-1 rounded">no climax</span>}
              </div>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                {s.intensity && <span className="text-[10px] text-muted-foreground">I: <span className="font-mono text-foreground">{s.intensity}</span></span>}
                {s.satisfaction && <span className="text-[10px] text-muted-foreground">S: <span className="font-mono text-foreground">{s.satisfaction}</span></span>}
                {s.hr_at_climax && <span className="text-[10px] text-muted-foreground">♥ <span className="font-mono text-foreground">{s.hr_at_climax}</span></span>}
                {s.mood && <span className="text-[10px] text-muted-foreground capitalize">{s.mood}</span>}
              </div>
            </div>
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-foreground shrink-0 transition-colors" />
          </Link>
        ))}
      </div>
    </div>
  );
}