import test from "node:test";
import assert from "node:assert/strict";
import { inferSessionVideoPriority, sortSessionVideosPrimaryFirst } from "./sessionVideoPriority.js";

test("underscored feet filenames are classified as secondary views", () => {
  assert.equal(inferSessionVideoPriority({ filename: "feet_2026-08-02 05-46-58.mkv" }), 9);
});

test("main and composite views sort ahead of feet views", () => {
  const sorted = sortSessionVideosPrimaryFirst([
    { filename: "feet_2026-08-02 05-46-58.mkv" },
    { filename: "2026-08-02 05-46-58.mkv" },
    { filename: "obs_composite_2026-08-02.mkv" },
  ]);
  assert.deepEqual(sorted.map((video) => video.filename), [
    "obs_composite_2026-08-02.mkv",
    "2026-08-02 05-46-58.mkv",
    "feet_2026-08-02 05-46-58.mkv",
  ]);
});

test("explicit primary camera metadata outranks filename order", () => {
  assert.equal(inferSessionVideoPriority({ camera_angle: "main_view", filename: "camera_2.mkv" }), 1);
});
