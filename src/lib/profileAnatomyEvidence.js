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

const SECTION_BEST_FOR_ALIASES = {
  shoulders_upper_back: ['upper_back', 'thoracic_back', 'posterior_torso_back'],
  pelvis_pubic_region: ['pelvis_hips', 'pubic_mound_lower_abdomen'],
  genitals_perineum: ['penis', 'foreskin', 'penis_and_foreskin', 'glans_meatus', 'scrotum_testes', 'perineum'],
  buttocks_perianal_region: ['buttocks', 'anus_perianal'],
  feet_toes: ['ankles_feet_toes'],
  posture_alignment: ['posture'],
  anal_opening_perianal_region: ['anus_perianal'],
  buttocks_gluteal_skin: ['buttocks'],
};

const QUALITY_SCORE = { poor: 0, fair: 8, adequate: 10, good: 16, excellent: 24 };

const FOCUSED_SECTIONS = new Set([
  'penis', 'foreskin', 'penis_and_foreskin', 'glans', 'meatus', 'glans_meatus',
  'scrotum_testes', 'perineum', 'anal_opening_perianal_region', 'anus_perianal',
  'buttocks_gluteal_skin', 'right_inguinal_repair',
]);

const BROAD_SECTIONS = new Set([
  'head_face', 'neck', 'shoulders_upper_back', 'chest', 'abdomen',
  'pelvis_pubic_region', 'upper_limbs_hands', 'lower_limbs', 'feet_toes',
  'posture_alignment', 'pubic_mound_lower_abdomen',
]);

const SECTION_REQUIRED_GROUPS = {
  pubic_mound_lower_abdomen: [['pubic_mound'], ['lower_abdomen']],
  penis: [['penis', 'penile_base', 'penile_shaft']],
  foreskin: [['foreskin', 'foreskin_forward', 'foreskin_partially_retracted', 'foreskin_fully_retracted']],
  penis_and_foreskin: [
    ['penis', 'penile_base', 'penile_shaft'],
    ['foreskin', 'foreskin_forward', 'foreskin_partially_retracted', 'foreskin_fully_retracted'],
  ],
  glans: [['glans', 'corona']],
  meatus: [['meatus']],
  glans_meatus: [['glans', 'corona'], ['meatus']],
  scrotum_testes: [['scrotum'], ['testes']],
  perineum: [['perineum']],
  anal_opening_perianal_region: [['anus', 'anal_margin'], ['perianal_region']],
  anus_perianal: [['anus', 'anal_margin'], ['perianal_region']],
  buttocks_gluteal_skin: [['buttocks']],
  buttocks_perianal_region: [['buttocks'], ['anus', 'anal_margin', 'perianal_region']],
  right_inguinal_repair: [['right_inguinal_region', 'inguinal_repair_scar']],
  shoulders_upper_back: [['shoulders'], ['upper_back', 'thoracic_back', 'posterior_torso']],
  feet_toes: [['feet', 'ankles'], ['toes']],
};

const SECTION_DISTRACTOR_KEYS = {
  foreskin: ['perineum', 'anus', 'anal_margin', 'perianal_region', 'buttocks'],
  penis: ['anus', 'anal_margin', 'perianal_region', 'buttocks'],
  scrotum_testes: ['anus', 'anal_margin', 'perianal_region', 'buttocks'],
  perineum: ['anus', 'anal_margin', 'perianal_region', 'buttocks'],
  anal_opening_perianal_region: ['penis', 'penile_shaft', 'glans', 'meatus'],
  anus_perianal: ['penis', 'penile_shaft', 'glans', 'meatus'],
  glans_meatus: ['anus', 'anal_margin', 'perianal_region', 'buttocks'],
};

function indexedClassification(image = {}) {
  return image.anatomy_classification || image.anatomyClassification || null;
}

