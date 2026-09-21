import { episodeSignature } from '../lib/episodeAnalysis.js';
import { episodeClock } from '../lib/episodeReviewContext.js';

export default function EpisodeAnalysisReview({episode, review, onAnalyze, disabled, onSeek}) {
  if (episode.end_s == null) return null;
  const result = review?.result || review?.checkpoint, job = review?.job;
  const partial = !review?.result && Boolean(review?.checkpoint);
  const active = ['queued','running'].includes(job?.status);
  const stale = result && result.signature !== episodeSignature(episode);
  return <div className="mt-3 rounded-xl border border-primary/15 bg-background/30 p-3 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <b className="text-primary">Sarah’s episode review</b>
      <button type="button" disabled={disabled || active} onClick={()=>onAnalyze(episode.id)} className="rounded border border-primary/30 px-3 py-1.5 text-primary disabled:opacity-40">{active ? 'Analyzing…' : result ? 'Re-analyze' : 'Analyze episode'}</button>
    </div>
    {active && <div role="status" className="mt-2"><p>{job.progress?.message || 'Queued for video analysis'}</p>
      <progress className="mt-1 h-1.5 w-full" value={job.progress?.total ? job.progress.current : undefined} max={job.progress?.total || 1}/></div>}
    {(review?.queue_error || ['error','cancelled'].includes(job?.status)) && <p role="alert" className="mt-2 text-amber-300">{review.queue_error || job.error || 'Review cancelled. Re-analyze to retry.'}</p>}
    {!result && !active && <p className="mt-2 text-muted-foreground">No saved analysis yet. New completed episodes are analyzed automatically; use Fill missing analyses for older entries.</p>}
    {stale && <p className="mt-2 text-amber-300">Showing the previous review. The episode boundaries or source have changed.</p>}
    {partial && <p className="mt-2 text-primary">{result.segments.length} of {result.total_segments} visual segments saved. {result.visual_complete ? 'The full visual checklist is available; the episode summary is pending.' : 'Completed observations are available below while the review continues.'}</p>}
    {result?.comparison_error && <p className="mt-2 text-amber-300">{result.comparison_error}</p>}
    {result && <>
      <p className="mt-2 leading-relaxed">{result.synthesis.overview}</p>
      <div className="mt-2 flex flex-wrap gap-3 text-muted-foreground"><span>Approach evidence: <b className="text-foreground">{result.evidence.peak?.score ?? '—'}/100</b>{result.evidence.peak && <button className="ml-1 text-primary" onClick={()=>onSeek(result.evidence.peak.time_s)}>at {episodeClock(result.evidence.peak.time_s)} ↗</button>}</span><span>Median {result.evidence.median_score ?? '—'}/100</span><span>Usable HRV: {result.evidence.usable_hrv_samples} samples</span></div>
      <p className="mt-1 text-[10px] text-muted-foreground">Evidence estimate · not calibrated climax probability</p>
      <details className="mt-3"><summary className="cursor-pointer text-primary">Physiology, progression & recovery</summary>
        {[['Approach evidence',result.synthesis.approach_assessment],['Progression',result.synthesis.progression],['Release / recovery',result.synthesis.recovery]].map(([title,text])=><div key={title} className="mt-2"><b>{title}</b><p className="mt-1 whitespace-pre-wrap leading-relaxed">{text}</p></div>)}
      </details>
      <details className="mt-3" open><summary className="cursor-pointer text-primary">Head-to-toe visual checklist · {result.source.role === 'feet' ? 'Feet / lower body only' : 'Main'} · {result.segments.length} segments</summary>
        {result.segments.map(segment=><details key={segment.start_s} className="mt-2 rounded border border-border p-2"><summary className="cursor-pointer">{episodeClock(segment.start_s)}–{episodeClock(segment.end_s)} · {segment.summary}</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">{segment.metrics.map(item=><div key={item.metric} className="min-w-0 rounded bg-muted/30 p-2">
            <div className="flex flex-wrap justify-between gap-1"><b>{item.metric}</b><span className="text-[10px] text-muted-foreground">{item.visibility.replaceAll('_',' ')} · {item.confidence}</span></div>
            <p className="mt-1 leading-relaxed">{item.observation}</p><p className="mt-1 text-muted-foreground">{item.progression}</p>
            <p className="mt-1 text-[10px] text-muted-foreground">{[item.laterality,item.magnitude].filter(Boolean).join(' · ')}</p>
            <button onClick={()=>onSeek(item.time_s)} className="mt-1 text-primary">{episodeClock(item.time_s)} ↗</button>
          </div>)}</div>
        </details>)}
      </details>
      <details className="mt-3"><summary className="cursor-pointer text-primary">Compared with earlier episodes ({result.synthesis.comparisons.length})</summary>
        {result.synthesis.comparisons.map((item,i)=><p key={i} className="mt-2 leading-relaxed">{item.observation}</p>)}
        {!result.synthesis.comparisons.length && <p className="mt-2 text-muted-foreground">{result.comparison_status === 'not_applicable' ? 'First logged episode: this is the baseline for subsequent comparisons.' : result.comparison_status === 'pending' ? 'Comparing earlier episodes…' : 'No earlier episode comparison was available.'}</p>}
      </details>
      {result.synthesis.limitations && <p className="mt-3 text-[11px] text-muted-foreground">{result.synthesis.limitations}</p>}
    </>}
  </div>;
}
