import { useState, useEffect, useMemo, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import PageHeader from "../components/PageHeader";
import { ArrowLeft, Star, Trash2, Heart, Clock, Zap, Pencil, XCircle } from "lucide-react";
import AITagSuggester from "../components/AITagSuggester";
import AIChat from "../components/AIChat";
import SessionExportButton from "../components/SessionExportButton";
import moment from "moment";
import HRTimelineChart from "../components/HRTimelineChart";
import EMGTimelineChart from "../components/EMGTimelineChart";
import HRZoneAnalysis from "../components/HRZoneAnalysis";
import HREventOverlayChart from "../components/HREventOverlayChart";
import HRPhysiologicalAnalysis from "../components/HRPhysiologicalAnalysis";
import NearClimaxEvents, { detectNearClimaxEvents } from "../components/NearClimaxEvents";
import NearClimaxSessionOverview from "../components/NearClimaxSessionOverview";
import SessionAIPanel from "../components/SessionAIPanel";
import SessionExecutiveSummary from "../components/SessionExecutiveSummary";
import CascadeOverviewPanel from "../components/CascadeOverviewPanel";
import ArousalEventChart from "../components/ArousalEventChart";
import UnifiedSessionTimeline from "../components/UnifiedSessionTimeline";
import InteractiveSessionTimeline from "../components/InteractiveSessionTimeline";
import InteractiveTimelinePlayer from "../components/InteractiveTimelinePlayer";
import NoClimaxAIPanel from "../components/NoClimaxAIPanel";
import SessionTimelineNarrative from "../components/SessionTimelineNarrative";
import JournalRecorder from "../components/JournalRecorder";
import { EVENT_CATEGORIES } from "../components/session-form/EventTimelineSection";

function getCategoryMeta(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

function fmtMmSs(s) {
  const totalS = Math.round(Number(s));
  const m = Math.floor(totalS / 60);
  const sec = totalS % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger
} from "@/components/ui/alert-dialog";

function InfoRow({ label, value }) {
  if (!value && value !== 0) return null;
  return (
    <div className="flex justify-between py-2 border-b border-border last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-right max-w-[60%]">{value}</span>
    </div>
  );
}

function MetricBadge({ label, value, max = 10 }) {
  if (!value) return null;
  const pct = (value / max) * 100;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-bold">{value}/{max}</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function SessionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [timelineRows, setTimelineRows] = useState([]);
  const [emgRows, setEmgRows] = useState([]);
  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedNearClimaxIdx, setSelectedNearClimaxIdx] = useState(null);
  const [lightboxPhoto, setLightboxPhoto] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [sessionNotes, setSessionNotes] = useState("");
  const [sessionJournal, setSessionJournal] = useState(null);

  const nearClimaxEvents = useMemo(() => {
    if (!session) return [];
    if (session.ai_near_climax_events?.length > 0) return session.ai_near_climax_events;
    return detectNearClimaxEvents(timelineRows, session.climax_offset_s, session.pre_climax_offset_s);
  }, [timelineRows, session]);

  // Auto-select first event once events are available
  useEffect(() => {
    if (nearClimaxEvents.length > 0 && selectedNearClimaxIdx == null) {
      setSelectedNearClimaxIdx(0);
    }
  }, [nearClimaxEvents.length]);

  const highlightRange = useMemo(() => {
    if (selectedNearClimaxIdx == null || !nearClimaxEvents[selectedNearClimaxIdx]) return null;
    const ev = nearClimaxEvents[selectedNearClimaxIdx];
    return { start: ev.start_offset_s, end: ev.end_offset_s };
  }, [selectedNearClimaxIdx, nearClimaxEvents]);

  const elevatedTime = timelineRows.length > 1
    ? timelineRows.reduce((total, row, i) => {
        if (i === 0) return total;
        const delta = Number(row.elevated_delta);
        if (isNaN(delta) || delta <= 8) return total;
        const dt = Number(row.time_offset_s) - Number(timelineRows[i - 1].time_offset_s);
        return total + (dt > 0 ? dt : 0);
      }, 0)
    : null;

  useEffect(() => {
    (async () => {
      const [all, me] = await Promise.all([
        base44.entities.Session.filter({ id }),
        base44.auth.me(),
      ]);
      const s = all[0];
      setSession(s);
      setUserProfile(me);
      setChatMessages(s?.ai_analysis?._chat_messages || []);
      setSessionNotes(s?.notes || "");
      const rows = await base44.entities.HeartRateTimeline.filter({ session: id }, "time_offset_s", 10000);

      // Load journal for this session so it can be factored into AI analyses
      base44.entities.Journal.filter({ session_id: id }, "-created_date", 1).then((rows) => {
        if (rows[0]?.ai_journal) setSessionJournal(rows[0].ai_journal);
      });
      setTimelineRows(rows);

      // Load EMG data from the stored CSV file (client-side parse — no DB rows needed)
      if (s?.emg_data_file) {
        try {
          const csvResp = await fetch(s.emg_data_file);
          const text = await csvResp.text();
          const { parseEmgCsv } = await import("../utils/parseEmgCsv");
          const result = parseEmgCsv(text);
          if (!result.error) {
            const startRow = result.rows.find((r) => r.marker === "RECORD_START");
            const timeZero = startRow ? startRow.time_s : result.rows[0]?.time_s ?? 0;
            setEmgRows(result.rows.map((r) => ({ ...r, time_s: parseFloat((r.time_s - timeZero).toFixed(6)) })));
          }
        } catch (_) {
          setEmgRows([]);
        }
      }

      // Auto-detect phase markers if not already set
      if (rows.length > 10 && s && !s.climax_offset_s) {
        // Climax: peak HR in last 60% of session
        const startIdx = Math.floor(rows.length * 0.25);
        let peakIdx = startIdx;
        for (let i = startIdx; i < rows.length; i++) {
          if (Number(rows[i].hr) > Number(rows[peakIdx].hr)) peakIdx = i;
        }
        const climaxOffset = Number(rows[peakIdx].time_offset_s);

        // Pre-climax: lowest HR point within 5 min before climax
        const windowStart = climaxOffset - 300;
        const windowEnd = climaxOffset - 15;
        let valleyIdx = peakIdx;
        let foundInWindow = false;
        for (let i = 0; i < rows.length; i++) {
          const t = Number(rows[i].time_offset_s);
          if (t < windowStart) continue;
          if (t > windowEnd) break;
          if (!foundInWindow || Number(rows[i].hr) < Number(rows[valleyIdx].hr)) {
            valleyIdx = i;
            foundInWindow = true;
          }
        }
        const preClimaxOffset = Number(rows[valleyIdx].time_offset_s);

        // Recovery: first point after 15s where HR is falling for 4 consecutive samples and dropped 2%
        const peakHr = Number(rows[peakIdx].hr);
        let searchStart = peakIdx + 1;
        for (let i = peakIdx + 1; i < rows.length; i++) {
          if (Number(rows[i].time_offset_s) >= Number(rows[peakIdx].time_offset_s) + 15) { searchStart = i; break; }
        }
        let recoveryIdx = Math.min(searchStart, rows.length - 1);
        for (let i = searchStart; i <= rows.length - 4; i++) {
          const hr = Number(rows[i].hr);
          if (
            hr < Number(rows[i - 1].hr) &&
            Number(rows[i + 1].hr) < hr &&
            Number(rows[i + 2].hr) < Number(rows[i + 1].hr) &&
            Number(rows[i + 3].hr) < Number(rows[i + 2].hr) &&
            hr <= peakHr * 0.98
          ) {
            recoveryIdx = i;
            break;
          }
        }
        const recoveryOffset = Number(rows[recoveryIdx].time_offset_s);

        const updates = {
          pre_climax_offset_s: preClimaxOffset,
          climax_offset_s: climaxOffset,
          recovery_offset_s: recoveryOffset,
        };

        // Compute HR metrics
        const lo = Math.min(preClimaxOffset, climaxOffset);
        const hi = Math.max(preClimaxOffset, climaxOffset);
        const seg = rows.filter((r) => Number(r.time_offset_s) >= lo && Number(r.time_offset_s) <= hi);
        if (seg.length > 0) updates.hr_avg_pre_to_climax = Math.round(seg.reduce((a, r) => a + Number(r.hr), 0) / seg.length);

        const win = rows.filter((r) => Math.abs(Number(r.time_offset_s) - climaxOffset) <= 30);
        if (win.length > 0) updates.hr_avg_at_climax_window = Math.round(win.reduce((a, r) => a + Number(r.hr), 0) / win.length);

        await base44.entities.Session.update(id, updates);
        setSession((prev) => ({ ...prev, ...updates }));
      } else if (rows.length > 0 && s && (!s.hr_avg_pre_to_climax || !s.hr_avg_at_climax_window)) {
        // Auto-compute phase HR metrics for existing sessions with markers but no computed values
        const updates = {};
        if (s.pre_climax_offset_s != null && s.climax_offset_s != null && !s.hr_avg_pre_to_climax) {
          const lo = Math.min(s.pre_climax_offset_s, s.climax_offset_s);
          const hi = Math.max(s.pre_climax_offset_s, s.climax_offset_s);
          const seg = rows.filter((r) => Number(r.time_offset_s) >= lo && Number(r.time_offset_s) <= hi);
          if (seg.length > 0)
            updates.hr_avg_pre_to_climax = Math.round(seg.reduce((a, r) => a + Number(r.hr), 0) / seg.length);
        }
        if (s.climax_offset_s != null && !s.hr_avg_at_climax_window) {
          const win = rows.filter((r) => Math.abs(Number(r.time_offset_s) - s.climax_offset_s) <= 30);
          if (win.length > 0)
            updates.hr_avg_at_climax_window = Math.round(win.reduce((a, r) => a + Number(r.hr), 0) / win.length);
        }
        if (Object.keys(updates).length > 0) {
          await base44.entities.Session.update(id, updates);
          setSession((prev) => ({ ...prev, ...updates }));
        }
      }

      setLoading(false);
    })();
  }, [id]);

  const handleDelete = async () => {
    await base44.entities.Session.delete(id);
    navigate("/sessions");
  };

  const toggleFav = async () => {
    await base44.entities.Session.update(id, { is_favorite: !session.is_favorite });
    setSession((s) => ({ ...s, is_favorite: !s.is_favorite }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!session) {
    return <div className="p-6 text-center text-muted-foreground">Session not found</div>;
  }

  const s = session;
  const cap = (str) => str ? str.charAt(0).toUpperCase() + str.slice(1) : str;

  return (
    <div>
      <div className="px-2 md:px-4 pt-4 flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-lg font-bold">{moment(s.date).format("MMM D, YYYY")}</h1>
          <p className="text-xs text-muted-foreground flex items-center gap-1 flex-wrap">
            {s.start_time && <><Clock className="w-3 h-3" />{s.start_time}</>}
            {s.end_time && ` – ${s.end_time}`}
            {s.duration_minutes && <> · <strong>{s.duration_minutes}m</strong></>}
            {s.is_quick_entry && <><Zap className="w-3 h-3 ml-1" /> Quick</>}
            {s.no_climax && (
              <span className="inline-flex items-center gap-1 ml-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
                <XCircle className="w-3 h-3" /> No Climax
              </span>
            )}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => navigate(`/sessions/${id}/edit`)}>
          <Pencil className="w-5 h-5 text-muted-foreground" />
        </Button>
        <SessionExportButton session={s} timelineRows={timelineRows} />
        <Button variant="ghost" size="icon" onClick={toggleFav}>
          <Star className={`w-5 h-5 ${s.is_favorite ? "text-yellow-500 fill-yellow-500" : "text-muted-foreground"}`} />
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon"><Trash2 className="w-5 h-5 text-destructive" /></Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete session?</AlertDialogTitle>
              <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <div className="px-2 md:px-4 py-4 space-y-4 pb-8">
        {/* Executive Summary */}
        <SessionExecutiveSummary
          session={s}
          timelineRows={timelineRows}
          onScoreComputed={async (pct) => {
            if (pct != null && s.ai_analysis?.score !== pct) {
              const updated = { ...(s.ai_analysis || {}), score: pct };
              await base44.entities.Session.update(id, { ai_analysis: updated });
              setSession((prev) => ({ ...prev, ai_analysis: updated }));
            }
          }}
        />

        {/* Subjective Metrics */}
        <div className="bg-card rounded-xl border border-border p-4 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Metrics</h3>
          <MetricBadge label={s.no_climax ? "Peak Arousal" : "Intensity"} value={s.intensity} />
          <MetricBadge label="Build Quality" value={s.build_quality} />
          <MetricBadge label="Satisfaction" value={s.satisfaction} />
          {s.build_type && <InfoRow label="Build Type" value={s.build_type === "Other" && s.custom_build_type ? s.custom_build_type : s.build_type} />}
          {!s.no_climax && s.climax_duration && (
            <InfoRow label="Climax Duration" value={cap(s.climax_duration)} />
          )}
        </div>

        {/* Heart Rate + Most Recent Side-by-Side */}
        <div className="bg-card rounded-xl border border-border p-4">
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
            <Heart className="w-3.5 h-3.5" /> Heart Rate
          </h3>
          <div className="grid grid-cols-3 gap-3">
            {[["Avg", s.avg_hr], ["Max", s.max_hr], ["Climax", s.hr_at_climax]].map(([label, val]) => (
              <div key={label} className="text-center">
                <p className="text-2xl font-bold font-mono">{val || "—"}</p>
                <p className="text-[10px] text-muted-foreground uppercase">{label}</p>
              </div>
            ))}
          </div>
          {!s.no_climax && (s.hr_avg_pre_to_climax || s.hr_avg_at_climax_window) && (
            <div className="grid grid-cols-2 gap-2">
              {s.hr_avg_pre_to_climax && (
                <div className="flex items-center justify-between rounded-lg bg-chart-2/10 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Avg HR Pre→Climax</span>
                  <span className="text-sm font-mono font-bold text-chart-2">{s.hr_avg_pre_to_climax} bpm</span>
                </div>
              )}
              {s.hr_avg_at_climax_window && (
                <div className="flex items-center justify-between rounded-lg bg-chart-3/10 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Avg HR ±30s Climax</span>
                  <span className="text-sm font-mono font-bold text-chart-3">{s.hr_avg_at_climax_window} bpm</span>
                </div>
              )}
            </div>
          )}
          {elevatedTime != null && elevatedTime > 0 && (
            <div className="flex items-center justify-between rounded-lg bg-chart-3/10 px-3 py-2">
              <span className="text-xs text-muted-foreground">Elevated Time <span className="text-[10px]">(Δ &gt; 8)</span></span>
              <span className="text-sm font-mono font-bold text-chart-3">{Math.floor(elevatedTime / 60) > 0 ? `${Math.floor(elevatedTime / 60)}m ${Math.round(elevatedTime % 60)}s` : `${Math.round(elevatedTime)}s`}</span>
            </div>
          )}
          <div className="space-y-3">
              {timelineRows.length > 0 && (
                <HRTimelineChart
                  rows={timelineRows}
                  savedMarkers={{
                    pre_climax_offset_s: s.pre_climax_offset_s,
                    climax_offset_s: s.climax_offset_s,
                    recovery_offset_s: s.recovery_offset_s,
                  }}
                  onMarkersChange={async (markers) => {
                    await base44.entities.Session.update(id, markers);
                    setSession((prev) => ({ ...prev, ...markers }));
                  }}
                  highlightRange={highlightRange}
                  noClimax={!!s.no_climax}
                  nearClimaxEvents={nearClimaxEvents}
                />
              )}
              {timelineRows.length > 0 && !s.no_climax && (
                <NearClimaxEvents
                  timelineRows={timelineRows}
                  session={s}
                  selectedIndex={selectedNearClimaxIdx}
                  onSelectIndex={setSelectedNearClimaxIdx}
                  onEventsRefined={(refined) => setSession((prev) => ({ ...prev, ai_near_climax_events: refined }))}
                  userProfile={userProfile}
                />
              )}
              {timelineRows.length > 0 && !s.no_climax && nearClimaxEvents.length > 0 && (
                <NearClimaxSessionOverview
                  session={s}
                  nearClimaxEvents={nearClimaxEvents}
                  userProfile={userProfile}
                />
              )}
              {timelineRows.length > 0 && (
                <HRZoneAnalysis rows={timelineRows} sessionMaxHR={s.max_hr} userProfile={userProfile} />
              )}
              {timelineRows.length > 0 && (
                <HRPhysiologicalAnalysis timelineRows={timelineRows} session={s} />
              )}
              {timelineRows.length > 0 && (s.event_timeline || []).length > 0 && (
                <HREventOverlayChart
                  timelineRows={timelineRows}
                  events={s.event_timeline}
                  session={s}
                  nearClimaxEvents={nearClimaxEvents}
                />
              )}
              {timelineRows.length === 0 && s.hr_timeline?.length > 0 && (
                <div className="h-32">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={s.hr_timeline}>
                      <XAxis dataKey="minute" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} domain={["auto", "auto"]} />
                      <Tooltip />
                      <Line type="monotone" dataKey="hr" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
        </div>

        </div>
        </div>

        {/* EMG */}
        {(emgRows.length > 0 || s.emg_enabled) && (
          <div className="bg-card rounded-xl border border-border p-4 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">EMG</h3>
            {s.emg_target_area && <p className="text-xs text-muted-foreground">Target: {s.emg_target_area}</p>}
            {emgRows.length > 0 ? (
              <EMGTimelineChart
                rows={emgRows}
                channelMode={s.emg_channels || "single"}
                events={s.event_timeline || []}
                savedMarkers={{
                  pre_climax_offset_s: s.pre_climax_offset_s,
                  climax_offset_s: s.climax_offset_s,
                  recovery_offset_s: s.recovery_offset_s,
                }}
                timelineRows={timelineRows}
              />
            ) : (
              <p className="text-xs text-muted-foreground">EMG recorded but no timeline data imported yet. Edit session to upload CSV.</p>
            )}
            {/* Placement photos (thumbnails) + notes side by side */}
            {(s.emg_placement_photos?.length > 0 || s.emg_general_notes || s.emg_left_placement_notes || s.emg_right_placement_notes) && (
              <div className="flex gap-3 items-start">
                {s.emg_placement_photos?.length > 0 && (
                  <div className="flex flex-col gap-1.5 shrink-0">
                    {s.emg_placement_photos.map((photo, i) => (
                      <button
                        key={i}
                        onClick={() => setLightboxPhoto(photo)}
                        className="block rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-1 focus:ring-primary"
                        title={photo.caption || photo.tag || "View photo"}
                      >
                        <img src={photo.url} alt={photo.caption || ""} className="w-16 h-16 object-cover" />
                      </button>
                    ))}
                  </div>
                )}
                {(s.emg_general_notes || s.emg_left_placement_notes || s.emg_right_placement_notes) && (
                  <div className="flex-1 space-y-1.5 text-xs text-foreground/80">
                    {s.emg_left_placement_notes && (
                      <p><span className="font-semibold text-muted-foreground">Left: </span>{s.emg_left_placement_notes}</p>
                    )}
                    {s.emg_right_placement_notes && (
                      <p><span className="font-semibold text-muted-foreground">Right: </span>{s.emg_right_placement_notes}</p>
                    )}
                    {s.emg_general_notes && <p className="whitespace-pre-wrap">{s.emg_general_notes}</p>}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Lightbox */}
        {lightboxPhoto && (
          <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
            onClick={() => setLightboxPhoto(null)}
          >
            <div className="max-w-lg w-full space-y-2" onClick={(e) => e.stopPropagation()}>
              <img src={lightboxPhoto.url} alt={lightboxPhoto.caption || ""} className="rounded-xl w-full object-contain max-h-[70vh]" />
              {(lightboxPhoto.caption || lightboxPhoto.tag) && (
                <div className="text-center">
                  {lightboxPhoto.caption && <p className="text-sm text-white">{lightboxPhoto.caption}</p>}
                  {lightboxPhoto.tag && <p className="text-xs text-white/60">{lightboxPhoto.tag}</p>}
                </div>
              )}
              <button
                onClick={() => setLightboxPhoto(null)}
                className="w-full text-xs text-white/60 hover:text-white py-2"
              >
                Tap to close
              </button>
            </div>
          </div>
        )}

        {/* Methods */}
        <div className="bg-card rounded-xl border border-border p-4 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Methods</h3>
          <div className="flex flex-wrap gap-1.5">
            {(s.methods || []).map((m) => <Badge key={m} variant="secondary">{m}</Badge>)}
          </div>
          {s.foley_size && <InfoRow label="Foley Size" value={`${s.foley_size} Fr`} />}
          {s.foley_type && <InfoRow label="Foley Type" value={s.foley_type} />}
          {s.estim_notes && <InfoRow label="E-Stim Notes" value={s.estim_notes} />}
          {s.sleeve_type && <InfoRow label="Sleeve" value={s.sleeve_type} />}
          {s.tens_placement && <InfoRow label="TENS Placement" value={s.tens_placement} />}
          {s.estim_screenshot && (
            <img src={s.estim_screenshot} alt="E-Stim settings" className="rounded-lg w-full mt-2" />
          )}
        </div>

        {/* Context */}
        <div className="bg-card rounded-xl border border-border p-4 space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary mb-2">Context</h3>
          <InfoRow label="Mood" value={cap(s.mood)} />
          <InfoRow label="Environment" value={cap(s.environment)} />
          <InfoRow label="Hydration" value={cap(s.hydration)} />
        </div>

        {/* Physiological */}
        <div className="bg-card rounded-xl border border-border p-4 space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary mb-2">Physiological</h3>
          <InfoRow label="Ejaculate Volume" value={cap(s.ejaculate_volume)} />
          {s.discomfort_entries?.length > 0 && (
            <div className="py-2 border-b border-border space-y-1.5">
              <span className="text-sm text-muted-foreground">Discomfort Log</span>
              {s.discomfort_entries.map((e, i) => (
                <div key={i} className="flex items-start gap-2 bg-muted/50 rounded-lg px-3 py-2">
                  <span className="text-xs font-bold text-destructive shrink-0 w-16">Sev {e.severity}/10</span>
                  <span className="text-sm text-foreground leading-snug whitespace-pre-wrap">{e.note}</span>
                </div>
              ))}
            </div>
          )}
          {!s.discomfort_entries?.length && <InfoRow label="Discomfort" value={s.discomfort ? "Yes" : "No"} />}
          {s.unusual_sensations && <InfoRow label="Unusual Sensations" value={s.unusual_sensations} />}
          {s.refractory_notes && <InfoRow label="Refractory Notes" value={s.refractory_notes} />}
        </div>

        {/* Notes */}
        {s.notes && (
          <div className="bg-card rounded-xl border border-border p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-primary mb-2">Notes</h3>
            <p className="text-sm whitespace-pre-wrap">{s.notes}</p>
          </div>
        )}

        {/* Media */}
        {((s.media_images || []).length > 0 || (s.media_videos || []).length > 0 || s.video_link) && (
          <div className="bg-card rounded-xl border border-border p-4 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Media</h3>
            {s.media_images?.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {s.media_images.map((url, i) => (
                  <img key={i} src={url} alt="" className="rounded-lg w-full aspect-square object-cover" />
                ))}
              </div>
            )}
            {(s.media_videos || []).length > 0 && (
              <div className="space-y-2">
                {s.media_videos.map((url, i) => (
                  <video key={i} src={url} controls className="w-full rounded-lg bg-black" />
                ))}
              </div>
            )}
            {s.video_link && (
              <a href={s.video_link} target="_blank" rel="noopener noreferrer" className="text-sm text-primary underline">
                Video Link →
              </a>
            )}
          </div>
        )}

        {/* Pause / Active Time */}
        {(() => {
          const events = s.event_timeline || [];
          const cats = (ev) => Array.isArray(ev.category) ? ev.category : [ev.category].filter(Boolean);
          const sorted = [...events].sort((a, b) => a.time_s - b.time_s);
          let totalPause = 0;
          let pauseStart = null;
          for (const ev of sorted) {
            const c = cats(ev);
            if (c.includes("stimulation_paused") && pauseStart == null) pauseStart = ev.time_s;
            if (c.includes("stimulation_resumed") && pauseStart != null) {
              totalPause += ev.time_s - pauseStart;
              pauseStart = null;
            }
          }
          if (totalPause === 0) return null;
          const totalS = (s.duration_minutes || 0) * 60;
          const activeS = totalS > 0 ? Math.max(0, totalS - totalPause) : null;
          const fmtS = (v) => { const m = Math.floor(v / 60); const sec = Math.round(v % 60); return m > 0 ? `${m}m ${sec}s` : `${sec}s`; };
          return (
            <div className="bg-card rounded-xl border border-border p-4 space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Stimulation Timing</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-muted/50 rounded-lg p-3 text-center">
                  <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Paused</p>
                  <p className="text-2xl font-bold font-mono text-destructive">{fmtS(totalPause)}</p>
                </div>
                {activeS != null && (
                  <div className="bg-muted/50 rounded-lg p-3 text-center">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Active</p>
                    <p className="text-2xl font-bold font-mono text-chart-1">{fmtS(activeS)}</p>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Interactive Timeline Player */}
        {(timelineRows.length > 0 || (s.event_timeline || []).length > 0 || (s.ai_near_climax_events || []).length > 0) && (
          <InteractiveTimelinePlayer session={s} timelineRows={timelineRows} />
        )}

        {/* Interactive Multi-Track Timeline */}
        {(timelineRows.length > 0 || (s.event_timeline || []).length > 0) && (
          <InteractiveSessionTimeline session={s} timelineRows={timelineRows} />
        )}

        {/* Unified Interactive Timeline */}
        {timelineRows.length > 0 && (
          <UnifiedSessionTimeline session={s} timelineRows={timelineRows} />
        )}

        {/* Arousal Arc + Event Correlation */}
        {((session.event_timeline || []).length > 0 || timelineRows.length > 0) && (
          <ArousalEventChart session={s} timelineRows={timelineRows} />
        )}

        {/* Cascade + AI — only for climax sessions */}
        {!s.no_climax && <CascadeOverviewPanel session={s} timelineRows={timelineRows} emgRows={emgRows} userProfile={userProfile} sessionJournal={sessionJournal} />}
        {!s.no_climax && <SessionAIPanel session={s} timelineRows={timelineRows} emgRows={emgRows} userProfile={userProfile} sessionJournal={sessionJournal} />}

        {/* Timeline & Arousal Narrative */}
        {!s.no_climax && <SessionTimelineNarrative session={s} timelineRows={timelineRows} userProfile={userProfile} sessionJournal={sessionJournal} />}

        {/* No-Climax AI Analysis */}
        {s.no_climax && <NoClimaxAIPanel session={s} timelineRows={timelineRows} userProfile={userProfile} />}

        {/* Session Journal */}
        <JournalRecorder session={s} timelineRows={timelineRows} />

        {/* Ask the AI — Session Deep Dive */}
        <AIChat
          mode="session"
          userProfile={userProfile}
          context={[
            `Session date: ${s.date?.slice(0, 10)}`,
            `Duration: ${s.duration_minutes ?? "?"}min`,
            `Methods: ${(s.methods || []).join(", ")}`,
            s.foley_size ? `Foley: ${s.foley_size}Fr ${s.foley_type || ""}` : null,
            s.estim_notes ? `E-Stim notes: ${s.estim_notes}` : null,
            `Intensity: ${s.intensity}/10, Build quality: ${s.build_quality}/10, Satisfaction: ${s.satisfaction}/10`,
            `Build type: ${s.build_type}${s.custom_build_type ? " — " + s.custom_build_type : ""}`,
            `Climax duration: ${s.climax_duration ?? "?"}`,
            `Mood: ${s.mood}, Hydration: ${s.hydration}`,
            s.avg_hr ? `HR: avg ${s.avg_hr}, max ${s.max_hr}, at climax ${s.hr_at_climax ?? "?"}` : null,
            s.pre_climax_offset_s != null ? (() => { const fmt = (v) => { if (v == null) return "?"; const m = Math.floor(v/60); const sec = Math.round(v%60); return `${m}:${sec.toString().padStart(2,"0")}`; }; return `Phase markers: pre-climax ${fmt(s.pre_climax_offset_s)}, climax ${fmt(s.climax_offset_s)}, recovery ${fmt(s.recovery_offset_s)}`; })() : null,
            s.ejaculate_volume ? `Ejaculate: ${s.ejaculate_volume}` : null,
            s.unusual_sensations ? `Unusual sensations: ${s.unusual_sensations}` : null,
            (s.discomfort_entries || []).length ? `Discomfort: ${s.discomfort_entries.map(e => `sev ${e.severity}/10 — ${e.note}`).join("; ")}` : null,
            (s.event_timeline || []).length ? `Events: ${s.event_timeline.map(e => { const m = Math.floor(e.time_s / 60); const sec = Math.round(e.time_s % 60); return `[${m}:${sec.toString().padStart(2,"0")}] ${e.note}`; }).join(" | ")}` : null,
            s.notes ? `Session notes: ${s.notes}` : null,
          ].filter(Boolean).join("\n")}
          savedMessages={chatMessages}
          savedNotes={sessionNotes}
          onSaveMessages={async (msgs) => {
            setChatMessages(msgs);
            const updated = { ...(s.ai_analysis || {}), _chat_messages: msgs };
            await base44.entities.Session.update(id, { ai_analysis: updated });
          }}
          onSaveNotes={async (merged) => {
            setSessionNotes(merged);
            await base44.entities.Session.update(id, { notes: merged });
          }}
        />

        {/* Tags */}
        <div className="bg-card rounded-xl border border-border p-4 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Tags</h3>
          {(s.tags || []).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {s.tags.map((t) => <Badge key={t} variant="outline">{t}</Badge>)}
            </div>
          )}
          <AITagSuggester
            session={s}
            onTagsAdded={(merged) => setSession((prev) => ({ ...prev, tags: merged }))}
          />
        </div>
      </div>
    </div>
  );
}