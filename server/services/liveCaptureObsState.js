let obsRecordingActive = false;
let obsRecordingPaused = false;
const listeners = new Set();

export function updateLiveCaptureObsState({ active = false, paused = false } = {}) {
  const previous = isLiveCaptureObsActivelyRecording();
  obsRecordingActive = Boolean(active);
  obsRecordingPaused = Boolean(paused);
  const current = isLiveCaptureObsActivelyRecording();
  if (current !== previous) {
    for (const listener of listeners) listener(current);
  }
}

export function isLiveCaptureObsActivelyRecording() {
  return obsRecordingActive && !obsRecordingPaused;
}

export function onLiveCaptureObsStateChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
