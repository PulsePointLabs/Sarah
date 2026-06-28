import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildManifestVisualTimeline,
  createReviewEvidenceManifest,
  createReviewEvidenceManifestWithFallback,
  validateManifestTimelineIntegrity,
  validateReviewEvidenceManifest,
  validateVisualTimeline,
} from './profileAnatomyVideoRenderer.js';
import {
  buildProfileAnatomyEvidenceItem,
  filterProfileAnatomyReviewEvidence,
  isEligibleProfileAnatomyEvidenceSource,
  profileAnatomyDeviceClassification,
  applyProfileAnatomyIndexToResult,
  selectIndexedProfileAnatomyEvidence,
} from '../../src/lib/profileAnatomyEvidence.js';

function classifiedImage(id, anatomy, sections, options = {}) {
  return {
    id,
    image_id: id,
    label: options.label || id,
    display_label: options.label || id,
    url: `/uploads/${id}.jpg`,
    preview_url: `/uploads/${id}.jpg`,
    source: 'profile_review_image',
    anatomy_classification: {
      visible_anatomy: anatomy,
      fine_structures: options.fineStructures || [],
      laterality: options.laterality || ['midline'],
      positions: options.positions || ['close_up'],
      device_classification: options.deviceClassification || 'none',
      device_types: options.deviceTypes || [],
      device_is_primary_subject: options.deviceClassification === 'device_dominant',
      quality: options.quality || { overall: 'good', focus: 'good', lighting: 'good', anatomy_visibility: 'good' },
      best_for_sections: sections,
      combined_view_strengths: options.combined || [],
      notes: options.notes || 'Indexed anatomy reference.',
    },
  };
}

test('saved classifications deterministically select penis, foreskin, anus, back, and right inguinal evidence', () => {
  const images = [
    classifiedImage('penis-only', ['penis', 'penile_shaft'], ['penis']),
    classifiedImage('foreskin-forward', ['penis', 'foreskin', 'foreskin_forward'], ['foreskin']),
    classifiedImage('combined', ['penis', 'penile_shaft', 'foreskin', 'foreskin_forward'], ['penis', 'foreskin', 'penis_and_foreskin'], { combined: ['penis_and_foreskin'], quality: { overall: 'excellent', focus: 'excellent', lighting: 'good', anatomy_visibility: 'excellent' } }),
    classifiedImage('anus', ['anus', 'anal_margin', 'perianal_region'], ['anal_opening_perianal_region']),
    classifiedImage('back', ['posterior_torso', 'thoracic_back', 'lumbar_back'], ['posterior_torso_back']),
    classifiedImage('right-inguinal', ['right_inguinal_region', 'inguinal_repair_scar'], ['right_inguinal_repair', 'inguinal_folds_groin_skin'], { laterality: ['right'] }),
  ];
  assert.equal(selectIndexedProfileAnatomyEvidence(images, { sectionKey: 'penis' })[0].image.id, 'combined');
  assert.equal(selectIndexedProfileAnatomyEvidence(images, { sectionKey: 'foreskin' })[0].image.id, 'combined');
  assert.equal(selectIndexedProfileAnatomyEvidence(images, { sectionKey: 'penis_and_foreskin' })[0].image.id, 'combined');
  assert.equal(selectIndexedProfileAnatomyEvidence(images, { sectionKey: 'anal_opening_perianal_region' })[0].image.id, 'anus');
  assert.equal(selectIndexedProfileAnatomyEvidence(images, { sectionKey: 'posterior_torso_back' })[0].image.id, 'back');
  assert.equal(selectIndexedProfileAnatomyEvidence(images, { sectionKey: 'right_inguinal_repair' })[0].image.id, 'right-inguinal');
});

test('incidental device remains anatomy eligible while device-dominant evidence is restricted', () => {
  const incidental = classifiedImage('incidental', ['penis', 'foreskin'], ['penis'], { deviceClassification: 'incidental_device', deviceTypes: ['foley'] });
  const dominant = classifiedImage('dominant', ['penis'], ['penis', 'device_contact_findings'], { deviceClassification: 'device_dominant', deviceTypes: ['foley'] });
  assert.ok(selectIndexedProfileAnatomyEvidence([incidental], { sectionKey: 'penis' })[0]);
  assert.equal(selectIndexedProfileAnatomyEvidence([dominant], { sectionKey: 'penis' }).length, 0);
  assert.ok(selectIndexedProfileAnatomyEvidence([dominant], { sectionKey: 'device_contact_findings' })[0]);
});

test('static review mapping preserves original annotation image IDs and dimensions', () => {
  const result = {
    _meta: { reviewed_images: [{ image_id: 'img_025', preview_url: '/uploads/img-025.jpg', width: 1200, height: 1600, source: 'profile_review_image' }] },
    annotated_images: [{ image_id: 'img_025', image_width: 1200, image_height: 1600, callouts: [{ x: 0.25, y: 0.4 }] }],
  };
  const classification = classifiedImage('img_025', ['pubic_mound', 'lower_abdomen', 'penis'], ['pubic_mound_lower_abdomen']).anatomy_classification;
  const mapped = applyProfileAnatomyIndexToResult(result, { entries: [{ reviewType: 'pelvic_genital', imageId: 'img_025', sourceUrl: '/uploads/img-025.jpg', fileHash: 'abc', classificationVersion: 'v1', classification }] }, 'pelvic_genital');
  assert.equal(mapped._meta.reviewed_images[0].image_id, 'img_025');
  assert.equal(mapped._meta.reviewed_images[0].width, 1200);
  assert.deepEqual(mapped.annotated_images, result.annotated_images);
});

test('video manifest and static selector agree on saved combined-view evidence', () => {
  const images = [
    classifiedImage('combined', ['penis', 'penile_shaft', 'foreskin', 'foreskin_forward'], ['penis_and_foreskin'], { combined: ['penis_and_foreskin'] }),
    classifiedImage('penis-only', ['penis', 'penile_shaft'], ['penis']),
  ];
  const manifest = createReviewEvidenceManifest({
    reviewId: 'indexed-combined', title: 'Pelvic review', reviewScope: 'pelvic_genital',
    paragraphs: ['Penis and Foreskin', 'Your penis and foreskin are directly visible.'],
    paragraphMeta: [
      { type: 'section-title', section_key: 'penis_and_foreskin', section_label: 'Penis and Foreskin' },
      { type: 'section', section_key: 'penis_and_foreskin', section_label: 'Penis and Foreskin' },
    ],
    images,
  });
  const staticId = selectIndexedProfileAnatomyEvidence(images, { sectionKey: 'penis_and_foreskin' })[0].image.id;
  assert.equal(staticId, 'combined');
  assert.equal(manifest.sections[0].assigned_evidence[0]?.evidence_id, staticId);
  assert.doesNotThrow(() => validateReviewEvidenceManifest(manifest));
});

