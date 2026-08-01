const PROCEDURE_TERMS = /\b(?:catheter|foley|urethr|sound(?:ing)?|dilat(?:e|ion|or)|hegar|enema|rectal|anal|anus|probe|insert(?:ion|ed)?|advance(?:ment|d)?|depth|meatus|bulbar|sphincter|prostat(?:e|ic)|bladder neck|balloon)\b/i;
const ENEMA_TERMS = /\b(?:enema|rectal|anal|anus|perianal|nozzle|tip|tube|instill|retention|hold|urge|leak(?:age)?|return|expel|evacuat|fleet)\b/i;
const MILESTONE_TERMS = /\b(?:contact|enter|insert|advance|depth|fully|seated|resistance|sphincter|bulbar|prostat|bladder|balloon|inject|instill|withdraw|remove|expel|gasp|cramp|pressure)\b/i;
const ENEMA_MILESTONE_TERMS = /\b(?:approach|contact|insert(?:ion|ed)?|instill(?:ation|ed|ing)?|flow|retention|retain|hold|urge|cramp(?:ing)?|spasm|leak(?:age)?|return|expel|release|withdraw(?:al|n)?|remove|fully inserted|fully in)\b/i;
const ENEMA_PHASE_BUCKETS = [
  /\b(?:approach|contact)\b/i,
  /\b(?:insert(?:ion|ed)?|fully inserted|fully in)\b/i,
  /\b(?:instill(?:ation|ed|ing)?|flow)\b/i,
  /\b(?:retention|retain|hold|urge|cramp(?:ing)?|spasm)\b/i,
  /\b(?:leak(?:age)?|return|expel|release|withdraw(?:al|n)?|remove)\b/i,
];
const USABLE_HRV_QUALITY = new Set(["moderate", "high"]);

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function cleanText(value, maxChars = 260) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
}

function eventTime(event = {}) {
  return numberOrNull(event.time_s ?? event.time_offset_s ?? event.offset_s ?? event.timestamp_s);
}

function rowTime(row = {}) {
  return numberOrNull(row.time_offset_s ?? row.time_s ?? row.offset_s ?? row.timestamp_s);
}

function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function recordText(record = {}) {
  return [
    record.title,
    record.exploration_type,
    ...(Array.isArray(record.methods) ? record.methods : []),
    record.notes,
    ...(Array.isArray(record.event_timeline)
      ? record.event_timeline.map((event) => event?.note || event?.description || event?.label)
      : []),
  ].filter(Boolean).join(" ");
}

export function isProcedurePhysiologyRecord(record = {}) {
  return PROCEDURE_TERMS.test(recordText(record));
}

function isEnemaProcedureRecord(record = {}) {
  return ENEMA_TERMS.test(recordText(record));
}

export function selectProcedureMilestones(record = {}, limit = 6) {
  const enemaRecord = isEnemaProcedureRecord(record);
  const candidates = (Array.isArray(record.event_timeline) ? record.event_timeline : [])
    .map((event) => ({
      time_s: eventTime(event),
      note: cleanText(event?.note || event?.description || event?.label),
      source: String(event?.source || "event_timeline"),
    }))
    .filter((event) => (
      event.time_s != null
      && event.note
      && (
        PROCEDURE_TERMS.test(event.note)
        || (enemaRecord && ENEMA_MILESTONE_TERMS.test(event.note))
      )
    ))
    .sort((a, b) => a.time_s - b.time_s);

  const deduped = [];
  for (const candidate of candidates) {
    const nearDuplicate = deduped.some((saved) => (
      Math.abs(saved.time_s - candidate.time_s) <= 4
      && (saved.note.includes(candidate.note.slice(0, 40)) || candidate.note.includes(saved.note.slice(0, 40)))
    ));
    if (!nearDuplicate) deduped.push(candidate);
  }

  const highValue = deduped.filter((event) => (
    enemaRecord
      ? ENEMA_MILESTONE_TERMS.test(event.note)
      : MILESTONE_TERMS.test(event.note)
  ));
  const pool = highValue.length >= Math.min(3, limit) ? highValue : deduped;
  if (pool.length <= limit) return pool;

  if (enemaRecord) {
    const selected = [];
    for (const bucket of ENEMA_PHASE_BUCKETS) {
      const match = pool.find((event) => !selected.includes(event) && bucket.test(event.note));
      if (match && !selected.includes(match)) selected.push(match);
      if (selected.length >= limit) return selected;
    }
    for (const event of pool) {
      if (!selected.includes(event)) selected.push(event);
      if (selected.length >= limit) return selected;
    }
    return selected;
  }

  const selected = [];
  for (let index = 0; index < limit; index += 1) {
    const poolIndex = Math.round((index * (pool.length - 1)) / Math.max(1, limit - 1));
    const event = pool[poolIndex];
    if (event && !selected.includes(event)) selected.push(event);
  }
  return selected;
}

