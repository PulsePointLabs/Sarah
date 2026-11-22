import { videoRecordDuration } from './videoRecordOrder.js';

export function videoRecordSummary(record, type = 'session') {
  const count = value => Array.isArray(value) ? value.length : 0;
  const media=[...(record.linked_local_videos||[]),...(Array.isArray(record.media_videos)?record.media_videos:[]),record.video_file,record.video_url,record.video_link,record.capture_video_filename].filter(Boolean);
  const videos=new Set(media.map((video,index)=>typeof video==='string'?video:video.path||video.url||video.file_url||video.id||`video-${index}`)).size;
  const events = record.review_event_count!=null?Number(record.review_event_count):count(record.event_timeline);
  const episodes = record.review_episode_count!=null?Number(record.review_episode_count):count(record.subjective_near_climax_episodes);
  const automatic = /^(Live capture session created automatically|Body exploration capture created from Live Capture)/i;
  const notes = typeof record.notes === 'string' && !automatic.test(record.notes.trim()) ? record.notes.trim() : '';
  return {
    title: record.title || record.exploration_type || (type === 'body_exploration' ? 'Body exploration' : 'Sexual session'),
    duration: videoRecordDuration(record) || 'Duration not recorded',
    events, episodes, videos,
    preview: notes.length > 140 ? `${notes.slice(0,137)}…` : notes,
    search: [record.title,record.exploration_type,record.date,record.start_time,...(Array.isArray(record.tags)?record.tags:[])].filter(Boolean).join(' ').toLowerCase(),
  };
}
