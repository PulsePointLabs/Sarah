import { useEffect, useRef, useState } from "react";
import { Headphones, Loader2, Play, RotateCcw, Save, Square } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Slider } from "@/components/ui/slider";
import {
  DEFAULT_TTS_SETTINGS,
  getTTSMime,
  getTTSRuntime,
  loadTTSSettings,
  normalizeTTSSettings,
  prepareTTSInput,
  saveTTSSettings,
  TTS_AUDIO_FORMATS,
  TTS_ENGINES,
  TTS_PRESETS,
} from "./TTSButton";

const TTS_SAMPLE_TEXT = "Your build phase begins quietly, with stimulation becoming more focused while your body starts to organize around arousal. As climax approaches, the shift is meaningful: sensation, muscle tone, and heart rate begin telling the same story, then recovery arrives as stimulation stops and the body settles.";

const CONTROL_ROWS = [
  ["speed", "Speed", 0.94, 1.04, 0.01],
  ["warmth", "Warmth", 0, 10, 1],
  ["enthusiasm", "Enthusiasm", 0, 10, 1],
  ["soothing", "Soothing", 0, 10, 1],
  ["lightness", "Lightness", 0, 10, 1],
  ["femininity", "Femininity", 0, 10, 1],
  ["continuity", "Section Flow", 0, 10, 1],
  ["naturalness", "Naturalness", 0, 10, 1],
  ["pauses", "Pauses", 0, 10, 1],
  ["softStart", "Soft Start", 0, 10, 1],
];

function ttsErrorMessage(error) {
  const raw = error?.data?.error || error?.data?.message || error?.message || "TTS sample failed";
  if (typeof raw !== "string") return JSON.stringify(raw);
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || parsed?.message || raw;
  } catch {
    return raw;
  }
}

async function requestSample(payload) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await base44.functions.invoke("openaiTTS", payload);
      if (response?.data?.error || !response?.data?.audio) {
        const error = new Error(ttsErrorMessage(response));
        error.status = response?.status || response?.data?.status || 502;
        error.data = response?.data;
        throw error;
      }
      return response;
    } catch (error) {
      lastError = error;
      const status = error?.status || error?.response?.status || error?.data?.status || 500;
      if (![408, 429, 500, 502, 503, 504].includes(status) || attempt === 3) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(1500 * 2 ** attempt, 12000)));
    }
  }
  throw lastError;
}

