import { answerMap, clamp01, isUnconfirmed, isVisible } from './schema.js';

function refs(...answers) {
  return [...new Set(answers.flatMap((answer) => answer?.evidence_frames || []))];
}

function evidenceObjects(answers, ids, labelMap = {}) {
  return ids.filter((id) => answers.has(id)).map((id) => {
    const answer = answers.get(id);
    return {
      label: labelMap[id] || id,
      status: answer?.answer || 'uncertain',
      confidence: clamp01(answer?.confidence, 0.25),
      frame_refs: answer?.evidence_frames || [],
      reason: answer?.reason || 'No visual evidence returned.',
    };
  });
}

function addForbidden(list, claim, reason, checkedFrames) {
  list.push({
    claim,
    reason,
    frame_refs_checked: [...new Set(checkedFrames.filter(Boolean))],
  });
}

function addStage(list, stage, confidence, basis, frameRefs) {
  list.push({
    stage,
    confidence: clamp01(confidence),
    basis,
    frame_refs: [...new Set(frameRefs.filter(Boolean))],
  });
}

function addEvent(list, window, eventType, label, confidence, frameRef) {
  list.push({
    time_ms: Number(window.startMs || 0),
    event_type: eventType,
    label,
    confidence: clamp01(confidence),
    frame_ref: frameRef || null,
  });
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function cmPerPixel(request) {
  const calibration = request.previousVisualState?.scaleCalibration || request.previousVisualState?.scale_calibration || {};
  const value = Number(calibration.cmPerPixel || calibration.cm_per_pixel);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function boundedVolumeProxy(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['none', 'trace', 'low', 'moderate', 'high', 'uncertain'].includes(normalized) ? normalized : 'uncertain';
}

function deriveRespiration({ request, frames, answers, forbidden }) {
  const visibility = answers.get('chest_or_abdomen_visible_for_respiration');
  const cycles = answers.get('respiratory_cycles_visible');
  const hold = answers.get('possible_breath_hold_visible');
  const asked = [visibility, cycles, hold].some(Boolean);
  if (!asked) return null;

  const checkedFrames = frames.map((frame) => frame.frame_id);
  const frameTimes = frames.map((frame) => Number(frame.time_ms)).filter(Number.isFinite).sort((a, b) => a - b);
  const frameStart = frameTimes[0] ?? Number(request.startMs || 0);
  const frameEnd = frameTimes[frameTimes.length - 1] ?? Number(request.endMs || frameStart);
  const frameSpanSeconds = Math.max(0, (frameEnd - frameStart) / 1000);
  const assessable = isVisible(visibility, 0.55);
  const breathsObserved = Math.max(0, Math.round(firstNumber(cycles?.attributes?.breaths_observed, cycles?.attributes?.cycle_count, 0)));
  const reportedObservationSeconds = Math.max(0, firstNumber(cycles?.attributes?.observation_seconds, cycles?.attributes?.duration_seconds, 0));
  const observationSeconds = Math.min(reportedObservationSeconds, frameSpanSeconds);
  const calculatedRate = observationSeconds >= 8 && breathsObserved >= 2
    ? Number(((breathsObserved * 60) / observationSeconds).toFixed(1))
    : null;
  const estimatedRate = assessable && isVisible(cycles, 0.6) && calculatedRate != null
    ? Number(Math.max(3, Math.min(80, calculatedRate)).toFixed(1))
    : null;
  const rawHoldStart = firstNumber(hold?.attributes?.hold_start_ms, hold?.attributes?.start_ms);
  const rawHoldEnd = firstNumber(hold?.attributes?.hold_end_ms, hold?.attributes?.end_ms);
  const holdStart = rawHoldStart == null ? null : Math.max(frameStart, Math.min(frameEnd, rawHoldStart));
  const holdEnd = rawHoldEnd == null ? null : Math.max(holdStart ?? frameStart, Math.min(frameEnd, rawHoldEnd));
  const reportedHoldDuration = firstNumber(hold?.attributes?.hold_duration_seconds, hold?.attributes?.duration_seconds, 0);
  const timedHoldDuration = holdStart != null && holdEnd != null ? Math.max(0, (holdEnd - holdStart) / 1000) : 0;
  const holdDuration = Math.min(frameSpanSeconds, Math.max(reportedHoldDuration || 0, timedHoldDuration));
  const possibleHold = assessable && isVisible(hold, 0.65) && holdDuration >= 4;

  if (!assessable) {
    addForbidden(forbidden, 'respiratory rate or breath hold', 'Chest/abdomen visibility is insufficient or confounded, so visual respiration cannot be estimated.', checkedFrames);
  } else if (estimatedRate == null) {
    addForbidden(forbidden, 'respiratory rate', 'Fewer than two complete visible respiratory cycles or less than eight seconds of usable evidence.', checkedFrames);
  }
  if (!possibleHold) {
    addForbidden(forbidden, 'breath hold', 'No assessable chest/abdominal still interval of at least four seconds is visibly confirmed.', checkedFrames);
  }

  return {
    assessable,
    breaths_observed: estimatedRate == null ? null : breathsObserved,
    observation_seconds: estimatedRate == null ? null : observationSeconds,
    estimated_rate_bpm: estimatedRate,
    pattern: cycles?.attributes?.pattern || (possibleHold ? 'possible_breath_hold' : estimatedRate != null ? 'visible_cycles' : 'unavailable'),
    possible_breath_hold: possibleHold,
    hold_start_ms: possibleHold ? (holdStart ?? Number(request.startMs || 0)) : null,
    hold_end_ms: possibleHold ? (holdEnd ?? Number(request.startMs || 0) + holdDuration * 1000) : null,
    hold_duration_seconds: possibleHold ? Number(holdDuration.toFixed(1)) : null,
    confidence: Math.max(clamp01(visibility?.confidence), clamp01(cycles?.confidence), clamp01(hold?.confidence)),
    frame_refs: refs(visibility, cycles, hold),
    limitations: [
      'Visual estimate only; shallow breathing, body motion, occlusion, camera motion, and sparse sampling can reduce accuracy.',
      'A visible still interval is labeled only as a possible breath hold.',
    ],
  };
}

function deriveFluidDynamics({ request, frames, answers, visibleFluid, fluidRelease, forbidden }) {
  const get = (id) => answers.get(id);
  const onset = get('visible_fluid_release_onset');
  const pulseCount = get('fluid_release_pulse_count');
  const streamDroplet = get('fluid_stream_or_droplet_visible');
  const projectionDistance = get('fluid_projection_distance_estimate');
  const trajectoryAngle = get('fluid_trajectory_angle_estimate');
  const velocityProxy = get('fluid_velocity_proxy_estimate');
  const volumeProxy = get('fluid_volume_proxy_estimate');
  const postEventFluid = get('post_event_fluid_presence');
  const cleanupWipe = get('cleanup_or_wipe_visible');
  const checkedFrames = frames.map((frame) => frame.frame_id);
  const releaseConfirmed = isVisible(fluidRelease, 0.65) || isVisible(visibleFluid, 0.75) || isVisible(onset, 0.65) || isVisible(streamDroplet, 0.65);
  const scale = cmPerPixel(request);
  const limitations = [
    'Clinical visual proxy only; true physical force is not estimated from ordinary video.',
  ];
  if (!scale) {
    limitations.push('No scale calibration was provided, so real-world distance and cm/sec velocity are unavailable.');
  }
  if (!isVisible(streamDroplet, 0.55)) {
    limitations.push('No visible stream/droplet path was confirmed, so trajectory and projection metrics may be unavailable.');
  }

  if (!releaseConfirmed) {
    return {
      release_detected: isUnconfirmed(fluidRelease) && isUnconfirmed(visibleFluid) ? 'not_visible' : 'uncertain',
      onset_ms: null,
      duration_ms: null,
      pulse_count: null,
      max_projected_distance_px: null,
      max_projected_distance_cm: null,
      trajectory_angle_degrees: null,
      velocity_proxy_px_per_sec: null,
      velocity_proxy_cm_per_sec: null,
      volume_proxy: 'none',
      confidence: Math.max(clamp01(fluidRelease?.confidence), clamp01(visibleFluid?.confidence), 0.2),
      frame_refs: [],
      limitations,
    };
  }

  const frameRefs = refs(onset, streamDroplet, projectionDistance, trajectoryAngle, velocityProxy, volumeProxy, visibleFluid, postEventFluid, cleanupWipe);
  const distancePx = isVisible(projectionDistance, 0.55)
    ? firstNumber(projectionDistance.attributes?.distance_px, projectionDistance.attributes?.max_projected_distance_px)
    : null;
  const durationMs = firstNumber(
    onset?.attributes?.duration_ms,
    fluidRelease?.attributes?.duration_ms,
  );
  const velocityPx = isVisible(velocityProxy, 0.55)
    ? firstNumber(velocityProxy.attributes?.velocity_px_per_sec, velocityProxy.attributes?.velocity_proxy_px_per_sec)
    : (distancePx != null && durationMs ? Number((distancePx / (durationMs / 1000)).toFixed(2)) : null);
  const pulseValue = isVisible(pulseCount, 0.6)
    ? firstNumber(pulseCount.attributes?.pulse_count, pulseCount.attributes?.count)
    : null;
  const angle = isVisible(trajectoryAngle, 0.55)
    ? firstNumber(trajectoryAngle.attributes?.angle_degrees, trajectoryAngle.attributes?.trajectory_angle_degrees)
    : null;
  const distanceCm = scale && distancePx != null ? Number((distancePx * scale).toFixed(2)) : null;
  const velocityCm = scale && velocityPx != null ? Number((velocityPx * scale).toFixed(2)) : null;

  if (!isVisible(pulseCount, 0.6)) {
    addForbidden(forbidden, 'fluid pulse count', 'Distinguishable repeated release bursts are not visibly confirmed.', checkedFrames);
  }
  if (!isVisible(projectionDistance, 0.55)) {
    addForbidden(forbidden, 'fluid projection distance', 'No visible fluid path or landing point supports a projection-distance estimate.', checkedFrames);
  }
  if (!scale) {
    addForbidden(forbidden, 'real-world fluid distance/velocity', 'No scale calibration is available; only pixel-based proxy metrics may be reported.', checkedFrames);
  }

  return {
    release_detected: 'visible',
    onset_ms: isVisible(onset, 0.6) ? firstNumber(onset.attributes?.onset_ms, frames.find((frame) => frame.frame_id === onset.evidence_frames?.[0])?.time_ms) : null,
    duration_ms: durationMs,
    pulse_count: pulseValue != null ? Math.max(0, Math.round(pulseValue)) : null,
    max_projected_distance_px: distancePx,
    max_projected_distance_cm: distanceCm,
    trajectory_angle_degrees: angle,
    velocity_proxy_px_per_sec: velocityPx,
    velocity_proxy_cm_per_sec: velocityCm,
    volume_proxy: boundedVolumeProxy(volumeProxy?.attributes?.volume_proxy || volumeProxy?.attributes?.volume || (isVisible(visibleFluid, 0.75) ? 'uncertain' : 'none')),
    confidence: Math.max(clamp01(fluidRelease?.confidence), clamp01(visibleFluid?.confidence), clamp01(streamDroplet?.confidence), 0.55),
    frame_refs: frameRefs,
    limitations,
  };
}

function qualityFromAnswers(answers) {
  const values = [...answers.values()];
  const visible = values.filter((answer) => answer.answer === 'visible').length;
  const uncertain = values.filter((answer) => answer.answer === 'uncertain').length;
  const confidence = values.length
    ? values.reduce((sum, answer) => sum + clamp01(answer.confidence), 0) / values.length
    : 0.25;
  return {
    overall: Number(Math.max(0.15, Math.min(0.92, confidence)).toFixed(2)),
    visibility_quality: Number(Math.max(0.1, Math.min(0.95, (visible + 1) / (values.length + 2) + (1 - uncertain / Math.max(values.length, 1)) * 0.25)).toFixed(2)),
    motion_quality: Number(Math.max(0.1, Math.min(0.9, confidence * 0.85)).toFixed(2)),
  };
}

export function deriveLocalVisionResult({
  request,
  frames = [],
  questions = [],
  answers: rawAnswers = [],
  engine = 'local_qwen25vl',
  model = { name: 'Qwen/Qwen2.5-VL-7B-Instruct', device: 'unknown', quantization: 'unknown' },
  warnings = [],
}) {
  const answers = answerMap(rawAnswers);
  const askedIds = new Set(questions.map((question) => question.id));
  const hasAny = (ids) => ids.some((id) => askedIds.has(id));
  const get = (id) => answers.get(id);
  const allFrameIds = frames.map((frame) => frame.frame_id);
  const visibleObjects = evidenceObjects(answers, [
    'foley_catheter_visible',
    'foley_tubing_visible',
    'statlock_visible',
    'adhesive_securement_device_visible',
    'gloved_hands_visible',
    'swab_gauze_syringe_lubricant_visible',
    'lubricant_or_syringe_visible',
    'gauze_or_swab_visible',
    'genital_state_visible',
    'erection_state_visible',
    'genital_visibility_obscured',
    'chest_or_abdomen_visible_for_respiration',
    'leg_or_foot_position_visible',
    'visible_fluid_present',
    'cleanup_material_visible',
    'lubricant_visible',
    'device_or_toy_visible',
  ], {
    foley_catheter_visible: 'foley_catheter',
    foley_tubing_visible: 'foley_tubing',
    statlock_visible: 'statlock_or_securement_device',
    adhesive_securement_device_visible: 'adhesive_securement_device',
    swab_gauze_syringe_lubricant_visible: 'prep_materials',
    lubricant_or_syringe_visible: 'lubricant_or_syringe',
    gauze_or_swab_visible: 'gauze_or_swab',
  });
  const visibleActions = evidenceObjects(answers, [
    'hands_touching_glans_or_meatus',
    'catheter_tip_at_or_entering_meatus',
    'visible_advancement_motion',
    'tubing_routing_or_field_handling',
    'urine_visible',
    'balloon_inflation_visible',
    'drape_applied_adjusted_or_removed',
    'hand_contact_with_genitals_visible',
    'stroking_motion_visible',
    'stroking_rhythm_estimate',
    'grip_or_contact_change_visible',
    'pelvic_motion_visible',
    'body_tension_or_relaxation_visible',
    'respiratory_cycles_visible',
    'possible_breath_hold_visible',
    'toe_curling_or_foot_flexion_visible',
    'ejaculation_or_fluid_release_visible',
    'visible_fluid_release_onset',
    'fluid_release_pulse_count',
    'fluid_stream_or_droplet_visible',
    'fluid_projection_distance_estimate',
    'fluid_trajectory_angle_estimate',
    'fluid_velocity_proxy_estimate',
    'fluid_volume_proxy_estimate',
    'post_ejaculation_state_visible',
    'post_event_fluid_presence',
    'cleanup_or_wipe_visible',
  ], {
    hands_touching_glans_or_meatus: 'hands_touching_glans_or_meatus',
    catheter_tip_at_or_entering_meatus: 'catheter_tip_at_or_entering_meatus',
    visible_advancement_motion: 'visible_advancement_motion',
    tubing_routing_or_field_handling: 'tubing_routing_or_field_handling',
    urine_visible: 'urine_visible',
    balloon_inflation_visible: 'balloon_inflation_visible',
  });

  const stageCandidates = [];
  const forbidden = [];
  const events = [];

  const tubing = get('foley_tubing_visible');
  const catheter = get('foley_catheter_visible');
  const statlock = get('statlock_visible');
  const adhesive = get('adhesive_securement_device_visible');
  const tubingHandling = get('tubing_routing_or_field_handling');
  const tipAtMeatus = get('catheter_tip_at_or_entering_meatus');
  const advancement = get('visible_advancement_motion');
  const urine = get('urine_visible');
  const balloon = get('balloon_inflation_visible');
  const drape = get('drape_applied_adjusted_or_removed');
  const prep = get('swab_gauze_syringe_lubricant_visible');
  const handsAtMeatus = get('hands_touching_glans_or_meatus');

  const foleyAsked = hasAny([
    'foley_catheter_visible',
    'foley_tubing_visible',
    'statlock_visible',
    'adhesive_securement_device_visible',
    'catheter_tip_at_or_entering_meatus',
    'visible_advancement_motion',
    'urine_visible',
    'balloon_inflation_visible',
  ]);
  const bodyAsked = hasAny([
    'hand_contact_with_genitals_visible',
    'stroking_motion_visible',
    'erection_state_visible',
    'ejaculation_or_fluid_release_visible',
    'visible_fluid_present',
    'toe_curling_or_foot_flexion_visible',
    'chest_or_abdomen_visible_for_respiration',
    'respiratory_cycles_visible',
    'possible_breath_hold_visible',
  ]);

  if (foleyAsked && (isVisible(prep, 0.5) || isVisible(drape, 0.5))) {
    addStage(stageCandidates, 'field_prep', Math.max(clamp01(prep?.confidence), clamp01(drape?.confidence)), 'Prep material or drape/field setup is visible; no stage is inferred beyond field/prep work.', refs(prep, drape));
  }
  if (foleyAsked && (isVisible(tubingHandling, 0.5) || (isVisible(tubing, 0.5) && isVisible(handsAtMeatus, 0.45) && !isVisible(advancement, 0.6)))) {
    addStage(stageCandidates, 'tubing_routing', Math.max(clamp01(tubingHandling?.confidence), clamp01(tubing?.confidence) * 0.8), 'Tubing or field handling is visible without enough evidence for securement or advancement.', refs(tubingHandling, tubing, handsAtMeatus));
    addEvent(events, request, 'visible_action', 'Tubing/field handling visible', Math.max(clamp01(tubingHandling?.confidence), 0.55), refs(tubingHandling, tubing)[0]);
  }
  if (foleyAsked && (isVisible(tipAtMeatus, 0.55) || isVisible(advancement, 0.55))) {
    addStage(stageCandidates, 'possible_advancement', Math.max(clamp01(tipAtMeatus?.confidence), clamp01(advancement?.confidence)), 'Tip-at-meatus or advancement motion is visually supported.', refs(tipAtMeatus, advancement));
    addEvent(events, request, 'stage_candidate', 'Possible visible catheter/tool advancement', Math.max(clamp01(tipAtMeatus?.confidence), clamp01(advancement?.confidence)), refs(tipAtMeatus, advancement)[0]);
  } else if (foleyAsked) {
    addForbidden(forbidden, 'catheter advancement', 'No visible tip-at-meatus or advancement motion evidence.', allFrameIds);
  }
  if (foleyAsked && isVisible(urine, 0.6)) {
    addStage(stageCandidates, 'urine_confirmation', clamp01(urine.confidence), 'Visible urine/fluid evidence is present in tubing, container, or bag.', refs(urine));
  } else if (foleyAsked) {
    addForbidden(forbidden, 'urine confirmation', 'No visible urine/fluid evidence is confirmed.', allFrameIds);
  }
  if (foleyAsked && isVisible(balloon, 0.65)) {
    addStage(stageCandidates, 'balloon_inflation', clamp01(balloon.confidence), 'Balloon inflation action is visually supported.', refs(balloon));
  } else if (foleyAsked) {
    addForbidden(forbidden, 'balloon inflation', 'No visible syringe/balloon-port inflation action is confirmed.', allFrameIds);
  }
  if (foleyAsked && isVisible(statlock, 0.75) && isVisible(adhesive, 0.75) && (isVisible(tubingHandling, 0.7) || isVisible(catheter, 0.7))) {
    addStage(stageCandidates, 'securement', Math.min(0.88, (clamp01(statlock.confidence) + clamp01(adhesive.confidence)) / 2), 'A distinct adhesive/securement device and related handling are visible.', refs(statlock, adhesive, tubingHandling, catheter));
  } else if (foleyAsked) {
    addForbidden(forbidden, 'StatLock securement', 'No StatLock/adhesive securement device is visibly present with sufficient evidence.', allFrameIds);
  }

  const obscured = get('genital_visibility_obscured');
  const genitalState = get('genital_state_visible');
  const erectionState = get('erection_state_visible');
  const scrotalPosition = get('scrotal_position_visible');
  const scrotalLiftChange = get('scrotal_lift_or_relaxation_change_visible');
  const scrotalTissueChange = get('scrotal_tissue_color_or_tension_change_visible');
  const handContact = get('hand_contact_with_genitals_visible');
  const stroking = get('stroking_motion_visible');
  const gripChange = get('grip_or_contact_change_visible');
  const fluidRelease = get('ejaculation_or_fluid_release_visible');
  const visibleFluid = get('visible_fluid_present');
  const cleanup = get('cleanup_material_visible');
  const bodyTension = get('body_tension_or_relaxation_visible');
  const footFlex = get('toe_curling_or_foot_flexion_visible');
  const streamDroplet = get('fluid_stream_or_droplet_visible');
  const postEventFluid = get('post_event_fluid_presence');
  const cleanupWipe = get('cleanup_or_wipe_visible');
  const respiration = deriveRespiration({ request, frames, answers, forbidden });

  if (bodyAsked && isVisible(handContact, 0.55) && (isVisible(stroking, 0.55) || isVisible(gripChange, 0.55))) {
    addStage(stageCandidates, 'manual_stimulation', Math.max(clamp01(stroking?.confidence), clamp01(gripChange?.confidence), clamp01(handContact?.confidence) * 0.85), 'Hand/genital contact plus repeated motion or grip/contact change is visually supported.', refs(handContact, stroking, gripChange));
    addEvent(events, request, 'visible_action', 'Manual genital contact/motion visible', Math.max(clamp01(stroking?.confidence), clamp01(gripChange?.confidence), 0.55), refs(handContact, stroking, gripChange)[0]);
  } else if (bodyAsked) {
    addForbidden(forbidden, 'stroking/manual stimulation', 'Repeated hand/genital motion is not visibly confirmed.', allFrameIds);
  }
  if (bodyAsked && isVisible(genitalState, 0.55) && !isVisible(obscured, 0.5) && erectionState?.answer === 'visible' && clamp01(erectionState.confidence) >= 0.55) {
    const state = erectionState.attributes?.state ? ` (${erectionState.attributes.state})` : '';
    addStage(stageCandidates, 'genital_state_change', clamp01(erectionState.confidence), `Erection/genital state is visually assessable${state}.`, refs(genitalState, erectionState));
  } else if (bodyAsked) {
    addForbidden(forbidden, 'specific erection state', 'Genital visibility is insufficient or the local visual answer was uncertain.', allFrameIds);
  }
  if (bodyAsked && !isVisible(obscured, 0.5) && (isVisible(scrotalPosition, 0.55) || isVisible(scrotalLiftChange, 0.55) || isVisible(scrotalTissueChange, 0.6))) {
    const position = scrotalPosition?.attributes?.position ? ` (${scrotalPosition.attributes.position})` : '';
    const confidence = Math.max(clamp01(scrotalPosition?.confidence), clamp01(scrotalLiftChange?.confidence), clamp01(scrotalTissueChange?.confidence));
    const basis = [
      isVisible(scrotalLiftChange, 0.55) ? 'visible scrotal/testicular lift, relaxation, or position change' : null,
      isVisible(scrotalTissueChange, 0.6) ? 'visible scrotal tissue color/tension change' : null,
      isVisible(scrotalPosition, 0.55) ? `scrotal/testicular position assessable${position}` : null,
    ].filter(Boolean).join('; ');
    addStage(stageCandidates, 'scrotal_state_change', confidence, basis || 'Scrotal/testicular state is visually assessable.', refs(scrotalPosition, scrotalLiftChange, scrotalTissueChange));
    if (isVisible(scrotalLiftChange, 0.55) || isVisible(scrotalTissueChange, 0.6)) {
      addEvent(events, request, 'physical', 'Scrotal/testicular state change visible', confidence, refs(scrotalLiftChange, scrotalTissueChange, scrotalPosition)[0]);
    }
  } else if (bodyAsked) {
    addForbidden(forbidden, 'specific scrotal/testicular state', 'Scrotal/testicular visibility or frame-to-frame change is not confirmed.', allFrameIds);
  }
  if (bodyAsked && (isVisible(fluidRelease, 0.65) || isVisible(visibleFluid, 0.75) || isVisible(streamDroplet, 0.65))) {
    addStage(stageCandidates, 'ejaculation_or_fluid_event', Math.max(clamp01(fluidRelease?.confidence), clamp01(visibleFluid?.confidence) * 0.85, clamp01(streamDroplet?.confidence) * 0.85), 'Visible fluid release, stream/droplet evidence, or high-confidence new fluid presence is confirmed. This is a visual fluid event only, not a subjective-state inference.', refs(fluidRelease, visibleFluid, streamDroplet));
    addEvent(events, request, 'visible_action', 'Visible fluid evidence present', Math.max(clamp01(fluidRelease?.confidence), clamp01(visibleFluid?.confidence), clamp01(streamDroplet?.confidence)), refs(fluidRelease, visibleFluid, streamDroplet)[0]);
  } else if (bodyAsked) {
    addForbidden(forbidden, 'ejaculation/fluid release', 'No visible fluid release or new visible fluid presence is confirmed.', allFrameIds);
  }
  if (bodyAsked && ((isVisible(visibleFluid, 0.65) && (isVisible(cleanup, 0.5) || isVisible(cleanupWipe, 0.5))) || isVisible(postEventFluid, 0.65) || request.previousVisualState?.confirmedFluidEvent)) {
    addStage(stageCandidates, 'post_ejaculation', Math.max(clamp01(visibleFluid?.confidence), clamp01(cleanup?.confidence), clamp01(cleanupWipe?.confidence), clamp01(postEventFluid?.confidence), 0.55), 'Visible fluid/cleanup evidence or a prior confirmed fluid event supports a post-fluid state.', refs(visibleFluid, cleanup, cleanupWipe, postEventFluid));
  }
  if (bodyAsked && (isVisible(bodyTension, 0.55) || isVisible(footFlex, 0.55))) {
    addStage(stageCandidates, 'body_or_foot_tension_change', Math.max(clamp01(bodyTension?.confidence), clamp01(footFlex?.confidence)), 'Visible physical movement, bracing, tension, relaxation, or foot/toe change is supported.', refs(bodyTension, footFlex));
  }
  if (respiration?.estimated_rate_bpm != null) {
    addStage(stageCandidates, 'visible_respiratory_pattern', respiration.confidence, `${respiration.breaths_observed} complete visible chest/abdominal cycles across ${respiration.observation_seconds} seconds support a rough rate of ${respiration.estimated_rate_bpm} breaths/min.`, respiration.frame_refs);
  }
  if (respiration?.possible_breath_hold) {
    addStage(stageCandidates, 'possible_breath_hold', respiration.confidence, `Possible ${respiration.hold_duration_seconds}-second breath hold based on sustained assessable chest/abdominal stillness; shallow breathing remains a confounder.`, respiration.frame_refs);
    events.push({
      time_ms: respiration.hold_start_ms,
      event_type: 'physical',
      label: `Possible breath hold (${respiration.hold_duration_seconds}s)`,
      confidence: clamp01(respiration.confidence),
      frame_ref: respiration.frame_refs[0] || null,
    });
  }

  if (!stageCandidates.length) {
    addStage(stageCandidates, 'unknown', 0.25, 'No gated stage has enough visible evidence. This is preferable to a false visual claim.', []);
  }

  const topStages = stageCandidates
    .slice()
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
    .map((stage) => stage.stage.replace(/_/g, ' '));
  const visibleBits = visibleObjects
    .filter((item) => item.status === 'visible')
    .slice(0, 3)
    .map((item) => item.label.replace(/_/g, ' '));
  const summary = [
    visibleBits.length ? `Local visual evidence confirms ${visibleBits.join(', ')}.` : 'Local visual evidence did not confirm major objects with high confidence.',
    `Gated stage candidates: ${topStages.join(', ')}.`,
    forbidden.length ? `${forbidden.length} unsafe claim${forbidden.length === 1 ? '' : 's'} blocked by visibility gates.` : '',
  ].filter(Boolean).join(' ');
  const fluidDynamics = deriveFluidDynamics({
    request,
    frames,
    answers,
    visibleFluid,
    fluidRelease,
    forbidden,
  });

  return {
    ok: true,
    engine,
    model,
    privacy: {
      localOnly: true,
      cloudUpload: false,
    },
    window: {
      sessionId: request.sessionId,
      recordType: request.recordType,
      startMs: request.startMs,
      endMs: request.endMs,
    },
    summary,
    visible_objects: visibleObjects,
    visible_actions: visibleActions,
    stage_candidates: stageCandidates.sort((a, b) => b.confidence - a.confidence),
    forbidden_or_not_visible: forbidden,
    fluid_dynamics: fluidDynamics,
    respiration,
    confidence: qualityFromAnswers(answers),
    timeline_events: events,
    frame_evidence: frames.map((frame) => ({
      frame_id: frame.frame_id,
      time_ms: frame.time_ms,
      image_path: frame.image_path,
      observations: rawAnswers
        .filter((answer) => (answer.evidence_frames || []).includes(frame.frame_id) && answer.answer === 'visible')
        .slice(0, 5)
        .map((answer) => answer.question_id),
    })),
    raw_answers: rawAnswers,
    questions: questions.map((question) => ({ id: question.id, label: question.label, domain: question.domain, category: question.category })),
    warnings: [
      ...warnings,
      ...(stageCandidates.some((stage) => stage.stage === 'unknown') ? ['No gated stage reached sufficient visual confidence.'] : []),
      ...([...answers.values()].some(isUnconfirmed) ? ['Some constrained visual questions were not visible or uncertain.'] : []),
    ],
  };
}
