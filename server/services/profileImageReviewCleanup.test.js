import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupProfileImageReviewResult,
  reduceProfileFindingRepetition,
} from '../../src/lib/profileImageReviewCleanup.js';

const HEAD_TO_TOE_SECTIONS = [
  { key: 'executive_summary' },
  { key: 'head_face' },
  { key: 'neck' },
  { key: 'shoulders_upper_back' },
  { key: 'chest' },
  { key: 'abdomen' },
  { key: 'pelvis_pubic_region' },
  { key: 'genitals_perineum' },
  { key: 'buttocks_perianal_region' },
  { key: 'upper_limbs_hands' },
  { key: 'lower_limbs' },
  { key: 'feet_toes' },
  { key: 'posture_alignment' },
  { key: 'skin_summary' },
  { key: 'limitations_future_coverage' },
];

const PELVIC_SECTIONS = [
  { key: 'executive_summary' },
  { key: 'pubic_mound_lower_abdomen' },
  { key: 'inguinal_folds_groin_skin' },
  { key: 'penis' },
  { key: 'foreskin' },
  { key: 'glans_meatus' },
  { key: 'scrotum_testes' },
  { key: 'perineum' },
  { key: 'anal_opening_perianal_region' },
  { key: 'buttocks_gluteal_skin' },
  { key: 'device_contact_findings' },
  { key: 'tissue_health_safety_observations' },
  { key: 'measurement_reconciliation' },
  { key: 'limitations_future_coverage' },
];

function allText(value) {
  const chunks = [];
  const add = (item) => {
    if (item == null) return;
    if (Array.isArray(item)) item.forEach(add);
    else if (typeof item === 'object') Object.values(item).forEach(add);
    else chunks.push(String(item));
  };
  add(value);
  return chunks.join(' ');
}

test('consolidates repeated hair, glasses, and goatee findings', () => {
  const result = cleanupProfileImageReviewResult({
    summary_card: {
      primary_reference_value: [
        'Short salt-and-pepper hair with mild vertex thinning is visible.',
        'Wire-frame glasses and a goatee with grey predominance are visible.',
      ],
      key_direct_findings: [
        'Short salt-and-pepper hair with mild vertex thinning is visible on lateral view.',
        'Wire-frame glasses and a goatee with grey predominance are visible from posterior angle.',
      ],
    },
    head_face: [
      'Short salt-and-pepper hair with mild vertex thinning is visible.',
      'Wire-frame glasses and a goatee with grey predominance are visible.',
      'Rounded facial contour is visible.',
    ],
  }, { sections: HEAD_TO_TOE_SECTIONS });

  const text = allText(result).toLowerCase();
  assert.equal((text.match(/salt-and-pepper hair/g) || []).length, 1);
  assert.equal((text.match(/wire-frame glasses/g) || []).length, 1);
  assert.equal((text.match(/goatee/g) || []).length, 1);
  assert.match(text, /confirmed across multiple views/);
  assert.match(text, /rounded facial contour/);
});

test('states dog bite healing and no infection once when repeated', () => {
  const result = cleanupProfileImageReviewResult({
    abdomen: [
      'Right lateral abdominal dog bite wound shows yellow-green bruise resolution with no visible infection or open skin breaks.',
      'Dog bite healing progression is visible with no visible infection.',
      'No open skin breaks or signs of secondary infection are visible near the dog bite wound.',
    ],
    skin_summary: [
      'No open skin breaks or signs of infection are visible.',
      'Follicular erythematous papules remain visible over the lower body.',
    ],
  }, { sections: HEAD_TO_TOE_SECTIONS });

  const text = allText(result).toLowerCase();
  assert.equal((text.match(/dog bite/g) || []).length, 1);
  assert.equal((text.match(/no visible infection|signs of infection|secondary infection/g) || []).length, 1);
  assert.match(text, /follicular erythematous papules/);
});

test('consolidates repeated forward head carriage', () => {
  const result = cleanupProfileImageReviewResult({
    posture_alignment: [
      'Mild forward head carriage is visible in standing profile.',
      'Mild forward head carriage is visible from posterior standing posture.',
      'Mild thoracic kyphosis and mild lumbar lordosis are visible.',
    ],
  }, { sections: HEAD_TO_TOE_SECTIONS });

  const text = allText(result).toLowerCase();
  assert.equal((text.match(/forward head carriage/g) || []).length, 1);
  assert.match(text, /thoracic kyphosis/);
  assert.match(text, /lumbar lordosis/);
});

test('preserves later details when severity or progression changes', () => {
  const result = reduceProfileFindingRepetition({
    abdomen_pelvis: [
      'Right lateral abdominal dog bite wound shows yellow-green bruise resolution.',
      'Compared with earlier images, the dog bite wound now has less purple-red central marking and improved surrounding discoloration.',
    ],
  }, { sections: HEAD_TO_TOE_SECTIONS });

  const text = allText(result).toLowerCase();
  assert.equal((text.match(/dog bite wound/g) || []).length, 2);
  assert.match(text, /less purple-red central marking/);
  assert.match(text, /improved surrounding discoloration/);
});

