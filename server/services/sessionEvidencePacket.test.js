import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSessionAnalysisEvidencePacket,
  normalizeGoldStandardSessionAnalysis,
  requiredAnalysisSectionsPresent,
} from '../../src/lib/sessionEvidencePacket.js';

const session = {
  id: 's1',
  date: '2026-06-07',
  duration_minutes: 15,
  intensity: 9,
  satisfaction: 8,
  build_quality: 7,
  build_type: 'plateau-heavy',
  methods: ['manual', 'silicone sleeve'],
  climax_offset_s: 624,
  hr_at_climax: 118,
  session_context: {
    fatigue: 'tired',
    hydration_state: 'electrolyte_supported',
    food_state: 'normal_meal',
    alcohol: { used: true, qualitative_level: 'moderate', timing_relative_to_session: 'under_30_min' },
    cannabis: { used: true, route: 'smoked', qualitative_level: 'moderate', timing_relative_to_session: 'under_30_min' },
    mental_state: ['calm', 'meditative'],
    privacy_interruptibility: 'fully_private',
    environmental_preparation: ['tools_prepared', 'telemetry_active'],
  },
  event_timeline: [
    { time_s: 41, note: 'Right hand makes first visible contact with shaft and scrotal-base region.', category: ['stimulation'], source: 'ai_video_pass' },
    { time_s: 432, note: 'Sleeve lifted and lubricant handled during a stimulation break.', category: ['stimulation_paused'], source: 'ai_video_pass' },
    { time_s: 624, note: 'Confirmed climax marker with visible whitish ejaculate.', category: ['physical'], source: 'ai_video_pass' },
  ],
  ai_analysis: {
    _video_pass_findings: [{
      id: 'vp1',
      label: 'AI video pass 7:12-7:36',
      clip: { start_s: 432, end_s: 456 },
      source_video: { label: 'Main' },
      summary: 'Sleeve stroking pauses as lubricant is handled, then resumes.',
      findings: [{ title: 'Lubrication break', text: 'Sleeve is lifted clear and lubricant bottle is handled.', confidence: 'high' }],
      draft_events: [{ time_s: 432, note: 'Sleeve lifted for lubrication break.', confidence: 'high' }],
      telemetry: 'HR avg 99 BPM.',
    }],
  },
};

const timelineRows = [
  { time_offset_s: 0, hr: 95, hrv_rmssd_ms: 6, hrv_sdnn_ms: 12, hrv_quality: 'moderate' },
  { time_offset_s: 300, hr: 103, hrv_rmssd_ms: 77, hrv_sdnn_ms: 65, hrv_quality: 'moderate' },
  { time_offset_s: 624, hr: 118, hrv_rmssd_ms: 59, hrv_sdnn_ms: 44, hrv_quality: 'high' },
];

test('shared evidence packet preserves context, video cards, HRV, and missing EMG', () => {
  const packet = buildSessionAnalysisEvidencePacket({ session, timelineRows, emgRows: [], userProfile: { arousal_notes: 'Left foot reacts first.' } });
  assert.equal(packet.user_logged_context.present, true);
  assert.match(packet.user_logged_context.text, /Alcohol: logged use/i);
  assert.match(packet.user_logged_context.text, /Cannabis: logged use/i);
  assert.equal(packet.visual_evidence.saved_sarah_video_cards_count, 1);
  assert.equal(packet.telemetry_findings.heart_rate.present, true);
  assert.equal(packet.hrv_findings.source, 'RR-interval-derived rolling HRV');
  assert.equal(packet.emg_findings.present, false);
  assert.match(packet.emg_findings.missing_statement, /No EMG data/i);
  assert.equal(packet.readiness, 'ready_for_full_sarah_synthesis');
});

