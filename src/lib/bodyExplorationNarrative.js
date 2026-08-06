const SEGMENT_HEADING_TERMS = /\b(?:phase|setup|baseline|assessment|insertion|fill|advancement|removal|retrieval|retention|defecation|release|recovery|outcome|interpretation|experience|placement|comparison|follow-up|follow up|course|synthesis|findings)\b/i;
const ELAPSED_HEADING_CONTEXT = /\b(?:seconds?|minutes?|elapsed)\b/i;

function cleanHeading(value = "") {
  return String(value)
    .replace(/^#{1,6}\s*/, "")
    .replace(/\s*\([^)]*(?:seconds?|minutes?|elapsed)[^)]*\)\s*$/i, "")
    .replace(/[.:\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitBodyExplorationSegmentHeading(value = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return { heading: "", body: "" };

  const markdown = text.match(/^#{1,6}\s+([^\n:]{3,140})[:.]?\s+(.+)$/);
  if (markdown) return { heading: cleanHeading(markdown[1]), body: markdown[2].trim() };

  const labeled = text.match(/^([^:]{3,190}):\s+(.+)$/);
  if (!labeled) return { heading: "", body: text };

  const rawHeading = labeled[1].trim();
  if (!SEGMENT_HEADING_TERMS.test(rawHeading) && !ELAPSED_HEADING_CONTEXT.test(rawHeading)) {
    return { heading: "", body: text };
  }

  return {
    heading: cleanHeading(rawHeading),
    body: labeled[2].trim(),
  };
}

function spokenHeading(label = "") {
  const cleaned = cleanHeading(label);
  return cleaned ? `${cleaned}.` : "";
}

export function buildBodyExplorationReaderContent(result, sectionDefs = []) {
  if (!result) return { paragraphs: [], paragraphMeta: [] };

  const paragraphs = [];
  const paragraphMeta = [];
  const push = (text, meta) => {
    const cleaned = String(text || "").trim();
    if (!cleaned) return;
    paragraphs.push(cleaned);
    paragraphMeta.push(meta);
  };

  push(result.summary, { type: "summary" });

  sectionDefs.forEach((section) => {
    const rows = Array.isArray(result[section.key]) ? result[section.key].filter(Boolean) : [];
    if (!rows.length) return;

    push(spokenHeading(section.label || section.title), { type: "heading", section });

    rows.forEach((row, rowIndex) => {
      const { heading, body } = splitBodyExplorationSegmentHeading(row);
      if (!heading) {
        push(body, { type: "section", section });
        return;
      }

      const subsection = {
        ...section,
        key: `${section.key}-segment-${rowIndex}`,
        label: heading,
      };
      push(spokenHeading(heading), { type: "subheading", section: subsection });
      push(body, { type: "section", section: subsection });
    });
  });

  return { paragraphs, paragraphMeta };
}
