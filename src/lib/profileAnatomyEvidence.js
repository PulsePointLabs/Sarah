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
  const indexed = image.anatomy_classification || image.anatomyClassification;
  if (['none', 'incidental_device', 'device_dominant'].includes(indexed?.device_classification)) {
    return indexed.device_classification;
  }
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
  const classification = image.anatomy_classification || image.anatomyClassification || null;
  const item = {
    ...image,
    image_id: imageId,
    display_label: displayLabel,
    section_key: selectedSectionKey,
    section_label: annotation.section_label || image.section_label || image.section || '',
    section_labels: selectedSectionKey ? [selectedSectionKey] : [],
    validated_section_keys: classification?.best_for_sections?.length ? classification.best_for_sections : sectionKeys,
    regions: classification?.visible_anatomy?.length
      ? [...new Set(classification.visible_anatomy)]
      : [...new Set((annotatedRegions.length
      ? annotatedRegions
      : [...findingRegions, ...(Array.isArray(image.regions) ? image.regions : [])]
    ).filter(Boolean))],
    coverage,
    preview_url: image.preview_url || image.previewUrl || image.storagePath || image.url || '',
    source: image.source || '',
    source_kind: profileAnatomyEvidenceSourceKind(image),
    anatomy_classification: classification,
    anatomy_classification_version: image.anatomy_classification_version || image.anatomyClassificationVersion || '',
    anatomy_file_hash: image.anatomy_file_hash || image.anatomyFileHash || '',
    anatomy_labels: classification?.visible_anatomy?.length ? classification.visible_anatomy : image.anatomy_labels,
    fine_structure_labels: classification?.fine_structures?.length ? classification.fine_structures : image.fine_structure_labels,
    combined_view_strengths: classification?.combined_view_strengths || image.combined_view_strengths || [],
  };
  return {
    ...item,
    device_classification: profileAnatomyDeviceClassification(item),
  };
}

const SECTION_CLASSIFICATION_REQUIREMENTS = {
  head_face: ['head', 'face', 'scalp'],
  neck: ['neck'],
  shoulders_upper_back: ['shoulders', 'upper_back', 'thoracic_back', 'posterior_torso'],
  chest: ['chest'],
  abdomen: ['abdomen'],
  pelvis_pubic_region: ['pelvis', 'hips', 'lower_abdomen', 'pubic_mound'],
  genitals_perineum: ['penis', 'foreskin', 'glans', 'meatus', 'scrotum', 'testes', 'perineum'],
  buttocks_perianal_region: ['buttocks', 'anal_margin', 'anus', 'perianal_region'],
  upper_limbs_hands: ['upper_limbs', 'hands'],
  lower_limbs: ['lower_limbs', 'knees', 'calves'],
  feet_toes: ['ankles', 'feet', 'toes'],
  posture_alignment: ['posture'],
  skin_summary: ['skin_finding'],
  pubic_mound_lower_abdomen: ['pubic_mound', 'lower_abdomen'],
  inguinal_folds_groin_skin: ['right_inguinal_region', 'left_inguinal_region', 'inguinal_repair_scar'],
  right_inguinal_repair: ['right_inguinal_region', 'inguinal_repair_scar'],
  penis: ['penis', 'penile_base', 'penile_shaft'],
  foreskin: ['foreskin', 'foreskin_forward', 'foreskin_partially_retracted', 'foreskin_fully_retracted'],
  penis_and_foreskin: ['penis', 'penile_base', 'penile_shaft', 'foreskin', 'foreskin_forward', 'foreskin_partially_retracted', 'foreskin_fully_retracted'],
  glans: ['glans', 'corona'],
  meatus: ['meatus'],
  glans_meatus: ['glans', 'corona', 'meatus'],
  scrotum_testes: ['scrotum', 'testes'],
  perineum: ['perineum'],
  anal_opening_perianal_region: ['anal_margin', 'anus', 'perianal_region'],
  anus_perianal: ['anal_margin', 'anus', 'perianal_region'],
  buttocks_gluteal_skin: ['buttocks'],
  measurement_reconciliation: ['penis', 'penile_shaft', 'glans', 'meatus'],
};

const COMBINED_SECTION_STRENGTH = {
  pubic_mound_lower_abdomen: 'pubic_mound_and_penis',
  penis_and_foreskin: 'penis_and_foreskin',
  glans_meatus: 'glans_and_meatus',
  scrotum_testes: 'scrotum_and_perineum',
  anal_opening_perianal_region: 'anus_and_perianal_region',
  anus_perianal: 'anus_and_perianal_region',
  shoulders_upper_back: 'back_and_posture',
  right_inguinal_repair: 'right_inguinal_region_and_repair_scar',
};

