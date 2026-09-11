import test from "node:test";
import assert from "node:assert/strict";
import { sidebarLimits, sidebarWidth, isFocusShortcut } from "./fullTelemetryLayout.js";

test("desktop sidebar cannot collapse its metrics or consume the video", () => {
  for (const viewport of [800, 1024, 1280, 1920, 2560]) {
    const { min, max } = sidebarLimits(viewport);
    assert.ok(min <= max);
    assert.equal(sidebarWidth(1, viewport), min);
    assert.equal(sidebarWidth(10000, viewport), max);
    assert.ok(viewport - max >= 320);
  }
  assert.equal(sidebarWidth(200, 1920), 400);
  assert.equal(sidebarWidth(680, 1920), 680);
  assert.equal(sidebarWidth(680, 1024), sidebarLimits(1024).max);
});
test("F toggle respects typing, modifiers and held keys", () => {
  assert.equal(isFocusShortcut({ code: "KeyF" }, { tagName: "BUTTON" }), true);
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) assert.equal(isFocusShortcut({ code: "KeyF" }, { tagName }), false);
  assert.equal(isFocusShortcut({ code: "KeyF" }, { isContentEditable: true }), false);
  for (const flag of ["repeat", "ctrlKey", "metaKey", "altKey"]) assert.equal(isFocusShortcut({ code: "KeyF", [flag]: true }, {}), false);
});