function indexedEvidenceScoreDetails(image = {}, sectionKey = '') {
  const classification = indexedClassification(image);
  if (!classification) return null;
  const deviceClass = classification.device_classification || 'none';
  const deviceSection = /^(?:device_contact_findings|tissue_health_safety_observations)$/.test(sectionKey);
  if (deviceClass === 'device_dominant' && !deviceSection) {
    return { score: -10000, status: 'rejected', reason: 'device_dominant' };
  }

  const visible = new Set(classification.visible_anatomy || []);
  const fine = new Set(classification.fine_structures || []);
  const allVisible = new Set([...visible, ...fine]);
  const required = SECTION_CLASSIFICATION_REQUIREMENTS[sectionKey] || [];
  const matched = required.filter((key) => allVisible.has(key));
  const fineMatched = required.filter((key) => fine.has(key));
  const bestFor = new Set(classification.best_for_sections || []);
  const exactBest = bestFor.has(sectionKey)
    || (SECTION_BEST_FOR_ALIASES[sectionKey] || []).some((alias) => bestFor.has(alias));
  const combined = Boolean(COMBINED_SECTION_STRENGTH[sectionKey]
    && (classification.combined_view_strengths || []).includes(COMBINED_SECTION_STRENGTH[sectionKey]));
  if (!exactBest && !matched.length && !deviceSection) {
    return { score: -10000, status: 'rejected', reason: 'no_requested_anatomy' };
  }

  const groups = SECTION_REQUIRED_GROUPS[sectionKey] || (required.length ? [required] : []);
  const coveredGroups = groups.filter((group) => group.some((key) => allVisible.has(key))).length;
  const completeGroups = groups.length > 0 && coveredGroups === groups.length;
  const positions = new Set(classification.positions || []);
  const focused = FOCUSED_SECTIONS.has(sectionKey);
  const broad = BROAD_SECTIONS.has(sectionKey);
  const distractors = (SECTION_DISTRACTOR_KEYS[sectionKey] || []).filter((key) => allVisible.has(key));

  let score = matched.length * 55;
  score += fineMatched.length * 45;
  score += exactBest ? 260 : 0;
  score += combined ? 170 : 0;
  score += coveredGroups * 85;
  score += completeGroups ? 110 : 0;
  if (focused && positions.has('close_up')) score += 90;
  if (focused && positions.has('wide_field')) score -= 35;
  if (broad && positions.has('wide_field')) score += 65;
  if (broad && positions.has('standing')) score += 35;
  if (sectionKey === 'pubic_mound_lower_abdomen') {
    if (allVisible.has('right_inguinal_region') && allVisible.has('left_inguinal_region')) score += 70;
    if (allVisible.has('penile_base')) score += 35;
  }
  score -= distractors.length * 95;
  if (focused) score -= Math.max(0, allVisible.size - matched.length - fineMatched.length - 5) * 4;
  score += QUALITY_SCORE[classification?.quality?.overall] || 0;
  score += QUALITY_SCORE[classification?.quality?.focus] || 0;
  score += QUALITY_SCORE[classification?.quality?.anatomy_visibility] || 0;
  if (deviceClass === 'incidental_device' && !deviceSection) score -= 70;
  if (deviceClass === 'device_dominant' && deviceSection) score += 80;

  const directStrong = exactBest && completeGroups
    && (!focused || positions.has('close_up') || combined)
    && classification?.quality?.anatomy_visibility !== 'poor';
  const directLimited = exactBest || (completeGroups && matched.length > 0);
  return {
    score,
    status: directStrong ? 'direct_strong' : directLimited ? 'direct_limited' : matched.length ? 'indirect' : 'absent',
    exactBest,
    combined,
    completeGroups,
    matched,
    fineMatched,
    distractors,
  };
}

export function scoreIndexedProfileAnatomyEvidence(image = {}, sectionKey = '') {
  return indexedEvidenceScoreDetails(image, sectionKey)?.score ?? null;
}

export function selectIndexedProfileAnatomyEvidence(images = [], { sectionKey = '', max = 2 } = {}) {
  return (Array.isArray(images) ? images : [])
    .map((image) => {
      const details = indexedEvidenceScoreDetails(image, sectionKey);
      return { image, score: details?.score ?? null, status: details?.status || 'unindexed', details };
    })
    .filter((entry) => entry.score != null && entry.score > 0)
    .sort((a, b) => b.score - a.score || String(a.image.image_id || '').localeCompare(String(b.image.image_id || '')))
    .slice(0, Math.max(1, Number(max) || 2));
}

export function profileAnatomyEvidenceAvailability(images = [], sectionKey = '', max = 3) {
  const ranked = selectIndexedProfileAnatomyEvidence(images, { sectionKey, max });
  const status = ranked.some((entry) => entry.status === 'direct_strong')
    ? 'direct_strong'
    : ranked.some((entry) => entry.status === 'direct_limited')
      ? 'direct_limited'
      : ranked.length ? 'indirect' : 'absent';
  return {
    sectionKey,
    status,
    evidence: ranked,
    imageIds: ranked.map((entry) => entry.image.image_id).filter(Boolean),
  };
}

