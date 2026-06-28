import assert from "node:assert/strict";
import test from "node:test";
import { buildStoredProfilerImageRef } from "./profilerReviewImagePayload.js";

test("restored Profiler images remain server references instead of inline base64", () => {
  const result = buildStoredProfilerImageRef({
    id: "head-to-toe-restored-1",
    filename: "standing-reference.jpg",
    media_type: "image/jpeg",
    storagePath: "/api/uploads/standing-reference.jpg",
    data: "very-large-base64-payload",
    upload_note: "Anterior standing reference",
  });

  assert.equal(result.data, "");
  assert.equal(result.server_image_ref, true);
  assert.equal(result.storagePath, "/api/uploads/standing-reference.jpg");
  assert.equal(result.url, "/api/uploads/standing-reference.jpg");
  assert.equal(result.id, "head-to-toe-restored-1");
  assert.equal(result.upload_note, "Anterior standing reference");
});

test("newly uploaded Profiler images use the returned reusable URL", () => {
  const result = buildStoredProfilerImageRef({
    filename: "new-reference.jpg",
    media_type: "image/jpeg",
  }, 2, "/api/uploads/new-reference.jpg");

  assert.equal(result.data, "");
  assert.equal(result.server_image_ref, true);
  assert.equal(result.storagePath, "/api/uploads/new-reference.jpg");
  assert.equal(result.filename, "new-reference.jpg");
});
