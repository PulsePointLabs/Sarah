export function buildStoredProfilerImageRef(image = {}, index = 0, storagePath = "") {
  const resolvedPath = storagePath || image.storagePath || image.file_url || image.url || "";
  if (!resolvedPath) {
    throw new Error(`Could not save a reusable preview for ${image.filename || `reference image ${index + 1}`}.`);
  }

  return {
    ...image,
    filename: image.filename || `profile-reference-${index + 1}.jpg`,
    media_type: image.media_type || "image/jpeg",
    data: "",
    storagePath: resolvedPath,
    url: resolvedPath,
    file_url: image.file_url || resolvedPath,
    preview_url: image.preview_url || resolvedPath,
    previewUrl: image.previewUrl || resolvedPath,
    source: "fresh_upload",
    upload_note: String(image.upload_note || "").trim(),
    server_image_ref: true,
  };
}
