import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_INTIMATE_REFLECTION_SETTINGS,
  INTIMATE_REFLECTION_SETTINGS_KEY,
  readIntimateReflectionSettings,
  saveIntimateReflectionSettings,
} from "./intimateReflectionSettings.js";

function storageMock() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test("returns the global intimate reflection default when storage is empty", () => {
  assert.deepEqual(readIntimateReflectionSettings(storageMock()), DEFAULT_INTIMATE_REFLECTION_SETTINGS);
});

test("persists custom reflection instructions for reuse across sessions", () => {
  const storage = storageMock();
  const saved = saveIntimateReflectionSettings({
    level: "custom",
    customInstructions: "  First-person   trusted-lover voice. ",
    updatedAt: "2026-07-25T00:00:00.000Z",
  }, storage);

  assert.equal(saved.level, "custom");
  assert.equal(saved.customInstructions, "First-person trusted-lover voice.");
  assert.equal(readIntimateReflectionSettings(storage).customInstructions, saved.customInstructions);
  assert.match(storage.getItem(INTIMATE_REFLECTION_SETTINGS_KEY), /trusted-lover voice/);
});
