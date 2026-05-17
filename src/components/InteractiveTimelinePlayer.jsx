import { useState, useEffect, useRef, useCallback } from "react";
import { Play, Pause, SkipBack, SkipForward, ChevronDown, ChevronUp, Zap, Activity, Flag, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EVENT_CATEGORIES } from "./session-form/EventTimelineSection";

function getCategoryMeta(value) {
  const cats = Array.isArray(value) ? value : [value].filter(Boolean);
  const first = cats[0];
  return EVENT_CATEGORIES.find((c) => c.value === first) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

function fmtTime(s) {
  const totalS = Math.round(Number(s));
  const m = Math.floor(totalS / 60);
  const sec = totalS % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const PHASE_COLORS = {
  pre_climax: "#a855f7",
  climax: "#ef4444",
  recovery: "#3b82f6",
};

// Build a unified sorted list of "waypoints" from events + near-climax events + phase markers
function buildWaypoints(session) {
  const waypoints = [];

  // Phase markers
  if (session.pre_climax_offset_s != null)
    waypoints.push({ time_s: session.pre_climax_offset_s, type: "phase", phase: "pre_climax", label: "Pre-Climax" });
  if (session.climax_offset_s != null)
    waypoints.push({ time_s: session.climax_offset_s, type: "phase", phase: "climax", label: "Climax" });
  if (session.recovery_offset_s != null)
    waypoints.push({ time_s: session.recovery_offset_s, type: "phase", phase: "recovery", label: "Recovery" });

  // User event timeline
  (session.event_timeline || []).forEach((ev, i) => {
    waypoints.push({ time_s: ev.time_s, type: "event", event: ev, id: `ev_${i}` });
  });

  // Near-climax AI events
  (session.ai_near_climax_events || []).forEach((nc, i) => {
    waypoints.push({ time_s: nc.peak_offset_s, type: "near_climax", nc, id: `nc_${i}` });
  });

  return waypoints.sort((a, b) => a.time_s - b.time_s);
}

export default function InteractiveTimelinePlayer({ session, timelineRows }) {
  const [collapsed, setCollapsed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [pausedAt, setPausedAt] = useState(null); // waypoint index we're paused at
  const [activeWaypointIdx, setActiveWaypointIdx] = useState(null);

  const intervalRef = useRef(null);
  const waypointsRef = useRef([]);
  const playingRef = useRef(false);
  const currentTimeRef = useRef(0);
  const pausedAtRef = useRef(null);

  // Sorted HR rows for lookup
  const sortedRows = [...timelineRows].sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));
  const totalDuration = sortedRows.length
    ? Number(sortedRows[sortedRows.length - 1].time_offset_s)
    : (session.duration_minutes || 0) * 60;

  // Current HR at playhead
  const hrAtTime = useCallback((t) => {
    if (!sortedRows.length) return null;
    let best = sortedRows[0];
    let bestDist = Math.abs(Number(sortedRows[0].time_offset_s) - t);
    for (const r of sortedRows) {
      const d = Math.abs(Number(r.time_offset_s) - t);
      if (d < bestDist) { bestDist = d; best = r; }
    }
    return Math.round(Number(best.hr));
  }, [sortedRows]);

  const waypoints = buildWaypoints(session);
  waypointsRef.current = waypoints;

  // Sync refs
  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);
  useEffect(() => { pausedAtRef.current = pausedAt; }, [pausedAt]);
  useEffect(() => { playingRef.current = playing; }, [playing]);

  const PLAYBACK_SPEED = 10; // 10x real-time
  const TICK_MS = 100;
  const PAUSE_DURATION_MS = 3000; // pause 3s at each waypoint

  const stopTicker = () => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  };

  const startTicker = useCallback(() => {
    stopTicker();
    intervalRef.current = setInterval(() => {
      if (!playingRef.current) return;

      const t = currentTimeRef.current;
      const wps = waypointsRef.current;

      // Check if we just passed a waypoint
      const nextWpIdx = wps.findIndex((w) => w.time_s > t && w.time_s <= t + (PLAYBACK_SPEED * TICK_MS / 1000) * 2);
      if (nextWpIdx !== -1 && pausedAtRef.current !== nextWpIdx) {
        // Snap to waypoint and pause
        const wp = wps[nextWpIdx];
        setCurrentTime(wp.time_s);
        currentTimeRef.current = wp.time_s;
        setActiveWaypointIdx(nextWpIdx);
        setPlaying(false);
        playingRef.current = false;
        setPausedAt(nextWpIdx);
        pausedAtRef.current = nextWpIdx;
        return;
      }

      const newTime = t + (PLAYBACK_SPEED * TICK_MS / 1000);
      if (newTime >= totalDuration) {
        setCurrentTime(totalDuration);
        setPlaying(false);
        playingRef.current = false;
        stopTicker();
        return;
      }
      setCurrentTime(newTime);
    }, TICK_MS);
  }, [totalDuration]);

  useEffect(() => {
    if (playing) startTicker();
    else stopTicker();
    return stopTicker;
  }, [playing, startTicker]);

  const handlePlayPause = () => {
    if (playing) {
      setPlaying(false);
    } else {
      // If paused at a waypoint, clear it and continue
      setPausedAt(null);
      setActiveWaypointIdx(null);
      setPlaying(true);
    }
  };

  const handleReset = () => {
    setPlaying(false);
    setCurrentTime(0);
    setPausedAt(null);
    setActiveWaypointIdx(null);
  };

  const handleScrub = (e) => {
    const val = Number(e.target.value);
    setCurrentTime(val);
    setPausedAt(null);
    setActiveWaypointIdx(null);
    if (playing) setPlaying(false);
  };

  const jumpToWaypoint = (idx) => {
    const wp = waypoints[idx];
    if (!wp) return;
    setCurrentTime(wp.time_s);
    setActiveWaypointIdx(idx);
    setPausedAt(idx);
    setPlaying(false);
  };

  const jumpNext = () => {
    const idx = waypoints.findIndex((w) => w.time_s > currentTime + 0.5);
    if (idx !== -1) jumpToWaypoint(idx);
  };

  const jumpPrev = () => {
    const reversed = [...waypoints].reverse();
    const wp = reversed.find((w) => w.time_s < currentTime - 0.5);
    if (wp) jumpToWaypoint(waypoints.indexOf(wp));
  };

  const currentHR = hrAtTime(currentTime);
  const activeWp = activeWaypointIdx != null ? waypoints[activeWaypointIdx] : null;
  const progress = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  // Determine which phase we're in
  const currentPhase = (() => {
    if (session.climax_offset_s != null && currentTime >= session.climax_offset_s &&
      (session.recovery_offset_s == null || currentTime < session.recovery_offset_s)) return "climax";
    if (session.recovery_offset_s != null && currentTime >= session.recovery_offset_s) return "recovery";
    if (session.pre_climax_offset_s != null && currentTime >= session.pre_climax_offset_s) return "pre_climax";
    return "build";
  })();

  const phaseColor = PHASE_COLORS[currentPhase] || "hsl(var(--primary))";

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button className="flex items-center gap-1.5 flex-1 text-left" onClick={() => setCollapsed((v) => !v)}>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
            <Play className="w-4 h-4" /> Interactive Timeline Player
          </h3>
          {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground ml-1" /> : <ChevronUp className="w-4 h-4 text-muted-foreground ml-1" />}
        </button>
        {!collapsed && (
          <span className="text-[10px] text-muted-foreground">
            {waypoints.length} waypoints
          </span>
        )}
      </div>

      {!collapsed && (
        <>
          {/* Playhead display */}
          <div className="flex items-center justify-between">
            <div className="text-center">
              <p className="text-2xl font-bold font-mono" style={{ color: phaseColor }}>{fmtTime(currentTime)}</p>
              <p className="text-[9px] uppercase text-muted-foreground tracking-wide capitalize">{currentPhase.replace("_", " ")}</p>
            </div>
            <div className="text-center">
              {currentHR != null ? (
                <>
                  <p className="text-2xl font-bold font-mono text-destructive">{currentHR}</p>
                  <p className="text-[9px] uppercase text-muted-foreground tracking-wide">bpm</p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No HR data</p>
              )}
            </div>
            <div className="text-center">
              <p className="text-sm font-mono text-muted-foreground">{fmtTime(totalDuration)}</p>
              <p className="text-[9px] uppercase text-muted-foreground tracking-wide">total</p>
            </div>
          </div>

          {/* Scrubber */}
          <div className="space-y-1">
            <div className="relative h-2 bg-muted rounded-full overflow-hidden">
              {/* Phase zones */}
              {session.pre_climax_offset_s != null && totalDuration > 0 && (
                <div
                  className="absolute top-0 h-full opacity-30"
                  style={{
                    left: `${(session.pre_climax_offset_s / totalDuration) * 100}%`,
                    width: session.climax_offset_s
                      ? `${((session.climax_offset_s - session.pre_climax_offset_s) / totalDuration) * 100}%`
                      : "5%",
                    background: PHASE_COLORS.pre_climax,
                  }}
                />
              )}
              {session.climax_offset_s != null && totalDuration > 0 && (
                <div
                  className="absolute top-0 h-full opacity-40"
                  style={{
                    left: `${(session.climax_offset_s / totalDuration) * 100}%`,
                    width: session.recovery_offset_s
                      ? `${((session.recovery_offset_s - session.climax_offset_s) / totalDuration) * 100}%`
                      : "3%",
                    background: PHASE_COLORS.climax,
                  }}
                />
              )}
              {/* Progress fill */}
              <div
                className="absolute top-0 left-0 h-full rounded-full transition-all duration-100"
                style={{ width: `${progress}%`, background: phaseColor }}
              />
              {/* Waypoint ticks */}
              {waypoints.map((wp, i) => (
                <button
                  key={i}
                  className="absolute top-0 h-full w-1 opacity-70 hover:opacity-100 transition-opacity"
                  style={{
                    left: `${(wp.time_s / totalDuration) * 100}%`,
                    background: wp.type === "phase" ? PHASE_COLORS[wp.phase] || "#fff"
                      : wp.type === "near_climax" ? "#f59e0b"
                      : "hsl(var(--primary))",
                  }}
                  onClick={() => jumpToWaypoint(i)}
                  title={wp.type === "event" ? wp.event.note : wp.type === "near_climax" ? (wp.nc.ai_label || "Near-climax") : wp.label}
                />
              ))}
            </div>
            <input
              type="range"
              min={0}
              max={totalDuration}
              step={1}
              value={currentTime}
              onChange={handleScrub}
              className="w-full h-1 opacity-0 absolute"
              style={{ marginTop: "-8px", cursor: "pointer" }}
            />
            {/* Visible range input on top */}
            <input
              type="range"
              min={0}
              max={totalDuration}
              step={1}
              value={currentTime}
              onChange={handleScrub}
              className="w-full accent-primary"
              style={{ height: "16px", marginTop: "-20px", opacity: 0, cursor: "pointer", position: "relative" }}
            />
          </div>

          {/* Controls */}
          <div className="flex items-center justify-center gap-3">
            <Button size="sm" variant="ghost" onClick={handleReset} className="h-8 w-8 p-0">
              <SkipBack className="w-4 h-4" />
            </Button>
            <Button size="sm" variant="ghost" onClick={jumpPrev} className="h-8 w-8 p-0">
              <SkipBack className="w-3.5 h-3.5" />
            </Button>
            <Button
              size="sm"
              onClick={handlePlayPause}
              className="h-10 w-10 p-0 rounded-full"
              style={{ background: phaseColor }}
            >
              {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
            </Button>
            <Button size="sm" variant="ghost" onClick={jumpNext} className="h-8 w-8 p-0">
              <SkipForward className="w-3.5 h-3.5" />
            </Button>
            <span className="text-[10px] text-muted-foreground ml-2">10× speed</span>
          </div>

          {/* Active waypoint card */}
          {activeWp && (
            <div
              className="rounded-xl p-3 space-y-1.5 border"
              style={{
                background: activeWp.type === "phase"
                  ? (PHASE_COLORS[activeWp.phase] || "#888") + "18"
                  : activeWp.type === "near_climax"
                  ? "#f59e0b18"
                  : "hsl(var(--primary) / 0.08)",
                borderColor: activeWp.type === "phase"
                  ? (PHASE_COLORS[activeWp.phase] || "#888") + "66"
                  : activeWp.type === "near_climax"
                  ? "#f59e0b66"
                  : "hsl(var(--primary) / 0.3)",
              }}
            >
              <div className="flex items-center gap-2">
                {activeWp.type === "phase" && <Flag className="w-4 h-4" style={{ color: PHASE_COLORS[activeWp.phase] }} />}
                {activeWp.type === "event" && <Activity className="w-4 h-4 text-primary" />}
                {activeWp.type === "near_climax" && <Zap className="w-4 h-4 text-yellow-500" />}
                <span
                  className="text-xs font-semibold uppercase tracking-wide"
                  style={{
                    color: activeWp.type === "phase" ? PHASE_COLORS[activeWp.phase]
                      : activeWp.type === "near_climax" ? "#f59e0b"
                      : "hsl(var(--primary))",
                  }}
                >
                  {activeWp.type === "phase" ? activeWp.label
                    : activeWp.type === "near_climax" ? (activeWp.nc.ai_label || "Near-Climax Event")
                    : getCategoryMeta(activeWp.event.category).label}
                </span>
                <span className="text-xs text-muted-foreground ml-auto font-mono">{fmtTime(activeWp.time_s)}</span>
              </div>

              {activeWp.type === "event" && (
                <p className="text-sm text-foreground leading-relaxed pl-6">{activeWp.event.note}</p>
              )}
              {activeWp.type === "near_climax" && (
                <div className="pl-6 space-y-0.5">
                  <p className="text-sm text-foreground leading-relaxed">{activeWp.nc.ai_interpretation || "Near-climax physiological event detected."}</p>
                  <div className="flex gap-3 mt-1">
                    <span className="text-[10px] text-muted-foreground">Peak: <span className="text-foreground font-mono">{activeWp.nc.peak_hr} bpm</span></span>
                    <span className="text-[10px] text-muted-foreground">Rise: <span className="text-foreground font-mono">+{activeWp.nc.rise_bpm} bpm</span></span>
                    <span className="text-[10px] text-muted-foreground">Confidence: <span className="text-foreground font-mono">{Math.round((activeWp.nc.confidence || 0) * 100)}%</span></span>
                  </div>
                </div>
              )}
              {activeWp.type === "phase" && currentHR && (
                <p className="text-sm text-muted-foreground pl-6">HR at this moment: <span className="text-foreground font-bold font-mono">{currentHR} bpm</span></p>
              )}

              {/* Continue button */}
              <div className="pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    setPausedAt(null);
                    setActiveWaypointIdx(null);
                    setPlaying(true);
                  }}
                >
                  Continue <Play className="w-3 h-3 ml-1" />
                </Button>
              </div>
            </div>
          )}

          {/* Waypoint list */}
          <div className="space-y-1">
            <p className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wide">All Waypoints</p>
            <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
              {waypoints.length === 0 && (
                <p className="text-xs text-muted-foreground">No events or markers found for this session.</p>
              )}
              {waypoints.map((wp, i) => {
                const isActive = activeWaypointIdx === i;
                const isPast = wp.time_s <= currentTime;
                return (
                  <button
                    key={i}
                    onClick={() => jumpToWaypoint(i)}
                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors ${
                      isActive ? "bg-primary/15 border border-primary/30" : "hover:bg-muted/60"
                    }`}
                  >
                    <span
                      className="shrink-0 w-1.5 h-1.5 rounded-full"
                      style={{
                        background: wp.type === "phase" ? PHASE_COLORS[wp.phase]
                          : wp.type === "near_climax" ? "#f59e0b"
                          : isPast ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))",
                      }}
                    />
                    <span className="text-[10px] font-mono text-muted-foreground w-10 shrink-0">{fmtTime(wp.time_s)}</span>
                    <span className={`text-xs truncate ${isActive ? "text-primary font-medium" : isPast ? "text-foreground" : "text-muted-foreground"}`}>
                      {wp.type === "phase" ? wp.label
                        : wp.type === "near_climax" ? (wp.nc.ai_label || "Near-Climax")
                        : wp.event.note}
                    </span>
                    {wp.type === "near_climax" && <Zap className="w-3 h-3 text-yellow-500 shrink-0" />}
                    {wp.type === "phase" && <Flag className="w-3 h-3 shrink-0" style={{ color: PHASE_COLORS[wp.phase] }} />}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}