import test from "node:test";
import assert from "node:assert/strict";
import { buildSavedCloudReviewCards } from "./cloudReviewCards.js";

test("saved cloud evidence becomes normal readable review cards without an AI call", () => {
  const cards = buildSavedCloudReviewCards({
    pass: {
      id: "cloud-1",
      source_video: { role: "main", source_zero_session_ms: 0 },
      result: {
        ok: true,
        multimodal_windows: [{
          id: "window-1",
          start_ms: 12000,
          end_ms: 24000,
          representative_time_ms: 18000,
          confidence: 0.62,
          visual_evidence: {
            body_position: ["The subject is lying on their back."],
            actions: ["The subject is adjusting their grip."],
            change_across_frames: ["Heart rate increases slightly."],
          },
          physiology: { heart_rate_bpm: { min: 93, max: 101, avg: 97, samples: 24 } },
          audio_candidates: [{ label: "Breathing", confidence: 0.8, confidence_band: "strong", start_ms: 15000, end_ms: 16000 }],
        }],
        strong_candidates: [],
      },
    },
    selectedVideo: { filename: "wide.mkv" },
    streamUrl: "http://localhost/video",
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0].label, "Cloud video review 0:12-0:24");
  assert.match(cards[0].summary, /You are lying on your back/);
  assert.match(cards[0].summary, /You are adjusting your grip/);
  assert.match(cards[0].findings.find((item) => item.title === "Aligned physiology").text, /93 to 101 bpm/);
  assert.match(cards[0].clipUrl, /#t=12\.00,24\.00$/);
  assert.equal(cards[0].events[0].time_s, 18);
  assert.doesNotMatch(cards[0].summary, /unconfirmed|candidate|subject/i);
});