function binaryAudio(audio) {
  const binary = atob(audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export default function TTSSettingsPanel() {
  const [savedSettings, setSavedSettings] = useState(() => loadTTSSettings());
  const [draftSettings, setDraftSettings] = useState(() => loadTTSSettings());
  const [sampleState, setSampleState] = useState("idle");
  const [message, setMessage] = useState(null);
  const sampleAudioRef = useRef(null);

  const stopSample = () => {
    const sample = sampleAudioRef.current;
    if (sample) {
      sample.audio.pause();
      sample.audio.src = "";
      URL.revokeObjectURL(sample.url);
      sampleAudioRef.current = null;
    }
    setSampleState("idle");
  };

  useEffect(() => {
    const sync = (event) => {
      const next = normalizeTTSSettings(event?.detail || loadTTSSettings());
      setSavedSettings(next);
      setDraftSettings(next);
    };
    window.addEventListener("pulsepoint:tts-settings", sync);
    return () => {
      stopSample();
      window.removeEventListener("pulsepoint:tts-settings", sync);
    };
  }, []);

  const updateDraft = (patch) => {
    setDraftSettings((previous) => normalizeTTSSettings({ ...previous, ...patch }));
  };

  const playSample = async () => {
    stopSample();
    setMessage(null);
    setSampleState("loading");
    try {
      const runtime = getTTSRuntime(draftSettings);
      const response = await requestSample({
        text: prepareTTSInput(TTS_SAMPLE_TEXT),
        voice: "nova",
        model: runtime.model,
        speed: runtime.speed,
        instructions: runtime.supportsInstructions ? runtime.instructions : "",
        format: runtime.format,
      });
      const bytes = binaryAudio(response.data.audio);
      const url = URL.createObjectURL(new Blob([bytes.buffer], { type: getTTSMime(response.data?.format || runtime.format) }));
      const audio = new Audio(url);
      audio.onended = stopSample;
      audio.onerror = stopSample;
      sampleAudioRef.current = { audio, url };
      setSampleState("playing");
      await audio.play();
    } catch (error) {
      setSampleState("idle");
      setMessage({ type: "error", text: ttsErrorMessage(error) });
    }
  };

  const save = () => {
    const next = saveTTSSettings(draftSettings);
    setSavedSettings(next);
    setDraftSettings(next);
    setMessage({ type: "ok", text: "TTS settings saved for all Sarah narration." });
  };

  const reset = () => {
    stopSample();
    setDraftSettings(normalizeTTSSettings(DEFAULT_TTS_SETTINGS));
    setMessage({ type: "note", text: "Default settings loaded into the controls. Save when they sound right." });
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-primary">
            <Headphones className="h-4 w-4" />
            <h2 className="text-sm font-bold uppercase tracking-wider">TTS Settings</h2>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            One Nova tuning surface for reads, samples, and premium downloads across Sarah. Expressive mode also follows saved Sarah Personality instructions for inflection and tone.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <span className="rounded-full bg-primary/10 px-2 py-1 font-semibold text-primary">Nova</span>
          <span className="rounded-full bg-muted px-2 py-1 text-muted-foreground">{TTS_ENGINES[draftSettings.engine]?.label}</span>
          <span className="rounded-full bg-muted px-2 py-1 text-muted-foreground">{TTS_AUDIO_FORMATS[draftSettings.audioFormat]?.label}</span>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Audio Engine</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(TTS_ENGINES).map(([key, engine]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => updateDraft({ engine: key })}
                    className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${draftSettings.engine === key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}
                  >
                    {engine.label}
                  </button>
                ))}
              </div>
              {draftSettings.engine === "hd" && <p className="mt-2 text-xs text-muted-foreground">HD Crisp prioritizes fidelity; tone controls and Sarah Personality instructions have less influence.</p>}
            </div>

            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Audio Format</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(TTS_AUDIO_FORMATS).map(([key, format]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => updateDraft({ audioFormat: key })}
                    className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${draftSettings.audioFormat === key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}
                  >
                    {format.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => updateDraft({ normalizeExport: !draftSettings.normalizeExport })}
            className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${draftSettings.normalizeExport ? "border-primary/35 bg-primary/10 text-primary" : "border-border bg-muted/20 text-muted-foreground hover:text-foreground"}`}
          >
            Gentle final loudness normalization: {draftSettings.normalizeExport ? "On" : "Off"}
            <span className="mt-0.5 block text-xs opacity-80">Applies once during premium server download rendering only.</span>
          </button>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Presets</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(TTS_PRESETS).map(([name, preset]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setDraftSettings(normalizeTTSSettings(preset))}
                  className="rounded-lg bg-muted px-2.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-muted/20 p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Voice Calibration</p>
          <div className="mt-3 space-y-3">
            {CONTROL_ROWS.map(([key, label, min, max, step]) => (
              <label key={key} className="grid grid-cols-[84px_1fr_42px] items-center gap-2 text-xs">
                <span className="font-medium text-muted-foreground">{label}</span>
                <Slider
                  value={[draftSettings[key]]}
                  min={min}
                  max={max}
                  step={step}
                  onValueChange={([value]) => updateDraft({ [key]: value })}
                />
                <span className="text-right font-mono text-muted-foreground">{draftSettings[key]}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={sampleState === "playing" ? stopSample : playSample}
          disabled={sampleState === "loading"}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-sm font-semibold text-primary transition-colors hover:bg-primary/20 disabled:opacity-60"
        >
          {sampleState === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : sampleState === "playing" ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {sampleState === "loading" ? "Preparing Sample" : sampleState === "playing" ? "Stop Sample" : "Play Sample"}
        </button>
        <button type="button" onClick={save} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
          <Save className="h-4 w-4" />
          Save
        </button>
        <button type="button" onClick={reset} className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground">
          <RotateCcw className="h-4 w-4" />
          Reset Draft
        </button>
        <span className="text-xs text-muted-foreground">Saved engine: {TTS_ENGINES[savedSettings.engine]?.label}, {TTS_AUDIO_FORMATS[savedSettings.audioFormat]?.label}, speed {savedSettings.speed}.</span>
      </div>

      {message && (
        <p className={`mt-3 rounded-lg px-3 py-2 text-sm ${message.type === "error" ? "bg-destructive/10 text-destructive" : message.type === "ok" ? "bg-emerald-500/10 text-emerald-300" : "bg-muted text-muted-foreground"}`}>
          {message.text}
        </p>
      )}
    </section>
  );
}