test('complete payload manifest does not scan historical media during normal render', () => {
  let historicalLoads = 0;
  const { manifest, usedHistoricalFallback } = createReviewEvidenceManifestWithFallback({
    reviewId: 'longitudinal-pelvic-follow-up',
    title: 'Pelvic and Genital Review',
    reviewScope: 'pelvic_genital',
    paragraphs: [
      'Pubic Mound and Lower Abdomen',
      'The pubic mound and lower abdomen remain stable.',
      'Foreskin',
      'The foreskin remains intact.',
      'Glans and Meatus',
      'The glans and meatus remain intact.',
      'Perineum',
      'The perineal skin remains intact.',
    ],
    paragraphMeta: [
      { type: 'section-title', section_key: 'pubic_mound_lower_abdomen', section_label: 'Pubic Mound and Lower Abdomen' },
      { type: 'section', section_key: 'pubic_mound_lower_abdomen', section_label: 'Pubic Mound and Lower Abdomen' },
      { type: 'section-title', section_key: 'foreskin', section_label: 'Foreskin' },
      { type: 'section', section_key: 'foreskin', section_label: 'Foreskin' },
      { type: 'section-title', section_key: 'glans_meatus', section_label: 'Glans and Meatus' },
      { type: 'section', section_key: 'glans_meatus', section_label: 'Glans and Meatus' },
      { type: 'section-title', section_key: 'perineum', section_label: 'Perineum' },
      { type: 'section', section_key: 'perineum', section_label: 'Perineum' },
    ],
    images: [
      { id: 'pubic-reference', label: 'Validated pubic mound lower abdomen reference', coverage: 'pubic mound lower abdomen suprapubic', sectionKey: 'pubic_mound_lower_abdomen', url: '/uploads/pubic.jpg', source: 'fresh_upload' },
      { id: 'foreskin-reference', label: 'Validated foreskin close-up', coverage: 'foreskin prepuce penile shaft', sectionKey: 'foreskin', url: '/uploads/foreskin.jpg', source: 'fresh_upload' },
      { id: 'glans-reference', label: 'Validated glans meatus close-up', coverage: 'glans meatus urethral opening', sectionKey: 'glans_meatus', url: '/uploads/glans.jpg', source: 'fresh_upload' },
      { id: 'perineum-reference', label: 'Validated posterior inferior perineal view', coverage: 'perineum perineal body perineal raphe', sectionKey: 'perineum', url: '/uploads/perineum.jpg', source: 'fresh_upload' },
    ],
    loadHistoricalImages: () => {
      historicalLoads += 1;
      return [];
    },
  });
  assert.equal(historicalLoads, 0);
  assert.equal(usedHistoricalFallback, false);
  assert.equal(manifest.sections.every((section) => section.assigned_evidence.length > 0), true);
  assert.doesNotThrow(() => validateReviewEvidenceManifest(manifest));
});

test('head-to-toe follow-up keeps relevant genital evidence in its normal anatomy lane', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'head-to-toe-genital-follow-up',
    title: 'Head-to-Toe Review',
    reviewScope: 'head_to_toe',
    paragraphs: ['Genitals and Perineum', 'Genital and perineal anatomy remains represented in the current chart.'],
    paragraphMeta: [
      { type: 'section-title', section_key: 'genitals_perineum', section_label: 'Genitals and Perineum' },
      { type: 'section', section_key: 'genitals_perineum', section_label: 'Genitals and Perineum' },
    ],
    images: [{
      id: 'validated-genital-reference',
      label: 'Validated genital and perineal reference',
      coverage: 'pelvis pubic region genitals perineum scrotum penis',
      sectionKey: 'genitals_perineum',
      url: '/uploads/genital-reference.jpg',
      source: 'fresh_upload',
    }],
  });
  const section = manifest.sections.find((item) => item.section_key === 'genitals_perineum');
  assert.equal(section.assigned_evidence[0]?.evidence_id, 'validated-genital-reference');
  assert.doesNotThrow(() => validateReviewEvidenceManifest(manifest));
});

test('validated visual callout image stays synchronized with its measured narration segment', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'pelvic-callout-sync',
    title: 'Pelvic and Genital Review',
    reviewScope: 'pelvic_genital',
    paragraphs: [
      'Foreskin',
      'The foreskin and preputial margin are directly visible in this annotated view.',
      'The foreskin remains intact without visible irritation.',
    ],
    paragraphMeta: [
      { type: 'section-title', section_key: 'foreskin', section_label: 'Foreskin' },
      { type: 'visual-callout', section_key: 'foreskin', section_label: 'Foreskin', evidence_image_ids: ['foreskin-validated'] },
      { type: 'section', section_key: 'foreskin', section_label: 'Foreskin' },
    ],
    images: [
      { id: 'foreskin-other', label: 'Foreskin reference view', coverage: 'foreskin prepuce', sectionKey: 'foreskin', url: '/uploads/foreskin-other.jpg', source: 'fresh_upload' },
      { id: 'foreskin-validated', label: 'Validated annotated foreskin view', coverage: 'foreskin prepuce coronal sulcus', sectionKey: 'foreskin', url: '/uploads/foreskin-validated.jpg', source: 'fresh_upload' },
    ],
  });
  const calloutSection = manifest.sections.find((section) => section.preferred_evidence_ids?.includes('foreskin-validated'));
  assert.ok(calloutSection);
  assert.equal(calloutSection.assigned_evidence.length, 1);
  assert.equal(calloutSection.assigned_evidence[0].evidence_id, 'foreskin-validated');
  assert.match(calloutSection.narration_text, /annotated view/i);
  assert.doesNotThrow(() => validateReviewEvidenceManifest(manifest));
});

test('validated preferred evidence survives generic upload labeling for its exact anatomy section', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'validated-generic-penis-reference',
    title: 'Pelvic/Genital Anatomy Video',
    reviewScope: 'pelvic_genital',
    paragraphs: ['Penis', 'Your penile shaft skin remains intact.', 'Clinical reference view.'],
    paragraphMeta: [
      { type: 'section-title', section_key: 'penis', section_label: 'Penis' },
      { type: 'paragraph', section_key: 'penis', section_label: 'Penis' },
      { type: 'visual-callout', section_key: 'penis', section_label: 'Penis', evidence_image_ids: ['validated-penis'] },
    ],
    images: [{
      id: 'validated-penis',
      display_label: 'Clinical reference view',
      sectionKey: 'penis',
      section: 'Penis',
      url: '/uploads/validated-penis.jpg',
      source: 'profile_review_image',
    }],
  });

  const calloutSection = manifest.sections.find((section) => section.preferred_evidence_ids?.includes('validated-penis'));
  assert.ok(calloutSection);
  assert.deepEqual(calloutSection.explicitly_assigned_evidence_ids, ['validated-penis']);
  assert.equal(validateReviewEvidenceManifest(manifest), true);
});

test('validated preferred evidence still rejects an explicitly conflicting fine structure', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'validated-conflicting-reference',
    title: 'Pelvic/Genital Anatomy Video',
    reviewScope: 'pelvic_genital',
    paragraphs: ['Foreskin', 'Your foreskin remains fully retractable.', 'Perineum close-up.'],
    paragraphMeta: [
      { type: 'section-title', section_key: 'foreskin', section_label: 'Foreskin' },
      { type: 'paragraph', section_key: 'foreskin', section_label: 'Foreskin' },
      { type: 'visual-callout', section_key: 'foreskin', section_label: 'Foreskin', evidence_image_ids: ['wrong-perineum'] },
    ],
    images: [{
      id: 'wrong-perineum',
      display_label: 'Perineum close-up',
      sectionKey: 'foreskin',
      section: 'Foreskin',
      url: '/uploads/wrong-perineum.jpg',
      source: 'profile_review',
    }],
  });

  const calloutSection = manifest.sections.find((section) => section.preferred_evidence_ids?.includes('wrong-perineum'));
  assert.ok(calloutSection);
  assert.deepEqual(calloutSection.explicitly_assigned_evidence_ids, []);
});

