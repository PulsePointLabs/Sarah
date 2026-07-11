import test from "node:test";
import assert from "node:assert/strict";
import { mergeDatedChatFindings, sanitizeSessionChatMessages } from "./chatFindings.js";

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

test("keeps only real saved chat messages", () => {
  const messages = sanitizeSessionChatMessages([
    { role: "user", text: "What happened near the end?" },
    { role: "assistant", text: "You had a longer plateau before recovery." },
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[1].role, "assistant");
});

test("drops imported findings that were masquerading as chat messages", () => {
  const hydrated = sanitizeSessionChatMessages(
    [{ role: "user", text: "What happened near the end?" }, { role: "assistant", text: "You had a longer plateau before recovery." }],
  );
  assert.equal(hydrated.length, 2);
});

test("removes imported note backfills from a mixed message array", () => {
  const hydrated = sanitizeSessionChatMessages([
    { role: "assistant", text: "Saved Ask Sarah findings from 2026-07-10:\n• Plateau", importedFromNotes: true },
    { role: "user", text: "What happened near the end?" },
    { role: "assistant", text: "You had a longer plateau before recovery." },
    { role: "assistant", text: "Sarah Image Review saved 2026-07-10:\n• Visible recovery settling", importedFromNotes: true },
  ]);
  assert.equal(hydrated.length, 2);
  assert.equal(hydrated[0].role, "user");
  assert.equal(hydrated[1].role, "assistant");
});

test("returns an empty list for non-array session chat input", () => {
  const hydrated = sanitizeSessionChatMessages(null);
  assert.deepEqual(hydrated, []);
});
