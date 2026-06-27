import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, ClipboardList, Loader2, RefreshCw } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import AIChat from "@/components/AIChat";
import { loadLatestProfilerAnalysis, mergeProfilerResultsIntoProfile } from "@/lib/profileContext";
import { richTextToPlainText } from "@/lib/richText";
import {
  backfillImageReviewFindingsFromChat,
  buildProfileQaFindingCards,
  buildRecentProfileQaFindings,
  makeProfileQaEntry,
  normalizeProfileQaFindings,
  parseProfileQaFindingsFromText,
  toSecondPersonFinding,
} from "@/lib/profileQa";

function formatMechanicalProfile(profile) {
  return Object.entries(profile || {})
    .filter(([, value]) => Array.isArray(value) ? value.length : typeof value === "object" ? value?.value != null : value)
    .map(([key, value]) => {
      if (typeof value === "object" && !Array.isArray(value)) return `${key}: ${value.value} ${value.unit || ""}`.trim();
      if (Array.isArray(value)) return `${key}: ${value.join(", ")}`;
      return `${key}: ${richTextToPlainText(value)}`;
    })
    .join("; ");
}

function buildProfileContext(profile, findingCards) {
  return [
    `First name: ${profile.first_name?.trim() || "not set"}`,
    `Age: ${profile.age ?? "not set"}, Weight: ${profile.weight_kg ?? "not set"}kg, Fitness: ${profile.fitness_level ?? "not set"}`,
    `Resting HR: ${profile.resting_hr ?? "not set"} bpm, Max HR: ${profile.max_hr ?? "not set"} bpm, Recovery HR drop 60s: ${profile.recovery_hr_60s ?? "not set"} bpm`,
    `Physical & anatomical context: ${richTextToPlainText(profile.medications) || "none"}`,
    `Arousal response style: ${profile.arousal_response_style ?? "not set"}`,
    `Typical build duration: ${profile.typical_build_duration ?? "not set"}`,
    `Climax sensitivity: ${profile.climax_sensitivity ?? "not set"}`,
    `Refractory pattern: ${profile.refractory_pattern ?? "not set"}`,
    `Preferred stimulation: ${(profile.preferred_stimulation || []).join(", ") || "not set"}`,
    `Arousal notes: ${richTextToPlainText(profile.arousal_notes) || "none"}`,
    `User-verified interview findings (Profile Q&A): ${findingCards.slice(0, 24).map((entry) => `[${entry.date}] ${entry.finding}`).join("\n") || "none"}`,
    `Functional mechanical profile: ${formatMechanicalProfile(profile.anatomical_mechanical_profile) || "not set"}`,
  ].join("\n");
}

const PROFILE_QA_LOAD_STEPS = [
  "Connecting to Sarah desktop API",
  "Loading profile and saved Q&A",
  "Checking latest Profiler results",
  "Preparing Sarah chat context",
];

