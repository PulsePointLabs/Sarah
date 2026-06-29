import test from "node:test";
import assert from "node:assert/strict";
import {
  resetBloodPressureCaptureForSession,
  selectLiveSessionBloodPressure,
} from "./liveSessionBloodPressure.js";

const priorReading = { systolic_mm_hg: 132, diastolic_mm_hg: 86 };
const currentReading = { systolic_mm_hg: 124, diastolic_mm_hg: 80 };

test("a new live session does not display the prior session blood pressure", () => {
  assert.equal(selectLiveSessionBloodPressure({
    activeSessionId: "session-new",
    activeSessionDoc: {
      id: "session-new",
    },
    captureState: {
      sessionId: "session-old",
      lastReading: priorReading,
    },
  }), null);
});

test("the active session displays only its own captured or persisted blood pressure", () => {
  assert.equal(selectLiveSessionBloodPressure({
    activeSessionId: "session-new",
    activeSessionDoc: { id: "session-new" },
    captureState: { sessionId: "session-new", lastReading: currentReading },
  }), currentReading);

  assert.equal(selectLiveSessionBloodPressure({
    activeSessionId: "session-new",
    activeSessionDoc: {
      id: "session-new",
      latest_blood_pressure_reading: currentReading,
    },
    captureState: { sessionId: null, lastReading: priorReading },
  }), currentReading);
});

test("starting a different session clears session-specific blood pressure state", () => {
  const reset = resetBloodPressureCaptureForSession({
    status: "captured",
    sessionId: "session-old",
    lastReading: priorReading,
    capturedCount: 2,
  }, "session-new");

  assert.equal(reset.sessionId, "session-new");
  assert.equal(reset.lastReading, null);
  assert.equal(reset.capturedCount, 0);
  assert.equal(reset.status, "idle");
});
