import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFocusedFoleyProfileContext,
  classifyFocusedProcedureProvenance,
  focusedFoleyPromptBlock,
  isFocusedFoleyExploration,
  isFocusedProcedureRelevantText,
  normalizeFocusedFoleyAnalysis,
} from '../../src/lib/bodyExplorationFocus.js';

const foleyExploration = {
  title: 'June 18 20 French Foley Insertion',
  exploration_type: 'Foley catheter insertion',
  foley_size: '20 Fr',
  foley_type: 'Dover Foley',
  event_timeline: [
    { time_s: 0, note: 'Sterile field and drape established.' },
    { time_s: 248, note: 'Main resistance at external sphincter region; deliberate pelvic relaxation and breathing.' },
    { time_s: 318, note: 'Bladder entry and urine return.' },
    { time_s: 372, note: '5 mL balloon inflated and seated with transient urgency.' },
  ],
};

test('detects focused Foley insertion records without changing generic body exploration', () => {
  assert.equal(isFocusedFoleyExploration(foleyExploration), true);
  assert.equal(isFocusedFoleyExploration({ exploration_type: 'standing posture review', notes: 'ankle mobility and foot posture' }), false);
});

test('focused Foley profile context keeps procedure history and filters unrelated profile material', () => {
  const context = buildFocusedFoleyProfileContext({
    foley: {
      preferred_size: '18 to 20 Fr',
      prior_dwell: 'Erection-related tugging during dwell can affect comfort.',
    },
    vascular: {
      ankle_edema: 'Bilateral ankle edema after shower and beer intake.',
    },
    urinary: {
      catheter_notes: 'Prior 18 Fr insertion had less meatal awareness than 20 Fr.',
    },
  });

  assert.match(context, /18 to 20 Fr/i);
  assert.match(context, /Erection-related tugging/i);
  assert.match(context, /Prior 18 Fr insertion/i);
  assert.doesNotMatch(context, /Bilateral ankle edema/i);
  assert.doesNotMatch(context, /beer intake/i);
});

test('focused relevance gate excludes unrelated edema, beer, hydration coaching, and later urine images', () => {
  assert.equal(isFocusedProcedureRelevantText('Bilateral ankle edema was present but did not affect placement.'), false);
  assert.equal(isFocusedProcedureRelevantText('Beer intake and daily hydration coaching should be reviewed later.'), false);
  assert.equal(isFocusedProcedureRelevantText('A later leg bag urine image showed darker urine color and dominates the conclusion.'), false);
  assert.equal(isFocusedProcedureRelevantText('Dependent edema affected leg bag tubing compression and drainage patency during dwell.'), true);
});

test('normalization preserves major Foley events while removing peripheral drift', () => {
  const cleaned = normalizeFocusedFoleyAnalysis({
    clinical_overview: 'Your 20 Fr Dover Foley placement was technically successful, with urine return, five mL balloon inflation, seating, and stable immediate dwell comfort.',
    procedural_course: [
      'Sterile preparation and draping started the procedure.',
      'The catheter passed the meatus and distal urethra smoothly before the main external sphincter resistance point.',
      'Bladder entry was supported by urine return, followed by five mL balloon inflation and gentle seating.',
      'Bilateral ankle edema deserves a broad vascular review unrelated to insertion.',
    ],
    clinical_interpretation: [
      'The insertion appears moderately difficult rather than difficult because the main resistance released with deliberate pelvic relaxation and breathing, without sudden withdrawal or visible bracing.',
      'Stable heart rate in the one hundred seven to one hundred fifteen beats per minute range supports calm tolerance rather than a major autonomic spike.',
    ],
    body_response_felt_experience: [
      'Your notes describe a dissociative clinician-observer state that held through most of the procedure and partially broke at the smaller internal pinching discomfort.',
      'Beer intake and hydration coaching are not central here.',
    ],
    placement_confidence: [
      'Placement confidence is supported by adequate advancement, urine return, continued advancement before balloon inflation, five mL balloon inflation without concerning pain, gentle traction and seating, established drainage, and immediate ambulatory tolerance.',
      'The later leg bag urine image showed darker color and should dominate the conclusion.',
    ],
    prior_comparison: [
      'Compared with the previous 18 Fr experience, the 20 Fr catheter seemed to create more meatal awareness but still remained tolerable during dwell.',
    ],
    focused_follow_up: [
      'Monitor urine flow, tubing patency, meatal irritation, bleeding, bypass leakage, bladder spasms, securement traction, erection-related tugging, and comfort compared with the 18 Fr catheter.',
      'Watch unrelated foot edema and generalized skin findings.',
    ],
  });

  const allText = JSON.stringify(cleaned);
  assert.match(allText, /20 Fr Dover Foley/i);
  assert.match(allText, /Sterile preparation/i);
  assert.match(allText, /meatus and distal urethra/i);
  assert.match(allText, /external sphincter resistance/i);
  assert.match(allText, /pelvic relaxation and breathing/i);
  assert.match(allText, /internal pinching discomfort/i);
  assert.match(allText, /heart rate/i);
  assert.match(allText, /urine return/i);
  assert.match(allText, /five mL balloon inflation/i);
  assert.match(allText, /ambulatory tolerance/i);
  assert.match(allText, /previous 18 Fr/i);
  assert.match(allText, /erection-related tugging/i);
  assert.doesNotMatch(allText, /ankle edema deserves/i);
  assert.doesNotMatch(allText, /Beer intake/i);
  assert.doesNotMatch(allText, /hydration coaching/i);
  assert.doesNotMatch(allText, /later leg bag urine image/i);
  assert.doesNotMatch(allText, /unrelated foot edema/i);
});

