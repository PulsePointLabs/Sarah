import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveUploadPath, uploadDir, ttsRenderDir } from '../config.js';
import { listEntities, listLatestProfileReviewEvidenceSlices, upsertEntity } from '../db.js';
import { renderTTSExport } from './ttsRenderer.js';
import { q, runProcess, slugifyFilePart } from './ttsCore.js';
import { resolveCachedFramePath } from './localVision/frameSampler.js';
import { normalizeWatermarkSettings, replaceVideoWithWatermarkedExport } from './watermark.js';

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
  { key: 'pubic_groin', aliases: ['pubic', 'pubic mound', 'inguinal', 'groin', 'lower abdomen', 'abdominal reference', 'penile base'] },
  { key: 'catheter_device', aliases: ['catheter', 'foley', 'statlock', 'device', 'tube', 'tubing', 'leg bag'] },
  { key: 'abdomen_bruise', aliases: ['abdomen', 'abdominal', 'bruise', 'bruising', 'bite', 'bite wound', 'ecchymosis'] },
  { key: 'feet_toes', aliases: ['foot', 'feet', 'toe', 'toes', 'ankle', 'heel'] },
  { key: 'chest', aliases: ['chest', 'thorax', 'pectoral', 'nipple', 'sternum'] },
  { key: 'face_head', aliases: ['head', 'face', 'scalp', 'beard', 'glasses'] },
  { key: 'ear', aliases: ['ear', 'ears', 'auricle', 'pinna'] },
  { key: 'eye', aliases: ['eye', 'eyes', 'eyelid', 'eyelids'] },
  { key: 'mouth', aliases: ['mouth', 'lip', 'lips', 'oral'] },
];

const DEVICE_STRUCTURE_KEYS = new Set(['catheter_device']);
const GENITAL_DETAIL_STRUCTURE_KEYS = new Set([
  'meatus',
  'glans',
  'foreskin',
  'shaft',
  'scrotum',
]);
const PUBIC_GROIN_STRUCTURE_KEYS = new Set(['pubic_groin']);
const STRICT_SECTION_SPECIFIC_KEYS = new Set([
  'meatus',
  'glans',
  'foreskin',
  'shaft',
  'scrotum',
  'pubic_groin',
  'perineum',
  'anal_perianal',
]);
const STRICT_FINE_STRUCTURE_MATCH_KEYS = new Set([
  'meatus',
  'glans',
  'foreskin',
  'shaft',
  'scrotum',
  'perineum',
  'anal_perianal',
  'pubic_groin',
  'catheter_device',
  'ear',
  'eye',
  'mouth',
]);
const DEVICE_AUTHORIZED_SECTION_KEYS = new Set([
  'device_contact_findings',
  'tissue_health_safety_observations',
]);
const DEVICE_AUTHORIZED_REGION_KEYS = new Set([
  'genitals_perineum',
  'pelvis_pubic_region',
]);

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

function pathnameFromUrl(fileUrl = '') {
  const raw = String(fileUrl || '').trim();
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).pathname;
  } catch {
    return raw;
  }
  return raw;
}

