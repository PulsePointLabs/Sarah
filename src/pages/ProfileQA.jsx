import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ClipboardList, MessageCircle } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import AIChat from "@/components/AIChat";
import { loadUserProfileWithProfilerResults } from "@/lib/profileContext";
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

export default function ProfileQA() {
  const [profile, setProfile] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [qaFindingsOpen, setQaFindingsOpen] = useState(true);

  useEffect(() => {
    loadUserProfileWithProfilerResults().then((u) => {
      const savedQaFindings = normalizeProfileQaFindings(u.profile_qa_findings);
      const importedQaFindings = savedQaFindings.length ? savedQaFindings : parseProfileQaFindingsFromText(u.arousal_notes);
      const savedChatMessages = u.profile_chat_messages || [];
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
      if (!savedQaFindings.length && importedQaFindings.length && !imageReviewBackfills.length) {
        base44.auth.updateMe({ profile_qa_findings: importedQaFindings }).catch(() => {});
      }
      if (imageReviewBackfills.length) {
        base44.auth.updateMe({ profile_qa_findings: qaFindingsWithBackfills }).catch(() => {});
      }
    });
  }, []);

  if (!profile) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
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
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 pb-24 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-3xl">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-primary">Sarah interview workspace</p>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <MessageCircle className="h-6 w-6 text-primary" /> Profile Q&A with Sarah
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A dedicated place for the ongoing profile interview, image/video review, and saved Q&A findings.
          </p>
        </div>
        <Button asChild variant="outline" className="shrink-0 gap-2">
          <Link to="/profile">
            <ArrowLeft className="h-4 w-4" />
            Back to Profile
          </Link>
        </Button>
      </div>

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
              <ClipboardList className="h-3.5 w-3.5" /> Saved Profile Q&A Findings
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
