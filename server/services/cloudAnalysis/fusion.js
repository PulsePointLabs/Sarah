import crypto from 'node:crypto';

function finite(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function compactText(value, limit = 900) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  const candidate = text.slice(0, limit);
  const sentenceEnd = Math.max(candidate.lastIndexOf('. '), candidate.lastIndexOf('; '));
  const wordEnd = candidate.lastIndexOf(' ');
  const end = sentenceEnd >= Math.floor(limit * 0.58) ? sentenceEnd + 1 : wordEnd;
  return `${candidate.slice(0, Math.max(1, end)).trim()}…`;
}

function cleanDescriptionValue(value) {
  const values = Array.isArray(value) ? value : [value];
  const seen = new Set();
  return values
    .flatMap((entry) => String(entry ?? '').split(/\s*\n+\s*/))
    .map((entry) => entry.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/([,.;:])\1+/g, '$1').trim())
    .filter((entry) => entry && !/^(unknown|none|n\/a|null)$/i.test(entry))
    .filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function sentenceList(value) {
  return cleanDescriptionValue(value)
    .map((entry) => entry.replace(/[.]+$/, ''))
    .join('; ');
}

function secondPerson(value) {
  return String(value || '')
    .replace(/\bThe subject's\b/gi, 'Your')
    .replace(/\bthe subject's\b/gi, 'your')
    .replace(/\bThe subject is\b/gi, 'You are')
    .replace(/\bthe subject is\b/gi, 'you are')
    .replace(/\bThe subject\b/gi, 'You')
    .replace(/\bthe subject\b/gi, 'you')
    .replace(/\s+/g, ' ')
    .trim();
}

function naturalList(value) {
  return secondPerson(sentenceList(value));
}

const VISUAL_DESCRIPTION_FIELDS = [
  'subject_visibility',
  'body_position',
  'visible_body_regions',
  'actions',
  'devices',
  'interactions',
  'visible_physiological_cues',
  'camera_quality',
  'change_across_frames',
  'uncertainty',
];

function recoverCompletedDescriptionFields(raw = '') {
  const text = String(raw || '');
  const recovered = {};
  for (const field of VISUAL_DESCRIPTION_FIELDS) {
    const keyIndex = text.indexOf(`"${field}"`);
    if (keyIndex < 0) continue;
    const colon = text.indexOf(':', keyIndex + field.length + 2);
    if (colon < 0) continue;
    let start = colon + 1;
    while (/\s/.test(text[start] || '')) start += 1;
    if (text[start] !== '[') continue;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = !inString;
      else if (char === ']' && !inString) {
        end = index + 1;
        break;
      }
    }
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(text.slice(start, end));
      if (Array.isArray(parsed)) recovered[field] = parsed;
    } catch {
      // Only fully parseable fields are recovered; the original raw output is retained below.
    }
  }
  return recovered;
}

function descriptionText(description = {}) {
  if (!description || typeof description !== 'object') return compactText(description);
  if (description.raw_description) {
    const recovered = recoverCompletedDescriptionFields(description.raw_description);
    const readable = Object.keys(recovered).length ? descriptionText(recovered) : '';
    return `${readable ? `${readable} ` : ''}The model response ended before every requested field was complete; the full raw output remains preserved.`;
  }
  const position = naturalList(description.body_position);
  const actions = naturalList(description.actions);
  const change = naturalList(description.change_across_frames);
  const visible = naturalList(description.visible_body_regions);
  const devices = naturalList(description.devices);
  const interactions = naturalList(description.interactions);
  const cues = naturalList(description.visible_physiological_cues);
  const uncertainty = naturalList(description.uncertainty);
  return compactText([
    position ? `${/^you\b/i.test(position) ? position : `You appear ${position}`.replace(/[.]+$/, '')}.` : '',
    actions ? `Visible activity: ${actions.replace(/[.]+$/, '')}.` : '',
    change ? `Across these frames, ${change.replace(/[.]+$/, '')}.` : '',
    visible ? `Visible areas: ${visible.replace(/[.]+$/, '')}.` : '',
    devices ? `Visible equipment: ${devices.replace(/[.]+$/, '')}.` : '',
    interactions ? `Interaction: ${interactions.replace(/[.]+$/, '')}.` : '',
    cues ? `Visible physiological cues: ${cues.replace(/[.]+$/, '')}.` : '',
    uncertainty ? `Uncertainty: ${uncertainty.replace(/[.]+$/, '')}.` : '',
  ].filter(Boolean).join(' '), 900);
}

function structuredVisualEvidence(description = {}) {
  if (!description || typeof description !== 'object') return null;
  if (description.raw_description) {
    const recovered = recoverCompletedDescriptionFields(description.raw_description);
    return {
      ...Object.fromEntries(Object.entries(recovered).map(([field, value]) => [field, cleanDescriptionValue(value)])),
      parse_state: description.parse_state || 'unstructured',
      raw_model_output: String(description.raw_description),
    };
  }
  const result = {};
  for (const field of VISUAL_DESCRIPTION_FIELDS) {
    const values = cleanDescriptionValue(description[field]);
    if (values.length) result[field] = values;
  }
  return Object.keys(result).length ? result : null;
}