const images = [
  {
    id: 'head-face-current',
    label: 'Current head and face view with hair, glasses, beard, scalp, and face visible',
    coverage: 'head face scalp beard glasses',
    sectionKey: 'head_face',
    url: '/uploads/head.jpg',
    source: 'fresh_upload',
  },
  {
    id: 'body-current',
    label: 'Current broad full body standing posture view',
    coverage: 'full body whole body standing posture alignment chest abdomen lower limbs feet',
    sectionKey: 'posture_alignment',
    url: '/uploads/body.jpg',
    source: 'fresh_upload',
  },
  {
    id: 'feet-only',
    label: 'Foot-only image showing toes ankles and dorsal feet',
    coverage: 'feet toes ankle heel plantar dorsal foot',
    sectionKey: 'feet_toes',
    url: '/uploads/feet.jpg',
    source: 'fresh_upload',
  },
  {
    id: 'pelvic-genital-current',
    label: 'Current pelvic genital view with pubic groin penile shaft glans meatus scrotum perineum visible',
    coverage: 'pelvic pubic groin penis penile shaft glans meatus scrotum testes perineum',
    sectionKey: 'genitals_perineum',
    url: '/uploads/pelvic.jpg',
    source: 'fresh_upload',
  },
  {
    id: 'foley-bag',
    label: 'Foley drainage bag with concentrated urine and tubing',
    coverage: 'foley catheter drainage bag urine tubing device procedure',
    sectionKey: 'device_contact_findings',
    url: '/uploads/foley.jpg',
    source: 'fresh_upload',
  },
];

function buildManifest(reviewScope = 'head_to_toe') {
  const paragraphs = [
    'Head-to-Toe Image Review',
    'Head and Face',
    'Short hair, glasses, goatee, and facial contour are assessed here.',
    'Feet and Toes',
    'Feet, toes, and ankles are assessed here.',
    'Pelvic and Genital',
    'Glans, meatus, shaft, scrotum, and perineum are assessed here.',
    'Device and Procedure Context',
    'Foley catheter, drainage bag, tubing, and device contact are assessed here.',
    'No Focused Image Section',
    'Ears are mentioned but no focused ear image exists.',
  ];
  const paragraphMeta = [
    { type: 'title', displayLabel: 'Head-to-Toe Image Review' },
    { type: 'section-title', section_key: 'head_face', section_label: 'Head and Face' },
    { type: 'section', section_key: 'head_face', section_label: 'Head and Face' },
    { type: 'section-title', section_key: 'feet_toes', section_label: 'Feet and Toes' },
    { type: 'section', section_key: 'feet_toes', section_label: 'Feet and Toes' },
    { type: 'section-title', section_key: 'glans_meatus', section_label: 'Pelvic and Genital' },
    { type: 'section', section_key: 'glans_meatus', section_label: 'Pelvic and Genital' },
    { type: 'section-title', section_key: 'device_contact_findings', section_label: 'Device and Procedure Context' },
    { type: 'section', section_key: 'device_contact_findings', section_label: 'Device and Procedure Context' },
    { type: 'section-title', section_key: 'ears', section_label: 'No Focused Image Section' },
    { type: 'section', section_key: 'ears', section_label: 'No Focused Image Section' },
  ];
  return createReviewEvidenceManifest({
    reviewId: 'fixture-review',
    title: 'Fixture Anatomy Video',
    paragraphs,
    paragraphMeta,
    images,
    reviewScope,
  });
}

test('head and face section never receives Foley, foot, or genital evidence', () => {
  const manifest = buildManifest();
  const head = manifest.sections.find((section) => section.section_key === 'head_face');
  assert.equal(head.assigned_evidence[0].evidence_id, 'head-face-current');
  assert.deepEqual(head.assigned_evidence[0].anatomy_labels.includes('feet_toes'), false);
  assert.deepEqual(head.assigned_evidence[0].anatomy_labels.includes('genitals_perineum'), false);
  assert.equal(head.assigned_evidence[0].device_related, false);
});

test('pelvic or genital section rejects foot-only media and uses compatible genital evidence', () => {
  const manifest = buildManifest('pelvic_genital');
  const genital = manifest.sections.find((section) => section.section_key === 'glans_meatus');
  assert.equal(genital.assigned_evidence[0].evidence_id, 'pelvic-genital-current');
  assert.equal(genital.assigned_evidence[0].anatomy_labels.includes('feet_toes'), false);
});

test('perineum section accepts the saved posterior-inferior perineal reference', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'saved-perineum-fixture',
    title: 'Pelvic and Genital Review',
    reviewScope: 'pelvic_genital',
    paragraphs: [
      'Perineum',
      'The perineal body and raphe are directly visible with intact skin.',
    ],
    paragraphMeta: [
      { type: 'section-title', section_key: 'perineum', section_label: 'Perineum' },
      { type: 'section', section_key: 'perineum', section_label: 'Perineum' },
    ],
    images: [{
      id: 'img-040-perineum',
      label: 'Posterior-inferior seated close-up - perineum, anal verge, scrotal base, proximal gluteal surfaces',
      coverage: 'Perineal body with midline raphe, anal verge and perianal skin, inferior scrotal surface and scrotal-perineal transition. No device visible.',
      sectionKey: 'perineum',
      url: '/uploads/perineum.jpg',
      source: 'profile_review_image',
    }],
  });
  const perineum = manifest.sections.find((section) => section.section_key === 'perineum');
  assert.equal(perineum.media_mode, 'assigned_evidence');
  assert.equal(perineum.assigned_evidence[0].evidence_id, 'img-040-perineum');
  assert.doesNotThrow(() => validateReviewEvidenceManifest(manifest));
});

test('foreskin section rejects a perineal image whose archive coverage only mentions foreskin', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'foreskin-direct-label-fixture',
    title: 'Pelvic and Genital Review',
    reviewScope: 'pelvic_genital',
    paragraphs: ['Foreskin', 'The foreskin and preputial mobility are directly reviewed.'],
    paragraphMeta: [
      { type: 'section-title', section_key: 'foreskin', section_label: 'Foreskin' },
      { type: 'section', section_key: 'foreskin', section_label: 'Foreskin' },
    ],
    images: [
      {
        id: 'perineum-with-archive-summary',
        label: 'Posterior-inferior perineal body and gluteal view',
        coverage: 'Cumulative review mentions foreskin, glans, shaft, scrotum, perineum and anal region.',
        sectionKey: 'perineum',
        url: '/uploads/perineum.jpg',
        source: 'profile_review_image',
      },
      {
        id: 'foreskin-closeup',
        label: 'Close-up foreskin and preputial margin with partial retraction',
        coverage: 'Foreskin mobility and preputial tissue are directly visible.',
        sectionKey: 'foreskin',
        url: '/uploads/foreskin.jpg',
        source: 'profile_review_image',
      },
    ],
  });
  const section = manifest.sections.find((item) => item.section_key === 'foreskin');
  assert.equal(section.assigned_evidence[0].evidence_id, 'foreskin-closeup');
  assert.equal(section.assignment_candidates.find((item) => item.id === 'perineum-with-archive-summary')?.score, -1000);
});

