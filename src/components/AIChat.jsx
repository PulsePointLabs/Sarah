import { useState, useRef, useEffect } from "react";
import { MessageCircle, Send, ChevronDown, ChevronUp, Sparkles, Save, RefreshCw, Mic, MicOff, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";

const PROFILE_CATEGORIES = [
  { key: "physical", label: "Physical Baseline", emoji: "🫀", hint: "Body metrics, fitness, resting HR, medications" },
  { key: "arousal", label: "Arousal Profile", emoji: "📈", hint: "Build style, speed to climax, plateau patterns" },
  { key: "stimulation", label: "Stimulation Methods", emoji: "⚡", hint: "What works best, technique nuances, edging habits" },
  { key: "anatomical", label: "Anatomical Sensitivity", emoji: "🧬", hint: "Nerve sensitivity, pelvic floor, pressure responses" },
  { key: "climax", label: "Climax & Recovery", emoji: "🎯", hint: "Climax intensity, duration, refractory period" },
  { key: "contextual", label: "Contextual Factors", emoji: "🌡️", hint: "Mood, hydration, substances, time of day effects" },
];

const SESSION_CATEGORIES = [
  { key: "sensations", label: "Sensations", emoji: "✋", hint: "What you felt physically during this session" },
  { key: "stimulation", label: "Stimulation Details", emoji: "⚡", hint: "Settings, technique, pauses, adjustments made" },
  { key: "buildup", label: "Build & Edging", emoji: "📈", hint: "How arousal escalated, near-misses, control" },
  { key: "climax", label: "Climax Experience", emoji: "🎯", hint: "Intensity, duration, contractions, ejaculate" },
  { key: "discomfort", label: "Discomfort / Issues", emoji: "⚠️", hint: "Pain, pressure, anything unusual or unexpected" },
  { key: "recovery", label: "Recovery & Aftermath", emoji: "🔄", hint: "Post-climax feelings, refractory, residual sensations" },
];

export default function AIChat({
  mode = "session",
  context,
  userProfile,
  savedMessages,
  savedNotes,
  onSaveMessages,
  onSaveNotes,
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState(savedMessages || []);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingFindings, setSavingFindings] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [speakingIdx, setSpeakingIdx] = useState(null);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioRef = useRef(null);

  const categories = mode === "profile" ? PROFILE_CATEGORIES : SESSION_CATEGORIES;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const speakText = async (text, idx) => {
    if (!ttsEnabled) return;
    setSpeakingIdx(idx);
    const res = await base44.functions.invoke("openaiTTS", { text, voice: "nova", speed: 1.0 });
    const audio = res.data?.audio;
    if (!audio) { setSpeakingIdx(null); return; }
    const src = `data:audio/mpeg;base64,${audio}`;
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    const el = new Audio(src);
    audioRef.current = el;
    el.onended = () => setSpeakingIdx(null);
    el.onerror = () => setSpeakingIdx(null);
    el.play();
  };

  const stopSpeaking = () => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setSpeakingIdx(null);
  };

  const WHISPER_PROMPT =
    "Session log note. Gentle strokes on the glans penis. Foreskin partially retracted. " +
    "Stimulation paused. Perineum pressure applied. Pelvic floor contraction. " +
    "E-stim via TENS unit. Foley catheter in place. Urethral stimulation. " +
    "Edging — arousal near climax. Frenulum contact. Prostate stimulation. " +
    "Ejaculation. Refractory period. Buildup plateau. Involuntary spasm. Discomfort noted.";

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
      const ab = await blob.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const base64 = btoa(bin);
      const res = await base44.functions.invoke("whisperSTT", { audio_base64: base64, mime_type: mimeType, prompt: WHISPER_PROMPT });
      const text = res.data?.text?.trim() || "";
      if (text) setInput((prev) => (prev ? prev + " " + text : text));
      setTranscribing(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    };
    mr.start();
    setRecording(true);
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };



  const handleOpen = () => {
    setOpen(true);
    // Restore persisted messages but don't auto-generate — let user pick a category
  };

  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    const userMsg = { role: "user", text: input.trim() };
    const updated = [...messages, userMsg];
    setMessages(updated);
    onSaveMessages?.(updated);
    setInput("");
    setLoading(true);

    const history = updated.map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.text}`).join("\n");

    const shouldPivot = messages.length > 4 && Math.random() < 0.4;

    // Build a profile context block if userProfile is available
    const profileBlock = userProfile ? `
