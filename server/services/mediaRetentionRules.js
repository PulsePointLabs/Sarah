const MEDIA_EXTENSION_RE = /\.(?:aac|csv|cue|gif|jpe?g|json|m4a|m4v|mkv|mov|mp3|mp4|partial|png|txt|wav|webm)$/i;

export const MEDIA_RETENTION_POLICY = Object.freeze({
  partial_conversion: { ttlDays: 1, automatic: true, reproducible: true },
  generated_preview_frame: { ttlDays: 7, automatic: true, reproducible: true },
  generated_preview_clip: { ttlDays: 7, automatic: true, reproducible: true },
  local_playback_cache: { ttlDays: 14, automatic: true, reproducible: true },
  extracted_still_cache: { ttlDays: 30, automatic: true, reproducible: true },
  final_render: { ttlDays: null, automatic: false, reproducible: false },
  uploaded_source: { ttlDays: null, automatic: false, reproducible: false },
});

function safeBasename(value = '') {
  const clean = String(value || '').trim().split(/[?#]/, 1)[0];
  const piece = clean.split(/[\\/]/).filter(Boolean).at(-1) || '';
  try {
    return decodeURIComponent(piece);
  } catch {
    return piece;
  }
}

export function extractUploadReferences(value = '') {
  const text = String(value || '');
  const references = new Set();
  const add = (candidate) => {
    const basename = safeBasename(candidate);
    if (basename && MEDIA_EXTENSION_RE.test(basename)) references.add(basename.toLowerCase());
  };

  for (const match of text.matchAll(/\/uploads\/([^"'<>\s?#\\]+)/gi)) add(match[1]);
  for (const match of text.matchAll(/"(?:filename|stored_filename|output_filename|thumbnail_filename|source_filename)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/gi)) {
    try {
      add(JSON.parse(`"${match[1]}"`));
    } catch {
      add(match[1]);
    }
  }
  return references;
}

export function classifyUploadArtifact(filename = '') {
  const name = safeBasename(filename).toLowerCase();
  if (!name) return { category: 'uploaded_source', ...MEDIA_RETENTION_POLICY.uploaded_source };
  if (name.endsWith('.partial')) return { category: 'partial_conversion', ...MEDIA_RETENTION_POLICY.partial_conversion };
  if (/^local-playback-.*\.mp4$/i.test(name)) return { category: 'local_playback_cache', ...MEDIA_RETENTION_POLICY.local_playback_cache };
  if (/(?:manual-frame-v1|visual-still-v1|review-video-frame)/i.test(name)) {
    return { category: 'extracted_still_cache', ...MEDIA_RETENTION_POLICY.extracted_still_cache };
  }
  if (/-frame-\d{1,4}\.jpe?g$/i.test(name)) {
    return { category: 'generated_preview_frame', ...MEDIA_RETENTION_POLICY.generated_preview_frame };
  }
  if (/(?:clip-preview-v3|ai-video-pass|manual-note-|video-clip).*\.mp4$/i.test(name)) {
    return { category: 'generated_preview_clip', ...MEDIA_RETENTION_POLICY.generated_preview_clip };
  }
  if (/(?:ai-body-exploration-analysis|ai-session-analysis|technical-deep-dive|arousal-timeline|cascade-overview|near-climax|physiological-profile)/i.test(name)) {
    return { category: 'final_render', ...MEDIA_RETENTION_POLICY.final_render };
  }
  return { category: 'uploaded_source', ...MEDIA_RETENTION_POLICY.uploaded_source };
}

export function isRetentionCandidate({ filename, referenced = false, ageDays = 0 } = {}) {
  const classification = classifyUploadArtifact(filename);
  const eligible = classification.automatic
    && classification.reproducible
    && !referenced
    && Number(ageDays) >= Number(classification.ttlDays);
  return {
    ...classification,
    eligible,
    reason: referenced
      ? 'preserved_database_reference'
      : !classification.automatic
        ? 'preserved_non_cache_media'
        : eligible
          ? `unreferenced_reproducible_older_than_${classification.ttlDays}_days`
          : `within_${classification.ttlDays}_day_retention_window`,
  };
}