test('perineum section rejects a foreskin close-up whose archive coverage only mentions perineum', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'perineum-direct-label-fixture',
    title: 'Pelvic and Genital Review',
    reviewScope: 'pelvic_genital',
    paragraphs: ['Perineum', 'The perineal body and surrounding skin are directly reviewed.'],
    paragraphMeta: [
      { type: 'section-title', section_key: 'perineum', section_label: 'Perineum' },
      { type: 'section', section_key: 'perineum', section_label: 'Perineum' },
    ],
    images: [
      {
        id: 'foreskin-with-archive-summary',
        label: 'Close-up foreskin and glans with full retraction',
        coverage: 'Cumulative review mentions foreskin, glans, shaft, scrotum, perineum and anal region.',
        sectionKey: 'foreskin',
        url: '/uploads/foreskin.jpg',
        source: 'profile_review_archive',
      },
      {
        id: 'perineum-closeup',
        label: 'Posterior-inferior perineal body and scrotal-base view',
        coverage: 'Perineal body is directly visible.',
        sectionKey: 'perineum',
        url: '/uploads/perineum.jpg',
        source: 'profile_review_image',
      },
    ],
  });
  const section = manifest.sections.find((item) => item.section_key === 'perineum');
  assert.equal(section.assigned_evidence[0].evidence_id, 'perineum-closeup');
  assert.equal(section.assignment_candidates.find((item) => item.id === 'foreskin-with-archive-summary')?.score, -1000);
});

test('pelvic review accepts an anal close-up with incidental thighs and a positioning hand', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'anal-incidental-limbs-fixture',
    title: 'Pelvic and Genital Review',
    reviewScope: 'pelvic_genital',
    paragraphs: ['Anal Opening and Perianal Region', 'The anal opening, perianal skin, and surrounding gluteal surfaces are directly reviewed.'],
    paragraphMeta: [
      { type: 'section-title', section_key: 'anal_opening_perianal_region', section_label: 'Anal Opening and Perianal Region' },
      { type: 'section', section_key: 'anal_opening_perianal_region', section_label: 'Anal Opening and Perianal Region' },
    ],
    images: [{
      id: 'anal-with-positioning',
      label: 'Posterior close-up of anal opening, perianal skin, perineum, proximal inner thighs and positioning hand',
      coverage: 'Anal verge, perianal skin, gluteal cleft, perineal body and proximal thighs are visible.',
      sectionKey: 'anal_opening_perianal_region',
      url: '/uploads/anal.jpg',
      source: 'fresh_upload',
    }],
  });
  const section = manifest.sections.find((item) => item.section_key === 'anal_opening_perianal_region');
  assert.equal(section.media_mode, 'assigned_evidence');
  assert.equal(section.assigned_evidence[0].evidence_id, 'anal-with-positioning');
});

test('pelvic review still rejects true distal lower-limb evidence', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'pelvic-distal-limb-decoy-fixture',
    title: 'Pelvic and Genital Review',
    reviewScope: 'pelvic_genital',
    paragraphs: ['Perineum', 'The perineal body and surrounding skin are directly reviewed.'],
    paragraphMeta: [
      { type: 'section-title', section_key: 'perineum', section_label: 'Perineum' },
      { type: 'section', section_key: 'perineum', section_label: 'Perineum' },
    ],
    images: [{
      id: 'perineum-foot-decoy',
      label: 'Lower-body view mentioning the perineum with feet, toes, ankles, calves and knees dominant',
      coverage: 'Feet toes ankles calves knees lower legs; perineum is not directly visible.',
      sectionKey: 'limitations_future_coverage',
      url: '/uploads/feet.jpg',
      source: 'fixture',
    }],
  });
  const section = manifest.sections.find((item) => item.section_key === 'perineum');
  assert.equal(section.media_mode, 'placeholder');
  assert.equal(section.assigned_evidence.length, 0);
});

test('mixed tissue-health section accepts safe pelvic evidence without forcing one narrated structure', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'mixed-tissue-health-fixture',
    title: 'Pelvic and Genital Review',
    reviewScope: 'pelvic_genital',
    paragraphs: [
      'Tissue Health / Safety Observations',
      'The glans, foreskin, shaft, scrotum, perineum, and surrounding skin show no visible tissue breakdown.',
    ],
    paragraphMeta: [
      { type: 'section-title', section_key: 'tissue_health_safety_observations', section_label: 'Tissue Health / Safety Observations' },
      { type: 'section', section_key: 'tissue_health_safety_observations', section_label: 'Tissue Health / Safety Observations' },
    ],
    images: [{
      id: 'safe-pelvic-reference',
      label: 'Semi-reclined pelvic and genital reference view',
      coverage: 'Pelvic and genital skin surfaces are directly visible.',
      sectionKey: 'genitals_perineum',
      url: '/uploads/safe-pelvic-reference.jpg',
      source: 'profile_review_image',
    }],
  });
  const section = manifest.sections.find((item) => item.section_key === 'tissue_health_safety_observations');
  assert.equal(section.media_mode, 'assigned_evidence');
  assert.equal(section.assigned_evidence[0].evidence_id, 'safe-pelvic-reference');
});

test('pubic section accepts directly labeled anatomy when a Foley is incidental', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'pubic-incidental-device-fixture',
    title: 'Pelvic and Genital Review',
    reviewScope: 'pelvic_genital',
    paragraphs: ['Pubic Mound and Lower Abdomen', 'The pubic mound, suprapubic skin, lower abdomen, and inguinal folds are directly reviewed.'],
    paragraphMeta: [
      { type: 'section-title', section_key: 'pubic_mound_lower_abdomen', section_label: 'Pubic Mound and Lower Abdomen' },
      { type: 'section', section_key: 'pubic_mound_lower_abdomen', section_label: 'Pubic Mound and Lower Abdomen' },
    ],
    images: [{
      id: 'pubic-with-foley',
      label: 'Wide-field pubic mound, suprapubic lower abdomen and inguinal folds with Foley tubing visible',
      coverage: 'Pubic mound lower abdomen groin and inguinal skin are directly visible; Foley tubing is incidental.',
      sectionKey: 'pubic_mound_lower_abdomen',
      url: '/uploads/pubic-foley.jpg',
      source: 'fresh_upload',
    }],
  });
  const section = manifest.sections.find((item) => item.section_key === 'pubic_mound_lower_abdomen');
  assert.equal(section.media_mode, 'assigned_evidence');
  assert.equal(section.assigned_evidence[0].evidence_id, 'pubic-with-foley');
});

