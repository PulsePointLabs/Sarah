import fs from 'node:fs/promises';
import path from 'node:path';
import { uploadDir, ttsRenderDir } from '../config.js';
import { listEntities, upsertEntity } from '../db.js';
import { renderTTSExport } from './ttsRenderer.js';
import { q, runProcess, slugifyFilePart } from './ttsCore.js';

const PROFILE_ANATOMY_VIDEO_RENDER_VERSION = 'profile_anatomy_video_v1_hd';
const VIDEO_WIDTH = Number(process.env.PROFILE_ANATOMY_VIDEO_WIDTH || 1920);
const VIDEO_HEIGHT = Number(process.env.PROFILE_ANATOMY_VIDEO_HEIGHT || 1080);
const VIDEO_FPS = Number(process.env.PROFILE_ANATOMY_VIDEO_FPS || 30);
const VIDEO_CRF = String(process.env.PROFILE_ANATOMY_VIDEO_CRF || 17);
const VIDEO_PRESET = process.env.PROFILE_ANATOMY_VIDEO_PRESET || 'slow';
const MIN_SEGMENT_SECONDS = 4.5;
const MAX_SEGMENT_SECONDS = 12;
const MIN_PARAGRAPH_SEGMENT_SECONDS = 1.4;

const SECTION_REGION_ALIASES = [
  {
    key: 'head_face',
    aliases: ['head', 'face', 'facial', 'head hair', 'salt and pepper hair', 'salt-and-pepper hair', 'closely cropped hair', 'scalp', 'beard', 'glasses', 'jaw', 'forehead', 'eyes', 'nose', 'mouth'],
  },
  {
    key: 'neck',
    aliases: ['neck', 'cervical'],
  },
  {
    key: 'shoulders_upper_back',
    aliases: ['shoulder', 'shoulders', 'upper back', 'back', 'posterior trunk', 'thoracic', 'scapula', 'scapular'],
  },
  {
    key: 'chest',
    aliases: ['chest', 'thorax', 'thoracic front', 'upper torso', 'anterior torso', 'front torso', 'pectoral', 'pectorals', 'nipple', 'nipples', 'sternum'],
  },
  {
    key: 'abdomen',
    aliases: ['abdomen', 'abdominal', 'belly', 'flank', 'umbilicus', 'bite wound', 'bruise', 'bruising', 'striae', 'hernia scar'],
  },
  {
    key: 'pelvis_pubic_region',
    aliases: ['pelvis', 'pelvic', 'pubic', 'inguinal', 'groin', 'statlock', 'penile base', 'lower abdomen'],
  },
  {
    key: 'genitals_perineum',
    aliases: ['genital', 'genitals', 'penis', 'penile', 'glans', 'meatus', 'foreskin', 'shaft', 'scrotum', 'testes', 'testicle', 'perineum', 'foley', 'catheter'],
  },
  {
    key: 'buttocks_perianal',
    aliases: ['buttock', 'buttocks', 'gluteal', 'anal', 'anus', 'perianal', 'perineal', 'rectal'],
  },
  {
    key: 'upper_limbs_hands',
    aliases: ['upper limb', 'arm', 'arms', 'hand', 'hands', 'wrist', 'forearm', 'elbow', 'finger'],
  },
  {
    key: 'lower_limbs',
    aliases: ['lower limb', 'lower limbs', 'lower extremity', 'lower extremities', 'lower leg', 'lower legs', 'leg', 'legs', 'calf', 'calves', 'knee', 'knees', 'shin', 'shins'],
  },
  {
    key: 'feet_toes',
    aliases: ['foot', 'feet', 'toe', 'toes', 'ankle', 'ankles', 'heel', 'heels', 'plantar', 'dorsal foot', 'edema'],
  },
  {
    key: 'posture_alignment',
    aliases: ['posture', 'alignment', 'standing', 'supine', 'lateral view', 'whole body', 'full body'],
  },
  {
    key: 'skin_summary',
    aliases: ['skin', 'lesion', 'lesions', 'papule', 'papules', 'wound', 'scar', 'erythema', 'ecchymosis', 'pigmented'],
  },
];

const FINE_STRUCTURE_ALIASES = [
  { key: 'meatus', aliases: ['meatus', 'meatal', 'urethral opening', 'urethral meatus', 'urethral outlet'] },
  { key: 'glans', aliases: ['glans', 'corona', 'coronal ridge'] },
  { key: 'foreskin', aliases: ['foreskin', 'prepuce', 'preputial', 'retracted foreskin', 'foreskin retraction'] },
  { key: 'shaft', aliases: ['shaft', 'penile shaft', 'dorsal shaft', 'ventral shaft'] },
  { key: 'scrotum', aliases: ['scrotum', 'scrotal', 'testes', 'testicle', 'testicles', 'raphe'] },
  { key: 'perineum', aliases: ['perineum', 'perineal', 'perineal body'] },
  { key: 'anal_perianal', aliases: ['anal', 'anus', 'perianal', 'rectal'] },
  { key: 'pubic_groin', aliases: ['pubic', 'pubic mound', 'inguinal', 'groin', 'lower abdomen', 'penile base'] },
  { key: 'catheter_device', aliases: ['catheter', 'foley', 'statlock', 'device', 'tube', 'tubing', 'leg bag'] },
  { key: 'abdomen_bruise', aliases: ['abdomen', 'abdominal', 'bruise', 'bruising', 'bite', 'bite wound', 'ecchymosis'] },
  { key: 'feet_toes', aliases: ['foot', 'feet', 'toe', 'toes', 'ankle', 'heel'] },
  { key: 'chest', aliases: ['chest', 'thorax', 'pectoral', 'nipple', 'sternum'] },
  { key: 'face_head', aliases: ['head', 'face', 'scalp', 'beard', 'glasses'] },
];

const DEVICE_STRUCTURE_KEYS = new Set(['catheter_device']);

const SECTION_KEY_REGION_MAP = new Map([
  ['executive_summary', 'overview'],
  ['head_face', 'head_face'],
  ['neck', 'neck'],
  ['shoulders_upper_back', 'shoulders_upper_back'],
  ['chest', 'chest'],
  ['abdomen', 'abdomen'],
  ['pelvis_pubic_region', 'pelvis_pubic_region'],
  ['genitals_perineum', 'genitals_perineum'],
  ['buttocks_perianal_region', 'buttocks_perianal'],
  ['upper_limbs_hands', 'upper_limbs_hands'],
  ['lower_limbs', 'lower_limbs'],
  ['feet_toes', 'feet_toes'],
  ['posture_alignment', 'posture_alignment'],
  ['skin_summary', 'skin_summary'],
  ['limitations_future_coverage', 'overview'],
  ['pubic_mound_lower_abdomen', 'pelvis_pubic_region'],
  ['inguinal_folds_groin_skin', 'pelvis_pubic_region'],
  ['penis', 'genitals_perineum'],
  ['foreskin', 'genitals_perineum'],
  ['glans_meatus', 'genitals_perineum'],
  ['scrotum_testes', 'genitals_perineum'],
  ['perineum', 'genitals_perineum'],
  ['anal_opening_perianal_region', 'buttocks_perianal'],
  ['buttocks_gluteal_skin', 'buttocks_perianal'],
  ['device_contact_findings', 'genitals_perineum'],
  ['tissue_health_safety_observations', 'genitals_perineum'],
  ['measurement_reconciliation', 'genitals_perineum'],
]);

const MIXED_SECTION_KEYS = new Set([
  'executive_summary',
  'limitations_future_coverage',
]);

const PELVIC_GENITAL_REVIEW_ALLOWED_REGIONS = new Set([
  'pelvis_pubic_region',
  'genitals_perineum',
  'buttocks_perianal',
]);

