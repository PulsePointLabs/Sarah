import { getEntity, upsertEntity, listEntitiesByExactCriteria } from '../db.js';
import { withManualEvidenceWorkspace, probeAnnotationVideo, extractNativeAnnotationFrames, denseFeetEvidence, mainDetailCrops } from './manualAnnotationEvidence.js';
import { completedEpisode, episodeSignature, episodeSegments, episodeRole, mainMetrics, feetMetrics, episodeEvidence, validateEpisodeSegment } from '../../src/lib/episodeAnalysis.js';
import { episodeReviewId } from './episodeReviewJobs.js';

const metricSchema = metrics => ({ type: 'object', properties: {
  summary: { type: 'string' }, metrics: { type: 'array', minItems: metrics.length, maxItems: metrics.length, items: {
    type: 'object', properties: {
      metric: { type: 'string', enum: metrics }, observation: { type: 'string' },
      visibility: { type: 'string', enum: ['clear','partial','not_visible','uncertain'] },
      confidence: { type: 'string', enum: ['low','moderate','high'] }, time_s: { type: 'number' },
      laterality: { type: 'string' }, magnitude: { type: 'string' }, progression: { type: 'string' },
    }, required: ['metric','observation','visibility','confidence','time_s','laterality','magnitude','progression'],
  } },
}, required: ['summary','metrics'] });

