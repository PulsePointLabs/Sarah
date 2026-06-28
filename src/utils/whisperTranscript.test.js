import test from "node:test";
import assert from "node:assert/strict";

import { cleanWhisperTranscript, finalizeWhisperTranscript } from "./whisperTranscript.js";

test("cleanWhisperTranscript preserves punctuation returned by Whisper", () => {
  assert.equal(cleanWhisperTranscript("  Are we ready?  "), "Are we ready?");
  assert.equal(cleanWhisperTranscript("That worked!"), "That worked!");
});

test("finalizeWhisperTranscript adds punctuation only when Whisper omitted it", () => {
  assert.equal(finalizeWhisperTranscript("How did that look"), "How did that look?");
  assert.equal(finalizeWhisperTranscript("That looked stable"), "That looked stable.");
  assert.equal(finalizeWhisperTranscript("Did that work?"), "Did that work?");
});

test("finalizeWhisperTranscript still removes trailing voice commands and hallucinated outros", () => {
  assert.equal(finalizeWhisperTranscript("This is the message stop"), "This is the message.");
  assert.equal(finalizeWhisperTranscript("Thank you for watching."), "");
  assert.equal(finalizeWhisperTranscript("Thank you."), "");
  assert.equal(finalizeWhisperTranscript("This is the actual note. Thank you."), "This is the actual note.");
  assert.equal(finalizeWhisperTranscript("I said thank you"), "I said thank you.");
});

test("finalizeWhisperTranscript removes a trailing URL unsupported by the live transcript", () => {
  const liveText = "It varies, but it is fairly consistent, I would say";
  const whisperText = "It varies, but it is fairly consistent, I would say. www.ottobock.com.";
  assert.equal(
    finalizeWhisperTranscript(whisperText, { referenceText: liveText }),
    "It varies, but it is fairly consistent, I would say.",
  );
  assert.equal(
    finalizeWhisperTranscript(whisperText),
    "It varies, but it is fairly consistent, I would say.",
  );
});

test("finalizeWhisperTranscript preserves deliberately dictated web addresses", () => {
  assert.equal(
    finalizeWhisperTranscript("Please visit www.example.com.", { referenceText: "Please visit" }),
    "Please visit www.example.com.",
  );
  assert.equal(
    finalizeWhisperTranscript("www.example.com", { referenceText: "www.example.com" }),
    "www.example.com.",
  );
  assert.equal(
    finalizeWhisperTranscript("The website address is www.example.com."),
    "The website address is www.example.com.",
  );
});
