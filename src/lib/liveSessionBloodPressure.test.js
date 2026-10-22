import test from "node:test";
import assert from "node:assert/strict";
import {
  resetBloodPressureCaptureForSession,
  selectLiveSessionBloodPressure,
  bloodPressureFallsInSession,
} from "./liveSessionBloodPressure.js";

const priorReading = { systolic_mm_hg: 132, diastolic_mm_hg: 86 };
const currentReading = { systolic_mm_hg: 124, diastolic_mm_hg: 80 };

test('measurement time determines session membership without pre/post padding or guesses from reception', () => {
  const startMs=Date.parse('2026-10-22T18:00:00Z'), endMs=startMs+60000;
  const window={startMs,endMs,sessionId:'new',pauses:[{pausedAt:new Date(startMs+20000).toISOString(),resumedAt:new Date(startMs+30000).toISOString()}]};
  const reading=offset=>({...currentReading,measured_at:new Date(startMs+offset).toISOString()});
  for (const offset of [-1,20000,25000,60001]) assert.equal(bloodPressureFallsInSession(reading(offset),window),false);
  for (const offset of [0,10000,30000,60000]) assert.equal(bloodPressureFallsInSession(reading(offset),window),true);
  assert.equal(bloodPressureFallsInSession({...reading(10000),timestamp_source:'received_at'},window),false);
  assert.equal(bloodPressureFallsInSession({...reading(10000),session:'old'},window),false);
  assert.equal(selectLiveSessionBloodPressure({activeSessionId:'new',captureState:{sessionId:'new',lastReading:reading(-1000)},window}),null);
});

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

test("an armed capture does not present an unassigned reading as session telemetry", () => {
  assert.equal(selectLiveSessionBloodPressure({
    activeSessionId: null,
    activeSessionDoc: null,
    captureState: { sessionId: null, lastReading: currentReading },
  }), null);

  assert.equal(selectLiveSessionBloodPressure({
    activeSessionId: null,
    activeSessionDoc: null,
    captureState: { sessionId: null, lastReading: null },
  }), null);
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