test('gold-standard normalization supplies every required section and missing EMG statement', () => {
  const packet = buildSessionAnalysisEvidencePacket({ session, timelineRows, emgRows: [] });
  const normalized = normalizeGoldStandardSessionAnalysis({
    executive_summary: 'This is a structured session read.',
    chronological_deep_dive: [{ time_range: '0:00-1:00', paragraph: 'Baseline and first contact are reviewed.', evidence_refs: ['event-0'], claim_types: ['visual_evidence'] }],
    motion_evidence_interpretation: [{ paragraph: 'Motion evidence is limited to saved visual cards.', evidence_refs: ['visual_evidence'], claim_types: ['visual_evidence'] }],
    telemetry_interpretation: [{ paragraph: 'Heart rate and HRV are interpreted cautiously.', evidence_refs: ['hrv_findings'], claim_types: ['hrv_interpretation'] }],
    patterns_hypotheses: [{ paragraph: 'Hypothesis: plateau-heavy rhythm may explain oscillation.', evidence_refs: ['session_metadata'], claim_types: ['hypothesis'] }],
    recommendations_experiments: [{ paragraph: 'Track the sleeve-to-manual transition next time.', evidence_refs: ['visual_evidence'], claim_types: ['hypothesis'] }],
    limitations: [{ paragraph: 'Middle video coverage is incomplete.', evidence_refs: [], claim_types: ['limitation'] }],
    provenance_summary: [{ paragraph: 'Evidence came from the shared packet.', evidence_refs: ['session_evidence_packet'], claim_types: ['limitation'] }],
  }, packet);
  const present = requiredAnalysisSectionsPresent(normalized);
  for (const [key, ok] of Object.entries(present)) {
    assert.equal(ok, true, `${key} should be present`);
  }
  assert.match(normalized.emg_analysis[0].paragraph, /No EMG data/i);
});

