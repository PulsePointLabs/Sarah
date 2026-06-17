import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSarahPersonalityPrompt,
  buildSarahTTSVoicePrompt,
  normalizeSarahPersonalitySettings,
} from "../../src/utils/sarahPersonality.js";

test("normalizes Sarah personality settings safely", () => {
  const settings = normalizeSarahPersonalitySettings({
    enabled: true,
    tonePreset: "soft_feminine",
    detailLevel: "plain",
    feminineWarmth: false,
    sexualSpecificity: true,
    arousalTimelineStory: true,
    ttsFriendly: true,
    customInstructions: "  read the arousal timeline with more feminine warmth   ",
  });

  assert.equal(settings.tonePreset, "soft_feminine");
  assert.equal(settings.detailLevel, "plain");
  assert.equal(settings.feminineWarmth, false);
  assert.equal(settings.customInstructions, "read the arousal timeline with more feminine warmth");
});

test("builds Sarah personality prompt with evidence guardrails", () => {
  const prompt = buildSarahPersonalityPrompt({
    enabled: true,
    tonePreset: "soft_feminine",
    detailLevel: "clinical",
    feminineWarmth: true,
    sexualSpecificity: true,
    arousalTimelineStory: true,
    ttsFriendly: true,
    customInstructions: "Use more plain English and a softer feminine read.",
  });

  assert.match(prompt, /SARAH PERSONALITY/);
  assert.match(prompt, /feminine, warm, intimate, attentive/);
  assert.match(prompt, /Read the arousal timeline as a body-state story/);
  assert.match(prompt, /Sexual specificity is for accurate analysis, not arousal writing/);
  assert.match(prompt, /cannot override evidence discipline/);
});

test("disabled Sarah personality settings return no prompt block", () => {
  assert.equal(buildSarahPersonalityPrompt({ enabled: false }), "");
});

test("builds Sarah TTS delivery prompt from personality settings", () => {
  const prompt = buildSarahTTSVoicePrompt({
    enabled: true,
    tonePreset: "soft_feminine",
    detailLevel: "clinical",
    feminineWarmth: true,
    sexualSpecificity: true,
    arousalTimelineStory: true,
    ttsFriendly: true,
    customInstructions: "Use more feminine warmth but keep anatomy clinical.",
  });

  assert.match(prompt, /VOICE DELIVERY/);
  assert.match(prompt, /Inflection: softer, more feminine/);
  assert.match(prompt, /Read anatomical sexual terms clinically and naturally/);
  assert.match(prompt, /story-like rise and settle/);
  assert.match(prompt, /Use more feminine warmth but keep anatomy clinical/);
});

test("disabled Sarah TTS delivery prompt returns empty string", () => {
  assert.equal(buildSarahTTSVoicePrompt({ enabled: false }), "");
});
