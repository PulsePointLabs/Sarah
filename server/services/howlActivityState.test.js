import test from "node:test";
import assert from "node:assert/strict";
import { identifyHowlActivity, readHowlActivityState } from "./howlActivityState.js";

test("identifies a Howl activity from a player title", () => {
  assert.deepEqual(readHowlActivityState({ player: { title: "Activity (Fast/slow)" } }), {
    reported: true,
    name: "FASTSLOW",
    displayName: "Fast/slow",
  });
});

test("does not claim activity synchronization when Howl omits activity identity", () => {
  assert.deepEqual(readHowlActivityState({ player: { playing: false, title: "", filename: null } }), {
    reported: false,
    name: null,
    displayName: null,
  });
});

test("normalizes Sarah's canonical activity names", () => {
  assert.equal(identifyHowlActivity("MILKMASTER")?.displayName, "Milkmaster 3000");
});
