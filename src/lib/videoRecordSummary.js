import { videoRecordDuration } from './videoRecordOrder.js';
import {recordFlag} from './sessionRecordFlags.js';

const positive=value=>value!=null&&value!==''&&Number.isFinite(Number(value))&&Number(value)>0?Number(value):null;
export function recordedEquipment(record) {
  const names=[...(Array.isArray(record.methods)?record.methods:[]),...(Array.isArray(record.devices)?record.devices:[])].map(value=>typeof value==='string'?value:value?.name||value?.label||'').map(value=>value.trim());
  return [...new Set(names.filter(value=>value&&!/^(manual|other|none|no device)$/i.test(value)&&!/(?:\bobs\b|\bchrome\b|\bserver\b|\bdesktop\b|recording|heart.?rate.?onstream|pulsoid)/i.test(value)))];
}
export function sessionOutcome(record,type='session') {
  if(type==='body_exploration')return {label:'Body exploration',tone:'neutral'};
  const marked=Array.isArray(record.subjective_near_climax_episodes)?record.subjective_near_climax_episodes:[];
  const climax=(record.climax_offset_s!=null&&String(record.climax_offset_s).trim()!==''&&Number.isFinite(Number(record.climax_offset_s))&&Number(record.climax_offset_s)>=0)||positive(record.climax_duration)!=null||marked.some(e=>e.kind==='climax'&&Number(e.end_s)>Number(e.start_s));
  const near=marked.some(e=>e.kind==='near_climax'&&Number(e.end_s)>Number(e.start_s));
  if(climax&&recordFlag(record.no_climax))return {label:'Outcome needs review',tone:'neutral'};
  if(climax)return {label:'Climax logged',tone:'climax'};
  if(near)return {label:'Near-climax marked',tone:'near'};
  if(recordFlag(record.no_climax))return {label:'No climax logged',tone:'near'};
  return {label:'Outcome not logged',tone:'neutral'};
}

export function recordedDevices(record,evidence={}) {
  const devices=[];
  if(evidence.hr||positive(record.avg_hr)||positive(record.max_hr))devices.push(/h10/i.test(`${record.hr_source||''} ${record.hr_source_label||''}`)?'Polar H10':'HR sensor');
  if(evidence.civet)devices.push('CIVET');
  if(evidence.emg||record.live_capture_import?.emg_attached===true||record.capture_digest?.emg_attached===true)devices.push('EMG');
  if(evidence.bp)devices.push('BP cuff');
  if(evidence.howl)devices.push('Howl');
  return [...new Set([...devices,...recordedEquipment(record)])];
}

export function videoRecordSummary(record, type = 'session') {
  const count = value => Array.isArray(value) ? value.length : 0;
  const media=[...(record.linked_local_videos||[]),...(Array.isArray(record.media_videos)?record.media_videos:[]),record.video_file,record.video_url,record.video_link,record.capture_video_filename].filter(Boolean);
  const videos=new Set(media.map((video,index)=>typeof video==='string'?video:video.path||video.url||video.file_url||video.id||`video-${index}`)).size;
  const events = Array.isArray(record.event_timeline)?count(record.event_timeline):Number(record.review_snapshot?.event_count??record.review_event_count??0);
  const episodes = Array.isArray(record.subjective_near_climax_episodes)?count(record.subjective_near_climax_episodes):Number(record.review_snapshot?.episode_count??record.review_episode_count??0);
  const automatic = /^(Live capture session created automatically|Body exploration capture created from Live Capture)/i;
  const notes = typeof record.notes === 'string' && !automatic.test(record.notes.trim()) ? record.notes.trim() : '';
  const snapshot=record.review_snapshot;
  const hr=snapshot?.heart_rate||{min:positive(record.min_hr),avg:positive(record.avg_hr),max:positive(record.max_hr)};
  return {
    title: record.title || record.exploration_type || (type === 'body_exploration' ? 'Body exploration' : 'Sexual session'),
    duration: videoRecordDuration(record) || 'Duration not recorded',
    events, episodes, videos,
    devices:[...new Set([...(snapshot?.devices||recordedDevices(record)),...recordedEquipment(record)])],
    heartRate:hr,
    pressure:snapshot?.pelvic_pressure||null,
    outcome:snapshot?.outcome||sessionOutcome(record,type),
    preview: notes.length > 140 ? `${notes.slice(0,137)}…` : notes,
    search: [record.title,record.exploration_type,record.date,record.start_time,...(Array.isArray(record.tags)?record.tags:[])].filter(Boolean).join(' ').toLowerCase(),
  };
}