test('pubic section accepts the verified legacy abdominal reference label', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'legacy-abdominal-reference-fixture',
    title: 'Pelvic and Genital Review',
    reviewScope: 'pelvic_genital',
    paragraphs: ['Pubic Mound and Lower Abdomen', 'The pubic mound and lower abdominal skin are directly reviewed.'],
    paragraphMeta: [
      { type: 'section-title', section_key: 'pubic_mound_lower_abdomen', section_label: 'Pubic Mound and Lower Abdomen' },
      { type: 'section', section_key: 'pubic_mound_lower_abdomen', section_label: 'Pubic Mound and Lower Abdomen' },
    ],
    images: [
      {
        id: 'verified-abdominal-reference',
        label: 'Abdominal reference view',
        coverage: 'Lower abdomen, suprapubic skin and pubic mound are directly visible.',
        sectionKey: 'pubic_mound_lower_abdomen',
        url: '/uploads/verified-abdominal-reference.jpg',
        source: 'profile_review_image',
      },
      {
        id: 'penile-base-decoy',
        label: 'Inferior seated view, scrotal and penile base, foreskin-covered flaccid state',
        coverage: 'Penile base and scrotum are visible; lower abdomen and pubic mound are outside the frame.',
        sectionKey: 'penis',
        url: '/uploads/penile-base.jpg',
        source: 'profile_review_archive',
      },
    ],
  });
  const section = manifest.sections.find((item) => item.section_key === 'pubic_mound_lower_abdomen');
  assert.equal(section.assigned_evidence[0].evidence_id, 'verified-abdominal-reference');
  assert.equal(section.assigned_evidence.length, 1);
});

test('pubic mound section refuses genital close-up evidence', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'pubic-fixture-review',
    title: 'Pelvic and Genital Review',
    reviewScope: 'pelvic_genital',
    paragraphs: [
      'Pubic Mound and Lower Abdomen',
      'The pubic mound, lower abdomen, inguinal folds, and groin skin are assessed here.',
    ],
    paragraphMeta: [
      { type: 'section-title', section_key: 'pubic_mound_lower_abdomen', section_label: 'Pubic Mound and Lower Abdomen' },
      { type: 'section', section_key: 'pubic_mound_lower_abdomen', section_label: 'Pubic Mound and Lower Abdomen' },
    ],
    images: [
      {
        id: 'genital-closeup-only',
        label: 'Close-up genital image showing penis shaft, glans, and meatus',
        coverage: 'penis penile shaft glans meatus foreskin',
        sectionKey: 'genitals_perineum',
        url: '/uploads/genital-closeup.jpg',
        source: 'fresh_upload',
      },
      {
        id: 'pubic-mound-view',
        label: 'Focused pubic mound and groin skin view',
        coverage: 'pubic mound lower abdomen inguinal folds groin skin penile base',
        sectionKey: 'pubic_mound_lower_abdomen',
        url: '/uploads/pubic-mound.jpg',
        source: 'fresh_upload',
      },
    ],
  });

  const pubic = manifest.sections.find((section) => section.section_key === 'pubic_mound_lower_abdomen');
  assert.equal(pubic.assigned_evidence[0].evidence_id, 'pubic-mound-view');
  assert.equal(
    pubic.assignment_candidates.find((candidate) => candidate.id === 'genital-closeup-only')?.score,
    -1000
  );
});

test('pubic mound section uses a card instead of unrelated genital close-up when no pubic evidence exists', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'pubic-missing-fixture-review',
    title: 'Pelvic and Genital Review',
    reviewScope: 'pelvic_genital',
    paragraphs: [
      'Pubic Mound and Lower Abdomen',
      'The pubic mound and lower abdomen are assessed here.',
    ],
    paragraphMeta: [
      { type: 'section-title', section_key: 'pubic_mound_lower_abdomen', section_label: 'Pubic Mound and Lower Abdomen' },
      { type: 'section', section_key: 'pubic_mound_lower_abdomen', section_label: 'Pubic Mound and Lower Abdomen' },
    ],
    images: [
      {
        id: 'genital-closeup-only',
        label: 'Close-up genital image showing penis shaft, glans, and meatus',
        coverage: 'penis penile shaft glans meatus foreskin',
        sectionKey: 'genitals_perineum',
        url: '/uploads/genital-closeup.jpg',
        source: 'fresh_upload',
      },
    ],
  });

  const pubic = manifest.sections.find((section) => section.section_key === 'pubic_mound_lower_abdomen');
  assert.equal(pubic.media_mode, 'placeholder');
  assert.deepEqual(pubic.explicitly_assigned_evidence_ids, []);
});

test('head-to-toe chest section uses a card instead of wrong-region feet evidence', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'head-to-toe-wrong-region-fixture',
    title: 'Head-to-Toe Image Review',
    reviewScope: 'head_to_toe',
    paragraphs: [
      'Chest',
      'The chest, sternum, pectoral contour, and anterior thorax are assessed here.',
    ],
    paragraphMeta: [
      { type: 'section-title', section_key: 'chest', section_label: 'Chest' },
      { type: 'section', section_key: 'chest', section_label: 'Chest' },
    ],
    images: [
      {
        id: 'feet-only',
        label: 'Foot-only image showing toes ankles and dorsal feet',
        coverage: 'feet toes ankle heel plantar dorsal foot',
        sectionKey: 'feet_toes',
        url: '/uploads/feet.jpg',
        source: 'fresh_upload',
      },
    ],
  });

  const chest = manifest.sections.find((section) => section.section_key === 'chest');
  assert.equal(chest.media_mode, 'placeholder');
  assert.deepEqual(chest.explicitly_assigned_evidence_ids, []);
});

test('head-to-toe head section uses a card instead of pelvic or genital evidence', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'head-to-toe-head-pelvic-mismatch-fixture',
    title: 'Head-to-Toe Image Review',
    reviewScope: 'head_to_toe',
    paragraphs: [
      'Head and Face',
      'Hair, scalp, facial contour, and face-specific findings are assessed here.',
      'Pelvic and Genital',
      'Pubic, genital, scrotal, and perineal findings are assessed here.',
    ],
    paragraphMeta: [
      { type: 'section-title', section_key: 'head_face', section_label: 'Head and Face' },
      { type: 'section', section_key: 'head_face', section_label: 'Head and Face' },
      { type: 'section-title', section_key: 'genitals_perineum', section_label: 'Pelvic and Genital' },
      { type: 'section', section_key: 'genitals_perineum', section_label: 'Pelvic and Genital' },
    ],
    images: [
      {
        id: 'pelvic-only',
        label: 'Current pelvic genital view with pubic groin penile shaft glans meatus scrotum perineum visible',
        coverage: 'pelvic pubic groin penis penile shaft glans meatus scrotum testes perineum',
        sectionKey: 'genitals_perineum',
        url: '/uploads/pelvic.jpg',
        source: 'fresh_upload',
      },
    ],
  });

  const head = manifest.sections.find((section) => section.section_key === 'head_face');
  const genital = manifest.sections.find((section) => section.section_key === 'genitals_perineum');
  assert.equal(head.media_mode, 'placeholder');
  assert.deepEqual(head.explicitly_assigned_evidence_ids, []);
  assert.equal(genital.assigned_evidence[0].evidence_id, 'pelvic-only');
  validateReviewEvidenceManifest(manifest);
});

