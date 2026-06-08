import { buildSarahLocalAnnotationCards } from '../../../src/lib/localVisionDisplay.js';

function array(value) {
  return Array.isArray(value) ? value : [];
}

function confidenceWord(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'uncertain';
  if (n >= 0.8) return 'high';
  if (n >= 0.6) return 'moderate';
  return 'low';
}

function refsFrom(item) {
  return [...new Set(array(item?.frame_refs || item?.evidence_refs || item?.evidenceFrames).filter(Boolean))];
}

export function findingFromEvent(event) {
  return {
    label: event.label || event.event_type || 'local visual finding',
    start_ms: event.start_ms ?? event.time_ms ?? null,
    end_ms: event.end_ms ?? event.start_ms ?? event.time_ms ?? null,
    confidence: Number(event.confidence || 0),
    confidence_label: confidenceWord(event.confidence),
    source: event.source || 'adaptive_local_vision',
    basis: event.basis || 'Promoted by local visual gates.',
    frame_refs: refsFrom(event),
    status: 'confirmed',
  };
}

export function candidateSummary(candidate, status = 'candidate_not_confirmed') {
  return {
    candidate_id: candidate.candidate_id,
    label: String(candidate.type || candidate.label || 'candidate').replace(/_/g, ' '),
    type: candidate.type || 'candidate',
    start_ms: candidate.start_ms ?? null,
    end_ms: candidate.end_ms ?? null,
    confidence: Number(candidate.confidence ?? candidate.score ?? 0),
    confidence_label: confidenceWord(candidate.confidence ?? candidate.score),
    status,
    lifecycle: array(candidate.lifecycle),
    basis: candidate.basis || array(candidate.reasons).join('; ') || 'Candidate detected by local CV pre-pass.',
    frame_refs: refsFrom(candidate),
  };
}

export function buildNotConfirmed({ recordType, qwenResults = [], rejectedCandidates = [] }) {
  const items = new Map();
  const add = (label, reason, frameRefs = []) => {
    if (!items.has(label)) {
      items.set(label, {
        label,
        reason,
        frame_refs_checked: [...new Set(frameRefs.filter(Boolean))],
      });
      return;
    }
    const existing = items.get(label);
    existing.frame_refs_checked = [...new Set([...existing.frame_refs_checked, ...frameRefs.filter(Boolean)])];
  };

  for (const result of qwenResults) {
    for (const item of array(result.forbidden_or_not_visible)) {
      add(item.claim, item.reason || 'Checked but not visually confirmed.', array(item.frame_refs_checked));
    }
  }

  if (String(recordType) === 'masturbation') {
    add('stroking/manual stimulation not confirmed', 'Repeated visible hand/genital motion did not pass confirmation gates.');
    add('ejaculation/fluid release not confirmed', 'No confirmed visible fluid release or new visible fluid event was promoted.');
    add('specific erection state not confirmed', 'Specific erection state requires sufficient genital visibility and did not pass gates.');
  }
  if (String(recordType) === 'foley_procedure') {
    add('catheter advancement not confirmed', 'Advancement requires visible tip/motion evidence.');
    add('Foley securement not confirmed', 'Securement requires a visible adhesive anchor/securement device.');
  }
  for (const candidate of rejectedCandidates) {
    add(`${String(candidate.type || 'candidate').replace(/_/g, ' ')} rejected`, candidate.rejection_reason || 'Candidate did not pass local visual gates.', refsFrom(candidate));
  }
  return [...items.values()];
}

export function buildSessionAnalysisExport({
  mode,
  recordType,
  actionableFindings = [],
  strongCandidates = [],
  unresolvedCandidates = [],
  downgradedCandidates = [],
  coverageSegments = [],
  notConfirmed = [],
  limitations = [],
}) {
  const localAnnotationCards = buildSarahLocalAnnotationCards({
    actionable_findings: actionableFindings,
    strong_candidates: strongCandidates,
    not_confirmed: notConfirmed,
  });
  return {
    mode: 'adaptive_candidate_pipeline',
    analysis_mode: mode,
    analysis_type: recordType,
    local_annotation_cards: localAnnotationCards,
    annotation_summary: localAnnotationCards.length
      ? `${localAnnotationCards.length} Sarah-style local annotation card${localAnnotationCards.length === 1 ? '' : 's'} prepared from confirmed findings, strong candidates, and not-confirmed checks.`
      : 'Local annotation did not produce useful session events from this run.',
    confirmed_findings: actionableFindings.map(findingFromEvent).sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0)),
    strong_candidates: strongCandidates.map((candidate) => candidateSummary(candidate, 'candidate_not_confirmed')).sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0)),
    unresolved_candidates: unresolvedCandidates.map((candidate) => candidateSummary(candidate, 'unresolved')).sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0)),
    downgraded_candidates: downgradedCandidates.map((candidate) => candidateSummary(candidate, 'downgraded')).sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0)),
    coverage_segments: array(coverageSegments).map((segment) => ({
      start_ms: segment.start_ms ?? null,
      end_ms: segment.end_ms ?? null,
      label: segment.label || segment.type || 'coverage segment',
      type: segment.type || 'coverage_segment',
      status: segment.status || 'unknown',
      reviewed_by_qwen: Boolean(segment.reviewed_by_qwen),
      confidence: Number(segment.confidence || 0),
      basis: segment.basis || '',
      frame_refs: refsFrom(segment),
    })).sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0)),
    not_confirmed: notConfirmed,
    limitations,
  };
}