test('pelvic/genital review preserves structure-specific details while reducing duplicates', () => {
  const result = cleanupProfileImageReviewResult({
    glans_meatus: [
      'The meatus is visible without obvious irritation.',
      'The glans and foreskin are visible without obvious focal lesion.',
      'The meatus is visible without obvious irritation.',
    ],
    scrotum_testes: [
      'The scrotum and perineal raphe are visible with midline alignment.',
    ],
    device_contact_findings: [
      'Foley catheter exits the meatus without visible urethral tissue stress.',
      'Foley catheter exits the meatus without visible urethral tissue stress.',
    ],
  }, { sections: PELVIC_SECTIONS });

  const text = allText(result).toLowerCase();
  assert.match(text, /meatus/);
  assert.match(text, /glans/);
  assert.match(text, /foreskin/);
  assert.match(text, /scrotum/);
  assert.match(text, /perineal raphe/);
  assert.match(text, /foley catheter/);
  assert.equal((text.match(/without obvious irritation/g) || []).length, 1);
  assert.equal((text.match(/visible urethral tissue stress/g) || []).length, 1);
});

test('negative findings are not repeated excessively', () => {
  const result = cleanupProfileImageReviewResult({
    skin_summary: [
      'No open skin breaks or signs of infection are visible.',
      'No open skin breaks are visible.',
      'No signs of infection are visible.',
      'Pale linear striae are visible over the lower abdomen.',
    ],
  }, { sections: HEAD_TO_TOE_SECTIONS });

  const text = allText(result).toLowerCase();
  assert.equal((text.match(/no open skin breaks/g) || []).length, 1);
  assert.equal((text.match(/signs of infection/g) || []).length, 1);
  assert.match(text, /pale linear striae/);
});

test('head-to-toe cleanup preserves anatomical breadth while reducing echo', () => {
  const result = cleanupProfileImageReviewResult({
    executive_summary: [
      'Overall body habitus, posture, skin distribution, scars, extremities, feet, and active abdominal skin findings are documented as a current head-to-toe picture.',
    ],
    head_face: ['Short salt-and-pepper hair with mild vertex thinning is visible.'],
    neck: ['Neck contour appears without obvious visible mass or focal asymmetry.'],
    shoulders_upper_back: ['Mild right shoulder elevation and mild thoracic kyphosis are visible.'],
    chest: ['Chest contour is visible without focal chest-wall skin concern in the saved views.'],
    abdomen: ['Right lateral abdominal dog bite wound shows yellow-green bruise resolution with no visible infection.'],
    pelvis_pubic_region: ['Right inguinal hernia repair scar is visible along the inguinal crease.'],
    genitals_perineum: ['Genital and perineal baseline is briefly represented; detailed structure review belongs in the pelvic/genital profile.'],
    buttocks_perianal_region: ['Buttock and perianal skin baseline is represented in saved views.'],
    upper_limbs_hands: ['Upper extremities appear symmetric where represented.'],
    lower_limbs: ['Lower limbs show no visible lower-extremity edema in this represented baseline.'],
    feet_toes: ['Feet and toes show neutral resting alignment where represented.'],
    posture_alignment: ['Mild forward head carriage is visible in standing profile. Mild forward head carriage is visible from another view.'],
    skin_summary: ['Follicular erythematous papules and pale linear striae are summarized as stable skin findings.'],
  }, { sections: HEAD_TO_TOE_SECTIONS });

  for (const section of HEAD_TO_TOE_SECTIONS.filter((section) => section.key !== 'limitations_future_coverage')) {
    assert.ok(Array.isArray(result[section.key]), `${section.key} should remain an array`);
    assert.ok(result[section.key].length > 0, `${section.key} should preserve meaningful content`);
  }

  const text = allText(result).toLowerCase();
  assert.equal((text.match(/forward head carriage/g) || []).length, 1);
  assert.equal((text.match(/dog bite wound/g) || []).length, 1);
  assert.match(text, /upper extremities/);
  assert.match(text, /feet and toes/);
});

test('pelvic/genital cleanup preserves focused exam structures without catheter dominance', () => {
  const result = cleanupProfileImageReviewResult({
    executive_summary: ['Focused pelvic/genital exam covers regional contour, tissue health, stable anatomy, and current catheter state without making the catheter the whole report.'],
    pubic_mound_lower_abdomen: ['Pubic mound and lower abdominal contour are represented without visible focal skin breakdown.'],
    inguinal_folds_groin_skin: ['Inguinal folds show stable follicular papules without fissuring.'],
    penis: ['Penile shaft contour is represented without obvious focal shaft lesion.'],
    foreskin: ['Foreskin coverage pattern is represented as stable.'],
    glans_meatus: ['Glans and meatus are visible without obvious irritation.'],
    scrotum_testes: ['Scrotum appears symmetric with visible midline raphe.'],
    perineum: ['Perineal raphe is visible with intact surface skin.'],
    anal_opening_perianal_region: ['Perianal skin is represented without visible fissure.'],
    buttocks_gluteal_skin: ['Gluteal skin is represented without visible pressure injury.'],
    device_contact_findings: [
      'Foley catheter exits the meatus without visible urethral tissue stress.',
      'Foley catheter exits the meatus without visible urethral tissue stress.',
    ],
    tissue_health_safety_observations: ['No obvious irritation, fissuring, discoloration, or tissue stress is apparent in represented views.'],
  }, { sections: PELVIC_SECTIONS });

  for (const section of PELVIC_SECTIONS.filter((section) => !/measurement|limitations/.test(section.key))) {
    assert.ok(Array.isArray(result[section.key]), `${section.key} should remain an array`);
    assert.ok(result[section.key].length > 0, `${section.key} should preserve focused exam content`);
  }

  const text = allText(result).toLowerCase();
  assert.equal((text.match(/foley catheter exits/g) || []).length, 1);
  assert.match(text, /glans and meatus/);
  assert.match(text, /scrotum appears symmetric/);
  assert.match(text, /perianal skin/);
});
