import { useState, useRef, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Mic, MicOff, Brain, BookOpen, ChevronDown, ChevronUp, Trash2, Save } from "lucide-react";
import TTSReader from "./TTSReader";
import JournalPrompts from "./JournalPrompts";

const WHISPER_PROMPT =
  "Post-session reflection. Physiological sensations. Arousal buildup. Climax experience. Heart rate. Muscle tension. Pelvic floor. E-stim. Foley catheter. Refractory period. Emotional state. What worked well. What to try next time.";

const SECTION_COLORS = {
  emotional_reflection:       "hsl(var(--chart-3))",
  physiological_observations: "hsl(var(--primary))",
  experience_narrative:       "hsl(var(--chart-2))",
  insights:                   "hsl(var(--accent))",
  next_session_intentions:    "hsl(var(--chart-4))",
};

const SECTION_LABELS = {
  emotional_reflection:       "Emotional Reflection",
  physiological_observations: "Physiological Observations",
  experience_narrative:       "Experience Narrative",
  insights:                   "Insights",
  next_session_intentions:    "Next Session Intentions",
};

export default function JournalRecorder({ session, timelineRows = [] }) {
  const [collapsed, setCollapsed] = useState(true);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [generating, setGenerating] = useState(false);
  const [journal, setJournal] = useState(null);   // loaded or freshly generated
  const [journalId, setJournalId] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef  = useRef([]);

  // Load existing journal for this session on mount
  useEffect(() => {
    base44.entities.Journal.filter({ session_id: session.id }, "-created_date", 1).then((rows) => {
      if (rows[0]) {
        setJournalId(rows[0].id);
        setJournal(rows[0].ai_journal || null);
        setTranscript(rows[0].voice_transcript || "");
      }
    });
  }, [session.id]);

  // ── Recording ──────────────────────────────────────────────────────────────
  const startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/ogg";
    const mr = new MediaRecorder(stream, { mimeType });
    mediaRecorderRef.current = mr;

    mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setTranscribing(true);

      const blob = new Blob(audioChunksRef.current, { type: mimeType });
      const ab   = await blob.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const base64 = btoa(bin);

      const res  = await base44.functions.invoke("whisperSTT", {
        audio_base64: base64,
        mime_type:    mimeType,
        prompt:       WHISPER_PROMPT,
      });
      const text = res.data?.text?.trim() || "";
      setTranscript(text);
      setTranscribing(false);
    };

    mr.start();
    setRecording(true);
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };

  // ── Generate ───────────────────────────────────────────────────────────────
  const generate = async () => {
    setGenerating(true);
    setJournal(null);
    setError(null);

    const sessionData = {
      date:               session.date,
      duration_minutes:   session.duration_minutes,
      methods:            session.methods,
      custom_methods:     session.custom_methods,
      intensity:          session.intensity,
      satisfaction:       session.satisfaction,
      build_quality:      session.build_quality,
      build_type:         session.build_type,
      climax_duration:    session.climax_duration,
      no_climax:          session.no_climax,
      mood:               session.mood,
      avg_hr:             session.avg_hr,
      max_hr:             session.max_hr,
      hr_at_climax:       session.hr_at_climax,
      ejaculate_volume:   session.ejaculate_volume,
      discomfort:         session.discomfort,
      discomfort_notes:   session.discomfort_notes,
      discomfort_entries: session.discomfort_entries,
      unusual_sensations: session.unusual_sensations,
      hydration:          session.hydration,
      substances:         session.substances,
      foley_size:         session.foley_size,
      foley_type:         session.foley_type,
      estim_notes:        session.estim_notes,
      refractory_notes:   session.refractory_notes,
      notes:              session.notes,
      event_timeline:     session.event_timeline,
    };

    const res = await base44.functions.invoke("generateJournal", {
      session_id:       session.id,
      voice_transcript: transcript,
      session_data:     sessionData,
    });

    const ai_journal = res.data?.journal;
    if (!ai_journal) {
      setError(res.data?.error || "Generation failed — no journal returned.");
      setGenerating(false);
      return;
    }

    setJournal(ai_journal);

    // Upsert Journal entity
    const payload = {
      session_id:       session.id,
      session_date:     session.date,
      voice_transcript: transcript,
      ai_journal,
    };

    if (journalId) {
      await base44.entities.Journal.update(journalId, payload);
    } else {
      const created = await base44.entities.Journal.create(payload);
      setJournalId(created.id);
    }

    setGenerating(false);
  };

  // ── Save Notes ─────────────────────────────────────────────────────────────
  const saveNotes = async () => {
    setSavingNotes(true);
    const payload = { session_id: session.id, session_date: session.date, voice_transcript: transcript };
    if (journalId) {
      await base44.entities.Journal.update(journalId, payload);
    } else {
      const created = await base44.entities.Journal.create(payload);
      setJournalId(created.id);
    }
    setSavingNotes(false);
    setNotesSaved(true);
    setTimeout(() => setNotesSaved(false), 2500);
  };

  // ── Delete ─────────────────────────────────────────────────────────────────
  const deleteJournal = async () => {
    if (!journalId) return;
    setDeleting(true);
    await base44.entities.Journal.delete(journalId);
    setJournal(null);
    setJournalId(null);
    setTranscript("");
    setDeleting(false);
  };

  // ── TTS paragraph list ─────────────────────────────────────────────────────
  const ORDERED_KEYS = [
    "emotional_reflection",
    "physiological_observations",
    "experience_narrative",
    "insights",
    "next_session_intentions",
  ];

  const buildParagraphs = (j) => {
    const paras = [];
    const meta  = [];
    if (j?.title) { paras.push(j.title); meta.push({ type: "title" }); }
    for (const key of ORDERED_KEYS) {
      if (!j?.[key]) continue;
      paras.push(j[key]);
      meta.push({ type: "section", key });
    }
    for (const moment of (j?.key_moments || [])) {
      paras.push(moment);
      meta.push({ type: "moment" });
    }
    return { paras, meta };
  };

  const { paras, meta } = buildParagraphs(journal);

  const dateStr = session.date
    ? new Date(session.date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "Session";

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button
          className="flex items-center gap-1.5 flex-1 text-left"
          onClick={() => setCollapsed((v) => !v)}
        >
          <h3 className="text-xs font-semibold uppercase tracking-wider text-accent flex items-center gap-1.5">
            <BookOpen className="w-4 h-4" /> Session Journal
          </h3>
          {journal && <span className="text-[9px] text-primary font-semibold ml-1">✓ saved</span>}
          {collapsed
            ? <ChevronDown className="w-4 h-4 text-muted-foreground ml-1" />
            : <ChevronUp   className="w-4 h-4 text-muted-foreground ml-1" />}
        </button>

        {/* Action buttons — always visible */}
        <div className="flex items-center gap-1.5">
          {journal && (
            <Button
              size="sm" variant="ghost"
              onClick={deleteJournal}
              disabled={deleting}
              className="h-7 w-7 p-0 text-destructive/70 hover:text-destructive"
              title="Delete journal"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
          <Button
            size="sm"
            onClick={generate}
            disabled={generating}
            className="h-7 text-xs gap-1.5"
          >
            {generating
              ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Writing…</>
              : <><Brain className="w-3 h-3" />{journal ? "Re-generate" : "Generate"}</>}
          </Button>
        </div>
      </div>

      {!collapsed && (
        <>
          {/* AI-driven reflection prompts */}
          <JournalPrompts
            session={session}
            timelineRows={timelineRows}
            onInsertPrompt={(text) => setTranscript((prev) => prev ? prev + "\n\n" + text : text)}
          />

          {/* Voice / Text note input */}
          <div className="space-y-2">
            <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider">Your Notes</p>
            <div className="flex items-center gap-2">
              <button
                onClick={recording ? stopRecording : startRecording}
                disabled={transcribing}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-50 ${
                  recording
                    ? "bg-destructive text-destructive-foreground animate-pulse"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                {transcribing
                  ? <><span className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />Transcribing…</>
                  : recording
                  ? <><MicOff className="w-3.5 h-3.5" />Stop Recording</>
                  : <><Mic className="w-3.5 h-3.5" />{transcript ? "Re-record" : "Record Voice Note"}</>}
              </button>
              {recording && (
                <span className="text-[10px] text-destructive animate-pulse font-medium">● Recording…</span>
              )}
            </div>

            <textarea
              value={transcript}
              onChange={(e) => { setTranscript(e.target.value); setNotesSaved(false); }}
              placeholder="Type your reflections here, or use the voice recorder above…"
              rows={4}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none text-foreground placeholder:text-muted-foreground"
            />
            {transcript && (
              <Button
                size="sm"
                variant="outline"
                onClick={saveNotes}
                disabled={savingNotes}
                className="h-7 text-xs gap-1.5 self-end"
              >
                {savingNotes
                  ? <><span className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />Saving…</>
                  : notesSaved
                  ? <><Save className="w-3 h-3 text-primary" />Saved!</>
                  : <><Save className="w-3 h-3" />Save Notes</>}
              </Button>
            )}
          </div>

          {/* AI journal output */}
          {journal && (
            <div className="space-y-2 border-t border-border pt-3">
              <TTSReader
                sessionId={`journal-${session.id}`}
                title={`${dateStr} – Session Journal`}
                paragraphs={paras}
                renderParagraph={(text, idx, isActive, isBuffering) => {
                  const m = meta[idx];
                  if (!m) return null;

                  if (m.type === "title") {
                    return (
                      <p className={`text-base font-semibold leading-snug border-l-2 pl-3 py-1 transition-all rounded-r-md ${
                        isActive ? "border-accent bg-accent/10 text-foreground" : "border-accent/50 text-foreground"
                      }`}>
                        {text}
                      </p>
                    );
                  }

                  if (m.type === "moment") {
                    return (
                      <li className={`text-sm pl-3 border-l-2 py-0.5 list-none leading-relaxed transition-all rounded-r-md ${
                        isActive ? "border-chart-4 bg-chart-4/10" : "border-chart-4/40"
                      }`} style={{ color: "hsl(var(--foreground))" }}>
                        {isBuffering && <span className="inline-block w-2.5 h-2.5 border-2 border-t-transparent rounded-full animate-spin mr-1.5 align-middle" style={{ borderColor: "hsl(var(--chart-4))" }} />}
                        {text}
                      </li>
                    );
                  }

                  const color = SECTION_COLORS[m.key] || "hsl(var(--primary))";
                  const label = SECTION_LABELS[m.key] || m.key;

                  return (
                    <div
                      className="pl-3 border-l-2 py-2 leading-relaxed transition-all duration-200 rounded-r-md"
                      style={{
                        borderColor: isActive ? color : color + "66",
                        background: isActive ? color + "18" : isBuffering ? color + "0f" : "transparent",
                      }}
                    >
                      <p className="text-[10px] font-semibold uppercase tracking-wider mb-1 flex items-center gap-1" style={{ color }}>
                        {isBuffering && <span className="w-2.5 h-2.5 border-2 border-t-transparent rounded-full animate-spin shrink-0" style={{ borderColor: color, borderTopColor: "transparent" }} />}
                        {label}
                      </p>
                      <p className="text-sm" style={{ color: isActive ? "#fff" : "hsl(var(--foreground))" }}>{text}</p>
                    </div>
                  );
                }}
              />
            </div>
          )}

          {error && (
            <p className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">{error}</p>
          )}

          {!journal && !generating && !error && (
            <p className="text-xs text-muted-foreground">
              Click <strong>Generate</strong> to create an AI-enhanced journal entry from this session's data{transcript ? " and your notes" : ""}. Uses GPT-4o.
            </p>
          )}
        </>
      )}
    </div>
  );
}