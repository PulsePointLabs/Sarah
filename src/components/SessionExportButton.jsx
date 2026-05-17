import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import moment from "moment";
import { jsPDF } from "jspdf";
import { EVENT_CATEGORIES } from "./session-form/EventTimelineSection";

function getCategoryLabel(value) {
  const cat = EVENT_CATEGORIES.find((c) => c.value === value);
  return cat ? cat.label : value;
}

function fmtMmSs(s) {
  const totalS = Math.round(Number(s));
  const m = Math.floor(totalS / 60);
  const sec = totalS % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function buildCSV(session, timelineRows) {
  const s = session;
  const lines = [];

  // Session summary header
  lines.push("=== SESSION SUMMARY ===");
  lines.push(`Date,${moment(s.date).format("MMMM D YYYY")}`);
  lines.push(`Start Time,${s.start_time || ""}`);
  lines.push(`Duration (min),${s.duration_minutes || ""}`);
  lines.push(`Intensity,${s.intensity || ""}`);
  lines.push(`Build Quality,${s.build_quality || ""}`);
  lines.push(`Satisfaction,${s.satisfaction || ""}`);
  lines.push(`Build Type,${s.build_type || ""}`);
  lines.push(`Climax Duration,${s.climax_duration || ""}`);
  lines.push(`Mood,${s.mood || ""}`);
  lines.push(`Environment,${s.environment || ""}`);
  lines.push(`Methods,"${(s.methods || []).join("; ")}"`);
  lines.push(`Ejaculate Volume,${s.ejaculate_volume || ""}`);
  lines.push(`Hydration,${s.hydration || ""}`);
  lines.push(`Avg HR,${s.avg_hr || ""}`);
  lines.push(`Max HR,${s.max_hr || ""}`);
  lines.push(`HR at Climax,${s.hr_at_climax || ""}`);
  lines.push(`Pre-Climax Marker (s),${s.pre_climax_offset_s ?? ""}`);
  lines.push(`Climax Marker (s),${s.climax_offset_s ?? ""}`);
  lines.push(`Recovery Marker (s),${s.recovery_offset_s ?? ""}`);
  if (s.notes) lines.push(`Notes,"${s.notes.replace(/"/g, '""')}"`);
  lines.push("");

  // Event timeline
  if ((s.event_timeline || []).length > 0) {
    lines.push("=== EVENT TIMELINE ===");
    lines.push("Time,Category,Note");
    for (const ev of [...s.event_timeline].sort((a, b) => a.time_s - b.time_s)) {
      const time = fmtMmSs(ev.time_s);
      const cats = Array.isArray(ev.category) ? ev.category : [ev.category].filter(Boolean);
      const catLabel = cats.map(getCategoryLabel).join("+") || "Event";
      lines.push(`${time},"${catLabel}","${(ev.note || "").replace(/"/g, '""')}"`);
    }
    lines.push("");
  }

  // Discomfort log
  if ((s.discomfort_entries || []).length > 0) {
    lines.push("=== DISCOMFORT LOG ===");
    lines.push("Severity,Note");
    for (const d of s.discomfort_entries) {
      lines.push(`${d.severity},"${(d.note || "").replace(/"/g, '""')}"`);
    }
    lines.push("");
  }

  // AI analysis
  const ai = s.ai_analysis;
  if (ai) {
    lines.push("=== AI SESSION ANALYSIS ===");
    if (ai.summary) lines.push(`Summary,"${ai.summary.replace(/"/g, '""')}"`);
    lines.push("");
    for (const [section, label] of [
      ["arousal_arc", "Arousal Arc"],
      ["event_analysis", "Event Analysis"],
      ["phase_analysis", "Phase Analysis"],
      ["notable_findings", "Notable Findings"],
      ["recommendations", "Recommendations"],
    ]) {
      if (ai[section]?.length) {
        lines.push(label);
        for (const item of ai[section]) lines.push(`,"${item.replace(/"/g, '""')}"`);
        lines.push("");
      }
    }
  }

  // HR timeline (if available)
  if (timelineRows.length > 0) {
    lines.push("=== HR TIMELINE ===");
    lines.push("Time (s),HR (bpm)");
    for (const r of timelineRows) {
      lines.push(`${Math.round(Number(r.time_offset_s))},${Math.round(Number(r.hr))}`);
    }
  }

  return lines.join("\n");
}

function buildTextReport(session, timelineRows) {
  const s = session;
  const lines = [];
  const divider = "─".repeat(50);

  lines.push(`SESSION REPORT — ${moment(s.date).format("MMMM D, YYYY")}`);
  lines.push(divider);
  lines.push(`Start: ${s.start_time || "—"}  |  Duration: ${s.duration_minutes ? s.duration_minutes + " min" : "—"}`);
  lines.push(`Mood: ${s.mood || "—"}  |  Environment: ${s.environment || "—"}  |  Hydration: ${s.hydration || "—"}`);
  lines.push(`Methods: ${(s.methods || []).join(", ") || "—"}`);
  lines.push("");
  lines.push("SUBJECTIVE RATINGS");
  lines.push(`  Intensity:     ${s.intensity || "—"}/10`);
  lines.push(`  Build Quality: ${s.build_quality || "—"}/10`);
  lines.push(`  Satisfaction:  ${s.satisfaction || "—"}/10`);
  lines.push(`  Build Type:    ${s.build_type || "—"}`);
  lines.push(`  Climax:        ${s.climax_duration || "—"}`);
  if (s.ejaculate_volume) lines.push(`  Ejaculate:     ${s.ejaculate_volume}`);
  lines.push("");

  if (s.avg_hr || s.max_hr || s.hr_at_climax) {
    lines.push("HEART RATE");
    if (s.avg_hr) lines.push(`  Avg: ${s.avg_hr} bpm`);
    if (s.max_hr) lines.push(`  Max: ${s.max_hr} bpm`);
    if (s.hr_at_climax) lines.push(`  At Climax: ${s.hr_at_climax} bpm`);
    if (s.pre_climax_offset_s != null) lines.push(`  Pre-Climax marker: ${fmtMmSs(s.pre_climax_offset_s)}`);
    if (s.climax_offset_s != null) lines.push(`  Climax marker: ${fmtMmSs(s.climax_offset_s)}`);
    if (s.recovery_offset_s != null) lines.push(`  Recovery marker: ${fmtMmSs(s.recovery_offset_s)}`);
    lines.push("");
  }

  if ((s.event_timeline || []).length > 0) {
    lines.push("EVENT TIMELINE");
    for (const ev of [...s.event_timeline].sort((a, b) => a.time_s - b.time_s)) {
      const cats = Array.isArray(ev.category) ? ev.category : [ev.category].filter(Boolean);
      const catLabel = cats.map(getCategoryLabel).join("+") || "Event";
      lines.push(`  ${fmtMmSs(ev.time_s)}  [${catLabel}]  ${ev.note || ""}`);
    }
    lines.push("");
  }

  if ((s.discomfort_entries || []).length > 0) {
    lines.push("DISCOMFORT LOG");
    for (const d of s.discomfort_entries) {
      lines.push(`  Severity ${d.severity}/10: ${d.note}`);
    }
    lines.push("");
  }

  if (s.unusual_sensations) { lines.push(`UNUSUAL SENSATIONS: ${s.unusual_sensations}`); lines.push(""); }
  if (s.refractory_notes) { lines.push(`REFRACTORY NOTES: ${s.refractory_notes}`); lines.push(""); }
  if (s.notes) { lines.push("NOTES"); lines.push(s.notes); lines.push(""); }

  const ai = s.ai_analysis;
  if (ai) {
    lines.push(divider);
    lines.push("AI SESSION ANALYSIS");
    lines.push(divider);
    if (ai.summary) { lines.push(ai.summary); lines.push(""); }
    for (const [section, label] of [
      ["arousal_arc", "AROUSAL ARC"],
      ["event_analysis", "EVENT ANALYSIS"],
      ["phase_analysis", "PHASE ANALYSIS"],
      ["notable_findings", "NOTABLE FINDINGS"],
      ["recommendations", "RECOMMENDATIONS"],
    ]) {
      if (ai[section]?.length) {
        lines.push(label);
        for (const item of ai[section]) lines.push(`  • ${item}`);
        lines.push("");
      }
    }
  }

  lines.push(divider);
  lines.push(`Exported ${moment().format("MMMM D, YYYY [at] h:mm A")}`);

  return lines.join("\n");
}

// ── PDF helpers ────────────────────────────────────────────────────────────

function drawHRChart(doc, rows, x, y, w, h, session) {
  if (!rows.length) return;
  const times = rows.map((r) => Number(r.time_offset_s));
  const hrs = rows.map((r) => Number(r.hr));
  const minT = Math.min(...times), maxT = Math.max(...times);
  const minHR = Math.min(...hrs) - 5, maxHR = Math.max(...hrs) + 5;
  const scaleX = (t) => x + ((t - minT) / (maxT - minT)) * w;
  const scaleY = (hr) => y + h - ((hr - minHR) / (maxHR - minHR)) * h;

  // Background
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(x - 2, y - 2, w + 4, h + 4, 2, 2, "F");

  // Grid lines
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.2);
  for (let i = 0; i <= 4; i++) {
    const gy = y + (i / 4) * h;
    doc.line(x, gy, x + w, gy);
    const hrLabel = Math.round(maxHR - (i / 4) * (maxHR - minHR));
    doc.setFontSize(6);
    doc.setTextColor(150, 150, 150);
    doc.text(String(hrLabel), x - 1, gy + 1, { align: "right" });
  }

  // Phase marker lines
  const phases = [
    { key: "pre_climax_offset_s", color: [168, 85, 247] },
    { key: "climax_offset_s", color: [239, 68, 68] },
    { key: "recovery_offset_s", color: [59, 130, 246] },
  ];
  phases.forEach(({ key, color }) => {
    if (session[key] != null) {
      const px = scaleX(session[key]);
      doc.setDrawColor(...color);
      doc.setLineWidth(0.6);
      doc.setLineDashPattern([1, 1], 0);
      doc.line(px, y, px, y + h);
      doc.setLineDashPattern([], 0);
    }
  });

  // HR line
  doc.setDrawColor(45, 185, 165);
  doc.setLineWidth(0.8);
  // Sample down to ~300 points for performance
  const step = Math.max(1, Math.floor(rows.length / 300));
  const sampled = rows.filter((_, i) => i % step === 0);
  for (let i = 1; i < sampled.length; i++) {
    const x1 = scaleX(Number(sampled[i - 1].time_offset_s));
    const y1 = scaleY(Number(sampled[i - 1].hr));
    const x2 = scaleX(Number(sampled[i].time_offset_s));
    const y2 = scaleY(Number(sampled[i].hr));
    doc.line(x1, y1, x2, y2);
  }

  // X-axis time labels
  doc.setFontSize(6);
  doc.setTextColor(150, 150, 150);
  const tickCount = 6;
  for (let i = 0; i <= tickCount; i++) {
    const t = minT + (i / tickCount) * (maxT - minT);
    const lx = scaleX(t);
    const m = Math.floor(t / 60);
    const s = Math.round(t % 60);
    doc.text(`${m}:${String(s).padStart(2, "0")}`, lx, y + h + 4, { align: "center" });
  }
}

