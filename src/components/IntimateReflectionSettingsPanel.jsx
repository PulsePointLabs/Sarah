import { useEffect, useState } from "react";
import { Heart, RotateCcw, Save } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { INTIMATE_REFLECTION_LEVELS } from "@/lib/intimateReflection";
import {
  DEFAULT_INTIMATE_REFLECTION_SETTINGS,
  loadSyncedIntimateReflectionSettings,
  readIntimateReflectionSettings,
  saveSyncedIntimateReflectionSettings,
} from "@/lib/intimateReflectionSettings";

export default function IntimateReflectionSettingsPanel() {
  const [settings, setSettings] = useState(readIntimateReflectionSettings);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let active = true;
    loadSyncedIntimateReflectionSettings().then((saved) => {
      if (!active) return;
      setSettings(saved);
      setDirty(false);
    });
    return () => {
      active = false;
    };
  }, []);

  const update = (patch) => {
    setSettings((current) => ({
      ...current,
      ...patch,
      ...(Object.prototype.hasOwnProperty.call(patch, "customInstructions")
        ? { customInstructions: String(patch.customInstructions || "").slice(0, 1200) }
        : {}),
    }));
    setDirty(true);
    setStatus("");
  };

  const save = async () => {
    setSaving(true);
    setStatus("");
    try {
      const saved = await saveSyncedIntimateReflectionSettings(settings);
      setSettings(saved);
      setDirty(false);
      setStatus("Saved and synchronized for EXE, browser, and APK.");
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setSettings({ ...DEFAULT_INTIMATE_REFLECTION_SETTINGS });
    setDirty(true);
    setStatus("Defaults restored. Press Save to keep them.");
  };

  return (
    <section id="intimate-reflection-settings" className="scroll-mt-24 rounded-xl border border-rose-300/30 bg-gradient-to-br from-rose-500/[0.06] via-card to-amber-400/[0.04] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-rose-500">
            <Heart className="h-4 w-4" />
            <h2 className="text-sm font-bold uppercase tracking-wider">Intimate Reflection</h2>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Set Sarah&apos;s default trusted-lover voice once. New and regenerated reflections retell the supported session from beginning to end with this voice across the EXE, browser, and APK.
          </p>
        </div>
        <span className="rounded-full border border-rose-300/30 bg-background/70 px-3 py-1 text-xs font-semibold text-rose-500">
          Private global default
        </span>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {INTIMATE_REFLECTION_LEVELS.map((level) => (
          <button
            key={level.id}
            type="button"
            onClick={() => update({ level: level.id })}
            className={`rounded-xl border p-3 text-left transition-colors ${settings.level === level.id ? "border-rose-400/60 bg-rose-500/10" : "border-border bg-background/60 hover:border-rose-300/40"}`}
          >
            <span className="block text-sm font-semibold text-foreground">{level.label}</span>
            <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{level.helper}</span>
          </button>
        ))}
      </div>

      {settings.level === "custom" && (
        <label className="mt-4 block rounded-xl border border-rose-300/20 bg-background/70 p-3">
          <span className="text-sm font-bold text-foreground">Private custom instruction</span>
          <Textarea
            value={settings.customInstructions}
            onChange={(event) => update({ customInstructions: event.target.value })}
            maxLength={1200}
            placeholder="Describe Sarah's observer voice, preferred vocabulary, boundaries, emphasis, and phrases to avoid..."
            className="mt-3 min-h-44 resize-y bg-card text-sm"
          />
          <span className="mt-1 block text-right text-[10px] text-muted-foreground">{settings.customInstructions.length}/1200</span>
        </label>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty || (settings.level === "custom" && !settings.customInstructions.trim())}
          className="inline-flex items-center gap-2 rounded-lg bg-rose-500 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-600 disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {saving ? "Saving..." : "Save Reflection Settings"}
        </button>
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground"
        >
          <RotateCcw className="h-4 w-4" /> Reset
        </button>
        <span className={`text-xs ${dirty ? "text-amber-700" : status ? "text-emerald-700" : "text-muted-foreground"}`}>
          {dirty ? "Unsaved changes" : status || "Saved settings are used for future reflection generation."}
        </span>
      </div>
    </section>
  );
}