export function buildProfileAnatomyEvidenceAvailability(result = {}, sections = [], max = 3) {
  const images = Array.isArray(result?._meta?.reviewed_images) ? result._meta.reviewed_images : [];
  return (Array.isArray(sections) ? sections : [])
    .map((section) => typeof section === 'string' ? { key: section, label: section } : section)
    .filter((section) => section?.key && !/^(?:executive_summary|limitations_future_coverage)$/.test(section.key))
    .map((section) => ({
      ...profileAnatomyEvidenceAvailability(images, section.key, max),
      label: section.label || section.key,
    }));
}

export function formatProfileAnatomyEvidenceAvailabilityForPrompt(result = {}, sections = [], max = 3) {
  const availability = buildProfileAnatomyEvidenceAvailability(result, sections, max);
  if (!availability.length) return '';
  const lines = availability.map((entry) => {
    const evidence = entry.evidence.map(({ image, status }) => {
      const classification = indexedClassification(image) || {};
      const stableId = image.original_image_id || image.image_id || 'unknown';
      const positions = (classification.positions || []).join(', ') || 'position unspecified';
      const anatomy = [...new Set([...(classification.visible_anatomy || []), ...(classification.fine_structures || [])])].join(', ');
      const device = classification.device_classification || 'none';
      const notes = String(classification.notes || '').replace(/\s+/g, ' ').trim().slice(0, 420);
      return `${stableId} [${status}; ${positions}; device=${device}; anatomy=${anatomy}]${notes ? ` ${notes}` : ''}`;
    }).join(' || ');
    return `- ${entry.key} (${entry.label}): ${entry.status}. ${evidence || 'No indexed evidence assigned.'}`;
  });
  return `INDEXED ANATOMY EVIDENCE AVAILABILITY - AUTHORITATIVE FOR COVERAGE CLAIMS:\n${lines.join('\n')}\n\nRules:\n- The first image listed is the first-choice evidence for that section and must lead both static evidence cards and video evidence.\n- direct_strong means do not claim absent, unassessable, missing, or a coverage gap.\n- direct_limited means describe what is directly visible and state only the specific remaining limitation.\n- indirect means qualify the assessment. absent is the only status that permits a true coverage-gap statement.\n- Device-dominant evidence is not ordinary anatomy evidence. Keep catheter and procedure history in the device/contact section unless it directly explains a visible tissue finding.`;
}

const FALSE_COVERAGE_GAP_RE = /\b(?:no dedicated|no direct|no established|not represented|not available|coverage gap|primary anatomical coverage gap|would establish|needed to complete|is needed to complete|unassessable|cannot be assessed|not assessable|no .*?view exists?|no .*?view is available)\b/i;
const DEVICE_HISTORY_RE = /\b(?:foley|catheter|statlock|drainage bag|leg bag|catheter shaft|catheter tubing|dwell|instrumentation)\b/i;
const MEASUREMENT_DEVICE_INFERENCE_RE = /\b(?:catheter shaft measurement|external catheter length|urethral length|insertion depth|catheter depth|accommodat(?:ion|ing) inferred from catheter)\b/i;

function sentences(value = '') {
  return String(value || '').split(/(?<=[.!?])\s+/).map((item) => item.trim()).filter(Boolean);
}

function sectionValueItems(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return sentences(value);
}

function restoreSectionValueType(original, items) {
  return Array.isArray(original) ? items : items.join(' ');
}

export function reconcileProfileReviewEvidenceClaims(result = {}, evidenceResult = result, sections = []) {
  if (!result || typeof result !== 'object') return result;
  const availability = buildProfileAnatomyEvidenceAvailability(evidenceResult, sections, 3);
  const bySection = new Map(availability.map((entry) => [entry.sectionKey, entry]));
  const next = { ...result };

  for (const section of Array.isArray(sections) ? sections : []) {
    const key = typeof section === 'string' ? section : section?.key;
    if (!key || next[key] == null) continue;
    const coverage = bySection.get(key);
    let items = sectionValueItems(next[key]);
    if (coverage?.status === 'direct_strong') {
      items = items.map((item) => sentences(item).filter((sentence) => !FALSE_COVERAGE_GAP_RE.test(sentence)).join(' ')).filter(Boolean);
    } else if (coverage?.status === 'direct_limited') {
      items = items.map((item) => sentences(item).filter((sentence) => !/\b(?:no established|no direct evidence|not represented|coverage is absent)\b/i.test(sentence)).join(' ')).filter(Boolean);
    }
    if (!/^(?:device_contact_findings|tissue_health_safety_observations)$/.test(key)) {
      items = items.map((item) => {
        const parts = sentences(item);
        return [...parts.filter((part) => !DEVICE_HISTORY_RE.test(part)), ...parts.filter((part) => DEVICE_HISTORY_RE.test(part))].join(' ');
      }).filter(Boolean);
    }
    if (key === 'measurement_reconciliation') {
      items = items.map((item) => sentences(item).filter((sentence) => !MEASUREMENT_DEVICE_INFERENCE_RE.test(sentence)).join(' ')).filter(Boolean);
    }
    next[key] = restoreSectionValueType(next[key], items);
  }

  const strongCoverageTerms = availability
    .filter((entry) => entry.status === 'direct_strong')
    .flatMap((entry) => [entry.label, entry.sectionKey])
    .flatMap((value) => String(value || '').toLowerCase().split(/[^a-z0-9]+/))
    .filter((term) => term.length > 3 && !['region', 'opening', 'skin'].includes(term));
  const dropCoveredGap = (item) => {
    const value = String(item || '');
    if (!FALSE_COVERAGE_GAP_RE.test(value)) return false;
    return strongCoverageTerms.some((term) => value.toLowerCase().includes(term));
  };
  if (next.limitations_future_coverage != null) {
    const original = next.limitations_future_coverage;
    next.limitations_future_coverage = restoreSectionValueType(original, sectionValueItems(original).filter((item) => !dropCoveredGap(item)));
  }
  if (next.summary_card && typeof next.summary_card === 'object' && Array.isArray(next.summary_card.key_limitations)) {
    next.summary_card = {
      ...next.summary_card,
      key_limitations: next.summary_card.key_limitations.filter((item) => !dropCoveredGap(item)),
    };
  }
  return next;
}

