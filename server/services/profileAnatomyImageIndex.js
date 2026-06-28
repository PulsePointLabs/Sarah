import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  getProfileAnatomyImageClassification,
  listEntities,
  nowIso,
  upsertProfileAnatomyImageClassification,
} from '../db.js';
import { resolveUploadPath } from '../config.js';
import { aiInvokeInternal } from '../routes/internalAi.js';
import {
  isEligibleProfileAnatomyEvidenceSource,
  profileAnatomyEvidenceSourceKind,
} from '../../src/lib/profileAnatomyEvidence.js';

export const PROFILE_ANATOMY_CLASSIFICATION_VERSION = 'profile-anatomy-v1';
export const PROFILE_ANATOMY_CLASSIFIER_MODEL = 'claude_sonnet_4_6';

export const PROFILE_ANATOMY_KEYS = [
  'head', 'face', 'scalp', 'neck', 'shoulders', 'upper_back', 'thoracic_back',
  'lumbar_back', 'posterior_torso', 'chest', 'abdomen', 'upper_limbs', 'hands',
  'pelvis', 'hips', 'buttocks', 'lower_limbs', 'knees', 'calves', 'ankles',
  'feet', 'toes', 'posture', 'skin_finding', 'lower_abdomen', 'pubic_mound',
  'right_inguinal_region', 'left_inguinal_region', 'inguinal_repair_scar',
  'penis', 'penile_base', 'penile_shaft', 'foreskin', 'foreskin_forward',
  'foreskin_partially_retracted', 'foreskin_fully_retracted', 'glans', 'corona',
  'meatus', 'scrotum', 'testes', 'perineum', 'anal_margin', 'anus',
  'perianal_region', 'inner_thighs',
];

const SECTION_KEYS = [
  'head_face', 'neck_shoulders', 'upper_back', 'thoracic_back', 'lumbar_back',
  'posterior_torso_back', 'chest', 'abdomen', 'upper_limbs_hands', 'pelvis_hips',
  'buttocks', 'lower_limbs', 'knees_calves', 'ankles_feet_toes', 'posture',
  'skin_findings', 'pubic_mound_lower_abdomen', 'right_inguinal_repair',
  'inguinal_folds_groin_skin', 'penis', 'foreskin', 'penis_and_foreskin',
  'glans', 'meatus', 'glans_meatus', 'scrotum_testes', 'perineum',
  'anus_perianal', 'device_contact_findings', 'tissue_health_safety_observations',
];

const COMBINED_STRENGTHS = [
  'pubic_mound_and_penis', 'penis_and_foreskin', 'glans_and_meatus',
  'scrotum_and_perineum', 'anus_and_perianal_region', 'back_and_posture',
  'right_inguinal_region_and_repair_scar',
];

const classificationSchema = {
  type: 'object',
  properties: {
    visible_anatomy: { type: 'array', items: { type: 'string', enum: PROFILE_ANATOMY_KEYS } },
    fine_structures: { type: 'array', items: { type: 'string', enum: PROFILE_ANATOMY_KEYS } },
    laterality: { type: 'array', items: { type: 'string', enum: ['left', 'right', 'bilateral', 'midline', 'not_applicable'] } },
    positions: { type: 'array', items: { type: 'string', enum: ['standing', 'seated', 'supine', 'prone', 'anterior', 'posterior', 'left_lateral', 'right_lateral', 'inferior', 'close_up', 'wide_field', 'unknown'] } },
    device_classification: { type: 'string', enum: ['none', 'incidental_device', 'device_dominant'] },
    device_types: { type: 'array', items: { type: 'string' } },
    device_is_primary_subject: { type: 'boolean' },
    quality: {
      type: 'object',
      properties: {
        overall: { type: 'string', enum: ['poor', 'fair', 'good', 'excellent'] },
        focus: { type: 'string', enum: ['poor', 'fair', 'good', 'excellent'] },
        lighting: { type: 'string', enum: ['poor', 'adequate', 'good', 'excellent'] },
        anatomy_visibility: { type: 'string', enum: ['poor', 'fair', 'good', 'excellent'] },
      },
      required: ['overall', 'focus', 'lighting', 'anatomy_visibility'],
    },
    best_for_sections: { type: 'array', items: { type: 'string', enum: SECTION_KEYS } },
    combined_view_strengths: { type: 'array', items: { type: 'string', enum: COMBINED_STRENGTHS } },
    notes: { type: 'string' },
  },
  required: [
    'visible_anatomy', 'fine_structures', 'laterality', 'positions',
    'device_classification', 'device_types', 'device_is_primary_subject',
    'quality', 'best_for_sections', 'combined_view_strengths', 'notes',
  ],
};

