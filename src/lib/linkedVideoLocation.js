export const sameLinkedVideo = (video, original) => original.id ? video.id === original.id : video.path === original.path;
export function relocateLinkedVideo(videos, original, metadata) {
  if (!metadata?.path) throw new Error('Choose a reachable video on Windows.');
  if (videos.some(v => !sameLinkedVideo(v, original) && v.path === metadata.path)) throw new Error('That video is already linked to this session.');
  return videos.map(v => sameLinkedVideo(v, original) ? {
    ...v, cameraRole: v.cameraRole || original.cameraRole, path: metadata.path, filename: metadata.filename, sizeBytes: metadata.sizeBytes,
    durationSeconds: metadata.durationSeconds, modifiedAt: metadata.modifiedAt,
    fingerprint: metadata.fingerprint, mimeType: metadata.mimeType, exists: true,
    lastCheckedAt: metadata.checkedAt,
    previousPaths: [...new Set([...(v.previousPaths || []),v.path])].filter(p=>p!==metadata.path),
  } : v);
}