function overlaps(first, second) {
  const firstStart = finite(first.source_start_s ?? first.start_s);
  const firstEnd = finite(first.source_end_s ?? first.end_s, firstStart);
  const secondStart = finite(second.source_start_s ?? second.start_s);
  const secondEnd = finite(second.source_end_s ?? second.end_s, secondStart);
  return firstStart <= secondEnd && secondStart <= firstEnd;
}

function evidenceRange(item = {}) {
  const start = finite(item.source_start_s ?? item.start_s ?? item.representative_time_s);
  const end = Math.max(start, finite(item.source_end_s ?? item.end_s, start));
  return { start, end };
}

function rowTimeSeconds(row = {}) {
  return finite(row.time_offset_s ?? row.time_s ?? row.start_offset_s, Number.NaN);
}

function rowsInRange(rows = [], start, end) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const time = rowTimeSeconds(row);
    return Number.isFinite(time) && time >= start && time <= end;
  });
}

function numericSummary(rows = [], fields = []) {
  const values = rows.flatMap((row) => fields.map((field) => Number(row?.[field])))
    .filter(Number.isFinite);
  if (!values.length) return null;
  return {
    min: Math.round(Math.min(...values) * 10) / 10,
    max: Math.round(Math.max(...values) * 10) / 10,
    avg: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10,
    samples: values.length,
  };
}

function physiologyForRange(physiology = {}, start, end) {
  const heartRate = rowsInRange(physiology.heartRateRows, start, end);
  const emg = rowsInRange(physiology.emgRows, start, end);
  const howl = rowsInRange(physiology.howlCommands, start, end);
  const bloodPressure = rowsInRange(physiology.bloodPressureRows, start, end);
  const pulseOx = rowsInRange(physiology.pulseOxRows, start, end);
  return {
    heart_rate_bpm: numericSummary(heartRate, ['hr', 'heart_rate', 'bpm']),
    rmssd_ms: numericSummary(heartRate, ['rmssd_ms']),
    emg_level_pct: numericSummary(emg, ['level_pct', 'left_pct', 'right_pct']),
    blood_pressure: bloodPressure.map((row) => ({
      time_s: rowTimeSeconds(row),
      systolic_mm_hg: finite(row.systolic_mm_hg, null),
      diastolic_mm_hg: finite(row.diastolic_mm_hg, null),
      pulse_bpm: finite(row.pulse_bpm, null),
    })),
    pulse_ox: pulseOx.map((row) => ({
      time_s: rowTimeSeconds(row),
      spo2_percent: finite(row.spo2_percent, null),
      pulse_bpm: finite(row.pulse_bpm, null),
    })),
    howl_changes: howl.map((row) => ({
      time_s: rowTimeSeconds(row),
      action: row.action ?? null,
      channel: row.channel ?? null,
      intensity: row.intensity ?? null,
      frequency_hz: row.frequency_hz ?? null,
      mode: row.mode ?? null,
    })),
  };
}