const PELVIC_GENITAL_REVIEW_FORBIDDEN_REGIONS = new Set([
  'head_face',
  'neck',
  'shoulders_upper_back',
  'chest',
  'abdomen',
  'lower_limbs',
  'feet_toes',
]);

const HEAD_TO_TOE_OVERVIEW_ALLOWED_REGIONS = new Set([
  'head_face',
  'neck',
  'shoulders_upper_back',
  'chest',
  'abdomen',
  'upper_limbs_hands',
  'lower_limbs',
  'feet_toes',
  'posture_alignment',
  'skin_summary',
]);

const HEAD_TO_TOE_OVERVIEW_FORBIDDEN_CLOSEUP_REGIONS = new Set([
  'pelvis_pubic_region',
  'genitals_perineum',
  'buttocks_perianal',
]);

const NEGATED_REGION_PATTERNS = [
  ['genitals_perineum', /\b(?:no|not|without|lacks?|absent)\s+(?:visible\s+|direct\s+|clear\s+|obvious\s+|confirmed\s+){0,4}(?:genital|genitals|penis|penile|glans|meatus|foreskin|shaft|scrotum|testes|testicle|perineum|perineal|foley|catheter|urethra|urethral)\b/i],
  ['pelvis_pubic_region', /\b(?:no|not|without|lacks?|absent)\s+(?:visible\s+|direct\s+|clear\s+|obvious\s+|confirmed\s+){0,4}(?:pelvis|pelvic|pubic|inguinal|groin|statlock|penile base)\b/i],
  ['buttocks_perianal', /\b(?:no|not|without|lacks?|absent)\s+(?:visible\s+|direct\s+|clear\s+|obvious\s+|confirmed\s+){0,4}(?:anal|anus|perianal|rectal|buttock|buttocks|gluteal)\b/i],
  ['abdomen', /\b(?:no|not|without|lacks?|absent)\s+(?:visible\s+|direct\s+|clear\s+|obvious\s+|confirmed\s+){0,4}(?:abdomen|abdominal|belly|flank|umbilicus|bite wound|bruise|bruising|striae|hernia scar)\b/i],
  ['feet_toes', /\b(?:no|not|without|lacks?|absent)\s+(?:visible\s+|direct\s+|clear\s+|obvious\s+|confirmed\s+){0,4}(?:foot|feet|toe|toes|ankle|ankles|heel|heels|plantar|dorsal foot|edema)\b/i],
  ['lower_limbs', /\b(?:no|not|without|lacks?|absent)\s+(?:visible\s+|direct\s+|clear\s+|obvious\s+|confirmed\s+){0,4}(?:lower limb|lower limbs|lower extremity|lower extremities|lower leg|lower legs|leg|legs|calf|calves|knee|knees|shin|shins)\b/i],
];

const IMAGE_SECTION_KEYS_WITHOUT_REGION_AUTHORITY = new Set([
  'executive_summary',
  'limitations_future_coverage',
  'tissue_health_safety_observations',
  'measurement_reconciliation',
]);

const REGION_LABELS = new Map([
  ['overview', 'overview/title card only'],
  ['head_face', 'head/face'],
  ['neck', 'neck'],
  ['shoulders_upper_back', 'shoulders/upper back'],
  ['chest', 'chest'],
  ['abdomen', 'abdomen'],
  ['pelvis_pubic_region', 'pelvis/pubic region'],
  ['genitals_perineum', 'genitals/perineum'],
  ['buttocks_perianal', 'buttocks/perianal'],
  ['upper_limbs_hands', 'upper limbs/hands'],
  ['lower_limbs', 'lower limbs'],
  ['feet_toes', 'feet/toes'],
  ['posture_alignment', 'posture/alignment'],
  ['skin_summary', 'skin'],
]);

const HARD_MISMATCH_GROUPS = new Map([
  ['head_face', new Set(['pelvis_pubic_region', 'genitals_perineum', 'buttocks_perianal', 'lower_limbs', 'feet_toes'])],
  ['neck', new Set(['pelvis_pubic_region', 'genitals_perineum', 'buttocks_perianal', 'lower_limbs', 'feet_toes'])],
  ['chest', new Set(['genitals_perineum', 'buttocks_perianal', 'feet_toes'])],
  ['abdomen', new Set(['head_face', 'neck', 'feet_toes'])],
  ['pelvis_pubic_region', new Set(['head_face', 'neck', 'chest', 'lower_limbs', 'feet_toes'])],
  ['genitals_perineum', new Set(['head_face', 'neck', 'chest', 'lower_limbs', 'feet_toes'])],
  ['buttocks_perianal', new Set(['head_face', 'neck', 'chest', 'lower_limbs', 'feet_toes'])],
  ['lower_limbs', new Set(['head_face', 'neck', 'chest', 'genitals_perineum', 'buttocks_perianal'])],
  ['feet_toes', new Set(['head_face', 'neck', 'chest', 'genitals_perineum', 'buttocks_perianal'])],
]);

const STRICT_ALLOWED_IMAGE_REGIONS = new Map([
  ['overview', new Set()],
  ['head_face', new Set(['head_face'])],
  ['neck', new Set(['neck', 'head_face'])],
  ['shoulders_upper_back', new Set(['shoulders_upper_back', 'posture_alignment', 'skin_summary'])],
  ['chest', new Set(['chest', 'posture_alignment', 'skin_summary'])],
  ['abdomen', new Set(['abdomen', 'skin_summary'])],
  ['pelvis_pubic_region', new Set(['pelvis_pubic_region', 'genitals_perineum'])],
  ['genitals_perineum', new Set(['genitals_perineum', 'pelvis_pubic_region'])],
  ['buttocks_perianal', new Set(['buttocks_perianal', 'genitals_perineum', 'pelvis_pubic_region'])],
  ['upper_limbs_hands', new Set(['upper_limbs_hands', 'skin_summary'])],
  ['lower_limbs', new Set(['lower_limbs', 'skin_summary'])],
  ['feet_toes', new Set(['feet_toes', 'skin_summary'])],
  ['posture_alignment', new Set(['posture_alignment', 'head_face', 'neck', 'shoulders_upper_back', 'chest', 'abdomen', 'lower_limbs', 'feet_toes'])],
  ['skin_summary', new Set(['skin_summary', 'abdomen', 'lower_limbs', 'feet_toes', 'shoulders_upper_back'])],
]);

const STRICT_FORBIDDEN_IMAGE_REGIONS = new Map([
  ['head_face', new Set(['pelvis_pubic_region', 'genitals_perineum', 'buttocks_perianal', 'lower_limbs', 'feet_toes'])],
  ['neck', new Set(['pelvis_pubic_region', 'genitals_perineum', 'buttocks_perianal', 'lower_limbs', 'feet_toes'])],
  ['pelvis_pubic_region', new Set(['head_face', 'neck', 'chest', 'lower_limbs', 'feet_toes'])],
  ['genitals_perineum', new Set(['head_face', 'neck', 'chest', 'lower_limbs', 'feet_toes'])],
  ['buttocks_perianal', new Set(['head_face', 'neck', 'chest', 'lower_limbs', 'feet_toes'])],
  ['lower_limbs', new Set(['head_face', 'neck', 'chest', 'genitals_perineum', 'buttocks_perianal'])],
  ['feet_toes', new Set(['head_face', 'neck', 'chest', 'pelvis_pubic_region', 'genitals_perineum', 'buttocks_perianal'])],
]);

