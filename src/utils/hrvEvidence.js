const USABLE_QUALITY = new Set(["moderate", "high"]);

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function qualityRank(value) {
  if (value === "high") return 3;
  if (value === "moderate") return 2;
  if (value === "low") return 1;
  return 0;
}

function summarizeRows(rows) {
  if (!rows.length) return null;
  const rmssd = rows.map((row) => numberOrNull(row.hrv_rmssd_ms)).filter(Number.isFinite);
  const sdnn = rows.map((row) => numberOrNull(row.hrv_sdnn_ms)).filter(Number.isFinite);
  const pnn50 = rows.map((row) => numberOrNull(row.hrv_pnn50)).filter(Number.isFinite);
  const qualities = rows.map((row) => String(row.hrv_quality || "").toLowerCase()).filter(Boolean);
  const bestQuality = qualities.sort((a, b) => qualityRank(b) - qualityRank(a))[0] || "unknown";
  const usableRows = rows.filter((row) => USABLE_QUALITY.has(String(row.hrv_quality || "").toLowerCase()));

  return {
    row_count: rows.length,
    usable_row_count: usableRows.length,
    best_quality: bestQuality,
    median_rmssd_ms: round(median(rmssd)),
    median_sdnn_ms: round(median(sdnn)),
    median_pnn50: round(median(pnn50), 3),
  };
}

function phaseLabel(timeSeconds, session, durationSeconds) {
  const climax = numberOrNull(session?.climax_offset_s);
  const recovery = numberOrNull(session?.recovery_offset_s);
  const preClimax = numberOrNull(session?.pre_climax_offset_s);

  if (climax != null) {
    if (recovery != null && timeSeconds >= recovery) return "recovery";
    if (timeSeconds >= climax) return "climax_to_recovery";
    if (preClimax != null && timeSeconds >= preClimax) return "pre_climax";
    return "build";
  }

  if (!durationSeconds) return "session";
  const fraction = timeSeconds / durationSeconds;
  if (fraction < 0.25) return "early";
  if (fraction > 0.75) return "late";
  return "middle";
}

export function buildSessionHrvEvidence(timelineRows = [], session = {}) {
  const rows = timelineRows
    .map((row) => ({
      ...row,
      _time_s: numberOrNull(row.time_offset_s),
      _rmssd_ms: numberOrNull(row.hrv_rmssd_ms),
      _sdnn_ms: numberOrNull(row.hrv_sdnn_ms),
      _pnn50: numberOrNull(row.hrv_pnn50),
      _quality: String(row.hrv_quality || "").toLowerCase(),
    }))
    .filter((row) => row._time_s != null && (row._rmssd_ms != null || row._sdnn_ms != null));

  if (!rows.length) return null;

  const durationSeconds = Math.max(...rows.map((row) => row._time_s));
  const overall = summarizeRows(rows);
  const phaseGroups = new Map();
  for (const row of rows) {
    const label = phaseLabel(row._time_s, session, durationSeconds);
    const group = phaseGroups.get(label) || [];
    group.push(row);
    phaseGroups.set(label, group);
  }

  const phases = Object.fromEntries(
    [...phaseGroups.entries()]
      .map(([label, phaseRows]) => [label, summarizeRows(phaseRows)])
      .filter(([, summary]) => summary),
  );

  const usableRows = rows.filter((row) => USABLE_QUALITY.has(row._quality));
  const sampleSource = usableRows.length ? usableRows : rows;
  const step = Math.max(1, Math.floor(sampleSource.length / 12));
  const trajectory = sampleSource
    .filter((_, index) => index % step === 0)
    .slice(0, 12)
    .map((row) => ({
      time_s: Math.round(row._time_s),
      rmssd_ms: round(row._rmssd_ms),
      sdnn_ms: round(row._sdnn_ms),
      pnn50: round(row._pnn50, 3),
      quality: row._quality || "unknown",
    }));

  return {
    source: "RR-interval-derived rolling HRV",
    interpretation_status: overall.usable_row_count > 0 ? "usable_with_quality_caution" : "low_quality_only",
    duration_s: Math.round(durationSeconds),
    overall,
    phases,
    sampled_trajectory: trajectory,
  };
}

export function buildLongitudinalHrvEvidence(sessions = [], timelineMap = {}) {
  const sessionEvidence = sessions
    .slice(0, 80)
    .map((session) => {
      const evidence = buildSessionHrvEvidence(timelineMap[session.id] || [], session);
      if (!evidence) return null;
      return {
        session_id: session.id,
        date: session.date?.slice?.(0, 10) || session.date || null,
        methods: session.methods || [],
        intensity: session.intensity ?? null,
        satisfaction: session.satisfaction ?? null,
        no_climax: Boolean(session.no_climax),
        hrv: {
          source: evidence.source,
          interpretation_status: evidence.interpretation_status,
          overall: evidence.overall,
          phases: evidence.phases,
        },
      };
    })
    .filter(Boolean);

  if (!sessionEvidence.length) return null;
  return {
    sessions_with_rr_hrv: sessionEvidence.length,
    sessions_with_usable_rr_hrv: sessionEvidence.filter((item) => item.hrv.interpretation_status === "usable_with_quality_caution").length,
    sessions: sessionEvidence,
  };
}

export const RR_HRV_INTERPRETATION_RULES = `
RR-DERIVED HRV INTERPRETATION RULES:
- HRV values labeled here as RMSSD, SDNN, or pNN50 come from recorded RR intervals. Do not confuse them with variability or roughness calculated from sampled beats-per-minute values.
- Treat moderate- or high-quality rows as usable evidence. Low-quality-only HRV may be mentioned as unavailable or limited, but do not interpret its direction.
- These are rolling within-session measurements, not a standardized resting morning HRV baseline. Use them to describe changes across this session or repeated session-linked patterns, not the person's general cardiovascular health.
- Interpret HRV alongside heart rate, timing, movement, stimulation changes, breathing notes, and recovery markers. Do not claim that one HRV value proves sympathetic or parasympathetic state, arousal level, vagal tone, illness, fitness, or diagnosis.
- Prefer cautious language such as "RR-derived HRV fell during this window" or "recovery showed a higher rolling RMSSD than the build phase" when the quality and repeated data support it.
`;
