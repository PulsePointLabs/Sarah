import test from "node:test";
import assert from "node:assert/strict";
import { hydrateSessionChatMessages, mergeDatedChatFindings } from "./chatFindings.js";

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

test("hydrates saved session chat from note sections when no durable thread exists", () => {
  const messages = hydrateSessionChatMessages([], "[AI Interview — 2026-07-11]\n• Your build was stronger late in the session");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
  assert.match(messages[0].text, /Saved Ask Sarah findings from 2026-07-11:/);
  assert.match(messages[0].text, /Your build was stronger late in the session/);
});

test("keeps durable thread and prepends non-duplicate saved note backfills", () => {
  const hydrated = hydrateSessionChatMessages(
    [{ role: "user", text: "What happened near the end?" }, { role: "assistant", text: "You had a longer plateau before recovery." }],
    "[AI Interview — 2026-07-10]\n• Your arousal plateau lasted longer than usual\n\n[Sarah Image Review — 2026-07-10]\n• Visible recovery settling followed the climax marker",
  );
  assert.equal(hydrated.length, 4);
  assert.match(hydrated[0].text, /Saved Ask Sarah findings from 2026-07-10:/);
  assert.match(hydrated[1].text, /Sarah Image Review saved 2026-07-10:/);
  assert.equal(hydrated[2].role, "user");
  assert.equal(hydrated[3].role, "assistant");
});