function rowsBetween(rows, start, end) {
  return rows.filter((row) => {
    const time = rowTime(row);
    return time != null && time >= start && time <= end;
  });
}

function summarizeWindow(rows = []) {
  const hrValues = rows
    .map((row) => numberOrNull(row.hr_smoothed ?? row.hr ?? row.heart_rate))
    .filter((value) => Number.isFinite(value) && value >= 30 && value <= 240);
  const usableHrvRows = rows.filter((row) => (
    USABLE_HRV_QUALITY.has(String(row.hrv_quality || "").toLowerCase())
    && numberOrNull(row.hrv_rmssd_ms) > 0
  ));
  const rmssd = usableHrvRows.map((row) => numberOrNull(row.hrv_rmssd_ms)).filter(Number.isFinite);
  const sdnn = usableHrvRows.map((row) => numberOrNull(row.hrv_sdnn_ms)).filter(Number.isFinite);
  return {
    samples: rows.length,
    hr_avg_bpm: round(hrValues.length ? hrValues.reduce((sum, value) => sum + value, 0) / hrValues.length : null),
    hr_min_bpm: round(hrValues.length ? Math.min(...hrValues) : null, 0),
    hr_max_bpm: round(hrValues.length ? Math.max(...hrValues) : null, 0),
    rmssd_median_ms: round(median(rmssd)),
    sdnn_median_ms: round(median(sdnn)),
    usable_hrv_samples: usableHrvRows.length,
    hrv_quality: [...new Set(usableHrvRows.map((row) => String(row.hrv_quality).toLowerCase()))].join("/") || "unavailable",
  };
}

function eventPhysiology(event, rows) {
  const pre = summarizeWindow(rowsBetween(rows, Math.max(0, event.time_s - 20), Math.max(0, event.time_s - 4)));
  const immediate = summarizeWindow(rowsBetween(rows, Math.max(0, event.time_s - 3), event.time_s + 10));
  const post = summarizeWindow(rowsBetween(rows, event.time_s + 10, event.time_s + 30));
  return {
    ...event,
    time_label: formatClock(event.time_s),
    pre,
    immediate,
    post,
    change: {
      immediate_hr_vs_pre_bpm: pre.hr_avg_bpm != null && immediate.hr_avg_bpm != null
        ? round(immediate.hr_avg_bpm - pre.hr_avg_bpm)
        : null,
      post_hr_vs_pre_bpm: pre.hr_avg_bpm != null && post.hr_avg_bpm != null
        ? round(post.hr_avg_bpm - pre.hr_avg_bpm)
        : null,
      immediate_rmssd_vs_pre_ms: pre.rmssd_median_ms != null && immediate.rmssd_median_ms != null
        ? round(immediate.rmssd_median_ms - pre.rmssd_median_ms)
        : null,
      post_rmssd_vs_pre_ms: pre.rmssd_median_ms != null && post.rmssd_median_ms != null
        ? round(post.rmssd_median_ms - pre.rmssd_median_ms)
        : null,
    },
  };
}

function formatWindow(label, window) {
  if (!window?.samples) return `${label}: unavailable`;
  const hrv = window.rmssd_median_ms != null
    ? `, RMSSD ${window.rmssd_median_ms} ms, SDNN ${window.sdnn_median_ms ?? "—"} ms (${window.hrv_quality}, ${window.usable_hrv_samples} usable HRV samples)`
    : ", RR/HRV unavailable or not usable";
  return `${label}: HR ${window.hr_avg_bpm ?? "—"} avg (${window.hr_min_bpm ?? "—"}-${window.hr_max_bpm ?? "—"})${hrv}`;
}

