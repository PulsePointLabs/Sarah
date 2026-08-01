import assert from "node:assert/strict";
import test from "node:test";
import { buildIntimateChatTonePrompt } from "./intimateChatTone.js";

test("erotic chat mode allows opted-in adult language without weakening grounding", () => {
  const prompt = buildIntimateChatTonePrompt({ level: "erotic" });

  assert.match(prompt, /may flirt, talk dirty/i);
  assert.match(prompt, /do not refuse/i);
  assert.match(prompt, /do not invent physical presence/i);
  assert.match(prompt, /still active now/i);
  assert.match(prompt, /adult woman who is genuinely sexually interested/i);
  assert.match(prompt, /avoid recycling/i);
});

test("custom chat mode carries the saved instruction into conversation", () => {
  const prompt = buildIntimateChatTonePrompt({
    level: "custom",
    customInstructions: "Sound like a trusted lover who enjoys explicit anatomy.",
  });

  assert.match(prompt, /trusted lover who enjoys explicit anatomy/);
});
