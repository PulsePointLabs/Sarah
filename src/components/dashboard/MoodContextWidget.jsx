import { useMemo } from "react";

const MOOD_EMOJI = {
  relaxed: "😌",
  stressed: "😤",
  neutral: "😐",
  excited: "😆",
  tired: "😴",
  anxious: "😰",
};

export default function MoodContextWidget({ sessions }) {
  const moodStats = useMemo(() => {
    const map = {};
    sessions.forEach((s) => {
      if (!s.mood) return;
      if (!map[s.mood]) map[s.mood] = { count: 0, satisfactions: [], intensities: [] };
      map[s.mood].count++;
      if (s.satisfaction) map[s.mood].satisfactions.push(s.satisfaction);
      if (s.intensity) map[s.mood].intensities.push(s.intensity);
    });
    return Object.entries(map)
      .map(([mood, d]) => ({
        mood,
        count: d.count,
        avgSat: d.satisfactions.length
          ? +(d.satisfactions.reduce((a, b) => a + b, 0) / d.satisfactions.length).toFixed(1)
          : null,
        avgInt: d.intensities.length
          ? +(d.intensities.reduce((a, b) => a + b, 0) / d.intensities.length).toFixed(1)
          : null,
      }))
      .sort((a, b) => (b.avgSat ?? 0) - (a.avgSat ?? 0));
  }, [sessions]);

  const buildStats = useMemo(() => {
    const map = {};
    sessions.forEach((s) => {
      if (!s.build_type) return;
      if (!map[s.build_type]) map[s.build_type] = { count: 0, satisfactions: [] };
      map[s.build_type].count++;
      if (s.satisfaction) map[s.build_type].satisfactions.push(s.satisfaction);
    });
    return Object.entries(map)
      .map(([type, d]) => ({
        type,
        count: d.count,
        avgSat: d.satisfactions.length
          ? +(d.satisfactions.reduce((a, b) => a + b, 0) / d.satisfactions.length).toFixed(1)
          : null,
      }))
      .sort((a, b) => (b.avgSat ?? 0) - (a.avgSat ?? 0));
  }, [sessions]);

  if (moodStats.length === 0 && buildStats.length === 0) return null;

  const maxSat = Math.max(...moodStats.map((m) => m.avgSat ?? 0), 1);

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-4">
      {moodStats.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Mood → Satisfaction</h2>
          <div className="space-y-2">
            {moodStats.map((m) => (
              <div key={m.mood} className="flex items-center gap-2">
                <span className="text-base w-6 shrink-0">{MOOD_EMOJI[m.mood] ?? "•"}</span>
                <span className="text-xs capitalize w-16 shrink-0 text-foreground">{m.mood}</span>
                <div className="flex-1 bg-muted/40 rounded-full h-2 overflow-hidden">
                  <div
                    className="h-2 rounded-full bg-primary transition-all"
                    style={{ width: `${((m.avgSat ?? 0) / 10) * 100}%` }}
                  />
                </div>
                <span className="text-[10px] font-mono text-muted-foreground w-10 text-right shrink-0">
                  {m.avgSat ?? "—"}<span className="text-[9px]"> /10</span>
                </span>
                <span className="text-[10px] text-muted-foreground shrink-0">×{m.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {buildStats.length > 1 && (
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Build Type → Satisfaction</h2>
          <div className="space-y-2">
            {buildStats.map((b) => (
              <div key={b.type} className="flex items-center gap-2">
                <span className="text-xs w-24 shrink-0 text-foreground">{b.type}</span>
                <div className="flex-1 bg-muted/40 rounded-full h-2 overflow-hidden">
                  <div
                    className="h-2 rounded-full bg-accent transition-all"
                    style={{ width: `${((b.avgSat ?? 0) / 10) * 100}%` }}
                  />
                </div>
                <span className="text-[10px] font-mono text-muted-foreground w-10 text-right shrink-0">
                  {b.avgSat ?? "—"}<span className="text-[9px]"> /10</span>
                </span>
                <span className="text-[10px] text-muted-foreground shrink-0">×{b.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}