function uploadPathFromUrl(fileUrl = '') {
  const raw = String(fileUrl || '').trim();
  if (!raw.startsWith('/uploads/')) return null;
  const filename = path.basename(decodeURIComponent(raw.replace(/^\/uploads\//, '')));
  return path.join(uploadDir, filename);
}

function normalizeText(value = '') {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasMatchesText(text = '', alias = '') {
  const normalizedText = normalizeText(text);
  const normalizedAlias = normalizeText(alias);
  if (!normalizedText || !normalizedAlias) return false;
  const pattern = normalizedAlias.split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`(^|[^a-z0-9])${pattern}([^a-z0-9]|$)`, 'i').test(normalizedText);
}

function aliasMatchIndex(text = '', alias = '') {
  const normalizedText = normalizeText(text);
  const normalizedAlias = normalizeText(alias);
  if (!normalizedText || !normalizedAlias) return -1;
  const pattern = normalizedAlias.split(/\s+/).map(escapeRegExp).join('\\s+');
  return normalizedText.search(new RegExp(`(^|[^a-z0-9])${pattern}([^a-z0-9]|$)`, 'i'));
}

function sectionRegionKeyFromText(value = '') {
  const text = normalizeText(value);
  if (!text) return '';
  let best = null;
  for (const region of SECTION_REGION_ALIASES) {
    for (const alias of region.aliases) {
      const needle = normalizeText(alias);
      if (!needle) continue;
      const index = aliasMatchIndex(text, needle);
      if (index < 0) continue;
      const score = needle.length + (index === 0 ? 10 : 0);
      if (!best || score > best.score) best = { key: region.key, score };
    }
  }
  return best?.key || '';
}

function collectRegionKeys(value = '') {
  const text = normalizeText(value);
  if (!text) return new Set();
  const keys = new Set();
  for (const region of SECTION_REGION_ALIASES) {
    if (region.aliases.some((alias) => aliasMatchesText(text, alias))) {
      keys.add(region.key);
    }
  }
  return keys;
}

function collectFineStructureKeys(value = '') {
  const text = normalizeText(value);
  if (!text) return new Set();
  const keys = new Set();
  for (const structure of FINE_STRUCTURE_ALIASES) {
    if (structure.aliases.some((alias) => aliasMatchesText(text, alias))) {
      keys.add(structure.key);
    }
  }
  return keys;
}

function fineStructureKeysForImage(image = {}) {
  return collectFineStructureKeys([
    image.sectionKey,
    image.section,
    image.label,
    image.coverage,
    image.regions,
    image.regionLabels,
    image.source,
  ].filter(Boolean).flat().join(' '));
}

function fineStructureMatchScore(image = {}, paragraphText = '', meta = {}) {
  const requested = collectFineStructureKeys([
    meta.section_key,
    meta.sectionKey,
    meta.section_label,
    meta.sectionLabel,
    meta.displayLabel,
    meta.label,
    paragraphText,
  ].filter(Boolean).join(' '));
  if (!requested.size) return 0;
  const imageKeys = fineStructureKeysForImage(image);
  let score = 0;
  for (const key of requested) {
    if (imageKeys.has(key)) score += 48;
  }
  const requestsDevice = [...requested].some((key) => DEVICE_STRUCTURE_KEYS.has(key));
  const imageIsDeviceHeavy = [...imageKeys].some((key) => DEVICE_STRUCTURE_KEYS.has(key));
  if (imageIsDeviceHeavy && !requestsDevice) score -= 55;
  if (requestsDevice && imageIsDeviceHeavy) score += 18;
  if (score > 0) return score + Math.min(18, imageKeys.size * 3);
  return -12;
}

function reviewScopeFromPayload(payload = {}) {
  const raw = normalizeText([
    payload.reviewType,
    payload.review_type,
    payload.title,
    payload.kind,
  ].filter(Boolean).join(' '));
  if (/\b(pelvic|genital|pubic|perineum|perineal|foley|catheter|meatus|glans|scrotum)\b/i.test(raw)) {
    return 'pelvic_genital';
  }
  return 'head_to_toe';
}

function pelvicGenitalRegionFromText(meta = {}, paragraphText = '') {
  const text = normalizeText([
    meta.section_key,
    meta.sectionKey,
    meta.section_label,
    meta.sectionLabel,
    meta.displayLabel,
    meta.label,
    paragraphText,
  ].filter(Boolean).join(' '));
  if (/\b(anal|anus|perianal|rectal|buttock|buttocks|gluteal)\b/i.test(text)) return 'buttocks_perianal';
  if (/\b(penis|penile|glans|meatus|foreskin|shaft|scrotum|testes|testicle|perineum|perineal|foley|catheter|urethra|urethral)\b/i.test(text)) return 'genitals_perineum';
  if (/\b(pelvis|pelvic|pubic|inguinal|groin|statlock|penile base|lower abdomen)\b/i.test(text)) return 'pelvis_pubic_region';
  return 'pelvis_pubic_region';
}

function constrainRegionForReview(regionKey = '', meta = {}, paragraphText = '', reviewScope = '') {
  if (reviewScope !== 'pelvic_genital') return regionKey;
  if (regionKey && PELVIC_GENITAL_REVIEW_ALLOWED_REGIONS.has(regionKey)) return regionKey;
  return pelvicGenitalRegionFromText(meta, paragraphText);
}

function sectionRegionResolutionFromMeta(meta = {}, paragraphText = '', reviewScope = '') {
  const explicitKey = normalizeText(meta.section_key || meta.sectionKey || '').replace(/\s+/g, '_');
  const paragraphRegion = sectionRegionKeyFromText(paragraphText);
  if (MIXED_SECTION_KEYS.has(explicitKey)) {
    const rawKey = paragraphRegion || 'overview';
    return {
      key: constrainRegionForReview(rawKey, meta, paragraphText, reviewScope),
      source: paragraphRegion ? 'paragraph_text_in_mixed_section' : 'mixed_section_overview',
    };
  }
  if ((meta.type === 'section-title' || meta.type === 'title') && SECTION_KEY_REGION_MAP.has(explicitKey)) {
    const rawKey = SECTION_KEY_REGION_MAP.get(explicitKey);
    return { key: constrainRegionForReview(rawKey, meta, paragraphText, reviewScope), source: 'section_title_key' };
  }
  if (SECTION_KEY_REGION_MAP.has(explicitKey)) {
    const rawKey = SECTION_KEY_REGION_MAP.get(explicitKey);
    return { key: constrainRegionForReview(rawKey, meta, paragraphText, reviewScope), source: 'section_key' };
  }
  const explicitLabel = sectionRegionKeyFromText([
    meta.section_label,
    meta.sectionLabel,
    meta.displayLabel,
    meta.label,
  ].filter(Boolean).join(' '));
  if (explicitLabel) {
    return { key: constrainRegionForReview(explicitLabel, meta, paragraphText, reviewScope), source: 'section_label' };
  }
  return {
    key: constrainRegionForReview(paragraphRegion, meta, paragraphText, reviewScope),
    source: paragraphRegion ? 'paragraph_text' : 'unresolved',
  };
}

function sectionRegionKeyFromMeta(meta = {}, paragraphText = '') {
  return sectionRegionResolutionFromMeta(meta, paragraphText).key;
}

function regionKeysForImage(image = {}) {
  const keys = new Set();
  const negatedKeys = new Set();
  const textFields = {
    label: image.label,
    coverage: image.coverage,
    meta: [
      image.section,
      image.regions,
      image.regionLabels,
      image.source,
    ].filter(Boolean).flat().join(' '),
  };
  for (const key of collectRegionKeys(textFields.label)) keys.add(key);
  for (const key of collectRegionKeys(textFields.coverage)) keys.add(key);
  for (const key of collectRegionKeys(textFields.meta)) keys.add(key);
  for (const [key, pattern] of NEGATED_REGION_PATTERNS) {
    if (pattern.test(String(textFields.label || '')) || pattern.test(String(textFields.coverage || '')) || pattern.test(String(textFields.meta || ''))) {
      negatedKeys.add(key);
    }
  }
  const sectionKey = normalizeText(image.sectionKey || '').replace(/\s+/g, '_');
  if (SECTION_KEY_REGION_MAP.has(sectionKey) && !IMAGE_SECTION_KEYS_WITHOUT_REGION_AUTHORITY.has(sectionKey)) {
    keys.add(SECTION_KEY_REGION_MAP.get(sectionKey));
  }
  for (const label of image.regionLabels || []) {
    const key = normalizeText(label).replace(/\s+/g, '_');
    if (SECTION_KEY_REGION_MAP.has(key)) keys.add(SECTION_KEY_REGION_MAP.get(key));
  }
  for (const key of negatedKeys) keys.delete(key);
  return keys;
}

function isBroadBodyReference(image = {}) {
  const haystack = normalizeText([
    image.label,
    image.section,
    image.coverage,
    image.regions,
    image.regionLabels,
  ].filter(Boolean).flat().join(' '));
  return /\b(full body|whole body|head to feet|head-to-toe|crown to feet|full anterior|full posterior|full right lateral|full left lateral|lithotomy-adjacent|wide overhead)\b/i.test(haystack);
}

function isHeadToToeOverviewImageAllowed(image = {}) {
  const keys = regionKeysForImage(image);
  if (!keys.size) return false;
  if (isBroadBodyReference(image) || keys.has('posture_alignment')) return true;
  if ([...keys].some((key) => HEAD_TO_TOE_OVERVIEW_FORBIDDEN_CLOSEUP_REGIONS.has(key))) return false;
  return [...keys].some((key) => HEAD_TO_TOE_OVERVIEW_ALLOWED_REGIONS.has(key));
}

function allowsRegionCropFallback(targetKey, imageKeys = new Set(), image = {}) {
  if (!targetKey || targetKey === 'overview') return false;
  if (!imageKeys.has(targetKey)) return false;
  if (!imageKeys.has('posture_alignment') && !isBroadBodyReference(image)) return false;
  return new Set([
    'head_face',
    'neck',
    'shoulders_upper_back',
    'chest',
    'abdomen',
    'upper_limbs_hands',
    'lower_limbs',
    'feet_toes',
    'posture_alignment',
  ]).has(targetKey);
}

function isHardMismatch(targetKey, imageKeys = new Set()) {
  if (!targetKey || !imageKeys?.size) return false;
  const blocked = HARD_MISMATCH_GROUPS.get(targetKey);
  if (!blocked) return false;
  for (const key of imageKeys) {
    if (blocked.has(key)) return true;
  }
  return false;
}

function scoreImageForSection(image, targetKey, meta = {}, paragraphText = '') {
  if (!targetKey || targetKey === 'overview') return 0;
  const imageKeys = regionKeysForImage(image);
  const cropFallback = allowsRegionCropFallback(targetKey, imageKeys, image);
  if (isHardMismatch(targetKey, imageKeys) && !cropFallback) return -1000;
  const allowed = STRICT_ALLOWED_IMAGE_REGIONS.get(targetKey);
  const hasAllowedRegion = allowed?.size ? [...imageKeys].some((key) => allowed.has(key)) : false;
  if (!hasAllowedRegion) return -1000;
  const forbidden = STRICT_FORBIDDEN_IMAGE_REGIONS.get(targetKey);
  if (forbidden && [...imageKeys].some((key) => forbidden.has(key)) && !cropFallback) return -1000;
  let score = imageKeys.has(targetKey) ? (cropFallback ? 78 : 100) : 0;
  const haystack = normalizeText([
    image.sectionKey,
    image.section,
    image.label,
    image.coverage,
    image.regions,
    image.regionLabels,
  ].filter(Boolean).flat().join(' '));
  const sectionNeedles = [
    meta.section_key,
    meta.sectionKey,
    meta.section_label,
    meta.sectionLabel,
    meta.displayLabel,
    paragraphText,
  ].map(normalizeText).filter(Boolean);
  for (const needle of sectionNeedles) {
    if (needle.length >= 4 && haystack.includes(needle.slice(0, 80))) score += 20;
  }
  score += fineStructureMatchScore(image, paragraphText, meta);
  const requestedFineKeys = collectFineStructureKeys(sectionNeedles.join(' '));
  const imageFineKeys = fineStructureKeysForImage(image);
  const requestsDevice = [...requestedFineKeys].some((key) => DEVICE_STRUCTURE_KEYS.has(key));
  const imageIsDeviceHeavy = [...imageFineKeys].some((key) => DEVICE_STRUCTURE_KEYS.has(key));
  if (PELVIC_GENITAL_REVIEW_ALLOWED_REGIONS.has(targetKey) && imageIsDeviceHeavy && !requestsDevice) score -= 35;
  if (imageKeys.has('skin_summary') && ['abdomen', 'lower_limbs', 'feet_toes'].includes(targetKey)) score += 8;
  if (imageKeys.has('posture_alignment') && targetKey === 'posture_alignment') score += 30;
  return score;
}

function isImageAllowedForReviewScope(image, reviewScope = '') {
  if (reviewScope !== 'pelvic_genital') return true;
  const keys = regionKeysForImage(image);
  if (![...keys].some((key) => PELVIC_GENITAL_REVIEW_ALLOWED_REGIONS.has(key))) return false;
  if ([...keys].some((key) => PELVIC_GENITAL_REVIEW_FORBIDDEN_REGIONS.has(key))) return false;
  return true;
}

function scoreImageForReviewFallback(image, targetKey, meta = {}, paragraphText = '', reviewScope = '') {
  if (!isImageAllowedForReviewScope(image, reviewScope)) return -1000;
  const score = scoreImageForSection(image, targetKey, meta, paragraphText);
  if (score > 0) return score;
  if (reviewScope !== 'pelvic_genital') return score;
  const keys = regionKeysForImage(image);
  const allowed = STRICT_ALLOWED_IMAGE_REGIONS.get(targetKey);
  if (!allowed?.size || ![...keys].some((key) => allowed.has(key))) return -1000;
  if (keys.has(targetKey)) return 80;
  if (targetKey === 'genitals_perineum' && keys.has('pelvis_pubic_region')) return 52;
  if (targetKey === 'pelvis_pubic_region' && keys.has('genitals_perineum')) return 48;
  if (targetKey === 'buttocks_perianal' && (keys.has('genitals_perineum') || keys.has('pelvis_pubic_region'))) return 35;
  return 25;
}

function imageRegionTrace(image = {}) {
  const keys = [...regionKeysForImage(image)];
  return {
    id: image.id || null,
    label: image.label || null,
    section: image.section || null,
    sectionKey: image.sectionKey || null,
    tags: keys,
    coverage: image.coverage || null,
    source: image.source || null,
  };
}

function textPreview(value = '', maxLength = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function candidateTrace(images = [], targetKey, meta = {}, paragraphText = '', reviewScope = '') {
  return images.map((image) => ({
    ...imageRegionTrace(image),
    score: scoreImageForReviewFallback(image, targetKey, meta, paragraphText, reviewScope),
    review_scope_allowed: isImageAllowedForReviewScope(image, reviewScope),
  }));
}

function scoreOverviewImage(image = {}, reviewScope = '') {
  if (!isImageAllowedForReviewScope(image, reviewScope)) return -1000;
  if (reviewScope !== 'pelvic_genital' && !isHeadToToeOverviewImageAllowed(image)) return -1000;
  const keys = regionKeysForImage(image);
  const fineKeys = fineStructureKeysForImage(image);
  let score = 45;
  if (reviewScope === 'pelvic_genital') {
    if (keys.has('genitals_perineum')) score += 40;
    if (keys.has('pelvis_pubic_region')) score += 28;
    if (keys.has('buttocks_perianal')) score += 24;
  } else {
    if (isBroadBodyReference(image)) score += 90;
    if (keys.has('posture_alignment')) score += 60;
    if (keys.has('head_face') || keys.has('chest') || keys.has('abdomen') || keys.has('lower_limbs') || keys.has('feet_toes')) score += 18;
    if (keys.has('upper_limbs_hands') || keys.has('shoulders_upper_back') || keys.has('skin_summary')) score += 12;
  }
  if ([...fineKeys].some((key) => DEVICE_STRUCTURE_KEYS.has(key))) score -= 45;
  return score;
}

function overviewCandidateTrace(images = [], reviewScope = '') {
  return images.map((image) => ({
    ...imageRegionTrace(image),
    score: scoreOverviewImage(image, reviewScope),
    review_scope_allowed: isImageAllowedForReviewScope(image, reviewScope),
  }));
}

function isImageAllowedForRegion(image, targetKey, reviewScope = '') {
  if (!image || !targetKey) return false;
  if (!isImageAllowedForReviewScope(image, reviewScope)) return false;
  if (targetKey === 'overview') {
    return reviewScope === 'pelvic_genital' ? true : isHeadToToeOverviewImageAllowed(image);
  }
  const keys = regionKeysForImage(image);
  const allowed = STRICT_ALLOWED_IMAGE_REGIONS.get(targetKey);
  if (!allowed?.size) return false;
  const hasAllowed = [...keys].some((key) => allowed.has(key));
  if (!hasAllowed) return false;
  const forbidden = STRICT_FORBIDDEN_IMAGE_REGIONS.get(targetKey);
  if (forbidden && [...keys].some((key) => forbidden.has(key)) && !allowsRegionCropFallback(targetKey, keys, image)) return false;
  return true;
}

function traceLine(trace = {}) {
  const candidates = (trace.candidates || []).map((candidate) => (
    `${candidate.id || 'unknown'} tags=[${(candidate.tags || []).join(', ') || 'none'}] score=${candidate.score} label="${candidate.label || ''}"`
  )).join('\n  ');
  return [
    'VIDEO REGION TRACE',
    `Narration Section: ${trace.sectionLabel || trace.targetRegion || 'Unknown'}`,
    `Narration Preview: ${trace.paragraphPreview || ''}`,
    `Resolved From: ${trace.resolvedFrom || 'unknown'}`,
    `Review Scope: ${trace.reviewScope || 'head_to_toe'}`,
    `Allowed Regions: ${(trace.allowedRegions || []).join(', ') || 'none/title-card'}`,
    `Candidate Images:\n  ${candidates || 'none'}`,
    `Selected Image: ${trace.selectedImage?.id || 'section title card'}${trace.selectedImage?.path ? ` (${trace.selectedImage.path})` : ''}`,
    `Selection Reason: ${trace.selectionReason || ''}`,
  ].join('\n');
}

function displayLabelForMeta(meta = {}, paragraphText = '') {
  return String(meta.section_label || meta.sectionLabel || meta.displayLabel || meta.label || paragraphText || 'Profile Anatomy').trim();
}

function safeDrawText(value = '') {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\n/g, ' ')
    .slice(0, 96);
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function mediaDurationSeconds(filePath) {
  const { stdout } = await runProcess('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const value = Number.parseFloat(String(stdout || '').trim());
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function matchAudioExport(record, request) {
  if (!record?.file_url) return false;
  if (record.render_version !== 'tts_export_leading_trim_v2') return false;
  if (String(record.tts_session_key || '') !== String(request.sessionId || '')) return false;
  if (String(record.source_generated_at || '') !== String(request.sourceGeneratedAt || '')) return false;
  if (String(record.voice || 'nova') !== String(request.voice || 'nova')) return false;
  if (String(record.model || '') !== String(request.model || '')) return false;
  if (String(record.format || 'mp3') !== String(request.outputFormat || 'mp3')) return false;
  return Math.abs(Number(record.speed || 1) - Number(request.speed || 1)) < 0.005;
}

async function resolveNarration(payload, { jobId, signal, onProgress }) {
  const request = {
    sessionId: payload.sessionId,
    title: payload.title || 'Profile Anatomy Video',
    sourceGeneratedAt: payload.sourceGeneratedAt || null,
    voice: payload.voice || 'nova',
    model: payload.model,
    speed: payload.speed,
    outputFormat: payload.outputFormat || 'mp3',
  };

  const existing = listEntities('AudioExport')
    .filter((record) => matchAudioExport(record, request))
    .sort((a, b) => String(b.created_date || '').localeCompare(String(a.created_date || '')))[0];
  const existingPath = uploadPathFromUrl(existing?.file_url);
  if (existing && await fileExists(existingPath)) {
    onProgress?.({
      phase: 'narration',
      current: 1,
      total: 5,
      message: 'Reusing matching anatomy narration export...',
      audio_file_url: existing.file_url,
    });
    return { reused: true, audioPath: existingPath, rendered: existing };
  }

  onProgress?.({
    phase: 'narration',
    current: 1,
    total: 5,
    message: 'Rendering anatomy narration...',
  });
  const rendered = await renderTTSExport({
    title: request.title,
    chunks: payload.chunks || [],
    chapters: payload.chapters || [],
    voice: request.voice,
    model: request.model,
    speed: request.speed,
    instructions: payload.instructions || '',
    outputFormat: request.outputFormat,
    normalize: Boolean(payload.normalize),
  }, {
    jobId: `${jobId}-audio`,
    signal,
    onProgress: (progress) => onProgress?.({
      ...progress,
      phase: `narration_${progress?.phase || 'rendering'}`,
      message: `Narration: ${progress?.message || 'rendering...'}`,
    }),
  });
  const audioPath = uploadPathFromUrl(rendered.file_url);
  const savedAudio = upsertEntity('AudioExport', crypto.randomUUID(), {
    title: request.title,
    file_url: rendered.file_url,
    duration_seconds: Math.round(rendered.duration_seconds || 0),
    voice: rendered.voice || request.voice,
    speed: rendered.speed || request.speed,
    model: rendered.model || request.model,
    format: rendered.format || request.outputFormat,
    render_version: rendered.render_version || 'tts_export_leading_trim_v2',
    silence_trim: rendered.silence_trim || null,
    size: rendered.size,
    filename: rendered.filename,
    tts_session_key: request.sessionId || null,
    analysis_title: request.title,
    source_generated_at: request.sourceGeneratedAt,
    exported_at: new Date().toISOString(),
    has_chapters: Boolean(rendered.has_chapters),
    chapter_format: rendered.chapter_format || 'sidecar',
    chapter_count: Number(rendered.chapter_count || 0),
    chapter_source: rendered.chapter_source || 'tts_export',
    chapter_generated_at: rendered.chapter_generated_at || null,
    chapters_embedded: Boolean(rendered.chapters_embedded),
    sidecar_chapters_available: Boolean(rendered.sidecar_chapters_available),
    chapter_json_url: rendered.chapter_json_url || null,
    chapter_cue_url: rendered.chapter_cue_url || null,
    chapter_txt_url: rendered.chapter_txt_url || null,
    audio_content_version: request.sourceGeneratedAt,
  });
  return { reused: false, audioPath, rendered: savedAudio };
}

function safeImageItems(images = []) {
  const seen = new Set();
  return (Array.isArray(images) ? images : [])
    .map((image, index) => ({
      id: image.image_id || image.id || `image-${index + 1}`,
      label: String(image.display_label || image.view_label || image.label || `Reference view ${index + 1}`).trim(),
      section: String(image.section_label || image.section || '').trim(),
      sectionKey: String(image.section_key || image.sectionKey || '').trim(),
      coverage: String(image.coverage || image.visibility_notes || '').trim(),
      regions: Array.isArray(image.regions) ? image.regions.map((item) => String(item || '').trim()).filter(Boolean) : [],
      regionLabels: Array.isArray(image.section_labels) ? image.section_labels.map((item) => String(item || '').trim()).filter(Boolean) : [],
      url: String(image.preview_url || image.previewUrl || image.url || image.storagePath || '').trim(),
      source: String(image.source || '').trim(),
    }))
    .filter((image) => {
      if (!image.url) return false;
      const key = image.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 300);
}

function archiveEntryResult(entryOrResult) {
  return entryOrResult?.result || entryOrResult || null;
}

function reviewKeysForPayload(payload = {}) {
  const raw = String(payload.reviewType || payload.review_type || payload.title || '').toLowerCase();
  if (/pelvic|genital|pubic|perine/i.test(raw)) {
    return {
      resultKey: 'pelvic_genital_image_review_result',
      archiveKey: 'pelvic_genital_image_review_archive',
    };
  }
  return {
    resultKey: 'head_to_toe_image_review_result',
    archiveKey: 'head_to_toe_image_review_archive',
  };
}

function savedProfileAttachmentImagesFromUsers() {
  const users = listEntities('User');
  const out = [];
  for (const user of users) {
    const messages = Array.isArray(user?.profile_chat_messages) ? user.profile_chat_messages : [];
    for (const [messageIndex, message] of messages.entries()) {
      const attachments = Array.isArray(message?.imageAttachments) ? message.imageAttachments : [];
      const reply = messages.slice(messageIndex + 1).find((candidate) => candidate?.role !== 'user' && String(candidate?.text || '').trim());
      for (const attachment of attachments) {
        if (attachment?.sourceVideo) continue;
        const url = String(attachment.previewUrl || attachment.storagePath || attachment.url || '').trim();
        if (!url) continue;
        out.push({
          image_id: `profile_qa_${attachment.id || out.length + 1}`,
          display_label: attachment.filename || 'Saved Profile Q&A image',
          preview_url: url,
          source: 'saved_profile_qa_attachment',
          coverage: [message?.text, reply?.text].filter(Boolean).join('. '),
        });
      }
    }
  }
  return out;
}

function reviewedImagesFromResult(result = {}, prefix = 'archive') {
  const reviewed = Array.isArray(result?._meta?.reviewed_images) ? result._meta.reviewed_images : [];
  const annotated = Array.isArray(result?.annotated_images) ? result.annotated_images : [];
  return reviewed
    .map((image, index) => {
      const originalId = image?.image_id || `img_${index + 1}`;
      const annotation = annotated.find((item) => item?.image_id === originalId) || {};
      const url = String(image?.preview_url || annotation?.preview_url || '').trim();
      if (!url) return null;
      return {
        image_id: `${prefix}_${String(originalId).replace(/[^a-z0-9_-]+/gi, '_')}_${index + 1}`,
        display_label: annotation.view_label || image.display_label || `Archived profile image ${index + 1}`,
        section_key: annotation.section_key || '',
        section_label: annotation.section_label || '',
        section_labels: Array.isArray(annotation.section_labels) ? annotation.section_labels : [],
        regions: [],
        coverage: [
          image.upload_note,
          annotation.view_label,
          annotation.coverage,
          annotation.visibility_notes,
          Array.isArray(annotation.major_regions_visible) ? annotation.major_regions_visible.join(', ') : '',
          image.source_video?.purpose,
          image.source_video?.note,
        ].filter(Boolean).join('. '),
        preview_url: url,
        source: image.source_video ? 'profile_review_archive_video_frame' : 'profile_review_archive',
      };
    })
    .filter(Boolean);
}

function profilerArchiveImagesForPayload(payload = {}) {
  const { resultKey, archiveKey } = reviewKeysForPayload(payload);
  const rows = listEntities('SessionClusterAnalysis')
    .sort((a, b) => String(b.updated_date || '').localeCompare(String(a.updated_date || '')));
  const out = [];
  for (const row of rows) {
    out.push(...reviewedImagesFromResult(row?.[resultKey], `current_${resultKey}`));
    const archive = Array.isArray(row?.[archiveKey]) ? row[archiveKey] : [];
    archive.forEach((entry, archiveIndex) => {
      out.push(...reviewedImagesFromResult(
        archiveEntryResult(entry),
        `archive_${archiveIndex + 1}_${archiveKey}`
      ));
    });
  }
  return out;
}

function augmentAnatomyImagesFromDatabase(payload = {}, initialImages = []) {
  const merged = [];
  const seen = new Set();
  const add = (image) => {
    const url = String(image?.preview_url || image?.previewUrl || image?.url || image?.storagePath || '').trim();
    if (!url) return;
    const key = url || image.image_id || image.id;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(image);
  };
  (Array.isArray(initialImages) ? initialImages : []).forEach(add);
  profilerArchiveImagesForPayload(payload).forEach(add);
  savedProfileAttachmentImagesFromUsers().forEach(add);
  return merged.slice(0, 140);
}

async function resolveImageToFile(image, workDir, index) {
  const rawUrl = String(image.url || '').trim();
  const uploadPath = uploadPathFromUrl(rawUrl);
  if (uploadPath && await fileExists(uploadPath)) return uploadPath;

  const dataMatch = rawUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  const output = path.join(workDir, `source-${String(index + 1).padStart(3, '0')}.jpg`);
  if (dataMatch) {
    await fs.writeFile(output, Buffer.from(dataMatch[2], 'base64'));
    return output;
  }

  if (/^https?:\/\//i.test(rawUrl)) {
    const response = await fetch(rawUrl);
    if (!response.ok) throw new Error(`Could not load image ${image.label || index + 1}: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(output, buffer);
    return output;
  }

  throw new Error(`Image ${image.label || index + 1} is not available to the renderer.`);
}

function cropAnchorForRegion(targetKey = '') {
  switch (targetKey) {
    case 'head_face':
      return { x: '(iw-ow)/2', y: '0' };
    case 'neck':
    case 'shoulders_upper_back':
    case 'chest':
      return { x: '(iw-ow)/2', y: '(ih-oh)*0.08' };
    case 'abdomen':
      return { x: '(iw-ow)/2', y: '(ih-oh)*0.32' };
    case 'pelvis_pubic_region':
    case 'genitals_perineum':
    case 'buttocks_perianal':
      return { x: '(iw-ow)/2', y: '(ih-oh)*0.48' };
    case 'lower_limbs':
      return { x: '(iw-ow)/2', y: '(ih-oh)*0.68' };
    case 'feet_toes':
      return { x: '(iw-ow)/2', y: 'ih-oh' };
    default:
      return { x: '(iw-ow)/2', y: '(ih-oh)/2' };
  }
}

async function renderImageSegment({ imagePath, outputPath, durationSeconds, index, targetKey }) {
  const frames = Math.max(1, Math.round(durationSeconds * VIDEO_FPS));
  const zoomDirection = index % 2 === 0 ? 'in' : 'out';
  const zoomExpr = zoomDirection === 'in'
    ? `min(1.10,1.0+0.10*on/${frames})`
    : `max(1.0,1.10-0.10*on/${frames})`;
  const cropAnchor = cropAnchorForRegion(targetKey);
  const fade = Math.min(0.28, Math.max(0, (durationSeconds - 0.6) / 2));
  const fadeFilters = fade
    ? `,fade=t=in:st=0:d=${fade.toFixed(2)},fade=t=out:st=${Math.max(0, durationSeconds - fade).toFixed(2)}:d=${fade.toFixed(2)}`
    : '';
  const vf = [
    `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:${cropAnchor.x}:${cropAnchor.y}`,
    `zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${VIDEO_FPS}`,
    `format=yuv420p${fadeFilters}`,
  ].join(',');

  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-i', imagePath,
    '-vf', vf,
    '-an',
    '-c:v', 'libx264',
    '-preset', VIDEO_PRESET,
    '-crf', VIDEO_CRF,
    '-pix_fmt', 'yuv420p',
    outputPath,
  ]);
}

async function renderSectionCardSegment({ outputPath, durationSeconds, label, index }) {
  const fade = Math.min(0.25, Math.max(0, (durationSeconds - 0.4) / 2));
  const fadeFilters = fade
    ? `,fade=t=in:st=0:d=${fade.toFixed(2)},fade=t=out:st=${Math.max(0, durationSeconds - fade).toFixed(2)}:d=${fade.toFixed(2)}`
    : '';
  const fontPath = 'C:/Windows/Fonts/arial.ttf';
  const fontFilterPath = 'C\\:/Windows/Fonts/arial.ttf';
  const drawText = await fileExists(fontPath)
    ? `,drawtext=fontfile='${fontFilterPath}':text='${safeDrawText(label || 'Profile Anatomy')}':fontsize=58:fontcolor=0xf8fafc:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=0x0b1020@0.78:boxborderw=32`
    : '';
  const vf = [
    `format=yuv420p`,
    `drawbox=x=0:y=0:w=iw:h=ih:color=0x10141f@1:t=fill`,
    `drawbox=x=160:y=430:w=1600:h=220:color=0x172033@1:t=fill`,
    `drawbox=x=160:y=430:w=1600:h=220:color=0x5eead4@0.35:t=4${drawText}`,
    `format=yuv420p${fadeFilters}`,
  ].join(',');

  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=0x10141f:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:r=${VIDEO_FPS}:d=${durationSeconds.toFixed(3)}`,
    '-vf', vf,
    '-an',
    '-c:v', 'libx264',
    '-preset', VIDEO_PRESET,
    '-crf', VIDEO_CRF,
    '-pix_fmt', 'yuv420p',
    outputPath,
  ]);
}

function buildNarrationVisualTimeline({ paragraphs = [], paragraphMeta = [], images = [], audioDuration = 0, reviewScope = '' }) {
  const items = (Array.isArray(paragraphs) ? paragraphs : [])
    .map((text, index) => ({
      text: String(text || '').trim(),
      meta: paragraphMeta[index] || {},
    }))
    .filter((item) => item.text);

  if (!items.length) {
    return [{
      type: 'card',
      image: null,
      durationSeconds: Math.max(MIN_SEGMENT_SECONDS, audioDuration || MIN_SEGMENT_SECONDS),
      label: 'Profile Anatomy',
      targetKey: 'overview',
      score: 0,
      selectionReason: 'No paragraph metadata was supplied; refusing to cycle unrelated anatomy images.',
      trace: {
        sectionLabel: 'Profile Anatomy',
        targetRegion: 'overview',
        allowedRegions: [],
        candidates: images.map((image) => ({ ...imageRegionTrace(image), score: 0 })),
        selectedImage: null,
        selectionReason: 'No paragraph metadata was supplied; title card selected.',
      },
    }];
  }

  const weights = items.map((item) => Math.max(80, Math.min(900, item.text.length)));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  const rawDurations = weights.map((weight) => Math.max(MIN_PARAGRAPH_SEGMENT_SECONDS, (audioDuration || items.length * 4) * (weight / totalWeight)));
  const durationScale = audioDuration > 0
    ? audioDuration / rawDurations.reduce((sum, value) => sum + value, 0)
    : 1;

  let lastByRegion = new Map();
  let lastInReviewScope = null;
  const recentImageIds = [];
  const imageUseCounts = new Map();
  return items.map((item, index) => {
    const regionResolution = sectionRegionResolutionFromMeta(item.meta, item.text, reviewScope);
    const targetKey = regionResolution.key;
    const label = displayLabelForMeta(item.meta, item.text);
    const candidates = targetKey === 'overview'
      ? overviewCandidateTrace(images, reviewScope)
      : candidateTrace(images, targetKey, item.meta, item.text, reviewScope);
    const ranked = candidates
      .map((candidate) => ({
        image: images.find((image) => image.id === candidate.id),
        score: candidate.score,
        candidate,
      }))
      .filter((entry) => entry.image && entry.score > 0)
      .map((entry) => {
        const imageId = entry.image?.id || entry.candidate?.id || '';
        const recentIndex = imageId ? recentImageIds.indexOf(imageId) : -1;
        const recentPenalty = recentIndex >= 0 ? Math.max(36, 92 - recentIndex * 18) : 0;
        const usagePenalty = imageId ? (imageUseCounts.get(imageId) || 0) * 42 : 0;
        const repeatPenalty = recentPenalty + usagePenalty;
        return {
          ...entry,
          adjustedScore: entry.score - repeatPenalty,
          repeatPenalty,
        };
      })
      .sort((a, b) => b.adjustedScore - a.adjustedScore || b.score - a.score);
    const best = ranked.find((entry) => entry.adjustedScore > 0) || (ranked.length === 1 ? ranked[0] : null);
    const last = targetKey && targetKey !== 'overview' ? lastByRegion.get(targetKey) : null;
    const reviewScopeFallback = reviewScope === 'pelvic_genital' && lastInReviewScope && isImageAllowedForRegion(lastInReviewScope, targetKey, reviewScope)
      ? lastInReviewScope
      : null;
    const selected = best?.image
      || (last && isImageAllowedForRegion(last, targetKey, reviewScope) ? last : null)
      || reviewScopeFallback;
    if (targetKey && targetKey !== 'overview' && selected && isImageAllowedForRegion(selected, targetKey, reviewScope)) {
      lastByRegion.set(targetKey, selected);
    }
    if (selected && isImageAllowedForReviewScope(selected, reviewScope)) {
      lastInReviewScope = selected;
    }
    if (selected?.id) {
      recentImageIds.unshift(selected.id);
      recentImageIds.splice(8);
      imageUseCounts.set(selected.id, (imageUseCounts.get(selected.id) || 0) + 1);
    }
    const selectedTrace = selected ? imageRegionTrace(selected) : null;
    const allowedRegions = [...(STRICT_ALLOWED_IMAGE_REGIONS.get(targetKey) || new Set())];
    const selectionReason = selected
      ? best?.image === selected
        ? `Selected highest scoring compatible image for ${REGION_LABELS.get(targetKey) || targetKey}.`
        : reviewScopeFallback === selected
          ? `Reused prior ${reviewScope.replace(/_/g, '/')} image; no exact section image was available, and unrelated anatomy fallback is disabled.`
          : `Reused previous compatible image for ${REGION_LABELS.get(targetKey) || targetKey}; no better current candidate was available.`
      : targetKey === 'overview'
        ? 'No representative library image was available for this overview/title segment; section card selected.'
        : `No compatible image found for ${REGION_LABELS.get(targetKey) || targetKey}; section card selected.`;
    const paragraphPreview = textPreview(item.text);
    return {
      type: selected ? 'image' : 'card',
      image: selected,
      durationSeconds: Math.max(0.5, rawDurations[index] * durationScale),
      label,
      targetKey,
      resolvedFrom: regionResolution.source,
      paragraphPreview,
      score: best?.adjustedScore ?? best?.score ?? 0,
      selectionReason,
      trace: {
        sectionLabel: label,
        paragraphPreview,
        resolvedFrom: regionResolution.source,
        reviewScope,
        targetRegion: targetKey,
        allowedRegions,
        candidates,
        selectedImage: selectedTrace,
        selectionReason,
      },
    };
  });
}

function validateVisualTimeline(visualTimeline = [], reviewScope = '') {
  const violations = [];
  for (const [index, item] of visualTimeline.entries()) {
    if (item.type !== 'image') continue;
    if (!isImageAllowedForRegion(item.image, item.targetKey, reviewScope)) {
      const imageTags = [...regionKeysForImage(item.image)];
      violations.push({
        index,
        target_region: item.targetKey || null,
        narration_section: item.label || null,
        image_id: item.image?.id || null,
        image_label: item.image?.label || null,
        image_tags: imageTags,
        allowed_regions: [...(STRICT_ALLOWED_IMAGE_REGIONS.get(item.targetKey) || new Set())],
        review_scope: reviewScope || null,
      });
    }
  }
  if (violations.length) {
    const error = new Error(`REGION VIOLATION DETECTED: anatomy video selected incompatible visual region at segment ${violations[0].index + 1}. Refusing to render wrong-body-region video.`);
    error.status = 422;
    error.regionViolations = violations;
    throw error;
  }
}

export async function renderProfileAnatomyVideo(payload = {}, options = {}) {
  let workDir = null;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const jobId = String(options.jobId || payload.jobId || crypto.randomUUID());
  const title = payload.title || 'Profile Anatomy Video';

  try {
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.mkdir(ttsRenderDir, { recursive: true });
    workDir = path.join(ttsRenderDir, `profile-video-${Date.now()}-${crypto.randomUUID()}`);
    await fs.mkdir(workDir, { recursive: true });

    const payloadImages = Array.isArray(payload.images) ? payload.images : [];
    const reviewScope = reviewScopeFromPayload(payload);
    const expandedImages = augmentAnatomyImagesFromDatabase(payload, payloadImages);
    const imageItems = safeImageItems(expandedImages);
    if (!imageItems.length) {
      const error = new Error('No review images are available for the anatomy video.');
      error.status = 400;
      throw error;
    }

    const narration = await resolveNarration(payload, { jobId, signal: options.signal, onProgress });
    if (options.signal?.aborted) throw new Error('Cancelled');
    const audioDuration = await mediaDurationSeconds(narration.audioPath);
    const visualTimeline = buildNarrationVisualTimeline({
      paragraphs: payload.paragraphs || [],
      paragraphMeta: payload.paragraphMeta || payload.paragraph_meta || [],
      images: imageItems,
      audioDuration,
      reviewScope,
    });
    validateVisualTimeline(visualTimeline, reviewScope);
    const totalSegments = visualTimeline.length;
    const regionTrace = visualTimeline.map((item, index) => ({
      segment: index + 1,
      type: item.type,
      target_region: item.targetKey || null,
      narration_section: item.label || null,
      narration_preview: item.paragraphPreview || null,
      resolved_from: item.resolvedFrom || null,
      review_scope: reviewScope,
      selected_image_id: item.image?.id || null,
      selected_image_label: item.image?.label || null,
      selected_image_tags: item.image ? [...regionKeysForImage(item.image)] : [],
      allowed_regions: [...(STRICT_ALLOWED_IMAGE_REGIONS.get(item.targetKey) || new Set())],
      selection_reason: item.selectionReason || '',
      candidates: item.trace?.candidates || [],
    }));
    onProgress({
      phase: 'visuals',
      current: 0,
      total: totalSegments,
      message: `Rendering ${totalSegments} section-matched anatomy visuals...`,
      image_count: imageItems.length,
      payload_image_count: payloadImages.length,
      database_augmented_image_count: Math.max(0, imageItems.length - payloadImages.length),
      review_scope: reviewScope,
      audio_duration_seconds: Math.round(audioDuration),
    });

    const segmentPaths = [];
    const visualSelections = [];
    for (let index = 0; index < visualTimeline.length; index += 1) {
      if (options.signal?.aborted) throw new Error('Cancelled');
      const item = visualTimeline[index];
      const segmentPath = path.join(workDir, `segment-${String(index + 1).padStart(4, '0')}.mp4`);
      if (item.type === 'image' && item.image) {
        const imagePath = await resolveImageToFile(item.image, workDir, index);
        if (item.trace?.selectedImage) item.trace.selectedImage.path = imagePath;
        if (regionTrace[index]) regionTrace[index].selected_file_path = imagePath;
        if (item.trace) console.info(traceLine(item.trace));
        await renderImageSegment({
          imagePath,
          outputPath: segmentPath,
          durationSeconds: item.durationSeconds,
          index,
          targetKey: item.targetKey,
        });
      } else {
        if (item.trace) console.info(traceLine(item.trace));
        await renderSectionCardSegment({
          outputPath: segmentPath,
          durationSeconds: item.durationSeconds,
          label: item.label,
          index,
        });
      }
      segmentPaths.push(segmentPath);
      visualSelections.push({
        type: item.type,
        target_region: item.targetKey || null,
        label: item.label || null,
        narration_preview: item.paragraphPreview || null,
        resolved_from: item.resolvedFrom || null,
        review_scope: reviewScope,
        duration_seconds: Number(item.durationSeconds.toFixed(3)),
        image_id: item.image?.id || null,
        image_label: item.image?.label || null,
        image_tags: item.image ? [...regionKeysForImage(item.image)] : [],
        allowed_regions: [...(STRICT_ALLOWED_IMAGE_REGIONS.get(item.targetKey) || new Set())],
        selection_reason: item.selectionReason || '',
        score: item.score || 0,
      });
      onProgress({
        phase: 'visuals',
        current: index + 1,
        total: totalSegments,
        message: `Rendered section-matched visual ${index + 1}/${totalSegments}...`,
      });
    }

    if (options.signal?.aborted) throw new Error('Cancelled');
    onProgress({
      phase: 'encoding',
      current: totalSegments,
      total: totalSegments,
      message: 'Combining anatomy visuals with narration...',
    });

    const concatPath = path.join(workDir, 'visuals.txt');
    await fs.writeFile(concatPath, segmentPaths.map((file) => `file ${q(file.replace(/\\/g, '/'))}`).join('\n'), 'utf8');
    const visualPath = path.join(workDir, 'visuals.mp4');
    await runProcess('ffmpeg', [
      '-hide_banner',
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatPath,
      '-c', 'copy',
      visualPath,
    ]);

    const outputBase = `${slugifyFilePart(title)}-${Date.now()}`;
    const filename = `${outputBase}.mp4`;
    const finalPath = path.join(uploadDir, filename);
    await runProcess('ffmpeg', [
      '-hide_banner',
      '-y',
      '-i', visualPath,
      '-i', narration.audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'libx264',
      '-preset', VIDEO_PRESET,
      '-crf', VIDEO_CRF,
      '-c:a', 'aac',
      '-b:a', '320k',
      '-shortest',
      '-movflags', '+faststart',
      finalPath,
    ]);

    const stat = await fs.stat(finalPath);
    const durationSeconds = Math.round(await mediaDurationSeconds(finalPath));
    return {
      ok: true,
      jobId,
      render_version: PROFILE_ANATOMY_VIDEO_RENDER_VERSION,
      file_url: `/uploads/${filename}`,
      filename,
      size: stat.size,
      duration_seconds: durationSeconds,
      audio_reused: narration.reused,
      audio_file_url: narration.rendered?.file_url || null,
      image_count: imageItems.length,
      payload_image_count: payloadImages.length,
      database_augmented_image_count: Math.max(0, imageItems.length - payloadImages.length),
      visual_segment_count: totalSegments,
      review_scope: reviewScope,
      source_images: imageItems.map((image) => ({
        id: image.id,
        label: image.label,
        section: image.section,
        source: image.source,
      })),
      visual_selections: visualSelections,
      region_trace: regionTrace,
      created_at: new Date().toISOString(),
    };
  } finally {
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