export function createEpisodeReviewHandler(invoke, dependencies = {}) {
  const dbGet = dependencies.getEntity || getEntity;
  const dbPut = dependencies.upsertEntity || upsertEntity;
  const dbList = dependencies.listEntitiesByExactCriteria || listEntitiesByExactCriteria;
  const workspace = dependencies.workspace || withManualEvidenceWorkspace;
  const probe = dependencies.probe || probeAnnotationVideo;
  const extract = dependencies.extract || extractNativeAnnotationFrames;
  const details = dependencies.details || mainDetailCrops;
  const dense = dependencies.dense || denseFeetEvidence;
  return async ({ entity, recordId, episodeId, signature, resume = false }, context) => {
    const record = dbGet(entity, recordId);
    const episode = record?.subjective_near_climax_episodes?.find(e=>e.id === episodeId);
    if (!episode || !completedEpisode(episode) || episodeSignature(episode) !== signature) throw new Error('Episode changed or was removed. Review its current boundaries.');
    const role = episodeRole(episode), feet = role === 'feet', metrics = feet ? feetMetrics : mainMetrics;
    const original = episode.source || {};
    const links = record.linked_local_videos || [];
    const link = links.find(v=>v.path === original.localPath || (original.fingerprint && v.fingerprint === original.fingerprint));
    const sameCamera = links.filter(v=>episodeRole({source:{key:v.cameraRole}}) === role);
    const video = link || (sameCamera.length === 1 ? sameCamera[0] : null);
    const sourcePath = video?.path || original.localPath;
    if (!sourcePath) throw new Error('Link the original video for this episode’s camera in Video Sync, then re-analyze.');
    const offset = Number(video?.timelineOffsetSeconds ?? original.timelineOffsetSeconds) || 0;
    const source = await probe(sourcePath, context.signal);
    if (!Number.isFinite(source.duration_s) || source.duration_s <= 0) throw new Error('Original video duration could not be read. Relink the source video and re-analyze.');
    const availableStart = offset, availableEnd = offset + source.duration_s - 1/source.fps;
    if (episode.start_s < availableStart || episode.end_s > availableEnd) throw new Error('The linked video does not cover the whole episode. Check its location and synchronization offset, then re-analyze.');
    const start = Math.max(availableStart, episode.start_s - 5), end = Math.min(availableEnd, episode.end_s + 5);
    const id = episodeReviewId(entity,recordId,episodeId);
    const assertCurrent = () => {
      context.signal?.throwIfAborted();
      const latest = dbGet(entity,recordId)?.subjective_near_climax_episodes?.find(e=>e.id === episodeId);
      if (!latest || episodeSignature(latest)!==signature) throw new Error('Episode changed during review. Old analysis was not attached to the new boundaries.');
      if (dbGet('EpisodeVisualReview',id)?.job_id !== context.jobId) throw new Error('A newer review superseded this job.');
    };
    const rows = dbList('HeartRateTimeline',{session:recordId}) || [];
    const evidence = episodeEvidence(episode,rows);
    const windows = episodeSegments(start, end), segments = [];
    const prior = dbGet('EpisodeVisualReview',id)?.checkpoint;
    const cached = resume && prior?.signature === signature && prior.source?.path === sourcePath && prior.source?.offset === offset ? prior.segments : [];
    const report = () => ({signature,episode_id:episodeId,created_at:new Date().toISOString(),source:{path:sourcePath,role,offset,...source},
      window:{start_s:episode.start_s,end_s:episode.end_s},reviewed_window:{start_s:start,end_s:end},segments:[...segments],evidence,
      visual_complete:segments.length===windows.length,total_segments:windows.length,
      synthesis:{overview:'Head-to-toe observations saved below. Episode summary pending.',approach_assessment:'',progression:'',recovery:'',limitations:'',comparisons:[]}});
    for (const [index, window] of windows.entries()) {
      context.signal?.throwIfAborted();
      const saved = cached?.find(s=>s.start_s===window.start_s && s.end_s===window.end_s);
      if (saved) { validateEpisodeSegment(saved,metrics,window.start_s,window.end_s); segments.push(saved); continue; }
      context.updateProgress({ phase: 'visual_review', current: index, total: windows.length + 1, message: `Reviewing segment ${index+1} of ${windows.length} · ${feet ? 'Feet / lower body' : 'Main head to toe'}` });
      // A separate workspace per chunk bounds both disk and memory for long episodes.
      segments.push(await workspace(async directory => {
        const a = window.start_s-offset, b = window.end_s-offset, mark = (a+b)/2;
        let frames, crops, motion;
        if (feet) {
          ({ frames, crops, motion } = await dense({ sourcePath, start:a, end:b, mark, offset, directory, signal:context.signal, invoke, source }));
        } else {
          const times = [...new Set([...Array.from({length: Math.ceil(b-a)},(_,i)=>a+i), b])];
          frames = await extract({sourcePath, timesSeconds:times, directory, signal:context.signal});
          crops = await details(frames,directory,source,context.signal,mark);
        }
        const images = [...frames,...crops];
        const temporal = motion ? {...motion, frame_metrics: motion.frame_metrics?.map(m=>({time_s:m.time_s,camera_compensated:m.camera_compensated,motion_p95_px:m.motion_p95_px,strongest_cells:[...m.tiles].sort((a,b)=>b.p90_px-a.p90_px).slice(0,3)}))} : null;
        const result = await invoke({ model:'claude_sonnet_4_6', max_tokens:7000, max_images:images.length,
          signal:context.signal, response_json_schema:metricSchema(metrics),
          images:images.map(f=>({filename:f.filename, media_type:f.mimeType, data:f.data})),
          prompt:`Independently review this ordered segment of Ben's private physiological session. Address him as you/your. This is observational analysis, not erotic narration.
The current visual evidence is your only basis. No previous Sarah prose or physiological scores are provided. Do not judge, validate, rebut or grade subjective episode labels. Do not infer sensations, climax, internal physiology, causation or unseen anatomy.
${feet ? 'FEET / LOWER BODY lane ONLY. Exclude genitals, penis, glans, scrotum, erection, stimulation, devices, grip and stroke cadence. Keep full lower-body context; distinguish toe extension from splay and anatomical left/right only when resolvable.' : 'MAIN lane: review head to toe wherever in view, including visible genital state and stimulation mechanics using neutral anatomical language. Do not infer pressure or contact hidden from this view.'}
Return exactly one entry for EACH checklist metric. Report visible baseline and progression in the segment, including subtle asymmetry, onset, persistence, direction changes and local release. When obscured or outside the frame use not_visible; do not guess or silently omit it. Low confidence candidates remain explicitly uncertain. Reduced movement does not itself prove relaxation; describe local changes without a canned warning. Do not argue with the user or narrate frame numbers.
Summary must describe chronological early -> middle -> late changes. Each metric's progression describes change over this interval, or a supported unchanged visible state. Do not confuse a lack of observed change with proof of stability between samples. Keep telemetry overlays out of visual observations. Cameras are not mirrored, but assign laterality only if the orientation establishes it.
Segment SESSION seconds: ${window.start_s} to ${window.end_s}; time_s must be within this interval. Prose uses minute:second timestamps.
Ordered image timestamps (session seconds): ${JSON.stringify(images.map(f=>({time_s:f.frameTimeSeconds+offset, context:f.context})))}
${temporal ? `Temporal CV evidence at up to 8 FPS; tracking labels are hypotheses, motion is not physiological diagnosis: ${JSON.stringify(temporal)}` : 'Full native-resolution frames approximately 1 second apart, with native detail supplements. Sub-second motion cannot be established from these samples alone.'}`,
        });
        return { ...validateEpisodeSegment(result, metrics, window.start_s, window.end_s),
          evidence: { frame_times_s: frames.map(f=>f.frameTimeSeconds+offset), native_full_frame:true, detail_crops:crops.length,
            temporal_cv: Boolean(motion), temporal_sample_times_s:motion?.frame_times_s || [] } };
      }));
      assertCurrent();
      dbPut('EpisodeVisualReview',id,{checkpoint:report()});
    }
    context.signal?.throwIfAborted();
    context.updateProgress({phase:'synthesis',current:windows.length,total:windows.length+1,message:'Comparing episode progression and saved physiology…'});
    const earlier = (record.subjective_near_climax_episodes || []).filter(e=>completedEpisode(e) && e.end_s < episode.start_s).sort((a,b)=>a.start_s-b.start_s).map(e=>{
      const review = dbGet('EpisodeVisualReview',episodeReviewId(entity,recordId,e.id))?.result;
      return {id:e.id,kind:e.kind,start_s:e.start_s,end_s:e.end_s,source_camera:episodeRole(e),
        evidence: {...episodeEvidence(e,rows),points:undefined},
        visual_review:review?.signature === episodeSignature(e) ? review.synthesis : null};
    });
    const savedResult = dbGet('EpisodeVisualReview',id)?.result;
    const synthesis = resume && cached?.length === windows.length && savedResult?.signature === signature ? savedResult.synthesis : await invoke({model:'claude_sonnet_4_6',max_tokens:6500,signal:context.signal,
      response_json_schema:{type:'object',properties:{overview:{type:'string'}, approach_assessment:{type:'string'},
        progression:{type:'string'},recovery:{type:'string'},limitations:{type:'string'},
      },required:['overview','approach_assessment','progression','recovery','limitations']},
      prompt:`Write Ben's standalone episode review using the independently analyzed current segment results below. Do not compare to other episodes; comparison is a separate later step. Neutral physiological reporting, address you/your. Respect the subjective ${episode.kind} marker without grading or disputing it. Describe early, middle, late and post-episode progression. Separate visible findings from telemetry and user labels. ${feet ? 'Feet/lower body ONLY: no genital state or stimulation mechanics.' : ''}
Approach scores are heuristic evidence estimates, NOT calibrated climax probabilities. Explain score trajectory, peak timing, contributing factors, HR/HRV support and missing data; never invent a percentage chance of climax, a validated threshold, or claim telemetry proves climax. Do not infer a score when unavailable. Do not infer relaxation merely from reduced motion. Report candidate findings as uncertain. This report covers ONLY the current episode; no earlier-episode information is supplied. Avoid repeating every checklist item in this overview. All prose times and durations must use minutes/seconds, never hundreds of seconds.
Current marked window: ${episode.start_s}–${episode.end_s} SESSION seconds. Reviewed with up to 5 seconds either side.
Current visual segments: ${JSON.stringify(segments)}
Current physiological evidence: ${JSON.stringify(evidence)}`,
    });
    if (!synthesis || ['overview','approach_assessment','progression','recovery','limitations'].some(k=>typeof synthesis[k] !== 'string')) throw new Error('Episode summary was incomplete. The visual checklist is saved; retry to finish.');
    assertCurrent();
    const result = {...report(),synthesis:{...synthesis,comparisons:[]},comparison_status:earlier.length?'pending':'not_applicable',compared_episode_ids:[]};
    // The standalone report is durable BEFORE any optional historical comparison.
    dbPut('EpisodeVisualReview',id,{result,queue_error:null});
    if (earlier.length) {
      context.updateProgress({phase:'comparison',current:windows.length,total:windows.length+1,message:'Head-to-toe report saved. Comparing earlier episodes…'});
      try {
        const compared = await invoke({model:'claude_sonnet_4_6',max_tokens:4000,signal:context.signal,
          response_json_schema:{type:'object',properties:{comparisons:{type:'array',items:{type:'object',properties:{episode_id:{type:'string',enum:earlier.map(e=>e.id)},observation:{type:'string'}},required:['episode_id','observation']}}},required:['comparisons']},
          prompt:`Compare this independently completed physiological episode report with the provided earlier episodes only. Address Ben as you/your, use minute:second times. Preserve the current observations; never grade subjective markers or invent climax probabilities. Keep uncertain findings uncertain and identify differing camera coverage or missing prior visual reviews. ${feet?'Feet/lower-body findings only; exclude genital state and stimulation mechanics.':''} Return only comparisons with the EXACT episode_id from earlier episodes. If no useful comparison is possible, return an empty comparisons array.\nCurrent report: ${JSON.stringify(result)}\nEarlier episodes: ${JSON.stringify(earlier)}`});
        if (!Array.isArray(compared?.comparisons)) throw new Error('Comparison response was incomplete.');
        const valid = compared.comparisons.filter(c=>earlier.some(e=>e.id===c.episode_id) && typeof c.observation==='string' && c.observation.trim());
        result.synthesis.comparisons = valid;
        result.compared_episode_ids = [...new Set(valid.map(c=>c.episode_id))];
        result.comparison_status = valid.length===compared.comparisons.length?'complete':'incomplete';
        if(result.comparison_status==='incomplete')result.comparison_error='An unlinked comparison was omitted. Your complete head-to-toe report is saved.';
      } catch(error) {
        result.comparison_status='error';result.comparison_error=`Comparison could not finish: ${error.message}. Your head-to-toe report is saved.`;
        assertCurrent();dbPut('EpisodeVisualReview',id,{result});
        throw error;
      }
      assertCurrent();dbPut('EpisodeVisualReview',id,{result});
    }
    context.updateProgress({phase:'complete',current:windows.length+1,total:windows.length+1,message:'Episode review saved'});
    return {reviewId:id,episodeId};
  };
}