test('focused output includes clinical synthesis and placement confidence rather than timeline-only narration', () => {
  const cleaned = normalizeFocusedFoleyAnalysis({
    clinical_overview: 'Your 20 Fr Foley placement succeeded with the main resistance at the external sphincter region, stable heart-rate tolerance, urine return, five mL balloon inflation, and seated drainage.',
    procedural_course: ['Preparation, meatal engagement, external sphincter resistance, bladder entry, urine return, and balloon seating were the major procedural phases.'],
    clinical_interpretation: ['The pattern suggests a familiar functional resistance point that released with relaxation rather than a traumatic or obstructive event, based on annotated sensation, visible lack of bracing, and stable telemetry.'],
    body_response_felt_experience: ['Your clinician-observer state held through most steps and partially broke at the pinching discomfort.'],
    placement_confidence: ['Successful placement is supported by urine return, continued advancement before balloon inflation, balloon seating, drainage, and no visible bleeding, bypass leakage, or severe pain.'],
    prior_comparison: ['The 20 Fr catheter was more noticeable than the previous 18 Fr but remained tolerable.'],
    focused_follow_up: ['Monitor urine flow, tubing patency, meatal irritation, bleeding, bypass leakage, bladder spasms, securement traction, and dwell comfort.'],
  });

  assert.ok(cleaned.clinical_interpretation.some((line) => /functional resistance point/i.test(line)));
  assert.ok(cleaned.placement_confidence.some((line) => /urine return/i.test(line)));
  assert.ok(cleaned.focused_follow_up.every((line) => !/hydration|beer|edema|skin finding/i.test(line)));
  assert.ok(cleaned.procedural_course.join(' ').match(TIMESTAMP_RE_SAFE) == null);
});

const TIMESTAMP_RE_SAFE = /\b(?:\d{1,2}:\d{2}.*\d{1,2}:\d{2}.*\d{1,2}:\d{2})\b/;

test('provenance labels are available internally for focused claims', () => {
  const labels = classifyFocusedProcedureProvenance('Your notes describe discomfort while the reviewed video shows no bracing and telemetry stayed stable compared with the prior 18 Fr insertion, suggesting calm tolerance.');
  assert.ok(labels.includes('subjective annotation'));
  assert.ok(labels.includes('visual observation'));
  assert.ok(labels.includes('telemetry supported'));
  assert.ok(labels.includes('historical comparison'));
  assert.ok(labels.includes('clinical interpretation'));
});

test('focused prompt keeps Sarah warm while requiring procedure-only structure and TTS pacing', () => {
  const prompt = focusedFoleyPromptBlock();
  assert.match(prompt, /Clinical Overview/i);
  assert.match(prompt, /Clinical Interpretation/i);
  assert.match(prompt, /Focused Follow-Up/i);
  assert.match(prompt, /Do not narrate every timestamp/i);
  assert.match(prompt, /Medium-length sentences/i);
  assert.match(prompt, /Exclude peripheral findings/i);
});
