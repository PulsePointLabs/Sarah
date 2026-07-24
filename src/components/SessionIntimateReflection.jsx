import { useEffect, useMemo, useState } from "react";
import { Brain, ChevronDown, ChevronUp, Heart, Loader2, LockKeyhole, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import AIOutputReader from "./AIOutputReader";
import {
  INTIMATE_REFLECTION_LEVELS,
  buildIntimateReflectionEvidence,
  buildIntimateReflectionPrompt,
  intimateReflectionEvidenceFingerprint,
  intimateReflectionFingerprint,
  intimateReflectionNeedsRefresh,
  intimateReflectionReaderData,
  normalizeIntimateReflectionResult,
  normalizeIntimateReflectionSettings,
} from "@/lib/intimateReflection";
import { buildSarahPersonalityPrompt, readSarahPersonalitySettings } from "@/utils/sarahPersonality";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    reflection: { type: "array", items: { type: "string" } },
    moments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          time_seconds: { type: "number" },
          label: { type: "string" },
          reflection: { type: "string" },
          evidence: { type: "string" },
        },
        required: ["label", "reflection", "evidence"],
      },
    },
    closing: { type: "string" },
  },
  required: ["summary", "reflection", "moments", "closing"],
};

function formatTimestamp(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "";
  const rounded = Math.max(0, Math.round(value));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function generatedLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function SessionIntimateReflection({
  session,
  timelineRows = [],
  onSave,
}) {
  const storedResult = session?.ai_analysis?._intimate_reflection || null;
  const [expanded, setExpanded] = useState(false);
  const [enabled, setEnabled] = useState(Boolean(storedResult));
  const [result, setResult] = useState(storedResult);
  const [settings, setSettings] = useState(() => normalizeIntimateReflectionSettings(storedResult?.settings));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const next = session?.ai_analysis?._intimate_reflection || null;
    setResult(next);
    if (next) {
      setEnabled(true);
      setSettings(normalizeIntimateReflectionSettings(next.settings));
    }
  }, [session?.ai_analysis?._intimate_reflection]);

  const evidence = useMemo(
    () => buildIntimateReflectionEvidence(session, timelineRows),
    [session, timelineRows],
  );
  const readerData = useMemo(() => intimateReflectionReaderData(result), [result]);
  const stale = intimateReflectionNeedsRefresh(result, settings, evidence);
  const canGenerate = enabled
    && !loading
    && (settings.level !== "custom" || Boolean(settings.customInstructions.trim()));

  const updateSettings = (patch) => {
    setSettings((current) => ({
      ...current,
      ...patch,
      ...(Object.prototype.hasOwnProperty.call(patch, "customInstructions")
        ? { customInstructions: String(patch.customInstructions || "").slice(0, 1200) }
        : {}),
    }));
    setError("");
  };

  const generate = async () => {
    if (!canGenerate) return;
    setLoading(true);
    setError("");
    try {
      const personalityPrompt = buildSarahPersonalityPrompt(readSarahPersonalitySettings());
      const request = buildIntimateReflectionPrompt({
        session,
        timelineRows,
        settings,
        personalityPrompt,
      });
      const response = await base44.integrations.Core.InvokeLLM({
        model: "claude_sonnet_4_6",
        prompt: request.prompt,
        response_json_schema: RESPONSE_SCHEMA,
      });
      const normalized = normalizeIntimateReflectionResult(
        typeof response === "string" ? JSON.parse(response) : response,
      );
      const generatedAt = new Date().toISOString();
      const next = {
        ...normalized,
        settings: normalizeIntimateReflectionSettings(settings),
        _meta: {
          version: 1,
          generated_at: generatedAt,
          model: "claude_sonnet_4_6",
          settings_fingerprint: intimateReflectionFingerprint(settings),
          evidence_fingerprint: intimateReflectionEvidenceFingerprint(request.evidence),
          source_analysis_generated_at: session?.ai_analysis?._meta?.last_generated_at || null,
        },
      };
      setResult(next);
      setExpanded(true);
      await onSave?.(next);
    } catch (generationError) {
      setError(generationError?.data?.error || generationError?.message || "Sarah could not generate this reflection.");
    } finally {
      setLoading(false);
    }
  };

  const remove = async () => {
    if (!window.confirm("Delete this session's Intimate Reflection? Clinical analysis and annotations will not be changed.")) return;
    setLoading(true);
    setError("");
    try {
      await onSave?.(null);
      setResult(null);
      setEnabled(false);
      setExpanded(false);
    } catch (removeError) {
      setError(removeError?.message || "Could not delete the reflection.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section id="session-intimate-reflection" className="scroll-mt-24 overflow-hidden rounded-2xl border border-rose-300/30 bg-gradient-to-br from-rose-500/[0.07] via-card to-amber-400/[0.05]">
      <div className="flex items-start gap-3 p-4">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="mt-0.5 rounded-xl border border-rose-300/30 bg-rose-500/10 p-2 text-rose-500">
            <Heart className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-[0.16em] text-rose-500">Sarah&apos;s Intimate Reflection</span>
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                <LockKeyhole className="h-2.5 w-2.5" /> Private and opt-in
              </span>
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">
              A trusted-lover reflection grounded in this session&apos;s saved evidence, with adjustable sensuality and Sarah narration.
            </span>
          </span>
          {expanded ? <ChevronUp className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />}
        </button>
      </div>

      {expanded && (
        <div className="space-y-4 border-t border-rose-300/20 px-4 pb-4 pt-4">
          {!enabled && !result && (
            <div className="rounded-xl border border-border bg-background/70 p-4">
              <p className="text-sm font-medium text-foreground">This output is disabled by default for each session.</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Enabling it permits Sarah to create a private companion reflection. It does not change clinical analysis, annotations, or exports.
              </p>
              <Button type="button" className="mt-3 gap-2" onClick={() => setEnabled(true)}>
                <Sparkles className="h-4 w-4" /> Enable for this session
              </Button>
            </div>
          )}

          {enabled && (
            <>
              <div className="space-y-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-rose-500">Sensuality</p>
                  <p className="mt-1 text-xs text-muted-foreground">Controls this reflection only. Clinical and annotation output remains evidence-first and unchanged.</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {INTIMATE_REFLECTION_LEVELS.map((level) => (
                    <button
                      key={level.id}
                      type="button"
                      onClick={() => updateSettings({ level: level.id })}
                      className={`rounded-xl border p-3 text-left transition-colors ${settings.level === level.id ? "border-rose-400/60 bg-rose-500/10" : "border-border bg-background/60 hover:border-rose-300/40"}`}
                    >
                      <span className="block text-sm font-semibold text-foreground">{level.label}</span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{level.helper}</span>
                    </button>
                  ))}
                </div>
              </div>

              {settings.level === "custom" && (
                <label className="block space-y-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-rose-500">Private custom instruction</span>
                  <textarea
                    value={settings.customInstructions}
                    onChange={(event) => updateSettings({ customInstructions: event.target.value })}
                    rows={4}
                    maxLength={1200}
                    placeholder="Describe Sarah's tone, preferred vocabulary, boundaries, emphasis, and phrases to avoid..."
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-rose-400/60"
                  />
                  <span className="block text-right text-[10px] text-muted-foreground">{settings.customInstructions.length}/1200</span>
                </label>
              )}

              {stale && result && (
                <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-700">
                  The selected sensuality or session evidence has changed. Regenerate to update the reflection; the saved version remains available until then.
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" onClick={generate} disabled={!canGenerate} className="gap-2">
                  {loading
                    ? <><Loader2 className="h-4 w-4 animate-spin" />Sarah is writing...</>
                    : result
                      ? <><RefreshCw className="h-4 w-4" />Regenerate reflection</>
                      : <><Brain className="h-4 w-4" />Generate reflection</>}
                </Button>
                {result && (
                  <Button type="button" variant="outline" onClick={remove} disabled={loading} className="gap-2 text-destructive">
                    <Trash2 className="h-4 w-4" />Delete
                  </Button>
                )}
                {settings.level === "custom" && !settings.customInstructions.trim() && (
                  <span className="text-xs text-amber-700">Add a custom instruction before generating.</span>
                )}
              </div>

              {error && (
                <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
              )}

              {result && (
                <div className="space-y-4 rounded-xl border border-border bg-background/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
                    <span>{result?._meta?.generated_at ? `Generated ${generatedLabel(result._meta.generated_at)}` : "Saved reflection"}</span>
                    <span className="rounded-full border border-rose-300/30 bg-rose-500/10 px-2 py-0.5 font-semibold text-rose-500">
                      {INTIMATE_REFLECTION_LEVELS.find((level) => level.id === result?.settings?.level)?.label || "Intimate"}
                    </span>
                  </div>

                  {result.moments?.length > 0 && (
                    <details className="rounded-xl border border-border bg-muted/10 p-3">
                      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-rose-500">
                        Moments Sarah noticed ({result.moments.length})
                      </summary>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {result.moments.map((moment, index) => (
                          <div key={`${moment.time_seconds ?? "moment"}-${index}`} className="rounded-lg border border-border bg-background p-3">
                            <div className="flex items-center gap-2">
                              {Number.isFinite(Number(moment.time_seconds)) && (
                                <span className="font-mono text-xs font-bold text-rose-500">{formatTimestamp(moment.time_seconds)}</span>
                              )}
                              <span className="text-xs font-semibold text-foreground">{moment.label || "Intimate moment"}</span>
                            </div>
                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{moment.reflection}</p>
                            {moment.evidence && <p className="mt-2 text-[10px] text-muted-foreground/80">Grounded by: {moment.evidence}</p>}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  <AIOutputReader
                    sessionId={`${session.id}_intimate_reflection`}
                    title="Sarah's Intimate Reflection"
                    sessionDate={session.date}
                    sourceGeneratedAt={result?._meta?.generated_at}
                    paragraphs={readerData.paragraphs}
                    paragraphMeta={readerData.paragraphMeta}
                    summaryColor="hsl(var(--chart-4))"
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