function uniqueAllowed(values, allowed) {
  const allowedSet = new Set(allowed);
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter((value) => allowedSet.has(value)))];
}

export function normalizeProfileAnatomyClassification(raw = {}, entry = {}) {
  const deviceClassification = ['none', 'incidental_device', 'device_dominant'].includes(raw.device_classification)
    ? raw.device_classification
    : 'none';
  const qualityValues = {
    overall: ['poor', 'fair', 'good', 'excellent'],
    focus: ['poor', 'fair', 'good', 'excellent'],
    lighting: ['poor', 'adequate', 'good', 'excellent'],
    anatomy_visibility: ['poor', 'fair', 'good', 'excellent'],
  };
  const quality = Object.fromEntries(Object.entries(qualityValues).map(([key, allowed]) => [
    key,
    allowed.includes(raw?.quality?.[key]) ? raw.quality[key] : allowed[0],
  ]));
  return {
    image_id: entry.imageId || raw.image_id || '',
    source_type: entry.sourceType || raw.source_type || '',
    visible_anatomy: uniqueAllowed(raw.visible_anatomy, PROFILE_ANATOMY_KEYS),
    fine_structures: uniqueAllowed(raw.fine_structures, PROFILE_ANATOMY_KEYS),
    laterality: uniqueAllowed(raw.laterality, ['left', 'right', 'bilateral', 'midline', 'not_applicable']),
    positions: uniqueAllowed(raw.positions, ['standing', 'seated', 'supine', 'prone', 'anterior', 'posterior', 'left_lateral', 'right_lateral', 'inferior', 'close_up', 'wide_field', 'unknown']),
    device_classification: deviceClassification,
    device_types: [...new Set((Array.isArray(raw.device_types) ? raw.device_types : []).map((value) => String(value || '').trim()).filter(Boolean))],
    device_is_primary_subject: deviceClassification === 'device_dominant' || raw.device_is_primary_subject === true,
    quality,
    best_for_sections: uniqueAllowed(raw.best_for_sections, SECTION_KEYS),
    combined_view_strengths: uniqueAllowed(raw.combined_view_strengths, COMBINED_STRENGTHS),
    notes: String(raw.notes || '').trim().slice(0, 1000),
  };
}

function latestEntity(name) {
  return listEntities(name).sort((a, b) => String(b.updated_date || b.created_date || '').localeCompare(String(a.updated_date || a.created_date || '')))[0] || null;
}

function sourceUrl(image = {}) {
  return String(image.preview_url || image.previewUrl || image.storagePath || image.file_url || image.url || '').trim();
}

function referenceImageMetadata(image = {}) {
  return {
    display_label: image.display_label || image.view_label || image.label || image.original_filename || image.filename || '',
    media_type: image.media_type || image.mimeType || image.mime_type || '',
    source: image.source || image.source_type || '',
    anatomy_reference_approved: image.anatomy_reference_approved === true
      || image.anatomyReferenceApproved === true
      || image.approved_for_anatomy === true
      || image.approvedForAnatomy === true,
    width: image.width ?? image.image_width ?? null,
    height: image.height ?? image.image_height ?? null,
    image_width: image.image_width ?? image.width ?? null,
    image_height: image.image_height ?? image.height ?? null,
  };
}