test('head-to-toe head section can crop from broad full-body evidence without rejecting visible pelvis labels', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'head-to-toe-broad-body-head-fixture',
    title: 'Head-to-Toe Image Review',
    reviewScope: 'head_to_toe',
    paragraphs: [
      'Head and Face',
      'Hair, scalp, facial contour, and face-specific findings are assessed here.',
    ],
    paragraphMeta: [
      { type: 'section-title', section_key: 'head_face', section_label: 'Head and Face' },
      { type: 'section', section_key: 'head_face', section_label: 'Head and Face' },
    ],
    images: [
      {
        id: 'full-body-with-head-and-pelvis',
        label: 'Full body standing reference with head face chest abdomen pelvis and feet visible',
        coverage: 'whole body full body posture head face chest abdomen pelvis pubic lower limbs feet',
        sectionKey: 'posture_alignment',
        url: '/uploads/full-body.jpg',
        source: 'fresh_upload',
      },
    ],
  });

  const head = manifest.sections.find((section) => section.section_key === 'head_face');
  assert.equal(head.assigned_evidence[0].evidence_id, 'full-body-with-head-and-pelvis');
  assert.equal(head.assigned_evidence[0].region_crop_fallback, true);
  assert.doesNotThrow(() => validateReviewEvidenceManifest(manifest));
});

test('head-to-toe validation allows multi-region evidence when the target region is present', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'head-to-toe-multi-region-head-fixture',
    title: 'Head-to-Toe Image Review',
    reviewScope: 'head_to_toe',
    paragraphs: [
      'Head and Face',
      'Hair, scalp, facial contour, and face-specific findings are assessed here.',
    ],
    paragraphMeta: [
      { type: 'section-title', section_key: 'head_face', section_label: 'Head and Face' },
      { type: 'section', section_key: 'head_face', section_label: 'Head and Face' },
    ],
    images: [
      {
        id: 'head-and-pelvis-labelled',
        label: 'Reference view with head face and pelvis visible',
        coverage: 'head face scalp pelvis pubic region',
        sectionKey: 'head_face',
        url: '/uploads/head-pelvis.jpg',
        source: 'fresh_upload',
      },
    ],
  });

  const head = manifest.sections.find((section) => section.section_key === 'head_face');
  assert.equal(head.assigned_evidence[0].evidence_id, 'head-and-pelvis-labelled');
  assert.equal(head.assigned_evidence[0].anatomy_labels.includes('head_face'), true);
  assert.equal(head.assigned_evidence[0].anatomy_labels.includes('pelvis_pubic_region'), true);
  assert.doesNotThrow(() => validateReviewEvidenceManifest(manifest));
});

test('Foley and drainage bag evidence stays in the device/procedure lane', () => {
  const manifest = buildManifest('pelvic_genital');
  const device = manifest.sections.find((section) => section.section_key === 'device_contact_findings');
  assert.equal(device.assigned_evidence[0].evidence_id, 'foley-bag');
  assert.equal(device.assigned_evidence[0].device_related, true);
  const nonDeviceSections = manifest.sections.filter((section) => section.section_key !== 'device_contact_findings');
  assert.equal(nonDeviceSections.some((section) => section.assigned_evidence?.[0]?.evidence_id === 'foley-bag'), false);
});

test('missing focused evidence produces a placeholder rather than unrelated fallback', () => {
  const manifest = buildManifest();
  const missing = manifest.sections.find((section) => section.section_key === 'ears');
  assert.equal(missing.media_mode, 'placeholder');
  assert.deepEqual(missing.explicitly_assigned_evidence_ids, []);
});

test('mixed limitations section uses safe overview evidence instead of a title card', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'limitations-fixture-review',
    title: 'Pelvic and Genital Review',
    reviewScope: 'pelvic_genital',
    paragraphs: [
      'Limitations / Future Useful Coverage',
      'A dedicated pubic mound close-up and a posterior perineal reference would improve future coverage.',
    ],
    paragraphMeta: [
      { type: 'section-title', section_key: 'limitations_future_coverage', section_label: 'Limitations / Future Useful Coverage' },
      { type: 'section', section_key: 'limitations_future_coverage', section_label: 'Limitations / Future Useful Coverage' },
    ],
    images,
  });
  const limitations = manifest.sections.find((section) => section.section_key === 'limitations_future_coverage');
  assert.equal(limitations.target_region, 'overview');
  assert.equal(limitations.media_mode, 'assigned_evidence');
  assert.equal(limitations.assigned_evidence[0].evidence_id, 'pelvic-genital-current');
  const narrationSegments = manifest.sections.map((section) => ({
    section_id: section.section_id,
    durationSeconds: 3,
  }));
  const visualTimeline = buildManifestVisualTimeline({ manifest, narrationSegments });
  validateManifestTimelineIntegrity({ manifest, narrationSegments, visualTimeline });
  assert.doesNotThrow(() => validateVisualTimeline(visualTimeline, 'pelvic_genital'));
});

test('pelvic limitations section stays overview even when wording names missing regions', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'limitations-missing-regions-fixture',
    title: 'Pelvic and Genital Review',
    reviewScope: 'pelvic_genital',
    paragraphs: [
      'Limitations / Future Useful Coverage',
      'Dedicated pubic mound, perineum, and posterior perianal close-ups would improve future coverage.',
    ],
    paragraphMeta: [
      { type: 'section-title', section_key: 'limitations_future_coverage', section_label: 'Limitations / Future Useful Coverage' },
      { type: 'section', section_key: 'limitations_future_coverage', section_label: 'Limitations / Future Useful Coverage' },
    ],
    images,
  });

  const limitations = manifest.sections.find((section) => section.section_key === 'limitations_future_coverage');
  assert.equal(limitations.target_region, 'overview');
  assert.equal(limitations.media_mode, 'assigned_evidence');
  assert.doesNotThrow(() => validateReviewEvidenceManifest(manifest));
});

test('renderer timeline uses identical section IDs and measured audio durations', () => {
  const manifest = buildManifest();
  validateReviewEvidenceManifest(manifest);
  const narrationSegments = manifest.sections.map((section, index) => ({
    section_id: section.section_id,
    durationSeconds: 2.5 + index,
    file_url: `/uploads/audio-${index}.mp3`,
  }));
  const visualTimeline = buildManifestVisualTimeline({ manifest, narrationSegments });
  validateManifestTimelineIntegrity({ manifest, narrationSegments, visualTimeline });
  assert.deepEqual(
    visualTimeline.map((segment) => segment.sectionId),
    manifest.sections.map((section) => section.section_id)
  );
  assert.equal(visualTimeline[0].durationSeconds, 2.5);
  assert.equal(visualTimeline[1].startSeconds, 2.5);
});

