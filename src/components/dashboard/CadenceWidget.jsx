import moment from "moment";
import { Calendar, TrendingUp, TrendingDown, Minus } from "lucide-react";

export default function CadenceWidget({ sessions }) {
  if (!sessions.length) return null;

  const sorted = [...sessions].sort((a, b) => new Date(b.date) - new Date(a.date));
  const latest = sorted[0];
  const daysSince = moment().diff(moment(latest.date), "days");

  const thisMonth = moment().startOf("month");
  const lastMonth = moment().subtract(1, "month").startOf("month");
  const thisMonthCount = sessions.filter((s) => moment(s.date).isSameOrAfter(thisMonth)).length;
  const lastMonthCount = sessions.filter((s) =>
    moment(s.date).isSameOrAfter(lastMonth) && moment(s.date).isBefore(thisMonth)
  ).length;

  // No-climax rate
  const withClimax = sessions.filter((s) => !s.no_climax);
  const climaxRate = sessions.length > 0 ? Math.round((withClimax.length / sessions.length) * 100) : null;

  // Best session (highest satisfaction, break ties with intensity)
  const best = sessions
    .filter((s) => s.satisfaction)
    .sort((a, b) => b.satisfaction - a.satisfaction || (b.intensity || 0) - (a.intensity || 0))[0];

  const diff = thisMonthCount - lastMonthCount;
  const TrendIcon = diff > 0 ? TrendingUp : diff < 0 ? TrendingDown : Minus;
  const trendColor = diff > 0 ? "text-primary" : diff < 0 ? "text-destructive" : "text-muted-foreground";

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">At a Glance</h2>
      <div className="grid grid-cols-2 gap-2">
        {/* Days since */}
        <div className="bg-muted/40 rounded-lg p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Last Session</p>
          <p className="text-2xl font-bold font-mono mt-0.5">
            {daysSince === 0 ? "Today" : daysSince === 1 ? "1 day" : `${daysSince}d`}
          </p>
          <p className="text-[10px] text-muted-foreground">{moment(latest.date).format("MMM D")}</p>
        </div>

        {/* This month */}
        <div className="bg-muted/40 rounded-lg p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">This Month</p>
          <div className="flex items-end gap-1.5 mt-0.5">
            <p className="text-2xl font-bold font-mono">{thisMonthCount}</p>
            <span className={`flex items-center gap-0.5 text-[10px] font-medium mb-0.5 ${trendColor}`}>
              <TrendIcon className="w-3 h-3" />
              {Math.abs(diff)} vs last
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground">{lastMonthCount} last month</p>
        </div>

        {/* Climax rate */}
        {climaxRate !== null && (
          <div className="bg-muted/40 rounded-lg p-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Climax Rate</p>
            <p className="text-2xl font-bold font-mono text-primary mt-0.5">{climaxRate}%</p>
            <p className="text-[10px] text-muted-foreground">{withClimax.length} of {sessions.length} sessions</p>
          </div>
        )}

        {/* Best session */}
        {best && (
          <div className="bg-muted/40 rounded-lg p-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Best Session</p>
            <p className="text-2xl font-bold font-mono text-chart-4 mt-0.5">{best.satisfaction}<span className="text-sm font-normal text-muted-foreground">/10</span></p>
            <p className="text-[10px] text-muted-foreground">{moment(best.date).format("MMM D, YYYY")}</p>
          </div>
        )}
      </div>
    </div>
  );
}