function uploadPathFromUrl(fileUrl = '') {
  const raw = pathnameFromUrl(fileUrl);
  if (!raw.startsWith('/uploads/')) return null;
  const filename = decodeURIComponent(raw.replace(/^\/uploads\//, ''));
  return resolveUploadPath(filename);
}

function localVisionFramePathFromUrl(fileUrl = '') {
  const raw = pathnameFromUrl(fileUrl);
  if (!raw.startsWith('/api/local-vision/frame/')) return null;
  const parts = raw
    .replace(/^\/api\/local-vision\/frame\//, '')
    .split('/')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  return resolveCachedFramePath(parts[0], parts[1], parts[2]);
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
    image.anatomy_labels,
    image.fine_structure_labels,
  ].filter(Boolean).flat().join(' '));
}

function isDeviceHeavyImage(image = {}) {
  const rawText = [
    image.sectionKey,
    image.section,
    image.label,
    image.coverage,
    image.regions,
    image.regionLabels,
    image.anatomy_labels,
    image.fine_structure_labels,
    image.source,
  ].filter(Boolean).flat().join(' ');
  const positiveDeviceText = normalizeText(rawText).replace(
    /\b(?:no|not|without|absent|lacks?)\s+(?:visible\s+|direct\s+|clear\s+|obvious\s+|active\s+){0,4}(?:foley|catheter|drainage\s*bag|leg\s*bag|urine|tube|tubing|statlock|device|procedure)(?:\s+(?:contact|visible|present|in\s+frame))?\b/gi,
    ' ',
  );
  const fineKeys = collectFineStructureKeys(positiveDeviceText);
  if ([...fineKeys].some((key) => DEVICE_STRUCTURE_KEYS.has(key))) return true;
  return /\b(foley|catheter|drainage\s*bag|leg\s*bag|urine|tubing|statlock|device|procedure)\b/i.test(positiveDeviceText);
}

function sectionRequestsDevice(meta = {}, paragraphText = '') {
  const sectionKey = normalizeText(meta.section_key || meta.sectionKey || meta.section?.key || '').replace(/\s+/g, '_');
  if (DEVICE_AUTHORIZED_SECTION_KEYS.has(sectionKey)) return true;
  const requested = collectFineStructureKeys([
    meta.section_label,
    meta.sectionLabel,
    meta.displayLabel,
    meta.label,
    paragraphText,
  ].filter(Boolean).join(' '));
  return [...requested].some((key) => DEVICE_STRUCTURE_KEYS.has(key));
}

function hasDirectRequestedAnatomyEvidence(image = {}, meta = {}, paragraphText = '') {
  const requested = requestedStrictFineStructureKeys(meta, paragraphText);
  const requestedAnatomy = [...requested].filter((key) => !DEVICE_STRUCTURE_KEYS.has(key));
  if (!requestedAnatomy.length) return false;
  if (requestedAnatomy.includes('pubic_groin') && !hasStrongPubicGroinEvidence(image)) return false;
  const available = directFineStructureKeysForImage(image);
  return requestedAnatomy.some((key) => available.has(key));
}

function requestedStrictFineStructureKeys(meta = {}, paragraphText = '') {
  const requested = collectFineStructureKeys([
    meta.section_key,
    meta.sectionKey,
    meta.section?.key,
    meta.section_label,
    meta.sectionLabel,
    meta.displayLabel,
    meta.label,
    paragraphText,
  ].filter(Boolean).join(' '));
  return new Set([...requested].filter((key) => STRICT_FINE_STRUCTURE_MATCH_KEYS.has(key)));
}

function requestedFineStructureText(meta = {}, paragraphText = '') {
  return normalizeText([
    meta.section_key,
    meta.sectionKey,
    meta.section?.key,
    meta.section_label,
    meta.sectionLabel,
    meta.displayLabel,
    meta.label,
    paragraphText,
  ].filter(Boolean).join(' '));
}

function imageFineStructureText(image = {}) {
  return normalizeText([
    image.label,
    image.display_label,
    image.coverage,
    image.source,
  ].filter(Boolean).flat().join(' '));
}

function imagePrimaryFineStructureText(image = {}) {
  return normalizeText([
    image.label,
    image.display_label,
  ].filter(Boolean).join(' '));
}

function directFineStructureKeysForImage(image = {}) {
  return collectFineStructureKeys(imagePrimaryFineStructureText(image));
}

const STRICT_STRUCTURE_PATTERNS = new Map([
  ['meatus', /\b(?:meatus|meatal|urethral\s+(?:opening|meatus|outlet))\b/i],
  ['glans', /\b(?:glans|corona|coronal\s+ridge)\b/i],
  ['foreskin', /\b(?:foreskin|prepuce|preputial)\b/i],
  ['shaft', /\b(?:penis|penile\s+shaft|shaft)\b/i],
  ['scrotum', /\b(?:scrotum|scrotal|testes|testicle|testicles)\b/i],
  ['pubic_groin', /\b(?:pubic(?:\s+mound|\s+region)?|suprapubic|inguinal|groin|lower\s+abdomen|abdominal\s+reference|penile\s+base)\b/i],
  ['perineum', /\b(?:perineum|perineal(?:\s+body)?)\b/i],
  ['anal_perianal', /\b(?:anal(?:\s+(?:opening|verge))?|anus|perianal|rectal)\b/i],
]);

function primaryStrictStructureKey(requestedText = '') {
  const text = normalizeText(requestedText);
  let best = null;
  for (const [key, pattern] of STRICT_STRUCTURE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (!best || match.index < best.index) best = { key, index: match.index };
  }
  return best?.key || '';
}

function hasStrongPubicGroinEvidence(image = {}) {
  const label = normalizeText([image.label, image.display_label].filter(Boolean).join(' '));
  const coverage = normalizeText(image.coverage || '');
  const patterns = [
    /\bpubic(?:\s+mound|\s+region|\s+base)?\b/i,
    /\bsuprapubic\b/i,
    /\binguinal(?:\s+folds?|\s+skin|\s+region)?\b/i,
    /\bgroin(?:\s+skin|\s+region)?\b/i,
    /\blower\s+abdomen\b/i,
    /\babdominal\s+reference\b/i,
    /\bpenile\s+base\b/i,
  ];
  if (patterns.some((pattern) => pattern.test(label))) return true;
  if (/\b(?:glans|meatus|foreskin|penile\s+shaft|scrotum|perineum|dilator|catheter|foley)\b/i.test(label)) return false;
  return patterns.filter((pattern) => pattern.test(coverage)).length >= 2;
}

function imageTextHasAny(text = '', patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

function imageMatchesStrictSectionSpecificRequest(image = {}, requestedKeys = new Set(), requestedText = '') {
  if (!requestedKeys.size) return true;
  const imageText = imageFineStructureText(image);
  const primaryText = imagePrimaryFineStructureText(image);
  const imageKeys = directFineStructureKeysForImage(image);
  const imageRegions = regionKeysForImage(image);
  const imageHasGenitalDetail = [...imageKeys].some((key) => GENITAL_DETAIL_STRUCTURE_KEYS.has(key));
  const primaryRequestedKey = primaryStrictStructureKey(requestedText);

  if (/\bpubic\s+mound\s+(?:and\s+)?lower\s+abdomen\b/i.test(requestedText)) {
    if (!/\b(?:pubic(?:\s+mound|\s+region)|suprapubic|lower\s+abdomen|abdominal\s+reference)\b/i.test(primaryText)) {
      return false;
    }
  }

  if (primaryRequestedKey && requestedKeys.has(primaryRequestedKey)) {
    const directPattern = STRICT_STRUCTURE_PATTERNS.get(primaryRequestedKey);
    if (!directPattern?.test(primaryText)) return false;
  }

  if (requestedKeys.has('pubic_groin') || /\b(pubic|pubic\s+mound|inguinal|groin|lower\s+abdomen|penile\s+base)\b/i.test(requestedText)) {
    const hasPubicGroinText = imageTextHasAny(imageText, [
      /\bpubic\b/i,
      /\bpubic\s+mound\b/i,
      /\binguinal\b/i,
      /\bgroin\b/i,
      /\blower\s+abdomen\b/i,
      /\babdominal\s+reference\b/i,
      /\bpenile\s+base\b/i,
      /\bsuprapubic\b/i,
    ]);
    if (!hasPubicGroinText && !imageKeys.has('pubic_groin') && !imageRegions.has('pelvis_pubic_region')) return false;
    if (imageHasGenitalDetail && !hasStrongPubicGroinEvidence(image)) return false;
  }

  if (requestedKeys.has('perineum') || /\bperineum|perineal|perineal\s+body\b/i.test(requestedText)) {
    const hasPerineumText = imageTextHasAny(imageText, [
      /\bperineum\b/i,
      /\bperineal\b/i,
      /\bperineal\s+body\b/i,
      /\bbetween\s+(?:scrotum|testes|testicles)\s+and\s+(?:anus|anal|perianal)\b/i,
    ]);
    if (!hasPerineumText && !imageKeys.has('perineum') && !imageRegions.has('buttocks_perianal')) return false;
    if (imageHasGenitalDetail && !hasPerineumText && !imageRegions.has('buttocks_perianal')) return false;
  }

  if (requestedKeys.has('anal_perianal') || /\b(?:anal|anus|perianal|rectal)\b/i.test(requestedText)) {
    const hasAnalText = imageTextHasAny(imageText, [
      /\banal\b/i,
      /\banus\b/i,
      /\bperianal\b/i,
      /\brectal\b/i,
    ]);
    if (!hasAnalText && !imageKeys.has('anal_perianal') && !imageRegions.has('buttocks_perianal')) return false;
    if (imageHasGenitalDetail && !hasAnalText && !imageRegions.has('buttocks_perianal')) return false;
  }

  return true;
}

function imageMatchesFineStructureRequest(image = {}, targetKey = '', meta = {}, paragraphText = '', reviewScope = '') {
  if (reviewScope !== 'pelvic_genital') return true;
  if (!PELVIC_GENITAL_REVIEW_ALLOWED_REGIONS.has(targetKey)) return true;
  const explicitSectionKey = normalizeText(meta.section_key || meta.sectionKey || meta.section?.key || '').replace(/\s+/g, '_');
  if (IMAGE_SECTION_KEYS_WITHOUT_REGION_AUTHORITY.has(explicitSectionKey)) return true;

  const requestedText = requestedFineStructureText(meta, paragraphText);
  const requestedKeys = requestedStrictFineStructureKeys(meta, paragraphText);
  const imageFineKeys = directFineStructureKeysForImage(image);
  const imageText = imageFineStructureText(image);
  const requestedPubicGroin = requestedKeys.has('pubic_groin')
    || /\b(pubic|pubic\s+mound|inguinal|groin|lower\s+abdomen|penile\s+base)\b/i.test(requestedText);
  const requestedGenitalDetail = [...requestedKeys].some((key) => GENITAL_DETAIL_STRUCTURE_KEYS.has(key));
  const imageHasPubicGroin = [...PUBIC_GROIN_STRUCTURE_KEYS].some((key) => imageFineKeys.has(key))
    || /\b(pubic|pubic\s+mound|inguinal|groin|lower\s+abdomen|penile\s+base)\b/i.test(imageText);
  const imageHasGenitalDetail = [...imageFineKeys].some((key) => GENITAL_DETAIL_STRUCTURE_KEYS.has(key));

  const strictSectionKeys = new Set([...requestedKeys].filter((key) => STRICT_SECTION_SPECIFIC_KEYS.has(key)));
  if (!imageMatchesStrictSectionSpecificRequest(image, strictSectionKeys, requestedText)) return false;

  if (requestedPubicGroin && !requestedGenitalDetail) {
    if (!imageHasPubicGroin) return false;
    if (imageHasGenitalDetail && !requestedGenitalDetail && !hasStrongPubicGroinEvidence(image)) return false;
  }

  if (targetKey === 'pelvis_pubic_region' && !requestedGenitalDetail && imageHasGenitalDetail && !imageHasPubicGroin) {
    return false;
  }

  if (requestedKeys.size && ![...requestedKeys].some((key) => imageFineKeys.has(key))) {
    return false;
  }

  return true;
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
  const imageKeys = directFineStructureKeysForImage(image);
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
  if (explicitKey === 'limitations_future_coverage') {
    return { key: 'overview', source: 'limitations_section_overview' };
  }
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
      image.anatomy_labels,
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
  if (
    keys.has('lower_limbs')
    && [...keys].some((key) => PELVIC_GENITAL_REVIEW_ALLOWED_REGIONS.has(key))
  ) {
    const allText = normalizeText([
      textFields.label,
      textFields.coverage,
      textFields.meta,
      image.sectionKey,
    ].filter(Boolean).join(' ')).replace(/\bleg\s+bag\b/g, ' ');
    const hasDistalLowerLimbEvidence = /\b(?:lower\s+limbs?|lower\s+extremit(?:y|ies)|lower\s+legs?|calves?|knees?|shins?|feet|foot|toes?|ankles?|heels?|plantar)\b/i.test(allText);
    if (!hasDistalLowerLimbEvidence) keys.delete('lower_limbs');
  }
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

function scoreImageForSection(image, targetKey, meta = {}, paragraphText = '', reviewScope = '') {
  if (!targetKey || targetKey === 'overview') return 0;
  if (!imageMatchesFineStructureRequest(image, targetKey, meta, paragraphText, reviewScope)) return -1000;
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
  const score = scoreImageForSection(image, targetKey, meta, paragraphText, reviewScope);
  if (score > 0) return score;
  if (reviewScope !== 'pelvic_genital') return score;
  if (!imageMatchesFineStructureRequest(image, targetKey, meta, paragraphText, reviewScope)) return -1000;
  const keys = regionKeysForImage(image);
  const allowed = STRICT_ALLOWED_IMAGE_REGIONS.get(targetKey);
  if (!allowed?.size || ![...keys].some((key) => allowed.has(key))) return -1000;
  if (keys.has(targetKey)) return 80;
  if (targetKey === 'buttocks_perianal' && (keys.has('genitals_perineum') || keys.has('pelvis_pubic_region'))) return 35;
  return -1000;
}

function fallbackScoreForSpecificSection(image, targetKey, meta = {}, paragraphText = '', reviewScope = '') {
  if (!image || !targetKey || targetKey === 'overview') return -1000;
  if (!isImageAllowedForReviewScope(image, reviewScope)) return -1000;
  if (!imageMatchesFineStructureRequest(image, targetKey, meta, paragraphText, reviewScope)) return -1000;
  if (
    isDeviceHeavyImage(image)
    && !sectionRequestsDevice(meta, paragraphText)
    && !hasDirectRequestedAnatomyEvidence(image, meta, paragraphText)
  ) return -1000;
  const keys = regionKeysForImage(image);
  const fineKeys = directFineStructureKeysForImage(image);
  const requestedText = requestedFineStructureText(meta, paragraphText);
  const requestedKeys = requestedStrictFineStructureKeys(meta, paragraphText);
  const hasGenitalDetail = [...fineKeys].some((key) => GENITAL_DETAIL_STRUCTURE_KEYS.has(key));

  if (requestedKeys.has('perineum') || /\b(?:perineum|perineal|perineal\s+body)\b/i.test(requestedText)) {
    if (keys.has('buttocks_perianal')) return 72;
    if (fineKeys.has('perineum')) return 68;
    if (keys.has('pelvis_pubic_region') && !hasGenitalDetail) return 36;
    return -1000;
  }

  if (requestedKeys.has('anal_perianal') || /\b(?:anal|anus|perianal|rectal)\b/i.test(requestedText)) {
    if (keys.has('buttocks_perianal')) return 74;
    if (fineKeys.has('anal_perianal')) return 70;
    return -1000;
  }

  if (requestedKeys.has('pubic_groin') || /\b(?:pubic|pubic\s+mound|suprapubic|inguinal|groin|lower\s+abdomen|penile\s+base)\b/i.test(requestedText)) {
    if (keys.has('pelvis_pubic_region')) return hasGenitalDetail ? 48 : 76;
    if (fineKeys.has('pubic_groin')) return 72;
    return -1000;
  }

  if (isImageAllowedForRegion(image, targetKey, reviewScope)) return 45;
  const allowed = STRICT_ALLOWED_IMAGE_REGIONS.get(targetKey);
  if (allowed?.size && [...keys].some((key) => allowed.has(key))) return 30;
  return -1000;
}

function bestSpecificSectionFallback(images = [], targetKey, meta = {}, paragraphText = '', reviewScope = '', usedIds = new Map()) {
  return images
    .map((image) => {
      const imageId = image?.id || '';
      const useCount = imageId ? (usedIds.get(imageId) || 0) : 0;
      const score = fallbackScoreForSpecificSection(image, targetKey, meta, paragraphText, reviewScope) - useCount * 120;
      return { image, score };
    })
    .filter((entry) => entry.image && entry.score > 0)
    .sort((a, b) => b.score - a.score)[0] || null;
}

function bestOverviewSectionFallback(images = [], reviewScope = '', usedIds = new Map()) {
  return images
    .map((image) => {
      const imageId = image?.id || '';
      const useCount = imageId ? (usedIds.get(imageId) || 0) : 0;
      return {
        image,
        score: scoreOverviewImage(image, reviewScope) - useCount * 90,
      };
    })
    .filter((entry) => entry.image && entry.score > 0 && !isDeviceHeavyImage(entry.image))
    .sort((a, b) => b.score - a.score)[0] || null;
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

function isImageAllowedForManifestSection(image, targetKey, reviewScope = '', meta = {}, paragraphText = '') {
  if (!isImageAllowedForRegion(image, targetKey, reviewScope)) return false;
  if (!imageMatchesFineStructureRequest(image, targetKey, meta, paragraphText, reviewScope)) return false;
  if (!isDeviceHeavyImage(image)) return true;
  if (sectionRequestsDevice(meta, paragraphText) && DEVICE_AUTHORIZED_REGION_KEYS.has(targetKey)) return true;
  if (hasDirectRequestedAnatomyEvidence(image, meta, paragraphText)) return true;
  return false;
}

function stableSectionId(value = '', index = 0) {
  const cleaned = normalizeText(value || `section-${index + 1}`).replace(/\s+/g, '_').replace(/[^a-z0-9_]+/g, '');
  return cleaned || `section_${index + 1}`;
}

function normalizeParagraphItems(paragraphs = [], paragraphMeta = []) {
  return (Array.isArray(paragraphs) ? paragraphs : [])
    .map((text, index) => ({
      index,
      text: String(text || '').trim(),
      meta: paragraphMeta[index] || {},
    }))
    .filter((item) => item.text);
}

function groupParagraphsIntoManifestSections(paragraphs = [], paragraphMeta = [], reviewScope = '') {
  const items = normalizeParagraphItems(paragraphs, paragraphMeta);
  if (!items.length) {
    return [{
      section_id: 'profile_anatomy_overview',
      order: 0,
      section_key: 'overview',
      section_title: 'Profile Anatomy',
      target_region: 'overview',
      resolved_from: 'missing_paragraph_metadata',
      paragraph_indices: [],
      narration_text: 'Profile Anatomy',
      hold_last_frame_allowed: false,
      placeholder_behavior: 'section_card',
    }];
  }

  const sections = [];
  let current = null;
  const pushCurrent = () => {
    if (!current) return;
    current.narration_text = current.paragraphs.map((item) => item.text).join('\n\n').trim();
    current.paragraph_indices = current.paragraphs.map((item) => item.index);
    delete current.paragraphs;
    delete current.has_visual_callout;
    sections.push(current);
    current = null;
  };

  for (const item of items) {
    const explicitKey = normalizeText(item.meta.section_key || item.meta.sectionKey || item.meta.section?.key || '').replace(/\s+/g, '_');
    const startsAnotherVisualCallout = item.meta.type === 'visual-callout' && current?.has_visual_callout;
    const leavesVisualCallout = item.meta.type !== 'visual-callout' && current?.has_visual_callout;
    const isBoundary = item.meta.type === 'title' || item.meta.type === 'section-title' || !current
      || (explicitKey && explicitKey !== current.section_key && item.meta.type !== 'visual-callout')
      || startsAnotherVisualCallout
      || leavesVisualCallout;
    if (isBoundary) {
      pushCurrent();
      const resolution = item.meta.type === 'title'
        ? { key: 'overview', source: 'document_title' }
        : sectionRegionResolutionFromMeta(item.meta, item.text, reviewScope);
      const sectionKey = explicitKey || resolution.key || `section_${sections.length + 1}`;
      const title = displayLabelForMeta(item.meta, item.text);
      current = {
        section_id: `${String(sections.length + 1).padStart(3, '0')}_${stableSectionId(sectionKey || title, sections.length)}`,
        order: sections.length,
        section_key: sectionKey,
        section_title: title,
        target_region: resolution.key || 'overview',
        resolved_from: resolution.source,
        paragraphs: [],
        allowed_anatomy_labels: [...(STRICT_ALLOWED_IMAGE_REGIONS.get(resolution.key) || new Set())],
        prohibited_anatomy_labels: [...(STRICT_FORBIDDEN_IMAGE_REGIONS.get(resolution.key) || new Set())],
        preferred_evidence_ids: [],
        has_visual_callout: false,
        hold_last_frame_allowed: false,
        placeholder_behavior: 'section_card',
      };
    }
    current.paragraphs.push(item);
    if (item.meta.type === 'visual-callout') current.has_visual_callout = true;
    for (const evidenceId of (Array.isArray(item.meta.evidence_image_ids) ? item.meta.evidence_image_ids : [])) {
      if (evidenceId && !current.preferred_evidence_ids.includes(evidenceId)) current.preferred_evidence_ids.push(evidenceId);
    }
  }
  pushCurrent();
  return sections;
}

function assignmentMetadataForImage(image = {}, score = 0, reason = '', targetKey = '') {
  const anatomyLabels = [...regionKeysForImage(image)];
  const fineLabels = [...directFineStructureKeysForImage(image)];
  const regionCropFallback = allowsRegionCropFallback(targetKey, new Set(anatomyLabels), image);
  return {
    evidence_id: image.id || null,
    source_collection: image.source || 'profile_review',
    source_ref: image.url || null,
    source_path_or_frame: image.url || null,
    anatomy_labels: anatomyLabels,
    fine_structure_labels: fineLabels,
    assignment_score: Number(score || 0),
    assignment_confidence: score >= 90 ? 'high' : score >= 45 ? 'moderate' : 'low',
    assignment_reason: reason,
    evidence_recency: image.source?.includes('archive') ? 'historical' : 'current_or_saved',
    evidence_role: isDeviceHeavyImage(image) ? 'device_related' : 'anatomy',
    device_related: isDeviceHeavyImage(image),
    region_crop_fallback: regionCropFallback,
    procedure_related: /\b(procedure|catheter|foley|statlock|tubing|drainage)\b/i.test(normalizeText([image.label, image.coverage, image.source].join(' '))),
    display_label: image.label || null,
  };
}

export function createReviewEvidenceManifest({
  reviewId = '',
  title = 'Profile Anatomy Video',
  paragraphs = [],
  paragraphMeta = [],
  images = [],
  reviewScope = 'head_to_toe',
} = {}) {
  const sections = groupParagraphsIntoManifestSections(paragraphs, paragraphMeta, reviewScope);
  const evidenceUseCounts = new Map();
  const maxEvidencePerSection = reviewScope === 'pelvic_genital' ? 2 : 3;
  const manifestSections = sections.map((section) => {
    const preferredEvidenceIds = new Set(section.preferred_evidence_ids || []);
    const meta = {
      section_key: section.section_key,
      section_label: section.section_title,
      type: 'manifest-section',
    };
    const unresolvedFineStructureRequest = section.target_region === 'overview'
      && section.resolved_from === 'unresolved'
      && requestedStrictFineStructureKeys(meta, section.narration_text).size > 0;
    const candidates = unresolvedFineStructureRequest
      ? overviewCandidateTrace(images, reviewScope).map((candidate) => ({
        ...candidate,
        score: -1000,
        rejection_reason: 'Specific anatomy was requested but no reliable section region was resolved; refusing overview fallback.',
      }))
      : section.target_region === 'overview'
      ? overviewCandidateTrace(images, reviewScope)
      : candidateTrace(images, section.target_region, meta, section.narration_text, reviewScope);
    const ranked = candidates
      .map((candidate) => ({
        candidate,
        image: images.find((image) => image.id === candidate.id),
      }))
      .filter((entry) => entry.image && entry.candidate.score > 0)
      .filter((entry) => isImageAllowedForManifestSection(entry.image, section.target_region, reviewScope, meta, section.narration_text))
      .map((entry) => {
        const imageId = entry.image?.id || entry.candidate?.id || '';
        const useCount = imageId ? (evidenceUseCounts.get(imageId) || 0) : 0;
        const repeatPenalty = useCount * (reviewScope === 'pelvic_genital' ? 135 : 105);
        return {
          ...entry,
          adjustedScore: entry.candidate.score - repeatPenalty + (preferredEvidenceIds.has(imageId) ? 1000 : 0),
          repeatPenalty,
          explicitlyPreferred: preferredEvidenceIds.has(imageId),
        };
      })
      .sort((a, b) => b.adjustedScore - a.adjustedScore || b.candidate.score - a.candidate.score);
    const fallback = ranked[0]
      ? null
      : MIXED_SECTION_KEYS.has(section.section_key)
        ? bestOverviewSectionFallback(images, reviewScope, evidenceUseCounts)
        : bestSpecificSectionFallback(images, section.target_region, meta, section.narration_text, reviewScope, evidenceUseCounts);
    const selectedEntries = ranked
      .filter((entry) => entry.adjustedScore > 0)
      .slice(0, preferredEvidenceIds.size ? 1 : maxEvidencePerSection);
    const selected = selectedEntries[0] || fallback;
    const directReason = selected
      ? fallback
        ? MIXED_SECTION_KEYS.has(section.section_key)
          ? `Selected safe overview evidence for ${section.section_title}; this mixed narrative section does not require a single exact anatomical close-up.`
          : `Selected closest safe anatomical fallback for ${REGION_LABELS.get(section.target_region) || section.target_region}; exact section evidence was not labelled strongly enough.`
        : `Selected explicit compatible evidence for ${REGION_LABELS.get(section.target_region) || section.target_region}.`
      : `No compatible focused evidence for ${REGION_LABELS.get(section.target_region) || section.target_region}; renderer must use section card.`;
    const selectedForAssignments = selectedEntries.length ? selectedEntries : (fallback ? [fallback] : []);
    const assignments = selectedForAssignments
      .map((entry, index) => {
        const reason = index === 0
          ? directReason
          : `Selected additional compatible visual ${index + 1} for ${REGION_LABELS.get(section.target_region) || section.target_region}.`;
        return assignmentMetadataForImage(entry.image, entry.candidate?.score ?? entry.score ?? 0, reason, section.target_region);
      })
      .filter(Boolean);
    for (const assignment of assignments) {
      if (assignment?.evidence_id) {
        evidenceUseCounts.set(assignment.evidence_id, (evidenceUseCounts.get(assignment.evidence_id) || 0) + 1);
      }
    }
    return {
      ...section,
      explicitly_assigned_evidence_ids: assignments.map((assignment) => assignment.evidence_id).filter(Boolean),
      assigned_evidence: assignments,
      assignment_candidates: candidates,
      fallback_reason: assignments.length ? '' : directReason,
      media_mode: assignments.length ? 'assigned_evidence' : 'placeholder',
    };
  });

  const manifest = {
    manifest_version: 1,
    review_id: reviewId || crypto.randomUUID(),
    title,
    review_scope: reviewScope,
    created_at: new Date().toISOString(),
    sections: manifestSections,
  };
  return Object.freeze(JSON.parse(JSON.stringify(manifest)));
}

export function validateReviewEvidenceManifest(manifest = {}) {
  const errors = [];
  const seen = new Set();
  const sections = Array.isArray(manifest.sections) ? manifest.sections : [];
  sections.forEach((section, index) => {
    if (!section.section_id) errors.push(`Section ${index + 1} is missing section_id.`);
    if (seen.has(section.section_id)) errors.push(`Duplicate section_id ${section.section_id}.`);
    seen.add(section.section_id);
    if (Number(section.order) !== index) errors.push(`Section ${section.section_id} has non-stable order ${section.order}; expected ${index}.`);
    const assigned = Array.isArray(section.assigned_evidence) ? section.assigned_evidence : [];
    if (!assigned.length && section.media_mode !== 'placeholder') errors.push(`Section ${section.section_id} has no assigned evidence but is not placeholder.`);
    assigned.forEach((evidence) => {
      if (!section.explicitly_assigned_evidence_ids?.includes(evidence.evidence_id)) {
        errors.push(`Renderer evidence ${evidence.evidence_id} is not explicitly assigned to ${section.section_id}.`);
      }
      const labels = new Set(evidence.anatomy_labels || []);
      for (const blocked of section.prohibited_anatomy_labels || []) {
        const allowedCropFromBroadReference = Boolean(evidence.region_crop_fallback && labels.has(section.target_region));
        const allowedHeadToToeMultiRegionReference = manifest.review_scope !== 'pelvic_genital'
          && labels.has(section.target_region);
        if (labels.has(blocked) && !allowedCropFromBroadReference && !allowedHeadToToeMultiRegionReference) {
          errors.push(`Section ${section.section_id} contains prohibited anatomy label ${blocked} from evidence ${evidence.evidence_id}.`);
        }
      }
      if (
        evidence.device_related
        && !sectionRequestsDevice({ section_key: section.section_key, section_label: section.section_title }, section.narration_text)
        && !hasDirectRequestedAnatomyEvidence(
          evidence,
          { section_key: section.section_key, section_label: section.section_title },
          section.narration_text,
        )
      ) {
        errors.push(`Device evidence ${evidence.evidence_id} is not authorized for section ${section.section_id}.`);
      }
    });
  });
  if (!sections.length) errors.push('Manifest has no sections.');
  if (errors.length) {
    const error = new Error(`ANATOMY MANIFEST VALIDATION FAILED: ${errors[0]}`);
    error.status = 422;
    error.validationErrors = errors;
    throw error;
  }
  return true;
}

function validateNoSpecificSectionPlaceholders(manifest = {}) {
  const placeholders = (manifest.sections || []).filter((section) => (
    section.target_region
    && section.target_region !== 'overview'
    && !section.assigned_evidence?.length
  ));
  if (!placeholders.length) return;
  const first = placeholders[0];
  const error = new Error(`No usable visual evidence was selected for ${first.section_title || first.section_key || first.target_region}. Refusing to render a black anatomy title card.`);
  error.status = 422;
  error.placeholderSections = placeholders.map((section) => ({
    section_id: section.section_id,
    section_title: section.section_title,
    target_region: section.target_region,
    fallback_reason: section.fallback_reason,
  }));
  throw error;
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

function ttsChunksForSectionText(text = '') {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const maxChars = 3200;
  const chunks = [];
  let remaining = cleaned;
  let previousContext = '';
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('. ', maxChars);
    if (splitAt < 800) splitAt = remaining.lastIndexOf(' ', maxChars);
    if (splitAt < 800) splitAt = maxChars;
    const part = remaining.slice(0, splitAt + 1).trim();
    if (part) {
      chunks.push({ text: part, previousContext });
      previousContext = part.slice(-320);
    }
    remaining = remaining.slice(splitAt + 1).trim();
  }
  if (remaining) chunks.push({ text: remaining, previousContext });
  return chunks;
}

async function concatAudioFiles({ files = [], outputPath, outputFormat = 'mp3', normalize = false }) {
  const concatPath = `${outputPath}.concat.txt`;
  await fs.writeFile(concatPath, files.map((file) => `file ${q(file.replace(/\\/g, '/'))}`).join('\n'), 'utf8');
  const filterArgs = normalize ? ['-af', 'loudnorm=I=-18:TP=-1.5:LRA=11'] : [];
  const encodeArgs = outputFormat === 'wav'
    ? ['-c:a', 'pcm_s16le']
    : outputFormat === 'm4a'
      ? ['-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart']
      : ['-c:a', 'libmp3lame', '-b:a', '320k', '-compression_level', '0'];
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatPath,
    ...filterArgs,
    ...encodeArgs,
    outputPath,
  ]);
}

async function resolveManifestNarration(payload, manifest, { jobId, signal, onProgress }) {
  const outputFormat = payload.outputFormat || 'mp3';
  const sectionOutputFormat = 'wav';
  const measuredFromPayload = Array.isArray(payload.measuredAudioSegments) ? payload.measuredAudioSegments : [];
  if (measuredFromPayload.length) {
    const byId = new Map(measuredFromPayload.map((segment) => [String(segment.section_id || ''), segment]));
    const segments = manifest.sections.map((section) => {
      const supplied = byId.get(section.section_id);
      const duration = Number(supplied?.duration_seconds || supplied?.durationSeconds || 0);
      if (!duration || duration <= 0) {
        const error = new Error(`Measured audio duration missing for manifest section ${section.section_id}.`);
        error.status = 422;
        throw error;
      }
      return {
        section_id: section.section_id,
        audioPath: supplied.audio_path || supplied.audioPath || null,
        file_url: supplied.file_url || supplied.fileUrl || null,
        durationSeconds: duration,
        reused: true,
      };
    });
    return { reused: true, audioPath: null, rendered: null, segments, durationSeconds: segments.reduce((sum, item) => sum + item.durationSeconds, 0) };
  }

  const files = [];
  const segments = [];
  let cursorSeconds = 0;
  for (const [index, section] of manifest.sections.entries()) {
    if (signal?.aborted) throw new Error('Cancelled');
    const chunks = ttsChunksForSectionText(section.narration_text || section.section_title);
    if (!chunks.length) {
      const error = new Error(`No narration text for manifest section ${section.section_id}.`);
      error.status = 422;
      throw error;
    }
    onProgress?.({
      phase: 'narration',
      current: index,
      total: manifest.sections.length,
      message: `Rendering measured narration section ${index + 1}/${manifest.sections.length}: ${section.section_title}`,
      section_id: section.section_id,
    });
    const rendered = await renderTTSExport({
      title: `${payload.title || 'Profile Anatomy Video'} - ${section.section_title}`,
      chunks,
      chapters: [{
        title: section.section_title,
        startMs: 0,
        source: 'profile_anatomy_manifest_section',
        confidence: 'explicit',
      }],
      voice: payload.voice || 'nova',
      model: payload.model,
      speed: payload.speed,
      instructions: payload.instructions || '',
      outputFormat: sectionOutputFormat,
      normalize: Boolean(payload.normalize),
    }, {
      jobId: `${jobId}-audio-${String(index + 1).padStart(3, '0')}`,
      signal,
      onProgress: (progress) => onProgress?.({
        ...progress,
        phase: `narration_${progress?.phase || 'rendering'}`,
        message: `Narration ${index + 1}/${manifest.sections.length}: ${progress?.message || 'rendering...'}`,
        section_id: section.section_id,
      }),
    });
    const audioPath = uploadPathFromUrl(rendered.file_url);
    if (!audioPath || !await fileExists(audioPath)) {
      const error = new Error(`Narration audio file missing for section ${section.section_id}.`);
      error.status = 500;
      throw error;
    }
    const durationSeconds = await mediaDurationSeconds(audioPath);
    if (!durationSeconds || durationSeconds <= 0) {
      const error = new Error(`Measured audio duration failed for section ${section.section_id}.`);
      error.status = 422;
      throw error;
    }
    files.push(audioPath);
    segments.push({
      section_id: section.section_id,
      audioPath,
      file_url: rendered.file_url,
      durationSeconds,
      startSeconds: cursorSeconds,
      endSeconds: cursorSeconds + durationSeconds,
      rendered,
    });
    cursorSeconds += durationSeconds;
  }

  const outputBase = `${slugifyFilePart(payload.title || 'Profile Anatomy Video')}-measured-narration-${Date.now()}`;
  const finalFilename = `${outputBase}.${outputFormat}`;
  const finalAudioPath = path.join(uploadDir, finalFilename);
  await concatAudioFiles({ files, outputPath: finalAudioPath, outputFormat, normalize: Boolean(payload.normalize) });
  const stat = await fs.stat(finalAudioPath);
  const durationSeconds = await mediaDurationSeconds(finalAudioPath);
  const savedAudio = upsertEntity('AudioExport', crypto.randomUUID(), {
    title: payload.title || 'Profile Anatomy Video',
    analysis_title: payload.title || 'Profile Anatomy Video',
    file_url: `/uploads/${finalFilename}`,
    duration_seconds: Math.round(durationSeconds || cursorSeconds),
    voice: payload.voice || 'nova',
    speed: payload.speed || null,
    model: payload.model || null,
    format: outputFormat,
    render_version: 'profile_anatomy_measured_sections_v1',
    size: stat.size,
    filename: finalFilename,
    tts_session_key: payload.sessionId || null,
    source_generated_at: payload.sourceGeneratedAt || null,
    exported_at: new Date().toISOString(),
    audio_content_version: payload.sourceGeneratedAt || null,
    notes: 'Measured section-level anatomy narration used for synchronized profile video rendering.',
  });
  return {
    reused: false,
    audioPath: finalAudioPath,
    rendered: savedAudio,
    segments,
    durationSeconds,
  };
}

export function buildManifestVisualTimeline({ manifest = {}, narrationSegments = [] } = {}) {
  const audioBySection = new Map((Array.isArray(narrationSegments) ? narrationSegments : []).map((segment) => [segment.section_id, segment]));
  let cursor = 0;
  const timeline = [];
  for (const [sectionIndex, section] of (manifest.sections || []).entries()) {
    const audio = audioBySection.get(section.section_id);
    const durationSeconds = Number(audio?.durationSeconds || audio?.duration_seconds || 0);
    if (!durationSeconds || durationSeconds <= 0) {
      const error = new Error(`Missing measured audio duration for section ${section.section_id}.`);
      error.status = 422;
      throw error;
    }
    const assignments = Array.isArray(section.assigned_evidence) ? section.assigned_evidence : [];
    const usableAssignments = assignments.filter((assignment) => assignment?.evidence_id);
    const visualCount = usableAssignments.length
      ? Math.max(1, Math.min(usableAssignments.length, Math.floor(durationSeconds / 6) || 1))
      : 1;
    const selectedAssignments = usableAssignments.slice(0, visualCount);
    const segmentDuration = durationSeconds / visualCount;
    const entries = selectedAssignments.length ? selectedAssignments : [null];
    for (const [visualIndex, assignment] of entries.entries()) {
      const startSeconds = cursor;
      const isLastVisual = visualIndex === entries.length - 1;
      const endSeconds = isLastVisual ? startSeconds + (durationSeconds - segmentDuration * visualIndex) : startSeconds + segmentDuration;
      const item = {
      type: assignment ? 'image' : 'card',
      image: assignment ? {
        id: assignment.evidence_id,
        label: assignment.display_label,
        url: assignment.source_ref,
        source: assignment.source_collection,
        manifest_assigned: true,
        regions: assignment.anatomy_labels,
        regionLabels: assignment.anatomy_labels,
        anatomy_labels: assignment.anatomy_labels,
        fine_structure_labels: assignment.fine_structure_labels,
        coverage: assignment.assignment_reason,
      } : null,
      durationSeconds: endSeconds - startSeconds,
      startSeconds,
      endSeconds,
      sectionId: section.section_id,
      sectionKey: section.section_key,
      label: section.section_title,
      targetKey: section.target_region,
      manifestAssigned: Boolean(assignment),
      resolvedFrom: section.resolved_from,
      paragraphPreview: textPreview(section.narration_text),
      score: assignment?.assignment_score || 0,
      selectionReason: assignment?.assignment_reason || section.fallback_reason || 'Section card selected.',
      audio,
      trace: {
        sectionId: section.section_id,
        sectionLabel: section.section_title,
        paragraphPreview: textPreview(section.narration_text),
        resolvedFrom: section.resolved_from,
        reviewScope: manifest.review_scope,
        targetRegion: section.target_region,
        allowedRegions: section.allowed_anatomy_labels,
        candidates: section.assignment_candidates || [],
        selectedImage: assignment ? {
          id: assignment.evidence_id,
          label: assignment.display_label,
          tags: assignment.anatomy_labels,
          source: assignment.source_collection,
        } : null,
        selectionReason: assignment?.assignment_reason || section.fallback_reason || 'Section card selected.',
      },
      };
      cursor = item.endSeconds;
      item.timeline_index = timeline.length;
      item.section_visual_index = visualIndex;
      item.section_visual_count = entries.length;
      item.section_manifest_index = sectionIndex;
      timeline.push(item);
    }
  }
  return timeline;
}

export function validateManifestTimelineIntegrity({ manifest = {}, narrationSegments = [], visualTimeline = [] } = {}) {
  validateReviewEvidenceManifest(manifest);
  const errors = [];
  const manifestIds = (manifest.sections || []).map((section) => section.section_id);
  const audioIds = (narrationSegments || []).map((segment) => segment.section_id);
  if (manifestIds.length !== audioIds.length || manifestIds.some((id, index) => id !== audioIds[index])) {
    errors.push('Narration segment ordering does not match manifest section ordering.');
  }
  const sectionsById = new Map((manifest.sections || []).map((section) => [section.section_id, section]));
  let visualIndex = 0;
  for (const sectionId of manifestIds) {
    let count = 0;
    while (visualIndex < visualTimeline.length && visualTimeline[visualIndex].sectionId === sectionId) {
      visualIndex += 1;
      count += 1;
    }
    if (!count) errors.push(`Visual segment ordering does not include section ${sectionId}.`);
  }
  if (visualIndex !== visualTimeline.length) {
    errors.push('Visual segment ordering contains an unknown or out-of-order section.');
  }
  let cursor = 0;
  for (const [index, item] of visualTimeline.entries()) {
    if (item.durationSeconds <= 0) errors.push(`Visual segment ${item.sectionId} has invalid duration.`);
    if (Math.abs(Number(item.startSeconds || 0) - cursor) > 0.03) errors.push(`Visual segment ${item.sectionId} has timeline gap or overlap.`);
    cursor = Number(item.endSeconds || 0);
    const section = sectionsById.get(item.sectionId);
    if (item.image?.id && !section?.explicitly_assigned_evidence_ids?.includes(item.image.id)) {
      errors.push(`Visual segment ${item.sectionId} uses unassigned evidence ${item.image.id}.`);
    }
  }
  if (errors.length) {
    const error = new Error(`ANATOMY TIMELINE VALIDATION FAILED: ${errors[0]}`);
    error.status = 422;
    error.validationErrors = errors;
    throw error;
  }
  return true;
}

export function buildManifestQaReport(manifest = {}, visualSelections = []) {
  const selectionsBySection = new Map();
  for (const item of visualSelections || []) {
    if (!item.section_id) continue;
    if (!selectionsBySection.has(item.section_id)) selectionsBySection.set(item.section_id, []);
    selectionsBySection.get(item.section_id).push(item);
  }
  const lines = [
    `Profile anatomy video QA manifest: ${manifest.title || 'Profile Anatomy Video'}`,
    `Review scope: ${manifest.review_scope || 'unknown'}`,
    `Sections: ${(manifest.sections || []).length}`,
    '',
  ];
  for (const section of manifest.sections || []) {
    const assignment = section.assigned_evidence?.[0] || null;
    const selections = selectionsBySection.get(section.section_id) || [];
    const duration = selections.reduce((sum, item) => sum + Number(item.duration_seconds || 0), 0);
    lines.push([
      `${String(section.order + 1).padStart(2, '0')}. ${section.section_title}`,
      `id=${section.section_id}`,
      `target=${section.target_region}`,
      assignment
        ? `evidence=${section.assigned_evidence.map((item) => item.evidence_id).join(', ')} labels=[${(assignment.anatomy_labels || []).join(', ')}] confidence=${assignment.assignment_confidence} role=${assignment.evidence_role}`
        : `placeholder=${section.placeholder_behavior} reason=${section.fallback_reason || 'no compatible evidence'}`,
      duration ? `duration=${Number(duration.toFixed(3))}s` : null,
    ].filter(Boolean).join(' | '));
  }
  return lines.join('\n');
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
  const out = [];
  const slices = listLatestProfileReviewEvidenceSlices(resultKey, archiveKey, 30);
  for (const slice of slices) {
    const prefix = slice.archiveIndex < 0
      ? `current_${resultKey}`
      : `archive_${slice.archiveIndex + 1}_${archiveKey}`;
    out.push(...reviewedImagesFromResult(slice.result, prefix));
  }
  return out;
}

function manifestNeedsHistoricalEvidence(manifest = {}) {
  return (manifest.sections || []).some((section) => (
    section.target_region
    && section.target_region !== 'overview'
    && !section.assigned_evidence?.length
  ));
}

export function createReviewEvidenceManifestWithFallback({
  reviewId,
  title,
  paragraphs = [],
  paragraphMeta = [],
  images = [],
  reviewScope = 'head_to_toe',
  loadHistoricalImages = () => images,
} = {}) {
  let imageItems = safeImageItems(images);
  let manifest = createReviewEvidenceManifest({
    reviewId,
    title,
    paragraphs,
    paragraphMeta,
    images: imageItems,
    reviewScope,
  });
  let usedHistoricalFallback = false;
  if (manifestNeedsHistoricalEvidence(manifest)) {
    imageItems = safeImageItems(loadHistoricalImages());
    manifest = createReviewEvidenceManifest({
      reviewId,
      title,
      paragraphs,
      paragraphMeta,
      images: imageItems,
      reviewScope,
    });
    usedHistoricalFallback = true;
  }
  return { manifest, imageItems, usedHistoricalFallback };
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

  const localVisionFramePath = localVisionFramePathFromUrl(rawUrl);
  if (localVisionFramePath && await fileExists(localVisionFramePath)) return localVisionFramePath;

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

function cropAnchorForRegion(targetKey = '', sectionKey = '') {
  switch (sectionKey) {
    case 'pubic_mound_lower_abdomen':
    case 'inguinal_folds_groin_skin':
      return { x: '(iw-ow)/2', y: '(ih-oh)*0.32' };
    case 'penis':
    case 'foreskin':
    case 'glans_meatus':
      return { x: '(iw-ow)/2', y: '(ih-oh)*0.30' };
    case 'scrotum_testes':
      return { x: '(iw-ow)/2', y: '(ih-oh)*0.46' };
    case 'perineum':
      return { x: '(iw-ow)/2', y: '(ih-oh)*0.60' };
    case 'anal_opening_perianal_region':
    case 'buttocks_gluteal_skin':
      return { x: '(iw-ow)/2', y: '(ih-oh)*0.68' };
    default:
      break;
  }
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

async function renderImageSegment({ imagePath, outputPath, durationSeconds, index, targetKey, sectionKey }) {
  const frames = Math.max(1, Math.round(durationSeconds * VIDEO_FPS));
  const zoomDirection = index % 2 === 0 ? 'in' : 'out';
  const zoomExpr = zoomDirection === 'in'
    ? `min(1.10,1.0+0.10*on/${frames})`
    : `max(1.0,1.10-0.10*on/${frames})`;
  const cropAnchor = cropAnchorForRegion(targetKey, sectionKey);
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
  const safeTitle = safeDrawText(label || 'Profile Anatomy');
  const drawText = await fileExists(fontPath)
    ? [
      `drawtext=fontfile='${fontFilterPath}':text='SARAH':fontsize=30:fontcolor=white@0.96:x=270:y=148`,
      `drawtext=fontfile='${fontFilterPath}':text='PulsePoint Anatomy Review':fontsize=24:fontcolor=white@0.62:x=270:y=192`,
      `drawtext=fontfile='${fontFilterPath}':text='${safeTitle}':fontsize=54:fontcolor=white:x=154:y=430`,
      `drawtext=fontfile='${fontFilterPath}':text='No verified matching source visual available for this section':fontsize=24:fontcolor=white@0.58:x=154:y=520`,
    ].join(',')
    : '';
  const vf = [
    `format=yuv420p`,
    `drawbox=x=0:y=0:w=iw:h=ih:color=0x090b10@1:t=fill`,
    `drawbox=x=110:y=100:w=1700:h=880:color=0x0f1117@0.94:t=fill`,
    `drawbox=x=110:y=100:w=1700:h=880:color=0xff2d55@0.82:t=4`,
    `drawbox=x=154:y=146:w=84:h=84:color=0xff2d55@0.95:t=8`,
    drawText,
    `format=yuv420p${fadeFilters}`,
  ].filter(Boolean).join(',');

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
        const recentPenalty = recentIndex >= 0 ? Math.max(70, 180 - recentIndex * 24) : 0;
        const usagePenalty = imageId ? (imageUseCounts.get(imageId) || 0) * (reviewScope === 'pelvic_genital' ? 135 : 105) : 0;
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
    const reviewScopeFallback = reviewScope === 'pelvic_genital'
      && lastInReviewScope
      && isImageAllowedForRegion(lastInReviewScope, targetKey, reviewScope)
      && imageMatchesFineStructureRequest(lastInReviewScope, targetKey, item.meta, item.text, reviewScope)
      ? lastInReviewScope
      : null;
    const safeSpecificFallback = !best?.image && !last && !reviewScopeFallback
      ? bestSpecificSectionFallback(images, targetKey, item.meta, item.text, reviewScope, imageUseCounts)?.image
      : null;
    const selected = best?.image
      || (last && isImageAllowedForRegion(last, targetKey, reviewScope) && imageMatchesFineStructureRequest(last, targetKey, item.meta, item.text, reviewScope) ? last : null)
      || reviewScopeFallback
      || safeSpecificFallback;
    if (targetKey && targetKey !== 'overview' && selected && isImageAllowedForRegion(selected, targetKey, reviewScope) && imageMatchesFineStructureRequest(selected, targetKey, item.meta, item.text, reviewScope)) {
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
          : safeSpecificFallback === selected
            ? `Selected closest safe anatomical fallback for ${REGION_LABELS.get(targetKey) || targetKey}; avoiding title card and unrelated anatomy.`
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

export function validateVisualTimeline(visualTimeline = [], reviewScope = '') {
  const violations = [];
  for (const [index, item] of visualTimeline.entries()) {
    if (item.type !== 'image') continue;
    const regionAllowed = isImageAllowedForRegion(item.image, item.targetKey, reviewScope);
    const manifestAssigned = Boolean(item.manifestAssigned || item.image?.manifest_assigned);
    const fineStructureAllowed = manifestAssigned || imageMatchesFineStructureRequest(
        item.image,
        item.targetKey,
        { section_key: item.targetKey, section_label: item.label },
        item.paragraphPreview,
        reviewScope
      );
    if (!regionAllowed || !fineStructureAllowed) {
      const imageTags = [...regionKeysForImage(item.image)];
      violations.push({
        index,
        reason: !regionAllowed ? 'region_not_allowed' : 'fine_structure_mismatch',
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
  const cardViolations = visualTimeline
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.type === 'card' && item.targetKey && item.targetKey !== 'overview');
  if (cardViolations.length) {
    const first = cardViolations[0];
    const error = new Error(`NO VISUAL EVIDENCE SELECTED: segment ${first.index + 1} (${first.item.label || first.item.targetKey}) would render as a black anatomy title card. Refusing to render.`);
    error.status = 422;
    error.placeholderSegments = cardViolations.map(({ item, index }) => ({
      index,
      label: item.label,
      target_region: item.targetKey,
      selection_reason: item.selectionReason,
    }));
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
    const evidence = createReviewEvidenceManifestWithFallback({
      reviewId: payload.reviewId || jobId,
      title,
      paragraphs: payload.paragraphs || [],
      paragraphMeta: payload.paragraphMeta || payload.paragraph_meta || [],
      images: payloadImages,
      reviewScope,
      loadHistoricalImages: () => augmentAnatomyImagesFromDatabase(payload, payloadImages),
    });
    const { manifest, imageItems, usedHistoricalFallback } = evidence;
    if (!imageItems.length) {
      const error = new Error('No review images are available for the anatomy video.');
      error.status = 400;
      throw error;
    }
    validateReviewEvidenceManifest(manifest);
    validateNoSpecificSectionPlaceholders(manifest);
    onProgress({
      phase: 'manifest',
      current: 1,
      total: 5,
      message: `Validated immutable ${manifest.sections.length}-section evidence manifest.`,
      review_scope: reviewScope,
      manifest_section_count: manifest.sections.length,
      assigned_evidence_count: manifest.sections.filter((section) => section.assigned_evidence?.length).length,
      placeholder_count: manifest.sections.filter((section) => !section.assigned_evidence?.length).length,
      historical_media_fallback_used: usedHistoricalFallback,
    });
    if (payload.qaOnly || payload.qa_only) {
      return {
        ok: true,
        jobId,
        render_version: PROFILE_ANATOMY_VIDEO_RENDER_VERSION,
        qa_only: true,
        review_scope: reviewScope,
        manifest,
        qa_report: buildManifestQaReport(manifest),
        created_at: new Date().toISOString(),
      };
    }

    const narration = await resolveManifestNarration(payload, manifest, { jobId, signal: options.signal, onProgress });
    if (options.signal?.aborted) throw new Error('Cancelled');
    const audioDuration = narration.durationSeconds || await mediaDurationSeconds(narration.audioPath);
    const visualTimeline = buildManifestVisualTimeline({
      manifest,
      narrationSegments: narration.segments || [],
    });
    validateManifestTimelineIntegrity({
      manifest,
      narrationSegments: narration.segments || [],
      visualTimeline,
    });
    validateVisualTimeline(visualTimeline, reviewScope);
    const totalSegments = visualTimeline.length;
    const regionTrace = visualTimeline.map((item, index) => ({
      segment: index + 1,
      section_id: item.sectionId || null,
      type: item.type,
      target_region: item.targetKey || null,
      narration_section: item.label || null,
      narration_preview: item.paragraphPreview || null,
      resolved_from: item.resolvedFrom || null,
      review_scope: reviewScope,
      audio_start_seconds: Number(item.startSeconds?.toFixed?.(3) || item.startSeconds || 0),
      audio_end_seconds: Number(item.endSeconds?.toFixed?.(3) || item.endSeconds || 0),
      actual_audio_duration_seconds: Number(item.durationSeconds?.toFixed?.(3) || item.durationSeconds || 0),
      video_start_seconds: Number(item.startSeconds?.toFixed?.(3) || item.startSeconds || 0),
      video_end_seconds: Number(item.endSeconds?.toFixed?.(3) || item.endSeconds || 0),
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
      database_augmented_image_count: usedHistoricalFallback ? Math.max(0, imageItems.length - payloadImages.length) : 0,
      historical_media_fallback_used: usedHistoricalFallback,
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
          sectionKey: item.sectionKey,
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
        section_id: item.sectionId || null,
        type: item.type,
        target_region: item.targetKey || null,
        label: item.label || null,
        narration_preview: item.paragraphPreview || null,
        resolved_from: item.resolvedFrom || null,
        review_scope: reviewScope,
        audio_file_url: item.audio?.file_url || null,
        audio_start_seconds: Number(item.startSeconds.toFixed(3)),
        audio_end_seconds: Number(item.endSeconds.toFixed(3)),
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

    const watermark = normalizeWatermarkSettings(payload.watermark || {});
    let durationSeconds = Math.round(await mediaDurationSeconds(finalPath));
    const watermarkDebug = await replaceVideoWithWatermarkedExport(finalPath, watermark, {
      durationSeconds,
      contentType: 'profile_anatomy_video',
      onProgress,
    });
    const stat = await fs.stat(finalPath);
    durationSeconds = Math.round(await mediaDurationSeconds(finalPath));
    return {
      ok: true,
      jobId,
      render_version: PROFILE_ANATOMY_VIDEO_RENDER_VERSION,
      file_url: `/uploads/${filename}`,
      filename,
      size: stat.size,
      duration_seconds: durationSeconds,
      created_at: new Date().toISOString(),
      watermark: watermarkDebug,
      watermark_enabled: Boolean(watermarkDebug?.watermark_enabled),
      watermark_preset: watermarkDebug?.preset || watermark.preset,
      audio_reused: narration.reused,
      audio_file_url: narration.rendered?.file_url || null,
      audio_timing: 'measured_section_audio',
      section_audio_segments: (narration.segments || []).map((segment) => ({
        section_id: segment.section_id,
        file_url: segment.file_url || null,
        duration_seconds: Number(segment.durationSeconds?.toFixed?.(3) || segment.durationSeconds || 0),
        start_seconds: Number(segment.startSeconds?.toFixed?.(3) || segment.startSeconds || 0),
        end_seconds: Number(segment.endSeconds?.toFixed?.(3) || segment.endSeconds || 0),
      })),
      image_count: imageItems.length,
      payload_image_count: payloadImages.length,
      database_augmented_image_count: Math.max(0, imageItems.length - payloadImages.length),
      visual_segment_count: totalSegments,
      review_scope: reviewScope,
      evidence_manifest: manifest,
      qa_report: buildManifestQaReport(manifest, visualSelections),
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