test('head-to-toe sections rotate through multiple compatible images when available', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'multi-image-head-fixture',
    title: 'Head-to-Toe Review',
    reviewScope: 'head_to_toe',
    paragraphs: [
      'Head and Face',
      'Head, face, scalp, hairline, and facial contour are reviewed here with several direct reference views.',
    ],
    paragraphMeta: [
      { type: 'section-title', section_key: 'head_face', section_label: 'Head and Face' },
      { type: 'section', section_key: 'head_face', section_label: 'Head and Face' },
    ],
    images: [
      {
        id: 'head-front',
        label: 'Anterior head and face reference view',
        coverage: 'head face scalp hairline anterior facial contour',
        sectionKey: 'head_face',
        url: '/uploads/head-front.jpg',
        source: 'fresh_upload',
      },
      {
        id: 'head-lateral',
        label: 'Lateral head and face profile reference view',
        coverage: 'head face scalp hairline lateral facial contour',
        sectionKey: 'head_face',
        url: '/uploads/head-lateral.jpg',
        source: 'fresh_upload',
      },
      {
        id: 'head-close',
        label: 'Close head face and scalp detail reference view',
        coverage: 'head face scalp hairline close detail',
        sectionKey: 'head_face',
        url: '/uploads/head-close.jpg',
        source: 'fresh_upload',
      },
      {
        id: 'feet-only-decoy',
        label: 'Foot-only image',
        coverage: 'feet toes plantar heel',
        sectionKey: 'feet_toes',
        url: '/uploads/feet-decoy.jpg',
        source: 'fresh_upload',
      },
    ],
  });
  const head = manifest.sections.find((section) => section.section_key === 'head_face');
  assert.equal(head.assigned_evidence.length, 3);
  assert.deepEqual(
    head.assigned_evidence.map((item) => item.evidence_id).sort(),
    ['head-close', 'head-front', 'head-lateral'].sort()
  );

  const narrationSegments = manifest.sections.map((section) => ({
    section_id: section.section_id,
    durationSeconds: 24,
  }));
  const visualTimeline = buildManifestVisualTimeline({ manifest, narrationSegments });
  assert.equal(visualTimeline.length, 3);
  assert.equal(visualTimeline.every((item) => item.sectionId === head.section_id), true);
  assert.equal(visualTimeline.every((item) => item.targetKey === 'head_face'), true);
  assert.equal(visualTimeline.some((item) => item.image?.id === 'feet-only-decoy'), false);
  assert.equal(
    Number(visualTimeline.reduce((sum, item) => sum + item.durationSeconds, 0).toFixed(3)),
    24
  );
  validateManifestTimelineIntegrity({ manifest, narrationSegments, visualTimeline });
});

test('anatomy evidence source policy admits only Profiler uploads and approved chat references', () => {
  assert.equal(isEligibleProfileAnatomyEvidenceSource({ source: 'fresh_upload', url: '/uploads/penis.jpg' }), true);
  assert.equal(isEligibleProfileAnatomyEvidenceSource({ source: 'profile_review_image', url: '/uploads/back.jpg' }), true);
  assert.equal(isEligibleProfileAnatomyEvidenceSource({ source: 'saved_profile_qa_attachment', anatomy_reference_approved: true, url: '/uploads/approved.jpg' }), true);
  assert.equal(isEligibleProfileAnatomyEvidenceSource({ source: 'saved_profile_qa_attachment', url: '/uploads/unapproved.jpg' }), false);
  assert.equal(isEligibleProfileAnatomyEvidenceSource({ source: 'body_exploration_video_frame', url: '/uploads/body-frame.jpg' }), false);
  assert.equal(isEligibleProfileAnatomyEvidenceSource({ source: 'session_video_frame', url: '/uploads/session-frame.jpg' }), false);
  assert.equal(isEligibleProfileAnatomyEvidenceSource({ source: 'profile_review_image', url: '/uploads/ai-video-pass-6-00-frame-01.jpg' }), false);
});

test('static evidence filtering and video evidence keep identical IDs and annotation geometry', () => {
  const annotation = {
    image_id: 'img_019',
    view_label: 'Penile base, shaft, and visible foreskin',
    width: 3024,
    height: 4032,
    annotations: [{ x: 0.25, y: 0.3, width: 0.2, height: 0.15 }],
  };
  const result = {
    _meta: {
      reviewed_images: [
        { image_id: 'img_019', source: 'profile_review_image', preview_url: '/uploads/penis.jpg', width: 3024, height: 4032 },
        { image_id: 'img_058', source: 'body_exploration_video_frame', preview_url: '/uploads/ai-video-pass-6-00-frame-01.jpg' },
      ],
    },
    annotated_images: [annotation, { image_id: 'img_058', view_label: 'Procedure frame' }],
    image_region_findings: [
      { image_id: 'img_019', section_key: 'penis', label: 'Penis and foreskin', finding: 'Penile shaft and foreskin are directly visible.' },
      { image_id: 'img_058', section_key: 'pubic_mound_lower_abdomen', label: 'Pubic mound' },
    ],
  };
  const filtered = filterProfileAnatomyReviewEvidence(result);
  assert.deepEqual(filtered._meta.reviewed_images.map((image) => image.image_id), ['img_019']);
  assert.deepEqual(filtered.annotated_images, [annotation]);
  assert.equal(filtered.annotated_images[0].annotations[0].x, 0.25);
  assert.equal(filtered._meta.reviewed_images[0].width, 3024);

  const videoItem = buildProfileAnatomyEvidenceItem(
    filtered._meta.reviewed_images[0],
    filtered.annotated_images[0],
    filtered.image_region_findings,
  );
  assert.equal(videoItem.image_id, 'img_019');
  assert.equal(videoItem.width, 3024);
  assert.match(videoItem.display_label, /penile base/i);
});

function singleSectionManifest({ sectionKey, sectionLabel, text, images, reviewScope = 'pelvic_genital' }) {
  return createReviewEvidenceManifest({
    reviewId: `fixture-${sectionKey}`,
    title: 'Anatomy evidence fixture',
    reviewScope,
    paragraphs: [sectionLabel, text],
    paragraphMeta: [
      { type: 'section-title', section_key: sectionKey, section_label: sectionLabel },
      { type: 'section', section_key: sectionKey, section_label: sectionLabel },
    ],
    images,
  });
}

test('direct Profiler anatomy labels select the matching structure', () => {
  const cases = [
    ['penis', 'Penis', 'Your penile shaft is directly visible.', 'penis-direct', 'Penile shaft and base'],
    ['foreskin', 'Foreskin', 'Your foreskin and preputial margin are directly visible.', 'foreskin-direct', 'Foreskin and preputial margin'],
    ['penis', 'Penis and Foreskin', 'Your penile shaft and foreskin are visible together.', 'penis-foreskin-direct', 'Penis shaft with foreskin visible'],
    ['anal_opening_perianal_region', 'Anus and Perianal Region', 'Your anus and perianal skin are directly visible.', 'anus-direct', 'Anus and perianal close-up'],
    ['shoulders_upper_back', 'Back', 'Your back and posterior trunk are directly visible.', 'back-direct', 'Posterior back and trunk'],
    ['inguinal_folds_groin_skin', 'Right Inguinal Repair', 'Your right inguinal repair scar and groin are directly visible.', 'right-inguinal-direct', 'Right inguinal repair scar and groin'],
  ];
  for (const [sectionKey, sectionLabel, text, expectedId, label] of cases) {
    const manifest = singleSectionManifest({
      sectionKey,
      sectionLabel,
      text,
      reviewScope: sectionKey === 'shoulders_upper_back' ? 'head_to_toe' : 'pelvic_genital',
      images: [{ id: expectedId, label, coverage: `${label}. Direct validated anatomy reference.`, sectionKey, source: 'profile_review_image', url: `/uploads/${expectedId}.jpg` }],
    });
    const section = manifest.sections[0];
    assert.equal(section.assigned_evidence[0]?.evidence_id, expectedId, sectionLabel);
    assert.doesNotThrow(() => validateReviewEvidenceManifest(manifest));
  }
});