function buildPDF(session, timelineRows) {
  const s = session;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const PAGE_W = 210, PAGE_H = 297, MARGIN = 14;
  const CONTENT_W = PAGE_W - MARGIN * 2;
  let curY = MARGIN;

  const checkPage = (needed = 10) => {
    if (curY + needed > PAGE_H - MARGIN) {
      doc.addPage();
      curY = MARGIN;
    }
  };

  const sectionHeader = (title) => {
    checkPage(10);
    doc.setFillColor(45, 185, 165);
    doc.roundedRect(MARGIN, curY, CONTENT_W, 6, 1, 1, "F");
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.text(title.toUpperCase(), MARGIN + 3, curY + 4.2);
    curY += 9;
    doc.setFont("helvetica", "normal");
  };

  const row = (label, value, indent = MARGIN) => {
    if (value == null || value === "" || value === "—") return;
    checkPage(6);
    doc.setFontSize(8);
    doc.setTextColor(100, 100, 100);
    doc.text(label, indent, curY);
    doc.setTextColor(30, 30, 30);
    doc.setFont("helvetica", "bold");
    const maxW = CONTENT_W - (indent - MARGIN) - 40;
    const lines = doc.splitTextToSize(String(value), maxW);
    doc.text(lines, indent + 40, curY);
    doc.setFont("helvetica", "normal");
    curY += lines.length * 4.5 + 0.5;
  };

  const metricBox = (items, startX, startY, boxW, boxH) => {
    items.forEach(({ label, value, color }, i) => {
      const bx = startX + i * (boxW + 3);
      doc.setFillColor(248, 250, 252);
      doc.roundedRect(bx, startY, boxW, boxH, 2, 2, "F");
      doc.setFontSize(6.5);
      doc.setTextColor(120, 120, 120);
      doc.text(label.toUpperCase(), bx + boxW / 2, startY + 4.5, { align: "center" });
      doc.setFontSize(13);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...(color || [45, 185, 165]));
      doc.text(String(value ?? "—"), bx + boxW / 2, startY + 12, { align: "center" });
      doc.setFont("helvetica", "normal");
    });
  };

  // ── Title ────────────────────────────────────────────────────────────────
  doc.setFillColor(20, 30, 48);
  doc.rect(0, 0, PAGE_W, 22, "F");
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(255, 255, 255);
  doc.text("Session Report", MARGIN, 10);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(180, 220, 215);
  doc.text(moment(s.date).format("MMMM D, YYYY"), MARGIN, 16);
  doc.setTextColor(130, 170, 165);
  doc.text(`Generated ${moment().format("MMM D, YYYY [at] h:mm A")}`, PAGE_W - MARGIN, 16, { align: "right" });
  curY = 28;

  // ── Quick stat boxes ─────────────────────────────────────────────────────
  const boxH = 16, boxW = (CONTENT_W - 9) / 4;
  metricBox([
    { label: "Intensity", value: s.intensity ? `${s.intensity}/10` : "—" },
    { label: "Satisfaction", value: s.satisfaction ? `${s.satisfaction}/10` : "—", color: [139, 92, 246] },
    { label: "Avg HR", value: s.avg_hr ? `${s.avg_hr} bpm` : "—", color: [59, 130, 246] },
    { label: "Max HR", value: s.max_hr ? `${s.max_hr} bpm` : "—", color: [239, 68, 68] },
  ], MARGIN, curY, boxW, boxH);
  curY += boxH + 6;

  // ── Session info ─────────────────────────────────────────────────────────
  sectionHeader("Session Info");
  row("Date", moment(s.date).format("MMMM D, YYYY"));
  if (s.start_time) row("Start Time", `${s.start_time}${s.end_time ? ` – ${s.end_time}` : ""}`);
  if (s.duration_minutes) row("Duration", `${s.duration_minutes} min`);
  row("Methods", (s.methods || []).join(", ") || null);
  row("Build Type", s.build_type === "Other" && s.custom_build_type ? s.custom_build_type : s.build_type);
  row("Climax Duration", s.climax_duration);
  row("Mood", s.mood);
  row("Environment", s.environment);
  if (s.no_climax) row("Note", "Session without climax");

  // ── Climax metrics ───────────────────────────────────────────────────────
  const hasClimaxMetrics = s.hr_at_climax || s.hr_avg_at_climax_window || s.hr_avg_pre_to_climax || s.climax_offset_s != null;
  if (hasClimaxMetrics) {
    sectionHeader("Climax Metrics");
    row("HR at Climax", s.hr_at_climax ? `${s.hr_at_climax} bpm` : null);
    row("Avg HR ±30s Window", s.hr_avg_at_climax_window ? `${s.hr_avg_at_climax_window} bpm` : null);
    row("Avg HR Pre→Climax", s.hr_avg_pre_to_climax ? `${s.hr_avg_pre_to_climax} bpm` : null);
    if (s.pre_climax_offset_s != null) row("Pre-Climax Marker", fmtMmSs(s.pre_climax_offset_s));
    if (s.climax_offset_s != null) row("Climax Marker", fmtMmSs(s.climax_offset_s));
    if (s.recovery_offset_s != null) row("Recovery Marker", fmtMmSs(s.recovery_offset_s));
    if (s.climax_offset_s != null && s.recovery_offset_s != null) {
      const gapS = s.recovery_offset_s - s.climax_offset_s;
      row("Climax → Recovery", gapS > 0 ? `${Math.floor(gapS / 60)}m ${gapS % 60}s` : null);
    }
  }

  // ── HR Timeline Chart ─────────────────────────────────────────────────────
  if (timelineRows.length > 1) {
    checkPage(55);
    sectionHeader("Heart Rate Timeline");
    const chartH = 42;
    drawHRChart(doc, timelineRows, MARGIN + 6, curY, CONTENT_W - 8, chartH, s);
    curY += chartH + 10;
    // Legend
    doc.setFontSize(6.5);
    const legendItems = [
      { color: [45, 185, 165], label: "HR" },
      { color: [168, 85, 247], label: "Pre-Climax" },
      { color: [239, 68, 68], label: "Climax" },
      { color: [59, 130, 246], label: "Recovery" },
    ];
    let lx = MARGIN + 6;
    legendItems.forEach(({ color, label }) => {
      doc.setDrawColor(...color);
      doc.setLineWidth(0.8);
      doc.line(lx, curY - 2, lx + 5, curY - 2);
      doc.setTextColor(100, 100, 100);
      doc.text(label, lx + 6, curY - 0.5);
      lx += 5 + doc.getTextWidth(label) + 7;
    });
    curY += 4;
  }

  // ── Event Log Table ───────────────────────────────────────────────────────
  const events = [...(s.event_timeline || [])].sort((a, b) => a.time_s - b.time_s);
  if (events.length > 0) {
    checkPage(14);
    sectionHeader(`Event Log (${events.length} events)`);

    // Table header
    const COL = { time: MARGIN, cat: MARGIN + 18, note: MARGIN + 52 };
    const noteMaxW = CONTENT_W - (COL.note - MARGIN);
    doc.setFillColor(230, 245, 243);
    doc.rect(MARGIN, curY, CONTENT_W, 5.5, "F");
    doc.setFontSize(7);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(45, 185, 165);
    doc.text("TIME", COL.time, curY + 3.8);
    doc.text("CATEGORY", COL.cat, curY + 3.8);
    doc.text("NOTE", COL.note, curY + 3.8);
    doc.setFont("helvetica", "normal");
    curY += 6.5;

    events.forEach((ev, idx) => {
      const cats = Array.isArray(ev.category) ? ev.category : [ev.category].filter(Boolean);
      const catLabel = cats.map(getCategoryLabel).join(" + ") || "Event";
      const noteLines = doc.splitTextToSize(ev.note || "", noteMaxW);
      const rowH = Math.max(5.5, noteLines.length * 4 + 2);

      checkPage(rowH + 1);

      // Alternating row background
      if (idx % 2 === 0) {
        doc.setFillColor(250, 252, 252);
        doc.rect(MARGIN, curY, CONTENT_W, rowH, "F");
      }

      doc.setFontSize(7.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(45, 185, 165);
      doc.text(fmtMmSs(ev.time_s), COL.time, curY + 4);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100, 80, 140);
      doc.text(catLabel, COL.cat, curY + 4);
      doc.setTextColor(30, 30, 30);
      doc.text(noteLines, COL.note, curY + 4);

      // Row separator
      doc.setDrawColor(230, 235, 235);
      doc.setLineWidth(0.2);
      doc.line(MARGIN, curY + rowH, MARGIN + CONTENT_W, curY + rowH);

      curY += rowH + 0.5;
    });
    curY += 4;
  }

  // ── Discomfort Log ───────────────────────────────────────────────────────
  if ((s.discomfort_entries || []).length > 0) {
    checkPage(14);
    sectionHeader(`Discomfort Log (${s.discomfort_entries.length} entries)`);
    s.discomfort_entries.forEach((d, idx) => {
      const noteLines = doc.splitTextToSize(d.note || "", CONTENT_W - 28);
      const rowH = Math.max(5.5, noteLines.length * 4 + 2);
      checkPage(rowH + 1);
      if (idx % 2 === 0) { doc.setFillColor(255, 248, 248); doc.rect(MARGIN, curY, CONTENT_W, rowH, "F"); }
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(220, 60, 60);
      doc.text(`Sev ${d.severity}/10`, MARGIN, curY + 4);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(50, 50, 50);
      doc.text(noteLines, MARGIN + 24, curY + 4);
      doc.setDrawColor(240, 220, 220);
      doc.setLineWidth(0.2);
      doc.line(MARGIN, curY + rowH, MARGIN + CONTENT_W, curY + rowH);
      curY += rowH + 0.5;
    });
    curY += 3;
  }

  // ── Unusual sensations / refractory notes ────────────────────────────────
  if (s.unusual_sensations || s.refractory_notes) {
    checkPage(12);
    sectionHeader("Additional Observations");
    if (s.unusual_sensations) {
      doc.setFontSize(7); doc.setTextColor(120, 120, 120); doc.setFont("helvetica", "bold");
      doc.text("UNUSUAL SENSATIONS", MARGIN, curY); curY += 4;
      doc.setFont("helvetica", "normal"); doc.setTextColor(50, 50, 50); doc.setFontSize(8);
      const lines = doc.splitTextToSize(s.unusual_sensations, CONTENT_W - 4);
      doc.text(lines, MARGIN, curY); curY += lines.length * 4.5 + 3;
    }
    if (s.refractory_notes) {
      doc.setFontSize(7); doc.setTextColor(120, 120, 120); doc.setFont("helvetica", "bold");
      doc.text("REFRACTORY NOTES", MARGIN, curY); curY += 4;
      doc.setFont("helvetica", "normal"); doc.setTextColor(50, 50, 50); doc.setFontSize(8);
      const lines = doc.splitTextToSize(s.refractory_notes, CONTENT_W - 4);
      doc.text(lines, MARGIN, curY); curY += lines.length * 4.5 + 3;
    }
  }

  // ── Notes ────────────────────────────────────────────────────────────────
  if (s.notes) {
    checkPage(14);
    sectionHeader("Session Notes");
    const noteLines = doc.splitTextToSize(s.notes, CONTENT_W - 4);
    doc.setFontSize(8);
    doc.setTextColor(50, 50, 50);
    doc.text(noteLines, MARGIN, curY);
    curY += noteLines.length * 4.5 + 4;
  }

  // ── Tags ─────────────────────────────────────────────────────────────────
  if ((s.tags || []).length > 0) {
    checkPage(10);
    sectionHeader("Tags");
    doc.setFontSize(8);
    doc.setTextColor(80, 60, 140);
    doc.text(s.tags.map(t => `#${t}`).join("   "), MARGIN, curY);
    curY += 6;
  }

  // ── AI Session Analysis ───────────────────────────────────────────────────
  const ai = s.ai_analysis;
  if (ai) {
    checkPage(14);
    sectionHeader("AI Session Analysis");

    const writeAIBlock = (label, items) => {
      if (!items?.length) return;
      checkPage(10);
      doc.setFontSize(7); doc.setFont("helvetica", "bold"); doc.setTextColor(45, 185, 165);
      doc.text(label.toUpperCase(), MARGIN, curY); curY += 4.5;
      doc.setFont("helvetica", "normal");
      for (const item of items) {
        const lines = doc.splitTextToSize(`• ${item}`, CONTENT_W - 6);
        checkPage(lines.length * 4.5 + 1);
        doc.setFontSize(7.5); doc.setTextColor(40, 40, 40);
        doc.text(lines, MARGIN + 2, curY);
        curY += lines.length * 4.5 + 1;
      }
      curY += 2;
    };

    if (ai.summary) {
      const sumLines = doc.splitTextToSize(ai.summary, CONTENT_W - 4);
      checkPage(sumLines.length * 4.5 + 4);
      doc.setFontSize(8.5); doc.setFont("helvetica", "bold"); doc.setTextColor(30, 30, 30);
      doc.text(sumLines, MARGIN, curY);
      curY += sumLines.length * 4.5 + 5;
      doc.setFont("helvetica", "normal");
    }

    writeAIBlock("Arousal Arc", ai.arousal_arc || ai.phase_analysis);
    writeAIBlock("Event Analysis", ai.event_analysis || ai.hr_analysis);
    writeAIBlock("Notable Findings", ai.notable_findings);
    writeAIBlock("Recommendations", ai.recommendations);
  }

  // ── AI Cascade Overview ───────────────────────────────────────────────────
  const cascade = s.ai_cascade;
  if (cascade) {
    checkPage(14);
    sectionHeader("AI Cascade Overview");

    const cascadeBlocks = [
      { key: "build_phase", label: "Build Phase" },
      { key: "pre_climax_phase", label: "Pre-Climax Phase" },
      { key: "climax_phase", label: "Climax Phase" },
      { key: "recovery_phase", label: "Recovery Phase" },
    ];

    if (cascade.summary) {
      const sumLines = doc.splitTextToSize(cascade.summary, CONTENT_W - 4);
      checkPage(sumLines.length * 4.5 + 4);
      doc.setFontSize(8.5); doc.setFont("helvetica", "bold"); doc.setTextColor(30, 30, 30);
      doc.text(sumLines, MARGIN, curY);
      curY += sumLines.length * 4.5 + 5;
      doc.setFont("helvetica", "normal");
    }

    for (const { key, label } of cascadeBlocks) {
      const items = cascade[key];
      if (!items?.length) continue;
      checkPage(10);
      doc.setFontSize(7); doc.setFont("helvetica", "bold"); doc.setTextColor(139, 92, 246);
      doc.text(label.toUpperCase(), MARGIN, curY); curY += 4.5;
      doc.setFont("helvetica", "normal");
      for (const item of items) {
        const lines = doc.splitTextToSize(`• ${item}`, CONTENT_W - 6);
        checkPage(lines.length * 4.5 + 1);
        doc.setFontSize(7.5); doc.setTextColor(40, 40, 40);
        doc.text(lines, MARGIN + 2, curY);
        curY += lines.length * 4.5 + 1;
      }
      curY += 2;
    }

    if (cascade.cascade_quality) {
      checkPage(12);
      doc.setFontSize(7); doc.setFont("helvetica", "bold"); doc.setTextColor(45, 185, 165);
      doc.text("CASCADE QUALITY", MARGIN, curY); curY += 4.5;
      doc.setFont("helvetica", "normal");
      const lines = doc.splitTextToSize(cascade.cascade_quality, CONTENT_W - 4);
      doc.setFontSize(7.5); doc.setTextColor(40, 40, 40);
      doc.text(lines, MARGIN, curY);
      curY += lines.length * 4.5 + 4;
    }
  }

  // ── Footer on every page ─────────────────────────────────────────────────
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(6.5);
    doc.setTextColor(170, 170, 170);
    doc.text(`Page ${i} of ${pageCount}`, PAGE_W - MARGIN, PAGE_H - 6, { align: "right" });
    doc.text("Session Report — Confidential", MARGIN, PAGE_H - 6);
  }

  return doc;
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function SessionExportButton({ session, timelineRows = [] }) {
  const [open, setOpen] = useState(false);
  const [generatingPDF, setGeneratingPDF] = useState(false);
  const dateSlug = moment(session.date).format("YYYY-MM-DD");
  const hasAI = !!(session.ai_analysis || session.ai_cascade);

  const handleCSV = () => {
    downloadFile(buildCSV(session, timelineRows), `session-${dateSlug}.csv`, "text/csv");
    setOpen(false);
  };

  const handleText = () => {
    downloadFile(buildTextReport(session, timelineRows), `session-${dateSlug}.txt`, "text/plain");
    setOpen(false);
  };

  const handlePDF = () => {
    setGeneratingPDF(true);
    setOpen(false);
    // Defer so UI can update before the synchronous PDF build
    setTimeout(() => {
      const doc = buildPDF(session, timelineRows);
      doc.save(`session-${dateSlug}.pdf`);
      setGeneratingPDF(false);
    }, 50);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" title="Export / Generate Report" disabled={generatingPDF}>
          {generatingPDF
            ? <span className="w-4 h-4 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
            : <Download className="w-5 h-5 text-muted-foreground" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={handlePDF}>
          <span className="flex flex-col">
            <span>Generate PDF Report</span>
            {hasAI && <span className="text-[10px] text-primary">Includes AI analysis + cascade</span>}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleCSV}>Export as CSV</DropdownMenuItem>
        <DropdownMenuItem onClick={handleText}>Export as Text Report</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}