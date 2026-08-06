import { describe, expect, it } from "vitest";
import {
  buildBodyExplorationReaderContent,
  splitBodyExplorationSegmentHeading,
} from "./bodyExplorationNarrative";

describe("body exploration narration structure", () => {
  it("turns legacy elapsed-time labels into clean segment headings", () => {
    expect(splitBodyExplorationSegmentHeading(
      "Initial nozzle insertion and first fill phase (12 minutes and 14 seconds to 13 minutes and 51 seconds): You repositioned and began the fill."
    )).toEqual({
      heading: "Initial nozzle insertion and first fill phase",
      body: "You repositioned and began the fill.",
    });
  });

  it("does not turn ordinary physiological prose into a heading", () => {
    const text = "The measured response matters here: heart rate stayed elevated while recovery remained incomplete.";
    expect(splitBodyExplorationSegmentHeading(text)).toEqual({ heading: "", body: text });
  });

  it("adds real spoken section and segment headings without duplicating them in prose", () => {
    const section = { key: "integrated_physiology", label: "Integrated Physiology" };
    const content = buildBodyExplorationReaderContent({
      summary: "This record shows a sustained physiological response.",
      integrated_physiology: [
        "Peak response phase (20 minutes through 22 minutes elapsed): Leg trembling and contraction waves coincided with the strongest reported urgency.",
      ],
    }, [section]);

    expect(content.paragraphs).toEqual([
      "This record shows a sustained physiological response.",
      "Integrated Physiology.",
      "Peak response phase.",
      "Leg trembling and contraction waves coincided with the strongest reported urgency.",
    ]);
    expect(content.paragraphMeta.map((entry) => entry.type)).toEqual([
      "summary",
      "heading",
      "subheading",
      "section",
    ]);
  });
});

