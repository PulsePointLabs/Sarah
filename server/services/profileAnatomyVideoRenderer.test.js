import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildManifestVisualTimeline,
  createReviewEvidenceManifest,
  validateManifestTimelineIntegrity,
  validateReviewEvidenceManifest,
  validateVisualTimeline,
} from './profileAnatomyVideoRenderer.js';

const images = [
  {
    id: 'head-face-current',
    label: 'Current head and face view with hair, glasses, beard, scalp, and face visible',
    coverage: 'head face scalp beard glasses',
    sectionKey: 'head_face',
    url: '/uploads/head.jpg',
    source: 'fixture',
  },
  {
    id: 'body-current',
    label: 'Current broad full body standing posture view',
    coverage: 'full body whole body standing posture alignment chest abdomen lower limbs feet',
    sectionKey: 'posture_alignment',
    url: '/uploads/body.jpg',
    source: 'fixture',
  },
  {
    id: 'feet-only',
    label: 'Foot-only image showing toes ankles and dorsal feet',
    coverage: 'feet toes ankle heel plantar dorsal foot',
    sectionKey: 'feet_toes',
    url: '/uploads/feet.jpg',
    source: 'fixture',
  },
  {
    id: 'pelvic-genital-current',
    label: 'Current pelvic genital view with pubic groin penile shaft glans meatus scrotum perineum visible',
    coverage: 'pelvic pubic groin penis penile shaft glans meatus scrotum testes perineum',
    sectionKey: 'genitals_perineum',
    url: '/uploads/pelvic.jpg',
    source: 'fixture',
  },
  {
    id: 'foley-bag',
    label: 'Foley drainage bag with concentrated urine and tubing',
    coverage: 'foley catheter drainage bag urine tubing device procedure',
    sectionKey: 'device_contact_findings',
    url: '/uploads/foley.jpg',
    source: 'fixture',
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
      source: 'profile_review_archive',
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
        source: 'profile_review_archive',
      },
      {
        id: 'foreskin-closeup',
        label: 'Close-up foreskin and preputial margin with partial retraction',
        coverage: 'Foreskin mobility and preputial tissue are directly visible.',
        sectionKey: 'foreskin',
        url: '/uploads/foreskin.jpg',
        source: 'profile_review_archive',
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
        source: 'profile_review_archive',
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
      source: 'fixture',
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
      source: 'fixture',
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
        source: 'profile_review_archive',
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
        source: 'fixture',
      },
      {
        id: 'pubic-mound-view',
        label: 'Focused pubic mound and groin skin view',
        coverage: 'pubic mound lower abdomen inguinal folds groin skin penile base',
        sectionKey: 'pubic_mound_lower_abdomen',
        url: '/uploads/pubic-mound.jpg',
        source: 'fixture',
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
        source: 'fixture',
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
        source: 'fixture',
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
        source: 'fixture',
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
        source: 'fixture',
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
        source: 'fixture',
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
        source: 'fixture',
      },
      {
        id: 'head-lateral',
        label: 'Lateral head and face profile reference view',
        coverage: 'head face scalp hairline lateral facial contour',
        sectionKey: 'head_face',
        url: '/uploads/head-lateral.jpg',
        source: 'fixture',
      },
      {
        id: 'head-close',
        label: 'Close head face and scalp detail reference view',
        coverage: 'head face scalp hairline close detail',
        sectionKey: 'head_face',
        url: '/uploads/head-close.jpg',
        source: 'fixture',
      },
      {
        id: 'feet-only-decoy',
        label: 'Foot-only image',
        coverage: 'feet toes plantar heel',
        sectionKey: 'feet_toes',
        url: '/uploads/feet-decoy.jpg',
        source: 'fixture',
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
        source: 'fixture',
      },
      {
        id: 'glans-current',
        label: 'Close-up glans meatus penile shaft reference',
        coverage: 'glans meatus penis penile shaft',
        sectionKey: 'glans_meatus',
        url: '/uploads/glans.jpg',
        source: 'fixture',
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