export function resolveProfilerImageFile(url = '') {
  let pathname = String(url || '').trim();
  try {
    pathname = new URL(pathname, 'http://localhost').pathname;
  } catch {
    // Keep the raw relative path.
  }
  const uploadsIndex = pathname.toLowerCase().lastIndexOf('/uploads/');
  if (uploadsIndex >= 0) pathname = pathname.slice(uploadsIndex + '/uploads/'.length);
  else pathname = pathname.replace(/^\/+/, '');
  try { pathname = decodeURIComponent(pathname); } catch { /* Keep encoded filename. */ }
  return resolveUploadPath(pathname);
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function reviewEntries(cluster = {}) {
  return [
    ['pelvic_genital', 'pelvic_genital_image_review_result', 'pelvic_genital_image_review_archive'],
    ['head_to_toe', 'head_to_toe_image_review_result', 'head_to_toe_image_review_archive'],
  ].flatMap(([reviewType, resultKey, archiveKey]) => {
    const results = [
      { result: cluster?.[resultKey], archiveIndex: -1 },
      ...(Array.isArray(cluster?.[archiveKey]) ? cluster[archiveKey].map((entry, archiveIndex) => ({ result: entry?.result, archiveIndex })) : []),
    ];
    return results.flatMap(({ result, archiveIndex }) => {
      const reviewed = Array.isArray(result?._meta?.reviewed_images) ? result._meta.reviewed_images : [];
      return reviewed.map((image, index) => ({
        image,
        reviewType,
        resultKey,
        archiveIndex,
        imageId: image?.image_id || image?.id || `${reviewType}_image_${archiveIndex}_${index + 1}`,
      }));
    });
  });
}

function approvedChatEntries(user = {}) {
  const messages = Array.isArray(user?.profile_chat_messages) ? user.profile_chat_messages : [];
  const entries = [];
  for (const message of messages) {
    const attachments = [
      ...(Array.isArray(message?.attachments) ? message.attachments : []),
      ...(Array.isArray(message?.imageAttachments) ? message.imageAttachments : []),
    ];
    for (const attachment of attachments) {
      const approved = attachment?.anatomy_reference_approved === true
        || attachment?.anatomyReferenceApproved === true
        || attachment?.approved_for_anatomy === true
        || attachment?.approvedForAnatomy === true;
      if (!approved) continue;
      entries.push({
        image: { ...attachment, source: attachment.source || 'saved_profile_qa_attachment', anatomy_reference_approved: true },
        reviewType: 'approved_chat',
        resultKey: 'approved_chat_reference',
        imageId: attachment.image_id || attachment.id || `chat_${entries.length + 1}`,
      });
    }
  }
  return entries;
}

export function buildProfileAnatomyImageInventory() {
  const cluster = latestEntity('SessionClusterAnalysis') || {};
  const user = latestEntity('User') || {};
  const rawEntries = [...reviewEntries(cluster), ...approvedChatEntries(user)];
  const seen = new Set();
  return rawEntries.flatMap((entry) => {
    if (!isEligibleProfileAnatomyEvidenceSource(entry.image)) return [];
    const url = sourceUrl(entry.image);
    const filePath = resolveProfilerImageFile(url);
    const exists = Boolean(filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile());
    const hash = exists ? fileHash(filePath) : '';
    const dedupeKey = `${entry.reviewType}:${hash || url}`;
    if (seen.has(dedupeKey)) return [];
    seen.add(dedupeKey);
    const cached = hash ? getProfileAnatomyImageClassification(hash, PROFILE_ANATOMY_CLASSIFICATION_VERSION) : null;
    const inventoryKey = `${entry.reviewType}:${entry.imageId}:${hash || crypto.createHash('sha1').update(url).digest('hex')}`;
    return [{
      inventoryKey,
      reviewType: entry.reviewType,
      resultKey: entry.resultKey,
      imageId: entry.imageId,
      sourceType: profileAnatomyEvidenceSourceKind(entry.image),
      sourceUrl: url,
      filePath,
      fileHash: hash,
      fileExists: exists,
      displayLabel: entry.image.display_label || entry.image.view_label || entry.image.label || entry.image.original_filename || entry.image.filename || entry.imageId,
      referenceImage: referenceImageMetadata(entry.image),
      classificationVersion: PROFILE_ANATOMY_CLASSIFICATION_VERSION,
      classifierModel: cached?.classifierModel || '',
      classifiedAt: cached?.classifiedAt || '',
      classification: cached?.classification || null,
      status: !exists ? 'missing_file' : cached?.classification ? 'indexed' : 'unindexed',
    }];
  });
}

export function publicProfileAnatomyInventory(entries = buildProfileAnatomyImageInventory()) {
  const publicEntries = entries.map(({ filePath: _filePath, ...entry }) => entry);
  return {
    classificationVersion: PROFILE_ANATOMY_CLASSIFICATION_VERSION,
    classifierModel: PROFILE_ANATOMY_CLASSIFIER_MODEL,
    total: publicEntries.length,
    indexed: publicEntries.filter((entry) => entry.status === 'indexed').length,
    unindexed: publicEntries.filter((entry) => entry.status === 'unindexed').length,
    missingFiles: publicEntries.filter((entry) => entry.status === 'missing_file').length,
    estimatedCalls: publicEntries.filter((entry) => entry.status === 'unindexed').length,
    entries: publicEntries,
  };
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

async function classifyEntry(entry, { invoke = aiInvokeInternal, signal } = {}) {
  const prompt = `Inspect this private clinical anatomy reference image once and return structured metadata only.\n\nRules:\n- Identify only anatomy directly visible in the image.\n- Use only the normalized vocabulary allowed by the response schema.\n- Do not infer anatomy hidden by framing, clothing, hands, or devices.\n- A device visible incidentally while anatomy remains the primary subject is incidental_device.\n- A catheter, tubing, bag, procedure, or device as the main subject is device_dominant.\n- best_for_sections must contain only sections this image can directly and clearly support.\n- Keep notes clinical, neutral, concise, and second-person free.\n\nInventory image id: ${entry.imageId}\nSource type: ${entry.sourceType}`;
  const raw = await invoke({
    prompt,
    response_json_schema: classificationSchema,
    model: PROFILE_ANATOMY_CLASSIFIER_MODEL,
    max_tokens: 1800,
    temperature: 0,
    schema_mode: 'strict',
    images: [{
      filename: path.basename(entry.filePath),
      media_type: mimeTypeFor(entry.filePath),
      data: fs.readFileSync(entry.filePath).toString('base64'),
    }],
    signal,
  });
  return normalizeProfileAnatomyClassification(raw, entry);
}

export function selectProfileAnatomyIndexEntries(entries, payload = {}) {
  const mode = String(payload.mode || 'unclassified');
  const selectedKey = String(payload.inventoryKey || '');
  const requestedAt = String(payload.requestedAt || '');
  return entries.filter((entry) => {
    if (!entry.fileExists || !entry.fileHash) return false;
    if (mode === 'selected') return entry.inventoryKey === selectedKey && (!requestedAt || String(entry.classifiedAt || '') < requestedAt);
    if (mode === 'all') return !requestedAt || String(entry.classifiedAt || '') < requestedAt;
    return entry.status === 'unindexed';
  });
}

export async function runProfileAnatomyImageIndex(payload = {}, context = {}, dependencies = {}) {
  if (payload.confirmCredits !== true) {
    throw new Error('Profiler anatomy indexing requires explicit confirmation that Claude credits will be used.');
  }
  const inventory = dependencies.entries || buildProfileAnatomyImageInventory();
  const selected = selectProfileAnatomyIndexEntries(inventory, payload);
  let completed = 0;
  let failed = 0;
  const failures = [];
  context.updateProgress?.({ stage: 'indexing', current: 0, total: selected.length, message: `${selected.length} image classifications queued.` });
  for (const entry of selected) {
    if (context.signal?.aborted) throw new Error('Cancelled');
    try {
      context.updateProgress?.({ stage: 'indexing', current: completed, total: selected.length, message: `Classifying ${entry.displayLabel}...`, current_image: entry.imageId });
      const classification = await classifyEntry(entry, { invoke: dependencies.invoke || aiInvokeInternal, signal: context.signal });
      (dependencies.save || upsertProfileAnatomyImageClassification)({
        fileHash: entry.fileHash,
        classificationVersion: PROFILE_ANATOMY_CLASSIFICATION_VERSION,
        imageId: entry.imageId,
        sourceType: entry.sourceType,
        sourceUrl: entry.sourceUrl,
        classifierModel: PROFILE_ANATOMY_CLASSIFIER_MODEL,
        classifiedAt: nowIso(),
        classification,
      });
      completed += 1;
    } catch (error) {
      failed += 1;
      failures.push({ imageId: entry.imageId, inventoryKey: entry.inventoryKey, error: error?.message || String(error) });
    }
    context.updateProgress?.({ stage: 'indexing', current: completed + failed, total: selected.length, message: `${completed} completed, ${failed} failed.`, completed, failed, remaining: selected.length - completed - failed });
  }
  return {
    completed,
    failed,
    skippedCached: Math.max(0, inventory.filter((entry) => entry.status === 'indexed').length - selected.filter((entry) => entry.status === 'indexed').length),
    requested: selected.length,
    failures,
    inventory: publicProfileAnatomyInventory(dependencies.entries ? inventory : buildProfileAnatomyImageInventory()),
  };
}
