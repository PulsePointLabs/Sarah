import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/base44Client", () => ({
  base44: {
    entities: {
      AICorrectionMemory: {
        create: vi.fn(() => Promise.resolve()),
        filter: vi.fn(() => Promise.resolve([])),
      },
    },
  },
}));

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) || null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
  clear: () => values.clear(),
};

const {
  buildAiCorrectionMemoryPrompt,
  mergeAiCorrectionMemory,
  readAiCorrectionMemory,
  rememberAiCorrection,
} = await import("./aiCorrectionMemory");

describe("AI correction memory", () => {
  beforeEach(() => values.clear());

  it("merges duplicate local and backend corrections once", () => {
    const correction = {
      id: "one",
      before: "Sleeve is visible",
      after: "Bare-hand contact is visible",
      recordType: "session",
      createdAt: "2026-07-23T10:00:00.000Z",
    };
    const merged = mergeAiCorrectionMemory([correction], [{ ...correction, id: "two" }]);
    expect(merged).toHaveLength(1);
    expect(readAiCorrectionMemory()).toHaveLength(1);
  });

  it("keeps exploration and session calibration separated in prompts", () => {
    rememberAiCorrection({
      before: "Catheter insertion",
      after: "Enema tubing handling",
      recordType: "body_exploration",
    });
    expect(buildAiCorrectionMemoryPrompt({ recordType: "session" })).toBe("");
    expect(buildAiCorrectionMemoryPrompt({ recordType: "body_exploration" })).toContain("Enema tubing handling");
  });
});
