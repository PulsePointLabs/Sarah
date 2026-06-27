const DYNAMIC_MEDIA_SOURCE_RE = /(?:body_exploration|session(?:_video)?|climax|generated_clip|local_vision|video_frame)/i;
const DYNAMIC_MEDIA_URL_RE = /(?:ai-video-pass|local-vision\/frame|session-video|climax|generated-clip)/i;
const PROFILER_SOURCE_RE = /^(?:fresh_upload|profile_review_image|profiler_upload|ai_profiler_upload)$/i;
const CHAT_SOURCE_RE = /^(?:saved_profile_qa_attachment|profile_qa_attachment|chat_with_sarah_attachment)$/i;
const DEVICE_RE = /\b(?:foley|catheter|statlock|drainage\s*bag|leg\s*bag|urine|tube|tubing|device|procedure|dilator|sound(?:ing)?)\b/i;
const DIRECT_ANATOMY_RE = /\b(?:penis|penile(?:\s+shaft)?|foreskin|prepuce|preputial|glans|meatus|meatal|scrotum|scrotal|testes?|testicles?|perineum|perineal|anus|anal|perianal|pubic|suprapubic|inguinal|groin|abdomen|abdominal|back|shoulder|chest|foot|feet|toe|buttock|gluteal)\b/i;

function text(...values) {
  return values.flat(Infinity).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export function isExplicitlyApprovedChatAnatomyReference(image = {}) {
  return image.anatomy_reference_approved === true
    || image.anatomyReferenceApproved === true
    || image.approved_for_anatomy === true
    || image.approvedForAnatomy === true;
}

export function profileAnatomyEvidenceSourceKind(image = {}) {
  const declaredKind = String(image.source_kind || image.sourceKind || '').trim();
  if (['profiler_upload', 'approved_chat_reference'].includes(declaredKind)) return declaredKind;
  if (declaredKind.startsWith('excluded_')) return declaredKind;
  const source = String(image.source || image.source_type || image.sourceType || '').trim();
  const url = String(image.preview_url || image.previewUrl || image.storagePath || image.url || '').trim();
  if (image.source_video || DYNAMIC_MEDIA_SOURCE_RE.test(source) || DYNAMIC_MEDIA_URL_RE.test(url)) {
    return 'excluded_dynamic_media';
  }
  if (CHAT_SOURCE_RE.test(source)) {
    return isExplicitlyApprovedChatAnatomyReference(image) ? 'approved_chat_reference' : 'excluded_unapproved_chat';
  }
  if (PROFILER_SOURCE_RE.test(source)) return 'profiler_upload';
  return 'excluded_unknown_source';
}

export function isEligibleProfileAnatomyEvidenceSource(image = {}) {
  return ['profiler_upload', 'approved_chat_reference'].includes(profileAnatomyEvidenceSourceKind(image));
}

export function profileAnatomyDeviceClassification(image = {}) {
  const primary = text(image.display_label, image.view_label, image.label);
  const allText = text(
    primary,
    image.coverage,
    image.visibility_notes,
    image.major_regions_visible,
    image.regions,
    image.regionLabels,
    image.anatomy_labels,
    image.fine_structure_labels,
  );
  if (!DEVICE_RE.test(allText)) return 'none';
  const sectionKey = String(image.section_key || image.sectionKey || '').toLowerCase();
  const deviceSection = /^(?:device_contact_findings|tissue_health_safety_observations)$/.test(sectionKey);
  const primaryHasAnatomy = DIRECT_ANATOMY_RE.test(primary);
  const primaryIsDeviceLed = /\b(?:foley|catheter|statlock|drainage\s*bag|device|procedure|dilator|sound(?:ing)?)\b/i.test(primary)
    && !primaryHasAnatomy;
  if (deviceSection || primaryIsDeviceLed || !DIRECT_ANATOMY_RE.test(allText)) return 'device_dominant';
  return 'incidental_device';
}

export function buildProfileAnatomyEvidenceItem(image = {}, annotation = {}, findings = [], index = 0) {
  const relatedFindings = Array.isArray(findings) ? findings.filter(Boolean) : [];
  const imageId = image.image_id || image.id || `profile-image-${index + 1}`;
  const sectionKeys = [...new Set(relatedFindings.map((finding) => finding.section_key).filter(Boolean))];
  const findingRegions = relatedFindings.map((finding) => finding.region || finding.label).filter(Boolean);
  const annotatedRegions = Array.isArray(annotation.major_regions_visible)
    ? annotation.major_regions_visible.filter(Boolean)
    : [];
  const selectedSectionKey = annotation.section_key
    || image.section_key
    || image.sectionKey
    || sectionKeys[0]
    || '';
  const displayLabel = annotation.view_label
    || image.display_label
    || image.view_label
    || image.label
    || `Reference view ${index + 1}`;
  const coverage = text(
    annotation.view_label,
    annotation.coverage,
    annotatedRegions,
    relatedFindings.map((finding) => finding.label),
    annotatedRegions.length || annotation.coverage ? '' : image.coverage,
    annotatedRegions.length || annotation.coverage ? '' : image.upload_note,
  );
  const item = {
    ...image,
    image_id: imageId,
    display_label: displayLabel,
    section_key: selectedSectionKey,
    section_label: annotation.section_label || image.section_label || image.section || '',
    section_labels: selectedSectionKey ? [selectedSectionKey] : [],
    validated_section_keys: sectionKeys,
    regions: [...new Set((annotatedRegions.length
      ? annotatedRegions
      : [...findingRegions, ...(Array.isArray(image.regions) ? image.regions : [])]
    ).filter(Boolean))],
    coverage,
    preview_url: image.preview_url || image.previewUrl || image.storagePath || image.url || '',
    source: image.source || '',
    source_kind: profileAnatomyEvidenceSourceKind(image),
  };
  return {
    ...item,
    device_classification: profileAnatomyDeviceClassification(item),
  };
}

export function filterProfileAnatomyReviewEvidence(result = {}) {
  if (!result || typeof result !== 'object') return result;
  const reviewed = Array.isArray(result?._meta?.reviewed_images) ? result._meta.reviewed_images : [];
  const eligibleIds = new Set(reviewed
    .filter((image) => isEligibleProfileAnatomyEvidenceSource(image))
    .map((image) => image?.image_id)
    .filter(Boolean));
  return {
    ...result,
    _meta: {
      ...(result._meta || {}),
      reviewed_images: reviewed.filter((image) => eligibleIds.has(image?.image_id)),
    },
    annotated_images: Array.isArray(result.annotated_images)
      ? result.annotated_images.filter((annotation) => eligibleIds.has(annotation?.image_id))
      : result.annotated_images,
    image_region_findings: Array.isArray(result.image_region_findings)
      ? result.image_region_findings.filter((finding) => eligibleIds.has(finding?.image_id))
      : result.image_region_findings,
  };
}
