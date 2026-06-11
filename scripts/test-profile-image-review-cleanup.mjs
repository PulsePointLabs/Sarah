import assert from 'node:assert/strict';
import {
  cleanupProfileImageReviewResult,
  cleanProfileImageReviewText,
  dedupeProfileImageReviewItems,
} from '../src/lib/profileImageReviewCleanup.js';

const sections = [
  { key: 'significant_findings' },
  { key: 'skin_surface_findings' },
  { key: 'missing_items_optional_image_requests' },
];

assert.equal(cleanProfileImageReviewText('The bladder neck is not visualized.'), '');
assert.equal(cleanProfileImageReviewText('Bone-conduction headphones are visible at the right ear.'), '');
assert.equal(
  cleanProfileImageReviewText('Possible glans surface finding consistent with pre-ejaculate: small bright meatal droplet.'),
  'Small bright meatal highlight or possible fluid point; static image cannot confirm secretion.',
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
  significant_findings: [
    'Visual callouts for anterior view. 1. Shoulders are level. Shoulders are level.',
    'Shoulders appear broadly level without obvious asymmetry.',
  ],
  skin_surface_findings: [
    'Scattered follicular papules are visible across bilateral inguinal folds.',
    'Erythematous papules are visible on the proximal inner thighs.',
  ],
  missing_items_optional_image_requests: [
    'Standing anterior whole-body view is needed.',
    'Dedicated hands close-up could improve hand detail.',
  ],
}, { sections });

assert.equal(cleaned.significant_findings.length, 1);
assert.equal(cleaned.skin_surface_findings.length, 1);
assert.deepEqual(cleaned.missing_items_optional_image_requests, ['Dedicated hands close-up could improve hand detail.']);

console.log('profile image review cleanup tests passed');