test('incidental device anatomy stays eligible while device-dominant media stays restricted', () => {
  const incidental = {
    id: 'pubic-with-incidental-foley',
    label: 'Pubic mound and lower abdomen',
    coverage: 'Pubic mound, lower abdomen, and penile base directly visible; Foley tubing is incidental at the edge.',
    sectionKey: 'pubic_mound_lower_abdomen',
    source: 'profile_review_image',
    url: '/uploads/pubic-incidental-foley.jpg',
  };
  const dominant = {
    id: 'routine-catheter-frame',
    label: 'Foley catheter procedure',
    coverage: 'Foley catheter tubing, StatLock, drainage bag, and procedure setup.',
    sectionKey: 'device_contact_findings',
    source: 'profile_review_image',
    url: '/uploads/routine-catheter.jpg',
  };
  assert.equal(profileAnatomyDeviceClassification(incidental), 'incidental_device');
  assert.equal(profileAnatomyDeviceClassification(dominant), 'device_dominant');

  const anatomyManifest = singleSectionManifest({
    sectionKey: 'pubic_mound_lower_abdomen',
    sectionLabel: 'Pubic Mound and Lower Abdomen',
    text: 'Your pubic mound and lower abdomen are directly visible.',
    images: [dominant, incidental],
  });
  assert.equal(anatomyManifest.sections[0].assigned_evidence[0]?.evidence_id, incidental.id);
  assert.doesNotThrow(() => validateReviewEvidenceManifest(anatomyManifest));

  const deviceManifest = singleSectionManifest({
    sectionKey: 'device_contact_findings',
    sectionLabel: 'Device and Procedure Context',
    text: 'Your Foley catheter, tubing, and StatLock are reviewed here.',
    images: [dominant],
  });
  assert.equal(deviceManifest.sections[0].assigned_evidence[0]?.evidence_id, dominant.id);
  assert.doesNotThrow(() => validateReviewEvidenceManifest(deviceManifest));
});

test('real img_058 procedure frame is rejected during selection instead of manifest validation', () => {
  const manifest = singleSectionManifest({
    sectionKey: 'pubic_mound_lower_abdomen',
    sectionLabel: 'Pubic Mound and Lower Abdomen',
    text: 'Your pubic mound and lower abdomen are directly visible.',
    images: [
      {
        id: 'img_058',
        label: 'AI video pass 6:00-6:24 frame 01',
        coverage: '18 French Foley catheter procedure frame with tubing and device context.',
        sectionKey: 'pubic_mound_lower_abdomen',
        source: 'body_exploration_video_frame',
        url: '/uploads/ai-video-pass-6-00-6-24-frame-01.jpg',
      },
      {
        id: 'img_025',
        label: 'Pubic mound, lower abdomen, and penile base',
        coverage: 'Direct anterior pubic mound and lower abdomen reference.',
        sectionKey: 'pubic_mound_lower_abdomen',
        source: 'profile_review_image',
        url: '/uploads/img-025.jpg',
      },
    ],
  });
  assert.deepEqual(manifest.sections[0].assigned_evidence.map((item) => item.evidence_id), ['img_025']);
  assert.doesNotThrow(() => validateReviewEvidenceManifest(manifest));
});

test('an exact validated section association outranks a nearby broad anatomy view', () => {
  const manifest = singleSectionManifest({
    sectionKey: 'pubic_mound_lower_abdomen',
    sectionLabel: 'Pubic Mound and Lower Abdomen',
    text: 'Your pubic mound and lower abdomen are directly visible.',
    images: [
      {
        id: 'nearby-penile-base',
        label: 'Inferior seated close-up - penile base and proximal perineum',
        coverage: 'Penile base and proximal perineum.',
        regions: ['pelvis_pubic_region'],
        source: 'profile_review_image',
        url: '/uploads/nearby-penile-base.jpg',
      },
      {
        id: 'direct-pubic-reference',
        label: 'Standing anterior lower-body reference',
        coverage: 'Lower abdomen, pubic mound, and pubic hair distribution.',
        regions: ['pelvis_pubic_region'],
        validated_section_keys: ['penis', 'pubic_mound_lower_abdomen'],
        source: 'profile_review_image',
        url: '/uploads/direct-pubic-reference.jpg',
      },
    ],
  });

  assert.equal(manifest.sections[0].assigned_evidence[0]?.evidence_id, 'direct-pubic-reference');
});

test('timeline validation accepts manifest-assigned pelvic/genital evidence labels', () => {
  const manifest = createReviewEvidenceManifest({
    reviewId: 'timeline-pelvic-fixture',
    title: 'Pelvic and Genital Review',
    reviewScope: 'pelvic_genital',
    paragraphs: [
      'Pelvic and Genital Image Review',
      'Pubic Mound and Lower Abdomen',
      'The pubic mound, lower abdomen, inguinal folds, and groin skin are assessed here.',
      'Glans and Meatus',
      'The glans and meatus are assessed here.',
    ],
    paragraphMeta: [
      { type: 'title', displayLabel: 'Pelvic and Genital Image Review' },
      { type: 'section-title', section_key: 'pubic_mound_lower_abdomen', section_label: 'Pubic Mound and Lower Abdomen' },
      { type: 'section', section_key: 'pubic_mound_lower_abdomen', section_label: 'Pubic Mound and Lower Abdomen' },
      { type: 'section-title', section_key: 'glans_meatus', section_label: 'Glans and Meatus' },
      { type: 'section', section_key: 'glans_meatus', section_label: 'Glans and Meatus' },
    ],
    images: [
      {
        id: 'pubic-current',
        label: 'Wide-field pubic mound lower abdomen inguinal groin reference',
        coverage: 'pubic mound lower abdomen inguinal groin pelvis',
        sectionKey: 'pubic_mound_lower_abdomen',
        url: '/uploads/pubic.jpg',
        source: 'fresh_upload',
      },
      {
        id: 'glans-current',
        label: 'Close-up glans meatus penile shaft reference',
        coverage: 'glans meatus penis penile shaft',
        sectionKey: 'glans_meatus',
        url: '/uploads/glans.jpg',
        source: 'fresh_upload',
      },
    ],
  });
  const narrationSegments = manifest.sections.map((section) => ({
    section_id: section.section_id,
    durationSeconds: 3,
  }));
  const visualTimeline = buildManifestVisualTimeline({ manifest, narrationSegments });
  validateManifestTimelineIntegrity({ manifest, narrationSegments, visualTimeline });
  assert.doesNotThrow(() => validateVisualTimeline(visualTimeline, 'pelvic_genital'));
});

test('timeline validation rejects renderer access to unassigned evidence', () => {
  const manifest = buildManifest();
  const narrationSegments = manifest.sections.map((section) => ({
    section_id: section.section_id,
    durationSeconds: 3,
  }));
  const visualTimeline = buildManifestVisualTimeline({ manifest, narrationSegments });
  visualTimeline[0].image = { id: 'foley-bag' };
  assert.throws(
    () => validateManifestTimelineIntegrity({ manifest, narrationSegments, visualTimeline }),
    /unassigned evidence/
  );
});