export function fuseCloudMultimodalEvidence({ audioResult = {}, visualResult = {}, preflight = {}, physiology = {} } = {}) {
  if (!audioResult?.ok || !visualResult?.ok) throw new Error('Successful audio and visual cloud results are required for fusion.');
  const durationSeconds = Math.max(
    finite(audioResult.audio?.duration_seconds),
    finite(visualResult.video?.duration_seconds),
  );
  const semanticWindows = Array.isArray(visualResult.semantic_windows) ? visualResult.semantic_windows : [];
  const acousticEvents = (Array.isArray(audioResult.acoustic_events) ? audioResult.acoustic_events : [])
    .filter((event) => ['moderate', 'strong'].includes(String(event.confidence_band || '')));
  const reliableSpeech = (Array.isArray(audioResult.transcription?.segments) ? audioResult.transcription.segments : [])
    .filter((segment) => segment?.reliable);
  const poseSamples = Array.isArray(visualResult.pose_samples) ? visualResult.pose_samples : [];
  const frameMetrics = Array.isArray(visualResult.frame_metrics) ? visualResult.frame_metrics : [];

  const multimodalWindows = semanticWindows.map((window, index) => {
    const range = evidenceRange(window);
    const audio = acousticEvents.filter((event) => overlaps(window, event));
    const speech = reliableSpeech.filter((segment) => overlaps(window, segment));
    const reviewSummary = descriptionText(window.description) || 'Visual model returned no usable description for this window.';
    return {
      id: `cloud-window-${String(index + 1).padStart(3, '0')}`,
      start_ms: Math.round(range.start * 1000),
      end_ms: Math.round(range.end * 1000),
      representative_time_ms: Math.round(finite(window.representative_time_s, range.start) * 1000),
      label: 'cloud_visual_review_candidate',
      review_summary: reviewSummary,
      basis: reviewSummary,
      visual_evidence: structuredVisualEvidence(window.description),
      confidence: window.description?.parse_state === 'unstructured' ? 0.45 : 0.62,
      review_state: 'candidate',
      claim_state: 'inferred',
      audio_candidates: audio.map((event) => ({
        label: event.label,
        start_ms: Math.round(finite(event.start_s) * 1000),
        end_ms: Math.round(finite(event.end_s) * 1000),
        confidence: finite(event.confidence),
        confidence_band: event.confidence_band,
      })),
      reliable_speech: speech.map((segment) => ({
        start_ms: Math.round(finite(segment.start_s) * 1000),
        end_ms: Math.round(finite(segment.end_s) * 1000),
        text: String(segment.text || '').trim(),
      })),
      physiology: physiologyForRange(physiology, range.start, range.end),
      provenance: {
        modality: 'multimodal',
        source_asset_id: window.source_asset_id || visualResult.asset_id,
        model_name: window.model_name,
        model_version: window.model_version,
      },
    };
  });

  const audioCandidates = acousticEvents.map((event, index) => ({
    id: `cloud-audio-${String(index + 1).padStart(3, '0')}`,
    label: `audio_${String(event.label || 'activity').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    start_ms: Math.round(finite(event.start_s) * 1000),
    end_ms: Math.round(finite(event.end_s) * 1000),
    basis: `${event.label || 'Audio activity'} candidate from the cloud acoustic classifier; review before accepting.`,
    confidence: finite(event.confidence),
    confidence_band: event.confidence_band,
    review_state: 'candidate',
    claim_state: 'inferred',
    provenance: { modality: 'audio', model_name: event.model },
  }));

  const visiblePoseSamples = poseSamples.filter((sample) => sample?.tracking_state === 'visible').length;
  const lostPoseSamples = poseSamples.length - visiblePoseSamples;
  const availableStreams = preflight?.cloudJob?.evidence_streams
    ?.filter((stream) => stream?.available)
    .map((stream) => stream.name) || [];
  const jobRef = crypto.createHash('sha256')
    .update(`${audioResult.job_id}:${visualResult.job_id}`)
    .digest('hex')
    .slice(0, 16);

  return {
    ok: true,
    id: `cloud-multimodal-${jobRef}`,
    schema_version: 'sarah.multimodal-evidence.v1',
    mode: 'cloud_multimodal',
    engine: 'modal_l4_qwen25vl_whisper_ast_yolo_pose',
    range: { startMs: 0, endMs: Math.round(durationSeconds * 1000) },
    summary: `Cloud deep analysis covered ${Math.round(durationSeconds)} seconds with ${frameMetrics.length} visual samples, ${poseSamples.length} pose checks, ${semanticWindows.length} semantic windows, and ${acousticEvents.length} reviewable audio candidates.`,
    whole_video_story: 'Encrypted full-range screening completed. Sarah can use these timestamped visual, audio, pose, and physiology candidates as supporting context, but they remain explicitly unconfirmed until reviewed.',
    actionable_findings: [],
    strong_candidates: [...multimodalWindows, ...audioCandidates]
      .sort((a, b) => finite(a.start_ms) - finite(b.start_ms)),
    not_confirmed: reliableSpeech.length ? [] : [{ label: 'reliable_speech', reason: 'No reliable spoken words were confirmed.' }],
    timeline_events: reliableSpeech.map((segment) => ({
      start_ms: Math.round(finite(segment.start_s) * 1000),
      end_ms: Math.round(finite(segment.end_s) * 1000),
      label: 'reliable_speech',
      basis: String(segment.text || '').trim(),
      confidence: 0.75,
      provenance: { modality: 'audio', model_name: audioResult.transcription?.model },
    })),
    coverage_segments: multimodalWindows.map((window) => ({
      start_ms: window.start_ms,
      end_ms: window.end_ms,
      label: 'semantic_visual_review',
      status: 'reviewed',
      reviewed_by_qwen: true,
    })),
    multimodal_windows: multimodalWindows,
    physiology: {
      available_streams: availableStreams,
      fusion_state: availableStreams.length ? 'available_for_session_alignment' : 'no_session_streams_supplied',
    },
    audio_summary: {
      duration_seconds: finite(audioResult.audio?.duration_seconds),
      reliable_speech_segments: reliableSpeech.length,
      reviewable_acoustic_candidates: acousticEvents.length,
    },
    visual_summary: {
      duration_seconds: finite(visualResult.video?.duration_seconds),
      width: finite(visualResult.video?.width),
      height: finite(visualResult.video?.height),
      fps: finite(visualResult.video?.fps),
      frame_metrics: frameMetrics.length,
      pose_samples: poseSamples.length,
      pose_visible: visiblePoseSamples,
      pose_lost: lostPoseSamples,
      semantic_windows: semanticWindows.length,
    },
    confidence: { overall: 0.62, state: 'candidate_review_required' },
    privacy: {
      encrypted_in_transit: true,
      cloud_plaintext_retained: false,
      cloud_encrypted_chunks_retained: false,
    },
    debug: {
      qwenCalls: semanticWindows.length,
      rawEvidenceCounts: {
        frame_metrics: frameMetrics.length,
        pose_samples: poseSamples.length,
        semantic_windows: semanticWindows.length,
        acoustic_events: acousticEvents.length,
      },
    },
  };
}
