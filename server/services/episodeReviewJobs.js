import { getEntity, upsertEntity, listEntitiesByExactCriteria } from '../db.js';
import { createJob, getJob, listJobs, cancelJob } from './jobQueue.js';
import { completedEpisode, episodeSignature } from '../../src/lib/episodeAnalysis.js';

export const episodeReviewId = (entity, id, episodeId) => `${entity}:${id}:${episodeId}`;
export function episodeReviews(entity, id) {
  return listEntitiesByExactCriteria('EpisodeVisualReview', { record_id: id, record_entity: entity }).map(review => ({
    ...review, job: review.job_id ? getJob(review.job_id) : null,
  }));
}
export function queueEpisodeReview(entity, id, episodeId, { force = false } = {}) {
  if (!['Session','BodyExploration'].includes(entity)) throw new Error('Unsupported episode record.');
  const record = getEntity(entity, id);
  const episode = record?.subjective_near_climax_episodes?.find(e=>e.id === episodeId);
  if (!episode || !completedEpisode(episode)) throw new Error('Mark the end of the episode before analyzing it.');
  const reviewId = episodeReviewId(entity, id, episodeId), signature = episodeSignature(episode);
  const previous = getEntity('EpisodeVisualReview', reviewId);
  const active = listJobs({ type: 'episode_visual_review', limit: 1000, meta: { reviewId } }).find(j=>['queued','running'].includes(j.status) && j.meta?.signature === signature);
  if (active) return active;
  const incompleteComparison = ['error','incomplete','pending'].includes(previous?.result?.comparison_status);
  if (!force && previous?.result?.signature === signature && !incompleteComparison) return null;
  for (const job of listJobs({ type: 'episode_visual_review', meta: {reviewId} })) {
    if (['queued','running'].includes(job.status)) cancelJob(job.id);
  }
  const resume = previous?.checkpoint?.signature === signature && (previous?.result?.signature !== signature || incompleteComparison);
  const job = createJob('episode_visual_review', { entity, recordId: id, episodeId, signature, resume }, {
    sessionId: id, reviewId, signature, title: `${episode.kind === 'climax' ? 'Climax' : 'Near climax'} episode review`,
    source: 'episode_visual_review', route: '/video', quietInTray: true, notifications: false,
  });
  upsertEntity('EpisodeVisualReview', reviewId, { record_id: id, record_entity: entity, episode_id: episodeId, job_id: job.id, requested_signature: signature, queue_error: null });
  return job;
}
export function queueChangedEpisodes(entity, previous, current) {
  if (!['Session','BodyExploration'].includes(entity)) return;
  for (const old of previous.subjective_near_climax_episodes || []) {
    const next = current.subjective_near_climax_episodes?.find(e=>e.id===old.id);
    if (!next || !completedEpisode(next)) {
      for (const job of listJobs({type:'episode_visual_review',meta:{reviewId:episodeReviewId(entity,current.id,old.id)}})) {
        if (['queued','running'].includes(job.status)) cancelJob(job.id);
      }
    }
  }
  for (const episode of current.subjective_near_climax_episodes || []) {
    const old = previous.subjective_near_climax_episodes?.find(e=>e.id === episode.id);
    if (completedEpisode(episode) && (!old || episodeSignature(old) !== episodeSignature(episode))) {
      try { queueEpisodeReview(entity, current.id, episode.id); }
      catch (error) { upsertEntity('EpisodeVisualReview', episodeReviewId(entity,current.id,episode.id), {
        record_id: current.id, record_entity: entity, episode_id: episode.id, queue_error: error.message,
      }); }
    }
  }
}
