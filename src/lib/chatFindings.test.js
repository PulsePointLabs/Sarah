import test from "node:test";
import assert from "node:assert/strict";
import { mergeDatedChatFindings } from "./chatFindings.js";

test("adds the first dated session-chat findings block", () => {
  assert.equal(
    mergeDatedChatFindings("Existing note", "2026-06-28", "• Your new finding"),
    "Existing note\n\n[AI Interview — 2026-06-28]\n• Your new finding",
  );
});

test("replaces the same-day findings summary instead of duplicating it", () => {
  const existing = "Existing note\n\n[AI Interview — 2026-06-28]\n• Old finding";
  assert.equal(
    mergeDatedChatFindings(existing, "2026-06-28", "• Updated finding"),
    "Existing note\n\n[AI Interview — 2026-06-28]\n• Updated finding",
  );
});

test("preserves later structured note sections", () => {
  const existing = "Intro\n\n[AI Interview — 2026-06-28]\n• Old\n\n[Sarah Image Review — 2026-06-28]\n• Image finding";
  assert.equal(
    mergeDatedChatFindings(existing, "2026-06-28", "• Updated"),
    "Intro\n\n[AI Interview — 2026-06-28]\n• Updated\n\n[Sarah Image Review — 2026-06-28]\n• Image finding",
  );
});
