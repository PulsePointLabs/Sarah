import assert from 'node:assert/strict';
import {
  cleanupProfileImageReviewResult,
  cleanProfileImageReviewText,
  dedupeProfileImageReviewItems,
} from '../src/lib/profileImageReviewCleanup.js';
import { readFileSync } from 'node:fs';

const sections = [
  { key: 'executive_summary' },
  { key: 'skin_summary' },
  { key: 'limitations_future_coverage' },
];

assert.equal(cleanProfileImageReviewText('The bladder neck is not visualized.'), '');
assert.equal(cleanProfileImageReviewText('Bone-conduction headphones are visible at the right ear.'), '');
assert.equal(cleanProfileImageReviewText('A Polar H10 chest strap is visible across the lower chest.'), '');
assert.equal(cleanProfileImageReviewText('Foot camera devices are visible at the end of the table.'), '');
assert.equal(cleanProfileImageReviewText('All 20 rechecked saved/direct views are close-up pelvic views.'), '');
assert.equal(cleanProfileImageReviewText('No distinct recovered batch paragraph was available.'), '');
assert.equal(cleanProfileImageReviewText('This batch does not include whole-body or torso views.'), '');
assert.equal(
  cleanProfileImageReviewText('Possible glans surface finding consistent with pre-ejaculate: small bright meatal droplet.'),
  'Small bright meatal highlight or possible fluid point; static image cannot confirm secretion.',
);
assert.equal(
  cleanProfileImageReviewText('Perineal tissue shows natural moisture or possible lubricant residue.'),
  'Perineal tissue shows surface sheen/moisture; source cannot be determined from static image.',
);

assert.deepEqual(
  dedupeProfileImageReviewItems([
    'Shoulders are level.',
    'Shoulders appear broadly level without obvious asymmetry.',
    'No shoulder height asymmetry is visible.',
  ]),
  ['Shoulders appear broadly level without obvious asymmetry.'],
);

assert.equal(
  dedupeProfileImageReviewItems([
    'Central adiposity is visible with anterior abdominal projection.',
    'The abdominal contour projects anteriorly with a mild lower pannus.',
    'Lower abdominal fullness is again visible.',
  ]).length,
  1,
);

assert.equal(
  dedupeProfileImageReviewItems([
    'Scattered follicular papules are visible across the inguinal folds.',
    'Erythematous papules are visible on the inner thighs.',
    'Follicular-appearing papules are also present near the gluteal/perianal skin.',
  ]).length,
  1,
);

const cleaned = cleanupProfileImageReviewResult({
  annotated_images: [
    {
      image_id: 'img_full_body',
      view_label: 'Anterior full-body standing view',
      coverage: 'Whole-body standing anterior view with head, torso, hands, legs, and feet visible.',
    },
  ],
  image_region_findings: [],
  executive_summary: [
    'Visual callouts for anterior view. 1. Shoulders are level. Shoulders are level.',
    'Shoulders appear broadly level without obvious asymmetry.',
    'A black Polar H10 chest strap is visible.',
  ],
  skin_summary: [
    'Scattered follicular papules are visible across bilateral inguinal folds.',
    'Erythematous papules are visible on the proximal inner thighs.',
  ],
  limitations_future_coverage: [
    'Standing anterior whole-body view is needed.',
    'Dedicated hands close-up could improve hand detail.',
  ],
}, { sections });

assert.equal(cleaned.executive_summary.length, 1);
assert.equal(cleaned.skin_summary.length, 1);
assert.deepEqual(cleaned.limitations_future_coverage, ['Dedicated hands close-up could improve hand detail.']);

const serialized = JSON.stringify(cleaned);
for (const forbidden of [
  'in this batch',
  'all 20 rechecked saved/direct views',
  'No distinct recovered batch paragraph',
  'Polar H10',
  'chest strap',
  'headphones',
  'foot camera',
  'Visual callouts for',
]) {
  assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, `forbidden output remained: ${forbidden}`);
}

const profilerSource = readFileSync(new URL('../src/pages/Profiler.jsx', import.meta.url), 'utf8');
for (const label of [
  'Head & Face',
  'Neck',
  'Shoulders & Upper Back',
  'Chest',
  'Abdomen',
  'Pelvis / Pubic Region',
  'Genitals / Perineum',
  'Buttocks / Perianal Region',
  'Upper Limbs & Hands',
  'Lower Limbs',
  'Feet & Toes',
  'Posture & Alignment',
  'Skin Summary',
]) {
  assert.ok(profilerSource.includes(`label: "${label}"`), `missing head-to-toe section: ${label}`);
}
for (const label of [
  'Pubic Mound & Lower Abdomen',
  'Penis',
  'Foreskin',
  'Glans & Meatus',
  'Scrotum & Testes',
  'Perineum',
  'Anal Opening & Perianal Region',
  'Buttocks / Gluteal Skin',
]) {
  assert.ok(profilerSource.includes(`label: "${label}"`), `missing pelvic/genital section: ${label}`);
}

for (const required of [
  'LONGITUDINAL EVIDENCE / CREDIT DISCIPLINE RULE',
  'Do not rediscover stable anatomy during every review',
  'anatomical_evidence_records',
  'first_observed_date',
  'last_confirmed_date',
  'evidence_strength',
  'strongly_established',
  'buildImageReviewMetaWithEvidence',
  'formatIncrementalEvidenceRecordsForPrompt',
]) {
  assert.ok(profilerSource.includes(required), `missing incremental evidence wiring: ${required}`);
}

for (const required of [
  'ANATOMICAL LEFT / RIGHT ORIENTATION RULE',
  'Use anatomical left/right, meaning the subject',
  'For anterior or front-facing photos where the person is facing the camera',
  'screen-left side is the subject',
  'screen-right side is the subject',
  'For mirror/reflection images, rotated images, close crops, or unclear orientation',
]) {
  assert.ok(profilerSource.includes(required), `missing left/right orientation rule: ${required}`);
}

console.log('profile image review cleanup tests passed');