export default function ProfileQA() {
  const [profile, setProfile] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [qaFindingsOpen, setQaFindingsOpen] = useState(true);
  const [loadState, setLoadState] = useState({
    step: 0,
    message: PROFILE_QA_LOAD_STEPS[0],
    error: "",
  });
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadProfileQaWorkspace() {
      setLoadState({ step: 0, message: PROFILE_QA_LOAD_STEPS[0], error: "" });
      setProfile(null);
      try {
        setLoadState({ step: 1, message: PROFILE_QA_LOAD_STEPS[1], error: "" });
        const profileResponse = await base44.auth.me();
        if (cancelled) return;
        if (!profileResponse) throw new Error("Sarah returned an empty profile response.");

        setLoadState({ step: 2, message: PROFILE_QA_LOAD_STEPS[2], error: "" });
        const latestProfilerAnalysis = await loadLatestProfilerAnalysis();
        if (cancelled) return;

        setLoadState({ step: 3, message: PROFILE_QA_LOAD_STEPS[3], error: "" });
        const u = mergeProfilerResultsIntoProfile(profileResponse, latestProfilerAnalysis) || profileResponse;
        const savedQaFindings = normalizeProfileQaFindings(u.profile_qa_findings);
        const importedQaFindings = savedQaFindings.length ? savedQaFindings : parseProfileQaFindingsFromText(u.arousal_notes);
        const savedChatMessages = Array.isArray(u.profile_chat_messages) ? u.profile_chat_messages : [];
        const imageReviewBackfills = backfillImageReviewFindingsFromChat(savedChatMessages, importedQaFindings, u.first_name);
        const qaFindingsWithBackfills = imageReviewBackfills.length
          ? normalizeProfileQaFindings([...imageReviewBackfills, ...importedQaFindings])
          : importedQaFindings;
        const hydratedProfile = {
          ...u,
          profile_qa_findings: qaFindingsWithBackfills,
        };

        setProfile(hydratedProfile);
        setChatMessages(savedChatMessages);
        setLoadState({ step: PROFILE_QA_LOAD_STEPS.length, message: "Chat with Sarah is ready", error: "" });
        if (!savedQaFindings.length && importedQaFindings.length && !imageReviewBackfills.length) {
          base44.auth.updateMe({ profile_qa_findings: importedQaFindings }).catch(() => {});
        }
        if (imageReviewBackfills.length) {
          base44.auth.updateMe({ profile_qa_findings: qaFindingsWithBackfills }).catch(() => {});
        }
      } catch (error) {
        if (cancelled) return;
        setLoadState({
          step: 0,
          message: "Profile Q&A could not finish loading.",
          error: error?.message || "Unknown loading error.",
        });
      }
    }

    loadProfileQaWorkspace();
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  if (!profile) {
    const pct = loadState.error
      ? 100
      : Math.max(12, Math.min(92, Math.round(((loadState.step + 1) / PROFILE_QA_LOAD_STEPS.length) * 100)));
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-xl items-center justify-center px-4 py-10">
        <div className="w-full rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <div className={`mt-0.5 rounded-full border p-2 ${loadState.error ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-primary/30 bg-primary/10 text-primary"}`}>
              {loadState.error ? <AlertCircle className="h-5 w-5" /> : <Loader2 className="h-5 w-5 animate-spin" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Chat with Sarah</p>
              <h1 className="mt-1 text-lg font-semibold">{loadState.error ? "Could not load Sarah chat" : loadState.message}</h1>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {loadState.error
                  ? loadState.error
                  : "Sarah is loading your saved profile, Q&A findings, chat thread, and latest profiler context."}
              </p>
            </div>
          </div>
          {!loadState.error && (
            <>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-3 space-y-1.5">
                {PROFILE_QA_LOAD_STEPS.map((step, index) => (
                  <div key={step} className={`flex items-center gap-2 text-xs ${index <= loadState.step ? "text-foreground" : "text-muted-foreground"}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${index < loadState.step ? "bg-primary" : index === loadState.step ? "bg-primary/70" : "bg-muted-foreground/30"}`} />
                    <span>{step}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {loadState.error && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="button" onClick={() => setLoadAttempt((value) => value + 1)} className="gap-2">
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
              <Button asChild type="button" variant="outline">
                <Link to="/profile">Back to Profile</Link>
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const profileQaFindings = normalizeProfileQaFindings(profile.profile_qa_findings);
  const profileQaFindingCards = buildProfileQaFindingCards(profileQaFindings, profile.first_name);
  const recentProfileQaFindings = buildRecentProfileQaFindings(profileQaFindings, profile.first_name, 3);
  const latestQaFinding = profileQaFindings[0] || null;

  const saveProfileQaFinding = async (findingsText, meta = {}) => {
    const entry = makeProfileQaEntry(findingsText, meta);
    if (!entry.findings.length) return;
    entry.findings = entry.findings.map((finding) => toSecondPersonFinding(finding, profile.first_name));
    const merged = normalizeProfileQaFindings([entry, ...(profile.profile_qa_findings || [])]);
    setProfile((current) => ({ ...current, profile_qa_findings: merged }));
    await base44.auth.updateMe({ profile_qa_findings: merged });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-3 py-3 pb-24 sm:px-6 sm:py-5 lg:px-8">
      <AIChat
        mode="profile"
        userProfile={profile}
        scopeId={profile.id || "profile"}
        context={buildProfileContext(profile, profileQaFindingCards)}
        savedMessages={chatMessages}
        savedNotes={profile.arousal_notes}
        latestSavedFinding={latestQaFinding}
        recentSavedFindings={recentProfileQaFindings}
        defaultOpen
        onSaveMessages={async (msgs) => {
          setChatMessages(msgs);
          await base44.auth.updateMe({ profile_chat_messages: msgs });
        }}
        onSaveNotes={async (findingsText, meta) => {
          await saveProfileQaFinding(findingsText, meta);
        }}
      />

      <div className="rounded-xl border border-border bg-card">
        <button
          type="button"
          onClick={() => setQaFindingsOpen((open) => !open)}
          className="flex w-full items-start justify-between gap-4 p-4 text-left"
          aria-expanded={qaFindingsOpen}
        >
          <div>
            <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
              <ClipboardList className="h-3.5 w-3.5" /> Saved Chat Findings
            </h2>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              Each finding is deduped, timestamped, and kept separate from the freeform arousal notes.
            </p>
          </div>
          <span className="rounded-full border border-border bg-muted/40 px-2 py-1 text-[10px] font-semibold text-muted-foreground">
            {profileQaFindingCards.length}
          </span>
        </button>
        {qaFindingsOpen && (
          <div className="max-h-[36rem] space-y-3 overflow-y-auto border-t border-border p-4">
            {profileQaFindingCards.length ? (
              <div className="grid gap-2 md:grid-cols-2">
                {profileQaFindingCards.map((entry) => (
                  <article key={entry.id} className="rounded-lg border border-border bg-muted/20 p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">{entry.timestamp}</p>
                      <div className="flex items-center gap-1.5">
                        {entry.duplicateCount > 0 && (
                          <span className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                            {entry.duplicateCount + 1} merged
                          </span>
                        )}
                        {entry.needs_review && (
                          <span className="rounded-full border border-chart-3/40 bg-chart-3/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-chart-3">
                            review
                          </span>
                        )}
                        {entry.image_count > 0 && (
                          <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary">
                            {entry.image_count} img
                          </span>
                        )}
                        <span className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                          {entry.sourceLabel}
                        </span>
                      </div>
                    </div>
                    <p className="text-sm leading-relaxed text-muted-foreground">{entry.finding}</p>
                  </article>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No profile Q&A findings saved yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