function procedureFocusLabel(record = {}) {
  return isEnemaProcedureRecord(record)
    ? "self-enema / rectal procedure"
    : "urethral / catheter-style procedure";
}

export function buildProcedurePhysiologyContext(records = [], timelineRowsBySession = {}, options = {}) {
  const recordLimit = Math.max(1, Math.min(8, Number(options.recordLimit) || 5));
  const milestoneLimit = Math.max(1, Math.min(8, Number(options.milestoneLimit) || 5));
  const selectedRecords = records
    .filter(isProcedurePhysiologyRecord)
    .sort((a, b) => new Date(b.date || b.created_date || 0) - new Date(a.date || a.created_date || 0))
    .slice(0, recordLimit);

  const digests = selectedRecords.map((record) => {
    const rows = Array.isArray(timelineRowsBySession[record.id]) ? timelineRowsBySession[record.id] : [];
    const milestones = selectProcedureMilestones(record, milestoneLimit)
      .map((event) => eventPhysiology(event, rows));
    return {
      id: record.id,
      date: String(record.date || record.created_date || "").slice(0, 10),
      title: cleanText(record.title || record.exploration_type || "Session", 120),
      timeline_rows: rows.length,
      milestones,
    };
  }).filter((record) => record.timeline_rows || record.milestones.length);

  if (!digests.length) {
    return {
      context: "PROCEDURE-ALIGNED PHYSIOLOGY: no timestamp-aligned catheter, sounding, or enema evidence was available.",
      recordCount: 0,
      milestoneCount: 0,
    };
  }

  const lines = [
    "PROCEDURE-ALIGNED PHYSIOLOGY - SAVED MEASURED EVIDENCE:",
    "Use this section when Ben asks about catheter insertion, urethral sounding/dilation, self-enema, rectal insertion, depth milestones, HR, RR-derived HRV, or autonomic response.",
    "Event notes identify the saved procedure milestone. HeartRateTimeline rows provide the measured physiology around it.",
    "Do not replace measured values with anatomical predictions. Do not call an RMSSD/SDNN change parasympathetic activation, vagal response, or causation by depth unless the timing, usable HRV quality, and repeated pattern support that cautious interpretation.",
    "A single association is descriptive, not proof. HRV marked unavailable must not be interpreted. State limitations plainly and compare repeated procedures when possible.",
    "For self-enema records, prioritize setup, contact, insertion, visible or manually logged instillation, retention or urge, cramping, leakage or return, withdrawal, expulsion, posture or bracing, and tolerance cues. Do not invent internal pressure, retained volume, flow rate, or symptom relief unless the note or measured timeline supports it.",
  ];

  for (const record of digests) {
    lines.push("", `[${record.date}] ${record.title} (${procedureFocusLabel(record)}; ${record.timeline_rows} saved physiology rows)`);
    for (const milestone of record.milestones) {
      lines.push(`- ${milestone.time_label} ${milestone.note}`);
      lines.push(`  ${formatWindow("Pre -20s to -4s", milestone.pre)}`);
      lines.push(`  ${formatWindow("Immediate -3s to +10s", milestone.immediate)}`);
      lines.push(`  ${formatWindow("Post +10s to +30s", milestone.post)}`);
      lines.push(`  Deltas vs pre: immediate HR ${milestone.change.immediate_hr_vs_pre_bpm ?? "—"} bpm, post HR ${milestone.change.post_hr_vs_pre_bpm ?? "—"} bpm, immediate RMSSD ${milestone.change.immediate_rmssd_vs_pre_ms ?? "—"} ms, post RMSSD ${milestone.change.post_rmssd_vs_pre_ms ?? "—"} ms`);
    }
  }

  return {
    context: lines.join("\n").slice(0, 18_000),
    recordCount: digests.length,
    milestoneCount: digests.reduce((sum, record) => sum + record.milestones.length, 0),
  };
}
