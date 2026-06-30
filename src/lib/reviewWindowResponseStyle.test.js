import { describe, expect, it } from "vitest";
import { REVIEW_WINDOW_RESPONSE_STYLE } from "./reviewWindowResponseStyle";

describe("Review Window response style", () => {
  it("requires natural answers without report scaffolding or duplicate timestamps", () => {
    expect(REVIEW_WINDOW_RESPONSE_STYLE).toContain("Start with the answer itself");
    expect(REVIEW_WINDOW_RESPONSE_STYLE).toContain("Address Ben as \"you\"");
    expect(REVIEW_WINDOW_RESPONSE_STYLE).toContain("Use each relevant timestamp once");
    expect(REVIEW_WINDOW_RESPONSE_STYLE).toContain("Do not add a title");
    expect(REVIEW_WINDOW_RESPONSE_STYLE).toContain("Bottom Line");
    expect(REVIEW_WINDOW_RESPONSE_STYLE).toContain("Preserve uncertainty");
  });
});