function profileEvidenceUrlIdentity(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, 'http://sarah.local').pathname.replace(/\\/g, '/');
  } catch {
    return raw.replace(/\\/g, '/');
  }
}

export function applyProfileAnatomyIndexToResult(result = {}, inventory = {}, reviewType = '') {
  if (!result || typeof result !== 'object') return result;
  const entries = Array.isArray(inventory?.entries) ? inventory.entries : [];
  const byId = new Map(entries
    .filter((entry) => entry.reviewType === reviewType && entry.classification)
    .map((entry) => [entry.imageId, entry]));
  const byUrl = new Map(entries
    .filter((entry) => entry.classification && entry.sourceUrl)
    .flatMap((entry) => [
      [entry.sourceUrl, entry],
      [profileEvidenceUrlIdentity(entry.sourceUrl), entry],
    ]));
  const reviewed = Array.isArray(result?._meta?.reviewed_images) ? result._meta.reviewed_images : [];
  const reviewedUrls = new Set(reviewed
    .map((image) => profileEvidenceUrlIdentity(image.preview_url || image.previewUrl || image.storagePath || image.url || ''))
    .filter(Boolean));
  const reviewedHashes = new Set(reviewed.map((image) => {
    const url = image.preview_url || image.previewUrl || image.storagePath || image.url || '';
    return (byUrl.get(url) || byUrl.get(profileEvidenceUrlIdentity(url)))?.fileHash || image.anatomy_file_hash || '';
  }).filter(Boolean));
  const indexedReferences = entries
    .filter((entry) => (entry.reviewType === reviewType || entry.reviewType === 'approved_chat')
      && entry.classification
      && entry.sourceUrl
      && !reviewedHashes.has(entry.fileHash)
      && !reviewedUrls.has(profileEvidenceUrlIdentity(entry.sourceUrl)))
    .map((entry) => {
      const stableId = `indexed_${String(entry.fileHash || '').slice(0, 16)}`;
      return {
        ...(entry.referenceImage || {}),
        id: stableId,
        image_id: stableId,
        original_image_id: entry.imageId,
        preview_url: entry.sourceUrl,
        source: entry.referenceImage?.source || (entry.reviewType === 'approved_chat' ? 'saved_profile_qa_attachment' : 'profile_review_image'),
        anatomy_reference_approved: entry.reviewType === 'approved_chat' ? true : entry.referenceImage?.anatomy_reference_approved,
        anatomy_classification: entry.classification,
        anatomy_classification_version: entry.classificationVersion,
        anatomy_file_hash: entry.fileHash,
      };
    });
  return {
    ...result,
    _meta: {
      ...(result._meta || {}),
      reviewed_images: [...reviewed.map((image) => {
        const url = image.preview_url || image.previewUrl || image.storagePath || image.url || '';
        // Image IDs are reused across archived Profiler runs. The source URL is
        // the stable identity for a concrete image; only fall back to the local
        // run ID when no URL match exists.
        const entry = byUrl.get(url) || byUrl.get(profileEvidenceUrlIdentity(url)) || byId.get(image.image_id);
        if (!entry?.classification) return { ...image, id: image.id || image.image_id };
        return {
          ...image,
          id: image.id || image.image_id,
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