const QUALITY_SCORE = { poor: 0, fair: 8, adequate: 10, good: 16, excellent: 24 };

export function scoreIndexedProfileAnatomyEvidence(image = {}, sectionKey = '') {
  const classification = image.anatomy_classification || image.anatomyClassification;
  if (!classification) return null;
  const deviceClass = classification.device_classification || 'none';
  const deviceSection = /^(?:device_contact_findings|tissue_health_safety_observations)$/.test(sectionKey);
  if (deviceClass === 'device_dominant' && !deviceSection) return -10000;
  const visible = new Set([...(classification.visible_anatomy || []), ...(classification.fine_structures || [])]);
  const required = SECTION_CLASSIFICATION_REQUIREMENTS[sectionKey] || [];
  const matched = required.filter((key) => visible.has(key));
  const exactBest = (classification.best_for_sections || []).includes(sectionKey);
  const combined = COMBINED_SECTION_STRENGTH[sectionKey]
    && (classification.combined_view_strengths || []).includes(COMBINED_SECTION_STRENGTH[sectionKey]);
  if (!exactBest && !matched.length && !deviceSection) return -10000;
  let score = matched.length * 80 + (exactBest ? 180 : 0) + (combined ? 120 : 0);
  score += QUALITY_SCORE[classification?.quality?.overall] || 0;
  score += QUALITY_SCORE[classification?.quality?.anatomy_visibility] || 0;
  if (deviceClass === 'incidental_device' && !deviceSection) score -= 25;
  if (deviceClass === 'device_dominant' && deviceSection) score += 80;
  return score;
}

export function selectIndexedProfileAnatomyEvidence(images = [], { sectionKey = '', max = 2 } = {}) {
  return (Array.isArray(images) ? images : [])
    .map((image) => ({ image, score: scoreIndexedProfileAnatomyEvidence(image, sectionKey) }))
    .filter((entry) => entry.score != null && entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Number(max) || 2));
}

export function applyProfileAnatomyIndexToResult(result = {}, inventory = {}, reviewType = '') {
  if (!result || typeof result !== 'object') return result;
  const entries = Array.isArray(inventory?.entries) ? inventory.entries : [];
  const byId = new Map(entries
    .filter((entry) => entry.reviewType === reviewType && entry.classification)
    .map((entry) => [entry.imageId, entry]));
  const byUrl = new Map(entries
    .filter((entry) => entry.classification && entry.sourceUrl)
    .map((entry) => [entry.sourceUrl, entry]));
  const reviewed = Array.isArray(result?._meta?.reviewed_images) ? result._meta.reviewed_images : [];
  const reviewedUrls = new Set(reviewed.map((image) => image.preview_url || image.previewUrl || image.storagePath || image.url || '').filter(Boolean));
  const indexedReferences = entries
    .filter((entry) => (entry.reviewType === reviewType || entry.reviewType === 'approved_chat') && entry.classification && entry.sourceUrl && !reviewedUrls.has(entry.sourceUrl))
    .map((entry) => ({
      ...(entry.referenceImage || {}),
      image_id: `indexed_${String(entry.fileHash || '').slice(0, 16)}`,
      original_image_id: entry.imageId,
      preview_url: entry.sourceUrl,
      source: entry.referenceImage?.source || (entry.reviewType === 'approved_chat' ? 'saved_profile_qa_attachment' : 'profile_review_image'),
      anatomy_reference_approved: entry.reviewType === 'approved_chat' ? true : entry.referenceImage?.anatomy_reference_approved,
      anatomy_classification: entry.classification,
      anatomy_classification_version: entry.classificationVersion,
      anatomy_file_hash: entry.fileHash,
    }));
  return {
    ...result,
    _meta: {
      ...(result._meta || {}),
      reviewed_images: [...reviewed.map((image) => {
        const url = image.preview_url || image.previewUrl || image.storagePath || image.url || '';
        const entry = byId.get(image.image_id) || byUrl.get(url);
        if (!entry?.classification) return image;
        return {
          ...image,
          anatomy_classification: entry.classification,
          anatomy_classification_version: entry.classificationVersion,
          anatomy_file_hash: entry.fileHash,
        };
      }), ...indexedReferences],
    },
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