test('normalization repairs third-person local wording into direct Sarah address', () => {
  const packet = buildSessionAnalysisEvidencePacket({ session, timelineRows, emgRows: [] });
  const normalized = normalizeGoldStandardSessionAnalysis({
    executive_summary: "The user's heart rate climbed during the session.",
    chronological_deep_dive: [{ time_range: '0:41', paragraph: 'The user made first visible contact according to the card.', evidence_refs: ['event-0'], claim_types: ['visual_evidence'] }],
    motion_evidence_interpretation: [{ paragraph: "The user's movement evidence is limited.", evidence_refs: ['visual_evidence'], claim_types: ['visual_evidence'] }],
    telemetry_interpretation: [{ paragraph: 'The patient had a peak HR of 118 BPM.', evidence_refs: ['telemetry_findings'], claim_types: ['telemetry_evidence'] }],
    emg_analysis: [{ paragraph: 'No EMG data was logged or captured in this session.', evidence_refs: ['emg_findings'], claim_types: ['limitation'] }],
    patterns_hypotheses: [{ paragraph: 'Your plateau-heavy build may explain oscillation.', evidence_refs: ['session_metadata'], claim_types: ['hypothesis'] }],
    recommendations_experiments: [{ paragraph: 'Track this transition next time.', evidence_refs: ['visual_evidence'], claim_types: ['hypothesis'] }],
    limitations: [{ paragraph: 'The user should treat weak windows cautiously.', evidence_refs: [], claim_types: ['limitation'] }],
    provenance_summary: [{ paragraph: 'The findings are based on the shared packet.', evidence_refs: ['session_evidence_packet'], claim_types: ['limitation'] }],
  }, packet, { repairDetachedPersona: true });

  const rendered = JSON.stringify(normalized);
  assert.doesNotMatch(rendered, /\bthe user\b/i);
  assert.doesNotMatch(rendered, /\bthe user's\b/i);
  assert.doesNotMatch(rendered, /\bthe patient\b/i);
  assert.match(normalized.executive_summary, /^Your heart rate/i);
  assert.match(normalized.chronological_deep_dive[0].paragraph, /^You made/i);
});

test('persona repair removes detached labels before rendering or saving', () => {
  const packet = buildSessionAnalysisEvidencePacket({ session, timelineRows, emgRows: [] });
  const normalized = normalizeGoldStandardSessionAnalysis({
    executive_summary: "This user had context in the packet. The subject's telemetry is reviewed.",
    chronological_deep_dive: [{ time_range: '0:00-1:00', paragraph: 'The individual showed a telemetry change. The patient remained in the reviewed window.', evidence_refs: ['telemetry_findings'], claim_types: ['telemetry_evidence'] }],
    motion_evidence_interpretation: [{ paragraph: "The subject's motion evidence is limited.", evidence_refs: [], claim_types: ['limitation'] }],
    telemetry_interpretation: [{ paragraph: "The individual's HRV data suggests cautious interpretation.", evidence_refs: ['hrv_findings'], claim_types: ['hrv_interpretation'] }],
    emg_analysis: [{ paragraph: 'No EMG data was logged or captured in this session.', evidence_refs: ['emg_findings'], claim_types: ['limitation'] }],
    patterns_hypotheses: [{ paragraph: 'Your pattern should be treated cautiously.', evidence_refs: [], claim_types: ['hypothesis'] }],
    recommendations_experiments: [{ paragraph: 'Track your logged context next time.', evidence_refs: ['user_logged_context'], claim_types: ['hypothesis'] }],
    limitations: [{ paragraph: 'The patient has limited visual evidence.', evidence_refs: [], claim_types: ['limitation'] }],
    provenance_summary: [{ paragraph: 'Evidence came from the shared packet.', evidence_refs: ['session_evidence_packet'], claim_types: ['limitation'] }],
  }, packet, { repairDetachedPersona: true });

  const rendered = JSON.stringify(normalized);
  assert.doesNotMatch(rendered, /\bthe user\b|\bthis user\b|\bthe subject\b|\bthe individual\b|\bthe patient\b/i);
  assert.match(normalized.executive_summary, /^You had context/i);
  assert.match(normalized.telemetry_interpretation[0].paragraph, /^Your HRV data suggests/i);
});

test('persona repair fixes simple agreement after detached-label replacement', () => {
  const packet = buildSessionAnalysisEvidencePacket({ session, timelineRows, emgRows: [] });
  const normalized = normalizeGoldStandardSessionAnalysis({
    executive_summary: 'The patient is encouraged to log EMG data. The subject has HRV data.',
    chronological_deep_dive: [{ time_range: '0:00-1:00', paragraph: 'The individual was in the reviewed session window.', evidence_refs: ['telemetry_findings'], claim_types: ['telemetry_evidence'] }],
    motion_evidence_interpretation: [{ paragraph: 'Motion evidence is limited to saved cards.', evidence_refs: ['visual_evidence'], claim_types: ['limitation'] }],
    telemetry_interpretation: [{ paragraph: 'Your HRV data suggests cautious interpretation.', evidence_refs: ['hrv_findings'], claim_types: ['hrv_interpretation'] }],
    emg_analysis: [{ paragraph: 'No EMG data was logged or captured in this session.', evidence_refs: ['emg_findings'], claim_types: ['limitation'] }],
    patterns_hypotheses: [{ paragraph: 'Your pattern should be treated cautiously.', evidence_refs: [], claim_types: ['hypothesis'] }],
    recommendations_experiments: [{ paragraph: 'Track your logged context next time.', evidence_refs: ['user_logged_context'], claim_types: ['hypothesis'] }],
    limitations: [{ paragraph: 'The patient is missing EMG data.', evidence_refs: [], claim_types: ['limitation'] }],
    provenance_summary: [{ paragraph: 'Evidence came from the shared packet.', evidence_refs: ['session_evidence_packet'], claim_types: ['limitation'] }],
  }, packet, { repairDetachedPersona: true });

  const rendered = JSON.stringify(normalized);
  assert.doesNotMatch(rendered, /\byou is\b|\byou was\b|\byou has\b/i);
  assert.match(normalized.executive_summary, /^You are encouraged/i);
});

test('normalization removes unsupported invented claims without overwriting executive summary', () => {
  const sparsePacket = buildSessionAnalysisEvidencePacket({
    session: {
      id: 'sparse',
      date: '2026-06-08',
      event_timeline: [],
      ai_analysis: {},
      session_context: { fatigue: 'tired' },
    },
    timelineRows: [{ time_offset_s: 0, hr: 90 }],
    emgRows: [],
  });
  const normalized = normalizeGoldStandardSessionAnalysis({
    executive_summary: 'The session involved prostate massage using a perineum pressure technique with multiple near-climax events.',
    chronological_deep_dive: [{ time_range: '0:00-1:00', paragraph: 'The user engaged in prostate massage and reached near-climax repeatedly.', evidence_refs: [], claim_types: ['visual_evidence'] }],
    motion_evidence_interpretation: [{ paragraph: "The user's hands moved in a circular pattern around the perineum area.", evidence_refs: [], claim_types: ['visual_evidence'] }],
    telemetry_interpretation: [{ paragraph: 'HRV data should be interpreted cautiously because only heart-rate data was available.', evidence_refs: ['telemetry_findings'], claim_types: ['telemetry_evidence'] }],
    emg_analysis: [{ paragraph: 'No EMG data was logged or captured in this session.', evidence_refs: ['emg_findings'], claim_types: ['limitation'] }],
    patterns_hypotheses: [{ paragraph: 'Near-climax cycling may have occurred.', evidence_refs: [], claim_types: ['hypothesis'] }],
    recommendations_experiments: [{ paragraph: 'Experiment with prostate massage techniques.', evidence_refs: [], claim_types: ['hypothesis'] }],
    limitations: [{ paragraph: 'Visual evidence is limited.', evidence_refs: [], claim_types: ['limitation'] }],
    provenance_summary: [{ paragraph: 'Evidence came from the shared packet.', evidence_refs: ['session_evidence_packet'], claim_types: ['limitation'] }],
  }, sparsePacket);

  const rendered = JSON.stringify(normalized);
  assert.equal(normalized.executive_summary, 'The session involved prostate massage using a perineum pressure technique with multiple near-climax events.');
  assert.doesNotMatch(rendered, /This local Sarah analysis is evidence-limited/i);
  assert.doesNotMatch(rendered, /No structured logged context was available/i);
  assert.doesNotMatch(rendered, /Heart-rate telemetry was not available/i);
  assert.doesNotMatch(rendered, /The local model tried/i);
  assert.deepEqual(normalized.chronological_deep_dive[0].claim_types, ['limitation']);
  assert.match(normalized.motion_evidence_interpretation[0].paragraph, /cannot be confirmed/i);
  assert.match(normalized.recommendations_experiments[0].paragraph, /improve the underlying evidence packet/i);
});

test('normalization does not claim missing evidence when event notes and telemetry are present', () => {
  const packet = buildSessionAnalysisEvidencePacket({
    session: {
      ...session,
      ai_analysis: {},
    },
    timelineRows,
    emgRows: [],
  });
  assert.equal(packet.counts.ai_video_pass_event_notes, 3);
  assert.equal(packet.user_logged_context.present, true);
  assert.equal(packet.telemetry_findings.heart_rate.present, true);
  assert.equal(packet.hrv_findings.source, 'RR-interval-derived rolling HRV');
  assert.equal(packet.visual_evidence.saved_sarah_video_cards_count, 0);

  const normalized = normalizeGoldStandardSessionAnalysis({
    executive_summary: 'Your session has accepted video-pass event notes, structured context, HR telemetry, and RR-derived HRV. Climax was not retained as a supported claim.',
    chronological_deep_dive: [{ time_range: '0:41', paragraph: 'Accepted event notes show first visible contact at the shaft and scrotal-base region.', evidence_refs: ['event-0'], claim_types: ['visual_evidence'] }],
    motion_evidence_interpretation: [],
    telemetry_interpretation: [{ paragraph: 'Heart rate and HRV are available and should be interpreted cautiously.', evidence_refs: ['hrv_findings'], claim_types: ['hrv_interpretation'] }],
    emg_analysis: [{ paragraph: 'No EMG data was logged or captured in this session.', evidence_refs: ['emg_findings'], claim_types: ['limitation'] }],
    patterns_hypotheses: [],
    recommendations_experiments: [],
    limitations: [],
    provenance_summary: [{ paragraph: 'Evidence came from accepted video-pass event notes, structured context, HR telemetry, and HRV.', evidence_refs: ['session_evidence_packet'], claim_types: ['limitation'] }],
  }, packet);

  const rendered = JSON.stringify(normalized);
  assert.match(normalized.executive_summary, /accepted video-pass event notes/i);
  assert.match(normalized.motion_evidence_interpretation[0].paragraph, /accepted event notes/i);
  assert.doesNotMatch(rendered, /This local Sarah analysis is evidence-limited/i);
  assert.doesNotMatch(rendered, /No structured logged context was available/i);
  assert.doesNotMatch(rendered, /Heart-rate telemetry was not available/i);
  assert.doesNotMatch(rendered, /No saved visual evidence cards were available/i);
  assert.doesNotMatch(rendered, /The local model tried/i);
});

test('normalization removes unsupported visual and HRV certainty claims cleanly', () => {
  const sparsePacket = buildSessionAnalysisEvidencePacket({
    session: {
      id: 'sparse-hrv',
      date: '2026-06-08',
      event_timeline: [],
      ai_analysis: {},
    },
    timelineRows: [
      { time_offset_s: 0, hr: 90, hrv_rmssd_ms: 20, hrv_sdnn_ms: 30, hrv_quality: 'moderate' },
      { time_offset_s: 60, hr: 96, hrv_rmssd_ms: 12, hrv_sdnn_ms: 22, hrv_quality: 'moderate' },
    ],
    emgRows: [],
  });
  const normalized = normalizeGoldStandardSessionAnalysis({
    executive_summary: 'Telemetry exists, but visual evidence is limited.',
    chronological_deep_dive: [{ time_range: '0:00-1:00', paragraph: 'Your hands are seen moving rhythmically, indicating manual stimulation.', evidence_refs: [], claim_types: ['visual_evidence'] }],
    motion_evidence_interpretation: [{ paragraph: 'Your hands are seen moving rhythmically, indicating manual stimulation.', evidence_refs: [], claim_types: ['visual_evidence'] }],
    telemetry_interpretation: [{ paragraph: 'HRV data shows a decrease in heart rate variability during the session, indicating increased arousal and tension.', evidence_refs: ['hrv_findings'], claim_types: ['hrv_interpretation'] }],
    emg_analysis: [{ paragraph: 'No EMG data was logged or captured in this session.', evidence_refs: ['emg_findings'], claim_types: ['limitation'] }],
    patterns_hypotheses: [],
    recommendations_experiments: [],
    limitations: [],
    provenance_summary: [{ paragraph: 'Evidence came from the shared packet.', evidence_refs: ['session_evidence_packet'], claim_types: ['limitation'] }],
  }, sparsePacket, { repairDetachedPersona: true });

  const rendered = JSON.stringify(normalized);
  assert.doesNotMatch(rendered, /hands are seen moving rhythmically/i);
  assert.doesNotMatch(rendered, /indicating increased arousal and tension/i);
  assert.match(normalized.telemetry_interpretation[0].paragraph, /HRV can support cautious autonomic interpretation/i);
});

test('normalization preserves visual claims when saved video cards are present', () => {
  const packet = buildSessionAnalysisEvidencePacket({ session, timelineRows, emgRows: [] });
  assert.equal(packet.visual_evidence.saved_sarah_video_cards_count, 1);
  assert.equal(packet.counts.ai_video_pass_event_notes, 3);

  const normalized = normalizeGoldStandardSessionAnalysis({
    executive_summary: 'Your session includes saved Sarah video-pass evidence and a logged climax marker.',
    chronological_deep_dive: [{ time_range: '7:12-7:36', paragraph: 'Your hands are seen moving around the saved video-pass window, with lubricant handling described in the saved Sarah card.', evidence_refs: ['visual_evidence.cards.0'], claim_types: ['visual_evidence'] }],
    motion_evidence_interpretation: [{ paragraph: 'Saved visual evidence supports a lubrication break and sleeve handling in this window.', evidence_refs: ['visual_evidence.cards.0'], claim_types: ['visual_evidence'] }],
    telemetry_interpretation: [{ paragraph: 'Heart-rate and HRV evidence should be interpreted cautiously alongside the saved visual card.', evidence_refs: ['hrv_findings'], claim_types: ['hrv_interpretation'] }],
    emg_analysis: [{ paragraph: 'No EMG data was logged or captured in this session.', evidence_refs: ['emg_findings'], claim_types: ['limitation'] }],
    patterns_hypotheses: [{ paragraph: 'The saved card may help anchor a stimulation pause hypothesis.', evidence_refs: ['visual_evidence.cards.0'], claim_types: ['hypothesis'] }],
    recommendations_experiments: [{ paragraph: 'Keep accepting useful video-pass cards before running Sarah analysis.', evidence_refs: ['visual_evidence'], claim_types: ['hypothesis'] }],
    limitations: [{ paragraph: 'Visual claims should stay limited to saved Sarah video-pass evidence.', evidence_refs: ['visual_evidence'], claim_types: ['limitation'] }],
    provenance_summary: [{ paragraph: 'Evidence came from saved video cards and telemetry.', evidence_refs: ['session_evidence_packet'], claim_types: ['limitation'] }],
  }, packet, { repairDetachedPersona: true });

  assert.match(normalized.executive_summary, /saved Sarah video-pass evidence/i);
  assert.match(normalized.chronological_deep_dive[0].paragraph, /Your hands are seen/i);
  assert.doesNotMatch(JSON.stringify(normalized), /evidence-limited|specific movement or technique findings cannot be confirmed/i);
});

test('normalization preserves visual claims grounded in accepted video-pass event notes without saved cards', () => {
  const packet = buildSessionAnalysisEvidencePacket({
    session: {
      ...session,
      event_timeline: [
        { time_s: 41, note: 'Right hand makes first visible contact with shaft and scrotal-base region.', category: ['stimulation'], source: 'ai_video_pass' },
        { time_s: 432, note: 'Sleeve lifted and lubricant handled during a stimulation break.', category: ['stimulation_paused'], source: 'ai_video_pass' },
      ],
      ai_analysis: {},
    },
    timelineRows,
    emgRows: [],
  });
  assert.equal(packet.visual_evidence.saved_sarah_video_cards_count, 0);
  assert.equal(packet.counts.ai_video_pass_event_notes, 2);

  const normalized = normalizeGoldStandardSessionAnalysis({
    executive_summary: 'The accepted video-pass event notes show first visible contact and a later lubrication break, with HR telemetry available for cautious interpretation.',
    chronological_deep_dive: [{ time_range: '0:41-7:12', paragraph: 'The accepted event notes show your right hand making first visible contact, then later describe the sleeve being lifted and lubricant handled during a stimulation break.', evidence_refs: ['event-0', 'event-1'], claim_types: ['visual_evidence'] }],
    motion_evidence_interpretation: [{ paragraph: 'Motion evidence is grounded in accepted video-pass event notes rather than saved video cards.', evidence_refs: ['session_timeline'], claim_types: ['visual_evidence'] }],
    telemetry_interpretation: [{ paragraph: 'Heart-rate and HRV evidence should be interpreted cautiously alongside the accepted event notes.', evidence_refs: ['hrv_findings'], claim_types: ['hrv_interpretation'] }],
    emg_analysis: [{ paragraph: 'No EMG data was logged or captured in this session.', evidence_refs: ['emg_findings'], claim_types: ['limitation'] }],
    patterns_hypotheses: [{ paragraph: 'The event timing may support a pause-and-resume pattern.', evidence_refs: ['session_timeline'], claim_types: ['hypothesis'] }],
    recommendations_experiments: [{ paragraph: 'Keep accepting useful video-pass notes and note transition times next session.', evidence_refs: ['session_timeline'], claim_types: ['hypothesis'] }],
    limitations: [{ paragraph: 'No saved video card is attached, so visual claims should stay tied to accepted event notes.', evidence_refs: ['visual_evidence'], claim_types: ['limitation'] }],
    provenance_summary: [{ paragraph: 'Evidence came from accepted video-pass event notes and telemetry.', evidence_refs: ['session_evidence_packet'], claim_types: ['limitation'] }],
  }, packet, { repairDetachedPersona: true });

  const rendered = JSON.stringify(normalized);
  assert.match(normalized.executive_summary, /accepted video-pass event notes/i);
  assert.match(normalized.chronological_deep_dive[0].paragraph, /first visible contact/i);
  assert.match(normalized.motion_evidence_interpretation[0].paragraph, /accepted video-pass event notes/i);
  assert.doesNotMatch(rendered, /specific movement or technique findings cannot be confirmed/i);
});
