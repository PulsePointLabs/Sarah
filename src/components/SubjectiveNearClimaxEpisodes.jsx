import { useMemo } from "react";
import { totalEpisodeSeconds, subjectiveProximity } from "../lib/subjectiveNearClimax.js";
import { buildPhaseEvidence, phaseBandsFromPoints } from "../lib/videoSyncPhaseEvidence.js";
import { episodeClock as time, episodeDuration } from "../lib/episodeReviewContext.js";
import EpisodeReviewCard from "./EpisodeReviewCard";
import { useEpisodeReviews } from '../hooks/useEpisodeReviews';
import { completedEpisode, episodeSignature } from '../lib/episodeAnalysis.js';
export default function SubjectiveNearClimaxEpisodes({ episodes, timelineRows, onSeekTime, onSeek, onToggle, onDelete, error, saving, onRetry, recordId, isExploration }) {
  const analysis = useEpisodeReviews(recordId,isExploration);
  const missing = episodes.filter(e=>completedEpisode(e) && !analysis.reviews.some(r=>r.episode_id===e.id && r.result?.signature===episodeSignature(e))).length;
  const phaseModel = useMemo(() => buildPhaseEvidence(timelineRows), [timelineRows]);
  const highApproach = useMemo(() => phaseBandsFromPoints(phaseModel.points).filter((b) => b.phase === "approach"), [phaseModel]);
  return <section className="space-y-3" aria-label="Subjective near-climax episodes">
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="text-muted-foreground">Completed episodes automatically receive a camera-specific video and physiology review.</span><button type="button" disabled={saving || analysis.submitting || !missing} onClick={()=>analysis.run({fillMissing:true})} className="rounded border border-primary/30 px-3 py-2 text-primary disabled:opacity-40">Fill missing analyses ({missing})</button></div>
    {analysis.error && <p role="alert" className="text-xs text-amber-300">{analysis.error}</p>}
    <div className="flex flex-wrap items-center gap-2">{[["near_climax", "Near climax", "N"], ["climax", "Climax", "C"]].map(([kind, label, key]) =>
      <button key={kind} type="button" onClick={() => onToggle(kind)} className="rounded border border-violet-400/40 px-3 py-2 text-xs text-violet-400">
        {episodes.some((e) => e.end_s == null && (e.kind || "near_climax") === kind) ? "End" : "Start"} {label} ({key})</button>)}
      <span className="text-xs text-muted-foreground">Your subjective markers · {error ? "Not saved" : saving ? "Saving…" : "Saved"}</span></div>
    <div className="flex flex-wrap gap-4 rounded border border-border p-3 text-sm">
      <span>Marked near climax: <b>{episodeDuration(totalEpisodeSeconds(episodes, "near_climax"))}</b></span>
      <span>Marked climax: <b>{episodeDuration(totalEpisodeSeconds(episodes, "climax"))}</b></span>
      <span>High-approach candidates: <b>{highApproach.length}</b> · {episodeDuration(highApproach.reduce((sum, b) => sum + b.end - b.start, 0))} total</span>
    </div>
    <p className="text-xs text-muted-foreground">Marked totals include completed episodes, without counting overlaps twice. High-approach bands use the card's estimate; they are not confirmed threshold or climax.</p>
    <details className="text-xs"><summary className="cursor-pointer">High-approach / near-threshold candidate durations ({highApproach.length})</summary>
      <div className="mt-2 flex flex-wrap gap-2">{highApproach.map((b) => <button key={b.start} type="button" onClick={() => onSeekTime(b.start)} className="rounded border border-orange-400/30 p-2">
        {time(b.start)}–{time(b.end)} · {episodeDuration(b.end - b.start)}</button>)}</div></details>
    {error && <p role="alert" className="text-sm text-red-400">{error} <button type="button" onClick={onRetry} className="underline">Retry save</button></p>}
    {!episodes.length && <p className="text-sm text-muted-foreground">No subjective episodes yet. Press N at the start, then N again at the end.</p>}
    {episodes.map((saved) => <EpisodeReviewCard key={saved.id} episode={{ ...saved, proximity: subjectiveProximity(saved, episodes, saved.proximity) }} timelineRows={timelineRows} phaseModel={phaseModel} onSeek={onSeek} onDelete={onDelete}
      review={analysis.reviews.find(r=>r.episode_id===saved.id)} onAnalyze={episodeId=>analysis.run({episodeId})} analysisDisabled={saving || analysis.submitting}/>)}
  </section>;
}
