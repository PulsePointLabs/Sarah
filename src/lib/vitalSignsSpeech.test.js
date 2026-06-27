import test from "node:test";
import assert from "node:assert/strict";
import { formatDurationWords, formatVitalSignsSpeech, numberToSpokenWords } from "./vitalSignsSpeech.js";

test("numberToSpokenWords handles clinical integers and decimals", () => {
  assert.equal(numberToSpokenWords("16,241"), "sixteen thousand two hundred forty-one");
  assert.equal(numberToSpokenWords("121.4"), "one hundred twenty-one point four");
});

test("formatDurationWords spells out hours, minutes, and seconds", () => {
  assert.equal(formatDurationWords(8066), "two hours, fourteen minutes, and twenty-six seconds");
});

test("formatVitalSignsSpeech expands vital-sign measurements and clock times", () => {
  const result = formatVitalSignsSpeech("134.4-minute HR session at 16:49 ET. BP 130/98 mmHg at ~7 min; average 121.4 bpm among 16,241 RR intervals.");
  assert.match(result, /one hundred thirty-four point four-minute heart rate session at four forty-nine P M Eastern Time/i);
  assert.match(result, /blood pressure one hundred thirty over ninety-eight millimeters of mercury/i);
  assert.match(result, /approximately seven minutes/i);
  assert.match(result, /one hundred twenty-one point four beats per minute/i);
  assert.match(result, /sixteen thousand two hundred forty-one R R intervals/i);
  assert.doesNotMatch(result, /\d/);
});

test("formatVitalSignsSpeech keeps Sarah's read in second person", () => {
  const result = formatVitalSignsSpeech("Ben's heart rate stayed elevated. Ben was active, and Ben has a documented baseline.");
  assert.equal(result, "Your heart rate stayed elevated. You were active, and you have a documented baseline.");
  assert.doesNotMatch(result, /\bBen\b/i);
});