PERSON'S PHYSIOLOGICAL & AROUSAL PROFILE (use this to personalize every question — never assume anatomy or biology not stated here):
- Physical/Anatomical context: ${userProfile.medications || "not specified"}
- Age: ${userProfile.age ?? "not set"}, Fitness: ${userProfile.fitness_level ?? "not set"}
- Resting HR: ${userProfile.resting_hr ?? "not set"} bpm, Max HR: ${userProfile.max_hr ?? "not set"} bpm
- Arousal response style: ${userProfile.arousal_response_style ?? "not set"}
- Typical build duration: ${userProfile.typical_build_duration ?? "not set"}
- Climax sensitivity: ${userProfile.climax_sensitivity ?? "not set"}
- Refractory pattern: ${userProfile.refractory_pattern ?? "not set"}
- Preferred stimulation: ${(userProfile.preferred_stimulation || []).join(", ") || "not set"}
- Arousal notes: ${userProfile.arousal_notes || "none"}
` : "";

    const ANATOMY_RULE = `ANATOMY RULE: Use ONLY the anatomical and physiological details stated in the profile above. Never assume or infer biological sex, genitalia, or anatomy not explicitly mentioned. If anatomy is ambiguous, use neutral language (e.g. "genital stimulation", "pelvic region", "that area").`;

    const SESSION_SCOPE_RULE = `SCOPE RULE: Stay anchored to THIS specific session's data only. Never compare to or reference other sessions.`;

    const QUESTION_QUALITY_RULE = `QUESTION QUALITY — THIS IS THE MOST IMPORTANT RULE:
Questions should be rooted in the session's AROUSAL and STIMULATION experience, not heart rate numbers or timestamps. Good anchors to use:
  - A stimulation method or combination used: "you combined the foley with e-stim — how did the sensation feel different when both were active?"
  - A logged event note (paraphrase, don't just quote): "you noted switching technique partway through — what prompted that and did it change the feel?"
  - A subjective metric gap: "intensity was an 8 but satisfaction only a 5 — what felt like it was missing?"
  - An outcome or experience quality: "the build was rated high but climax duration was short — what did that arc feel like from the inside?"
  - A notable logged experience: "you noted discomfort at one point — did that affect how present you felt during the rest of the session?"
  - A broad session pattern: "the buildup went long this time — were you edging intentionally or did it just feel harder to tip over?"
  - Something they haven't mentioned yet: "what was the most physically intense moment for you, and what was driving it?"

TONE: Casual, warm, curious — like a knowledgeable friend who actually read the session notes, not a clinician reviewing a chart. Short sentences. Use "you" freely. Contractions are fine.

BANNED QUESTION TYPES — never ask these:
- Questions pinned to exact timestamps or minute markers ("at 14:22", "around the 9-minute mark")
- Questions that cite raw HR numbers as the main anchor ("your HR hit 112 — how did that feel?")
- Generic enjoyment questions with no session grounding ("what did you enjoy most?")
- Time-perception questions ("did it feel longer or shorter than usual?")
- Abstract cause-and-effect speculation with no data anchor
- Yes/no questions — always invite a narrative answer

If nothing specific stands out, ask what surprised them most or what they'd most want to remember from this session.`;

    const systemPrompt = messages.length === 1
      ? mode === "profile"
        ? `You're having a genuine, immersive conversation with someone about their physiology and arousal — like a knowledgeable friend who has studied their data closely. They've just shared something. Respond naturally, ask ONE follow-up question that goes deeper. Curious, specific, engaged. 2–3 sentences. No bullets, no clinical jargon. ${ANATOMY_RULE}`
        : `You're a curious, knowledgeable friend helping someone unpack a specific session. They just shared something. React briefly and naturally, then ask ONE question grounded in a real detail from this session — a stimulation method used, a logged event or note, a subjective metric gap, or something about the arc of their arousal. Sound like you actually read the session, not like you're scanning a graph. Keep it casual and conversational.

${SESSION_SCOPE_RULE}
${QUESTION_QUALITY_RULE}
${ANATOMY_RULE}
2–3 sentences total. No affirmations, no "great!", no formal phrasing.`
      : shouldPivot
        ? mode === "profile"
          ? `You're having a warm conversation about someone's physiology. They just responded. Pivot to a DIFFERENT aspect of their profile not yet covered. ONE curious, specific question. No affirmations. 2–3 sentences. ${ANATOMY_RULE}`
          : `You're digging into THIS session with someone. They just responded. Switch to a fresh angle — pick something not yet discussed (a different stimulation method, a metric gap, a logged event, something about how the session ended or how they felt afterward) and ask ONE casual, pointed question. Sound like you spotted something worth exploring, not like you're following a checklist.

${SESSION_SCOPE_RULE}
${QUESTION_QUALITY_RULE}
${ANATOMY_RULE}
No affirmations. 2–3 sentences.`
        : mode === "profile"
          ? `Warm, immersive conversation about physiology. They just responded. Continue naturally — ONE follow-up that goes deeper on what they said. Curious, specific. No affirmations. 2–3 sentences. ${ANATOMY_RULE}`
          : `You're digging into THIS session with someone. They just answered. Pick up the thread and ask ONE casual follow-up that goes deeper — reference something specific from the session (a method, a sensation they mentioned, a logged event, a metric gap, or how things unfolded) and invite them to expand. Make it feel like a genuine back-and-forth, not a checklist.

${SESSION_SCOPE_RULE}
${QUESTION_QUALITY_RULE}
${ANATOMY_RULE}
No affirmations or pleasantries. 2–3 sentences.`;

    const res = await base44.integrations.Core.InvokeLLM({
      prompt: `${systemPrompt}${profileBlock ? `\n\n${profileBlock}` : ""}\n\nSession data:\n${context}\n\nConversation:\n${history}\n\nRespond now as the AI:`,
    });

    const reply = typeof res === "string" ? res.trim() : res?.response?.trim() ?? "";
    const aiMsg = { role: "assistant", text: reply };
    const finalMessages = [...updated, aiMsg];
    setMessages(finalMessages);
    onSaveMessages?.(finalMessages);
    setLoading(false);
    const newIdx = finalMessages.length - 1;
    if (ttsEnabled) speakText(reply, newIdx);
  };

  const saveFindings = async () => {
    setSavingFindings(true);
    const history = messages.map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.text}`).join("\n");
    const res = await base44.integrations.Core.InvokeLLM({
      prompt: `Based on this Q&A conversation about a person's ${mode === "profile" ? "physiological and arousal profile" : "session"}, write 2-4 concise bullet points summarizing only the NEW factual findings from the user's answers that would be useful to persist for future AI analysis. Do not repeat generic information already obvious from the base data. Be specific and factual.\n\nConversation:\n${history}\n\nOutput as plain bullet points starting with "•":`,
    });
    const findings = typeof res === "string" ? res.trim() : res?.response?.trim() ?? "";
    const timestamp = new Date().toISOString().slice(0, 10);
    const newNote = `\n\n[AI Interview — ${timestamp}]\n${findings}`;
    const merged = (savedNotes || "") + newNote;
    onSaveNotes?.(merged);
    setSavingFindings(false);
    setSavedFeedback(true);
    setTimeout(() => setSavedFeedback(false), 3000);
  };

  const hasUserReplied = messages.some((m) => m.role === "user");
  const hasMessages = messages.length > 0;

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-4 py-3 bg-muted/40 hover:bg-muted/60 transition-colors text-left"
        onClick={() => open ? setOpen(false) : handleOpen()}
      >
        <MessageCircle className="w-4 h-4 text-accent shrink-0" />
        <span className="text-xs font-semibold text-foreground flex-1">
          {mode === "profile" ? "Interview Me — Deepen My Profile" : "Ask the AI — Session Deep Dive"}
        </span>
        {hasMessages && (
          <span className="text-[10px] text-muted-foreground">{messages.length} msg{messages.length !== 1 ? "s" : ""}</span>
        )}
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); if (ttsEnabled) stopSpeaking(); setTtsEnabled((v) => !v); }}
            title={ttsEnabled ? "Read questions aloud (on)" : "Read questions aloud (off)"}
            className="p-1 rounded-md transition-colors hover:bg-black/10"
          >
            {ttsEnabled
              ? <Volume2 className="w-4 h-4 text-accent" />
              : <VolumeX className="w-4 h-4 text-muted-foreground" />}
          </button>
        )}
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {open && (
        <div className="p-3 space-y-3">
          <p className="text-[11px] text-muted-foreground">
            {mode === "profile"
              ? "Start a conversation about your physiology and arousal. Findings are saved to your arousal notes."
              : "Ask anything about this session or share observations. Findings are saved to session notes."}
          </p>

          {/* Message thread or input prompt */}
          {messages.length === 0 ? (
            <div className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), sendMessage())}
                placeholder={transcribing ? "Transcribing…" : recording ? "Recording… tap mic to stop" : `Tell the AI something about your ${mode === "profile" ? "physiology" : "session"}…`}
                disabled={loading || transcribing}
                rows={3}
                className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 resize-none"
              />
              <button
                onClick={recording ? stopRecording : startRecording}
                disabled={loading || transcribing}
                title={recording ? "Stop recording" : "Speak your message"}
                className={`flex items-center justify-center w-9 h-9 rounded-lg shrink-0 transition-all disabled:opacity-40 ${recording ? "bg-destructive text-destructive-foreground animate-pulse" : "bg-muted text-muted-foreground hover:text-foreground"}`}
              >
                {transcribing
                  ? <span className="w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  : recording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>
              <button
                onClick={sendMessage}
                disabled={!input.trim() || loading}
                className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary text-primary-foreground disabled:opacity-40 shrink-0 transition-opacity"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1 border-t border-border pt-2">
              {messages.map((msg, i) => (
                <div key={i} className={`flex gap-2 items-start ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
                  {msg.role === "assistant" && (
                    <Sparkles className="w-3.5 h-3.5 text-accent shrink-0 mt-1" />
                  )}
                  <div
                    className={`rounded-xl px-3 py-2 text-sm leading-relaxed max-w-[85%] ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground rounded-tr-sm"
                        : "bg-muted/70 text-foreground rounded-tl-sm cursor-pointer"
                    }`}
                    onClick={msg.role === "assistant" ? () => speakingIdx === i ? stopSpeaking() : speakText(msg.text, i) : undefined}
                    title={msg.role === "assistant" ? (speakingIdx === i ? "Tap to stop" : "Tap to hear") : undefined}
                  >
                    {msg.text}
                    {msg.role === "assistant" && speakingIdx === i && (
                      <span className="ml-2 inline-flex items-center gap-0.5">
                        <span className="w-1 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                        <span className="w-1 h-3 bg-accent rounded-full animate-bounce" style={{ animationDelay: "100ms" }} />
                        <span className="w-1 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: "200ms" }} />
                      </span>
                    )}
                  </div>
                </div>
              ))}

              {loading && (
                <div className="flex gap-2 items-start">
                  <Sparkles className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" />
                  <div className="bg-muted/70 rounded-xl rounded-tl-sm px-3 py-2 flex items-center gap-1.5">
                    <span className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              )}
              <div ref={bottomRef} />

              {/* Input — shown after messages start */}
              <div className="flex gap-2 items-end sticky bottom-0 bg-white dark:bg-slate-900 pt-2">
                <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), sendMessage())}
                    placeholder={transcribing ? "Transcribing…" : recording ? "Recording… tap mic to stop" : "Type or speak your response…"}
                    disabled={loading || transcribing}
                    rows={5}
                    className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 resize-none sm:rows-3"
                  />
                <button
                  onClick={recording ? stopRecording : startRecording}
                  disabled={loading || transcribing}
                  title={recording ? "Stop recording" : "Speak your response"}
                  className={`flex items-center justify-center w-9 h-9 rounded-lg shrink-0 transition-all disabled:opacity-40 ${recording ? "bg-destructive text-destructive-foreground animate-pulse" : "bg-muted text-muted-foreground hover:text-foreground"}`}
                >
                  {transcribing
                    ? <span className="w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    : recording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </button>
                <button
                  onClick={sendMessage}
                  disabled={!input.trim() || loading}
                  className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary text-primary-foreground disabled:opacity-40 shrink-0 transition-opacity"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
              </div>
              )}

          {/* Actions */}
          {hasUserReplied && (
            <div className="flex items-center gap-2 pt-2 border-t border-border flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={saveFindings}
                disabled={savingFindings}
                className="h-7 text-xs gap-1.5"
              >
                {savingFindings
                  ? <><span className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />Saving…</>
                  : savedFeedback
                  ? <><Save className="w-3 h-3 text-primary" />Saved!</>
                  : <><Save className="w-3 h-3" />Save Findings</>}
              </Button>
              <button
                onClick={() => { setMessages([]); onSaveMessages?.([]); }}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors ml-auto"
              >
                <RefreshCw className="w-3 h-3" /> Clear chat
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}